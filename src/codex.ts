import { spawn } from "node:child_process";
import type { UsageSnapshot } from "./budget.js";
import { TIME_ZONE } from "./time.js";

export const CODEX_MODEL = "gpt-6.1-sol";
export const CODEX_EFFORT = "high";
export const CODEX_ALLOWANCE_PCT = 20;

const SESSION_WINDOW_MINS = 300;
const WEEKLY_WINDOW_MINS = 10080;
const USAGE_TIMEOUT_MS = 20_000;

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
