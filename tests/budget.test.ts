import { describe, expect, it } from "vitest";
import {
  apiUsageSource, budgetUsedPct, cliUsageSource, closedBudget, formatUsageAttempts, openNightBudget,
  parseRateLimitHeaders, parseUsageOutput, snapshotUsage, UsageUnavailableError, withCurrentUsage,
  type UsageCommandResult,
} from "../src/budget.js";

const usageOutput = `Ignoring 6 permissions.allow entries from .claude/settings.json
You are currently using your subscription to power your Claude Code usage

Current session: 5% used · resets Oct 1 at 1pm (America/Vancouver)
Current week (all models): 1% used · resets Oct 7 at 10am (America/Vancouver)

What's contributing to your limits usage?
`;

describe("parseUsageOutput", () => {
  it("reads the weekly line, not the session line", () => {
    expect(parseUsageOutput(usageOutput)).toEqual({
      weeklyPercent: 1,
      resetInfo: "Oct 7 at 10am (America/Vancouver)",
    });
  });

  it("supports decimal percentages", () => {
    expect(parseUsageOutput("Current week (all models): 12.5% used").weeklyPercent).toBe(12.5);
  });

  it("throws instead of reporting 0% when the weekly line is missing", () => {
    expect(() => parseUsageOutput("Current session: 5% used")).toThrow(/weekly usage/);
  });
});

describe("night budget gate", () => {
  const start = openNightBudget({ weeklyPercent: 3, resetInfo: "soon" });

  it("caps at start plus the 15 point allocation", () => {
    expect(start).toMatchObject({ startPct: 3, capPct: 18, allocationPct: 15, gateHit: false });
  });

  it("allows a ticket below the cap, stops at or above it", () => {
    expect(withCurrentUsage(start, { weeklyPercent: 14, resetInfo: "" }).gateHit).toBe(false);
    expect(withCurrentUsage(start, { weeklyPercent: 18, resetInfo: "" }).gateHit).toBe(true);
    expect(withCurrentUsage(start, { weeklyPercent: 19, resetInfo: "" }).gateHit).toBe(true);
  });

  it("reports how much of the allocation was used", () => {
    expect(budgetUsedPct(withCurrentUsage(start, { weeklyPercent: 19, resetInfo: "" }))).toBe(16);
  });

  it("re-bases the cap when weekly usage resets mid-night", () => {
    const spent5 = withCurrentUsage(start, { weeklyPercent: 8, resetInfo: "" });
    const afterReset = withCurrentUsage(spent5, { weeklyPercent: 1, resetInfo: "next week" });
    expect(afterReset).toMatchObject({ currentPct: 1, capPct: 11, gateHit: false });
    expect(budgetUsedPct(afterReset)).toBe(5);
  });

  it("keeps the full allocation if usage resets before anything is spent", () => {
    const afterReset = withCurrentUsage(start, { weeklyPercent: 0, resetInfo: "" });
    expect(afterReset).toMatchObject({ capPct: 15, gateHit: false });
  });

  it("stays closed after reset if the allocation was already spent", () => {
    const spentAll = withCurrentUsage(start, { weeklyPercent: 18, resetInfo: "" });
    expect(withCurrentUsage(spentAll, { weeklyPercent: 0, resetInfo: "" }).gateHit).toBe(true);
  });
});

describe("closedBudget", () => {
  it("is a gate-hit budget that explains why", () => {
    expect(closedBudget("claude not on PATH")).toMatchObject({ gateHit: true, unavailable: true, resetInfo: "claude not on PATH", capPct: 0 });
  });
});

