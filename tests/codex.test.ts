import { describe, expect, it } from "vitest";
import { parseCodexRateLimits } from "../src/codex.js";
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
