import { describe, expect, it } from "vitest";
import { buildCodexArgs, codexUsageLimited, openCodexBudget, parseCodexEvents, parseCodexRateLimits, runCodexLens, type CodexLensDeps } from "../src/codex.js";
import { buildFinderPrompt, type AgentReport, type ReviewRunResult, type TicketBrief } from "../src/claude.js";
import { closedBudget, openNightBudget, type UsageSnapshot } from "../src/budget.js";
import { TIME_ZONE } from "../src/time.js";
import fixture from "./fixtures/codex-rate-limits.json" with { type: "json" };

const weeklyReset = new Date(1793300095000).toLocaleString("en-US", {
  timeZone: TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

describe("parseCodexRateLimits", () => {
  const expected = { weeklyPercent: 0, sessionPercent: 0, sessionResetAt: 1792713295000, weeklyResetAt: 1793300095000, resetInfo: `${weeklyReset} (${TIME_ZONE})` };

  it("maps the 5-hour and weekly windows onto a usage snapshot", () => {
    expect(parseCodexRateLimits(fixture)).toEqual(expected);
  });

  it("matches windows by duration, not by primary/secondary", () => {
    const { primary, secondary, ...rest } = fixture.rateLimits;
    expect(parseCodexRateLimits({ ...fixture, rateLimits: { ...rest, primary: secondary, secondary: primary } })).toEqual(expected);
  });

  it("rejects a response without a weekly window", () => {
    const { secondary: _, ...rest } = fixture.rateLimits;
    expect(() => parseCodexRateLimits({ ...fixture, rateLimits: rest })).toThrow(/weekly/);
  });
});

describe("buildCodexArgs", () => {
  it("runs read-only and ephemeral with the prompt on stdin", () => {
    expect(buildCodexArgs("/wt")).toEqual([
      "exec", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"', "-s", "read-only", "--ephemeral", "--ignore-user-config", "--json", "-C", "/wt", "-",
    ]);
  });
});

describe("parseCodexEvents", () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"t"}',
    "not json",
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
    '{"type":"turn.completed","usage":{"input_tokens":14013,"cached_input_tokens":11520,"output_tokens":5,"reasoning_output_tokens":0}}',
  ].join("\n");

  it("reads the last agent message and sums turn usage", () => {
    expect(parseCodexEvents(stdout, "gpt-6.1-sol")).toEqual({
      text: "ok",
      usage: { inputTokens: 2493, cacheReadTokens: 11520, cacheCreationTokens: 0, outputTokens: 5, costUsd: 0, turns: 1, durationMs: 0, models: ["gpt-6.1-sol"] },
    });
  });

  it("has no usage when no turn completed", () => {
    expect(parseCodexEvents('{"type":"thread.started"}', "m")).toEqual({ text: "" });
  });
});

describe("codexUsageLimited", () => {
  it("spots the usage limit message", () => {
    expect(codexUsageLimited("You've hit your usage limit. Try again at 3:00 PM.")).toBe(true);
    expect(codexUsageLimited("all good")).toBe(false);
  });
});

describe("codex finder prompt", () => {
  const brief: TicketBrief = { ticketId: "ENG-12", ticketName: "Poll", context: [], linearDesc: "", linearComments: [], linearUrl: "u", state: "Todo" };
  const report: AgentReport = {
    status: "done", title: "t", summary: "s", filesCreated: [], filesModified: [], tests: [], verifyCommands: [], notes: "", followups: [],
    decisions: [{ file: "src/a.ts", decision: "Empty rows are skipped." }],
  };

  it("lists the implementer's decisions like the bugs lens", () => {
    const prompt = buildFinderPrompt("codex", brief, report, "origin/main");
    expect(prompt).toContain("rule on each one");
    expect(prompt).toContain("D1 (src/a.ts): Empty rows are skipped.");
  });
});

const usage = (weeklyPercent: number, sessionPercent = 0): UsageSnapshot => ({ weeklyPercent, sessionPercent, resetInfo: "Oct 29" });
const ok: ReviewRunResult = { success: true, rawOutput: "out", findings: [] };

