import { describe, it, expect, vi } from "vitest";
import { runResumable, sessionArgs, sumUsage, MAX_RESUMES, type Attempt } from "../src/claude.js";

const proc = { stdout: "", stderr: "", status: 0, signal: null };
const done: Attempt = { proc };
const paused: Attempt = { proc: { ...proc, abortReason: "session limit" }, paused: "session limit" };

function script(...attempts: Attempt[]) {
  const flags: boolean[] = [];
  const attempt = vi.fn(async (resume: boolean) => { flags.push(resume); return attempts[flags.length - 1]; });
  return { attempt, flags };
}

describe("runResumable", () => {
  it("runs once when not paused", async () => {
    const { attempt } = script(done);
    const waitForSession = vi.fn(async () => {});
    const result = await runResumable(attempt, { waitForSession });
    expect(result).toEqual({ attempts: [done], stopReason: undefined });
    expect(waitForSession).not.toHaveBeenCalled();
  });

  it("waits once and resumes after a pause", async () => {
    const { attempt, flags } = script(paused, done);
    const waitForSession = vi.fn(async () => {});
    const result = await runResumable(attempt, { waitForSession });
    expect(flags).toEqual([false, true]);
    expect(waitForSession).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBeUndefined();
    expect(result.attempts).toEqual([paused, done]);
  });

  it("stops for good when the weekly gate trips during the wait", async () => {
    const { attempt, flags } = script(paused, done);
    const result = await runResumable(attempt, { waitForSession: async () => {}, shouldAbort: () => "budget cap reached" });
    expect(flags).toEqual([false]);
    expect(result.stopReason).toBe("budget cap reached");
  });

  it("gives up after MAX_RESUMES resumes", async () => {
    const { attempt, flags } = script(paused, paused, paused, paused);
    const result = await runResumable(attempt, { waitForSession: async () => {} });
    expect(flags).toHaveLength(1 + MAX_RESUMES);
    expect(result.stopReason).toBe("session limit");
  });

  it("treats a pause as final without waitForSession", async () => {
    const { attempt, flags } = script(paused, done);
    const result = await runResumable(attempt, {});
    expect(flags).toEqual([false]);
    expect(result.stopReason).toBe("session limit");
  });
});

describe("sessionArgs", () => {
  it("starts the session on the first attempt and resumes the same id after", () => {
    expect(sessionArgs("abc", false)).toEqual(["--session-id", "abc"]);
    expect(sessionArgs("abc", true)).toEqual(["--resume", "abc"]);
  });
});

describe("sumUsage", () => {
  const u = (n: number, models: string[]) => ({ inputTokens: n, outputTokens: n, cacheReadTokens: n, cacheCreationTokens: n, costUsd: n, turns: n, durationMs: n, models });
  it("adds fields and de-duplicates models", () => {
    expect(sumUsage([u(1, ["a"]), u(2, ["a", "b"])])).toEqual(u(3, ["a", "b"]));
  });
  it("is undefined when no attempt reported usage", () => {
    expect(sumUsage([undefined, undefined])).toBeUndefined();
  });
});
