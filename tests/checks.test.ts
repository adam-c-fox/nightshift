import { describe, expect, it } from "vitest";
import {
  checkCommands, classifyChecks, discoverWorkspaces, firstFailingLine, regressionFindings, runChecks,
  type CheckExec, type CheckResult,
} from "../src/checks.js";

const result = (command: string, passed: boolean, outputTail = ""): CheckResult =>
  ({ name: command, command, passed, durationSec: 1, outputTail });

describe("checkCommands", () => {
  it("lists the CI commands and one test run per workspace for main", () => {
    const commands = checkCommands("main", ["services/a", "packages/b"]).map(c => c.command);
    expect(commands).toEqual([
      "npm run build", "npm run typecheck", "npm run lint", "npm run format", "npx vitest run",
      "npm test -w services/a", "npm test -w packages/b",
    ]);
  });

  it("lists init, validate and fmt for terraform and ignores workspaces", () => {
    expect(checkCommands("terraform", ["x"]).map(c => c.command)).toEqual([
      "terraform init -backend=false", "terraform validate", "terraform fmt -check -recursive",
    ]);
  });
});

describe("discoverWorkspaces", () => {
  it("reads locations from npm query output", () => {
    expect(discoverWorkspaces("/w", () => JSON.stringify([{ name: "a", location: "services/a" }, { name: "b", location: "packages/b" }])))
      .toEqual(["services/a", "packages/b"]);
  });

  it("returns none when the query fails or prints junk", () => {
    expect(discoverWorkspaces("/w", () => { throw new Error("npm broke"); })).toEqual([]);
    expect(discoverWorkspaces("/w", () => "not json")).toEqual([]);
  });
});

describe("runChecks", () => {
  const env = { PATH: "/bin" };

  it("records pass and fail per command and keeps going after a failure", async () => {
    const seen: string[] = [];
    const exec: CheckExec = async (command, options) => {
      seen.push(`${command}@${options.cwd}`);
      expect(options.env).toBe(env);
      return command === "b" ? { status: 1, output: "boom" } : { status: 0, output: "ok" };
    };
    const results = await runChecks("/w", [{ name: "A", command: "a" }, { name: "B", command: "b" }, { name: "C", command: "c" }], env, exec);
    expect(seen).toEqual(["a@/w", "b@/w", "c@/w"]);
    expect(results.map(r => [r.name, r.command, r.passed])).toEqual([["A", "a", true], ["B", "b", false], ["C", "c", true]]);
    expect(results[1].outputTail).toBe("boom");
  });

  it("treats a missing exit status (timeout or spawn error) as failed", async () => {
    const [r] = await runChecks("/w", [{ name: "A", command: "a" }], env, async () => ({ status: null, output: "" }));
    expect(r.passed).toBe(false);
  });

  it("keeps only the last 80 lines of output", async () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const [r] = await runChecks("/w", [{ name: "A", command: "a" }], env, async () => ({ status: 1, output }));
    const lines = r.outputTail.split("\n");
    expect(lines).toHaveLength(80);
    expect(lines[0]).toBe("line 121");
    expect(lines[79]).toBe("line 200");
  });

  it("passes a timeout to every command", async () => {
    const timeouts: number[] = [];
    await runChecks("/w", [{ name: "A", command: "a" }], env, async (_c, o) => { timeouts.push(o.timeoutMs); return { status: 0, output: "" }; });
    expect(timeouts).toEqual([15 * 60 * 1000]);
  });
});

describe("classifyChecks", () => {
  it("separates regressions, pre-existing failures, passes and new checks", () => {
    const baseline = [result("a", true), result("b", true), result("c", false), result("d", false)];
    const after = [result("a", true), result("b", false), result("c", false), result("d", true), result("e", false)];
    expect(classifyChecks(baseline, after).map(c => [c.command, c.status])).toEqual([
      ["a", "passed"], ["b", "regression"], ["c", "pre-existing"], ["d", "passed"], ["e", "new"],
    ]);
  });
});

describe("regressionFindings", () => {
  const classified = classifyChecks(
    [result("npm run lint", true), result("npm test -w services/a", true), result("npm run build", false)],
    [
      result("npm run lint", false, "src/a.ts\n  3:1  error  Unexpected any\n1 problem"),
      result("npm test -w services/a", false, "FAIL tests/poll.test.ts > retries\nAssertionError"),
      result("npm run build", false, "error TS1"),
    ],
  );

  it("makes a blocker finding per regression with sequential C ids", () => {
    const findings = regressionFindings(classified);
    expect(findings).toEqual([
      {
        id: "C1", severity: "blocker", file: ".",
        issue: "npm run lint fails after the change (passed before it): 3:1  error  Unexpected any",
        suggestion: "Make npm run lint pass again.",
      },
      {
        id: "C2", severity: "blocker", file: "services/a",
        issue: "npm test -w services/a fails after the change (passed before it): FAIL tests/poll.test.ts > retries",
        suggestion: "Make npm test -w services/a pass again.",
      },
    ]);
  });

  it("produces nothing when no check regressed", () => {
    expect(regressionFindings(classifyChecks([result("a", false)], [result("a", false)]))).toEqual([]);
  });
});

describe("firstFailingLine", () => {
  it("falls back to the last line when nothing looks like a failure", () => {
    expect(firstFailingLine("one\ntwo\n")).toBe("two");
    expect(firstFailingLine("")).toBe("");
  });
});
