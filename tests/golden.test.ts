import { describe, expect, it } from "vitest";
import { candidateOrigin, matchCandidate, parseGolden, scoreSummary, scoreTicket, totalSummary } from "../src/golden.js";
import type { GoldenItem, GoldenSet } from "../src/golden.js";
import { NOT_COVERED_NOTE } from "../src/confirm.js";
import type { CandidateVerdict, ReviewCandidate, RunRecord, RunUsage, TicketReview } from "../src/types.js";

const rawItem = (over: Record<string, unknown> = {}) => ({
  id: "1-1", file: "src/a.ts", issue: "drops the last row", expect: "finding", origin: "change",
  match: { files: ["src/a.ts"], all: [["last row"]] }, ...over,
});

const rawGolden = (over: Record<string, unknown> = {}) => ({ version: 1, ticket: "ENG-1", items: [rawItem()], ...over });

describe("parseGolden", () => {
  it("parses a version 1 golden set with items and noise", () => {
    const noise = { id: "1-n1", file: "src/e.ts", issue: "fine as is", match: { files: ["src/e.ts"], all: [["fine"]] } };
    const golden = parseGolden(rawGolden({ sources: ["review"], items: [rawItem({ guard: true })], noise: [noise] }));
    expect(golden).toEqual({ version: 1, ticket: "ENG-1", sources: ["review"], items: [rawItem({ guard: true })], noise: [noise] });
  });

  it("defaults noise to empty and guard to false", () => {
    const golden = parseGolden(rawGolden());
    expect(golden.noise).toEqual([]);
    expect(golden.items[0]!.guard).toBe(false);
  });

  it("rejects an unknown version", () => {
    expect(() => parseGolden(rawGolden({ version: 2 }))).toThrow("version");
  });

  it("rejects a missing ticket and items that are not an array", () => {
    expect(() => parseGolden(rawGolden({ ticket: undefined }))).toThrow("ticket");
    expect(() => parseGolden(rawGolden({ items: {} }))).toThrow("items");
  });

  it.each(["id", "file", "issue"])("rejects an item without %s", field => {
    expect(() => parseGolden(rawGolden({ items: [rawItem({ [field]: undefined })] }))).toThrow(field);
  });

  it("rejects an item without match files or term groups", () => {
    expect(() => parseGolden(rawGolden({ items: [rawItem({ match: { files: [], all: [["x"]] } })] }))).toThrow("1-1");
    expect(() => parseGolden(rawGolden({ items: [rawItem({ match: { files: ["src/a.ts"], all: [] } })] }))).toThrow("1-1");
    expect(() => parseGolden(rawGolden({ items: [rawItem({ match: { files: ["src/a.ts"], all: [[]] } })] }))).toThrow("1-1");
    expect(() => parseGolden(rawGolden({ items: [rawItem({ match: { files: ["src/a.ts"], all: [[1]] } })] }))).toThrow("1-1");
  });

  it("accepts expect decision", () => {
    expect(parseGolden(rawGolden({ items: [rawItem({ expect: "decision" })] })).items[0]!.expect).toBe("decision");
  });

  it("rejects an expect other than finding, surfaced or decision, and an origin other than change or fix", () => {
    expect(() => parseGolden(rawGolden({ items: [rawItem({ expect: "confirmed" })] }))).toThrow("expect must be finding, surfaced or decision");
    expect(() => parseGolden(rawGolden({ items: [rawItem({ origin: "later" })] }))).toThrow("origin");
  });

  it("rejects duplicate ids across items and noise", () => {
    const noise = { id: "1-1", file: "src/e.ts", issue: "fine", match: { files: ["src/e.ts"], all: [["fine"]] } };
    expect(() => parseGolden(rawGolden({ noise: [noise] }))).toThrow("duplicate");
  });
});

