import { describe, expect, it, vi } from "vitest";
import type { AgentReport, ConfirmRunResult, FixRunResult, ReviewRunResult, VerifyRunResult } from "../src/claude.js";
import { findAndConfirm, mergeFixReport, reviewAndFix, type ReviewDeps } from "../src/review.js";
import type { CandidateVerdict, ConfirmBatch, FixResolution, ReviewCandidate, ReviewFinding, ReviewLens, VerifyResult } from "../src/types.js";

const finding = (id: string, severity: ReviewFinding["severity"] = "major"): ReviewFinding => ({
  id, severity, file: "src/a.ts", issue: `Problem ${id}.`, suggestion: `Fix ${id}.`,
});

const reviewed = (...findings: ReviewFinding[]): ReviewRunResult => ({ success: true, rawOutput: "review out", findings });

const report = (over: Partial<AgentReport> = {}): AgentReport => ({
  status: "done", title: "", summary: "Fixed it.", filesCreated: [], filesModified: [], tests: [], verifyCommands: [], notes: "", followups: [], decisions: [], ...over,
});

const fixed = (fixes: FixResolution[], over: Partial<FixRunResult> = {}): FixRunResult =>
  ({ success: true, rawOutput: "fix out", report: report(), fixes, ...over });

const resolution = (id: string, status: FixResolution["status"] = "fixed"): FixResolution => ({ id, status, how: `how ${id}` });

const SOURCE: Record<string, string> = {
  "src/a.ts": ["export function a(input: string[]) {", "  if (!input.length) return [];", "  return input.map(String);", "}"].join("\n"),
};

const TICKET_TEXT = "Rows must never be dropped silently.\nExport the report as CSV.";

const holds = { evidence: "src/a.ts:2", code: "if (!input.length) return [];" };
const refutes = { ...holds, happens: false };

const judged = (batch: ConfirmBatch, verdict: CandidateVerdict["verdict"] = "confirmed"): ConfirmRunResult => ({
  success: true, rawOutput: "confirm out", verdicts: batch.candidates.map(c => ({ id: c.id, verdict, note: `note ${c.id}`, ...(verdict === "rejected" ? refutes : {}) })),
});

const harness = (overrides: Partial<ReviewDeps> = {}) => {
  const calls = { find: [] as ReviewLens[], confirm: [] as ReviewCandidate[][], batches: [] as ConfirmBatch[], dedupe: [] as ReviewCandidate[][], fix: [] as ReviewFinding[][], saved: [] as string[], logged: [] as string[] };
  const deps: ReviewDeps = {
    hasChanges: () => true,
    snapshot: () => "same",
    gateOpen: () => true,
    lenses: ["bugs"],
    find: async lens => { calls.find.push(lens); return reviewed(); },
    fix: async findings => { calls.fix.push(findings); return fixed(findings.map(f => resolution(f.id))); },
    saveOutput: (stage, raw) => calls.saved.push(`${stage}:${raw}`),
    log: m => calls.logged.push(m),
    confirm: async batch => judged(batch),
    source: file => SOURCE[file],
    ticketText: TICKET_TEXT,
    ...overrides,
  };
  const confirm = deps.confirm;
  deps.confirm = async batch => { calls.confirm.push(batch.candidates); calls.batches.push(batch); return confirm(batch); };
  const dedupe = deps.dedupe;
  if (dedupe) deps.dedupe = async candidates => { calls.dedupe.push(candidates); return dedupe(candidates); };
  return { calls, run: (publishable = true) => reviewAndFix(publishable, deps) };
};

describe("reviewAndFix", () => {
  it("skips quietly when the implementation is not publishable", async () => {
    const { calls, run } = harness();
    const outcome = await run(false);
    expect(calls.find).toHaveLength(0);
    expect(outcome.review).toMatchObject({ outcome: "skipped" });
    expect(outcome.needsReview).toBe(false);
  });

  it("skips quietly when there are no changes against base", async () => {
    const { calls, run } = harness({ hasChanges: () => false });
    const outcome = await run();
    expect(calls.find).toHaveLength(0);
    expect(outcome.review.outcome).toBe("skipped");
    expect(outcome.review.reason).toMatch(/no changes/i);
    expect(outcome.needsReview).toBe(false);
  });

  it("skips and flags needs_review when the budget gate is closed", async () => {
    const { calls, run } = harness({ gateOpen: () => false });
    const outcome = await run();
    expect(calls.find).toHaveLength(0);
    expect(outcome.review).toMatchObject({ outcome: "skipped", reason: expect.stringMatching(/budget/i) });
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
  });

  it("does not run the fix when there are no findings", async () => {
    const { calls, run } = harness();
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review).toMatchObject({ outcome: "reviewed", findings: [], resolutions: [], risks: [] });
    expect(outcome).toMatchObject({ needsReview: false, publish: true });
  });

  it("runs the fix with the findings and records the resolutions", async () => {
    const findings = [finding("R1", "blocker"), finding("R2", "minor")];
    const { calls, run } = harness({ find: async () => reviewed(...findings) });
    const outcome = await run();
    expect(calls.fix).toEqual([findings.map(f => ({ ...f, from: `B${f.id.slice(1)}` }))]);
    expect(outcome.review.findings).toEqual(calls.fix[0]);
    expect(outcome.review.resolutions.map(r => r.status)).toEqual(["fixed", "fixed"]);
    expect(outcome).toMatchObject({ needsReview: false, publish: true });
    expect(outcome.fixReport).toBeDefined();
  });

  it("saves the raw review and fix output", async () => {
    const { calls, run } = harness({ find: async () => reviewed(finding("R1")) });
    await run();
    expect(calls.saved).toEqual(["review-bugs:review out", "review-confirm-1:confirm out", "fix:fix out"]);
  });

  it("gives needs_review for an unfixed major but still publishes", async () => {
    const { run } = harness({
      find: async () => reviewed(finding("R1", "major")),
      fix: async () => fixed([resolution("R1", "not_fixed")]),
    });
    expect(await run()).toMatchObject({ needsReview: true, publish: true });
  });

  it("does not publish an unfixed blocker", async () => {
    const { run } = harness({
      find: async () => reviewed(finding("R1", "blocker")),
      fix: async () => fixed([resolution("R1", "not_fixed")]),
    });
    expect(await run()).toMatchObject({ needsReview: true, publish: false });
  });

  it("ignores an unfixed minor", async () => {
    const { run } = harness({
      find: async () => reviewed(finding("R1", "minor")),
      fix: async () => fixed([resolution("R1", "not_fixed")]),
    });
    expect(await run()).toMatchObject({ needsReview: false, publish: true });
  });

  it("treats a finding missing from the fix output as not fixed", async () => {
    const { run } = harness({
      find: async () => reviewed(finding("R1", "major"), finding("R2", "minor")),
      fix: async () => fixed([resolution("R2")]),
    });
    const outcome = await run();
    expect(outcome.review.resolutions).toEqual([
      { id: "R1", status: "not_fixed", how: expect.stringMatching(/not reported/i) },
      resolution("R2"),
    ]);
    expect(outcome.needsReview).toBe(true);
  });

  it("treats a fix run without a FIXES block as all not fixed", async () => {
    const { run } = harness({
      find: async () => reviewed(finding("R1", "major")),
      fix: async () => fixed([], { fixes: undefined, fixesError: "No ---FIXES--- block" }),
    });
    const outcome = await run();
    expect(outcome.review.resolutions[0].status).toBe("not_fixed");
    expect(outcome.needsReview).toBe(true);
  });

  it("keeps the implementer's work but holds back on a crashed fix with a blocker", async () => {
    const { run } = harness({
      find: async () => reviewed(finding("R1", "blocker")),
      fix: async () => ({ success: false, rawOutput: "", failure: "claude exited with status 1" }),
    });
    const outcome = await run();
    expect(outcome).toMatchObject({ needsReview: true, publish: false });
    expect(outcome.notes.join(" ")).toContain("claude exited with status 1");
    expect(outcome.review.resolutions.every(r => r.status === "not_fixed")).toBe(true);
  });

  it("publishes after a crashed fix when no blocker was found", async () => {
    const { run } = harness({
      find: async () => reviewed(finding("R1", "major")),
      fix: async () => ({ success: false, rawOutput: "", failure: "boom" }),
    });
    expect(await run()).toMatchObject({ needsReview: true, publish: true });
  });

  it("skips the fix and flags needs_review when the gate closes after the review", async () => {
    let open = true;
    const { calls, run } = harness({
      gateOpen: () => open,
      find: async () => { open = false; return reviewed(finding("R1", "major")); },
    });
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review.findings).toHaveLength(1);
    expect(outcome.review.resolutions).toEqual([]);
    expect(outcome.notes.join(" ")).toMatch(/budget/i);
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
  });

  it("flags a review that modified the worktree and refuses to publish", async () => {
    let snap = "before";
    const { calls, run } = harness({
      snapshot: () => snap,
      find: async () => { snap = "after"; return reviewed(finding("R1")); },
    });
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/modified/i) });
    expect(outcome).toMatchObject({ needsReview: true, publish: false });
    expect(calls.logged.join("\n")).toMatch(/modified/i);
  });

  it("continues to publish when the review output cannot be parsed", async () => {
    const { calls, run } = harness({
      find: async () => ({ success: true, rawOutput: "waffle", parseError: "No ---REVIEW--- block found in agent output" }),
    });
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review).toMatchObject({ outcome: "failed", reason: expect.stringContaining("---REVIEW---") });
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
  });

  it("continues to publish when the review run crashes", async () => {
    const { run } = harness({
      find: async () => ({ success: false, rawOutput: "", failure: "claude stopped: timed out" }),
    });
    const outcome = await run();
    expect(outcome.review).toMatchObject({ outcome: "failed", reason: "claude stopped: timed out" });
    expect(outcome.publish).toBe(true);
  });

  it("takes needs_review from a fix run that reports it", async () => {
    const { run } = harness({
      find: async () => reviewed(finding("R1", "minor")),
      fix: async () => fixed([resolution("R1")], { report: report({ status: "needs_review" }) }),
    });
    expect(await run()).toMatchObject({ needsReview: true });
  });
});

