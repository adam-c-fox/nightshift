import { describe, expect, it } from "vitest";
import type { AgentReport, FixRunResult, ReviewRunResult } from "../src/claude.js";
import { mergeFixReport, reviewAndFix, type ReviewDeps } from "../src/review.js";
import type { FixResolution, ReviewFinding } from "../src/types.js";

const finding = (id: string, severity: ReviewFinding["severity"] = "major"): ReviewFinding => ({
  id, severity, file: "src/a.ts", issue: `Problem ${id}.`, suggestion: `Fix ${id}.`,
});

const reviewed = (...findings: ReviewFinding[]): ReviewRunResult => ({ success: true, rawOutput: "review out", findings });

const report = (over: Partial<AgentReport> = {}): AgentReport => ({
  status: "done", title: "", summary: "Fixed it.", filesCreated: [], filesModified: [], tests: [], verifyCommands: [], notes: "", ...over,
});

const fixed = (fixes: FixResolution[], over: Partial<FixRunResult> = {}): FixRunResult =>
  ({ success: true, rawOutput: "fix out", report: report(), fixes, ...over });

const resolution = (id: string, status: FixResolution["status"] = "fixed"): FixResolution => ({ id, status, how: `how ${id}` });

const harness = (overrides: Partial<ReviewDeps> = {}) => {
  const calls = { review: 0, fix: [] as ReviewFinding[][], saved: [] as string[], logged: [] as string[] };
  const deps: ReviewDeps = {
    hasChanges: () => true,
    snapshot: () => "same",
    gateOpen: () => true,
    review: async () => { calls.review++; return reviewed(); },
    fix: async findings => { calls.fix.push(findings); return fixed(findings.map(f => resolution(f.id))); },
    saveOutput: (stage, raw) => calls.saved.push(`${stage}:${raw}`),
    log: m => calls.logged.push(m),
    ...overrides,
  };
  return { calls, run: (publishable = true) => reviewAndFix(publishable, deps) };
};