describe("matchCandidate", () => {
  const match = { files: ["src/a.ts", "lib/b.ts"], all: [["last row", "final row"], ["loop"]] };
  const text = { file: "src/a.ts", issue: "The loop drops the Last Row", suggestion: "iterate fully" };

  it("matches when the file is listed and every term group hits the issue or suggestion", () => {
    expect(matchCandidate(match, text)).toBe("match");
    expect(matchCandidate(match, { ...text, issue: "drops the last row", suggestion: "use a loop" })).toBe("match");
  });

  it("ignores case", () => {
    expect(matchCandidate({ files: ["src/a.ts"], all: [["LAST ROW"]] }, text)).toBe("match");
  });

  it("accepts a path given with ./ or as a suffix", () => {
    expect(matchCandidate(match, { ...text, file: "./src/a.ts" })).toBe("match");
    expect(matchCandidate(match, { ...text, file: "pkg/lib/b.ts" })).toBe("match");
    expect(matchCandidate({ files: ["./src/a.ts"], all: [["loop"]] }, text)).toBe("match");
    expect(matchCandidate(match, { ...text, file: "src/aa.ts" })).toBe("possible");
  });

  it("is possible when the file is listed but a term group misses", () => {
    expect(matchCandidate({ ...match, all: [["last row"], ["retry"]] }, text)).toBe("possible");
  });

  it("is possible when every group hits but the file is not listed", () => {
    expect(matchCandidate(match, { ...text, file: "src/z.ts" })).toBe("possible");
  });

  it("is none when the file is listed and no group hits", () => {
    expect(matchCandidate(match, { ...text, issue: "unrelated", suggestion: "" })).toBe("none");
  });
});

const lenses = [
  { lens: "bugs", outcome: "reviewed", candidates: 2 },
  { lens: "bugs", pass: 2, outcome: "reviewed", candidates: 2 },
  { lens: "spec", outcome: "reviewed", candidates: 1 },
  { lens: "reuse", outcome: "reviewed", candidates: 1 },
] as const;

const candidate = (over: Partial<ReviewCandidate> = {}): ReviewCandidate => ({
  id: "B1", lens: "bugs", kind: "finding", severity: "major", confidence: "proven", file: "src/a.ts", issue: "drops the last row", suggestion: "loop", data: false, ...over,
});

describe("candidateOrigin", () => {
  const review = { lenses: [...lenses], decisions: [] };

  it("names the bugs pass from the per-pass candidate counts", () => {
    expect(candidateOrigin(candidate({ id: "B2" }), review)).toBe("bugs");
    expect(candidateOrigin(candidate({ id: "B3" }), review)).toBe("bugs (pass 2)");
    expect(candidateOrigin(candidate({ id: "S1", lens: "spec" }), review)).toBe("spec");
    expect(candidateOrigin(candidate({ id: "U1", lens: "reuse" }), review)).toBe("reuse");
  });

  it("names the decision for a risk added from a ruling", () => {
    const decisions = [
      { id: "D1", decision: "null on miss", file: "src/a.ts", ruling: "accept" as const, reason: "holds" },
      { id: "D2", decision: "skip retries", file: "src/b.ts", ruling: "risk" as const, reason: "retries are lost" },
    ];
    expect(candidateOrigin(candidate({ id: "B5", issue: "retries are lost" }), { lenses: [...lenses], decisions })).toBe("decision D2");
    expect(candidateOrigin(candidate({ id: "B5", issue: "skip retries" }), { lenses: [...lenses], decisions })).toBe("decision D2");
    expect(candidateOrigin(candidate({ id: "B5", issue: "other" }), { lenses: [...lenses], decisions })).toBe("decision");
  });

  it("falls back to the lens name without lens runs", () => {
    expect(candidateOrigin(candidate({ id: "B3" }), {})).toBe("bugs");
    expect(candidateOrigin(candidate({ id: "U1", lens: "reuse" }), { lenses: [{ lens: "bugs", outcome: "reviewed", candidates: 1 }] })).toBe("reuse");
  });
});

type Reviewed = ReviewCandidate & { verdict?: CandidateVerdict };

const verdicted = (over: Partial<ReviewCandidate>, verdict?: Partial<CandidateVerdict>): Reviewed => {
  const base = candidate(over);
  return verdict ? { ...base, verdict: { id: base.id, verdict: "confirmed", note: "checked", ...verdict } } : base;
};

