import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { RepoKind } from "./types.js";

export type Log = (msg: string) => void;

export interface WorktreeSpec {
  repoPath: string;
  worktreesDir: string;
  ticketId: string;
  repo: RepoKind;
  branchBase: string;
  startFrom?: { branch: string; baseBranch: string };
}

export interface Worktree {
  wtPath: string;
  branch: string;
  baseRef: string;
  baseBranch: string;
  startedFromPr: boolean;
}

const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { encoding: "utf-8", cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
}

function stderrOf(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  return err.stderr?.toString().trim() || err.message || String(e);
}

const SLUG_MAX = 32;
const DANGLING_WORDS = new Set(["a", "an", "and", "the", "of", "for", "from", "to", "in", "on", "with", "by"]);

function slugWords(ticketName: string): string[] {
  const words = ticketName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    if ([...kept, word].join("-").length > SLUG_MAX) break;
    kept.push(word);
  }
  while (kept.length > 1 && DANGLING_WORDS.has(kept[kept.length - 1])) kept.pop();
  return kept;
}

export function ticketBranchName(prefix: string | undefined, ticketId: string, ticketName: string): string {
  const name = [ticketId.toLowerCase(), ...slugWords(ticketName)].join("-");
  const cleanPrefix = prefix?.trim().replace(/\/+$/, "");
  return cleanPrefix ? `${cleanPrefix}/${name}` : name;
}

export function chooseBranchName(base: string, exists: (name: string) => boolean): string {
  if (!exists(base)) return base;
  for (let n = 2; ; n++) {
    if (!exists(`${base}-${n}`)) return `${base}-${n}`;
  }
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

function refExists(repoPath: string, ref: string): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", ref], repoPath);
    return true;
  } catch {
    return false;
  }
}

function branchMissingOnRemote(repoPath: string, branch: string): boolean {
  try {
    git(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], repoPath);
    return false;
  } catch (e) {
    return (e as { status?: number }).status === 2;
  }
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

function salvageUncommittedWork(wtPath: string, ticketId: string, log: Log): void {
  if (git(["status", "--porcelain", ...PATHSPEC], wtPath).trim() === "") return;
  git(["add", "-A", ...PATHSPEC], wtPath);
  git([...NO_HOOKS, "commit", "-m", `wip: salvage uncommitted work (${ticketId})`, ...PATHSPEC], wtPath);
  log(`  Salvaged uncommitted work from interrupted run in ${wtPath}`);
}

function removeStaleWorktree(repoPath: string, worktreesDir: string, wtPath: string, ticketId: string, log: Log): void {
  git(["worktree", "prune"], repoPath);
  if (!existsSync(wtPath)) return;
  log(`Cleaning stale worktree: ${wtPath}`);
  if (isRegisteredWorktree(repoPath, wtPath)) salvageUncommittedWork(wtPath, ticketId, log);
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
  const { repoPath, worktreesDir, ticketId, repo, branchBase, startFrom } = spec;
  const wtPath = worktreePath(worktreesDir, repo, ticketId);

  removeStaleWorktree(repoPath, worktreesDir, wtPath, ticketId, log);

  const freshBaseRef = resolveBaseRef(repoPath, log);
  const prRef = startFrom ? `origin/${startFrom.branch}` : null;
  const fallbackCause = prRef === null ? null
    : !refExists(repoPath, prRef) ? "not available locally (fetch failed?)"
    : branchMissingOnRemote(repoPath, startFrom!.branch) ? "deleted on origin"
    : null;
  const startedFromPr = prRef !== null && fallbackCause === null;
  if (startFrom && fallbackCause) {
    log(`  PR branch ${startFrom.branch} no longer on origin; starting fresh from ${freshBaseRef} (${fallbackCause})`);
  }
  const localExists = (name: string) => refExists(repoPath, `refs/heads/${name}`);
  const branch = chooseBranchName(branchBase, startedFromPr ? localExists : name => localExists(name) || !branchMissingOnRemote(repoPath, name));
  const baseRef = startedFromPr ? prRef : freshBaseRef;
  const baseBranch = startedFromPr ? startFrom!.baseBranch : freshBaseRef.replace(/^origin\//, "");
  git(["worktree", "add", "-b", branch, wtPath, baseRef], repoPath);
  log(`Worktree created: ${wtPath} (branch: ${branch} from ${baseRef})`);

  if (repo === "main") {
    const srcNM = path.join(repoPath, "node_modules");
    const dstNM = path.join(wtPath, "node_modules");
    if (existsSync(srcNM) && !existsSync(dstNM)) {
      symlinkSync(srcNM, dstNM, "dir");
      log(`Symlinked node_modules → ${dstNM}`);
    }
  }

  return { wtPath, branch, baseRef, baseBranch, startedFromPr };
}

export const EXCLUDED_PATHS = ["node_modules", "tfplan", "*.tfplan"];
export type CommitOutcome = "committed" | "agent_committed" | "no_changes";

const PATHSPEC = ["--", ".", ...EXCLUDED_PATHS.flatMap(p => [`:(exclude,glob)**/${p}`, `:(exclude,glob)**/${p}/**`])];

function commitsAhead(wt: Worktree): number {
  return Number(git(["rev-list", "--count", `${wt.baseRef}..HEAD`], wt.wtPath).trim());
}

export function commitWorktree(wt: Worktree, subject: string, log: Log): CommitOutcome {
  const dirty = git(["status", "--porcelain", ...PATHSPEC], wt.wtPath).trim() !== "";
  if (dirty) {
    git(["add", "-A", ...PATHSPEC], wt.wtPath);
    git([...NO_HOOKS, "commit", "-m", subject], wt.wtPath);
    log(`Committed: ${wt.branch}`);
    return "committed";
  }
  if (commitsAhead(wt) > 0) {
    log(`Agent already committed on ${wt.branch}`);
    return "agent_committed";
  }
  log(`No changes to commit on ${wt.branch}`);
  return "no_changes";
}

const isExcludedPath = (file: string): boolean =>
  file.split("/").some(segment => segment === "node_modules" || segment === "tfplan" || segment.endsWith(".tfplan"));

export function excludedPathsInBranch(wt: Worktree): string[] {
  return git(["diff", "--name-only", `${wt.baseRef}..HEAD`], wt.wtPath).split("\n").filter(isExcludedPath);
}

export function hasChangesVsBase(wt: Worktree): boolean {
  return git(["status", "--porcelain", ...PATHSPEC], wt.wtPath).trim() !== "" || commitsAhead(wt) > 0;
}

function fileFingerprint(filePath: string): Buffer | string {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) return `link:${readlinkSync(filePath)}`;
  return stat.isFile() ? readFileSync(filePath) : "other";
}

export function worktreeSnapshot(wt: Worktree): string {
  const hash = createHash("sha256");
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z", ...PATHSPEC], wt.wtPath).split("\0").filter(Boolean).sort();
  hash.update(git(["rev-parse", "HEAD"], wt.wtPath));
  hash.update(git(["status", "--porcelain", ...PATHSPEC], wt.wtPath));
  hash.update(git(["diff", "HEAD", ...PATHSPEC], wt.wtPath));
  for (const file of untracked) {
    hash.update(`\0${file}\0`);
    hash.update(fileFingerprint(path.join(wt.wtPath, file)));
  }
  return hash.digest("hex");
}
