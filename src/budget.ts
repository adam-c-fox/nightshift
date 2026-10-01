import { execFileSync } from "node:child_process";
import path from "node:path";
import type { BudgetStatus } from "./types.js";

const GATE_PERCENT = 15;
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

export function snapshotUsage(): UsageSnapshot {
  const output = execFileSync("claude", ["-p", "/usage"], {
    encoding: "utf-8",
    cwd: ROOT,
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseUsageOutput(output);
}

export function checkBudget(): BudgetStatus {
  const { weeklyPercent, resetInfo } = snapshotUsage();
  return { weeklyPercent, gateHit: weeklyPercent >= GATE_PERCENT, resetInfo };
}

export function budgetGateMessage(b: BudgetStatus): string {
  if (b.gateHit) {
    return `Budget gate HIT – weekly usage at ${b.weeklyPercent}% (≥ ${GATE_PERCENT}%). ` +
           `Reset: ${b.resetInfo}. No tickets will be processed.`;
  }
  return `Budget OK – weekly usage at ${b.weeklyPercent}% (gate at ${GATE_PERCENT}%).`;
}
