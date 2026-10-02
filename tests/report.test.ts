import { describe, expect, it } from "vitest";
import { closedBudget, openNightBudget } from "../src/budget.js";
import { generateHTML } from "../src/report.js";
import type { SessionResult } from "../src/types.js";

const session = (over: Partial<SessionResult>): SessionResult => ({
  date: "2026-10-01", startedAt: "", endedAt: "", tickets: [],
  budget: openNightBudget({ weeklyPercent: 3, resetInfo: "Oct 7" }),
  gateHit: false, skipReason: "", noTasks: false, ...over,
});

describe("report budget section", () => {
  it("says usage was unavailable instead of claiming the budget was reached", () => {
    const reason = "Skipped – could not read usage at start: Could not find weekly usage";
    const html = generateHTML(session({ budget: closedBudget("usage unavailable"), gateHit: true, skipReason: reason }));
    expect(html).toContain(reason);
    expect(html).not.toContain("Budget allocation reached");
    expect(html).not.toContain("Tonight's allocation");
  });

  it("names the budget cap when that is why tickets were skipped", () => {
    const reason = "Skipped – nightly budget allocation reached (18% ≥ cap 18%).";
    const html = generateHTML(session({ gateHit: true, skipReason: reason }));
    expect(html).toContain("Tonight's allocation");
    expect(html).toContain("nightly budget allocation reached (18% ≥ cap 18%)");
  });
});