const byLens = (results: Partial<Record<ReviewLens, ReviewRunResult>>): ReviewDeps["find"] =>
  async lens => results[lens] ?? reviewed();

const verdictsFor = (verdicts: Record<string, Partial<CandidateVerdict>>): ReviewDeps["confirm"] => async batch => ({
  success: true, rawOutput: "confirm out",
  verdicts: batch.candidates.map(c => ({ id: c.id, verdict: "confirmed", note: `note ${c.id}`, ...verdicts[c.id] })),
});

const risk = (text: string, data = false) => ({ file: "src/r.ts", risk: text, data });

describe("reviewAndFix lenses", () => {
  it("runs each lens in the order given and saves its output as review-<lens>", async () => {
    const { calls, run } = harness({
      lenses: ["bugs", "spec", "reuse"],
      find: async lens => ({ success: true, rawOutput: `${lens} out`, findings: [] }),
    });
    await run();
    expect(calls.saved).toEqual(["review-bugs:bugs out", "review-spec:spec out", "review-reuse:reuse out"]);
  });

  it("runs the bugs lens twice, saving the second pass as review-bugs-2 and logging the pass", async () => {
    const { calls, run } = harness({
      lenses: ["bugs", "bugs", "spec", "reuse"],
      find: async lens => ({ success: true, rawOutput: `${lens} out`, findings: [] }),
    });
    const outcome = await run();
    expect(calls.saved).toEqual(["review-bugs:bugs out", "review-bugs-2:bugs out", "review-spec:spec out", "review-reuse:reuse out"]);
    expect(calls.logged).toContain("  Reviewing change (bugs)");
    expect(calls.logged).toContain("  Reviewing change (bugs, pass 2)");
    expect(outcome.review.lenses).toEqual([
      { lens: "bugs", outcome: "reviewed", candidates: 0 },
      { lens: "bugs", pass: 2, outcome: "reviewed", candidates: 0 },
      { lens: "spec", outcome: "reviewed", candidates: 0 },
      { lens: "reuse", outcome: "reviewed", candidates: 0 },
    ]);
  });

  it("numbers bugs candidates continuously across both passes", async () => {
    let pass = 0;
    const { calls, run } = harness({
      lenses: ["bugs", "bugs"],
      find: async () => reviewed(finding(`R${++pass}`, "minor"), finding(`R${++pass}`, "minor")),
    });
    await run();
    expect(calls.confirm[0].map(c => c.id)).toEqual(["B1", "B2", "B3", "B4"]);
  });

  it("still confirms the other bugs pass's candidates when one pass fails, with a note", async () => {
    let pass = 0;
    const { calls, run } = harness({
      lenses: ["bugs", "bugs"],
      find: async () => ++pass === 1 ? reviewed(finding("R1", "minor")) : { success: false, rawOutput: "", failure: "timed out" },
    });
    const outcome = await run();
    expect(calls.confirm[0].map(c => c.id)).toEqual(["B1"]);
    expect(outcome.review.lenses?.[1]).toEqual({ lens: "bugs", pass: 2, outcome: "failed", reason: "timed out", candidates: 0 });
    expect(outcome.notes.join(" ")).toContain("Review lens bugs (pass 2) failed: timed out");
    expect(outcome.needsReview).toBe(true);
  });

  it("fails the stage only when every pass failed", async () => {
    const { run } = harness({
      lenses: ["bugs", "bugs"],
      find: async () => ({ success: false, rawOutput: "", failure: "timed out" }),
    });
    const outcome = await run();
    expect(outcome.review.outcome).toBe("failed");
    expect(outcome.needsReview).toBe(true);
  });

  it("skips a lens when the gate closes before it, still confirms the earlier candidates and flags needs_review", async () => {
    let gateChecks = 0;
    const { calls, run } = harness({
      lenses: ["bugs", "spec"],
      gateOpen: () => ++gateChecks !== 3,
      find: byLens({ bugs: reviewed(finding("R1", "minor")) }),
    });
    const outcome = await run();
    expect(calls.confirm[0].map(c => c.id)).toEqual(["B1"]);
    expect(outcome.review.lenses).toEqual([
      { lens: "bugs", outcome: "reviewed", candidates: 1 },
      { lens: "spec", outcome: "skipped", reason: "budget cap reached", candidates: 0 },
    ]);
    expect(outcome.notes).toContain("Review lens spec skipped: budget cap reached.");
    expect(outcome.needsReview).toBe(true);
  });

  it("records a failed lens and carries on with the others", async () => {
    const { calls, run } = harness({
      lenses: ["bugs", "spec"],
      find: byLens({ bugs: { success: false, rawOutput: "", failure: "claude stopped: timed out" }, spec: reviewed(finding("R1", "minor")) }),
    });
    const outcome = await run();
    expect(calls.confirm[0].map(c => c.id)).toEqual(["S1"]);
    expect(outcome.review.lenses?.[0]).toEqual({ lens: "bugs", outcome: "failed", reason: "claude stopped: timed out", candidates: 0 });
    expect(outcome.notes.join(" ")).toContain("Review lens bugs failed: claude stopped: timed out");
    expect(outcome.needsReview).toBe(true);
  });

  it("records a lens whose block does not parse as failed", async () => {
    const { run } = harness({
      lenses: ["bugs", "spec"],
      find: byLens({ bugs: { success: true, rawOutput: "waffle", parseError: "No ---REVIEW--- block found in agent output" } }),
    });
    const outcome = await run();
    expect(outcome.review.lenses?.[0]).toMatchObject({ lens: "bugs", outcome: "failed", reason: expect.stringContaining("---REVIEW---") });
    expect(outcome.needsReview).toBe(true);
  });

  it("fails the review but still publishes when every lens fails", async () => {
    const { run } = harness({
      lenses: ["bugs", "spec"],
      find: async () => ({ success: false, rawOutput: "", failure: "crashed" }),
    });
    const outcome = await run();
    expect(outcome.review).toMatchObject({ outcome: "failed", reason: expect.stringContaining("crashed") });
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
  });

  it("stops without publishing when a lens changes the worktree, running no later lens or confirm", async () => {
    let snap = "before";
    const { calls, run } = harness({
      lenses: ["bugs", "spec"],
      snapshot: () => snap,
      find: async lens => { calls.find.push(lens); snap = "after"; return reviewed(finding("R1")); },
    });
    const outcome = await run();
    expect(calls.find).toEqual(["bugs"]);
    expect(calls.confirm).toHaveLength(0);
    expect(outcome.review).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/modified/i) });
    expect(outcome).toMatchObject({ needsReview: true, publish: false });
  });
});

