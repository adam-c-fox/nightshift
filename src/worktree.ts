import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { RepoKind } from "./types.js";

export type Log = (msg: string) => void;

export interface WorktreeSpec {
  repoPath: string;
  worktreesDir: string;
  ticketId: string;
  repo: RepoKind;
  runStamp: string;
}

export interface Worktree {
  wtPath: string;
  branch: string;
  baseRef: string;
  baseBranch: string;
}

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { encoding: "utf-8", cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
}

function stderrOf(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  return err.stderr?.toString().trim() || err.message || String(e);
}

export function branchName(ticketId: string, runStamp: string): string {
  return `night/${ticketId}-${runStamp}`;
}

export function worktreePath(worktreesDir: string, repo: RepoKind, ticketId: string): string {
  return path.join(worktreesDir, `${repo}-${ticketId}`);
}

function resolveBaseRef(repoPath: string, log: Log): string {
  try {
    git(["fetch", "origin"], repoPath);
  } catch (e) {
    log(`  git fetch failed (branching from local refs): ${stderrOf(e)}`);
  }
  const candidates: string[] = [];
  try {
    candidates.push(git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoPath).trim());
  } catch { /* origin/HEAD not set */ }
  candidates.push("origin/main", "main");
  for (const ref of candidates) {
    try {
      git(["rev-parse", "--verify", "--quiet", ref], repoPath);
      return ref;
    } catch { /* try next */ }
  }
  throw new Error(`No base branch found in ${repoPath} (tried ${candidates.join(", ")})`);
}

function isRegisteredWorktree(repoPath: string, wtPath: string): boolean {
  const target = realpathSync(wtPath);
  return git(["worktree", "list", "--porcelain"], repoPath)
    .split("\n")
    .filter(line => line.startsWith("worktree "))
    .some(line => {
      try {
        return realpathSync(line.slice("worktree ".length)) === target;
      } catch {
        return false;
      }
    });
}

function salvageUncommittedWork(wtPath: string, log: Log): void {
  if (git(["status", "--porcelain", ...PATHSPEC], wtPath).trim() === "") return;
  git(["add", "-A", ...PATHSPEC], wtPath);
  git(["commit", "-m", "night: salvaged uncommitted work from interrupted run", ...PATHSPEC], wtPath);
  log(`  Salvaged uncommitted work from interrupted run in ${wtPath}`);
}

function removeStaleWorktree(repoPath: string, worktreesDir: string, wtPath: string, log: Log): void {
  git(["worktree", "prune"], repoPath);
  if (!existsSync(wtPath)) return;
  log(`Cleaning stale worktree: ${wtPath}`);
  if (isRegisteredWorktree(repoPath, wtPath)) salvageUncommittedWork(wtPath, log);
  try {
    git(["worktree", "remove", "--force", wtPath], repoPath);
  } catch {
    const resolved = path.resolve(wtPath);
    if (!resolved.startsWith(path.resolve(worktreesDir) + path.sep)) {
      throw new Error(`Refusing to delete ${resolved}: outside ${worktreesDir}`);
    }
    rmSync(resolved, { recursive: true, force: true });
    git(["worktree", "prune"], repoPath);
  }
}

export function createWorktree(spec: WorktreeSpec, log: Log): Worktree {
  const { repoPath, worktreesDir, ticketId, repo, runStamp } = spec;
  const branch = branchName(ticketId, runStamp);
  const wtPath = worktreePath(worktreesDir, repo, ticketId);

  removeStaleWorktree(repoPath, worktreesDir, wtPath, log);

  const baseRef = resolveBaseRef(repoPath, log);
  git(["worktree", "add", "-B", branch, wtPath, baseRef], repoPath);
  log(`Worktree created: ${wtPath} (branch: ${branch} from ${baseRef})`);

  if (repo === "main") {
    const srcNM = path.join(repoPath, "node_modules");
    const dstNM = path.join(wtPath, "node_modules");
    if (existsSync(srcNM) && !existsSync(dstNM)) {
      symlinkSync(srcNM, dstNM, "dir");
      log(`Symlinked node_modules → ${dstNM}`);
    }
  }

  return { wtPath, branch, baseRef, baseBranch: baseRef.replace(/^origin\//, "") };
}

export const EXCLUDED_PATHS = ["node_modules", "tfplan", "*.tfplan"];
export type CommitOutcome = "committed" | "agent_committed" | "no_changes";

const PATHSPEC = ["--", ".", ...EXCLUDED_PATHS.flatMap(p => [`:(exclude,glob)**/${p}`, `:(exclude,glob)**/${p}/**`])];

function commitsAhead(wt: Worktree): number {
  return Number(git(["rev-list", "--count", `${wt.baseRef}..HEAD`], wt.wtPath).trim());
}

export function commitWorktree(wt: Worktree, ticketId: string, summary: string, log: Log): CommitOutcome {
  const dirty = git(["status", "--porcelain", ...PATHSPEC], wt.wtPath).trim() !== "";
  if (dirty) {
    git(["add", "-A", ...PATHSPEC], wt.wtPath);
    git(["commit", "-m", `night: ${ticketId} – ${summary.slice(0, 120)}`], wt.wtPath);
    log(`Committed: ${wt.branch}`);
    return "committed";
  }
  if (commitsAhead(wt) > 0) {
    log(`Agent already committed on ${wt.branch}`);
    return "agent_committed";
  }
  log(`No changes to commit for ${ticketId}`);
  return "no_changes";
}