const lensHarness = (reads: UsageSnapshot[], runs: ReviewRunResult[] = [ok], over: Partial<CodexLensDeps> = {}) => {
  const calls = { sleeps: [] as number[], runs: 0 };
  const deps: CodexLensDeps = {
    budget: { current: openNightBudget(usage(15), 20) },
    readUsage: async () => reads.length > 1 ? reads.shift()! : reads[0],
    claudeGateReason: () => undefined,
    sleep: async ms => { calls.sleeps.push(ms); },
    now: () => 0,
    log: () => {},
    run: async () => runs[Math.min(calls.runs++, runs.length - 1)],
    ...over,
  };
  return { calls, deps, run: () => runCodexLens(deps) };
};

describe("runCodexLens", () => {
  it("skips when the Codex budget is unavailable", async () => {
    const { calls, run } = lensHarness([usage(15)], [ok], { budget: { current: closedBudget("no login") } });
    expect(await run()).toMatchObject({ success: false, skipReason: "Codex usage unavailable" });
    expect(calls.runs).toBe(0);
  });

  it("skips when the night allowance is spent", async () => {
    const { calls, run } = lensHarness([usage(36)], [ok], { budget: { current: openNightBudget(usage(15), 20) } });
    expect(await run()).toMatchObject({ success: false, skipReason: "Codex night allowance reached (36% ≥ cap 35%)" });
    expect(calls.runs).toBe(0);
  });

  it("skips with the read error when usage cannot be refreshed", async () => {
    const { calls, run } = lensHarness([usage(15)], [ok], { readUsage: async () => { throw new Error("app-server down"); } });
    expect(await run()).toMatchObject({ skipReason: "app-server down" });
    expect(calls.runs).toBe(0);
  });

  it("waits for the 5-hour session to reset, then runs once", async () => {
    const { calls, run } = lensHarness([usage(16, 85), usage(16, 85), usage(16, 10)]);
    expect(await run()).toBe(ok);
    expect(calls.sleeps).toHaveLength(1);
    expect(calls.runs).toBe(1);
  });

  it("skips with the Claude gate reason when Claude's cap closed during the wait", async () => {
    const { calls, run } = lensHarness([usage(16, 85), usage(16, 85), usage(16, 10)], [ok], { claudeGateReason: () => "budget cap reached" });
    expect(await run()).toMatchObject({ success: false, skipReason: "budget cap reached" });
    expect(calls.runs).toBe(0);
  });

  it("retries once after a usage limit", async () => {
    const limited: ReviewRunResult = { success: false, rawOutput: "", failure: "Codex usage limit reached", usageLimited: true };
    const { calls, run } = lensHarness([usage(16)], [limited, ok]);
    expect(await run()).toBe(ok);
    expect(calls.runs).toBe(2);
  });

  it("fails after a second usage limit instead of looping", async () => {
    const limited: ReviewRunResult = { success: false, rawOutput: "", usageLimited: true };
    const { calls, run } = lensHarness([usage(16)], [limited, limited]);
    expect(await run()).toMatchObject({ success: false, failure: "Codex usage limit reached" });
    expect(calls.runs).toBe(2);
  });

  it("refreshes the shared budget after the run", async () => {
    const { deps, run } = lensHarness([usage(16), usage(16), usage(19)]);
    await run();
    expect(deps.budget.current.currentPct).toBe(19);
  });
});

describe("openCodexBudget", () => {
  it("opens a 20% budget from the weekly reading", async () => {
    expect(await openCodexBudget(async () => usage(10))).toMatchObject({ startPct: 10, capPct: 30, allocationPct: 20, unavailable: false });
  });

  it("closes the budget with the reason when the read fails", async () => {
    const budget = await openCodexBudget(async () => { throw new Error("no login"); });
    expect(budget).toMatchObject({ unavailable: true, gateHit: true, resetInfo: "Codex usage unavailable: no login" });
  });
});
