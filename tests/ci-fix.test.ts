import { describe, expect, it } from "vitest";
import { ciFixContext, fixFailingChecks, MAX_CI_FIX_ATTEMPTS, type CiFixDeps } from "../src/ci-fix.js";
import type { ClaudeResult } from "../src/claude.js";
import type { PRResult } from "../src/pr.js";

const pr = (pipelineStatus: PRResult["pipelineStatus"], names: string[] = []): PRResult => ({
  prId: 7, url: "https://x/7", pipelineStatus, durationSec: 1,
  failedChecks: names.map((name, i) => ({ name, buildId: i + 1 })),
});

const agentResult = (title = "fix: format files", status = "done"): ClaudeResult => ({
  success: true, rawOutput: "",
  report: { status, title, summary: "Ran prettier.", filesCreated: [], filesModified: [], tests: [], verifyCommands: [], notes: "", followups: [] },
});

const harness = (overrides: Partial<CiFixDeps> = {}, pushes: PRResult[] = [pr("succeeded")]) => {
  const calls = { agent: [] as string[][], commits: [] as string[], publishes: 0, fetched: [] as string[][], logged: [] as string[] };
  let publishIndex = 0;
  const deps: CiFixDeps = {
    runAgent: async context => { calls.agent.push(context); return agentResult(); },
    commit: subject => { calls.commits.push(subject); return "committed"; },
    publish: async () => { calls.publishes++; return pushes[Math.min(publishIndex++, pushes.length - 1)]; },
    fetchLogs: async checks => { calls.fetched.push(checks.map(c => c.name)); return [{ check: checks[0].name, task: "prettier --check", issues: [], tail: "[warn] a.ts" }]; },
    gateOpen: () => true,
    log: m => calls.logged.push(m),
    ...overrides,
  };
  const run = (initial: PRResult) => fixFailingChecks(initial, { ticketId: "DEMO-1", title: "feat: original" }, deps);
  return { calls, run };
};

describe("fixFailingChecks", () => {
  it("does nothing when checks already passed", async () => {
    const { calls, run } = harness();
    const outcome = await run(pr("succeeded"));
    expect(outcome).toMatchObject({ attempts: 0, stopped: undefined });
    expect(calls.agent).toHaveLength(0);
  });

  it("does not loop on an unknown verdict", async () => {
    const { calls, run } = harness();
    const outcome = await run(pr("unknown"));
    expect(outcome.attempts).toBe(0);
    expect(calls.agent).toHaveLength(0);
  });

  it("passes on the first fix attempt", async () => {
    const { calls, run } = harness();
    const outcome = await run(pr("failed", ["lint-format"]));
    expect(outcome.attempts).toBe(1);
    expect(outcome.pr.pipelineStatus).toBe("succeeded");
    expect(outcome.stopped).toBeUndefined();
    expect(calls.logged).toContain("  CI fix attempt 1/2: lint-format");
    expect(calls.fetched).toEqual([["lint-format"]]);
    expect(calls.agent[0].join("\n")).toContain("PR #7");
    expect(calls.agent[0].join("\n")).toContain("[warn] a.ts");
    expect(calls.commits).toEqual(["fix: format files (DEMO-1)"]);
  });

  it("falls back to the ticket title when the report has none", async () => {
    const { calls, run } = harness({ runAgent: async () => agentResult("") });
    await run(pr("failed", ["lint-format"]));
    expect(calls.commits).toEqual(["feat: original (DEMO-1)"]);
  });

  it("gives up after two attempts and reports the still-failing checks", async () => {
    const { calls, run } = harness({}, [pr("failed", ["typecheck"]), pr("failed", ["typecheck", "unit-tests"])]);
    const outcome = await run(pr("failed", ["lint-format"]));
    expect(MAX_CI_FIX_ATTEMPTS).toBe(2);
    expect(outcome.attempts).toBe(2);
    expect(outcome.stopped).toBe("exhausted");
    expect(outcome.pr.failedChecks.map(c => c.name)).toEqual(["typecheck", "unit-tests"]);
    expect(calls.agent).toHaveLength(2);
    expect(calls.publishes).toBe(2);
    expect(calls.logged).toContain("  CI fix attempt 2/2: typecheck");
  });

  it("stops when the budget gate closes", async () => {
    let checks = 0;
    const { calls, run } = harness({ gateOpen: () => ++checks === 1 }, [pr("failed", ["lint-format"])]);
    const outcome = await run(pr("failed", ["lint-format"]));
    expect(outcome.attempts).toBe(1);
    expect(outcome.stopped).toBe("budget");
    expect(calls.agent).toHaveLength(1);
  });

  it("does not start when the gate is already closed", async () => {
    const { calls, run } = harness({ gateOpen: () => false });
    const outcome = await run(pr("failed", ["lint-format"]));
    expect(outcome).toMatchObject({ attempts: 0, stopped: "budget" });
    expect(calls.agent).toHaveLength(0);
  });

  it("stops when the agent makes no changes", async () => {
    const { calls, run } = harness({ commit: () => "no_changes" });
    const outcome = await run(pr("failed", ["lint-format"]));
    expect(outcome).toMatchObject({ attempts: 1, stopped: "no_changes" });
    expect(calls.publishes).toBe(0);
    expect(outcome.pr.pipelineStatus).toBe("failed");
  });

  it("stops without committing when the agent aborts or fails", async () => {
    const { calls, run } = harness({ runAgent: async () => ({ success: false, rawOutput: "", failure: "claude exited with status 1" }) });
    const outcome = await run(pr("failed", ["lint-format"]));
    expect(outcome).toMatchObject({ attempts: 1, stopped: "agent" });
    expect(outcome.notes.join(" ")).toMatch(/did not finish/);
    expect(calls.commits).toHaveLength(0);
  });

  it("stops looping when a fix push ends unknown", async () => {
    const { calls, run } = harness({}, [pr("unknown")]);
    const outcome = await run(pr("failed", ["lint-format"]));
    expect(outcome.attempts).toBe(1);
    expect(outcome.pr.pipelineStatus).toBe("unknown");
    expect(calls.agent).toHaveLength(1);
  });

  it("surfaces a needs_review status from the fix agent", async () => {
    const { run } = harness({ runAgent: async () => agentResult("fix: x", "needs_review") });
    const outcome = await run(pr("failed", ["lint-format"]));
    expect(outcome.agentStatus).toBe("needs_review");
  });
});

describe("ciFixContext", () => {
  it("names the PR, includes the logs and scopes the fix", () => {
    const text = ciFixContext(42, "LOGS HERE").join("\n");
    expect(text).toContain("PR #42");
    expect(text).toContain("LOGS HERE");
    expect(text).toMatch(/only/i);
    expect(text).toMatch(/locally/i);
    expect(text.toLowerCase()).not.toContain("night");
  });
});