describe("reviewAndFix", () => {
  it("skips quietly when the implementation is not publishable", async () => {
    const { calls, run } = harness();
    const outcome = await run(false);
    expect(calls.review).toBe(0);
    expect(outcome.review).toMatchObject({ outcome: "skipped" });
    expect(outcome.needsReview).toBe(false);
  });

  it("skips quietly when there are no changes against base", async () => {
    const { calls, run } = harness({ hasChanges: () => false });
    const outcome = await run();
    expect(calls.review).toBe(0);
    expect(outcome.review.outcome).toBe("skipped");
    expect(outcome.review.reason).toMatch(/no changes/i);
    expect(outcome.needsReview).toBe(false);
  });

  it("skips and flags needs_review when the budget gate is closed", async () => {
    const { calls, run } = harness({ gateOpen: () => false });
    const outcome = await run();
    expect(calls.review).toBe(0);
    expect(outcome.review).toMatchObject({ outcome: "skipped", reason: expect.stringMatching(/budget/i) });
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
  });

  it("does not run the fix when there are no findings", async () => {
    const { calls, run } = harness();
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review).toEqual({ outcome: "reviewed", findings: [], resolutions: [], risks: [] });
    expect(outcome).toMatchObject({ needsReview: false, publish: true });
  });

  it("runs the fix with the findings and records the resolutions", async () => {
    const findings = [finding("R1", "blocker"), finding("R2", "minor")];
    const { calls, run } = harness({ review: async () => reviewed(...findings) });
    const outcome = await run();
    expect(calls.fix).toEqual([findings]);
    expect(outcome.review.findings).toEqual(findings);
    expect(outcome.review.resolutions.map(r => r.status)).toEqual(["fixed", "fixed"]);
    expect(outcome).toMatchObject({ needsReview: false, publish: true });
    expect(outcome.fixReport).toBeDefined();
  });

  it("saves the raw review and fix output", async () => {
    const { calls, run } = harness({ review: async () => reviewed(finding("R1")) });
    await run();
    expect(calls.saved).toEqual(["review:review out", "fix:fix out"]);
  });

  it("gives needs_review for an unfixed major but still publishes", async () => {
    const { run } = harness({
      review: async () => reviewed(finding("R1", "major")),
      fix: async () => fixed([resolution("R1", "not_fixed")]),
    });
    expect(await run()).toMatchObject({ needsReview: true, publish: true });
  });

  it("does not publish an unfixed blocker", async () => {
    const { run } = harness({
      review: async () => reviewed(finding("R1", "blocker")),
      fix: async () => fixed([resolution("R1", "not_fixed")]),
    });
    expect(await run()).toMatchObject({ needsReview: true, publish: false });
  });

  it("ignores an unfixed minor", async () => {
    const { run } = harness({
      review: async () => reviewed(finding("R1", "minor")),
      fix: async () => fixed([resolution("R1", "not_fixed")]),
    });
    expect(await run()).toMatchObject({ needsReview: false, publish: true });
  });

  it("treats a finding missing from the fix output as not fixed", async () => {
    const { run } = harness({
      review: async () => reviewed(finding("R1", "major"), finding("R2", "minor")),
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
      review: async () => reviewed(finding("R1", "major")),
      fix: async () => fixed([], { fixes: undefined, fixesError: "No ---FIXES--- block" }),
    });
    const outcome = await run();
    expect(outcome.review.resolutions[0].status).toBe("not_fixed");
    expect(outcome.needsReview).toBe(true);
  });

  it("keeps the implementer's work but holds back on a crashed fix with a blocker", async () => {
    const { run } = harness({
      review: async () => reviewed(finding("R1", "blocker")),
      fix: async () => ({ success: false, rawOutput: "", failure: "claude exited with status 1" }),
    });
    const outcome = await run();
    expect(outcome).toMatchObject({ needsReview: true, publish: false });
    expect(outcome.notes.join(" ")).toContain("claude exited with status 1");
    expect(outcome.review.resolutions.every(r => r.status === "not_fixed")).toBe(true);
  });

  it("publishes after a crashed fix when no blocker was found", async () => {
    const { run } = harness({
      review: async () => reviewed(finding("R1", "major")),
      fix: async () => ({ success: false, rawOutput: "", failure: "boom" }),
    });
    expect(await run()).toMatchObject({ needsReview: true, publish: true });
  });

  it("skips the fix and flags needs_review when the gate closes after the review", async () => {
    let open = true;
    const { calls, run } = harness({
      gateOpen: () => open,
      review: async () => { open = false; return reviewed(finding("R1", "major")); },
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
      review: async () => { snap = "after"; return reviewed(finding("R1")); },
    });
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/modified/i) });
    expect(outcome).toMatchObject({ needsReview: true, publish: false });
    expect(calls.logged.join("\n")).toMatch(/modified/i);
  });

  it("continues to publish when the review output cannot be parsed", async () => {
    const { calls, run } = harness({
      review: async () => ({ success: true, rawOutput: "waffle", parseError: "No ---REVIEW--- block found in agent output" }),
    });
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review).toMatchObject({ outcome: "failed", reason: expect.stringContaining("---REVIEW---") });
    expect(outcome).toMatchObject({ needsReview: true, publish: true });
  });

  it("continues to publish when the review run crashes", async () => {
    const { run } = harness({
      review: async () => ({ success: false, rawOutput: "", failure: "claude stopped: timed out" }),
    });
    const outcome = await run();
    expect(outcome.review).toMatchObject({ outcome: "failed", reason: "claude stopped: timed out" });
    expect(outcome.publish).toBe(true);
  });

  it("takes needs_review from a fix run that reports it", async () => {
    const { run } = harness({
      review: async () => reviewed(finding("R1", "minor")),
      fix: async () => fixed([resolution("R1")], { report: report({ status: "needs_review" }) }),
    });
    expect(await run()).toMatchObject({ needsReview: true });
  });
});

describe("mergeFixReport", () => {
  const base = {
    title: "feat: export", summary: "Adds export.", filesCreated: ["a.ts"], filesModified: ["b.ts"],
    tests: [{ name: "t1", file: "a.test.ts", result: "fail" as const }],
  };

  it("takes the refined title and summary when present", () => {
    expect(mergeFixReport(base, report({ title: "feat: stream export", summary: "Streams export." })))
      .toMatchObject({ title: "feat: stream export", summary: "Streams export." });
  });

  it("keeps the original title and summary when the fix report has none", () => {
    expect(mergeFixReport(base, report({ summary: "" }))).toMatchObject({ title: "feat: export", summary: "Adds export." });
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
    const { calls, run } = harness({ regressions: [regression], review: async () => reviewed(finding("R1")) });
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
    const { run } = harness({ regressions: [regression], review: async () => ({ success: false, rawOutput: "", failure: "crashed" }) });
    const outcome = await run();
    expect(outcome.needsReview).toBe(true);
    expect(outcome.notes.join(" ")).toContain("npm run lint");
  });
});

describe("reviewAndFix with risks", () => {
  const risks = [{ file: "a.ts", risk: "Confirm the default." }];

  it("keeps risks on the review and never sends them to the fix", async () => {
    const { calls, run } = harness({ review: async () => ({ ...reviewed(finding("R1")), risks }) });
    const outcome = await run();
    expect(outcome.review.risks).toEqual(risks);
    expect(JSON.stringify(calls.fix)).not.toContain("Confirm the default");
  });

  it("keeps risks when there are no findings, without running the fix", async () => {
    const { calls, run } = harness({ review: async () => ({ ...reviewed(), risks }) });
    const outcome = await run();
    expect(calls.fix).toHaveLength(0);
    expect(outcome.review.risks).toEqual(risks);
  });
});
