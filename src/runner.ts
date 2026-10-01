import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { Ticket, TicketResult, SessionResult, LinearTicket, RepoKind } from "./types.js";
import { loadTickets } from "./tickets.js";
import { startNightBudget, checkGate, budgetGateMessage } from "./budget.js";
import { fetchTicket } from "./linear.js";
import { runAgent } from "./claude.js";
import { createAndCheckPR } from "./pr.js";
import { writeReport } from "./report.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKTREES_DIR = path.join(ROOT, "worktrees");
const LOGS_DIR = path.join(ROOT, "logs");

const REPOS: Record<string, string> = {
  main: "/path/to/app",
  terraform: "/path/to/infra",
};

const DRY_RUN = process.argv.includes("--dry-run");

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    appendFileSync(path.join(LOGS_DIR, `nightshift-${today}.log`), line + "\n");
  } catch { /* best effort */ }
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { encoding: "utf-8", cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
}

function errorMessage(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  const stderr = err.stderr?.toString().trim();
  return stderr ? `${err.message}\n${stderr}` : (err.message ?? String(e));
}

function resolveBaseRef(repoPath: string): string {
  try {
    git(["fetch", "origin"], repoPath);
  } catch (e) {
    log(`  git fetch failed (branching from local refs): ${errorMessage(e)}`);
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

function createWorktree(repoPath: string, ticketId: string, repo: RepoKind): { wtPath: string; baseBranch: string } {
  const branch = `night/${ticketId}`;
  const wtPath = path.join(WORKTREES_DIR, ticketId);

  if (existsSync(wtPath)) {
    log(`Cleaning stale worktree: ${wtPath}`);
    git(["worktree", "remove", "--force", wtPath], repoPath);
  }
  git(["worktree", "prune"], repoPath);

  const base = resolveBaseRef(repoPath);
  git(["worktree", "add", "-B", branch, wtPath, base], repoPath);
  log(`Worktree created: ${wtPath} (branch: ${branch} from ${base})`);

  if (repo === "main") {
    const srcNM = path.join(repoPath, "node_modules");
    const dstNM = path.join(wtPath, "node_modules");
    if (existsSync(srcNM) && !existsSync(dstNM)) {
      symlinkSync(srcNM, dstNM, "dir");
      log(`Symlinked node_modules → ${dstNM}`);
    }
  }

  return { wtPath, baseBranch: base.replace(/^origin\//, "") };
}

function commitWorktree(wtPath: string, ticketId: string, summary: string): "committed" | "no_changes" {
  const status = git(["status", "--porcelain"], wtPath).trim();
  if (status === "") {
    log(`No changes to commit for ${ticketId}`);
    return "no_changes";
  }
  git(["add", "-A"], wtPath);
  git(["commit", "-m", `night: ${ticketId} – ${summary.slice(0, 120)}`], wtPath);
  log(`Committed: night/${ticketId}`);
  return "committed";
}

function placeholderResult(ticket: Ticket, status: TicketResult["status"], summary: string): TicketResult {
  return {
    ticket, linear: null, status, summary,
    filesCreated: [], filesModified: [], tests: [],
    verifyCommands: [], notes: "",
    worktreePath: "", branch: `night/${ticket.id}`, durationSec: 0,
  };
}

async function openPullRequest(result: TicketResult, baseBranch: string): Promise<void> {
  const { ticket, branch, worktreePath } = result;
  log(`  Pushing ${branch} and opening PR into ${baseBranch}`);
  const pr = await createAndCheckPR(
    ticket.id, result.summary, result.verifyCommands, branch, baseBranch, worktreePath,
  );
  result.prUrl = pr.url;
  result.prId = pr.prId;
  result.pipelineStatus = pr.pipelineStatus;
  log(`  PR #${pr.prId}: ${pr.url} (pipelines: ${pr.pipelineStatus})`);

  if (pr.pipelineStatus === "failed") {
    result.status = "needs_review";
    result.notes = [result.notes, "CI pipeline failed on PR."].filter(Boolean).join(" | ");
  } else if (pr.pipelineStatus === "unknown") {
    result.status = "needs_review";
    result.notes = [result.notes, "CI status unknown after waiting (timed out or no policies)."].filter(Boolean).join(" | ");
  }
}

async function processTicket(ticket: Ticket, dryRun: boolean): Promise<TicketResult> {
  const { id: ticketId, name: ticketName, context, repo } = ticket;
  const repoPath = REPOS[repo];
  const branch = `night/${ticketId}`;
  const startTime = Date.now();
  const wtPath = path.join(WORKTREES_DIR, ticketId);

  log(`\n── Ticket ${ticketId} – ${ticketName} [${repo}] ──`);

  let linear: LinearTicket | null = null;
  let linearDesc = "", linearUrl = "", linearState = "";
  try {
    linear = await fetchTicket(ticketId);
    if (linear) {
      linearDesc = linear.description;
      linearUrl = linear.url;
      linearState = linear.state;
      log(`  Linear: ${linear.name} [${linear.state}]`);
    } else {
      log(`  Linear: ticket ${ticketId} not found (using tonight.md context only)`);
    }
  } catch (e) {
    log(`  Linear fetch error: ${(e as Error).message}`);
  }

  let baseBranch = "main";
  if (dryRun) {
    log(`  [dry-run] Would create worktree at ${wtPath}`);
  } else {
    baseBranch = createWorktree(repoPath, ticketId, repo).baseBranch;
  }

  const result = runAgent(
    wtPath, ticketId, ticketName, context,
    linearDesc, linearUrl, linearState, dryRun
  );

  const report = result.report;
  const ticketResult: TicketResult = {
    ticket,
    linear,
    status: (report?.status ?? "needs_review") as TicketResult["status"],
    summary: report?.summary ?? (result.parseError ? `Parse error: ${result.parseError}` : "Agent produced no report."),
    filesCreated: report?.filesCreated ?? [],
    filesModified: report?.filesModified ?? [],
    tests: report?.tests ?? [],
    verifyCommands: report?.verifyCommands ?? [],
    notes: report?.notes ?? (result.parseError ? "Agent did not produce a valid ---REPORT--- block." : ""),
    worktreePath: wtPath,
    branch,
    durationSec: 0,
  };

  if (dryRun) {
    log(`  [dry-run] Would commit, push ${branch} and open an Azure DevOps PR into ${baseBranch}`);
  } else {
    try {
      mkdirSync(LOGS_DIR, { recursive: true });
      writeFileSync(path.join(LOGS_DIR, `${ticketId}-output.txt`), result.rawOutput, "utf-8");
    } catch (e) {
      log(`  Could not save agent output: ${(e as Error).message}`);
    }

    try {
      const commit = commitWorktree(wtPath, ticketId, ticketResult.summary);
      if (commit === "committed") {
        await openPullRequest(ticketResult, baseBranch);
      }
    } catch (e) {
      const message = errorMessage(e);
      log(`  Commit or PR step failed for ${ticketId}: ${message}`);
      ticketResult.status = "needs_review";
      ticketResult.notes = [ticketResult.notes, `Commit/PR failed: ${message}`].filter(Boolean).join(" | ");
    }
  }

  ticketResult.durationSec = Math.round((Date.now() - startTime) / 1000);
  log(`  Result: ${ticketResult.status} (${ticketResult.durationSec}s)`);
  return ticketResult;
}

async function main() {
  const date = new Date().toISOString().slice(0, 10);
  const startedAt = new Date().toLocaleString("en-US", { timeZone: "America/Vancouver" });
  log(`═══ Nightshift session ${date} started ${DRY_RUN ? "(DRY RUN)" : ""} ═══`);

  mkdirSync(WORKTREES_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  let budget = startNightBudget();
  log(`Tonight's allocation: ${budget.allocationPct}% of weekly. Started at ${budget.startPct}%, cap ${budget.capPct}%.`);

  const tickets = loadTickets();
  log(`Loaded ${tickets.length} ticket(s) from tonight.md`);

  const results: TicketResult[] = [];
  let gateHit = false;
  let skipReason = "";

  for (const ticket of tickets) {
    if (!gateHit) {
      try {
        budget = checkGate(budget);
        log(budgetGateMessage(budget));
        if (budget.gateHit) {
          gateHit = true;
          skipReason = `Skipped – nightly budget allocation reached (${budget.currentPct}% ≥ cap ${budget.capPct}%).`;
        }
      } catch (e) {
        gateHit = true;
        skipReason = `Skipped – could not read usage: ${(e as Error).message}`;
        log(`  ${skipReason}`);
      }
    }

    if (gateHit) {
      log(`  Skipping ${ticket.id}`);
      results.push(placeholderResult(ticket, "skipped", skipReason));
      continue;
    }

    try {
      const r = await processTicket(ticket, DRY_RUN);
      results.push(r);
    } catch (e) {
      log(`  ERROR processing ${ticket.id}: ${(e as Error).message}`);
      results.push(placeholderResult(ticket, "error", (e as Error).message));
    }
  }

  try {
    budget = checkGate(budget);
  } catch (e) {
    log(`Final usage check failed: ${(e as Error).message}`);
  }
  const endedAt = new Date().toLocaleString("en-US", { timeZone: "America/Vancouver" });

  const session: SessionResult = {
    date,
    startedAt,
    endedAt,
    tickets: results,
    budget,
    gateHit,
    noTasks: tickets.length === 0,
  };

  // Write report
  const reportPath = writeReport(session);
  log(`\n═══ Report written: ${reportPath} ═══`);
  log(`Open in browser: file://${reportPath}`);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
