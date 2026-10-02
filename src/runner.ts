import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import type { Ticket, TicketResult, SessionResult, LinearTicket, NightBudget } from "./types.js";
import { loadTickets } from "./tickets.js";
import { REPOS } from "./repos.js";
import { startNightBudget, closedBudget, checkGate, budgetGateMessage, formatUsageAttempts, UsageUnavailableError } from "./budget.js";
import { fetchTicket, markInProgress, shouldMarkInProgress } from "./linear.js";
import { runAgent, runFix, runReview, type TicketBrief } from "./claude.js";
import { agentEnv, buildAgentSettings, CLAUDE_TOKEN } from "./agent-env.js";
import { getEnv, requireEnv } from "./env.js";
import { deriveOutcome } from "./status.js";
import { createAndCheckPR, orgUrl, existingPrWebUrl, findOpenTicketPr, buildPrTitle, prContent, prAction, updateAndCheckPR, type ExistingPr, type PRResult } from "./pr.js";
import { fixFailingChecks, type CiFixOutcome } from "./ci-fix.js";
import { mergeFixReport, reviewAndFix, type ReviewStageOutcome } from "./review.js";
import { azCiSource, fetchCiFailures } from "./ci-logs.js";
import { writeReport } from "./report.js";
import { localDate, TIME_ZONE } from "./time.js";
import { createWorktree, ticketBranchName, commitWorktree, excludedPathsInBranch, hasChangesVsBase, worktreePath, worktreeSnapshot, type Worktree } from "./worktree.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKTREES_DIR = path.join(ROOT, "worktrees");
const LOGS_DIR = path.join(ROOT, "logs");

const DRY_RUN = process.argv.includes("--dry-run");

const BRANCH_PREFIX = getEnv("BRANCH_PREFIX");

const claudeToken = getEnv(CLAUDE_TOKEN);
if (claudeToken) process.env[CLAUDE_TOKEN] = claudeToken;

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

function logUsageFailure(e: unknown, prefix = "") {
  if (!(e instanceof UsageUnavailableError)) return;
  for (const line of formatUsageAttempts(e.attempts)) log(`${prefix}${line}`);
}

function errorMessage(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  const stderr = err.stderr?.toString().trim();
  return stderr ? `${err.message}\n${stderr}` : (err.message ?? String(e));
}

function placeholderResult(ticket: Ticket, status: TicketResult["status"], summary: string): TicketResult {
  return {
    ticket, linear: null, status, summary,
    filesCreated: [], filesModified: [], tests: [],
    verifyCommands: [], notes: "",
    worktreePath: "", branch: ticketBranchName(BRANCH_PREFIX, ticket.id, ticket.name), durationSec: 0,
  };
}

function applyPipelineStatus(result: TicketResult, pr: PRResult): void {
  result.prUrl = pr.url;
  result.prId = pr.prId;
  result.pipelineStatus = pr.pipelineStatus;
  log(`  PR #${pr.prId}: ${pr.url} (pipelines: ${pr.pipelineStatus})`);

  if (pr.pipelineStatus === "unknown") {
    result.status = "needs_review";
    result.notes = [result.notes, "CI status unknown after waiting (timed out or no policies)."].filter(Boolean).join(" | ");
  }
}

async function openPullRequest(result: TicketResult, baseBranch: string): Promise<PRResult> {
  const { branch, worktreePath } = result;
  log(`  Pushing ${branch} and opening PR into ${baseBranch}`);
  const pr = await createAndCheckPR(prContent(result), branch, baseBranch, worktreePath, { log });
  applyPipelineStatus(result, pr);
  return pr;
}

