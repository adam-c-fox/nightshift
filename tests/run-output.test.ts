import { describe, expect, it } from "vitest";
import { parseRunOutput } from "../src/claude.js";

const envelope = (over: object = {}) => JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "All done.\n---REPORT---\nstatus: done\n---",
  num_turns: 12, duration_ms: 45000, total_cost_usd: 1.25,
  usage: { input_tokens: 100, output_tokens: 2000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 4000 },
  modelUsage: { "claude-opus-5-5": { inputTokens: 100 }, "claude-haiku-5": { inputTokens: 5 } },
  ...over,
});

describe("parseRunOutput", () => {
  it("takes the final message and usage from the JSON output", () => {
    const { text, usage } = parseRunOutput(envelope());
    expect(text).toBe("All done.\n---REPORT---\nstatus: done\n---");
    expect(usage).toEqual({
      inputTokens: 100, outputTokens: 2000, cacheReadTokens: 30000, cacheCreationTokens: 4000,
      costUsd: 1.25, turns: 12, durationMs: 45000, models: ["claude-opus-5-5", "claude-haiku-5"],
    });
  });

  it("returns stdout unchanged with no usage when it isn't JSON", () => {
    expect(parseRunOutput("partial output")).toEqual({ text: "partial output" });
    expect(parseRunOutput("")).toEqual({ text: "" });
  });

  it("returns no usage when the JSON has no result", () => {
    const stdout = JSON.stringify({ usage: { input_tokens: 1 } });
    expect(parseRunOutput(stdout)).toEqual({ text: stdout });
  });

  it("lists the models from modelUsage", () => {
    expect(parseRunOutput(envelope({ modelUsage: { "claude-sonnet-5-5": {} } })).usage?.models).toEqual(["claude-sonnet-5-5"]);
    expect(parseRunOutput(envelope({ modelUsage: undefined })).usage?.models).toEqual([]);
  });
});
