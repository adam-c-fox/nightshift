import { describe, expect, it } from "vitest";
import { ExecError, execAsync } from "../src/exec.js";

describe("execAsync", () => {
  it("resolves with stdout", async () => {
    const result = await execAsync(
      "node",
      ["-e", "process.stdout.write('hi')"],
      { timeoutMs: 5000 },
    );
    expect(result.stdout).toBe("hi");
  });

  it("rejects with an ExecError carrying the first stderr line and exit code", async () => {
    const error = await execAsync(
      "node",
      ["-e", "console.error('bad');process.exit(3)"],
      { timeoutMs: 5000 },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ExecError);
    expect(error.message).toBe("bad");
    expect(error.code).toBe(3);
  });
});