describe("reviewAndFix confirmation", () => {
  it("does not run confirm when no lens found anything", async () => {
    const { calls, run } = harness();
    const outcome = await run();
    expect(calls.confirm).toHaveLength(0);
    expect(outcome.review.confirmation).toBeUndefined();
    expect(outcome).toMatchObject({ needsReview: false, publish: true });
  });

  it("goes straight to the fix with only check regressions and no candidates", async () => {
    const regression: ReviewFinding = { id: "C1", severity: "blocker", file: ".", issue: "npm test fails after the change", suggestion: "Fix it." };
    const { calls, run } = harness({ regressions: [regression] });
    await run();
    expect(calls.confirm).toHaveLength(0);
    expect(calls.fix).toEqual([[regression]]);
  });

  it("sends confirm every finding and risk from every lens with lens-prefixed ids", async () => {
    const { calls, run } = harness({
      lenses: ["bugs", "spec", "reuse"],
      find: byLens({
        bugs: { ...reviewed(finding("R1"), finding("R2")), risks: [risk("maybe")] },
        spec: reviewed(finding("R1")),
        reuse: { ...reviewed(), risks: [risk("dup helper")] },
      }),
    });
    await run();
    expect(calls.confirm.flat().map(c => `${c.id}:${c.lens}:${c.kind}`)).toEqual([
      "B1:bugs:finding", "B2:bugs:finding", "S1:spec:finding", "B3:bugs:risk", "U1:reuse:risk",
    ]);
  });

  it("carries the finder's confidence, decision and data flag onto the candidate", async () => {
    const found = { ...finding("R1"), confidence: "suspected" as const, decision: "D1" };
    const { calls, run } = harness({ find: async () => ({ ...reviewed(), findings: [found], risks: [risk("x", true)] }) });
    await run();
    expect(calls.confirm[0][0]).toMatchObject({ confidence: "suspected", decision: "D1", data: false });
    expect(calls.confirm[0][1]).toMatchObject({ kind: "risk", data: true, file: "src/r.ts", issue: "x" });
  });

  it("fixes only confirmed candidates, renumbered R1.. after the C regressions, keeping from", async () => {
    const regression: ReviewFinding = { id: "C1", severity: "blocker", file: ".", issue: "npm test fails after the change", suggestion: "Fix it." };
    const { calls, run } = harness({
      regressions: [regression],
      lenses: ["bugs", "spec"],
      find: byLens({ bugs: reviewed(finding("R1"), finding("R2")), spec: reviewed(finding("R1")) }),
      confirm: verdictsFor({ B2: { verdict: "rejected", ...refutes } }),
    });
    const outcome = await run();
    expect(calls.fix[0].map(f => `${f.id}:${f.from}`)).toEqual(["C1:undefined", "R1:B1", "R2:S1"]);
    expect(outcome.review.findings.map(f => f.id)).toEqual(["C1", "R1", "R2"]);
  });

  it("does not send check regressions to confirm", async () => {
    const regression: ReviewFinding = { id: "C1", severity: "blocker", file: ".", issue: "npm test fails after the change", suggestion: "Fix it." };
    const { calls, run } = harness({ regressions: [regression], find: byLens({ bugs: reviewed(finding("R1")) }) });
    await run();
    expect(calls.confirm[0].map(c => c.id)).toEqual(["B1"]);
  });

  it("takes the severity from confirm when it gives one", async () => {
    const { calls, run } = harness({
      find: byLens({ bugs: reviewed(finding("R1", "minor")) }),
      confirm: verdictsFor({ B1: { severity: "blocker" } }),
    });
    await run();
    expect(calls.fix[0][0].severity).toBe("blocker");
  });

  it("promotes a confirmed risk to a finding", async () => {
    const { calls, run } = harness({
      find: async () => ({ ...reviewed(), risks: [risk("null recorded as success")] }),
      confirm: verdictsFor({ B1: { severity: "major" } }),
    });
    const outcome = await run();
    expect(calls.fix[0]).toMatchObject([{ id: "R1", from: "B1", severity: "major", file: "src/r.ts", issue: "null recorded as success" }]);
    expect(outcome.review.risks).toEqual([]);
  });

  it("drops duplicates and rejected candidates but records them with their verdicts", async () => {
    const { run } = harness({
      lenses: ["bugs", "spec"],
      find: byLens({ bugs: reviewed(finding("R1")), spec: reviewed(finding("R1"), finding("R2")) }),
      confirm: verdictsFor({ S1: { verdict: "duplicate", duplicateOf: "B1" }, S2: { verdict: "rejected", note: "guarded on line 4", ...refutes } }),
    });
    const outcome = await run();
    expect(outcome.review.findings.map(f => f.from)).toEqual(["B1"]);
    expect(outcome.review.risks).toEqual([]);
    expect(outcome.review.candidates?.map(c => `${c.id}:${c.verdict?.verdict}`)).toEqual(["B1:confirmed", "S1:duplicate", "S2:rejected"]);
    expect(outcome.review.candidates?.[1].verdict?.duplicateOf).toBe("B1");
    expect(outcome.review.confirmation).toMatchObject({ outcome: "confirmed" });
  });

  it("turns unproven candidates into risks", async () => {
    const { calls, run } = harness({
      find: byLens({ bugs: reviewed(finding("R1")) }),
      confirm: verdictsFor({ B1: { verdict: "unproven" } }),
    });
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review.risks).toEqual([{ file: "src/a.ts", risk: "Problem R1.", data: false }]);
  });

  it("treats a candidate confirm did not mention as unproven", async () => {
    const { run } = harness({
      find: byLens({ bugs: reviewed(finding("R1")) }),
      confirm: async () => ({ success: true, rawOutput: "confirm out", verdicts: [] }),
    });
    const outcome = await run();
    expect(outcome.review.risks).toHaveLength(1);
    expect(outcome.review.candidates?.[0].verdict).toMatchObject({ verdict: "unproven" });
  });

  it("takes the data flag for an unproven candidate from confirm", async () => {
    const { run } = harness({
      find: byLens({ bugs: reviewed(finding("R1")) }),
      confirm: verdictsFor({ B1: { verdict: "unproven", data: true } }),
    });
    expect((await run()).review.risks?.[0].data).toBe(true);
  });

  it("does not publish when confirm changes the worktree", async () => {
    let snap = "same";
    const { calls, run } = harness({
      snapshot: () => snap,
      find: byLens({ bugs: reviewed(finding("R1")) }),
      confirm: async batch => { snap = "changed"; return judged(batch); },
    });
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/modified/i) });
    expect(outcome).toMatchObject({ needsReview: true, publish: false });
  });

  it("sends the finding candidates to the fix unconfirmed and flags needs_review when confirm fails", async () => {
    const { calls, run } = harness({
      find: async () => ({ ...reviewed(finding("R1")), risks: [risk("maybe")] }),
      confirm: async () => ({ success: false, rawOutput: "", failure: "claude exited with status 1" }),
    });
    const outcome = await run();
    expect(calls.fix[0]).toMatchObject([{ id: "R1", from: "B1" }]);
    expect(outcome.review.risks).toEqual([risk("maybe")]);
    expect(outcome.review.confirmation).toMatchObject({ outcome: "failed", reason: "claude exited with status 1" });
    expect(outcome.notes).toContain("Confirm batch 1 of 1 failed: claude exited with status 1; 2 candidate(s) unconfirmed.");
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
  });

  it("treats an unparseable confirm block as a failed confirmation", async () => {
    const { calls, run } = harness({
      find: byLens({ bugs: reviewed(finding("R1")) }),
      confirm: async () => ({ success: true, rawOutput: "x", parseError: "No ---CONFIRM--- block found" }),
    });
    const outcome = await run();
    expect(calls.fix).toHaveLength(1);
    expect(outcome.review.confirmation).toMatchObject({ outcome: "failed", reason: "No ---CONFIRM--- block found" });
  });

  it("sends the candidates to the fix unconfirmed when the gate closes before confirm", async () => {
    let open = true;
    const { calls, run } = harness({
      gateOpen: () => open,
      find: async () => { open = false; return reviewed(finding("R1")); },
    });
    const outcome = await run();
    expect(calls.confirm).toHaveLength(0);
    expect(outcome.review.confirmation).toMatchObject({ outcome: "skipped", reason: "budget cap reached" });
    expect(outcome.review.findings).toMatchObject([{ id: "R1", from: "B1" }]);
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
  });

  const manyFindings = (count: number) => reviewed(...Array.from({ length: count }, (_, i) => finding(`R${i + 1}`)));
  const dedupeGroups = (groups: { keep: string; same: string[] }[]): ReviewDeps["dedupe"] => async () => ({ success: true, rawOutput: "dedupe out", groups });

  it("confirms in batches of at most four groups, saving each as review-confirm-<n>", async () => {
    const { calls, run } = harness({ find: async () => manyFindings(5), fix: async () => fixed([]) });
    const outcome = await run();
    expect(calls.batches.map(b => [b.n, b.candidates.map(c => c.id)])).toEqual([[1, ["B1", "B2", "B3", "B4"]], [2, ["B5"]]]);
    expect(calls.saved).toContain("review-confirm-1:confirm out");
    expect(calls.saved).toContain("review-confirm-2:confirm out");
    expect(calls.logged).toContain("  Confirming batch 2 of 2 (1 candidate(s))");
    expect(outcome.review.confirmation).toMatchObject({
      outcome: "confirmed",
      batches: [{ n: 1, ids: ["B1", "B2", "B3", "B4"], outcome: "confirmed" }, { n: 2, ids: ["B5"], outcome: "confirmed" }],
    });
    expect(outcome.review.findings).toHaveLength(5);
  });

  it("runs dedupe before the first batch and saves it as review-dedupe", async () => {
    const { calls, run } = harness({
      find: async () => manyFindings(5),
      dedupe: dedupeGroups([{ keep: "B1", same: ["B3"] }]),
      fix: async () => fixed([]),
    });
    const outcome = await run();
    expect(calls.dedupe[0].map(c => c.id)).toEqual(["B1", "B2", "B3", "B4", "B5"]);
    expect(calls.saved.indexOf("review-dedupe:dedupe out")).toBeLessThan(calls.saved.indexOf("review-confirm-1:confirm out"));
    expect(calls.logged).toContain("  Grouping 5 candidate(s)");
    expect(outcome.review.confirmation).toMatchObject({ dedupe: { outcome: "grouped", merged: 1 } });
  });

  it("sends grouped members in their keeper's batch", async () => {
    const { calls, run } = harness({
      find: async () => manyFindings(6),
      dedupe: dedupeGroups([{ keep: "B1", same: ["B6"] }]),
      fix: async () => fixed([]),
    });
    await run();
    expect(calls.batches[0].candidates.map(c => c.id)).toEqual(["B1", "B6", "B2", "B3", "B4"]);
    expect(calls.batches[0].groupedWith).toEqual({ B6: "B1" });
    expect(calls.batches[1].candidates.map(c => c.id)).toEqual(["B5"]);
  });

  it("confirms without groups and without needs_review when dedupe fails", async () => {
    const { calls, run } = harness({
      find: async () => manyFindings(5),
      dedupe: async () => ({ success: false, rawOutput: "", failure: "claude exited with status 1" }),
      fix: async () => fixed([]),
    });
    const outcome = await run();
    expect(calls.batches[0].candidates.map(c => c.id)).toEqual(["B1", "B2", "B3", "B4"]);
    expect(calls.batches[0].groupedWith).toEqual({});
    expect(calls.logged).toContain("  Dedupe failed: claude exited with status 1");
    expect(outcome.review.confirmation).toMatchObject({ outcome: "confirmed", dedupe: { outcome: "failed", reason: "claude exited with status 1", merged: 0 } });
    expect(outcome.notes).toEqual([`Review found 5 issue(s); 0 fixed.`]);
    expect(outcome.needsReview).toBe(true);
  });

  it("does not run dedupe when every candidate fits in one batch", async () => {
    const { calls, run } = harness({ find: async () => manyFindings(4), dedupe: dedupeGroups([]) });
    const outcome = await run();
    expect(calls.dedupe).toHaveLength(0);
    expect(outcome.review.confirmation?.dedupe).toBeUndefined();
  });

  it("runs dedupe once the candidates no longer fit in one batch", async () => {
    const { calls, run } = harness({ find: async () => manyFindings(5), dedupe: dedupeGroups([]) });
    const outcome = await run();
    expect(calls.dedupe).toHaveLength(1);
    expect(outcome.review.confirmation?.dedupe).toMatchObject({ outcome: "grouped", merged: 0 });
  });

  it("stops without publishing when dedupe changes the worktree", async () => {
    let snap = "same";
    const { calls, run } = harness({
      snapshot: () => snap,
      find: async () => manyFindings(5),
      dedupe: async () => { snap = "changed"; return { success: true, rawOutput: "dedupe out", groups: [] }; },
    });
    const outcome = await run();
    expect(calls.batches).toHaveLength(0);
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review).toMatchObject({ outcome: "failed", reason: "the dedupe run modified the worktree" });
    expect(outcome).toMatchObject({ needsReview: true, publish: false });
  });

  it("stops without publishing when a batch changes the worktree, running no later batch", async () => {
    let snap = "same";
    const { calls, run } = harness({
      snapshot: () => snap,
      find: async () => manyFindings(5),
      confirm: async batch => { snap = "changed"; return judged(batch); },
    });
    const outcome = await run();
    expect(calls.batches).toHaveLength(1);
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review).toMatchObject({ outcome: "failed", reason: "confirm batch 1 modified the worktree" });
    expect(outcome).toMatchObject({ needsReview: true, publish: false });
  });

  it("uses the other batches' verdicts when one batch fails, sending its findings to the fix unconfirmed", async () => {
    const { calls, run } = harness({
      find: async () => manyFindings(5),
      confirm: async batch => batch.n === 1
        ? { success: false, rawOutput: "", failure: "claude exited with status 1" }
        : verdictsFor({ B5: { verdict: "unproven" } })(batch),
    });
    const outcome = await run();
    expect(calls.fix[0].map(f => f.from)).toEqual(["B1", "B2", "B3", "B4"]);
    expect(outcome.review.risks).toEqual([{ file: "src/a.ts", risk: "Problem R5.", data: false }]);
    expect(outcome.review.candidates?.map(c => c.verdict?.verdict)).toEqual([undefined, undefined, undefined, undefined, "unproven"]);
  });

  it("marks the confirmation partial and names the failed batch in the notes", async () => {
    const { run } = harness({
      find: async () => manyFindings(5),
      confirm: async batch => batch.n === 2 ? { success: true, rawOutput: "x", parseError: "No ---CONFIRM--- block found" } : judged(batch),
    });
    const outcome = await run();
    expect(outcome.review.confirmation).toMatchObject({
      outcome: "partial",
      batches: [{ n: 1, outcome: "confirmed" }, { n: 2, ids: ["B5"], outcome: "failed", reason: "No ---CONFIRM--- block found" }],
    });
    expect(outcome.notes).toContain("Confirm batch 2 of 2 failed: No ---CONFIRM--- block found; 1 candidate(s) unconfirmed.");
    expect(outcome.needsReview).toBe(true);
  });

  it("leaves the remaining candidates unconfirmed when the gate closes between batches", async () => {
    let open = true;
    const { calls, run } = harness({
      gateOpen: () => open,
      find: async () => manyFindings(6),
      confirm: async batch => { open = false; return judged(batch); },
    });
    const outcome = await run();
    expect(calls.batches).toHaveLength(1);
    expect(outcome.review.confirmation).toMatchObject({
      outcome: "partial",
      batches: [{ n: 1, outcome: "confirmed" }, { n: 2, ids: ["B5", "B6"], outcome: "skipped", reason: "budget cap reached" }],
    });
    expect(outcome.notes).toContain("Confirm stopped after batch 1 of 2: budget cap reached; 2 candidate(s) unconfirmed.");
    expect(outcome.needsReview).toBe(true);
  });
});

