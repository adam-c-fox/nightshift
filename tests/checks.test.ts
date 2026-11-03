import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyChecks, didNotRun, firstFailingLine, regressionFindings, repoCheckCommands, repoSetupCommands, runChecks,
  type CheckExec, type CheckResult,
} from "../src/checks.js";
import type { RepoConfig } from "../src/project.js";

const result = (command: string, passed: boolean, outputTail = ""): CheckResult =>
  ({ name: command, command, passed, durationSec: 1, outputTail });

describe("repoCheckCommands and repoSetupCommands", () => {
  const roots: string[] = [];
  const project = (files: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "nightshift-in-"));
    roots.push(root);
    for (const f of files) {
      mkdirSync(join(root, dirname(f)), { recursive: true });
      writeFileSync(join(root, f), "");
    }
    return root;
  };
  const repo = (checks: RepoConfig["checks"], setup: RepoConfig["setup"] = []): RepoConfig =>
    ({ path: "/r", description: "", setup, checks, network: [], allowLocalBinding: false, tools: [] });
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  it("keeps a check without in as one command at the worktree root", () => {
    expect(repoCheckCommands(repo([{ name: "lint", command: "make lint" }]), "/w")).toEqual([{ name: "lint", command: "make lint" }]);
  });

  it("expands in to one command per matching directory, sorted", () => {
    const root = project(["env/prod/main.tf", "env/dev/main.tf", "env/dev/vars.tf", "README.md"]);
    expect(repoCheckCommands(repo([{ name: "validate", command: "make validate", in: ["env/*/main.tf"] }]), root)).toEqual([
      { name: "validate (env/dev)", command: "make validate", cwd: "env/dev" },
      { name: "validate (env/prod)", command: "make validate", cwd: "env/prod" },
    ]);
  });

  it("merges several globs and dedupes directories", () => {
    const root = project(["services/a/package.json", "packages/b/package.json", "packages/b/other.json"]);
    const commands = repoCheckCommands(repo([{ name: "t", command: "npm test", in: ["services/*/package.json", "packages/*/*.json"] }]), root);
    expect(commands.map(c => c.cwd)).toEqual(["packages/b", "services/a"]);
  });

  it("skips node_modules, .git and .terraform segments", () => {
    const root = project(["env/dev/main.tf", "node_modules/p/main.tf", ".git/hooks/a.tf", "env/dev/.terraform/modules/y/main.tf"]);
    expect(repoCheckCommands(repo([{ name: "v", command: "x", in: ["**/*.tf"] }]), root).map(c => c.cwd)).toEqual(["env/dev"]);
  });

  it("runs in the worktree root when the glob matches a root file", () => {
    const root = project(["package.json"]);
    expect(repoCheckCommands(repo([{ name: "t", command: "x", in: ["package.json"] }]), root)).toEqual([{ name: "t (.)", command: "x", cwd: "." }]);
  });

  it("throws naming the check and glob when nothing matches", () => {
    const root = project(["README.md"]);
    expect(() => repoCheckCommands(repo([{ name: "validate", command: "x", in: ["env/*/main.tf"] }]), root))
      .toThrow(`check "validate": "env/*/main.tf" matched nothing in ${root}`);
  });

  it("expands setup the same way, naming each step by its command", () => {
    const root = project(["a/package.json", "b/package.json"]);
    expect(repoSetupCommands(repo([], [{ command: "npm ci" }, { command: "npm i", in: ["*/package.json"] }]), root)).toEqual([
      { name: "npm ci", command: "npm ci" },
      { name: "npm i (a)", command: "npm i", cwd: "a" },
      { name: "npm i (b)", command: "npm i", cwd: "b" },
    ]);
  });

  it("throws for a setup glob that matches nothing", () => {
    const root = project([]);
    expect(() => repoSetupCommands(repo([], [{ command: "npm ci", in: ["x/package.json"] }]), root))
      .toThrow(`setup "npm ci": "x/package.json" matched nothing in ${root}`);
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

  it("runs a command in its subdirectory and records it on the result", async () => {
    const cwds: string[] = [];
    const results = await runChecks("/w", [{ name: "A (x/y)", command: "a", cwd: "x/y" }, { name: "B", command: "b" }], env, async (_c, o) => { cwds.push(o.cwd); return { status: 0, output: "" }; });
    expect(cwds).toEqual(["/w/x/y", "/w"]);
    expect(results.map(r => r.cwd)).toEqual(["x/y", undefined]);
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

  const timed = (command: string, passed: boolean, durationSec: number, outputTail = ""): CheckResult => ({ ...result(command, passed, outputTail), durationSec });

  it("marks a check that failed in 0s on both sides as not-run, not pre-existing", () => {
    expect(classifyChecks([timed("a", false, 0)], [timed("a", false, 0)])[0].status).toBe("not-run");
  });

  it("keeps a slow failure with real assertion output as pre-existing", () => {
    const output = "FAIL tests/poll.test.ts\nAssertionError: expected 1 to be 2";
    expect(classifyChecks([timed("a", false, 40, output)], [timed("a", false, 40, output)])[0].status).toBe("pre-existing");
  });

  it("marks a check whose output shows it never started as not-run", () => {
    expect(classifyChecks([timed("a", false, 3, "npm error No workspaces found")], [timed("a", false, 3, "npm error No workspaces found")])[0].status).toBe("not-run");
  });

  it("marks a new check that did not run as not-run", () => {
    expect(classifyChecks([], [timed("a", false, 0)])[0].status).toBe("not-run");
  });

  it("keeps a check the change stopped from starting as a regression", () => {
    expect(classifyChecks([timed("a", true, 5)], [timed("a", false, 0)])[0].status).toBe("regression");
  });

  it("keeps a pass as passed even when it failed to start on the base", () => {
    expect(classifyChecks([timed("a", false, 0)], [timed("a", true, 5)])[0].status).toBe("passed");
  });
});

describe("classifyChecks by directory", () => {
  const at = (cwd: string, passed: boolean): CheckResult => ({ ...result("npm test", passed), name: `tests (${cwd})`, cwd });

  it("matches the same command in different directories separately", () => {
    const statuses = classifyChecks([at("a", true), at("b", false)], [at("a", false), at("b", false)]).map(c => [c.cwd, c.status]);
    expect(statuses).toEqual([["a", "regression"], ["b", "pre-existing"]]);
  });
});

describe("didNotRun", () => {
  const fails = (outputTail: string, durationSec = 5): CheckResult => ({ ...result("a", false, outputTail), durationSec });

  it.each([
    "npm error No workspaces found:\n  --workspace=services/x",
    "npm error Missing script: \"test\"",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/w/vitest.config.ts'",
    "sh: vitest: command not found",
    "Error: spawn npm ENOENT",
  ])("recognises never-started output: %s", output => expect(didNotRun(fails(output))).toBe(true));

  it.each([
    "FAIL tests/a.test.ts > parses\nAssertionError: expected 'x' to be 'y'",
    "Error: Cannot find module './missing.js' imported from tests/a.test.ts",
    "Error: ENOENT: no such file or directory, open 'fixtures/a.json'",
    "1 failed | 12 passed",
  ])("does not treat ordinary failure output as never-started: %s", output => expect(didNotRun(fails(output))).toBe(false));

  it("treats a failure in 0s as not run and never a pass", () => {
    expect(didNotRun(fails("", 0))).toBe(true);
    expect(didNotRun({ ...result("a", true), durationSec: 0 })).toBe(false);
  });
});

describe("regressionFindings", () => {
  const classified = classifyChecks(
    [result("npm run lint", true), { ...result("npm test", true), cwd: "services/a" }, result("npm run build", false)],
    [
      result("npm run lint", false, "src/a.ts\n  3:1  error  Unexpected any\n1 problem"),
      { ...result("npm test", false, "FAIL tests/poll.test.ts > retries\nAssertionError"), cwd: "services/a" },
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
        issue: "npm test fails after the change (passed before it): FAIL tests/poll.test.ts > retries",
        suggestion: "Make npm test pass again.",
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
