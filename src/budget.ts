import { execFileSync } from "node:child_process";
import path from "node:path";
import type { NightBudget } from "./types.js";

const ALLOCATION_PERCENT = 15;
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

export function openNightBudget(snapshot: UsageSnapshot, allocationPct = ALLOCATION_PERCENT): NightBudget {
  return {
    startPct: snapshot.weeklyPercent,
    capPct: snapshot.weeklyPercent + allocationPct,
    currentPct: snapshot.weeklyPercent,
    allocationPct,
    gateHit: false,
    resetInfo: snapshot.resetInfo,
  };
}

export function closedBudget(reason: string): NightBudget {
  return { ...openNightBudget({ weeklyPercent: 0, resetInfo: reason }, 0), gateHit: true };
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

export function checkGate(budget: NightBudget): NightBudget {
  return withCurrentUsage(budget, snapshotUsage());
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