describe("reviewAndFix evidence", () => {
  const one = (verdict: Partial<CandidateVerdict>) =>
    harness({ find: byLens({ bugs: reviewed(finding("R1")) }), confirm: verdictsFor({ B1: verdict }) });

  it("keeps a rejection whose cited line holds", async () => {
    const { calls, run } = one({ verdict: "rejected", ...refutes });
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review.risks).toEqual([]);
    expect(outcome.review.candidates?.[0].verdict).toMatchObject({ verdict: "rejected", citation: "holds" });
  });

  it("turns a rejection without evidence into a risk, recording that it was rejected", async () => {
    const { run } = one({ verdict: "rejected", happens: false });
    const outcome = await run();
    expect(outcome.review.risks).toEqual([{ file: "src/a.ts", risk: "Problem R1.", data: false }]);
    expect(outcome.review.candidates?.[0].verdict).toMatchObject({ verdict: "unproven", citation: "missing", adjusted: { from: "rejected" } });
  });

  it("turns a rejection whose quoted code is not at the cited line into a risk", async () => {
    const { run } = one({ verdict: "rejected", happens: false, evidence: "src/a.ts:2", code: "return somethingElseEntirely();" });
    const outcome = await run();
    expect(outcome.review.risks).toHaveLength(1);
    expect(outcome.review.candidates?.[0].verdict).toMatchObject({ verdict: "unproven", citation: "mismatch", adjusted: { from: "rejected" } });
  });

  it("turns a rejection that admits the behaviour happens into a risk", async () => {
    const { calls, run } = one({ verdict: "rejected", happens: true, ...holds });
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review.risks).toEqual([{ file: "src/a.ts", risk: "Problem R1.", data: false }]);
    expect(outcome.review.candidates?.[0].verdict).toMatchObject({ verdict: "unproven", citation: "holds", adjusted: { from: "rejected" } });
  });

  it("turns a rejection that doesn't say whether the behaviour happens into a risk", async () => {
    const { run } = one({ verdict: "rejected", ...holds });
    const outcome = await run();
    expect(outcome.review.risks).toHaveLength(1);
    expect(outcome.review.candidates?.[0].verdict).toMatchObject({ verdict: "unproven", adjusted: { from: "rejected" } });
  });

  it("turns a rejection that admits the behaviour happens and quotes the ticket into a ticket conflict", async () => {
    const { calls, run } = one({ verdict: "rejected", happens: true, ticket: "Rows must never be dropped silently.", note: "the ticket asked for it", ...holds });
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review.risks).toEqual([]);
    expect(outcome.review.findings).toEqual([]);
    expect(outcome.review.conflicts).toMatchObject([{ from: "B1", quoted: true, consequence: "Problem R1." }]);
    expect(outcome.review.candidates?.[0].verdict).toMatchObject({ verdict: "ticket_conflict", adjusted: { from: "rejected" } });
  });

  it("keeps such a rejection as a risk when its ticket line isn't in the ticket", async () => {
    const { run } = one({ verdict: "rejected", happens: true, ticket: "Rows are retained forever.", ...holds });
    const outcome = await run();
    expect(outcome.review.conflicts ?? []).toEqual([]);
    expect(outcome.review.risks).toHaveLength(1);
    expect(outcome.review.candidates?.[0].verdict).toMatchObject({ verdict: "unproven", adjusted: { from: "rejected" } });
  });

  it("keeps a confirmed candidate whose cited line does not hold, without passing the line to the fix", async () => {
    const { calls, run } = one({ evidence: "src/a.ts:2", code: "return somethingElseEntirely();" });
    const outcome = await run();
    expect(calls.fix[0]).toMatchObject([{ id: "R1", from: "B1" }]);
    expect(calls.fix[0][0].evidence).toBeUndefined();
    expect(outcome.review.candidates?.[0].verdict).toMatchObject({ verdict: "confirmed", citation: "mismatch" });
  });

  it("passes a confirmed candidate's checked line to the fix", async () => {
    const { calls, run } = one(holds);
    await run();
    expect(calls.fix[0]).toMatchObject([{ id: "R1", evidence: "src/a.ts:2" }]);
  });

  it("turns a duplicate of a candidate that was not kept into a risk", async () => {
    const { run } = harness({
      lenses: ["bugs", "spec"],
      find: byLens({ bugs: reviewed(finding("R1")), spec: reviewed(finding("R1")) }),
      confirm: verdictsFor({ B1: { verdict: "rejected", ...refutes }, S1: { verdict: "duplicate", duplicateOf: "B1" } }),
    });
    const outcome = await run();
    expect(outcome.review.risks).toEqual([{ file: "src/a.ts", risk: "Problem R1.", data: false }]);
    expect(outcome.review.candidates?.[1].verdict).toMatchObject({ verdict: "unproven", adjusted: { from: "duplicate" } });
  });
});

