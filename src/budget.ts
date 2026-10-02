import { spawnSync } from "node:child_process";
import path from "node:path";
import type { NightBudget } from "./types.js";
import { CLAUDE_TOKEN } from "./agent-env.js";
import { TIME_ZONE } from "./time.js";

const ALLOCATION_PERCENT = 15;
const USAGE_ATTEMPTS = 3;
const USAGE_RETRY_DELAY_MS = 15_000;
const PROBE_MODEL = "claude-haiku-4-5-20251001";
const ROOT = path.resolve(import.meta.dirname, "..");

export interface UsageSnapshot {
  weeklyPercent: number;
  resetInfo: string;
}

export function parseUsageOutput(output: string): UsageSnapshot {
  const weekLine = output.match(/^.*Current week \(all models\).*$/im)?.[0]
    ?? output.match(/^.*Current week[^:\n]*:.*$/im)?.[0];
  const percent = weekLine?.match(/(\d+(?:\.\d+)?)%\s*used/i);
  if (!weekLine || !percent) {
    throw new Error("Could not find weekly usage in `claude -p /usage` output");
  }
  const reset = weekLine.match(/resets\s+(.+?)\s*$/i);
  return {
    weeklyPercent: parseFloat(percent[1]),
    resetInfo: reset ? reset[1].trim() : "unknown",
  };
}

export interface UsageCommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: string;
}

export class UsageUnavailableError extends Error {
  constructor(message: string, readonly attempts: UsageCommandResult[]) {
    super(message);
  }
}

