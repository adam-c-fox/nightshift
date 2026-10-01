import { describe, expect, it } from "vitest";
import { budgetUsedPct, openNightBudget, parseUsageOutput, withCurrentUsage } from "../src/budget.js";

const usageOutput = `Ignoring 6 permissions.allow entries from .claude/settings.json
You are currently using your subscription to power your Claude Code usage

Current session: 5% used · resets Oct 1 at 1pm (America/Vancouver)
Current week (all models): 1% used · resets Oct 7 at 10am (America/Vancouver)

What's contributing to your limits usage?
`;

describe("parseUsageOutput", () => {
  it("reads the weekly line, not the session line", () => {
    expect(parseUsageOutput(usageOutput)).toEqual({
      weeklyPercent: 1,
      resetInfo: "Oct 7 at 10am (America/Vancouver)",
    });
  });

  it("supports decimal percentages", () => {
    expect(parseUsageOutput("Current week (all models): 12.5% used").weeklyPercent).toBe(12.5);
  });

  it("throws instead of reporting 0% when the weekly line is missing", () => {
    expect(() => parseUsageOutput("Current session: 5% used")).toThrow(/weekly usage/);
  });
});

describe("night budget gate", () => {
  const start = openNightBudget({ weeklyPercent: 3, resetInfo: "soon" });

  it("caps at start plus the 15 point allocation", () => {
    expect(start).toMatchObject({ startPct: 3, capPct: 18, allocationPct: 15, gateHit: false });
  });

  it("allows a ticket below the cap, stops at or above it", () => {
    expect(withCurrentUsage(start, { weeklyPercent: 14, resetInfo: "" }).gateHit).toBe(false);
    expect(withCurrentUsage(start, { weeklyPercent: 18, resetInfo: "" }).gateHit).toBe(true);
    expect(withCurrentUsage(start, { weeklyPercent: 19, resetInfo: "" }).gateHit).toBe(true);
  });

  it("reports how much of the allocation was used", () => {
    expect(budgetUsedPct(withCurrentUsage(start, { weeklyPercent: 19, resetInfo: "" }))).toBe(16);
  });
});