const review = (candidates: Reviewed[], over: Partial<TicketReview> = {}): TicketReview => ({
  outcome: "reviewed", findings: [], resolutions: [], lenses: [...lenses], candidates, confirmation: { outcome: "confirmed" }, ...over,
});

const item = (over: Partial<GoldenItem> = {}): GoldenItem => ({
  id: "1-1", file: "src/a.ts", issue: "drops the last row", expect: "finding", origin: "change", guard: false,
  match: { files: ["src/a.ts"], all: [["last row"]] }, ...over,
});

const golden = (items: GoldenItem[] = [item()], noise: GoldenSet["noise"] = []): GoldenSet => ({ version: 1, ticket: "ENG-1", items, noise });

describe("scoreTicket", () => {
  it("reports the finder and confirm outcome for each item", () => {
    const score = scoreTicket(golden(), review([verdicted({ id: "B3" }, {})]));
    expect(score.items).toHaveLength(1);
    expect(score.items[0]).toMatchObject({ id: "1-1", outcome: "confirmed", found: true, met: true, hits: [{ id: "B3", origin: "bugs (pass 2)", outcome: "confirmed" }] });
    expect(score.counts).toEqual({ items: 1, found: 1, confirmed: 1, surfaced: 1, met: 1, lost: 0 });
  });

  it("follows a duplicate to a primary that matches the same item", () => {
    const score = scoreTicket(golden(), review([
      verdicted({ id: "B1" }, { verdict: "unproven" }),
      verdicted({ id: "B2" }, { verdict: "duplicate", duplicateOf: "B1" }),
    ]));
    expect(score.items[0]!.hits.map(h => h.outcome)).toEqual(["unproven", "unproven"]);
    expect(score.items[0]!.outcome).toBe("unproven");
  });

  it("reports a duplicate merged into an unrelated candidate with the primary's outcome", () => {
    const score = scoreTicket(golden(), review([
      verdicted({ id: "B1", issue: "something else", suggestion: "" }, { verdict: "rejected" }),
      verdicted({ id: "B2" }, { verdict: "duplicate", duplicateOf: "B1" }),
    ]));
    expect(score.items[0]!.hits).toEqual([{ id: "B2", origin: "bugs", outcome: "duplicate", duplicateOf: "B1", primaryOutcome: "rejected" }]);
    expect(score.items[0]!.outcome).toBe("duplicate");
    expect(score.counts.lost).toBe(1);
  });

  it("survives a duplicate cycle or a missing primary", () => {
    const score = scoreTicket(golden(), review([
      verdicted({ id: "B1" }, { verdict: "duplicate", duplicateOf: "B2" }),
      verdicted({ id: "B2" }, { verdict: "duplicate", duplicateOf: "B1" }),
      verdicted({ id: "B3" }, { verdict: "duplicate", duplicateOf: "B9" }),
    ]));
    expect(score.items[0]!.found).toBe(true);
    expect(score.items[0]!.outcome).toBe("duplicate");
  });

  it("reports missing when confirm gave no verdict", () => {
    const score = scoreTicket(golden(), review([verdicted({ id: "B1" }, { verdict: "unproven", note: NOT_COVERED_NOTE })]));
    expect(score.items[0]!.outcome).toBe("missing");
    expect(score.counts).toMatchObject({ found: 1, surfaced: 0, lost: 1 });
  });

  it("takes the best outcome when several candidates match", () => {
    const score = scoreTicket(golden(), review([
      verdicted({ id: "B1" }, { verdict: "rejected" }),
      verdicted({ id: "S1", lens: "spec" }, { verdict: "unproven" }),
      verdicted({ id: "U1", lens: "reuse" }, { verdict: "confirmed" }),
    ]));
    expect(score.items[0]!.outcome).toBe("confirmed");
    expect(score.items[0]!.hits).toHaveLength(3);
  });

  it("counts unproven as met only for surfaced items", () => {
    const candidates = [verdicted({ id: "B1" }, { verdict: "unproven" })];
    expect(scoreTicket(golden([item({ expect: "finding" })]), review(candidates)).items[0]!.met).toBe(false);
    const surfaced = scoreTicket(golden([item({ expect: "surfaced" })]), review(candidates));
    expect(surfaced.items[0]!.met).toBe(true);
    expect(surfaced.counts).toMatchObject({ confirmed: 0, surfaced: 1, met: 1 });
  });

  it("ranks a ticket conflict just below confirmed", () => {
    const below = scoreTicket(golden(), review([
      verdicted({ id: "B1" }, { verdict: "unproven" }),
      verdicted({ id: "S1", lens: "spec" }, { verdict: "ticket_conflict" }),
    ]));
    expect(below.items[0]!.outcome).toBe("ticket_conflict");
    const above = scoreTicket(golden(), review([
      verdicted({ id: "B1" }, { verdict: "ticket_conflict" }),
      verdicted({ id: "S1", lens: "spec" }, { verdict: "confirmed" }),
    ]));
    expect(above.items[0]!.outcome).toBe("confirmed");
  });

  it("counts a ticket conflict as surfaced and meets a surfaced item with it", () => {
    const score = scoreTicket(golden([item({ expect: "surfaced" })]), review([verdicted({ id: "B1" }, { verdict: "ticket_conflict" })]));
    expect(score.items[0]!.met).toBe(true);
    expect(score.counts).toMatchObject({ confirmed: 0, surfaced: 1, met: 1 });
  });

  it("meets a decision item with a ticket conflict or a confirmed verdict", () => {
    for (const verdict of ["ticket_conflict", "confirmed"] as const) {
      const score = scoreTicket(golden([item({ expect: "decision" })]), review([verdicted({ id: "B1" }, { verdict })]));
      expect(score.items[0]!.met).toBe(true);
    }
  });

  it("does not meet a decision item with an unproven verdict", () => {
    const score = scoreTicket(golden([item({ expect: "decision" })]), review([verdicted({ id: "B1" }, { verdict: "unproven" })]));
    expect(score.items[0]!.met).toBe(false);
  });

  it("does not meet a finding item with a ticket conflict", () => {
    const score = scoreTicket(golden([item({ expect: "finding" })]), review([verdicted({ id: "B1" }, { verdict: "ticket_conflict" })]));
    expect(score.items[0]!.met).toBe(false);
  });

  it("reports not found when no candidate matches", () => {
    const score = scoreTicket(golden(), review([verdicted({ id: "B1", issue: "unrelated", suggestion: "" }, {})]));
    expect(score.items[0]).toMatchObject({ outcome: "not found", found: false, met: false, hits: [] });
  });

  it("lists candidates that match the file but not every term as possible", () => {
    const twoGroups = item({ match: { files: ["src/a.ts"], all: [["last row"], ["retry"]] } });
    const score = scoreTicket(golden([twoGroups]), review([verdicted({ id: "B4", suggestion: "" }, {}), verdicted({ id: "U1", lens: "reuse", file: "src/z.ts", suggestion: "retry" }, {})]));
    expect(score.items[0]!.possible).toEqual(["B4", "U1"]);
  });

  it("keeps fix-origin items out of the counts", () => {
    const score = scoreTicket(golden([item({ id: "1-4", origin: "fix" })]), review([]));
    expect(score.items).toEqual([]);
    expect(score.fixItems.map(i => i.id)).toEqual(["1-4"]);
    expect(score.counts.items).toBe(0);
  });

  it("does not credit a change item to a candidate from the fix review", () => {
    const score = scoreTicket(golden(), review([verdicted({ id: "F1", lens: "fixer" }, {})]));
    expect(score.items[0]).toMatchObject({ outcome: "not found", found: false, met: false });
    expect(score.unmatchedConfirmed).toEqual([]);
  });

  it("scores a fix-origin item against fix review candidates", () => {
    const score = scoreTicket(golden([item({ id: "1-4", origin: "fix" })]), review([verdicted({ id: "F1", lens: "fixer" }, {})]));
    expect(score.fixItems[0]).toMatchObject({ outcome: "confirmed", found: true });
  });

  it("counts guards separately", () => {
    const score = scoreTicket(golden([item({ id: "1-g1", guard: true }), item({ id: "1-2", match: { files: ["src/a.ts"], all: [["nothing"]] } })]), review([verdicted({ id: "B1" }, {})]));
    expect(score.guards.map(i => i.id)).toEqual(["1-g1"]);
    expect(score.guardCounts).toMatchObject({ items: 1, confirmed: 1 });
    expect(score.counts).toMatchObject({ items: 1, found: 0 });
  });

  it("marks items unconfirmed when the confirm step did not run", () => {
    const score = scoreTicket(golden(), review([verdicted({ id: "B1" })], { confirmation: { outcome: "failed", reason: "timed out" } }));
    expect(score.items[0]!.outcome).toBe("unconfirmed");
    expect(score.confirmation).toBe("failed (timed out)");
  });

  it("counts noise that confirm confirmed", () => {
    const noise = [{ id: "1-n1", file: "src/e.ts", issue: "fine", match: { files: ["src/e.ts"], all: [["fine"]] } }, { id: "1-n2", file: "src/e.ts", issue: "ok", match: { files: ["src/e.ts"], all: [["ok"]] } }];
    const score = scoreTicket(golden([], noise), review([
      verdicted({ id: "B1", file: "src/e.ts", issue: "this is fine" }, { verdict: "confirmed" }),
      verdicted({ id: "B2", file: "src/e.ts", issue: "this is ok" }, { verdict: "rejected" }),
    ]));
    expect(score.noise.map(n => [n.id, n.outcome, n.met])).toEqual([["1-n1", "confirmed", false], ["1-n2", "rejected", false]]);
    expect(score.noiseConfirmed).toBe(1);
  });

  it("lists confirmed findings that match no golden entry", () => {
    const score = scoreTicket(golden(), review([
      verdicted({ id: "B1" }, {}),
      verdicted({ id: "B2", file: "src/f.ts", issue: "new problem" }, {}),
      verdicted({ id: "B3", file: "src/g.ts", issue: "weak" }, { verdict: "unproven" }),
    ]));
    expect(score.unmatchedConfirmed).toEqual([{ id: "B2", file: "src/f.ts", issue: "new problem" }]);
  });

  it("keeps an unknown verdict as its own outcome", () => {
    const score = scoreTicket(golden(), review([{ ...candidate({ id: "B1" }), verdict: { id: "B1", verdict: "maybe" as never, note: "" } }]));
    expect(score.items[0]!.outcome).toBe("maybe");
    expect(score.items[0]!.found).toBe(true);
  });

  it("shows the resolution and verification of a confirmed match", () => {
    const candidates = [verdicted({ id: "B1" }, {})];
    const finding = { id: "R2", severity: "major" as const, file: "src/a.ts", issue: "x", suggestion: "y", from: "B1" };
    const resolution = (status: "fixed" | "not_fixed") => ({ id: "R2", status, how: "done" });
    const verified = (status: "resolved" | "unresolved") => ({ outcome: "verified" as const, results: [{ id: "R2", status, note: "" }] });
    const resolutionOf = (over: Partial<TicketReview>) => scoreTicket(golden(), review(candidates, { findings: [finding], ...over })).items[0]!.hits[0]!.resolution;
    expect(resolutionOf({ resolutions: [resolution("fixed")], verification: verified("resolved") })).toBe("R2 fixed, verified");
    expect(resolutionOf({ resolutions: [resolution("fixed")], verification: verified("unresolved") })).toBe("R2 fixed, still open");
    expect(resolutionOf({ resolutions: [resolution("fixed")] })).toBe("R2 fixed");
    expect(resolutionOf({ resolutions: [resolution("not_fixed")] })).toBe("R2 not fixed");
    expect(scoreTicket(golden(), review(candidates)).items[0]!.hits[0]).not.toHaveProperty("resolution");
  });

  it("never matches on the confirm note", () => {
    const score = scoreTicket(golden(), review([verdicted({ id: "B1", issue: "unrelated", suggestion: "" }, { note: "also drops the last row" })]));
    expect(score.items[0]!.found).toBe(false);
  });

  it("is plain JSON", () => {
    const score = scoreTicket(golden(), review([verdicted({ id: "B1" }, {})]));
    expect(JSON.parse(JSON.stringify(score))).toEqual(score);
  });
});

