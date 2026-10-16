import { describe, expect, it } from "vitest";
import { parseReplayFixArgs, replayFixSummary, roundOneFindings, type ReplayFixResult } from "../src/replay-fix-review.js";
import type { FixReviewStep } from "../src/review.js";
import type { FixResolution, RecordedCandidate, ReviewFinding, RunRecord, RunUsage, TicketConflict } from "../src/types.js";

const flags = {
  "--project": "acme", "--ticket": "ENG-1", "--base": "abc123", "--pre-diff": "pre.txt", "--diff": "d.txt",
  "--report": "r.txt", "--fix": "f.txt", "--session": "s.json",
};
const required = Object.entries(flags).flat();

describe("parseReplayFixArgs", () => {
  it("parses all flags in any order", () => {
    expect(parseReplayFixArgs(Object.entries(flags).reverse().flat()))
      .toEqual({ project: "acme", ticket: "ENG-1", base: "abc123", preDiff: "pre.txt", diff: "d.txt", report: "r.txt", fix: "f.txt", session: "s.json" });
  });

  it.each(Object.keys(flags))("throws the usage when %s is missing", flag => {
    const i = required.indexOf(flag);
    expect(() => parseReplayFixArgs([...required.slice(0, i), ...required.slice(i + 2)])).toThrow(`${flag} is required\nusage: replay-fix-review`);
  });

  it("rejects a ticket that is not an ID", () => {
    expect(() => parseReplayFixArgs([...required.slice(0, 3), "nope", ...required.slice(4)])).toThrow("expected a ticket ID");
  });

  it("rejects unknown arguments", () => {
    expect(() => parseReplayFixArgs([...required, "--bogus"])).toThrow('unknown argument "--bogus"');
  });
});

const reviewFinding = (id: string): ReviewFinding => ({ id, severity: "minor", file: "src/a.ts", issue: `Problem ${id}.`, suggestion: "Fix it." });
const reportedFix = (id: string): FixResolution => ({ id, status: "fixed", how: "done" });

describe("roundOneFindings", () => {
  it("keeps only the findings the fix log reported on", () => {
    const given = roundOneFindings([reviewFinding("R1"), reviewFinding("R2"), reviewFinding("C1")], [reportedFix("R1"), reportedFix("C1")], "logs/p/ENG-1-fix.txt");
    expect(given.map(f => f.id)).toEqual(["R1", "C1"]);
  });

  it("throws naming the fix log when none were reported", () => {
    expect(() => roundOneFindings([reviewFinding("R1")], [], "logs/p/ENG-1-fix.txt")).toThrow("logs/p/ENG-1-fix.txt");
  });
});

const usage = (over: Partial<RunUsage> = {}): RunUsage => ({
  inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheCreationTokens: 300, costUsd: 0.5, turns: 4, durationMs: 1000, models: ["m"], ...over,
});

const candidate = (over: Partial<RecordedCandidate>): RecordedCandidate => ({
  id: "F1", lens: "fixer", kind: "finding", severity: "minor", confidence: "proven", file: "tests/destination-folder.test.ts", issue: "no test for sanitiseFolderName",
  suggestion: "add one", data: false, ...over,
});

const step = (over: Partial<FixReviewStep> = {}): FixReviewStep => ({
  resolutions: [], reopened: [], pending: [], notes: [], needsReview: false, publish: true, stop: false,
  run: { round: 1, outcome: "reviewed", files: 2, candidates: 2 },
  verification: {
    outcome: "verified",
    results: [{ id: "R1", status: "resolved", note: "cap applied" }, { id: "R2", status: "unresolved", note: "callers untested" }],
  },
  ...over,
});

const finding = candidate({ id: "F1", verdict: { id: "F1", verdict: "confirmed", note: "reproduced" } });
const risk = candidate({ id: "F2", kind: "risk", file: "src/share.ts", issue: "truncation may collide", data: true, verdict: { id: "F2", verdict: "unproven", note: "no collision found" } });

const result: ReplayFixResult = {
  step: step(),
  candidates: [finding, risk],
  confirmation: { outcome: "confirmed" },
  confirmed: [{ id: "R4", severity: "minor", file: finding.file, issue: finding.issue, suggestion: "add one", from: "F1" }],
  risks: [{ file: risk.file, risk: risk.issue, data: true }],
  conflicts: [],
};

