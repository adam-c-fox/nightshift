import { describe, expect, it } from "vitest";
import { closedBudget, openNightBudget } from "../src/budget.js";
import { generateHTML, reportBase, reportFilename } from "../src/report.js";
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
  summary: "Did it.", filesCreated: [], filesModified: [], tests: [], verifyCommands: [], notes: "", followups: [],
  worktreePath: "/w", branch: "b", durationSec: 1, ...over,
});

const reportFor = (ticket: TicketResult) => generateHTML(session({ tickets: [ticket] }));

describe("report followups section", () => {
  it("lists spotted problems escaped", () => {
    const html = reportFor(ticketResult({ followups: [{ file: "src/<a>.ts", note: "Leaks <b>handle</b>." }] }));
    expect(html).toContain("Spotted, not fixed");
    expect(html).toContain("src/&lt;a&gt;.ts");
    expect(html).toContain("Leaks &lt;b&gt;handle&lt;/b&gt;.");
    expect(html).not.toContain("<b>handle</b>");
  });

  it("omits the section when there are none", () => {
    expect(reportFor(ticketResult())).not.toContain("Spotted, not fixed");
  });
});

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

describe("report fix verification", () => {
  const findings = [
    { id: "R1", severity: "blocker" as const, file: "a.ts", issue: "One.", suggestion: "s" },
    { id: "R2", severity: "major" as const, file: "b.ts", issue: "Two.", suggestion: "s" },
  ];

  it("shows verified and still-open findings", () => {
    const html = reportFor(ticketResult({ review: {
      outcome: "reviewed", findings,
      resolutions: [
        { id: "R1", status: "fixed", how: "Streamed." },
        { id: "R2", status: "not_fixed", how: "Added header; still open: <b>row 3</b> lacks it" },
      ],
      verification: { outcome: "verified", results: [
        { id: "R1", status: "resolved", note: "ok" },
        { id: "R2", status: "unresolved", note: "<b>row 3</b> lacks it" },
      ] },
    } }));
    expect(html).toContain("Fixed · verified");
    expect(html).toContain("Claimed fixed");
    expect(html).toContain("&lt;b&gt;row 3&lt;/b&gt; lacks it");
  });

  it("shows a line when verification was skipped or failed", () => {
    const base = { outcome: "reviewed" as const, findings, resolutions: [{ id: "R1", status: "fixed" as const, how: "Streamed." }] };
    const skipped = reportFor(ticketResult({ review: { ...base, verification: { outcome: "skipped", reason: "budget cap reached", results: [] } } }));
    expect(skipped).toContain("Fix verification skipped: budget cap reached");
    expect(skipped).toContain("Fixed (unverified)");
    expect(reportFor(ticketResult({ review: { ...base, verification: { outcome: "failed", reason: "no block <x>", results: [] } } })))
      .toContain("Fix verification failed: no block &lt;x&gt;");
  });
});

describe("reportBase", () => {
  it("is the report filename without its extension", () => {
    expect(reportBase("2026-10-01", name => name === "nightshift-2026-10-01.html")).toBe("nightshift-2026-10-01-2");
  });
});

describe("report postmortem section", () => {
  const sug = { id: "P1", target: "AGENTS.md", tickets: ["ENG-1"], problem: "Skipped <tests>", cause: "Vague step", change: "Add a line" };
  const withPm = (postmortem: SessionResult["postmortem"]) => generateHTML(session({ tickets: [ticketResult()], postmortem }));

  it("lists suggestions escaped with their fields and the file", () => {
    const html = withPm({ outcome: "done", suggestions: [sug], file: "reports/x-postmortem.md" });
    for (const text of ["Postmortem", "P1", "AGENTS.md", "ENG-1", "Skipped &lt;tests&gt;", "Vague step", "Add a line", "reports/x-postmortem.md"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("Postmortem not run");
  });
  it("says when there are no suggestions", () => {
    expect(withPm({ outcome: "done", suggestions: [] })).toContain("No suggestions");
  });
  it("flags a skipped postmortem prominently, also in the summary bar", () => {
    const html = withPm({ outcome: "skipped", reason: "budget cap reached", suggestions: [] });
    expect(html).toContain("Postmortem not run: budget cap reached");
    expect(html).toContain("postmortem-flag");
  });
  it("flags a failed postmortem", () => {
    expect(withPm({ outcome: "failed", reason: "claude exited with status 1", suggestions: [] }))
      .toContain("Postmortem failed: claude exited with status 1");
  });
  it("shows nothing when no postmortem was attempted", () => {
    expect(reportFor(ticketResult())).not.toContain("Postmortem");
  });
});

describe("report stacked tickets", () => {
  it("shows the parent ticket on a stacked card only", () => {
    const stacked = reportFor(ticketResult({ ticket: { id: "ENG-2", name: "Child", context: [], repo: "main", base: "ENG-1" } }));
    expect(stacked).toContain("Stacked on <code>ENG-1</code>");
    expect(reportFor(ticketResult())).not.toContain("Stacked on");
  });
});
