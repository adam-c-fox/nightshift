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

  it("calls onStdoutLine per complete line, joining a line split across chunks and flushing a trailing one", async () => {
    const lines: string[] = [];
    const script = "process.stdout.write('one\\ntw'); setTimeout(() => process.stdout.write('o\\nthree'), 50)";
    const r = await runWithWatchdog(node, ["-e", script], { ...base, onStdoutLine: l => lines.push(l) });
    expect(lines).toEqual(["one", "two", "three"]);
    expect(r.stdout).toBe("one\ntwo\nthree");
  });

  it("reports the child pid through onSpawn", async () => {
    let pid = 0;
    await runWithWatchdog(node, ["-e", "process.stdout.write(String(process.pid))"], { ...base, onSpawn: p => { pid = p; } }).then(r => {
      expect(pid).toBe(Number(r.stdout));
    });
  });

  it("kills the process when the signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await runWithWatchdog(node, ["-e", "setTimeout(() => {}, 60000)"], { ...base, signal: controller.signal });
    expect(r.abortReason).toBe("cancelled");
    expect(r.signal).toBe("SIGTERM");
  });

  it("kills at once when the signal is already aborted", async () => {
    const r = await runWithWatchdog(node, ["-e", "setTimeout(() => {}, 60000)"], { ...base, signal: AbortSignal.abort() });
    expect(r.abortReason).toBe("cancelled");
  });
});