const runs: RunRecord[] = [
  { stage: "fix-review", usage: usage() },
  { stage: "fix-review-confirm-1" },
  { stage: "fix-review-confirm-2", usage: usage({ inputTokens: 500, outputTokens: 50, costUsd: 0.25 }) },
];

describe("replayFixSummary", () => {
  const text = replayFixSummary(result, runs);

  it("prints the fix review outcome", () => {
    expect(text).toContain("Fix review: reviewed (2 files, 2 candidates)");
  });

  it("lists each claim result", () => {
    expect(text).toContain("R1 resolved: cap applied");
    expect(text).toContain("R2 unresolved: callers untested");
  });

  it("lists fixer candidates with their verdicts", () => {
    expect(text).toContain("F1 [minor finding] tests/destination-folder.test.ts no test for sanitiseFolderName -> confirmed: reproduced");
    expect(text).toContain("F2 [minor risk] src/share.ts truncation may collide -> unproven: no collision found");
  });

  it("lists the confirmed findings with their new ids", () => {
    expect(text).toContain("R4 (from F1) minor tests/destination-folder.test.ts: no test for sanitiseFolderName");
  });

  it("marks data risks", () => {
    expect(text).toContain("src/share.ts [data]: truncation may collide");
  });

  it("prints usage per run and in total", () => {
    expect(text).toContain("fix-review: 6,300 in / 200 out, $0.50");
    expect(text).toContain("fix-review-confirm-1: no usage recorded");
    expect(text).toContain("total: 12,100 in / 250 out, $0.75");
  });

  it("says when there are no candidates", () => {
    const empty = replayFixSummary({ step: step(), candidates: [], confirmed: [], risks: [], conflicts: [] }, []);
    expect(empty).toContain("Fixer candidates: none");
    expect(empty).toContain("Confirmed findings: none");
    expect(empty).toContain("Risks: none");
  });

  const conflict = (over: Partial<TicketConflict> = {}): TicketConflict => ({
    from: "F1", file: "src/export.ts", ticket: "Drop rows with no id", quoted: true, consequence: "silently loses records", change: "keep and flag them", data: false, ...over,
  });

  it("lists ticket conflicts and marks a ticket line that was not found", () => {
    const text = replayFixSummary({ ...result, conflicts: [conflict(), conflict({ from: "F2", quoted: false }), conflict({ from: "F3", ticket: "" })] }, []);
    expect(text).toContain("Ticket conflicts:");
    expect(text).toContain('F1 ticket conflict src/export.ts: asks for "Drop rows with no id", silently loses records');
    expect(text).toContain('F2 ticket conflict src/export.ts: asks for "Drop rows with no id" (not found verbatim in the ticket), silently loses records');
    expect(text).toContain("F3 ticket conflict src/export.ts: no ticket line quoted, silently loses records");
  });

  it("says when there are no ticket conflicts", () => {
    expect(text).toContain("Ticket conflicts: none");
  });

  it("prints the confirm outcome only when it was not fully confirmed", () => {
    expect(text).not.toContain("Fix confirm");
    expect(replayFixSummary({ ...result, confirmation: { outcome: "partial" } }, [])).toContain("Fix confirm partial\n");
    expect(replayFixSummary({ ...result, confirmation: { outcome: "failed", reason: "no block" } }, [])).toContain("Fix confirm failed: no block");
  });

  it("reports a stopped confirm with its reason", () => {
    expect(replayFixSummary({ ...result, confirmation: undefined, stopped: "agent crashed" }, [])).toContain("Fix confirm stopped: agent crashed");
  });

  it("reports a failed fix review with its reason", () => {
    const failed = replayFixSummary({
      step: step({ run: { round: 1, outcome: "failed", reason: "the fix review run modified the worktree", files: 2, candidates: 0 }, verification: undefined }),
      candidates: [], confirmed: [], risks: [], conflicts: [],
    }, runs);
    expect(failed).toContain("Fix review: failed: the fix review run modified the worktree");
    expect(failed).toContain("total:");
  });
});
