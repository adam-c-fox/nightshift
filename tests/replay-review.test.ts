import { describe, expect, it } from "vitest";
import { parseReplayArgs, replaySummary } from "../src/replay-review.js";
import type { FindAndConfirmResult } from "../src/review.js";
import type { RunRecord, RunUsage } from "../src/types.js";

const required = ["--project", "acme", "--ticket", "ENG-1", "--base", "abc123", "--diff", "d.txt", "--report", "r.txt"];

describe("parseReplayArgs", () => {
  it("parses the required flags in any order", () => {
    expect(parseReplayArgs(["--report", "r.txt", "--base", "abc123", "--project", "acme", "--diff", "d.txt", "--ticket", "ENG-1"]))
      .toEqual({ project: "acme", ticket: "ENG-1", base: "abc123", diff: "d.txt", report: "r.txt", related: [] });
  });

  it("collects repeated --related flags as ticket and branch", () => {
    expect(parseReplayArgs([...required, "--related", "ENG-2=feat/two", "--related", "ENG-3=feat/three"]).related)
      .toEqual([{ ticketId: "ENG-2", branch: "feat/two" }, { ticketId: "ENG-3", branch: "feat/three" }]);
  });

  it.each(["--project", "--ticket", "--base", "--diff", "--report"])("throws naming %s when it is missing", flag => {
    const i = required.indexOf(flag);
    const argv = [...required.slice(0, i), ...required.slice(i + 2)];
    expect(() => parseReplayArgs(argv)).toThrow(`${flag} is required`);
  });

  it("rejects a ticket that is not an ID", () => {
    expect(() => parseReplayArgs([...required.slice(0, 3), "nope", ...required.slice(4)])).toThrow("expected a ticket ID");
  });

  it("rejects a related value without a branch", () => {
    expect(() => parseReplayArgs([...required, "--related", "ENG-2"])).toThrow("--related expects ID=branch");
  });

  it("rejects unknown arguments", () => {
    expect(() => parseReplayArgs([...required, "--bogus"])).toThrow('unknown argument "--bogus"');
  });
});

const usage = (over: Partial<RunUsage> = {}): RunUsage => ({
  inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheCreationTokens: 300, costUsd: 0.5, turns: 4, durationMs: 1000, models: ["m"], ...over,
});

const found: FindAndConfirmResult = {
  findings: [{ id: "R1", severity: "major", file: "src/a.ts", issue: "reads first row only", suggestion: "loop", from: "B2" }],
  risks: [{ file: "src/b.ts", risk: "invalid CSV rejects the export", data: true }, { file: "src/c.ts", risk: "no retry", data: false }],
  record: {
    lenses: [
      { lens: "bugs", outcome: "reviewed", candidates: 3 },
      { lens: "spec", outcome: "failed", reason: "timed out", candidates: 0 },
    ],
    decisions: [{ id: "D1", decision: "null on miss", file: "src/a.ts", ruling: "accept", reason: "holds on every path" }],
  },
  notes: [],
  needsReview: true,
};

const runs: RunRecord[] = [
  { stage: "review-bugs", usage: usage() },
  { stage: "review-spec" },
  { stage: "review-confirm", usage: usage({ inputTokens: 500, outputTokens: 50, costUsd: 0.25 }) },
];

describe("replaySummary", () => {
  const text = replaySummary(found, runs);

  it("prints each confirmed finding with its id, origin, severity and file", () => {
    expect(text).toContain("R1 (from B2) major src/a.ts: reads first row only");
  });

  it("prints risks with their data flag", () => {
    expect(text).toContain("src/b.ts [data]: invalid CSV rejects the export");
    expect(text).toContain("src/c.ts: no retry");
    expect(text).not.toContain("src/c.ts [data]");
  });

  it("prints rulings and lens outcomes", () => {
    expect(text).toContain("D1 accept: holds on every path");
    expect(text).toContain("bugs reviewed (3 candidates)");
    expect(text).toContain("spec failed: timed out");
  });

  it("prints usage per run and in total", () => {
    expect(text).toContain("review-bugs: 6,300 in / 200 out, $0.50");
    expect(text).toContain("review-spec: no usage recorded");
    expect(text).toContain("total: 12,100 in / 250 out, $0.75");
  });

  it("says when nothing was found", () => {
    const empty = replaySummary({ ...found, findings: [], risks: [], record: {} }, []);
    expect(empty).toContain("Confirmed findings: none");
    expect(empty).toContain("Risks: none");
  });

  it("reports why a stopped review stopped", () => {
    const stopped = replaySummary({ stopped: { review: { outcome: "failed", reason: "worktree changed", findings: [], resolutions: [] }, publish: false, needsReview: true, notes: [] } }, runs);
    expect(stopped).toContain("Review stopped: worktree changed");
    expect(stopped).toContain("total:");
  });
});
