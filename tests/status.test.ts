import { describe, expect, it } from "vitest";
import type { AgentReport, ClaudeResult } from "../src/claude.js";
import { deriveOutcome } from "../src/status.js";

const report = (over: Partial<AgentReport> = {}): AgentReport => ({
  status: "done", summary: "s", filesCreated: [], filesModified: [],
  tests: [{ name: "t", file: "f", result: "pass" }], verifyCommands: [], notes: "", ...over,
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
