import { describe, expect, it, vi } from "vitest";
import type { AgentReport, ConfirmRunResult, FixReviewRunResult, FixRunResult, ReviewRunResult } from "../src/claude.js";
import { findAndConfirm, mergeFixReport, reviewAndFix, type FixReviewDeps, type ReviewDeps } from "../src/review.js";
import type { CandidateVerdict, ConfirmBatch, Decision, FixResolution, ReviewCandidate, ReviewFinding, ReviewLens, VerifyResult } from "../src/types.js";

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
  const calls = {
    find: [] as ReviewLens[], confirm: [] as ReviewCandidate[][], batches: [] as ConfirmBatch[], dedupe: [] as ReviewCandidate[][], fix: [] as ReviewFinding[][],
    fixRounds: [] as number[], confirmStages: [] as (string | undefined)[], saved: [] as string[], logged: [] as string[],
  };
  const deps: ReviewDeps = {
    hasChanges: () => true,
    snapshot: () => "same",
    gateOpen: () => true,
    lenses: ["bugs"],
    find: async lens => { calls.find.push(lens); return reviewed(); },
    fix: async (findings, round) => { calls.fix.push(findings); calls.fixRounds.push(round); return fixed(findings.map(f => resolution(f.id))); },
    saveOutput: (stage, raw) => calls.saved.push(`${stage}:${raw}`),
    log: m => calls.logged.push(m),
    confirm: async batch => judged(batch),
    source: file => SOURCE[file],
    ticketText: TICKET_TEXT,
    ...overrides,
  };
  const confirm = deps.confirm;
  deps.confirm = async (batch, stage) => {
    calls.confirm.push(batch.candidates);
    calls.batches.push(batch);
    calls.confirmStages.push(stage);
    return confirm(batch, stage);
  };
  const dedupe = deps.dedupe;
  if (dedupe) deps.dedupe = async (candidates, stage) => { calls.dedupe.push(candidates); return dedupe(candidates, stage); };
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
    expect(outcome.fixReports).toHaveLength(1);
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

  it("records a skipped codex lens with its reason without marking the ticket for review", async () => {
    const { run } = harness({
      lenses: ["bugs", "codex"],
      find: async lens => lens === "codex" ? { success: false, rawOutput: "", skipReason: "Codex usage unavailable" } : reviewed(),
    });
    const outcome = await run();
    expect(outcome.review.lenses?.[1]).toEqual({ lens: "codex", outcome: "skipped", reason: "Codex usage unavailable", candidates: 0 });
    expect(outcome.needsReview).toBe(false);
  });

  it("records a failed codex lens without marking the ticket for review", async () => {
    const { run } = harness({
      lenses: ["bugs", "codex"],
      find: async lens => lens === "codex" ? { success: false, rawOutput: "", failure: "Codex usage limit reached" } : reviewed(),
    });
    const outcome = await run();
    expect(outcome.review.lenses?.[1]).toMatchObject({ lens: "codex", outcome: "failed", reason: "Codex usage limit reached" });
    expect(outcome.needsReview).toBe(false);
    expect(outcome.notes).toEqual([]);
  });

  it("prefixes codex candidates with X", async () => {
    const { calls, run } = harness({
      lenses: ["bugs", "codex"],
      find: async lens => lens === "codex" ? reviewed(finding("R1", "minor")) : reviewed(),
    });
    await run();
    expect(calls.confirm[0].map(c => c.id)).toEqual(["X1"]);
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

  const build: ReviewFinding = {
    id: "C2", severity: "blocker", file: ".", issue: "npm run build fails after the change (passed before it): boom", suggestion: "Make npm run build pass again.",
  };

  it("holds back a regression the second round claims fixed when its check still fails", async () => {
    const { run } = harness({ regressions: [regression], recheck: async () => [regression] });
    const outcome = await run();
    expect(outcome.review.resolutions.find(r => r.id === "C1")).toMatchObject({ status: "not_fixed", how: expect.stringContaining("; still failing after the last fix round") });
    expect(outcome).toMatchObject({ publish: false, needsReview: true });
  });

  it("holds back a new regression the second round introduces", async () => {
    let rechecks = 0;
    const { run } = harness({ regressions: [regression], recheck: async () => (++rechecks === 1 ? [regression] : [build]) });
    const outcome = await run();
    expect(outcome.review.findings.map(f => f.id)).toEqual(["C1", "C2"]);
    expect(outcome.review.resolutions.find(r => r.id === "C2")).toBeUndefined();
    expect(outcome).toMatchObject({ publish: false, needsReview: true });
  });

  it("holds back a regression the first round introduces when the second round is skipped for budget", async () => {
    let open = true;
    const { run } = harness({
      regressions: [regression],
      fix: async findings => { open = false; return fixed(findings.map(f => resolution(f.id))); },
      gateOpen: () => open,
      recheck: async () => [build],
    });
    const outcome = await run();
    expect(outcome.review.findings.map(f => f.id)).toEqual(["C1", "C2"]);
    expect(outcome.review.resolutions.find(r => r.id === "C2")).toMatchObject({ status: "not_fixed", how: "still failing after the last fix round" });
    expect(outcome).toMatchObject({ publish: false, needsReview: true });
  });

  it("holds back a check the first fix run breaks before crashing", async () => {
    const { run } = harness({
      regressions: [regression],
      fix: async () => fixed([], { success: false, failure: "claude stopped: timeout" }),
      recheck: async () => [build],
    });
    const outcome = await run();
    expect(outcome.review.findings.map(f => f.id)).toEqual(["C1", "C2"]);
    expect(outcome).toMatchObject({ publish: false, needsReview: true });
  });

  it("holds back a check the second fix run breaks before crashing", async () => {
    let fixes = 0;
    let rechecks = 0;
    const { run } = withFixReview(
      ({ round, resolutions }) => round === 1 ? fixReviewed({ results: claimsResolved(resolutions), findings: [{ id: "N1", severity: "major", confidence: "proven", file: "src/b.ts", issue: "Shared helper changed with no test.", suggestion: "Add a test." }] }) : fixReviewed({ results: claimsResolved(resolutions) }),
      {
        find: async () => reviewed(finding("R1", "blocker")),
        fix: async findings => ++fixes === 1 ? fixed(findings.map(f => resolution(f.id))) : fixed([], { success: false, failure: "claude stopped: timeout" }),
        recheck: async () => (++rechecks === 1 ? [] : [build]),
      },
    );
    const outcome = await run();
    expect(outcome.review.findings.some(f => f.id === "C1" && f.issue.startsWith("npm run build"))).toBe(true);
    expect(outcome).toMatchObject({ publish: false, needsReview: true });
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

const verdict = (id: string, status: VerifyResult["status"] = "resolved", note = `note ${id}`): VerifyResult => ({ id, status, note });

const fixReviewed = (over: Partial<FixReviewRunResult> = {}): FixReviewRunResult =>
  ({ success: true, rawOutput: "fix review out", results: [], findings: [], risks: [], ...over });

const claimsResolved = (resolutions: FixResolution[]): VerifyResult[] =>
  resolutions.filter(r => r.status === "fixed").map(r => verdict(r.id));

interface FixReviewCall {
  round: number;
  scope: { from: string; to: string; files: string };
  findings: ReviewFinding[];
  resolutions: FixResolution[];
  added: Decision[];
}

const withFixReview = (
  review: (call: FixReviewCall) => FixReviewRunResult | Promise<FixReviewRunResult> = ({ resolutions }) => fixReviewed({ results: claimsResolved(resolutions) }),
  over: Partial<ReviewDeps> = {},
  tree: () => string | undefined = () => undefined,
) => {
  const seen = { captures: 0, diffs: [] as [string, string][], runs: [] as FixReviewCall[] };
  const fixReview: FixReviewDeps = {
    capture: () => { const id = tree() ?? `tree${seen.captures}`; seen.captures++; return id; },
    diff: (from, to) => { seen.diffs.push([from, to]); return { files: "M\tsrc/a.ts\nA\tsrc/b.ts\n", patch: `patch ${from}..${to}` }; },
    run: async (round, scope, findings, resolutions, added) => {
      const call = { round, scope, findings, resolutions, added };
      seen.runs.push(call);
      return review(call);
    },
  };
  const h = harness({
    find: async () => reviewed(finding("R1", "blocker"), finding("R2", "major"), finding("R3", "minor")),
    fixReview,
    ...over,
  });
  return { ...h, seen };
};

describe("reviewAndFix fix review", () => {
  it("captures the worktree before and after the fix and reviews the diff between them", async () => {
    const { seen, run } = withFixReview();
    await run();
    expect(seen.captures).toBe(2);
    expect(seen.diffs).toEqual([["tree0", "tree1"]]);
    expect(seen.runs[0].scope).toEqual({ from: "tree0", to: "tree1", files: "M\tsrc/a.ts\nA\tsrc/b.ts\n" });
    expect(seen.runs[0].round).toBe(1);
  });

  it("saves the fixer's diff as fix-diff and the run as fix-review", async () => {
    const { calls, run } = withFixReview();
    await run();
    expect(calls.saved).toContain("fix-diff:patch tree0..tree1");
    expect(calls.saved).toContain("fix-review:fix review out");
    expect(calls.saved.indexOf("fix:fix out")).toBeLessThan(calls.saved.indexOf("fix-diff:patch tree0..tree1"));
  });

  it("checks the claimed-fixed findings and records the results", async () => {
    const { seen, run } = withFixReview(
      ({ resolutions }) => fixReviewed({ results: claimsResolved(resolutions) }),
      { fix: async findings => fixed(findings.map(f => resolution(f.id, f.id === "R2" ? "not_fixed" : "fixed"))) },
    );
    const outcome = await run();
    expect(seen.runs[0].findings.map(f => f.id)).toEqual(["R1", "R2", "R3"]);
    expect(seen.runs[0].resolutions.filter(r => r.status === "fixed").map(r => r.id)).toEqual(["R1", "R3"]);
    expect(outcome.review.verification).toEqual({ outcome: "verified", results: [verdict("R1"), verdict("R3")] });
    expect(outcome.review.resolutions.map(r => r.status)).toEqual(["fixed", "not_fixed", "fixed"]);
  });

  it("turns an unresolved claim into not_fixed and blocks publishing on a blocker", async () => {
    const { run } = withFixReview(() => fixReviewed({ results: [verdict("R1", "unresolved", "still buffers"), verdict("R2"), verdict("R3")] }));
    const outcome = await run();
    expect(outcome.review.resolutions[0]).toEqual({ id: "R1", status: "not_fixed", how: "how R1; still open: still buffers" });
    expect(outcome).toMatchObject({ publish: false, needsReview: true });
    expect(outcome.notes.join(" ")).toContain("Fix review: 1 claimed fix(es) still open (R1).");
  });

  it("flags needs_review but still publishes when an unresolved claim is a major", async () => {
    const { run } = withFixReview(() => fixReviewed({ results: [verdict("R1"), verdict("R2", "unresolved", "nope"), verdict("R3")] }));
    expect(await run()).toMatchObject({ publish: true, needsReview: true });
  });

  it("treats a claimed id missing from the results as unresolved", async () => {
    const { run } = withFixReview(() => fixReviewed({ results: [verdict("R1"), verdict("R3")] }));
    const outcome = await run();
    expect(outcome.review.resolutions[1]).toMatchObject({ id: "R2", status: "not_fixed", how: "how R2; still open: not verified" });
    expect(outcome.review.verification?.results).toContainEqual(verdict("R2", "unresolved", "not verified"));
    expect(outcome.needsReview).toBe(true);
  });

  it("skips the fix review with a note when the gate closes, flagging a claimed blocker or major", async () => {
    let open = true;
    const { seen, run } = withFixReview(undefined, {
      gateOpen: () => open,
      fix: async findings => { open = false; return fixed(findings.map(f => resolution(f.id))); },
    });
    const outcome = await run();
    expect(seen.runs).toHaveLength(0);
    expect(outcome.review.verification).toEqual({ outcome: "skipped", reason: "budget cap reached", results: [] });
    expect(outcome.notes.join(" ")).toContain("Fixer's changes unreviewed and fixes unverified: budget cap reached.");
    expect(outcome.review.fixReviews).toEqual([{ round: 1, outcome: "skipped", reason: "budget cap reached", files: 2, candidates: 0 }]);
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
  });

  it("does not flag needs_review for a skipped fix review of only minors", async () => {
    let open = true;
    const { run } = withFixReview(undefined, {
      find: async () => reviewed(finding("R3", "minor")),
      gateOpen: () => open,
      fix: async findings => { open = false; return fixed(findings.map(f => resolution(f.id))); },
    });
    expect((await run()).needsReview).toBe(false);
  });

  it("keeps the fixer's claims and flags needs_review when the fix review fails or its output cannot be parsed", async () => {
    const crashed = withFixReview(() => ({ success: false, rawOutput: "boom", failure: "claude exited with status 1" }));
    const outcome = await crashed.run();
    expect(outcome.review.verification).toMatchObject({ outcome: "failed", reason: "claude exited with status 1" });
    expect(outcome.review.resolutions.every(r => r.status === "fixed")).toBe(true);
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
    expect(outcome.notes.join(" ")).toContain("Fix review failed: claude exited with status 1");
    expect(outcome.review.fixReviews).toEqual([{ round: 1, outcome: "failed", reason: "claude exited with status 1", files: 2, candidates: 0 }]);

    const garbled = withFixReview(() => ({ success: true, rawOutput: "x", parseError: "No ---FIXREVIEW--- block found" }));
    const parsed = await garbled.run();
    expect(parsed.review.verification).toMatchObject({ outcome: "failed", reason: "No ---FIXREVIEW--- block found" });
    expect(parsed.needsReview).toBe(true);
  });

  it("refuses to publish when the fix review modified the worktree", async () => {
    let snap = "same";
    const { calls, run } = withFixReview(
      ({ resolutions }) => { snap = "changed"; return fixReviewed({ results: claimsResolved(resolutions) }); },
      { snapshot: () => snap },
    );
    const outcome = await run();
    expect(outcome.review.verification).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/modified/i) });
    expect(outcome).toMatchObject({ publish: false, needsReview: true });
    expect(outcome.review.resolutions.every(r => r.status === "fixed")).toBe(true);
    expect(outcome.notes.join(" ")).toContain("Fix review failed: the fix review run modified the worktree; work kept on local branch, not pushed.");
    expect(calls.fix).toHaveLength(1);
  });

  it("skips the fix review when the fixer changed nothing and claimed nothing", async () => {
    const { seen, run } = withFixReview(undefined, {
      fix: async findings => fixed(findings.map(f => resolution(f.id, "not_fixed"))),
    }, () => "same");
    const outcome = await run();
    expect(seen.runs).toHaveLength(0);
    expect(outcome.review.fixReviews).toEqual([{ round: 1, outcome: "skipped", reason: "the fixer changed nothing", files: 2, candidates: 0 }]);
    expect(outcome.review.verification).toBeUndefined();
  });

  it("still checks the claims when the fixer changed nothing", async () => {
    const { seen, run } = withFixReview(undefined, {}, () => "same");
    const outcome = await run();
    expect(seen.runs).toHaveLength(1);
    expect(seen.runs[0].scope).toMatchObject({ from: "same", to: "same" });
    expect(outcome.review.verification?.outcome).toBe("verified");
  });

  it("reviews the fixer's diff even when nothing was claimed fixed", async () => {
    const { seen, run } = withFixReview(() => fixReviewed(), {
      fix: async findings => fixed(findings.map(f => resolution(f.id, "not_fixed"))),
    });
    const outcome = await run();
    expect(seen.runs).toHaveLength(1);
    expect(outcome.review.verification).toBeUndefined();
    expect(outcome.review.fixReviews).toEqual([{ round: 1, outcome: "reviewed", files: 2, candidates: 0 }]);
  });

  it("does not review a crashed fix run but saves its diff", async () => {
    let fixes = 0;
    const { calls, seen, run } = withFixReview(undefined, { fix: async () => { fixes++; return { success: false, rawOutput: "x", failure: "died" }; } });
    const outcome = await run();
    expect(seen.runs).toHaveLength(0);
    expect(calls.saved).toContain("fix-diff:patch tree0..tree1");
    expect(outcome.review.fixReviews).toEqual([{ round: 1, outcome: "skipped", reason: "the fix run did not finish", files: 2, candidates: 0 }]);
    expect(fixes).toBe(1);
  });

  it("passes only the decisions the fixer added to the fix review", async () => {
    const known = { file: "src/a.ts", decision: "null when no row" };
    const added = { file: "src/b.ts", decision: "cap counts code points" };
    const { seen, run } = withFixReview(undefined, {
      decisions: [known],
      fix: async findings => fixed(findings.map(f => resolution(f.id)), { report: report({ decisions: [known, added] }) }),
    });
    await run();
    expect(seen.runs[0].added).toEqual([added]);
  });
});

describe("reviewAndFix fixer findings", () => {
  const fixerFinding = (issue = "Shared helper changed with no test.", severity: ReviewFinding["severity"] = "minor") =>
    ({ id: "N1", severity, confidence: "proven" as const, file: "src/b.ts", issue, suggestion: "Add a test." });

  const firstReviewFindsOne = (over: Partial<FixReviewRunResult> = {}) =>
    ({ round, resolutions }: FixReviewCall) => round === 1
      ? fixReviewed({ results: claimsResolved(resolutions), findings: [fixerFinding()], ...over })
      : fixReviewed({ results: claimsResolved(resolutions) });

  const oneBlocker = { find: async () => reviewed(finding("R1", "blocker")) };

  it("sends the fix review's findings and risks to confirm as F candidates, saving the run as fix-review-confirm-1", async () => {
    const { calls, run } = withFixReview(
      firstReviewFindsOne({ risks: [risk("maybe leaks")] }),
      { ...oneBlocker, confirm: async batch => batch.candidates[0].lens === "fixer" ? judged(batch, "unproven") : judged(batch) },
    );
    await run();
    expect(calls.confirm[1].map(c => `${c.id}:${c.lens}:${c.kind}`)).toEqual(["F1:fixer:finding", "F2:fixer:risk"]);
    expect(calls.confirmStages).toEqual(["review-confirm-1", "fix-review-confirm-1"]);
    expect(calls.saved).toContain("fix-review-confirm-1:confirm out");
  });

  it("logs the fix review's confirm batches as fix-review-confirm-<n> and round 2's as fix-review-2-confirm-<n>, leaving review-confirm-<n> alone", async () => {
    const { calls, run } = withFixReview(
      ({ round, resolutions }) => fixReviewed({ results: claimsResolved(resolutions), findings: [fixerFinding(`issue ${round}`)] }),
      oneBlocker,
    );
    await run();
    expect(calls.confirmStages).toEqual(["review-confirm-1", "fix-review-confirm-1", "fix-review-2-confirm-1"]);
    expect(calls.saved.filter(entry => entry.includes("confirm-"))).toEqual([
      "review-confirm-1:confirm out", "fix-review-confirm-1:confirm out", "fix-review-2-confirm-1:confirm out",
    ]);
  });

  it("sends a ticket conflict found in the fixer's changes to conflicts, not to the fixer", async () => {
    const conflict = { verdict: "ticket_conflict", ticket: "Rows must never be dropped silently.", note: "the guard drops rows", change: "return an error instead", ...holds } as const;
    const { calls, run } = withFixReview(firstReviewFindsOne(), { ...oneBlocker, confirm: verdictsFor({ F1: conflict }) });
    const outcome = await run();
    expect(outcome.review.conflicts).toEqual([{
      from: "F1", file: "src/b.ts", ticket: "Rows must never be dropped silently.", quoted: true,
      consequence: "Shared helper changed with no test.", change: "return an error instead", data: false, evidence: "src/a.ts:2",
    }]);
    expect(calls.fixRounds).toEqual([1]);
    expect(outcome.review.findings.map(f => f.id)).toEqual(["R1"]);
    expect(outcome.notes).toContain("Ticket conflicts to decide: src/b.ts.");
    expect(outcome.needsReview).toBe(true);
  });

  it("overturns a fixer candidate's rejection that admits the behaviour happens into a risk", async () => {
    const admits = { verdict: "rejected", happens: true, note: "the guard is deliberate", ...holds } as const;
    const { calls, run } = withFixReview(firstReviewFindsOne(), { ...oneBlocker, confirm: verdictsFor({ F1: admits }) });
    const outcome = await run();
    expect(outcome.review.candidates?.find(c => c.id === "F1")?.verdict).toMatchObject({ verdict: "unproven", adjusted: { from: "rejected" } });
    expect(outcome.review.risks).toEqual([{ file: "src/b.ts", risk: "Shared helper changed with no test.", data: false }]);
    expect(calls.fixRounds).toEqual([1]);
  });

  it("turns a fixer candidate's rejection that admits the behaviour and quotes the ticket into a ticket conflict", async () => {
    const admits = { verdict: "rejected", happens: true, ticket: "Rows must never be dropped silently.", note: "the ticket asked for it", ...holds } as const;
    const { calls, run } = withFixReview(firstReviewFindsOne(), { ...oneBlocker, confirm: verdictsFor({ F1: admits }) });
    const outcome = await run();
    expect(outcome.review.candidates?.find(c => c.id === "F1")?.verdict).toMatchObject({ verdict: "ticket_conflict", adjusted: { from: "rejected" } });
    expect(outcome.review.conflicts?.map(c => c.from)).toEqual(["F1"]);
    expect(calls.fixRounds).toEqual([1]);
  });

  it("keeps the lens conflicts alongside the fix review's", async () => {
    const conflict = { verdict: "ticket_conflict", ticket: "Rows must never be dropped silently.", note: "n", change: "c", ...holds } as const;
    const { run } = withFixReview(firstReviewFindsOne(), {
      find: byLens({ bugs: reviewed(finding("R1", "blocker"), finding("R2", "minor")) }),
      confirm: verdictsFor({ B2: conflict, F1: conflict }),
    });
    expect((await run()).review.conflicts?.map(c => c.from)).toEqual(["B2", "F1"]);
  });

  it("prefixes the confirm step's own notes with the fix review", async () => {
    const { run } = withFixReview(firstReviewFindsOne(), {
      ...oneBlocker,
      confirm: async batch => batch.candidates[0].lens === "fixer" ? { success: false, rawOutput: "", failure: "boom" } : judged(batch),
    });
    const outcome = await run();
    expect(outcome.notes).toContain("Fix review: Confirm batch 1 of 1 failed: boom; 1 candidate(s) unconfirmed.");
    expect(outcome.needsReview).toBe(true);
  });

  it("flags needs_review but still publishes for an unproven fixer risk to recorded data", async () => {
    const { run } = withFixReview(
      firstReviewFindsOne({ findings: [], risks: [risk("records null", true)] }),
      { ...oneBlocker, confirm: async batch => batch.candidates[0].lens === "fixer" ? judged(batch, "unproven") : judged(batch) },
    );
    const outcome = await run();
    expect(outcome.review.risks).toEqual([risk("records null", true)]);
    expect(outcome.notes).toContain("Unconfirmed risk to recorded data: src/r.ts");
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
  });

  it("numbers confirmed fixer findings after the existing findings, keeping from", async () => {
    const { calls, run } = withFixReview(firstReviewFindsOne(), { find: async () => reviewed(finding("R1"), finding("R2"), finding("R3")) });
    const outcome = await run();
    expect(outcome.review.findings.map(f => `${f.id}:${f.from}`)).toEqual(["R1:B1", "R2:B2", "R3:B3", "R4:F1"]);
    expect(calls.fix[1].map(f => f.id)).toEqual(["R4"]);
  });

  it("turns unproven fixer candidates into risks and records dropped ones with their verdicts", async () => {
    const { run } = withFixReview(
      firstReviewFindsOne({ findings: [fixerFinding("one"), fixerFinding("two"), fixerFinding("three")] }),
      {
        ...oneBlocker,
        confirm: async batch => batch.candidates[0].lens === "fixer"
          ? { success: true, rawOutput: "c", verdicts: [{ id: "F1", verdict: "unproven", note: "" }, { id: "F2", verdict: "rejected", note: "guarded", ...refutes }, { id: "F3", verdict: "duplicate", note: "", duplicateOf: "F1" }] }
          : judged(batch),
      },
    );
    const outcome = await run();
    expect(outcome.review.risks).toEqual([{ file: "src/b.ts", risk: "one", data: false }]);
    expect(outcome.review.candidates?.filter(c => c.lens === "fixer").map(c => `${c.id}:${c.verdict?.verdict}`)).toEqual(["F1:unproven", "F2:rejected", "F3:duplicate"]);
    expect(outcome.review.findings.map(f => f.id)).toEqual(["R1"]);
    expect(outcome.review.fixReviews).toEqual([{ round: 1, outcome: "reviewed", files: 2, candidates: 3, confirmation: { outcome: "confirmed", batches: [{ n: 1, ids: ["F1", "F2", "F3"], outcome: "confirmed" }] } }]);
  });

  it("runs a second round with the confirmed fixer findings, saved as fix-2, fix-diff-2, fix-review-2", async () => {
    const { calls, seen, run } = withFixReview(firstReviewFindsOne(), oneBlocker);
    await run();
    expect(calls.fixRounds).toEqual([1, 2]);
    expect(calls.saved).toEqual(expect.arrayContaining(["fix-2:fix out", "fix-diff-2:patch tree2..tree3", "fix-review-2:fix review out", "fix-review-confirm-1:confirm out"]));
    expect(seen.runs.map(r => r.round)).toEqual([1, 2]);
    expect(seen.runs[1].findings.map(f => f.id)).toEqual(["R2"]);
    expect(calls.logged).toContain("  Reviewing the fixer's changes, round 2");
  });

  it("runs round 2 for a single confirmed minor", async () => {
    const { calls, run } = withFixReview(firstReviewFindsOne(), { find: async () => reviewed(finding("R1", "minor")) });
    await run();
    expect(calls.fix[1].map(f => `${f.id}:${f.severity}`)).toEqual(["R2:minor"]);
  });

  it("runs no third round: round-2 findings stay open, needs_review on a major, no publish on a blocker", async () => {
    const stays = (severity: ReviewFinding["severity"]) => withFixReview(
      ({ round, resolutions }) => fixReviewed({ results: claimsResolved(resolutions), findings: [fixerFinding(`issue ${round}`, round === 1 ? "minor" : severity)] }),
      { find: async () => reviewed(finding("R1", "minor")) },
    );
    const minor = stays("minor");
    const minorOutcome = await minor.run();
    expect(minor.calls.fixRounds).toEqual([1, 2]);
    expect(minorOutcome.review.findings.map(f => f.id)).toEqual(["R1", "R2", "R3"]);
    expect(minorOutcome.review.resolutions.map(r => r.id)).toEqual(["R1", "R2"]);
    expect(minorOutcome).toMatchObject({ needsReview: false, publish: true });
    expect(minorOutcome.notes.join(" ")).toContain("Fix review (round 2) found 1 new issue(s); not fixed, no further rounds.");

    const major = await stays("major").run();
    expect(major).toMatchObject({ needsReview: true, publish: true });

    const blocker = await stays("blocker").run();
    expect(blocker).toMatchObject({ needsReview: true, publish: false });
  });

  it("re-sends unresolved claims and still-failing regressions in round 2 under their own ids, and the latest resolution wins", async () => {
    const regression: ReviewFinding = { id: "C1", severity: "blocker", file: ".", issue: "npm run lint fails after the change (passed before it): boom", suggestion: "Fix it." };
    let rechecks = 0;
    const { calls, seen, run } = withFixReview(
      ({ round, resolutions }) => round === 1
        ? fixReviewed({ results: [verdict("C1"), verdict("R1", "unresolved", "still buffers")] })
        : fixReviewed({ results: claimsResolved(resolutions) }),
      {
        regressions: [regression],
        find: async () => reviewed(finding("R1", "major")),
        recheck: async () => ++rechecks === 1 ? [{ ...regression, issue: "npm run lint fails after the change (passed before it): still" }] : [],
      },
    );
    const outcome = await run();
    expect(calls.fix.map(f => f.map(x => x.id))).toEqual([["C1", "R1"], ["R1", "C1"]]);
    expect(calls.fix[1][0].issue).toBe(`${finding("R1", "major").issue} Still open after the last fix: still buffers`);
    expect(outcome.review.findings.find(f => f.id === "R1")?.issue).toBe(finding("R1", "major").issue);
    expect(seen.runs[1].findings.map(f => f.id)).toEqual(["R1", "C1"]);
    expect(outcome.review.resolutions).toEqual([resolution("C1"), resolution("R1")]);
    expect(outcome.review.verification).toEqual({ outcome: "verified", results: [verdict("C1"), verdict("R1")] });
    expect(outcome).toMatchObject({ needsReview: false, publish: true });
  });

  it("leaves no still-open note for a claim reopened in round 1 and verified in round 2", async () => {
    const { run } = withFixReview(
      ({ round, resolutions }) => round === 1 ? fixReviewed({ results: [verdict("R1", "unresolved", "still buffers")] }) : fixReviewed({ results: claimsResolved(resolutions) }),
      { find: async () => reviewed(finding("R1", "minor")) },
    );
    const outcome = await run();
    expect(outcome.notes.filter(n => n.includes("still open"))).toEqual([]);
  });

  it("drops a round 1 unresolved result when round 2's fix review fails", async () => {
    const { run } = withFixReview(
      ({ round }) => round === 1 ? fixReviewed({ results: [verdict("R1", "unresolved", "still buffers")] }) : { success: false, rawOutput: "boom", failure: "claude exited with status 1" },
      { find: async () => reviewed(finding("R1", "blocker")) },
    );
    const outcome = await run();
    expect(outcome.review.resolutions).toEqual([resolution("R1")]);
    expect(outcome.review.verification?.results.map(r => r.id)).toEqual([]);
    expect(outcome.notes.filter(n => n.includes("still open"))).toEqual([]);
    expect(outcome.notes.join(" ")).toContain("Fix review failed: claude exited with status 1");
    expect(outcome.needsReview).toBe(true);
  });

  it("notes a claim still unresolved after round 2 once", async () => {
    const { run } = withFixReview(
      () => fixReviewed({ results: [verdict("R1", "unresolved", "still buffers")] }),
      { find: async () => reviewed(finding("R1", "minor")) },
    );
    const outcome = await run();
    expect(outcome.notes.filter(n => n.includes("still open"))).toEqual(["Fix review: 1 claimed fix(es) still open (R1)."]);
  });

  it("gives a regression that first fails after round 1 the next C id", async () => {
    const lateRegression: ReviewFinding = { id: "C1", severity: "blocker", file: ".", issue: "npm run build fails after the change (passed before it): x", suggestion: "Fix it." };
    const existing: ReviewFinding = { id: "C1", severity: "blocker", file: ".", issue: "npm run lint fails after the change (passed before it): y", suggestion: "Fix it." };
    let rechecks = 0;
    const { calls, run } = withFixReview(undefined, {
      find: async () => reviewed(),
      regressions: [existing],
      recheck: async () => ++rechecks === 1 ? [lateRegression] : [],
    });
    const outcome = await run();
    expect(calls.fix[1]).toMatchObject([{ id: "C2", issue: lateRegression.issue }]);
    expect(outcome.review.findings.map(f => f.id)).toEqual(["C1", "C2"]);
  });

  it("does not re-send a finding the fixer marked not_fixed", async () => {
    let fixes = 0;
    const { run } = withFixReview(undefined, {
      find: async () => reviewed(finding("R1", "minor"), finding("R2", "minor")),
      fix: async findings => { fixes++; return fixed(findings.map(f => resolution(f.id, f.id === "R1" ? "not_fixed" : "fixed"))); },
    });
    await run();
    expect(fixes).toBe(1);
  });

  it("skips round 2 with a note and needs_review when the gate closes before it", async () => {
    let reviews = 0;
    const { calls, run } = withFixReview(
      call => { reviews++; return firstReviewFindsOne()(call); },
      { gateOpen: () => reviews === 0, find: async () => reviewed(finding("R1", "minor")) },
    );
    const outcome = await run();
    expect(calls.fixRounds).toEqual([1]);
    expect(outcome.notes).toContain("Second fix round skipped: budget cap reached.");
    expect(outcome.needsReview).toBe(true);
  });

  it("treats fixer candidates as unconfirmed findings when the gate closes before the fix review confirm", async () => {
    let reviews = 0;
    const { calls, run } = withFixReview(
      ({ resolutions }) => { reviews++; return fixReviewed({ results: claimsResolved(resolutions), findings: [fixerFinding()], risks: [risk("maybe")] }); },
      { ...oneBlocker, gateOpen: () => reviews === 0 },
    );
    const outcome = await run();
    expect(calls.confirmStages).toEqual(["review-confirm-1"]);
    expect(outcome.review.findings.map(f => `${f.id}:${f.from}`)).toEqual(["R1:B1", "R2:F1"]);
    expect(outcome.review.risks).toEqual([risk("maybe")]);
    expect(outcome.review.fixReviews).toEqual([{ round: 1, outcome: "reviewed", files: 2, candidates: 2, confirmation: { outcome: "skipped", reason: "budget cap reached" } }]);
    expect(outcome.notes).toContain("Fix review: Review candidates unconfirmed: budget cap reached.");
    expect(outcome.needsReview).toBe(true);
  });

  it("keeps the record but refuses to publish when the fix review's confirm modifies the worktree", async () => {
    let snap = "same";
    const { calls, run } = withFixReview(firstReviewFindsOne(), {
      ...oneBlocker,
      snapshot: () => snap,
      confirm: async batch => { if (batch.candidates[0].lens === "fixer") snap = "changed"; return judged(batch); },
    });
    const outcome = await run();
    expect(calls.fixRounds).toEqual([1]);
    expect(outcome.review.outcome).toBe("reviewed");
    expect(outcome.review.findings.map(f => f.id)).toEqual(["R1"]);
    expect(outcome.review.resolutions).toEqual([resolution("R1")]);
    expect(outcome.review.verification?.outcome).toBe("verified");
    expect(outcome.review.candidates?.map(c => c.id)).toEqual(["B1", "F1"]);
    expect(outcome).toMatchObject({ needsReview: true, publish: false });
    expect(outcome.notes.join(" ")).toContain("Fix review failed: confirm batch 1 modified the worktree; work kept on local branch, not pushed.");
    expect(outcome.review.fixReviews).toEqual([{ round: 1, outcome: "reviewed", files: 2, candidates: 1, confirmation: { outcome: "failed", reason: "confirm batch 1 modified the worktree" } }]);
  });

  it("rechecks after each round and reports checks still failing after the last", async () => {
    const regression: ReviewFinding = { id: "C1", severity: "minor", file: ".", issue: "npm run lint fails after the change (passed before it): boom", suggestion: "Fix it." };
    let rechecks = 0;
    const { calls, run } = withFixReview(undefined, {
      regressions: [regression],
      recheck: async () => { rechecks++; return [regression]; },
    });
    const outcome = await run();
    expect(calls.fixRounds).toEqual([1, 2]);
    expect(rechecks).toBe(2);
    expect(outcome.notes.join(" ")).toMatch(/still failing.*npm run lint/);
    expect(outcome.needsReview).toBe(true);
  });

  it("returns both rounds' fix reports in order", async () => {
    const { run } = withFixReview(firstReviewFindsOne(), {
      find: async () => reviewed(finding("R1", "minor")),
      fix: async (findings, round) => fixed(findings.map(f => resolution(f.id)), { report: report({ summary: `round ${round}` }) }),
    });
    const outcome = await run();
    expect(outcome.fixReports.map(r => r.summary)).toEqual(["round 1", "round 2"]);
  });

  it("returns no fix reports when no fix ran", async () => {
    const { run } = harness();
    expect((await run()).fixReports).toEqual([]);
  });

  it("records each round in fixReviews with its outcome, file count and candidate count", async () => {
    const { run } = withFixReview(firstReviewFindsOne(), { find: async () => reviewed(finding("R1", "minor")) });
    const outcome = await run();
    expect(outcome.review.fixReviews).toEqual([
      { round: 1, outcome: "reviewed", files: 2, candidates: 1, confirmation: { outcome: "confirmed", batches: [{ n: 1, ids: ["F1"], outcome: "confirmed" }] } },
      { round: 2, outcome: "reviewed", files: 2, candidates: 0 },
    ]);
  });

  it("DEMO-564: an untested change to a shared helper found in the fixer's diff is fixed in round 2", async () => {
    const folderFinding = {
      id: "N1", severity: "minor" as const, confidence: "proven" as const, file: "services/import-worker/tests/destination-folder.test.ts",
      issue: "The code-point cap in sanitiseExportName also changes sanitiseFolderName; no test in destination-folder.test.ts covers it.",
      suggestion: "Add an astral-character test for the destination folder name.",
    };
    const { calls, seen, run } = withFixReview(
      ({ round, resolutions }) => round === 1
        ? fixReviewed({ results: claimsResolved(resolutions), findings: [folderFinding] })
        : fixReviewed({ results: claimsResolved(resolutions) }),
      { find: async () => reviewed(finding("R1", "major"), finding("R2", "major"), finding("R3", "minor")) },
    );
    const outcome = await run();
    expect(calls.confirm[1]).toMatchObject([{ id: "F1", lens: "fixer", file: folderFinding.file }]);
    expect(calls.fixRounds).toEqual([1, 2]);
    expect(calls.fix[1]).toMatchObject([{ id: "R4", from: "F1" }]);
    expect(seen.runs[1].resolutions.filter(r => r.status === "fixed").map(r => r.id)).toEqual(["R4"]);
    expect(outcome.review.resolutions.find(r => r.id === "R4")?.status).toBe("fixed");
    expect(outcome.review.verification?.results).toContainEqual(verdict("R4"));
    expect(outcome).toMatchObject({ publish: true, needsReview: false });
  });
});