describe("reviewAndFix ticket conflicts", () => {
  const conflict = { verdict: "ticket_conflict", ticket: "Rows must never be dropped silently.", note: "the guard drops rows", change: "return an error instead", ...holds } as const;
  const withConflict = (over: Partial<CandidateVerdict> = {}) =>
    harness({ find: byLens({ bugs: reviewed(finding("R1")) }), confirm: verdictsFor({ B1: { ...conflict, ...over } }) });

  it("records a ticket conflict under conflicts, never in the fix or the risks", async () => {
    const { calls, run } = withConflict();
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review.risks).toEqual([]);
    expect(outcome.review.findings).toEqual([]);
    expect(outcome.review.conflicts).toEqual([{
      from: "B1", file: "src/a.ts", ticket: "Rows must never be dropped silently.", quoted: true,
      consequence: "Problem R1.", change: "return an error instead", data: false, evidence: "src/a.ts:2",
    }]);
  });

  it("flags needs_review with the conflicting files in the notes", async () => {
    const { run } = withConflict();
    const outcome = await run();
    expect(outcome.needsReview).toBe(true);
    expect(outcome.notes).toContain("Ticket conflicts to decide: src/a.ts.");
  });

  it("records whether the conflict's ticket line is in the ticket text", async () => {
    const { run } = withConflict({ ticket: "Rows are retained forever." });
    expect((await run()).review.conflicts?.[0].quoted).toBe(false);
  });

  it("records no change when the conflict suggests none", async () => {
    const { run } = withConflict({ change: undefined });
    expect((await run()).review.conflicts?.[0]).not.toHaveProperty("change");
  });
});