async function updatePullRequest(result: TicketResult, existing: ExistingPr): Promise<PRResult> {
  const { branch, worktreePath } = result;
  log(`  Pushing ${branch} to existing PR #${existing.prId} branch ${existing.sourceBranch}`);
  let pr: PRResult;
  try {
    pr = await updateAndCheckPR(existing, branch, worktreePath, { log });
  } catch (e) {
    result.notes = [result.notes, `Updating PR #${existing.prId} failed before or during push to ${existing.sourceBranch}: ${errorMessage(e).split("\n")[0]}; this run's work is on local ${branch}.`].filter(Boolean).join(" | ");
    throw e;
  }
  result.branch = existing.sourceBranch;
  result.notes = [result.notes, `Updated existing PR #${existing.prId}.`].filter(Boolean).join(" | ");
  applyPipelineStatus(result, pr);
  return pr;
}

function settleCi(result: TicketResult, fix: CiFixOutcome): void {
  const { pr, attempts, stopped, agentStatus } = fix;
  applyPipelineStatus(result, pr);
  result.notes = [result.notes, ...fix.notes].filter(Boolean).join(" | ");
  const attemptsNote = `${attempts} CI fix attempt(s)`;
  if (pr.pipelineStatus === "failed") {
    const names = pr.failedChecks.map(c => c.name).join(", ");
    const why = stopped === "exhausted" ? "" : `; stopped: ${stopped}`;
    result.status = "needs_review";
    result.notes = [result.notes, `Required checks still failing on PR #${pr.prId}: ${names} after ${attemptsNote}${why}.`].filter(Boolean).join(" | ");
  } else if (pr.pipelineStatus === "succeeded" && attempts > 0) {
    if (agentStatus === "needs_review") result.status = "needs_review";
    result.notes = [result.notes, `Required checks passed after ${attemptsNote}.`].filter(Boolean).join(" | ");
  } else if (attempts > 0) {
    result.notes = [result.notes, `After ${attemptsNote}: CI status unknown.`].filter(Boolean).join(" | ");
  }
}

function holdForAutoComplete(result: TicketResult, existing: ExistingPr): void {
  log(`  Not pushing ${result.branch}: PR #${existing.prId} has auto-complete set`);
  result.status = "needs_review";
  result.notes = [result.notes, `PR #${existing.prId} has auto-complete set; not pushing agent commits to it.`].filter(Boolean).join(" | ");
}

async function startLinearTicket(linear: LinearTicket): Promise<void> {
  const target = linear.inProgressState;
  if (!target || !shouldMarkInProgress(linear.stateType)) return;
  try {
    await markInProgress(linear.id, target.id);
    log(`  Linear: moved ${linear.identifier} to ${target.name}`);
  } catch (e) {
    log(`  Linear: could not move ${linear.identifier} to ${target.name}: ${(e as Error).message}`);
  }
}

function saveLog(name: string, text: string): void {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    writeFileSync(path.join(LOGS_DIR, name), text, "utf-8");
  } catch (e) {
    log(`  Could not save ${name}: ${(e as Error).message}`);
  }
}

function applyReviewStage(result: TicketResult, stage: ReviewStageOutcome): void {
  result.review = stage.review;
  result.notes = [result.notes, ...stage.notes].filter(Boolean).join(" | ");
  if (stage.needsReview) result.status = "needs_review";
  if (stage.fixReport) Object.assign(result, mergeFixReport({ ...result, title: result.title ?? "" }, stage.fixReport));
}

function lookUpExistingPr(expectedBranch: string, repoPath: string): ExistingPr | null {
  try {
    const existing = findOpenTicketPr(expectedBranch, repoPath);
    if (existing) log(`  Continuing PR #${existing.prId} (${existing.sourceBranch} → ${existing.targetBranch})`);
    return existing;
  } catch (e) {
    log(`  Could not look up existing PRs: ${errorMessage(e)}; a new PR will be opened if needed`);
    return null;
  }
}

const continuingPrContext = (prId: number) =>
  `This ticket already has open PR #${prId} from an earlier run. The worktree contains that work; continue from it instead of starting over.`;

