import { execSync } from "node:child_process";
import type { BudgetStatus } from "./types.js";

const GATE_PERCENT = 15;

export function checkBudget(): BudgetStatus {
  let output = "";

  try {
    output = execSync("claude /usage", {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    // claude sometimes writes to stderr in print mode
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }

  // Primary pattern: "Current week (all models): 42% used"
  let weeklyPercent = 0;
  const weekMatch = output.match(/Current week[^:]*:\s*(\d+(?:\.\d+)?)%\s*used/i);
  if (weekMatch) {
    weeklyPercent = parseFloat(weekMatch[1]);
  }

  // Fallback: "Current session: X% used"
  if (weeklyPercent === 0) {
    const sessionMatch = output.match(/Current session:\s*(\d+(?:\.\d+)?)%\s*used/i);
    if (sessionMatch) {
      weeklyPercent = parseFloat(sessionMatch[1]);
    }
  }

  // Reset info: "resets Sep 30 at 9:59am (America/Vancouver)"
  const resetMatch = output.match(/resets\s+(.+?)(?:\s*·|\n|$)/i);
  const resetInfo = resetMatch ? resetMatch[1].trim() : "unknown";

  return {
    weeklyPercent,
    gateHit: weeklyPercent >= GATE_PERCENT,
    resetInfo,
  };
}

export function budgetGateMessage(b: BudgetStatus): string {
  if (b.gateHit) {
    return `Budget gate HIT – weekly usage at ${b.weeklyPercent}% (≥ ${GATE_PERCENT}%). ` +
           `Reset: ${b.resetInfo}. No tickets will be processed.`;
  }
  return `Budget OK – weekly usage at ${b.weeklyPercent}% (gate at ${GATE_PERCENT}%).`;
}
