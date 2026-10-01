import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import type { Ticket, TicketResult, SessionResult, LinearTicket, NightBudget } from "./types.js";
import { loadTickets } from "./tickets.js";
import { startNightBudget, closedBudget, checkGate, budgetGateMessage } from "./budget.js";
import { fetchTicket } from "./linear.js";
import { runAgent } from "./claude.js";
import { agentEnv, buildAgentSettings } from "./agent-env.js";
import { deriveOutcome } from "./status.js";
import { createAndCheckPR, findOpenNightPr, updateAndCheckPR, type ExistingPr, type PRResult } from "./pr.js";
import { writeReport } from "./report.js";
import { localDate, runStamp, TIME_ZONE } from "./time.js";
import { branchName, createWorktree, commitWorktree, excludedPathsInBranch, worktreePath, type Worktree } from "./worktree.js";

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
    const today = localDate();
    appendFileSync(path.join(LOGS_DIR, `nightshift-${today}.log`), line + "\n");
  } catch { /* best effort */ }
}

function errorMessage(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  const stderr = err.stderr?.toString().trim();
  return stderr ? `${err.message}\n${stderr}` : (err.message ?? String(e));
}

function placeholderResult(ticket: Ticket, status: TicketResult["status"], summary: string, stamp: string): TicketResult {
  return {
    ticket, linear: null, status, summary,
    filesCreated: [], filesModified: [], tests: [],
    verifyCommands: [], notes: "",
    worktreePath: "", branch: branchName(ticket.id, stamp), durationSec: 0,
  };
}

