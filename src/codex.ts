import { spawn } from "node:child_process";
import { closedBudget, openNightBudget, waitForSessionCapacity, withCurrentUsage, type UsageSnapshot } from "./budget.js";
import {
  LAYER_SEPARATOR, buildFinderPrompt, finderSystemPrompt, parseOrError, parseReviewBlock,
  type AgentReport, type ReviewPromptExtras, type ReviewRunResult, type TicketBrief,
} from "./claude.js";
import { runWithWatchdog } from "./process.js";
import type { NightBudget, RunUsage } from "./types.js";
import { TIME_ZONE } from "./time.js";

export const CODEX_MODEL = "gpt-6.1-sol";
export const CODEX_EFFORT = "high";
export const CODEX_ALLOWANCE_PCT = 20;

const SESSION_WINDOW_MINS = 300;
const WEEKLY_WINDOW_MINS = 10080;
const USAGE_TIMEOUT_MS = 20_000;
const FINDER_TIMEOUT_MS = 2 * 60 * 60 * 1000;

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export function parseCodexRateLimits(result: unknown): UsageSnapshot {
  const { primary, secondary } = (result as { rateLimits?: { primary?: RateLimitWindow; secondary?: RateLimitWindow } }).rateLimits ?? {};
  const windows = [primary, secondary].filter((w): w is RateLimitWindow => !!w);
  const weekly = windows.find((w) => w.windowDurationMins === WEEKLY_WINDOW_MINS);
  if (!weekly) throw new Error("Codex rate limits have no weekly window");
  const session = windows.find((w) => w.windowDurationMins === SESSION_WINDOW_MINS);
  const resetInfo = new Date(weekly.resetsAt * 1000).toLocaleString("en-US", {
    timeZone: TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  return {
    weeklyPercent: weekly.usedPercent,
    resetInfo: `${resetInfo} (${TIME_ZONE})`,
    weeklyResetAt: weekly.resetsAt * 1000,
    ...(session ? { sessionPercent: session.usedPercent, sessionResetAt: session.resetsAt * 1000 } : {}),
  };
}

const rpc = (message: object) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;

export function readCodexUsage(): Promise<UsageSnapshot> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      child.kill();
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Codex usage read timed out"))), USAGE_TIMEOUT_MS);
    child.on("error", (e) => finish(() => reject(e)));
    child.stdin.on("error", (e) => finish(() => reject(e)));
    child.on("close", () => finish(() => reject(new Error("codex app-server exited before answering"))));
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 2) continue;
        if (message.error) return finish(() => reject(new Error(message.error?.message ?? "Codex usage read failed")));
        try {
          const snapshot = parseCodexRateLimits(message.result);
          return finish(() => resolve(snapshot));
        } catch (e) {
          return finish(() => reject(e));
        }
      }
    });
    child.stdin.write(rpc({ id: 1, method: "initialize", params: { clientInfo: { name: "nightshift", version: "1" } } }));
    child.stdin.write(rpc({ method: "initialized" }));
    child.stdin.write(rpc({ id: 2, method: "account/rateLimits/read" }));
  });
}

export const buildCodexArgs = (worktreePath: string, model = CODEX_MODEL): string[] => [
  "exec", "-m", model, "-c", `model_reasoning_effort="${CODEX_EFFORT}"`, "-s", "read-only", "--ephemeral", "--ignore-user-config", "--json", "-C", worktreePath, "-",
];

export function parseCodexEvents(stdout: string, model: string): { text: string; usage?: RunUsage } {
  let text = "";
  let usage: RunUsage | undefined;
  for (const line of stdout.split("\n")) {
    let event: { type?: string; item?: { type?: string; text?: string }; usage?: Record<string, number> };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") text = event.item.text ?? "";
    if (event.type === "turn.completed") {
      const cached = event.usage?.cached_input_tokens ?? 0;
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + (event.usage?.input_tokens ?? 0) - cached,
        cacheReadTokens: (usage?.cacheReadTokens ?? 0) + cached,
        cacheCreationTokens: 0,
        outputTokens: (usage?.outputTokens ?? 0) + (event.usage?.output_tokens ?? 0),
        costUsd: 0,
        turns: (usage?.turns ?? 0) + 1,
        durationMs: 0,
        models: [model],
      };
    }
  }
  return { text, ...(usage ? { usage } : {}) };
}

