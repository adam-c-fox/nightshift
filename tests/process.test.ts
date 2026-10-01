import { describe, expect, it } from "vitest";
import { runWithWatchdog } from "../src/process.js";

const node = process.execPath;
const base = { cwd: process.cwd(), input: "", timeoutMs: 5000, checkIntervalMs: 20 };

describe("runWithWatchdog", () => {
  it("captures stdout and exit status, feeding stdin", async () => {
    const r = await runWithWatchdog(node, ["-e", "process.stdin.pipe(process.stdout)"], { ...base, input: "hello" });
    expect(r).toMatchObject({ stdout: "hello", status: 0 });
    expect(r.abortReason).toBeUndefined();
  });

  it("kills the process when shouldAbort returns a reason", async () => {
    let checks = 0;
    const r = await runWithWatchdog(node, ["-e", "setTimeout(() => {}, 60000)"], {
      ...base, shouldAbort: () => (++checks >= 2 ? "budget cap reached" : undefined),
    });
    expect(r.abortReason).toBe("budget cap reached");
    expect(r.signal).toBe("SIGTERM");
  });

  it("kills the process on timeout", async () => {
    const r = await runWithWatchdog(node, ["-e", "setTimeout(() => {}, 60000)"], { ...base, timeoutMs: 100 });
    expect(r.abortReason).toMatch(/timed out/);
  });

  it("reports a missing binary as an error, not a hang", async () => {
    const r = await runWithWatchdog("definitely-not-a-binary-xyz", [], base);
    expect(r.error?.message).toMatch(/ENOENT/);
  });
});
