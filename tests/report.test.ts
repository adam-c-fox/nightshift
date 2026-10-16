import { describe, expect, it } from "vitest";
import { closedBudget, openNightBudget } from "../src/budget.js";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REPORT_BASE, countTickets, esc, generateHTML, postmortemActionKey, reportBase, reportFilename, ticketActionKey, writeReport,
} from "../src/report.js";
import { DASHBOARD_ORIGIN } from "../src/dashboard/address.js";
import type { RunUsage, SessionResult, TicketResult, TicketReview } from "../src/types.js";

const session = (over: Partial<SessionResult>): SessionResult => ({
  date: "2026-10-01", startedAt: "", endedAt: "", tickets: [],
  budget: openNightBudget({ weeklyPercent: 3, resetInfo: "Oct 7" }, 15),
  gateHit: false, skipReason: "", noTasks: false, ...over,
});

describe("report navigation", () => {
  it("links back to the dashboard home page", () => {
    expect(generateHTML(session({}))).toContain(`<a class="home" href="${DASHBOARD_ORIGIN}/">`);
  });
});

describe("report ticket loading failure", () => {
  it("shows why tickets could not be loaded", () => {
    const html = generateHTML(session({ ticketError: 'Ticket ENG-1: unknown repo "web" (known: main)' }));
    expect(html).toContain("Tickets could not be loaded");
    expect(html).toContain("unknown repo &quot;web&quot; (known: main)");
  });

  it("shows no banner when tickets loaded", () => {
    expect(generateHTML(session({}))).not.toContain("Tickets could not be loaded");
  });
});