export const codexUsageLimited = (output: string): boolean => /hit your usage limit/i.test(output);

export async function runCodexFinder(
  worktreePath: string, brief: TicketBrief, report: AgentReport | undefined, baseRef: string, extras: ReviewPromptExtras, model = CODEX_MODEL,
): Promise<ReviewRunResult> {
  const started = Date.now();
  const proc = await runWithWatchdog("codex", buildCodexArgs(worktreePath, model), {
    cwd: worktreePath,
    input: finderSystemPrompt("bugs") + LAYER_SEPARATOR + buildFinderPrompt("codex", brief, report, baseRef, extras),
    timeoutMs: FINDER_TIMEOUT_MS,
    checkIntervalMs: FINDER_TIMEOUT_MS,
  });
  const { text, usage } = parseCodexEvents(proc.stdout, model);
  const usageLimited = codexUsageLimited(`${proc.stdout}\n${proc.stderr}`);
  const failure = proc.error
    ? `codex failed to run: ${proc.error.message}`
    : usageLimited
      ? "Codex usage limit reached"
      : proc.abortReason
        ? `codex stopped: ${proc.abortReason}`
        : proc.status !== 0
          ? `codex exited with status ${proc.status}${proc.signal ? ` (${proc.signal})` : ""}`
          : undefined;
  const { value: parsed, error: parseError } = parseOrError(text, failure, parseReviewBlock);
  return {
    success: failure === undefined,
    rawOutput: [text, proc.stderr, failure ?? ""].filter(Boolean).join("\n"),
    findings: parsed?.findings,
    risks: parsed?.risks,
    rulings: parsed?.rulings,
    parseError,
    failure,
    usageLimited,
    usage: usage && { ...usage, durationMs: Date.now() - started },
  };
}

export interface CodexLensDeps {
  budget: { current: NightBudget };
  readUsage: () => Promise<UsageSnapshot>;
  claudeGateReason: () => string | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (msg: string) => void;
  run: () => Promise<ReviewRunResult>;
}

export async function openCodexBudget(read = readCodexUsage): Promise<NightBudget> {
  try {
    return openNightBudget(await read(), CODEX_ALLOWANCE_PCT);
  } catch (e) {
    return closedBudget(`Codex usage unavailable: ${(e as Error).message}`);
  }
}

const skipped = (skipReason: string): ReviewRunResult => ({ success: false, rawOutput: "", skipReason });

const allowanceReason = (b: NightBudget): string => `Codex night allowance reached (${b.currentPct}% ≥ cap ${b.capPct}%)`;

async function readyToRun(deps: CodexLensDeps): Promise<string | undefined> {
  const refresh = async () => {
    const snapshot = await deps.readUsage();
    deps.budget.current = withCurrentUsage(deps.budget.current, snapshot);
    return snapshot;
  };
  try {
    await refresh();
  } catch (e) {
    return (e as Error).message;
  }
  if (deps.budget.current.gateHit) return allowanceReason(deps.budget.current);
  let waited = false;
  await waitForSessionCapacity({
    snapshot: refresh,
    sleep: async (ms) => { waited = true; await deps.sleep(ms); },
    log: (msg) => deps.log(`  Codex ${msg.trim()}`),
    now: deps.now,
  });
  if (!waited) return undefined;
  return deps.claudeGateReason() ?? (deps.budget.current.gateHit ? allowanceReason(deps.budget.current) : undefined);
}

export async function runCodexLens(deps: CodexLensDeps): Promise<ReviewRunResult> {
  if (deps.budget.current.unavailable) return skipped("Codex usage unavailable");
  let result: ReviewRunResult | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reason = await readyToRun(deps);
    if (reason) return skipped(reason);
    result = await deps.run();
    if (!result.usageLimited) break;
  }
  try {
    deps.budget.current = withCurrentUsage(deps.budget.current, await deps.readUsage());
  } catch { /* the next lens refreshes it */ }
  return result!.usageLimited ? { ...result!, failure: "Codex usage limit reached" } : result!;
}
