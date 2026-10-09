import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { pushBranch } from "../src/pr.js";
import { chooseBranchName, commitWorktree, createWorktree, excludedPathsInBranch, hasChangesVsBase, ticketBranchName, worktreeSnapshot, worktreePath, type WorktreeSpec } from "../src/worktree.js";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function makeRepo(): { root: string; repoPath: string } {
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
  return { root, repoPath };
}

const noop = () => {};
const noInstall = () => {};

describe("naming", () => {
  it("builds prefix/id-slug like a hand-made branch", () => {
    expect(ticketBranchName("adamfox", "DEMO-500", "Export runs: schema & store!")).toBe("adamfox/demo-500-export-runs-schema-store");
  });

  it("cuts the slug at a word boundary and drops dangling small words", () => {
    expect(ticketBranchName("adamfox", "DEMO-503", "export-generation: document path from download to upload"))
      .toBe("adamfox/demo-503-export-generation-document-path");
  });

  it("omits the prefix when none is configured", () => {
    expect(ticketBranchName(undefined, "ENG-1", "  --Fix CSV export--  ")).toBe("eng-1-fix-csv-export");
  });

  it("keeps the id alone when the name has no usable characters", () => {
    expect(ticketBranchName("adamfox", "ENG-1", "???")).toBe("adamfox/eng-1");
  });

  it("chooses the first free numbered name when the base is taken", () => {
    expect(chooseBranchName("a/b", () => false)).toBe("a/b");
    expect(chooseBranchName("a/b", n => n === "a/b")).toBe("a/b-2");
    expect(chooseBranchName("a/b", n => ["a/b", "a/b-2", "a/b-3"].includes(n))).toBe("a/b-4");
  });

  it("puts the worktree beside the repo, suffixed with the ticket id", () => {
    expect(worktreePath("/dev/project/infra", "INF-7")).toBe("/dev/project/infra-INF-7");
  });
});