describe("reviewAndFix data risks", () => {
  it("flags needs_review but still publishes for an unproven risk to recorded data", async () => {
    const { run } = harness({
      find: async () => ({ ...reviewed(), risks: [risk("records null", true)] }),
      confirm: verdictsFor({ B1: { verdict: "unproven" } }),
    });
    const outcome = await run();
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
    expect(outcome.notes).toContain("Unconfirmed risk to recorded data: src/r.ts");
  });

  it("does not flag a risk that is not about data", async () => {
    const { run } = harness({
      find: async () => ({ ...reviewed(), risks: [risk("style")] }),
      confirm: verdictsFor({ B1: { verdict: "unproven" } }),
    });
    expect((await run()).needsReview).toBe(false);
  });
});

describe("reviewAndFix decisions", () => {
  const decisions = [{ file: "src/a.ts", decision: "null when no row" }, { file: "src/b.ts", decision: "reject the export on invalid CSV" }];
  const rule = (...rulings: { id: string; ruling: "accept" | "finding" | "risk"; reason: string }[]) => ({ ...reviewed(), rulings });

  it("records accepted decisions without raising anything", async () => {
    const { calls, run } = harness({
      decisions,
      find: async () => rule({ id: "D1", ruling: "accept", reason: "null is handled" }, { id: "D2", ruling: "accept", reason: "logged" }),
    });
    const outcome = await run();
    expect(calls.confirm).toHaveLength(0);
    expect(outcome.review.decisions).toEqual([
      { id: "D1", decision: "null when no row", file: "src/a.ts", ruling: "accept", reason: "null is handled" },
      { id: "D2", decision: "reject the export on invalid CSV", file: "src/b.ts", ruling: "accept", reason: "logged" },
    ]);
    expect(outcome).toMatchObject({ needsReview: false, publish: true });
  });

  it("turns a decision ruled risk into a risk that confirm can still promote", async () => {
    const { calls, run } = harness({
      decisions: [decisions[0]],
      find: async () => rule({ id: "D1", ruling: "risk", reason: "a missing row records null" }),
      confirm: verdictsFor({ B1: {} }),
    });
    const outcome = await run();
    expect(calls.confirm[0]).toMatchObject([{ id: "B1", kind: "risk", file: "src/a.ts", issue: "a missing row records null" }]);
    expect(calls.fix[0]).toMatchObject([{ id: "R1", from: "B1", issue: "a missing row records null" }]);
    expect(outcome.review.decisions?.[0]).toMatchObject({ id: "D1", ruling: "risk" });
  });

  it("carries a decision ruled finding through to the fixed finding", async () => {
    const { calls, run } = harness({
      decisions: [decisions[0]],
      find: async () => ({ ...rule({ id: "D1", ruling: "finding", reason: "bad" }), findings: [{ ...finding("R1"), decision: "D1" }] }),
    });
    const outcome = await run();
    expect(calls.confirm[0]).toHaveLength(1);
    expect(calls.fix[0]).toMatchObject([{ id: "R1", from: "B1" }]);
    expect(outcome.review.decisions?.[0]).toMatchObject({ id: "D1", ruling: "finding" });
  });

  it("records a decision ruled finding with no matching candidate as a risk", async () => {
    const { calls, run } = harness({
      decisions: [decisions[0]],
      find: async () => rule({ id: "D1", ruling: "finding", reason: "bad but unfiled" }),
      confirm: verdictsFor({ B1: { verdict: "unproven" } }),
    });
    const outcome = await run();
    expect(calls.confirm[0]).toMatchObject([{ kind: "risk", issue: "bad but unfiled" }]);
    expect(outcome.review.decisions?.[0]).toMatchObject({ id: "D1", ruling: "risk", reason: "bad but unfiled" });
  });

  it("turns an unruled decision into a risk with a note", async () => {
    const { calls, run } = harness({
      decisions: [decisions[0]],
      find: async () => rule(),
      confirm: verdictsFor({ B1: { verdict: "unproven" } }),
    });
    const outcome = await run();
    expect(calls.confirm[0]).toMatchObject([{ kind: "risk", file: "src/a.ts", issue: "null when no row" }]);
    expect(outcome.review.decisions?.[0]).toMatchObject({ id: "D1", ruling: "unruled" });
    expect(outcome.notes).toContain("Decision D1 not ruled on");
    expect(outcome.review.risks).toEqual([{ file: "src/a.ts", risk: "null when no row", data: false }]);
  });

  describe("across two bugs passes", () => {
    const twice = (first: ReviewRunResult, second: ReviewRunResult) => {
      let pass = 0;
      return harness({ decisions, lenses: ["bugs", "bugs"], find: async () => ++pass === 1 ? first : second });
    };

    it("keeps the strictest ruling per decision and that pass's reason", async () => {
      const { run } = twice(
        { ...rule({ id: "D1", ruling: "accept", reason: "fine" }, { id: "D2", ruling: "risk", reason: "iffy" }) },
        rule({ id: "D1", ruling: "risk", reason: "null leaks" }, { id: "D2", ruling: "accept", reason: "ok" }),
      );
      const outcome = await run();
      expect(outcome.review.decisions).toMatchObject([
        { id: "D1", ruling: "risk", reason: "null leaks" },
        { id: "D2", ruling: "risk", reason: "iffy" },
      ]);
    });

    it("counts a finding ruling as matched when the other pass filed the candidate", async () => {
      const { run } = twice(
        { ...rule({ id: "D1", ruling: "finding", reason: "bad" }) },
        { ...rule({ id: "D2", ruling: "accept", reason: "ok" }), findings: [{ ...finding("R1"), decision: "D1" }] },
      );
      const outcome = await run();
      expect(outcome.review.decisions?.[0]).toMatchObject({ id: "D1", ruling: "finding", reason: "bad" });
    });

    it("leaves a decision unruled only when no pass ruled on it", async () => {
      const { run } = twice({ ...rule({ id: "D1", ruling: "accept", reason: "fine" }) }, rule({ id: "D1", ruling: "accept", reason: "fine" }));
      const outcome = await run();
      expect(outcome.review.decisions?.map(d => d.ruling)).toEqual(["accept", "unruled"]);
    });

    it("merges notes-derived rulings that share an id across passes, keeping the strictest", async () => {
      const verdicts = ["accept", "risk"] as const;
      let pass = 0;
      const { run } = harness({
        lenses: ["bugs", "bugs"],
        find: async () => rule({ id: "N1", ruling: verdicts[pass++], reason: `pass ${pass}` }),
      });
      const outcome = await run();
      expect(outcome.review.decisions).toMatchObject([{ id: "N1", ruling: "risk", reason: "pass 2" }]);
    });
  });

  it("records rulings the lens took from the notes when no decisions were listed", async () => {
    const { run } = harness({ find: async () => rule({ id: "N1", ruling: "accept", reason: "fine" }) });
    const outcome = await run();
    expect(outcome.review.decisions).toMatchObject([{ id: "N1", ruling: "accept", reason: "fine" }]);
  });
});

