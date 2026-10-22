import { describe, expect, it } from "vitest";
import { buildCodexArgs, codexUsageLimited, parseCodexEvents, parseCodexRateLimits } from "../src/codex.js";
import { buildFinderPrompt, type AgentReport, type TicketBrief } from "../src/claude.js";
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