function runUsageCommand(): UsageCommandResult {
  const result = spawnSync("claude", ["-p", "/usage"], {
    encoding: "utf-8",
    cwd: ROOT,
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status, error: result.error?.message };
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseUsageResult(result: UsageCommandResult): UsageSnapshot {
  if (result.error) throw new Error(result.error);
  if (result.status !== 0) throw new Error(`\`claude -p /usage\` exited with status ${result.status}`);
  if (/^Total cost:/m.test(result.stdout)) {
    throw new Error("claude is not logged in (cron can't read the login keychain); set CLAUDE_CODE_OAUTH_TOKEN in .env from `claude setup-token`");
  }
  return parseUsageOutput(result.stdout);
}

export function parseRateLimitHeaders(response: string): UsageSnapshot {
  const header = (name: string) => response.match(new RegExp(`^anthropic-ratelimit-unified-${name}:\\s*(\\S+)`, "im"))?.[1];
  const utilization = header("7d-utilization");
  if (utilization === undefined) {
    throw new Error("Could not find anthropic-ratelimit-unified-7d-utilization in the usage probe response");
  }
  const reset = header("7d-reset");
  const resetInfo = reset
    ? `${new Date(Number(reset) * 1000).toLocaleString("en-US", {
        timeZone: TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      })} (${TIME_ZONE})`
    : "unknown";
  return { weeklyPercent: Math.round(parseFloat(utilization) * 1000) / 10, resetInfo };
}

function runUsageProbe(token: string): UsageCommandResult {
  const body = JSON.stringify({
    model: PROBE_MODEL,
    max_tokens: 1,
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    messages: [{ role: "user", content: "hi" }],
  });
  const config = [
    `header = "Authorization: Bearer ${token}"`,
    `header = "anthropic-beta: oauth-2025-04-20"`,
    `header = "anthropic-version: 2023-06-01"`,
    `header = "content-type: application/json"`,
    `data = ${JSON.stringify(body)}`,
  ].join("\n");
  const result = spawnSync("curl", ["-sS", "-D", "-", "--max-time", "60", "--config", "-", "https://api.anthropic.com/v1/messages"], {
    encoding: "utf-8",
    input: config,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status, error: result.error?.message };
}

function parseProbeResult(result: UsageCommandResult): UsageSnapshot {
  if (result.error) throw new Error(result.error);
  if (result.status !== 0) throw new Error(`curl exited with status ${result.status}`);
  const httpStatus = result.stdout.match(/^HTTP\/\S+\s+(\d{3})/m)?.[1];
  if (httpStatus !== "200") {
    const responseBody = result.stdout.split(/\r?\n\r?\n/).slice(1).join("\n").trim();
    throw new Error(`Usage probe returned HTTP ${httpStatus ?? "unknown"}: ${responseBody.slice(0, 300)}`);
  }
  return parseRateLimitHeaders(result.stdout);
}

export interface UsageSource {
  read: () => UsageCommandResult;
  parse: (result: UsageCommandResult) => UsageSnapshot;
}

export function cliUsageSource(read: () => UsageCommandResult = runUsageCommand): UsageSource {
  return { read, parse: parseUsageResult };
}

export function apiUsageSource(token: string, read: () => UsageCommandResult = () => runUsageProbe(token)): UsageSource {
  return { read, parse: parseProbeResult };
}

function defaultUsageSource(): UsageSource {
  const token = process.env[CLAUDE_TOKEN];
  return token ? apiUsageSource(token) : cliUsageSource();
}

export function snapshotUsage(
  attempts = USAGE_ATTEMPTS,
  source: UsageSource = defaultUsageSource(),
  pause: (ms: number) => void = sleepSync,
): UsageSnapshot {
  const results: UsageCommandResult[] = [];
  let lastMessage = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) pause(USAGE_RETRY_DELAY_MS);
    const result = source.read();
    results.push(result);
    try {
      return source.parse(result);
    } catch (e) {
      lastMessage = (e as Error).message;
    }
  }
  throw new UsageUnavailableError(`${lastMessage} (${attempts} attempt${attempts === 1 ? "" : "s"})`, results);
}

export function formatUsageAttempts(attempts: UsageCommandResult[]): string[] {
  const stream = (name: string, text: string) => `  ${name}: ${text.trim() || "(empty)"}`;
  return attempts.flatMap((a, i) => [
    `Attempt ${i + 1}: exit ${a.status}${a.error ? `, ${a.error}` : ""}`,
    stream("stdout", a.stdout),
    stream("stderr", a.stderr),
  ]);
}

export function openNightBudget(snapshot: UsageSnapshot, allocationPct = ALLOCATION_PERCENT): NightBudget {
  return {
    startPct: snapshot.weeklyPercent,
    capPct: snapshot.weeklyPercent + allocationPct,
    currentPct: snapshot.weeklyPercent,
    allocationPct,
    gateHit: false,
    unavailable: false,
    resetInfo: snapshot.resetInfo,
  };
}

export function closedBudget(reason: string): NightBudget {
  return { ...openNightBudget({ weeklyPercent: 0, resetInfo: reason }, 0), gateHit: true, unavailable: true };
}

export function withCurrentUsage(budget: NightBudget, snapshot: UsageSnapshot): NightBudget {
  const now = snapshot.weeklyPercent;
  if (now < budget.currentPct) {
    const spent = budget.currentPct - budget.startPct;
    const remaining = Math.max(0, budget.allocationPct - spent);
    return {
      ...budget,
      startPct: now - spent,
      capPct: now + remaining,
      currentPct: now,
      gateHit: remaining <= 0,
      resetInfo: snapshot.resetInfo,
    };
  }
  return { ...budget, currentPct: now, gateHit: now >= budget.capPct, resetInfo: snapshot.resetInfo };
}

export function startNightBudget(): NightBudget {
  return openNightBudget(snapshotUsage());
}

export function checkGate(budget: NightBudget, attempts = USAGE_ATTEMPTS): NightBudget {
  return withCurrentUsage(budget, snapshotUsage(attempts));
}

export function budgetUsedPct(budget: NightBudget): number {
  return Math.round((budget.currentPct - budget.startPct) * 10) / 10;
}

export function budgetGateMessage(b: NightBudget): string {
  if (b.gateHit) {
    return `Budget allocation reached – weekly usage at ${b.currentPct}% (cap ${b.capPct}%). ` +
           `Remaining tickets will be skipped. Reset: ${b.resetInfo}.`;
  }
  return `Budget OK – weekly usage at ${b.currentPct}% (night started at ${b.startPct}%, cap ${b.capPct}%).`;
}
