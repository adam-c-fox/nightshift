import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { branchName, createWorktree, worktreePath, type WorktreeSpec } from "../src/worktree.js";

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

  it("keeps the previous run's branch so unpushed work survives", () => {
    const first = createWorktree(spec, noop);
    writeFileSync(join(first.wtPath, "work.txt"), "x");
    run(first.wtPath, "add", "work.txt");
    run(first.wtPath, "commit", "-q", "-m", "wip");
    createWorktree({ ...spec, runStamp: "20261002-2305" }, noop);
    expect(run(env.repoPath, "branch", "--list", "night/ENG-1-20261001-2305")).toContain("night/ENG-1-20261001-2305");
  });
});
