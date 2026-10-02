import { describe, expect, it } from "vitest";
import { closedBudget, openNightBudget } from "../src/budget.js";
import { generateHTML, reportFilename } from "../src/report.js";
import type { SessionResult, TicketResult } from "../src/types.js";

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

const ticketResult = (over: Partial<TicketResult> = {}): TicketResult => ({
  ticket: { id: "ENG-1", name: "Export", context: [], repo: "main" }, linear: null, status: "done",
  summary: "Did it.", filesCreated: [], filesModified: [], tests: [], verifyCommands: [], notes: "",
  worktreePath: "/w", branch: "b", durationSec: 1, ...over,
});

const reportFor = (ticket: TicketResult) => generateHTML(session({ tickets: [ticket] }));

describe("report review section", () => {
  const findings = [
    { id: "R1", severity: "blocker" as const, file: "src/export.ts", issue: "Buffers all rows <b>in memory</b>.", suggestion: "Stream them." },
    { id: "R2", severity: "minor" as const, file: "tests/export.spec.ts", issue: "No header assertion.", suggestion: "Assert it." },
  ];

  it("lists each finding with its fields and resolution", () => {
    const html = reportFor(ticketResult({ review: {
      outcome: "reviewed", findings,
      resolutions: [
        { id: "R1", status: "fixed", how: "Streamed rows." },
        { id: "R2", status: "not_fixed", how: "Left as is." },
      ],
    } }));
    for (const text of ["R1", "blocker", "src/export.ts", "Stream them.", "Streamed rows.", "R2", "minor", "tests/export.spec.ts", "Left as is."]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("Buffers all rows &lt;b&gt;in memory&lt;/b&gt;.");
    expect(html).toContain("sev-blocker");
    expect(html).toContain("res-fixed");
    expect(html).toContain("res-not_fixed");
  });

  it("says when no issues were found", () => {
    const html = reportFor(ticketResult({ review: { outcome: "reviewed", findings: [], resolutions: [] } }));
    expect(html).toContain("Review: no issues found");
  });

  it("shows why a review was skipped or failed", () => {
    expect(reportFor(ticketResult({ review: { outcome: "skipped", reason: "budget cap reached", findings: [], resolutions: [] } })))
      .toContain("Review skipped: budget cap reached");
    expect(reportFor(ticketResult({ review: { outcome: "failed", reason: "no block <x>", findings: [], resolutions: [] } })))
      .toContain("Review failed: no block &lt;x&gt;");
  });

  it("omits the section when the ticket was never reviewed", () => {
    expect(reportFor(ticketResult())).not.toContain('class="review"');
  });
});

describe("reportFilename", () => {
  it("uses the plain name when it is free", () => {
    expect(reportFilename("2026-10-01", () => false)).toBe("nightshift-2026-10-01.html");
  });

  it("adds the first free numeric suffix", () => {
    const taken = new Set(["nightshift-2026-10-01.html", "nightshift-2026-10-01-2.html"]);
    expect(reportFilename("2026-10-01", name => taken.has(name))).toBe("nightshift-2026-10-01-3.html");
  });

  it("starts at 2 when only the plain name is taken", () => {
    expect(reportFilename("2026-10-01", name => name === "nightshift-2026-10-01.html")).toBe("nightshift-2026-10-01-2.html");
  });
});

describe("report checks and risks", () => {
  it("renders a compact checks table", () => {
    const html = reportFor(ticketResult({ checks: [
      { name: "lint", command: "npm run lint", passed: true, durationSec: 12, status: "passed" },
      { name: "tests (services/a)", command: "npm test -w services/a", passed: false, durationSec: 30, status: "regression" },
      { name: "format", command: "npm run format", passed: false, durationSec: 3, status: "pre-existing" },
    ] }));
    expect(html).toContain("<td>lint</td><td>passed</td><td>12s</td>");
    expect(html).toContain("<td>tests (services/a)</td><td>regression</td><td>30s</td>");
    expect(html).toContain("failed (pre-existing)");
  });

  it("omits the checks table when none ran", () => {
    expect(reportFor(ticketResult())).not.toContain('class="checks"');
  });

  it("lists risks with escaping, with or without findings", () => {
    const risks = [{ file: "src/<a>.ts", risk: "Confirm <b>this</b>." }];
    const html = reportFor(ticketResult({ review: { outcome: "reviewed", findings: [], resolutions: [], risks } }));
    expect(html).toContain("Worth a closer look");
    expect(html).toContain("src/&lt;a&gt;.ts");
    expect(html).not.toContain("<b>this</b>");
  });
});
