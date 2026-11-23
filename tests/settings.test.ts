import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../src/settings.js";

const from = (values: Record<string, string>) => (name: string) => values[name];

describe("loadSettings", () => {
  it("returns the defaults when nothing is set", () => {
    expect(loadSettings(() => undefined)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      claudeEffort: "high",
      reviewModel: "claude-opus-5-5",
      dedupeModel: "claude-sonnet-5-5",
      usageProbeModel: "claude-haiku-4-5-20251001",
      codexModel: "gpt-6.1-sol",
      codexEffort: "high",
      codexAllowancePercent: 20,
      timeZone: "America/Vancouver",
    });
  });

  it("leaves the implementation model unset by default", () => {
    expect(loadSettings(() => undefined).implementationModel).toBeUndefined();
  });

  it("treats empty values as unset", () => {
    expect(loadSettings(from({ REVIEW_MODEL: "" }))).toEqual(DEFAULT_SETTINGS);
  });

  it("overrides every key", () => {
    expect(
      loadSettings(
        from({
          NIGHTSHIFT_CLAUDE_EFFORT: "max",
          REVIEW_MODEL: "review-x",
          DEDUPE_MODEL: "dedupe-x",
          IMPLEMENTATION_MODEL: "claude-opus-4-1[1m]",
          USAGE_PROBE_MODEL: "probe-x",
          CODEX_MODEL: "codex-x",
          CODEX_EFFORT: "minimal",
          CODEX_ALLOWANCE_PERCENT: "35",
          NIGHTSHIFT_TIME_ZONE: "Europe/London",
        }),
      ),
    ).toEqual({
      claudeEffort: "max",
      reviewModel: "review-x",
      dedupeModel: "dedupe-x",
      implementationModel: "claude-opus-4-1[1m]",
      usageProbeModel: "probe-x",
      codexModel: "codex-x",
      codexEffort: "minimal",
      codexAllowancePercent: 35,
      timeZone: "Europe/London",
    });
  });

  it.each([
    ["NIGHTSHIFT_CLAUDE_EFFORT", "x", 'NIGHTSHIFT_CLAUDE_EFFORT must be one of low, medium, high, xhigh, max, got "x"'],
    ["CODEX_EFFORT", "max", 'CODEX_EFFORT must be one of minimal, low, medium, high, xhigh, got "max"'],
    ["REVIEW_MODEL", "claude opus", 'REVIEW_MODEL must be a model name like "claude-opus-5-5", got "claude opus"'],
    ["DEDUPE_MODEL", "a b", 'DEDUPE_MODEL must be a model name like "claude-sonnet-5-5", got "a b"'],
    ["IMPLEMENTATION_MODEL", "a b", 'IMPLEMENTATION_MODEL must be a model name like "claude-opus-5-5", got "a b"'],
    ["USAGE_PROBE_MODEL", "a b", 'USAGE_PROBE_MODEL must be a model name like "claude-haiku-4-5-20251001", got "a b"'],
    ["CODEX_MODEL", "a b", 'CODEX_MODEL must be a model name like "gpt-6.1-sol", got "a b"'],
    ["CODEX_ALLOWANCE_PERCENT", "0", 'CODEX_ALLOWANCE_PERCENT must be a whole number from 1 to 100, got "0"'],
    ["CODEX_ALLOWANCE_PERCENT", "101", 'CODEX_ALLOWANCE_PERCENT must be a whole number from 1 to 100, got "101"'],
    ["CODEX_ALLOWANCE_PERCENT", "2.5", 'CODEX_ALLOWANCE_PERCENT must be a whole number from 1 to 100, got "2.5"'],
    ["NIGHTSHIFT_TIME_ZONE", "Mars/Base", 'NIGHTSHIFT_TIME_ZONE must be an IANA time zone like "America/Vancouver", got "Mars/Base"'],
  ])("rejects %s=%s", (key, value, message) => {
    expect(() => loadSettings(from({ [key]: value }))).toThrow(message);
  });
});