describe("createWorktree", () => {
  let env: ReturnType<typeof makeRepo>;
  let spec: WorktreeSpec;
  beforeEach(() => {
    env = makeRepo();
    spec = { repoPath: env.repoPath, ticketId: "ENG-1", toolchain: "node", branchBase: "adamfox/eng-1-fix" };
  });

  it("creates the ticket branch from origin/main and installs instead of symlinking node_modules", () => {
    const installed: string[] = [];
    const wt = createWorktree(spec, noop, p => installed.push(p));
    expect(wt).toMatchObject({ branch: "adamfox/eng-1-fix", baseRef: "origin/main", baseBranch: "main" });
    expect(run(wt.wtPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("adamfox/eng-1-fix");
    expect(installed).toEqual([wt.wtPath]);
    expect(existsSync(join(wt.wtPath, "node_modules"))).toBe(false);
  });

  it("aborts when the install fails", () => {
    const failing = () => { throw Object.assign(new Error("x"), { stderr: "ERESOLVE boom" }); };
    expect(() => createWorktree(spec, noop, failing)).toThrow(/npm ci failed.*ERESOLVE boom/);
  });

  it("does not install for terraform", () => {
    const installed: string[] = [];
    createWorktree({ ...spec, toolchain: "terraform" }, noop, p => installed.push(p));
    expect(installed).toEqual([]);
  });

  it("replaces a worktree left over from a previous run on the next free branch", () => {
    createWorktree(spec, noop, noInstall);
    const wt = createWorktree(spec, noop, noInstall);
    expect(run(wt.wtPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("adamfox/eng-1-fix-2");
  });

  it("creates the worktree beside the repo", () => {
    const wt = createWorktree(spec, noop, noInstall);
    expect(wt.wtPath).toBe(`${env.repoPath}-ENG-1`);
  });

  it("removes a leftover worktree directory whose git metadata is gone", () => {
    const first = createWorktree(spec, noop, noInstall);
    rmSync(join(env.repoPath, ".git", "worktrees"), { recursive: true, force: true });
    writeFileSync(join(first.wtPath, "junk.txt"), "x");
    const wt = createWorktree(spec, noop, noInstall);
    expect(existsSync(join(wt.wtPath, "junk.txt"))).toBe(false);
  });

  it("refuses to delete a directory at the worktree path that is not one of the repo's worktrees", () => {
    const unrelated = worktreePath(env.repoPath, "ENG-1");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "mine.txt"), "x");
    expect(() => createWorktree(spec, noop, noInstall)).toThrow(/Refusing to delete/);
    expect(readFileSync(join(unrelated, "mine.txt"), "utf-8")).toBe("x");
  });

  it("salvages uncommitted work from an interrupted run before replacing its worktree", () => {
    const first = createWorktree(spec, noop, noInstall);
    writeFileSync(join(first.wtPath, "half-done.ts"), "export {};\n");
    createWorktree(spec, noop, noInstall);
    expect(run(env.repoPath, "log", "-1", "--format=%s", first.branch)).toBe("wip: salvage uncommitted work (ENG-1)");
    expect(run(env.repoPath, "show", "--name-only", "--format=", first.branch)).toBe("half-done.ts");
  });

  it("never resets a surviving branch: the next run gets a numbered one and the first keeps its tip", () => {
    const first = createWorktree(spec, noop, noInstall);
    writeFileSync(join(first.wtPath, "work.txt"), "x");
    run(first.wtPath, "add", "work.txt");
    run(first.wtPath, "commit", "-q", "-m", "wip");
    const tip = run(env.repoPath, "rev-parse", first.branch);
    const second = createWorktree(spec, noop, noInstall);
    expect(second.branch).toBe("adamfox/eng-1-fix-2");
    expect(run(env.repoPath, "rev-parse", first.branch)).toBe(tip);
  });

  it("skips a name that exists on origin only", () => {
    run(env.repoPath, "push", "-q", "origin", "main:refs/heads/adamfox/eng-1-fix");
    run(env.repoPath, "push", "-q", "origin", "main:refs/heads/adamfox/eng-1-fix-2");
    expect(createWorktree(spec, noop, noInstall).branch).toBe("adamfox/eng-1-fix-3");
  });
});

describe("commitWorktree", () => {
  let wt: ReturnType<typeof createWorktree>;
  beforeEach(() => {
    const env = makeRepo();
    wt = createWorktree({ repoPath: env.repoPath, ticketId: "ENG-1", toolchain: "node", branchBase: "adamfox/eng-1-fix" }, noop, noInstall);
  });

  const committedFiles = () => run(wt.wtPath, "diff", "--name-only", `${wt.baseRef}..HEAD`).split("\n").filter(Boolean);

  it("uses the given subject as the commit message", () => {
    writeFileSync(join(wt.wtPath, "fix.ts"), "export {};\n");
    commitWorktree(wt, "fix: handle empty rows (ENG-1)", noop);
    expect(run(wt.wtPath, "log", "-1", "--format=%B")).toBe("fix: handle empty rows (ENG-1)");
  });

  it("reports no changes when nothing was changed", () => {
    expect(commitWorktree(wt, "nothing", noop)).toBe("no_changes");
  });

  it("commits real changes but never node_modules or terraform plan files", () => {
    writeFileSync(join(wt.wtPath, "fix.ts"), "export {};\n");
    writeFileSync(join(wt.wtPath, "tfplan"), "binary");
    expect(commitWorktree(wt, "fix", noop)).toBe("committed");
    expect(committedFiles()).toEqual(["fix.ts"]);
  });

  it("does not run repo hooks when committing", () => {
    const marker = join(wt.wtPath, "..", "hook-ran");
    const hook = join(run(wt.wtPath, "rev-parse", "--git-common-dir"), "hooks", "pre-commit");
    mkdirSync(join(hook, ".."), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(wt.wtPath, "fix.ts"), "export {};\n");
    expect(commitWorktree(wt, "fix", noop)).toBe("committed");
    expect(existsSync(marker)).toBe(false);
  });

  it("treats commits the agent made itself as work to publish", () => {
    writeFileSync(join(wt.wtPath, "agent.ts"), "export {};\n");
    run(wt.wtPath, "add", "agent.ts");
    run(wt.wtPath, "commit", "-q", "-m", "agent commit");
    expect(commitWorktree(wt, "fix", noop)).toBe("agent_committed");
  });

  it("includes both agent commits and leftover uncommitted changes", () => {
    writeFileSync(join(wt.wtPath, "a.ts"), "export {};\n");
    run(wt.wtPath, "add", "a.ts");
    run(wt.wtPath, "commit", "-q", "-m", "agent commit");
    writeFileSync(join(wt.wtPath, "b.ts"), "export {};\n");
    expect(commitWorktree(wt, "fix", noop)).toBe("committed");
    expect(committedFiles().sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("leaves excluded files untracked in the worktree", () => {
    writeFileSync(join(wt.wtPath, "tfplan"), "binary");
    writeFileSync(join(wt.wtPath, "fix.ts"), "export {};\n");
    commitWorktree(wt, "fix", noop);
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
    expect(commitWorktree(wt, "fix", noop)).toBe("committed");
    expect(run(wt.wtPath, "diff", "--name-only", "HEAD~1..HEAD").split("\n")).toEqual(["fix.ts"]);
  });
});

describe("excludedPathsInBranch", () => {
  let wt: ReturnType<typeof createWorktree>;
  beforeEach(() => {
    const env = makeRepo();
    wt = createWorktree({ repoPath: env.repoPath, ticketId: "ENG-1", toolchain: "node", branchBase: "adamfox/eng-1-fix" }, noop, noInstall);
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

describe("createWorktree stackedOn", () => {
  const parent = "adamfox/eng-1-parent";
  let env: ReturnType<typeof makeRepo>;
  let spec: WorktreeSpec;
  beforeEach(() => {
    env = makeRepo();
    spec = { repoPath: env.repoPath, ticketId: "ENG-2", toolchain: "node", branchBase: "adamfox/eng-2-child" };
  });

  const pushParent = () => {
    run(env.repoPath, "checkout", "-q", "-b", parent);
    writeFileSync(join(env.repoPath, "parent.ts"), "export {};\n");
    run(env.repoPath, "add", "parent.ts");
    run(env.repoPath, "commit", "-q", "-m", "parent work");
    run(env.repoPath, "push", "-q", "origin", parent);
    run(env.repoPath, "checkout", "-q", "main");
  };

  it("branches from the parent branch and targets it", () => {
    pushParent();
    const wt = createWorktree({ ...spec, stackedOn: parent }, noop, noInstall);
    expect(existsSync(join(wt.wtPath, "parent.ts"))).toBe(true);
    expect(wt).toMatchObject({ baseRef: `origin/${parent}`, baseBranch: parent, startedFromPr: false, branch: "adamfox/eng-2-child" });
    expect(commitWorktree(wt, "nothing", noop)).toBe("no_changes");
  });

  it("throws instead of falling back to main when the parent branch is missing", () => {
    expect(() => createWorktree({ ...spec, stackedOn: parent }, noop, noInstall)).toThrow(parent);
  });

  it("keeps resuming an existing PR branch over the stack base", () => {
    pushParent();
    run(env.repoPath, "push", "-q", "origin", `main:refs/heads/${spec.branchBase}`);
    const wt = createWorktree({ ...spec, stackedOn: parent, startFrom: { branch: spec.branchBase, baseBranch: parent } }, noop, noInstall);
    expect(wt).toMatchObject({ baseRef: `origin/${spec.branchBase}`, baseBranch: parent, startedFromPr: true });
  });
});

describe("createWorktree startFrom", () => {
  const prBranch = "adamfox/eng-1-fix";
  let env: ReturnType<typeof makeRepo>;
  let spec: WorktreeSpec;
  beforeEach(() => {
    env = makeRepo();
    spec = { repoPath: env.repoPath, ticketId: "ENG-1", toolchain: "node", branchBase: "adamfox/eng-1-fix" };
  });

  const pushPrBranch = () => {
    run(env.repoPath, "checkout", "-q", "-b", prBranch);
    writeFileSync(join(env.repoPath, "prev.ts"), "export {};\n");
    run(env.repoPath, "add", "prev.ts");
    run(env.repoPath, "commit", "-q", "-m", "previous run");
    run(env.repoPath, "push", "-q", "origin", prBranch);
    run(env.repoPath, "checkout", "-q", "main");
  };

  it("starts from the PR branch, counts only new commits and avoids the local branch of the same name", () => {
    pushPrBranch();
    const wt = createWorktree({ ...spec, startFrom: { branch: prBranch, baseBranch: "main" } }, noop, noInstall);
    expect(existsSync(join(wt.wtPath, "prev.ts"))).toBe(true);
    expect(wt).toMatchObject({ baseRef: `origin/${prBranch}`, baseBranch: "main", startedFromPr: true, branch: `${prBranch}-2` });
    expect(commitWorktree(wt, "nothing", noop)).toBe("no_changes");
  });

  it("falls back to origin/main when the PR branch is gone", () => {
    const logs: string[] = [];
    const wt = createWorktree({ ...spec, startFrom: { branch: prBranch, baseBranch: "main" } }, m => logs.push(m), noInstall);
    expect(wt).toMatchObject({ baseRef: "origin/main", baseBranch: "main", startedFromPr: false });
    expect(existsSync(join(wt.wtPath, "prev.ts"))).toBe(false);
    expect(logs.some(l => l.includes(`PR branch ${prBranch} no longer on origin; starting fresh from origin/main (not available locally (fetch failed?))`))).toBe(true);
  });

  it("falls back when the PR branch was deleted on origin but a stale tracking ref remains", () => {
    pushPrBranch();
    run(env.repoPath, "fetch", "-q", "origin");
    run(join(env.root, "origin.git"), "branch", "-D", prBranch);
    expect(run(env.repoPath, "rev-parse", "--verify", `origin/${prBranch}`)).not.toBe("");
    const logs: string[] = [];
    const wt = createWorktree({ ...spec, startFrom: { branch: prBranch, baseBranch: "main" } }, m => logs.push(m), noInstall);
    expect(wt).toMatchObject({ baseRef: "origin/main", startedFromPr: false });
    expect(existsSync(join(wt.wtPath, "prev.ts"))).toBe(false);
    expect(logs.some(l => l.includes(`PR branch ${prBranch} no longer on origin; starting fresh from origin/main (deleted on origin)`))).toBe(true);
  });

  it("does not mistake a differently-prefixed remote branch for the PR branch", () => {
    pushPrBranch();
    run(env.repoPath, "fetch", "-q", "origin");
    const origin = join(env.root, "origin.git");
    run(origin, "branch", "-m", prBranch, `other/${prBranch}`);
    const wt = createWorktree({ ...spec, startFrom: { branch: prBranch, baseBranch: "main" } }, noop, noInstall);
    expect(wt.startedFromPr).toBe(false);
  });

  it("is not started from a PR without startFrom", () => {
    expect(createWorktree(spec, noop, noInstall).startedFromPr).toBe(false);
  });

  it("fast-forwards the remote PR branch and rejects a non-fast-forward push", () => {
    pushPrBranch();
    const wt = createWorktree({ ...spec, startFrom: { branch: prBranch, baseBranch: "main" } }, noop, noInstall);
    writeFileSync(join(wt.wtPath, "tonight.ts"), "export {};\n");
    expect(commitWorktree(wt, "tonight", noop)).toBe("committed");
    pushBranch(wt.wtPath, wt.branch, prBranch);
    const origin = join(env.root, "origin.git");
    expect(run(origin, "rev-parse", prBranch)).toBe(run(wt.wtPath, "rev-parse", "HEAD"));

    run(env.repoPath, "checkout", "-q", "-b", "other", "main");
    writeFileSync(join(env.repoPath, "other.ts"), "export {};\n");
    run(env.repoPath, "add", "other.ts");
    run(env.repoPath, "commit", "-q", "-m", "unrelated");
    run(env.repoPath, "push", "-q", "--force", "origin", `other:${prBranch}`);
    writeFileSync(join(wt.wtPath, "more.ts"), "export {};\n");
    commitWorktree(wt, "more", noop);
    expect(() => pushBranch(wt.wtPath, wt.branch, prBranch)).toThrow();
  });
});

describe("worktreeSnapshot and hasChangesVsBase", () => {
  let wt: ReturnType<typeof createWorktree>;
  beforeEach(() => {
    const env = makeRepo();
    wt = createWorktree({ repoPath: env.repoPath, ticketId: "ENG-1", toolchain: "node", branchBase: "adamfox/eng-1-fix" }, noop, noInstall);
  });

  it("is stable while nothing changes", () => {
    expect(worktreeSnapshot(wt)).toBe(worktreeSnapshot(wt));
  });

  it("changes when an untracked file is added or its content edited", () => {
    const clean = worktreeSnapshot(wt);
    writeFileSync(join(wt.wtPath, "new.ts"), "a");
    const added = worktreeSnapshot(wt);
    writeFileSync(join(wt.wtPath, "new.ts"), "b");
    const edited = worktreeSnapshot(wt);
    expect(new Set([clean, added, edited]).size).toBe(3);
  });

  it("changes when a tracked file is edited again after it was already dirty", () => {
    writeFileSync(join(wt.wtPath, ".gitignore"), "node_modules/\nx\n");
    const first = worktreeSnapshot(wt);
    writeFileSync(join(wt.wtPath, ".gitignore"), "node_modules/\ny\n");
    expect(worktreeSnapshot(wt)).not.toBe(first);
  });

  it("ignores node_modules", () => {
    const clean = worktreeSnapshot(wt);
    mkdirSync(join(wt.wtPath, "node_modules"));
    writeFileSync(join(wt.wtPath, "node_modules", "pkg.js"), "x");
    expect(worktreeSnapshot(wt)).toBe(clean);
  });

  it("changes when HEAD moves", () => {
    const clean = worktreeSnapshot(wt);
    run(wt.wtPath, "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "x");
    expect(worktreeSnapshot(wt)).not.toBe(clean);
  });

  it("reports changes vs base for uncommitted work and for commits, not for a clean tree", () => {
    expect(hasChangesVsBase(wt)).toBe(false);
    writeFileSync(join(wt.wtPath, "new.ts"), "a");
    expect(hasChangesVsBase(wt)).toBe(true);
    run(wt.wtPath, "add", "new.ts");
    run(wt.wtPath, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "x");
    expect(hasChangesVsBase(wt)).toBe(true);
  });
});