describe("findAndConfirm", () => {
  it("returns the confirmed findings, risks and record without running the fix", async () => {
    const fix = vi.fn();
    const found = await findAndConfirm({
      hasChanges: () => true, snapshot: () => "same", gateOpen: () => true, lenses: ["bugs"],
      find: async () => ({ ...reviewed(finding("R1")), risks: [risk("maybe")] }),
      confirm: verdictsFor({ B1: {}, B2: { verdict: "unproven" } }),
      source: file => SOURCE[file], ticketText: TICKET_TEXT,
      fix, saveOutput: () => {}, log: () => {},
    });
    expect(fix).not.toHaveBeenCalled();
    expect(found.stopped).toBeUndefined();
    expect(found).toMatchObject({
      findings: [{ id: "R1", from: "B1" }], risks: [risk("maybe")],
      record: { lenses: [{ lens: "bugs", outcome: "reviewed" }], confirmation: { outcome: "confirmed" } },
    });
  });
});

describe("mergeFixReport", () => {
  const base = {
    title: "feat: export", summary: "Adds export.", filesCreated: ["a.ts"], filesModified: ["b.ts"],
    tests: [{ name: "t1", file: "a.test.ts", result: "fail" as const }], followups: [{ file: "x.ts", note: "old" }],
  };

  it("takes the refined title and summary when present", () => {
    expect(mergeFixReport(base, report({ title: "feat: stream export", summary: "Streams export." })))
      .toMatchObject({ title: "feat: stream export", summary: "Streams export." });
  });

  it("keeps the original title and summary when the fix report has none", () => {
    expect(mergeFixReport(base, report({ summary: "" }))).toMatchObject({ title: "feat: export", summary: "Adds export." });
  });

  it("unions followups, deduping by file and note", () => {
    const merged = mergeFixReport(base, report({ followups: [{ file: "x.ts", note: "old" }, { file: "x.ts", note: "new" }, { file: "y.ts", note: "old" }] }));
    expect(merged.followups).toEqual([{ file: "x.ts", note: "old" }, { file: "x.ts", note: "new" }, { file: "y.ts", note: "old" }]);
  });

  it("keeps the original decisions and adds new ones from the fix report, deduping by file and decision", () => {
    const original = { file: "x.ts", decision: "null when absent" };
    const merged = mergeFixReport({ ...base, decisions: [original] }, report({ decisions: [original, { file: "x.ts", decision: "retry once" }] }));
    expect(merged.decisions).toEqual([original, { file: "x.ts", decision: "retry once" }]);
  });

  it("unions files and lets the fix run's test results replace same-named ones", () => {
    const merged = mergeFixReport(base, report({
      filesCreated: ["a.ts", "c.ts"], filesModified: ["d.ts"],
      tests: [{ name: "t1", file: "a.test.ts", result: "pass" }, { name: "t2", file: "c.test.ts", result: "pass" }],
    }));
    expect(merged.filesCreated).toEqual(["a.ts", "c.ts"]);
    expect(merged.filesModified).toEqual(["b.ts", "d.ts"]);
    expect(merged.tests.map(t => `${t.name}:${t.result}`)).toEqual(["t1:pass", "t2:pass"]);
  });
});

describe("reviewAndFix with check regressions", () => {
  const regression: ReviewFinding = {
    id: "C1", severity: "blocker", file: ".", issue: "npm run lint fails after the change (passed before it): boom", suggestion: "Make npm run lint pass again.",
  };

  it("runs the fix with regressions first even when the reviewer reports nothing", async () => {
    const { calls, run } = harness({ regressions: [regression] });
    const outcome = await run();
    expect(calls.fix).toEqual([[regression]]);
    expect(outcome.review.findings).toEqual([regression]);
    expect(outcome).toMatchObject({ needsReview: false, publish: true });
  });

  it("puts regressions ahead of the reviewer's findings", async () => {
    const { calls, run } = harness({ regressions: [regression], find: async () => reviewed(finding("R1")) });
    await run();
    expect(calls.fix[0].map(f => f.id)).toEqual(["C1", "R1"]);
  });

  it("flags needs_review and names the command when a regression survives the fix", async () => {
    const { run } = harness({ regressions: [regression], recheck: async () => [regression] });
    const outcome = await run();
    expect(outcome.needsReview).toBe(true);
    expect(outcome.notes.join(" ")).toMatch(/still failing.*npm run lint/);
  });

  it("stays clean when the recheck finds nothing", async () => {
    const { run } = harness({ regressions: [regression], recheck: async () => [] });
    expect(await run()).toMatchObject({ needsReview: false });
  });

  it("does not recheck when there was nothing to fix", async () => {
    let rechecked = 0;
    const { run } = harness({ recheck: async () => { rechecked++; return []; } });
    await run();
    expect(rechecked).toBe(0);
  });

  it("still names regressions when the review itself fails", async () => {
    const { run } = harness({ regressions: [regression], find: async () => ({ success: false, rawOutput: "", failure: "crashed" }) });
    const outcome = await run();
    expect(outcome.needsReview).toBe(true);
    expect(outcome.notes.join(" ")).toContain("npm run lint");
  });
});