function applyPipelineStatus(result: TicketResult, pr: PRResult): void {
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

async function openPullRequest(result: TicketResult, baseBranch: string): Promise<void> {
  const { ticket, branch, worktreePath } = result;
  log(`  Pushing ${branch} and opening PR into ${baseBranch}`);
  const pr = await createAndCheckPR(
    ticket.id, result.summary, result.verifyCommands, branch, baseBranch, worktreePath, { log },
  );
  applyPipelineStatus(result, pr);
}

async function updatePullRequest(result: TicketResult, existing: ExistingPr): Promise<void> {
  const { branch, worktreePath } = result;
  log(`  Pushing ${branch} to existing PR #${existing.prId} branch ${existing.sourceBranch}`);
  const pr = await updateAndCheckPR(existing, branch, worktreePath, { log });
  result.branch = existing.sourceBranch;
  result.notes = [result.notes, `Updated existing PR #${existing.prId}.`].filter(Boolean).join(" | ");
  applyPipelineStatus(result, pr);
}

function lookUpExistingPr(ticketId: string, repoPath: string): ExistingPr | null {
  try {
    const existing = findOpenNightPr(ticketId, repoPath);
    if (existing) log(`  Continuing PR #${existing.prId} (${existing.sourceBranch} → ${existing.targetBranch})`);
    return existing;
  } catch (e) {
    log(`  Could not look up existing PRs: ${errorMessage(e)}; a new PR will be opened if needed`);
    return null;
  }
}

const continuingPrContext = (prId: number) =>
  `This ticket already has open PR #${prId} from an earlier night. The worktree contains that work; continue from it instead of starting over.`;

async function processTicket(ticket: Ticket, dryRun: boolean, stamp: string, budgetRef: { current: NightBudget }): Promise<TicketResult> {
  const { id: ticketId, name: ticketName, context, repo } = ticket;
  const repoPath = REPOS[repo];
  const startTime = Date.now();
  const plannedPath = worktreePath(WORKTREES_DIR, repo, ticketId);
  let wt: Worktree = {
    wtPath: plannedPath, branch: branchName(ticketId, stamp), baseRef: "origin/main", baseBranch: "main", startedFromPr: false,
  };

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

  const existing = lookUpExistingPr(ticketId, repoPath);
  if (dryRun) {
    log(`  [dry-run] Would create worktree at ${wt.wtPath} on ${wt.branch}`);
  } else {
    const startFrom = existing ? { branch: existing.sourceBranch, baseBranch: existing.targetBranch } : undefined;
    wt = createWorktree({ repoPath, worktreesDir: WORKTREES_DIR, ticketId, repo, runStamp: stamp, startFrom }, log);
  }
  const continuing = existing !== null && (dryRun || wt.startedFromPr);
  const agentContext = continuing ? [continuingPrContext(existing.prId), ...context] : context;

  const shouldAbort = () => {
    try {
      budgetRef.current = checkGate(budgetRef.current);
    } catch (e) {
      log(`  Mid-ticket usage check failed: ${(e as Error).message}`);
      return undefined;
    }
    return budgetRef.current.gateHit
      ? `budget cap reached mid-ticket (${budgetRef.current.currentPct}% ≥ ${budgetRef.current.capPct}%)`
      : undefined;
  };
  const result = await runAgent(
    wt.wtPath, ticketId, ticketName, agentContext,
    linearDesc, linearUrl, linearState, dryRun,
    { shouldAbort, env: agentEnv(process.env), settings: buildAgentSettings(repo, ROOT) },
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
    notes: report?.notes ?? "",
    worktreePath: wt.wtPath,
    branch: wt.branch,
    durationSec: 0,
  };
  const outcome = deriveOutcome(result);
  ticketResult.status = outcome.status;
  ticketResult.notes = [ticketResult.notes, ...outcome.notes].filter(Boolean).join(" | ");

  if (dryRun) {
    log(continuing
      ? `  [dry-run] Would commit and push to existing PR #${existing.prId} branch ${existing.sourceBranch}`
      : `  [dry-run] Would commit, push ${wt.branch} and open a new Azure DevOps PR into ${wt.baseBranch}`);
  } else {
    try {
      mkdirSync(LOGS_DIR, { recursive: true });
      writeFileSync(path.join(LOGS_DIR, `${ticketId}-output.txt`), result.rawOutput, "utf-8");
    } catch (e) {
      log(`  Could not save agent output: ${(e as Error).message}`);
    }

    try {
      const commit = commitWorktree(wt, ticketId, ticketResult.summary, log);
      const excluded = commit === "no_changes" ? [] : excludedPathsInBranch(wt);
      if (excluded.length > 0) {
        const listed = excluded.slice(0, 5).join(", ");
        log(`  Not publishing ${wt.branch}: contains excluded files (${listed})`);
        ticketResult.status = "needs_review";
        ticketResult.notes = [ticketResult.notes, `Branch contains excluded files (${listed}); not pushed.`].filter(Boolean).join(" | ");
      } else if (commit !== "no_changes" && outcome.publish) {
        if (existing && wt.startedFromPr) await updatePullRequest(ticketResult, existing);
        else await openPullRequest(ticketResult, wt.baseBranch);
      } else if (commit !== "no_changes") {
        log(`  Not publishing ${wt.branch}: ${outcome.notes.join(" ")}`);
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
  const date = localDate();
  const stamp = runStamp();
  const startedAt = new Date().toLocaleString("en-US", { timeZone: TIME_ZONE });
  log(`═══ Nightshift session ${date} started ${DRY_RUN ? "(DRY RUN)" : ""} ═══`);

  mkdirSync(WORKTREES_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  const results: TicketResult[] = [];
  let gateHit = false;
  let skipReason = "";
  let budget: NightBudget;
  try {
    budget = startNightBudget();
    log(`Tonight's allocation: ${budget.allocationPct}% of weekly. Started at ${budget.startPct}%, cap ${budget.capPct}%.`);
  } catch (e) {
    const message = (e as Error).message;
    budget = closedBudget(`usage unavailable: ${message}`);
    gateHit = true;
    skipReason = `Skipped – could not read usage at start: ${message}`;
    log(skipReason);
  }
  const budgetRef = { current: budget };
  const closedAtStart = gateHit;

  let tickets: Ticket[] = [];
  let ticketError = "";
  try {
    tickets = loadTickets();
    log(`Loaded ${tickets.length} ticket(s) from tonight.md`);
  } catch (e) {
    ticketError = (e as Error).message;
    log(`ERROR loading tickets: ${ticketError}`);
  }

  for (const ticket of tickets) {
    if (!gateHit) {
      try {
        budgetRef.current = checkGate(budgetRef.current);
        log(budgetGateMessage(budgetRef.current));
        if (budgetRef.current.gateHit) {
          gateHit = true;
          skipReason = `Skipped – nightly budget allocation reached (${budgetRef.current.currentPct}% ≥ cap ${budgetRef.current.capPct}%).`;
        }
      } catch (e) {
        gateHit = true;
        skipReason = `Skipped – could not read usage: ${(e as Error).message}`;
        log(`  ${skipReason}`);
      }
    }

    if (gateHit) {
      log(`  Skipping ${ticket.id}`);
      results.push(placeholderResult(ticket, "skipped", skipReason, stamp));
      continue;
    }

    try {
      const r = await processTicket(ticket, DRY_RUN, stamp, budgetRef);
      results.push(r);
    } catch (e) {
      log(`  ERROR processing ${ticket.id}: ${(e as Error).message}`);
      results.push(placeholderResult(ticket, "error", (e as Error).message, stamp));
    }
  }

  try {
    if (!closedAtStart) budgetRef.current = checkGate(budgetRef.current);
  } catch (e) {
    log(`Final usage check failed: ${(e as Error).message}`);
  }
  const endedAt = new Date().toLocaleString("en-US", { timeZone: TIME_ZONE });

  const session: SessionResult = {
    date,
    startedAt,
    endedAt,
    tickets: results,
    budget: budgetRef.current,
    gateHit,
    noTasks: tickets.length === 0 && !ticketError,
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