describe("snapshotUsage", () => {
  const good: UsageCommandResult = { stdout: usageOutput, stderr: "", status: 0 };
  const garbled: UsageCommandResult = { stdout: "Not logged in · Please run /login", stderr: "auth warning", status: 0 };
  const sequence = (...results: UsageCommandResult[]) => {
    let i = 0;
    return cliUsageSource(() => results[i++]);
  };

  it("reads usage on the first attempt without pausing", () => {
    const pauses: number[] = [];
    expect(snapshotUsage(3, sequence(good), ms => pauses.push(ms)).weeklyPercent).toBe(1);
    expect(pauses).toEqual([]);
  });

  it("retries after a failed read and pauses between attempts", () => {
    const pauses: number[] = [];
    expect(snapshotUsage(3, sequence(garbled, good), ms => pauses.push(ms)).weeklyPercent).toBe(1);
    expect(pauses).toHaveLength(1);
  });

  it("explains a logged-out claude, which prints a cost summary instead of usage", () => {
    const loggedOut: UsageCommandResult = { stdout: "Total cost:            $0.0000\nUsage: 0 input", stderr: "", status: 0 };
    expect(() => snapshotUsage(1, sequence(loggedOut), () => {})).toThrow(/not logged in.*CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("treats a non-zero exit as a failed read even if stdout parses", () => {
    const crashed: UsageCommandResult = { ...good, status: 1 };
    expect(() => snapshotUsage(1, sequence(crashed), () => {})).toThrow(/exited with status 1/);
  });

  it("keeps every attempt's raw output when all attempts fail", () => {
    const spawnFailure: UsageCommandResult = { stdout: "", stderr: "", status: null, error: "spawnSync claude ETIMEDOUT" };
    let caught: unknown;
    try {
      snapshotUsage(2, sequence(garbled, spawnFailure), () => {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UsageUnavailableError);
    const err = caught as UsageUnavailableError;
    expect(err.message).toMatch(/ETIMEDOUT/);
    expect(err.message).toMatch(/2 attempts/);
    expect(err.attempts).toEqual([garbled, spawnFailure]);
  });
});

describe("formatUsageAttempts", () => {
  it("shows each attempt's exit, stdout and stderr", () => {
    const lines = formatUsageAttempts([
      { stdout: "Not logged in", stderr: "auth warning", status: 0 },
      { stdout: "", stderr: "", status: null, error: "ETIMEDOUT" },
    ]);
    expect(lines.join("\n")).toBe([
      "Attempt 1: exit 0",
      "  stdout: Not logged in",
      "  stderr: auth warning",
      "Attempt 2: exit null, ETIMEDOUT",
      "  stdout: (empty)",
      "  stderr: (empty)",
    ].join("\n"));
  });
});

const probeHeaders = `HTTP/2 200 
anthropic-ratelimit-unified-5h-utilization: 0.05
anthropic-ratelimit-unified-7d-reset: 1791392400
anthropic-ratelimit-unified-7d-utilization: 0.234
anthropic-ratelimit-unified-status: allowed

{"type":"message"}`;

describe("parseRateLimitHeaders", () => {
  it("reads the weekly utilization and reset, not the 5h window", () => {
    const snapshot = parseRateLimitHeaders(probeHeaders);
    expect(snapshot.weeklyPercent).toBe(23.4);
    expect(snapshot.resetInfo).toMatch(/^Oct 7, 10:00\sAM \(America\/Vancouver\)$/);
  });

  it("throws when the weekly header is missing", () => {
    expect(() => parseRateLimitHeaders("HTTP/2 200 \nanthropic-ratelimit-unified-5h-utilization: 0.05")).toThrow(/7d-utilization/);
  });
});

describe("apiUsageSource", () => {
  const probe = (stdout: string, status = 0) => apiUsageSource("token", () => ({ stdout, stderr: "", status }));

  it("reads weekly usage from a successful probe", () => {
    expect(snapshotUsage(1, probe(probeHeaders), () => {}).weeklyPercent).toBe(23.4);
  });

  it("fails with the HTTP status and body when the probe is rejected", () => {
    const rejected = `HTTP/2 401 \ncontent-type: application/json\n\n{"error":"invalid token"}`;
    expect(() => snapshotUsage(1, probe(rejected), () => {})).toThrow(/HTTP 401.*invalid token/);
  });

  it("fails when curl itself fails", () => {
    expect(() => snapshotUsage(1, probe("", 6), () => {})).toThrow(/curl exited with status 6/);
  });
});
