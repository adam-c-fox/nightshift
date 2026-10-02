import { describe, expect, it } from "vitest";
import { startTestDb, type ScriptExec } from "../src/test-db.js";

const URL = "postgresql://nightshift_example:nightshift_example@127.0.0.1:55433/nightshift_example_test";

const harness = (exec?: ScriptExec) => {
  const calls: string[][] = [];
  const logged: string[] = [];
  const env: NodeJS.ProcessEnv = {};
  const run: ScriptExec = exec ?? (() => `${URL}\n`);
  const wrapped: ScriptExec = (cmd, args, timeout) => { calls.push([cmd, ...args]); return run(cmd, args, timeout); };
  return { calls, logged, env, start: () => startTestDb(m => logged.push(m), wrapped, env, "/s/test-db.sh") };
};

describe("startTestDb", () => {
  it("runs the script, exports the URL and logs it", () => {
    const { calls, logged, env, start } = harness();
    const db = start();
    expect(calls).toEqual([["/s/test-db.sh", "up"]]);
    expect(db?.url).toBe(URL);
    expect(env.TEST_DATABASE_URL).toBe(URL);
    expect(logged.join("\n")).toContain(URL);
  });

  it("stops the database with the down subcommand", () => {
    const { calls, start } = harness();
    start()!.stop();
    expect(calls[1]).toEqual(["/s/test-db.sh", "down"]);
  });

  it("carries on without a URL when the script fails", () => {
    const { logged, env, start } = harness(() => { throw new Error("docker: command not found\nmore"); });
    expect(start()).toBeUndefined();
    expect(env.TEST_DATABASE_URL).toBeUndefined();
    expect(logged.join("\n")).toMatch(/docker: command not found/);
  });

  it("carries on when the script prints nothing", () => {
    const { env, start } = harness(() => "\n");
    expect(start()).toBeUndefined();
    expect(env.TEST_DATABASE_URL).toBeUndefined();
  });

  it("does not throw when stopping fails", () => {
    let n = 0;
    const { logged, start } = harness(() => { if (n++ > 0) throw new Error("boom"); return URL; });
    expect(() => start()!.stop()).not.toThrow();
    expect(logged.join("\n")).toMatch(/Could not stop/);
  });
});