describe("reviewAndFix with risks", () => {
  const risks = [{ file: "a.ts", risk: "Confirm the default.", data: false }];
  const confirmRisksUnproven = async ({ candidates }: ConfirmBatch): Promise<ConfirmRunResult> => ({
    success: true, rawOutput: "confirm out",
    verdicts: candidates.map(c => ({ id: c.id, verdict: c.kind === "risk" ? "unproven" : "confirmed", note: "" })),
  });

  it("keeps risks on the review and never sends them to the fix", async () => {
    const { calls, run } = harness({ confirm: confirmRisksUnproven, find: async () => ({ ...reviewed(finding("R1")), risks }) });
    const outcome = await run();
    expect(outcome.review.risks).toEqual(risks);
    expect(JSON.stringify(calls.fix)).not.toContain("Confirm the default");
  });

  it("keeps risks when there are no findings, without running the fix", async () => {
    const { calls, run } = harness({ confirm: confirmRisksUnproven, find: async () => ({ ...reviewed(), risks }) });
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review.risks).toEqual(risks);
  });
});

describe("reviewAndFix verification", () => {
  const verdict = (id: string, status: VerifyResult["status"] = "resolved", note = `note ${id}`): VerifyResult => ({ id, status, note });
  const verified = (...results: VerifyResult[]): VerifyRunResult => ({ success: true, rawOutput: "verify out", results });
  const withVerify = (verify: ReviewDeps["verify"], over: Partial<ReviewDeps> = {}) => {
    const seen: { findings: ReviewFinding[]; resolutions: FixResolution[] }[] = [];
    const h = harness({
      find: async () => reviewed(finding("R1", "blocker"), finding("R2", "major"), finding("R3", "minor")),
      verify: async (findings, resolutions) => { seen.push({ findings, resolutions }); return verify!(findings, resolutions); },
      ...over,
    });
    return { ...h, seen };
  };

  it("verifies the claimed-fixed findings only and records the results", async () => {
    const { calls, seen, run } = withVerify(
      async () => verified(verdict("R1"), verdict("R3")),
      { fix: async findings => fixed(findings.map(f => resolution(f.id, f.id === "R2" ? "not_fixed" : "fixed"))) },
    );
    const outcome = await run();
    expect(seen[0].resolutions.filter(r => r.status === "fixed").map(r => r.id)).toEqual(["R1", "R3"]);
    expect(outcome.review.verification).toEqual({ outcome: "verified", results: [verdict("R1"), verdict("R3")] });
    expect(outcome.review.resolutions.map(r => r.status)).toEqual(["fixed", "not_fixed", "fixed"]);
    expect(calls.saved).toContain("verify:verify out");
  });

  it("turns an unresolved claim into not_fixed and blocks publishing on a blocker", async () => {
    const { run } = withVerify(async () => verified(verdict("R1", "unresolved", "still buffers"), verdict("R2"), verdict("R3")));
    const outcome = await run();
    expect(outcome.review.resolutions[0]).toEqual({ id: "R1", status: "not_fixed", how: "how R1; still open: still buffers" });
    expect(outcome).toMatchObject({ publish: false, needsReview: true });
  });

  it("flags needs_review but still publishes when an unresolved claim is a major", async () => {
    const { run } = withVerify(async () => verified(verdict("R1"), verdict("R2", "unresolved", "nope"), verdict("R3")));
    expect(await run()).toMatchObject({ publish: true, needsReview: true });
  });

  it("treats a claimed id missing from the verification as unresolved", async () => {
    const { run } = withVerify(async () => verified(verdict("R1"), verdict("R3")));
    const outcome = await run();
    expect(outcome.review.resolutions[1]).toMatchObject({ id: "R2", status: "not_fixed", how: "how R2; still open: not verified" });
    expect(outcome.review.verification?.results).toContainEqual(verdict("R2", "unresolved", "not verified"));
    expect(outcome.needsReview).toBe(true);
  });

  it("skips verification with a note when the gate closes, flagging a claimed blocker or major", async () => {
    let open = true;
    let verifyCalls = 0;
    const { run } = withVerify(async () => { verifyCalls++; return verified(); }, {
      gateOpen: () => open,
      fix: async findings => { open = false; return fixed(findings.map(f => resolution(f.id))); },
    });
    const outcome = await run();
    expect(verifyCalls).toBe(0);
    expect(outcome.review.verification).toEqual({ outcome: "skipped", reason: "budget cap reached", results: [] });
    expect(outcome.notes.join(" ")).toContain("Fixes unverified: budget cap reached.");
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
  });

  it("does not flag needs_review for a skipped verification of only minors", async () => {
    let open = true;
    const { run } = withVerify(async () => verified(), {
      find: async () => reviewed(finding("R3", "minor")),
      gateOpen: () => open,
      fix: async findings => { open = false; return fixed(findings.map(f => resolution(f.id))); },
    });
    expect((await run()).needsReview).toBe(false);
  });

  it("keeps the fixer's claims and flags needs_review when the verify run fails", async () => {
    const { run } = withVerify(async () => ({ success: false, rawOutput: "boom", failure: "claude exited with status 1" }));
    const outcome = await run();
    expect(outcome.review.verification).toMatchObject({ outcome: "failed", reason: "claude exited with status 1" });
    expect(outcome.review.resolutions.every(r => r.status === "fixed")).toBe(true);
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
    expect(outcome.notes.join(" ")).toMatch(/verification failed/i);
  });

  it("keeps the fixer's claims and flags needs_review when the verify output cannot be parsed", async () => {
    const { run } = withVerify(async () => ({ success: true, rawOutput: "x", parseError: "No ---VERIFY--- block found" }));
    const outcome = await run();
    expect(outcome.review.verification).toMatchObject({ outcome: "failed", reason: "No ---VERIFY--- block found" });
    expect(outcome.needsReview).toBe(true);
  });

  it("refuses to publish when the verify run modified the worktree", async () => {
    let snap = "same";
    const { run } = withVerify(async () => { snap = "changed"; return verified(verdict("R1"), verdict("R2"), verdict("R3")); }, { snapshot: () => snap });
    const outcome = await run();
    expect(outcome.review.verification).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/modified/i) });
    expect(outcome).toMatchObject({ publish: false, needsReview: true });
    expect(outcome.review.resolutions.every(r => r.status === "fixed")).toBe(true);
  });

  it("does not verify when nothing was claimed fixed", async () => {
    let verifyCalls = 0;
    const { run } = withVerify(async () => { verifyCalls++; return verified(); }, {
      fix: async findings => fixed(findings.map(f => resolution(f.id, "not_fixed"))),
    });
    const outcome = await run();
    expect(verifyCalls).toBe(0);
    expect(outcome.review.verification).toBeUndefined();
  });

  it("does not verify when the fix run crashed", async () => {
    let verifyCalls = 0;
    const { run } = withVerify(async () => { verifyCalls++; return verified(); }, { fix: async () => ({ success: false, rawOutput: "x", failure: "died" }) });
    await run();
    expect(verifyCalls).toBe(0);
  });
});