const usage = (over: Partial<RunUsage> = {}): RunUsage => ({
  inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.48, turns: 7, durationMs: 1000, models: ["m"], ...over,
});

const runs: RunRecord[] = [
  { stage: "review-bugs", usage: usage() },
  { stage: "review-spec" },
  { stage: "review-confirm", usage: usage({ costUsd: 0.26, turns: 3 }) },
];

describe("scoreSummary", () => {
  const items = [
    item(),
    item({ id: "1-2", file: "src/b.ts", expect: "surfaced", match: { files: ["src/b.ts"], all: [["second"]] } }),
    item({ id: "1-3", file: "src/c.ts", match: { files: ["src/c.ts"], all: [["third"]] } }),
  ];
  const candidates = [
    verdicted({ id: "B1" }, {}),
    verdicted({ id: "B2", file: "src/b.ts", issue: "second problem" }, { verdict: "unproven" }),
    verdicted({ id: "B4", file: "src/z.ts", issue: "third problem" }, {}),
  ];
  const text = scoreSummary(scoreTicket(golden(items), review(candidates), runs));

  it("prints one line per item with candidate, origin and outcome", () => {
    expect(text).toContain("1-1 src/a.ts: B1 (bugs) confirmed");
    expect(text).toContain("1-2 src/b.ts: B2 (bugs) unproven");
    expect(text).toContain("1-3 src/c.ts: not found");
  });

  it("prints the counts line", () => {
    expect(text).toContain("found 2/3");
    expect(text).toContain("confirmed 1/3");
    expect(text).toContain("surfaced 2/3");
    expect(text).toContain("met 2/3");
    expect(text).toContain("lost at confirm 0");
  });

  it("lists possible matches separately", () => {
    expect(text).toContain("possible: 1-3 ~ B4");
  });

  it("shows a duplicate with its primary and the confirm status", () => {
    const merged = scoreSummary(scoreTicket(golden(), review([
      verdicted({ id: "B1", issue: "other", suggestion: "" }, { verdict: "rejected" }),
      verdicted({ id: "B3" }, { verdict: "duplicate", duplicateOf: "B1" }),
    ], { confirmation: { outcome: "failed", reason: "timed out" } })));
    expect(merged).toContain("B3 (bugs (pass 2)) duplicate of B1 (rejected)");
    expect(merged).toContain("confirm: failed (timed out)");
    expect(text).not.toContain("confirm:");
  });

  it("prints usage per stage and the total", () => {
    expect(text).toContain("review-bugs $0.48 (7 turns)");
    expect(text).toContain("review-spec no usage");
    expect(text).toContain("review-confirm $0.26 (3 turns)");
    expect(text).toContain("total $0.74");
  });

  it("says when nothing confirmed is unmatched", () => {
    expect(scoreSummary(scoreTicket(golden(), review([verdicted({ id: "B1" }, {})])))).toContain("unmatched confirmed: none");
    expect(text).toContain("unmatched confirmed: B4 src/z.ts: third problem");
  });
});

describe("totalSummary", () => {
  it("totals several tickets", () => {
    const first = scoreTicket(golden(), review([verdicted({ id: "B1" }, {})]), runs);
    const second = scoreTicket({ ...golden([item({ id: "2-1" }), item({ id: "2-2", match: { files: ["src/a.ts"], all: [["nothing"]] } })]), ticket: "ENG-2" }, review([verdicted({ id: "B1" }, { verdict: "rejected" })]), runs);
    const text = totalSummary([first, second]);
    expect(text.split("\n")[0]).toBe("total");
    expect(text).toContain("found 2/3");
    expect(text).toContain("confirmed 1/3");
    expect(text).toContain("lost at confirm 1");
    expect(text).toContain("total $1.48");
  });
});
