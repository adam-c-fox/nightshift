import { describe, expect, it } from "vitest";
import type { AgentReport, ClaudeResult } from "../src/claude.js";
import type { Issue } from "../src/issue-tracker.js";
import { deriveOutcome, reviewMove } from "../src/status.js";

const report = (over: Partial<AgentReport> = {}): AgentReport => ({
  status: "done", title: "", summary: "s", filesCreated: [], filesModified: [],
  tests: [{ name: "t", file: "f", result: "pass" }], verifyCommands: [], notes: "", followups: [], decisions: [], threads: [], ...over,
});
const ok = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({ success: true, rawOutput: "", report: report(), ...over });

describe("deriveOutcome", () => {
  it("trusts a clean done", () => {
    expect(deriveOutcome(ok())).toEqual({ status: "done", notes: [], publish: true });
  });

  it("downgrades done when a reported test failed", () => {
    const out = deriveOutcome(ok({ report: report({ tests: [{ name: "t", file: "f", result: "fail" }] }) }));
    expect(out).toMatchObject({ status: "needs_review", publish: true });
    expect(out.notes.join()).toMatch(/failing test/i);
  });

  it("does not publish when the agent crashed or timed out", () => {
    const out = deriveOutcome(ok({ success: false, failure: "claude exited with status null (SIGTERM)" }));
    expect(out).toMatchObject({ status: "needs_review", publish: false });
    expect(out.notes.join()).toMatch(/SIGTERM/);
  });

  it("does not publish when aborted for budget", () => {
    const out = deriveOutcome(ok({ success: false, abortReason: "budget cap reached" }));
    expect(out).toMatchObject({ status: "needs_review", publish: false });
    expect(out.notes.join()).toMatch(/budget cap/);
  });

  it("publishes for review when the agent finished but gave no report", () => {
    expect(deriveOutcome({ success: true, rawOutput: "", parseError: "No ---REPORT---" }))
      .toMatchObject({ status: "needs_review", publish: true });
  });

  it("keeps partial and needs_review as reported", () => {
    expect(deriveOutcome(ok({ report: report({ status: "partial" }) })).status).toBe("partial");
  });
});

describe("reviewMove", () => {
  const review = { id: "review", name: "In Review" };
  const issue = (over: Partial<Issue> = {}): Issue => ({
    id: "i", identifier: "ENG-1", name: "n", description: "", comments: [], state: "Todo", url: "u", reviewTarget: review, ...over,
  });

  it("moves tickets that finished done or need review", () => {
    expect((["done", "needs_review"] as const).map(s => reviewMove(issue(), s))).toEqual([review, review]);
  });

  it("leaves partial, skipped and errored tickets where they are", () => {
    expect((["partial", "skipped", "error"] as const).map(s => reviewMove(issue(), s))).toEqual([undefined, undefined, undefined]);
  });

  it("has nowhere to move a ticket with no review target", () => {
    expect(reviewMove(issue({ reviewTarget: undefined }), "done")).toBeUndefined();
  });

  it("has nowhere to move a missing issue", () => {
    expect(reviewMove(null, "done")).toBeUndefined();
  });
});
