import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { branchName, commitWorktree, createWorktree, excludedPathsInBranch, worktreePath, type WorktreeSpec } from "../src/worktree.js";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function makeRepo(): { root: string; repoPath: string; worktreesDir: string } {
  const root = mkdtempSync(join(tmpdir(), "nightshift-wt-"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const repoPath = join(root, "repo");
  execFileSync("git", ["clone", "-q", origin, repoPath], { stdio: "ignore" });
  run(repoPath, "config", "user.email", "night@test");
  run(repoPath, "config", "user.name", "night");
  writeFileSync(join(repoPath, ".gitignore"), "node_modules/\n*.tfplan\n");
  run(repoPath, "add", "-A");
  run(repoPath, "commit", "-q", "-m", "init");
  run(repoPath, "push", "-q", "origin", "main");
  mkdirSync(join(repoPath, "node_modules"));
  const worktreesDir = join(root, "worktrees");
  mkdirSync(worktreesDir);
  return { root, repoPath, worktreesDir };
}

const noop = () => {};

describe("naming", () => {
  it("makes a unique branch per run", () => {
    expect(branchName("ENG-1", "20261001-2305")).toBe("night/ENG-1-20261001-2305");
  });

  it("namespaces the worktree path by repo", () => {
    expect(worktreePath("/w", "terraform", "INF-7")).toBe("/w/terraform-INF-7");
  });
});

describe("createWorktree", () => {
  let env: ReturnType<typeof makeRepo>;
  let spec: WorktreeSpec;
  beforeEach(() => {
    env = makeRepo();
    spec = { repoPath: env.repoPath, worktreesDir: env.worktreesDir, ticketId: "ENG-1", repo: "main", runStamp: "20261001-2305" };
  });

  it("creates the per-run branch from origin/main and symlinks node_modules", () => {
    const wt = createWorktree(spec, noop);
    expect(wt).toMatchObject({ branch: "night/ENG-1-20261001-2305", baseRef: "origin/main", baseBranch: "main" });
    expect(run(wt.wtPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("night/ENG-1-20261001-2305");
    expect(existsSync(join(wt.wtPath, "node_modules"))).toBe(true);
  });

  it("replaces a worktree left over from a previous run", () => {
    createWorktree(spec, noop);
    const wt = createWorktree({ ...spec, runStamp: "20261002-2305" }, noop);
    expect(run(wt.wtPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("night/ENG-1-20261002-2305");
  });

  it("removes a leftover directory git does not know about", () => {
    const stale = worktreePath(env.worktreesDir, "main", "ENG-1");
    mkdirSync(stale);
    writeFileSync(join(stale, "junk.txt"), "x");
    const wt = createWorktree(spec, noop);
    expect(existsSync(join(wt.wtPath, "junk.txt"))).toBe(false);
    expect(run(wt.wtPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("night/ENG-1-20261001-2305");
  });

  it("salvages uncommitted work from an interrupted run before replacing its worktree", () => {
    const first = createWorktree(spec, noop);
    writeFileSync(join(first.wtPath, "half-done.ts"), "export {};\n");
    createWorktree({ ...spec, runStamp: "20261002-2305" }, noop);
    expect(run(env.repoPath, "log", "-1", "--format=%s", first.branch)).toBe("night: salvaged uncommitted work from interrupted run");
    expect(run(env.repoPath, "show", "--name-only", "--format=", first.branch)).toBe("half-done.ts");
  });

  it("throws on a reused branch name and leaves the first branch untouched", () => {
    const first = createWorktree(spec, noop);
    writeFileSync(join(first.wtPath, "work.txt"), "x");
    run(first.wtPath, "add", "work.txt");
    run(first.wtPath, "commit", "-q", "-m", "wip");
    const tip = run(env.repoPath, "rev-parse", first.branch);
    expect(() => createWorktree(spec, noop)).toThrow();
    expect(run(env.repoPath, "rev-parse", first.branch)).toBe(tip);
  });

  it("keeps the previous run's branch so unpushed work survives", () => {
    const first = createWorktree(spec, noop);
    writeFileSync(join(first.wtPath, "work.txt"), "x");
    run(first.wtPath, "add", "work.txt");
    run(first.wtPath, "commit", "-q", "-m", "wip");
    createWorktree({ ...spec, runStamp: "20261002-2305" }, noop);
    expect(run(env.repoPath, "branch", "--list", "night/ENG-1-20261001-2305")).toContain("night/ENG-1-20261001-2305");
  });
});

describe("commitWorktree", () => {
  let wt: ReturnType<typeof createWorktree>;
  beforeEach(() => {
    const env = makeRepo();
    wt = createWorktree({ repoPath: env.repoPath, worktreesDir: env.worktreesDir, ticketId: "ENG-1", repo: "main", runStamp: "20261001-2305" }, noop);
  });

  const committedFiles = () => run(wt.wtPath, "diff", "--name-only", `${wt.baseRef}..HEAD`).split("\n").filter(Boolean);

  it("reports no changes when only the node_modules symlink exists", () => {
    expect(commitWorktree(wt, "ENG-1", "nothing", noop)).toBe("no_changes");
  });

  it("commits real changes but never node_modules or terraform plan files", () => {
    writeFileSync(join(wt.wtPath, "fix.ts"), "export {};\n");
    writeFileSync(join(wt.wtPath, "tfplan"), "binary");
    expect(commitWorktree(wt, "ENG-1", "fix", noop)).toBe("committed");
    expect(committedFiles()).toEqual(["fix.ts"]);
  });

  it("treats commits the agent made itself as work to publish", () => {
    writeFileSync(join(wt.wtPath, "agent.ts"), "export {};\n");
    run(wt.wtPath, "add", "agent.ts");
    run(wt.wtPath, "commit", "-q", "-m", "agent commit");
    expect(commitWorktree(wt, "ENG-1", "fix", noop)).toBe("agent_committed");
  });

  it("includes both agent commits and leftover uncommitted changes", () => {
    writeFileSync(join(wt.wtPath, "a.ts"), "export {};\n");
    run(wt.wtPath, "add", "a.ts");
    run(wt.wtPath, "commit", "-q", "-m", "agent commit");
    writeFileSync(join(wt.wtPath, "b.ts"), "export {};\n");
    expect(commitWorktree(wt, "ENG-1", "fix", noop)).toBe("committed");
    expect(committedFiles().sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("leaves excluded files untracked in the worktree", () => {
    writeFileSync(join(wt.wtPath, "tfplan"), "binary");
    writeFileSync(join(wt.wtPath, "fix.ts"), "export {};\n");
    commitWorktree(wt, "ENG-1", "fix", noop);
    expect(readFileSync(join(wt.wtPath, "tfplan"), "utf-8")).toBe("binary");
  });

  it("excludes files nested under node_modules and plan paths even without a gitignore", () => {
    writeFileSync(join(wt.wtPath, ".gitignore"), "");
    run(wt.wtPath, "add", ".gitignore");
    run(wt.wtPath, "commit", "-q", "-m", "drop ignores");
    mkdirSync(join(wt.wtPath, "pkg", "node_modules"), { recursive: true });
    mkdirSync(join(wt.wtPath, "infra"), { recursive: true });
    writeFileSync(join(wt.wtPath, "pkg", "node_modules", "x.js"), "x");
    writeFileSync(join(wt.wtPath, "infra", "night.tfplan"), "binary");
    writeFileSync(join(wt.wtPath, "fix.ts"), "export {};\n");
    expect(commitWorktree(wt, "ENG-1", "fix", noop)).toBe("committed");
    expect(run(wt.wtPath, "diff", "--name-only", "HEAD~1..HEAD").split("\n")).toEqual(["fix.ts"]);
  });
});

describe("excludedPathsInBranch", () => {
  let wt: ReturnType<typeof createWorktree>;
  beforeEach(() => {
    const env = makeRepo();
    wt = createWorktree({ repoPath: env.repoPath, worktreesDir: env.worktreesDir, ticketId: "ENG-1", repo: "main", runStamp: "20261001-2305" }, noop);
  });

  it("returns excluded paths the agent committed itself", () => {
    mkdirSync(join(wt.wtPath, "pkg", "node_modules"), { recursive: true });
    mkdirSync(join(wt.wtPath, "infra"), { recursive: true });
    writeFileSync(join(wt.wtPath, "pkg", "node_modules", "x.js"), "x");
    writeFileSync(join(wt.wtPath, "infra", "night.tfplan"), "binary");
    writeFileSync(join(wt.wtPath, "tfplan"), "binary");
    writeFileSync(join(wt.wtPath, "fix.ts"), "export {};\n");
    run(wt.wtPath, "add", "-f", "pkg", "infra", "tfplan", "fix.ts");
    run(wt.wtPath, "commit", "-q", "-m", "agent commit");
    expect(excludedPathsInBranch(wt).sort()).toEqual(["infra/night.tfplan", "pkg/node_modules/x.js", "tfplan"]);
  });

  it("returns nothing when every commit is clean", () => {
    writeFileSync(join(wt.wtPath, "fix.ts"), "export {};\n");
    run(wt.wtPath, "add", "fix.ts");
    run(wt.wtPath, "commit", "-q", "-m", "agent commit");
    expect(excludedPathsInBranch(wt)).toEqual([]);
  });
});