async function processTicket(ticket: Ticket, dryRun: boolean, budgetRef: { current: NightBudget }): Promise<TicketResult> {
  const { id: ticketId, name: ticketName, context, repo } = ticket;
  const repoPath = REPOS[repo];
  const startTime = Date.now();
  const plannedPath = worktreePath(WORKTREES_DIR, repo, ticketId);
  let wt: Worktree = {
    wtPath: plannedPath, branch: ticketBranchName(BRANCH_PREFIX, ticketId, ticketName), baseRef: "origin/main", baseBranch: "main", startedFromPr: false,
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
      if (!dryRun) await startLinearTicket(linear);
    } else {
      log(`  Linear: ticket ${ticketId} not found (using tonight.md context only)`);
    }
  } catch (e) {
    log(`  Linear fetch error: ${(e as Error).message}`);
  }

  const branchBase = ticketBranchName(BRANCH_PREFIX, ticketId, linear?.name ?? ticketName);
  wt.branch = branchBase;
  const existing = lookUpExistingPr(branchBase, repoPath);
  if (dryRun) {
    log(`  [dry-run] Would create worktree at ${wt.wtPath} on ${wt.branch}`);
  } else {
    const startFrom = existing ? { branch: existing.sourceBranch, baseBranch: existing.targetBranch } : undefined;
    wt = createWorktree({ repoPath, worktreesDir: WORKTREES_DIR, ticketId, repo, branchBase, startFrom }, log);
  }
  const continuing = existing !== null && (dryRun || wt.startedFromPr);
  const agentContext = continuing ? [continuingPrContext(existing.prId), ...context] : context;

  const shouldAbort = () => {
    try {
      budgetRef.current = checkGate(budgetRef.current, 1);
    } catch (e) {
      log(`  Mid-ticket usage check failed: ${(e as Error).message}`);
      logUsageFailure(e, "    ");
      return undefined;
    }
    return budgetRef.current.gateHit
      ? `budget cap reached mid-ticket (${budgetRef.current.currentPct}% ≥ ${budgetRef.current.capPct}%)`
      : undefined;
  };
  const agentOptions = { shouldAbort, env: agentEnv(process.env), settings: buildAgentSettings(repo, ROOT) };
  const result = await runAgent(
    wt.wtPath, ticketId, ticketName, agentContext,
    linearDesc, linearUrl, linearState, dryRun, agentOptions,
  );

  const report = result.report;
  const ticketResult: TicketResult = {
    ticket,
    linear,
    status: (report?.status ?? "needs_review") as TicketResult["status"],
    title: report?.title ?? "",
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
  if (existing && wt.startedFromPr) {
    ticketResult.prId = existing.prId;
    try {
      ticketResult.prUrl = existingPrWebUrl(existing, repoPath);
    } catch (e) {
      log(`  Could not build URL for PR #${existing.prId}: ${errorMessage(e)}`);
    }
  }
  const outcome = deriveOutcome(result);
  ticketResult.status = outcome.status;
  ticketResult.notes = [ticketResult.notes, ...outcome.notes].filter(Boolean).join(" | ");

  if (dryRun) {
    log(`  [dry-run] Would review the change on ${wt.branch}, then fix any issues found`);
    const action = prAction(existing, true);
    log(action === "update"
      ? `  [dry-run] Would push to existing PR #${existing!.prId} branch ${existing!.sourceBranch}`
      : action === "hold"
        ? `  [dry-run] Would commit on ${wt.branch} but not push: PR #${existing!.prId} has auto-complete set`
        : `  [dry-run] Would commit, push ${wt.branch} and open a new Azure DevOps PR into ${wt.baseBranch}`);
  } else {
    saveLog(`${ticketId}-output.txt`, result.rawOutput);

    const brief: TicketBrief = { ticketId, ticketName, context: agentContext, linearDesc, linearUrl, state: linearState };
    const stage = await reviewAndFix(outcome.publish, {
      hasChanges: () => hasChangesVsBase(wt),
      snapshot: () => worktreeSnapshot(wt),
      gateOpen: () => shouldAbort() === undefined,
      review: () => runReview(wt.wtPath, brief, report, wt.baseRef, agentOptions),
      fix: findings => runFix(wt.wtPath, brief, findings, agentOptions),
      saveOutput: (name, raw) => saveLog(`${ticketId}-${name}.txt`, raw),
      log,
    }).catch((e): ReviewStageOutcome => {
      const reason = errorMessage(e);
      log(`  Review stage errored for ${ticketId}: ${reason}`);
      return {
        review: { outcome: "failed", reason, findings: [], resolutions: [] },
        publish: false, needsReview: true, notes: [`Review stage errored: ${reason}; work kept on local branch, not pushed.`],
      };
    });
    applyReviewStage(ticketResult, stage);
    const publish = outcome.publish && stage.publish;

    try {
      const commit = commitWorktree(wt, buildPrTitle(ticketId, ticketResult.title ?? "", ticketResult.summary), log);
      const excluded = commit === "no_changes" ? [] : excludedPathsInBranch(wt);
      if (excluded.length > 0) {
        const listed = excluded.slice(0, 5).join(", ");
        log(`  Not publishing ${wt.branch}: contains excluded files (${listed})`);
        ticketResult.status = "needs_review";
        ticketResult.notes = [ticketResult.notes, `Branch contains excluded files (${listed}); not pushed.`].filter(Boolean).join(" | ");
      } else if (commit !== "no_changes" && publish) {
        const action = prAction(existing, wt.startedFromPr);
        let pr: PRResult | undefined;
        let pushedTo: ExistingPr | undefined;
        if (action === "update") {
          pushedTo = existing!;
          pr = await updatePullRequest(ticketResult, pushedTo);
        } else if (action === "hold") {
          holdForAutoComplete(ticketResult, existing!);
        } else {
          pr = await openPullRequest(ticketResult, wt.baseBranch);
          pushedTo = { prId: pr.prId, sourceBranch: wt.branch, targetBranch: wt.baseBranch, autoComplete: false };
        }
        if (pr?.pipelineStatus === "failed" && pushedTo) {
          const target = pushedTo;
          const logSource = azCiSource(orgUrl(requireEnv("AZURE_DEVOPS_ORG")), requireEnv("AZURE_DEVOPS_PROJECT"));
          const fix = await fixFailingChecks(pr, { ticketId, title: ticketResult.title ?? "" }, {
            runAgent: context => runAgent(
              wt.wtPath, ticketId, ticketName, context, linearDesc, linearUrl, linearState, false, agentOptions,
            ),
            commit: subject => {
              const outcome = commitWorktree(wt, subject, log);
              if (outcome !== "no_changes" && excludedPathsInBranch(wt).length > 0) throw new Error("CI fix touched excluded files; not pushing.");
              return outcome;
            },
            publish: () => updateAndCheckPR(target, wt.branch, wt.wtPath, { log }),
            fetchLogs: checks => fetchCiFailures(checks, logSource),
            gateOpen: () => shouldAbort() === undefined,
            log,
          });
          settleCi(ticketResult, fix);
        }
      } else if (commit !== "no_changes") {
        log(`  Not publishing ${wt.branch}: ${[...outcome.notes, ...stage.notes].join(" ")}`);
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
    logUsageFailure(e, "  ");
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
        logUsageFailure(e, "    ");
      }
    }

    if (gateHit) {
      log(`  Skipping ${ticket.id}`);
      results.push(placeholderResult(ticket, "skipped", skipReason));
      continue;
    }

    try {
      const r = await processTicket(ticket, DRY_RUN, budgetRef);
      results.push(r);
    } catch (e) {
      log(`  ERROR processing ${ticket.id}: ${(e as Error).message}`);
      results.push(placeholderResult(ticket, "error", (e as Error).message));
    }
  }

  try {
    if (!closedAtStart) budgetRef.current = checkGate(budgetRef.current);
  } catch (e) {
    log(`Final usage check failed: ${(e as Error).message}`);
    logUsageFailure(e, "  ");
  }
  const endedAt = new Date().toLocaleString("en-US", { timeZone: TIME_ZONE });

  const session: SessionResult = {
    date,
    startedAt,
    endedAt,
    tickets: results,
    budget: budgetRef.current,
    gateHit,
    skipReason,
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