describe("report budget section", () => {
  it("shows the effective allocation when the cap clamped it", () => {
    const budget = openNightBudget({ weeklyPercent: 40, resetInfo: "" }, 100);
    const html = generateHTML(session({ budget }));
    expect(html).toContain("100% requested, 60% available");
  });

  it("shows the plain allocation when nothing was clamped", () => {
    const html = generateHTML(session({}));
    expect(html).toContain("<strong>15%</strong> of weekly");
    expect(html).not.toContain("requested");
  });

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

describe("report inline code", () => {
  it("renders backticked spans in the summary, notes and followups as code", () => {
    const html = reportFor(ticketResult({
      summary: "Logs `import-worker message ignored` with a `reason`.",
      notes: "Renamed `isEligible`.",
      followups: [{ file: "src/a.ts", note: "Duplicates `parse`." }],
    }));
    expect(html).toContain('<code class="inline">import-worker message ignored</code> with a <code class="inline">reason</code>.');
    expect(html).toContain('Renamed <code class="inline">isEligible</code>.');
    expect(html).toContain('Duplicates <code class="inline">parse</code>.');
  });

  it("escapes html inside and around code spans", () => {
    const html = reportFor(ticketResult({ summary: "Wraps `<b>` in <i>." }));
    expect(html).toContain('Wraps <code class="inline">&lt;b&gt;</code> in &lt;i&gt;.');
  });

  it("leaves an unpaired backtick as text", () => {
    expect(reportFor(ticketResult({ summary: "Odd ` tick." }))).toContain("Odd ` tick.");
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

describe("report fix review", () => {
  type Recorded = NonNullable<TicketReview["candidates"]>[number];
  const candidate = (id: string, over: Partial<Recorded> = {}): Recorded => ({
    id, lens: "bugs", kind: "finding", severity: "major", confidence: "proven",
    file: `src/${id}.ts`, issue: `Issue ${id}.`, suggestion: "", data: false, ...over,
  });
  const fixerCandidates = [
    candidate("F1", { lens: "fixer", verdict: { id: "F1", verdict: "confirmed", note: "real" } }),
    candidate("F2", { lens: "fixer", verdict: { id: "F2", verdict: "rejected", note: "guarded" } }),
  ];
  const base: TicketReview = {
    outcome: "reviewed", resolutions: [],
    findings: [{ id: "R1", severity: "major", file: "a.ts", issue: "One.", suggestion: "s" }],
  };

  it("shows each fix review round on its own line with the fixer candidates' tally", () => {
    const html = reportFor(ticketResult({ review: {
      ...base,
      fixReviews: [
        { round: 1, outcome: "reviewed", files: 2, candidates: 2 },
        { round: 2, outcome: "reviewed", files: 1, candidates: 0 },
      ],
      candidates: fixerCandidates,
    } }));
    expect(html).toContain(`<div class="review review-stages">Fix review: round 1 ✓ · round 2 ✓ · 2 candidates → 1 confirmed, 0 unproven, 1 dropped</div>`);
  });

  it("keeps fixer candidates out of the lens tally", () => {
    const html = reportFor(ticketResult({ review: {
      ...base,
      lenses: [{ lens: "bugs", outcome: "reviewed", candidates: 1 }],
      fixReviews: [{ round: 1, outcome: "reviewed", files: 2, candidates: 2 }],
      candidates: [candidate("B1", { verdict: { id: "B1", verdict: "confirmed", note: "n" } }), ...fixerCandidates],
    } }));
    expect(html).toContain("Review: bugs ✓ · 1 candidates → 1 confirmed, 0 unproven, 0 dropped</div>");
    expect(html).toContain("Fix review: round 1 ✓ · 2 candidates → 1 confirmed, 0 unproven, 1 dropped</div>");
  });

  it("keeps fixer candidates and their ticket conflicts out of the lens tally", () => {
    const html = reportFor(ticketResult({ review: {
      ...base,
      lenses: [{ lens: "bugs", outcome: "reviewed", candidates: 1 }],
      fixReviews: [{ round: 1, outcome: "reviewed", files: 2, candidates: 2 }],
      candidates: [
        candidate("B1", { verdict: { id: "B1", verdict: "confirmed", note: "n" } }),
        candidate("F1", { lens: "fixer", verdict: { id: "F1", verdict: "ticket_conflict", note: "n" } }),
        candidate("F2", { lens: "fixer", verdict: { id: "F2", verdict: "confirmed", note: "n" } }),
      ],
      confirmation: { outcome: "partial", batches: [{ n: 1, ids: ["B1"], outcome: "confirmed" }, { n: 2, ids: ["B2"], outcome: "failed", reason: "x" }] },
    } }));
    expect(html).toContain("Review: bugs ✓ · 1 candidates → 1 confirmed, 0 unproven, 0 dropped · confirm in 2 batches (1 failed or skipped)</div>");
    expect(html).toContain("Fix review: round 1 ✓ · 2 candidates → 1 confirmed, 1 ticket conflict, 0 unproven, 0 dropped</div>");
  });

  it("shows a fix review round whose confirm was only partly done", () => {
    const html = reportFor(ticketResult({ review: {
      ...base,
      fixReviews: [
        { round: 1, outcome: "reviewed", files: 2, candidates: 2, confirmation: { outcome: "confirmed" } },
        { round: 2, outcome: "reviewed", files: 2, candidates: 2, confirmation: { outcome: "partial" } },
        { round: 3, outcome: "reviewed", files: 2, candidates: 2, confirmation: { outcome: "failed", reason: "no block <x>" } },
      ],
    } }));
    expect(html).toContain("Fix review: round 1 ✓ · round 2 ✓ (confirm partial) · round 3 ✓ (confirm failed: no block &lt;x&gt;)");
  });

  it("groups the fix review's confirm batches into one usage share", () => {
    const usage = (costUsd: number): RunUsage => ({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd, turns: 1, durationMs: 1, models: [] });
    const html = reportFor(ticketResult({ runs: [
      { stage: "fix-review-confirm-1", usage: usage(1) },
      { stage: "fix-review-confirm-2", usage: usage(1) },
      { stage: "fix-review-2-confirm-1", usage: usage(1) },
      { stage: "fix-review-2-confirm-2", usage: usage(1) },
    ] }));
    expect(html).toContain("fix-review-confirm 50% · fix-review-2-confirm 50%");
    expect(html).not.toContain("confirm-1");
  });

  it("labels a finding from the fix review", () => {
    const html = reportFor(ticketResult({ review: {
      ...base,
      findings: [...base.findings, { id: "R2", from: "F1", severity: "major", file: "b.ts", issue: "Two.", suggestion: "s" }],
      fixReviews: [{ round: 1, outcome: "reviewed", files: 2, candidates: 2 }],
      candidates: fixerCandidates,
    } }));
    expect(html).toContain("(from F1 · fixer's changes)");
  });

  it("shows a skipped or failed fix review with its reason", () => {
    const skipped = reportFor(ticketResult({ review: { ...base, fixReviews: [{ round: 1, outcome: "skipped", reason: "budget cap reached", files: 0, candidates: 0 }] } }));
    expect(skipped).toContain("Fix review: round 1 skipped (budget cap reached)");
    const failed = reportFor(ticketResult({ review: { ...base, fixReviews: [{ round: 1, outcome: "reviewed", files: 1, candidates: 0 }, { round: 2, outcome: "failed", reason: "no block <x>", files: 1, candidates: 0 }] } }));
    expect(failed).toContain("round 2 failed (no block &lt;x&gt;)");
  });

  it("still renders a record with verification and no fixReviews as before", () => {
    const old = reportFor(ticketResult({ review: { ...base, verification: { outcome: "skipped", reason: "budget cap reached", results: [] } } }));
    expect(old).toContain("Fix verification skipped: budget cap reached");
    expect(old).not.toContain("Fix review:");
    const current = reportFor(ticketResult({ review: {
      ...base,
      fixReviews: [{ round: 1, outcome: "reviewed", files: 1, candidates: 0 }],
      verification: { outcome: "skipped", reason: "budget cap reached", results: [] },
    } }));
    expect(current).not.toContain("Fix verification");
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

describe("writeReport", () => {
  it("writes the report into the given directory", () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "nightshift-report-")), "reports", "acme");
    const file = writeReport(session({}), dir, "nightshift-2026-10-01");
    expect(file).toBe(path.join(dir, "nightshift-2026-10-01.html"));
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).toContain("<html");
  });
});

describe("report collapsible sections and actioned checkboxes", () => {
  const sug = { id: "P1", target: "AGENTS.md", tickets: ["ENG-1"], problem: "p", cause: "c", change: "x" };
  const html = generateHTML(session({
    tickets: [ticketResult(), ticketResult({ ticket: { id: "ENG-2", name: "Import", context: [], repo: "main" }, status: "needs_review" })],
    postmortem: { outcome: "done", suggestions: [sug] },
  }));

  it("renders each ticket as a collapsed card with its status in the header", () => {
    expect(html).toContain('<details class="card" id="ticket-ENG-1">');
    expect(html).toMatch(/<summary class="card-header">[\s\S]*?NEEDS_REVIEW[\s\S]*?ENG-2[\s\S]*?<\/summary>/);
    expect(html).not.toMatch(/<details[^>]* open/);
  });

  it("gives every ticket and postmortem suggestion an actioned checkbox", () => {
    expect(html).toContain('<input type="checkbox" class="actioned" data-key="ticket:ENG-1"');
    expect(html).toContain('<input type="checkbox" class="actioned" data-key="ticket:ENG-2"');
    expect(html).toContain('<input type="checkbox" class="actioned" data-key="postmortem:P1"');
  });

  it("collapses the postmortem section", () => {
    expect(html).toMatch(/<details class="postmortem" id="postmortem">\s*<summary>/);
  });

  it("counts actioned items in the summary bar", () => {
    expect(html).toContain('id="actioned-count">0 / 3</strong>');
  });

  it("keeps a skipped postmortem visible without a checkbox", () => {
    const skipped = generateHTML(session({ tickets: [ticketResult()], postmortem: { outcome: "skipped", reason: "cap", suggestions: [] } }));
    expect(skipped).not.toContain('data-key="postmortem:');
    expect(skipped).toContain('id="actioned-count">0 / 1</strong>');
  });

  it("escapes ids used as storage keys", () => {
    const odd = generateHTML(session({ tickets: [ticketResult({ ticket: { id: 'X"1', name: "n", context: [], repo: "main" } })] }));
    expect(odd).toContain('data-key="ticket:X&quot;1"');
  });
});

describe("shared report helpers", () => {
  it("escapes html and quotes", () => {
    expect(esc('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("counts tickets by status, folding errors into skipped", () => {
    const statuses = ["done", "done", "partial", "needs_review", "skipped", "error"] as const;
    const tickets = statuses.map(status => ticketResult({ status }));
    expect(countTickets(tickets)).toEqual({ total: 6, done: 2, partial: 1, needsReview: 1, skipped: 2 });
  });

  it("captures the date and run number from a report base", () => {
    expect(REPORT_BASE.exec("nightshift-2026-10-01-2")?.slice(1)).toEqual(["2026-10-01", "2"]);
    expect(REPORT_BASE.test("nightshift-2026-10-01-postmortem")).toBe(false);
  });

  it("generates bases that match the report base pattern", () => {
    expect(REPORT_BASE.test(reportBase("2026-10-01", () => false))).toBe(true);
    expect(REPORT_BASE.test(reportBase("2026-10-01", name => name === "nightshift-2026-10-01.html"))).toBe(true);
  });

  it("builds action keys", () => {
    expect(ticketActionKey("ENG-1")).toBe("ticket:ENG-1");
    expect(postmortemActionKey("P2")).toBe("postmortem:P2");
  });

  it("keeps the theme and stats markup in the report", () => {
    const html = reportFor(ticketResult());
    expect(html).toContain('data-key="ticket:ENG-1"');
    expect(html).toContain("--bg: #0f1117");
    expect(html).toContain('<div class="stat"><strong style="color:#22c55e">1</strong>done</div>');
  });
});

describe("report review stages", () => {
  type Recorded = NonNullable<TicketReview["candidates"]>[number];
  const candidate = (id: string, over: Partial<Recorded> = {}): Recorded => ({
    id, lens: "bugs", kind: "finding", severity: "major", confidence: "proven",
    file: `src/${id}.ts`, issue: `Issue ${id}.`, suggestion: "", data: false, ...over,
  });
  const verdict = (id: string, v: "confirmed" | "duplicate" | "unproven" | "rejected" | "ticket_conflict", note = `note ${id}`) => ({ id, verdict: v, note });
  const staged = (over: Partial<TicketReview> = {}): TicketReview => ({
    outcome: "reviewed", findings: [], resolutions: [],
    lenses: [
      { lens: "bugs", outcome: "reviewed", candidates: 4 },
      { lens: "spec", outcome: "reviewed", candidates: 3 },
      { lens: "reuse", outcome: "failed", reason: "crashed <x>", candidates: 0 },
    ],
    candidates: [
      candidate("B1", { verdict: verdict("B1", "confirmed") }),
      candidate("B2", { verdict: verdict("B2", "unproven") }),
      candidate("B3", { verdict: verdict("B3", "rejected", "guarded on line 4") }),
      candidate("S1", { lens: "spec", verdict: { ...verdict("S1", "duplicate"), duplicateOf: "B1" } }),
    ],
    confirmation: { outcome: "confirmed" },
    ...over,
  });

  it("shows each lens's outcome and the candidate counts", () => {
    const html = reportFor(ticketResult({ review: staged() }));
    expect(html).toContain("Review: bugs ✓ · spec ✓ · reuse failed (crashed &lt;x&gt;)");
    expect(html).toContain("4 candidates → 1 confirmed, 1 unproven, 2 dropped");
  });

  it("labels the later bugs passes", () => {
    const html = reportFor(ticketResult({ review: staged({
      lenses: [
        { lens: "bugs", outcome: "reviewed", candidates: 1 },
        { lens: "bugs", pass: 2, outcome: "reviewed", candidates: 1 },
        { lens: "spec", outcome: "reviewed", candidates: 0 },
      ],
    }) }));
    expect(html).toContain("Review: bugs ✓ · bugs (pass 2) ✓ · spec ✓");
  });

  it("says the candidates were unconfirmed when confirm did not run", () => {
    const html = reportFor(ticketResult({ review: staged({
      candidates: [candidate("B1"), candidate("B2")], confirmation: { outcome: "failed", reason: "boom" },
    }) }));
    expect(html).toContain("2 candidates → unconfirmed");
  });

  it("shows where a finding came from", () => {
    const html = reportFor(ticketResult({ review: staged({
      findings: [{ id: "R1", severity: "major", file: "src/B1.ts", issue: "Issue B1.", suggestion: "", from: "B1" }],
    }) }));
    expect(html).toContain("(from B1)");
  });

  it("lists dropped and duplicate candidates collapsed with the reason", () => {
    const html = reportFor(ticketResult({ review: staged() }));
    expect(html).toMatch(/<details class="dropped">[\s\S]*B3[\s\S]*rejected[\s\S]*guarded on line 4[\s\S]*<\/details>/);
    expect(html).toMatch(/<details class="dropped">[\s\S]*S1[\s\S]*duplicate of B1[\s\S]*<\/details>/);
    expect(html).not.toMatch(/<details class="dropped">[\s\S]*Issue B2[\s\S]*<\/details>/);
  });

  it("lists decision rulings collapsed", () => {
    const html = reportFor(ticketResult({ review: staged({ decisions: [
      { id: "D1", decision: "null when no <row>", file: "src/a.ts", ruling: "accept", reason: "handled downstream" },
    ] }) }));
    expect(html).toMatch(/<details class="rulings">[\s\S]*D1<\/span> accept: [\s\S]*null when no &lt;row&gt;[\s\S]*handled downstream[\s\S]*<\/details>/);
  });

  it("marks risks to recorded data", () => {
    const html = reportFor(ticketResult({ review: staged({ risks: [
      { file: "src/a.ts", risk: "Records null.", data: true }, { file: "src/b.ts", risk: "Style.", data: false },
    ] }) }));
    expect(html.match(/<span class="data-risk">/g)).toHaveLength(1);
    expect(html).toMatch(/<span class="data-risk">[\s\S]*Records null\./);
  });

  it("renders a review recorded before lenses existed without the new sections", () => {
    const html = reportFor(ticketResult({ review: { outcome: "reviewed", findings: [], resolutions: [], risks: [{ file: "a.ts", risk: "Old." }] } }));
    expect(html).toContain("Review: no issues found");
    for (const absent of ["review-stages", "<details class=\"dropped\">", "<details class=\"rulings\">", "<span class=\"data-risk\">", "(from"]) expect(html).not.toContain(absent);
  });

  const conflict = (over: Partial<NonNullable<TicketReview["conflicts"]>[number]> = {}) => ({
    from: "S1", file: "src/export.ts", ticket: "Drop rows with no id", quoted: true,
    consequence: "Silently loses records", change: "Keep them and flag them.", data: false, ...over,
  });

  it("lists ticket conflicts at the top of the report with the ticket line and the suggested change, linking to the ticket", () => {
    const html = reportFor(ticketResult({ review: staged({ conflicts: [conflict({ ticket: 'Drop "orphan" rows', data: true })] }) }));
    const top = html.slice(html.indexOf('<section class="decisions"'), html.indexOf("</section>"));
    expect(html.indexOf('<section class="decisions"')).toBeLessThan(html.indexOf('id="ticket-ENG-1"'));
    expect(top).toContain("<h2>Decisions needed</h2>");
    expect(top).toContain('<a class="ticket-id" href="#ticket-ENG-1">ENG-1</a>');
    expect(top).toContain("<q>Drop &quot;orphan&quot; rows</q>");
    expect(top).toContain("Silently loses records");
    expect(top).toContain('<div class="finding-suggestion">Suggested change: Keep them and flag them.</div>');
    expect(top).toContain('<span class="data-risk">recorded data</span>');
    expect(top).not.toContain("not found verbatim");
  });

  it("leaves out the suggested change when the conflict has none", () => {
    const html = reportFor(ticketResult({ review: staged({ conflicts: [conflict({ change: undefined })] }) }));
    expect(html).toContain("Silently loses records");
    expect(html).not.toMatch(/Suggested change|undefined/);
  });

  it("leaves out the decisions section when no ticket has a conflict", () => {
    const html = reportFor(ticketResult({ review: staged({ conflicts: [] }) }));
    expect(html).not.toContain('<section class="decisions"');
    expect(html).not.toContain("Conflicts with the ticket");
    expect(reportFor(ticketResult({ review: staged() }))).not.toContain('<section class="decisions"');
  });

  it("flags a conflict whose ticket line was not found in the ticket", () => {
    const html = reportFor(ticketResult({ review: staged({ conflicts: [conflict({ quoted: false })] }) }));
    expect(html).toContain('<span class="unverified">not found verbatim in the ticket</span>');
    const bare = reportFor(ticketResult({ review: staged({ conflicts: [conflict({ ticket: "", quoted: false })] }) }));
    expect(bare).toContain('<span class="unverified">no ticket line quoted</span>');
    expect(bare).not.toContain("The ticket asks for:");
  });

  it("shows a ticket's conflicts ahead of its findings", () => {
    const review = staged({
      conflicts: [conflict()],
      findings: [{ id: "R1", severity: "major", file: "src/B1.ts", issue: "Issue B1.", suggestion: "" }],
    });
    const card = reportFor(ticketResult({ review })).split('id="ticket-ENG-1"')[1];
    expect(card).toContain("Conflicts with the ticket (1)");
    expect(card.indexOf("Conflicts with the ticket (1)")).toBeGreaterThan(card.indexOf("review-stages"));
    expect(card.indexOf("Conflicts with the ticket (1)")).toBeLessThan(card.indexOf('<ul class="findings">'));
    const clean = reportFor(ticketResult({ review: staged({ conflicts: [conflict()] }) })).split('id="ticket-ENG-1"')[1];
    expect(clean.indexOf("Review: no issues found")).toBeLessThan(clean.indexOf("Conflicts with the ticket (1)"));
    expect(clean.indexOf("review-stages")).toBeLessThan(clean.indexOf("Conflicts with the ticket (1)"));
  });

  it("escapes every interpolated value of a conflict", () => {
    const html = reportFor(ticketResult({ review: staged({ conflicts: [conflict({ ticket: "a < b", file: "src/<x>.ts", consequence: "c <i>", change: "d <b>" })] }) }));
    for (const raw of ["a < b", "src/<x>.ts", "c <i>", "d <b>"]) expect(html).not.toContain(raw);
    for (const escaped of ["a &lt; b", "src/&lt;x&gt;.ts", "c &lt;i&gt;", "d &lt;b&gt;"]) expect(html).toContain(escaped);
  });

  it("counts conflicts, batches and overturned rejections in the candidate tally", () => {
    const html = reportFor(ticketResult({ review: staged({
      candidates: [
        candidate("B1", { verdict: verdict("B1", "confirmed") }),
        candidate("B2", { verdict: verdict("B2", "ticket_conflict") }),
        candidate("B3", { verdict: { ...verdict("B3", "unproven"), adjusted: { from: "rejected" } } }),
        candidate("B4", { verdict: verdict("B4", "rejected") }),
      ],
      confirmation: { outcome: "partial", dedupe: { outcome: "failed", reason: "boom", merged: 0 }, batches: [
        { n: 1, ids: ["B1", "B2"], outcome: "confirmed" }, { n: 2, ids: ["B3", "B4"], outcome: "failed", reason: "x" },
      ] },
    }) }));
    expect(html).toContain("4 candidates → 1 confirmed, 1 ticket conflict, 1 unproven, 1 dropped, 1 rejection overturned · confirm in 2 batches (1 failed or skipped) · dedupe failed");
  });

  it("pluralises ticket conflicts and leaves a single clean batch out of the tally", () => {
    const html = reportFor(ticketResult({ review: staged({
      candidates: [candidate("B1", { verdict: verdict("B1", "ticket_conflict") }), candidate("B2", { verdict: verdict("B2", "ticket_conflict") })],
      confirmation: { outcome: "confirmed", batches: [{ n: 1, ids: ["B1", "B2"], outcome: "confirmed" }] },
    }) }));
    expect(html).toContain("2 candidates → 0 confirmed, 2 ticket conflicts, 0 unproven, 0 dropped</div>");
  });

  it("counts candidates left unconfirmed by a failed batch", () => {
    const html = reportFor(ticketResult({ review: staged({
      candidates: [candidate("B1", { verdict: verdict("B1", "confirmed") }), candidate("B2")],
      confirmation: { outcome: "partial", batches: [{ n: 1, ids: ["B1"], outcome: "confirmed" }, { n: 2, ids: ["B2"], outcome: "skipped", reason: "budget" }] },
    }) }));
    expect(html).toContain("2 candidates → 1 confirmed, 0 unproven, 0 dropped, 1 unconfirmed · confirm in 2 batches (1 failed or skipped)");
  });

  it("counts overturned rejections that became ticket conflicts", () => {
    const html = reportFor(ticketResult({ review: staged({
      candidates: [
        candidate("B1", { verdict: { ...verdict("B1", "ticket_conflict"), adjusted: { from: "rejected" } } }),
        candidate("B2", { verdict: { ...verdict("B2", "unproven"), adjusted: { from: "rejected" } } }),
      ],
      confirmation: { outcome: "confirmed", batches: [{ n: 1, ids: ["B1", "B2"], outcome: "confirmed" }] },
    }) }));
    expect(html).toContain("2 candidates → 0 confirmed, 1 ticket conflict, 1 unproven, 0 dropped, 2 rejections overturned");
  });

  it("shows the evidence line of a rejected candidate", () => {
    const html = reportFor(ticketResult({ review: staged({
      candidates: [candidate("B3", { verdict: { ...verdict("B3", "rejected", "guarded"), evidence: "if (!row) return;" } })],
    }) }));
    expect(html).toContain('rejected <code class="finding-file">if (!row) return;</code>');
  });

  it("folds confirm batches into one review-confirm share of usage", () => {
    const usage = (costUsd: number): RunUsage => ({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd, turns: 1, durationMs: 1, models: [] });
    const html = reportFor(ticketResult({ runs: [
      { stage: "implement", usage: usage(2) },
      { stage: "review-confirm-1", usage: usage(1) },
      { stage: "review-confirm-2", usage: usage(1) },
      { stage: "review-bugs-2", usage: usage(4) },
    ] }));
    expect(html).toContain("implement 25% · review-confirm 25% · review-bugs-2 50%");
    expect(html).not.toContain("review-confirm-1");
  });

  it("renders a review recorded before confirm batches", () => {
    const html = reportFor(ticketResult({ review: staged({ confirmation: { outcome: "confirmed" } }) }));
    expect(html).toContain("4 candidates → 1 confirmed, 1 unproven, 2 dropped</div>");
  });

  it("keeps the skipped and failed lines", () => {
    const html = reportFor(ticketResult({ review: staged({ outcome: "failed", reason: "all lenses failed" }) }));
    expect(html).toContain("Review failed: all lenses failed");
  });
});

describe("report usage", () => {
  const usage = (over: Partial<RunUsage> = {}): RunUsage => ({
    inputTokens: 1000, outputTokens: 500, cacheReadTokens: 8000, cacheCreationTokens: 1000, costUsd: 2, turns: 3, durationMs: 1000, models: [], ...over,
  });

  it("shows each ticket's usage with the share per stage", () => {
    const html = reportFor(ticketResult({ runs: [
      { stage: "implement", usage: usage({ costUsd: 3 }) },
      { stage: "review", usage: usage({ costUsd: 1 }) },
    ] }));
    expect(html).toContain("Usage: 20.0k in / 1.0k out");
    expect(html).toContain("$4.00 API-equivalent");
    expect(html).toContain("implement 75% · review 25%");
  });

  it("totals usage for the night", () => {
    const html = generateHTML(session({ tickets: [
      ticketResult({ runs: [{ stage: "implement", usage: usage() }] }),
      ticketResult({ ticket: { id: "ENG-2", name: "Other", context: [], repo: "main" }, runs: [{ stage: "implement", usage: usage() }] }),
    ] }));
    expect(html).toContain("$4.00");
    expect(html).toContain("20.0k in / 1.0k out");
    expect(html).toContain("night-usage");
  });

  it("adds the postmortem run to the night total", () => {
    const html = generateHTML(session({
      tickets: [ticketResult({ runs: [{ stage: "implement", usage: usage() }] })],
      postmortem: { outcome: "done", suggestions: [], usage: usage({ costUsd: 1 }) },
    }));
    expect(html).toContain("<strong>$3.00</strong>");
    expect(html).toContain("20.0k in / 1.0k out");
  });

  it("counts runs without usage as unmeasured", () => {
    const html = reportFor(ticketResult({ runs: [
      { stage: "implement", usage: usage() },
      { stage: "fix" },
      { stage: "verify" },
    ] }));
    expect(html).toContain("2 runs unmeasured");
    expect(reportFor(ticketResult({ runs: [{ stage: "implement" }] }))).toContain("1 run unmeasured");
  });

  it("renders a session recorded before usage existed", () => {
    const html = reportFor(ticketResult());
    expect(html).not.toContain("Usage:");
    expect(html).not.toContain("night-usage");
    expect(html).not.toContain("unmeasured");
  });
});
