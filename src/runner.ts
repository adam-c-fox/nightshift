import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Ticket, TicketResult, SessionResult, SessionPostmortem, LinearComment, LinearTicket, NightBudget } from "./types.js";
import { archiveTickets, loadAllowance, loadTickets } from "./tickets.js";
import { startNightBudget, closedBudget, checkGate, budgetGateMessage, formatUsageAttempts, sessionAbortReason, snapshotUsage, UsageUnavailableError, waitForSessionCapacity } from "./budget.js";
import { fetchTicket, markInProgress, shouldMarkInProgress } from "./linear.js";
import { runAgent, runFix, runReview, runVerify, type TicketBrief } from "./claude.js";
import { composeInstructions, GENERIC_AGENTS_MD } from "./instructions.js";
import { agentEnv, buildAgentSettings, CLAUDE_TOKEN } from "./agent-env.js";
import { getEnv, requireEnv, useProjectEnv } from "./env.js";
import { parseRunArgs, RUN_USAGE, type RunArgs } from "./args.js";
import { listProjects, loadProject, projectEnvFiles, type Project } from "./project.js";
import { deriveOutcome } from "./status.js";
import { createAndCheckPR, orgUrl, existingPrWebUrl, findOpenTicketPr, buildPrTitle, prContent, prAction, updateAndCheckPR, type ExistingPr, type PRResult, type PrContent } from "./pr.js";
import { fixFailingChecks, type CiFixOutcome } from "./ci-fix.js";
import { mergeFixReport, reviewAndFix, type ReviewStageOutcome } from "./review.js";
import { azCiSource, fetchCiFailures } from "./ci-logs.js";
import { reportBase, REPORTS_DIR, writeReport } from "./report.js";
import { postmortemMarkdown, postmortemSkipReason, runPostmortem, sessionLogData, type UsageGate } from "./postmortem.js";
import { checkCommands, classifyChecks, discoverTerraformRoots, discoverWorkspaces, regressionFindings, runChecks, type CheckCommand, type CheckResult, type ClassifiedCheck } from "./checks.js";
import { relatedTickets, type ProcessedTicket, type PushedBranch } from "./related.js";
import { stackDecision, stackedContext } from "./stack.js";
import { startTestDb } from "./test-db.js";
import { localDate, TIME_ZONE } from "./time.js";
import { createWorktree, ticketBranchName, branchDiff, commitWorktree, excludedPathsInBranch, hasChangesVsBase, worktreePath, worktreeSnapshot, type Worktree } from "./worktree.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKTREES_DIR = path.join(ROOT, "worktrees");
let logsDir = path.join(ROOT, "logs");

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(logsDir, { recursive: true });
    const today = localDate();
    appendFileSync(path.join(logsDir, `nightshift-${today}.log`), line + "\n");
  } catch { /* best effort */ }
}

function waitForSession(): Promise<void> {
  return waitForSessionCapacity({
    snapshot: () => snapshotUsage(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    log,
    now: Date.now,
  });
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

function placeholderResult(ticket: Ticket, status: TicketResult["status"], summary: string, branchPrefix: string | undefined): TicketResult {
  return {
    ticket, linear: null, status, summary,
    filesCreated: [], filesModified: [], tests: [],
    verifyCommands: [], notes: "", followups: [],
    worktreePath: "", branch: ticketBranchName(branchPrefix, ticket.id, ticket.name), durationSec: 0,
  };
}

function applyPipelineStatus(result: TicketResult, pr: PRResult): void {
  result.prUrl = pr.url;
  result.prId = pr.prId;
  result.pipelineStatus = pr.pipelineStatus;
  log(`  PR #${pr.prId}: ${pr.url} (pipelines: ${pr.pipelineStatus})`);

  if (pr.pipelineStatus === "unknown") {
    result.status = "needs_review";
    result.notes = [result.notes, pr.unknownReason ? `CI status unknown: ${pr.unknownReason}.` : "CI status unknown after waiting (timed out or no policies)."].filter(Boolean).join(" | ");
  }
}

async function openPullRequest(result: TicketResult, baseBranch: string, stackedOn?: PrContent["stackedOn"]): Promise<PRResult> {
  const { branch, worktreePath } = result;
  log(`  Pushing ${branch} and opening PR into ${baseBranch}`);
  const pr = await createAndCheckPR({ ...prContent(result), stackedOn }, branch, baseBranch, worktreePath, { log });
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
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(path.join(logsDir, name), text, "utf-8");
  } catch (e) {
    log(`  Could not save ${name}: ${(e as Error).message}`);
  }
}

function weeklyGate(budgetRef: { current: NightBudget }, when: string): string | undefined {
  try {
    budgetRef.current = checkGate(budgetRef.current, 1);
  } catch (e) {
    log(`  Mid-ticket usage check failed: ${(e as Error).message}`);
    logUsageFailure(e, "    ");
    return undefined;
  }
  return budgetRef.current.gateHit
    ? `budget cap reached ${when} (${budgetRef.current.currentPct}% ≥ ${budgetRef.current.capPct}%)`
    : undefined;
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

async function runLoggedChecks(label: string, cwd: string, commands: CheckCommand[]): Promise<CheckResult[]> {
  log(`  Running checks ${label}`);
  const results = await runChecks(cwd, commands, agentEnv(process.env));
  const failed = results.filter(r => !r.passed).map(r => r.command);
  log(`  Checks ${label}: ${results.length - failed.length}/${results.length} passed${failed.length > 0 ? `; failing: ${failed.join(", ")}` : ""}`);
  return results;
}

const checkRecords = (checks: ClassifiedCheck[]): TicketResult["checks"] =>
  checks.map(({ outputTail: _tail, ...record }) => record);

async function processTicket(
  ticket: Ticket, project: Project, branchPrefix: string | undefined, instructions: string, dryRun: boolean,
  budgetRef: { current: NightBudget }, processed: Map<string, ProcessedTicket>,
): Promise<TicketResult> {
  const { id: ticketId, name: ticketName, context, repo } = ticket;
  const { path: repoPath, toolchain } = project.repos[repo];
  const startTime = Date.now();
  const stack = stackDecision(ticket, processed);
  if (stack.kind === "skip") {
    log(`  ${ticketId}: ${stack.reason}`);
    return placeholderResult(ticket, "skipped", stack.reason, branchPrefix);
  }
  const parent = stack.kind === "stacked" ? stack.parent : undefined;
  const plannedPath = worktreePath(WORKTREES_DIR, repo, ticketId);
  let wt: Worktree = {
    wtPath: plannedPath, branch: ticketBranchName(branchPrefix, ticketId, ticketName), baseRef: "origin/main", baseBranch: "main", startedFromPr: false,
  };

  log(`\n── Ticket ${ticketId} – ${ticketName} [${repo}] ──`);

  let linear: LinearTicket | null = null;
  let linearDesc = "", linearUrl = "", linearState = "";
  let linearComments: LinearComment[] = [];
  try {
    linear = await fetchTicket(ticketId);
    if (linear) {
      linearDesc = linear.description;
      linearComments = linear.comments;
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

  const branchBase = ticketBranchName(branchPrefix, ticketId, linear?.name ?? ticketName);
  wt.branch = branchBase;
  const existing = lookUpExistingPr(branchBase, repoPath);
  if (dryRun) {
    log(`  [dry-run] Would create worktree at ${wt.wtPath} on ${wt.branch}`);
    if (parent) log(`  [dry-run] Would branch from origin/${parent.branch}`);
  } else {
    const startFrom = existing ? { branch: existing.sourceBranch, baseBranch: existing.targetBranch } : undefined;
    wt = createWorktree({ repoPath, worktreesDir: WORKTREES_DIR, ticketId, repo, toolchain, branchBase, startFrom, stackedOn: parent?.branch }, log);
  }
  const continuing = existing !== null && (dryRun || wt.startedFromPr);
  const agentContext = [...(continuing ? [continuingPrContext(existing.prId)] : []), ...(parent ? [stackedContext(parent)] : []), ...context];

  const weeklyGateReason = () => weeklyGate(budgetRef, "mid-ticket");
  const shouldAbort = () => weeklyGateReason() ?? sessionAbortReason(budgetRef.current);
  const agentOptions = { shouldAbort, env: agentEnv(process.env), settings: buildAgentSettings(toolchain, ROOT, { secretFiles: projectEnvFiles() }), instructions };
  const commands = dryRun ? [] : checkCommands(toolchain, toolchain === "node" ? discoverWorkspaces(wt.wtPath) : discoverTerraformRoots(wt.wtPath));
  const baseline = dryRun ? [] : await runLoggedChecks("before the change", wt.wtPath, commands);
  if (!dryRun) await waitForSession();
  const result = await runAgent(
    wt.wtPath, ticketId, ticketName, agentContext,
    linearDesc, linearComments, linearUrl, linearState, dryRun, agentOptions,
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
    followups: report?.followups ?? [],
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

  let pushed: PushedBranch | undefined;
  if (dryRun) {
    log(`  [dry-run] Would review the change on ${wt.branch}, then fix any issues found`);
    const action = prAction(existing, true);
    if (action !== "hold") pushed = { branch: action === "update" ? existing!.sourceBranch : wt.branch, prId: existing?.prId ?? 0 };
    log(action === "update"
      ? `  [dry-run] Would push to existing PR #${existing!.prId} branch ${existing!.sourceBranch}`
      : action === "hold"
        ? `  [dry-run] Would commit on ${wt.branch} but not push: PR #${existing!.prId} has auto-complete set`
        : `  [dry-run] Would commit, push ${wt.branch} and open a new Azure DevOps PR into ${wt.baseBranch}`);
  } else {
    saveLog(`${ticketId}-output.txt`, result.rawOutput);

    const brief: TicketBrief = { ticketId, ticketName, context: agentContext, linearDesc, linearComments, linearUrl, state: linearState };
    const after = outcome.publish && hasChangesVsBase(wt) ? await runLoggedChecks("after the change", wt.wtPath, commands) : undefined;
    let checks = after && classifyChecks(baseline, after);
    const related = relatedTickets(ticketId, repo, [...agentContext, linearDesc], processed);
    const stage = await reviewAndFix(outcome.publish, {
      regressions: checks ? regressionFindings(checks) : [],
      recheck: async () => {
        checks = classifyChecks(baseline, await runLoggedChecks("after the fix", wt.wtPath, commands));
        return regressionFindings(checks);
      },
      hasChanges: () => hasChangesVsBase(wt),
      snapshot: () => worktreeSnapshot(wt),
      gateOpen: () => weeklyGateReason() === undefined,
      review: async () => {
        await waitForSession();
        return runReview(wt.wtPath, brief, report, wt.baseRef, agentOptions, { checks, related: related.map(r => ({ ticketId: r.ticketId, branch: r.branch })) });
      },
      fix: async findings => {
        await waitForSession();
        return runFix(wt.wtPath, brief, findings, agentOptions);
      },
      verify: async (findings, resolutions) => {
        await waitForSession();
        return runVerify(wt.wtPath, brief, wt.baseRef, findings, resolutions, agentOptions);
      },
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
    if (checks) ticketResult.checks = checkRecords(checks);
    const notRun = checks?.filter(c => c.status === "not-run") ?? [];
    for (const c of notRun) log(`  Check did not run: ${c.command}`);
    if (notRun.length > 0) ticketResult.notes = [ticketResult.notes, `Checks that did not run: ${notRun.map(c => c.name).join(", ")}.`].filter(Boolean).join(" | ");
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
          pr = await openPullRequest(ticketResult, wt.baseBranch, parent && { ticketId: parent.ticketId, prId: parent.prId });
          pushedTo = { prId: pr.prId, sourceBranch: wt.branch, targetBranch: wt.baseBranch, autoComplete: false };
        }
        if (pushedTo) pushed = { branch: pushedTo.sourceBranch, prId: pushedTo.prId };
        if (pr?.pipelineStatus === "failed" && pushedTo) {
          const target = pushedTo;
          const logSource = azCiSource(orgUrl(requireEnv("AZURE_DEVOPS_ORG")), requireEnv("AZURE_DEVOPS_PROJECT"));
          const fix = await fixFailingChecks(pr, { ticketId, title: ticketResult.title ?? "" }, {
            runAgent: async context => {
              await waitForSession();
              return runAgent(wt.wtPath, ticketId, ticketName, context, linearDesc, linearComments, linearUrl, linearState, false, agentOptions);
            },
            commit: subject => {
              const outcome = commitWorktree(wt, subject, log);
              if (outcome !== "no_changes" && excludedPathsInBranch(wt).length > 0) throw new Error("CI fix touched excluded files; not pushing.");
              return outcome;
            },
            publish: () => updateAndCheckPR(target, wt.branch, wt.wtPath, { log }),
            fetchLogs: checks => fetchCiFailures(checks, logSource),
            gateOpen: () => weeklyGateReason() === undefined,
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
    try {
      saveLog(`${ticketId}-diff.txt`, branchDiff(wt));
    } catch (e) {
      log(`  Could not save the diff for ${ticketId}: ${errorMessage(e)}`);
    }
  }

  ticketResult.durationSec = Math.round((Date.now() - startTime) / 1000);
  log(`  Result: ${ticketResult.status} (${ticketResult.durationSec}s)`);
  processed.set(ticketId, { branch: wt.branch, repo, pushed });
  return ticketResult;
}

function freshGate(budgetRef: { current: NightBudget }): UsageGate {
  try {
    budgetRef.current = checkGate(budgetRef.current);
    return budgetRef.current.gateHit ? "hit" : "open";
  } catch (e) {
    logUsageFailure(e, "  ");
    return "unreadable";
  }
}

async function nightPostmortem(session: SessionResult, project: Project, dryRun: boolean, reportsDir: string, budgetRef: { current: NightBudget }, base: string): Promise<SessionPostmortem> {
  const { date } = session;
  try {
    saveLog(`session-${date}.json`, JSON.stringify(sessionLogData(session, name => existsSync(path.join(logsDir, name)), path.relative(ROOT, logsDir)), null, 2));
    const reason = postmortemSkipReason({ dryRun, tickets: session.tickets, gate: () => freshGate(budgetRef) });
    if (reason) {
      log(`Postmortem skipped: ${reason}`);
      return { outcome: "skipped", reason, suggestions: [] };
    }
    log("Running postmortem");
    await waitForSession();
    const shouldAbort = () => weeklyGate(budgetRef, "during the postmortem") ?? sessionAbortReason(budgetRef.current);
    const { rawOutput, outcome } = await runPostmortem(ROOT, date, path.relative(ROOT, logsDir), [WORKTREES_DIR], {
      shouldAbort, env: agentEnv(process.env), settings: buildAgentSettings("node", ROOT, { readLogs: true, secretFiles: projectEnvFiles() }),
    });
    saveLog(`postmortem-${date}.txt`, rawOutput);
    if (outcome.outcome !== "done") {
      log(`Postmortem failed: ${outcome.reason}`);
      return outcome;
    }
    const file = path.join(reportsDir, `${base}-postmortem.md`);
    writeFileSync(file, postmortemMarkdown(date, outcome.suggestions), "utf-8");
    log(`Postmortem: ${outcome.suggestions.length} suggestion(s) in ${file}`);
    return { ...outcome, file: path.relative(ROOT, file) };
  } catch (e) {
    const reason = errorMessage(e);
    log(`Postmortem errored: ${reason}`);
    return { outcome: "failed", reason, suggestions: [] };
  }
}

function selectProject(): { args: RunArgs; project: Project } {
  let args: RunArgs;
  try {
    args = parseRunArgs(process.argv.slice(2));
  } catch (e) {
    const message = (e as Error).message;
    console.error(message.includes(RUN_USAGE) ? message : `${message}\n${RUN_USAGE}`);
    process.exit(2);
  }
  try {
    const name = args.project ?? getEnv("NIGHTSHIFT_PROJECT");
    if (!name) {
      throw new Error(`no project selected: pass --project <name> or set NIGHTSHIFT_PROJECT (available: ${listProjects().join(", ") || "none"})`);
    }
    return { args, project: loadProject(name) };
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}

async function main() {
  const { args, project } = selectProject();
  useProjectEnv(project.envFile);
  const claudeToken = getEnv(CLAUDE_TOKEN);
  if (claudeToken) process.env[CLAUDE_TOKEN] = claudeToken;
  const dryRun = args.dryRun;
  const branchPrefix = getEnv("BRANCH_PREFIX");
  const reportsDir = path.join(REPORTS_DIR, project.name);
  logsDir = path.join(ROOT, "logs", project.name);
  const instructions = composeInstructions(readFileSync(GENERIC_AGENTS_MD, "utf-8"), project.name, project.instructions);
  const date = localDate();
  const startedAt = new Date().toLocaleString("en-US", { timeZone: TIME_ZONE });
  log(`═══ Nightshift session ${date} started ${dryRun ? "(DRY RUN)" : ""} ═══`);
  log(`Project: ${project.name}`);

  mkdirSync(WORKTREES_DIR, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const results: TicketResult[] = [];
  let gateHit = false;
  let skipReason = "";
  let budget: NightBudget;
  let ticketError = "";
  let nightAllowance: number | undefined;
  try {
    nightAllowance = loadAllowance(project.ticketsFile);
  } catch (e) {
    ticketError = (e as Error).message;
    log(`ERROR loading tickets: ${ticketError}`);
  }
  try {
    const allocationPct = args.allowancePercent ?? nightAllowance ?? project.allowancePercent;
    const source = args.allowancePercent !== undefined ? "--allowance override" : nightAllowance !== undefined ? "tonight.md" : "project default";
    budget = startNightBudget(allocationPct);
    log(`Tonight's allocation: ${allocationPct}% (${source}). Started at ${budget.startPct}%, cap ${budget.capPct}%.`);
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
  if (!ticketError) {
    try {
      tickets = loadTickets(project.ticketsFile, { names: Object.keys(project.repos), defaultRepo: project.defaultRepo });
      log(`Loaded ${tickets.length} ticket(s) from ${path.basename(project.ticketsFile)}`);
    } catch (e) {
      ticketError = (e as Error).message;
      log(`ERROR loading tickets: ${ticketError}`);
    }
  }

  const processed = new Map<string, ProcessedTicket>();
  const needsTestDb = tickets.some(t => project.repos[t.repo].toolchain === "node");
  const testDb = !dryRun && project.testDbScript && needsTestDb ? startTestDb(log, undefined, process.env, project.testDbScript) : undefined;
  try {
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
        results.push(placeholderResult(ticket, "skipped", skipReason, branchPrefix));
        continue;
      }

      try {
        const r = await processTicket(ticket, project, branchPrefix, instructions, dryRun, budgetRef, processed);
        results.push(r);
      } catch (e) {
        log(`  ERROR processing ${ticket.id}: ${(e as Error).message}`);
        results.push(placeholderResult(ticket, "error", (e as Error).message, branchPrefix));
      }
    }
  } finally {
    testDb?.stop();
  }

  const session: SessionResult = {
    date,
    startedAt,
    endedAt: new Date().toLocaleString("en-US", { timeZone: TIME_ZONE }),
    tickets: results,
    budget: budgetRef.current,
    gateHit,
    skipReason,
    noTasks: tickets.length === 0 && !ticketError,
    ...(ticketError ? { ticketError } : {}),
  };
  mkdirSync(reportsDir, { recursive: true });
  const base = reportBase(date, name => existsSync(path.join(reportsDir, name)));
  session.postmortem = await nightPostmortem(session, project, dryRun, reportsDir, budgetRef, base);

  try {
    if (!closedAtStart) budgetRef.current = checkGate(budgetRef.current);
  } catch (e) {
    log(`Final usage check failed: ${(e as Error).message}`);
    logUsageFailure(e, "  ");
  }
  session.budget = budgetRef.current;
  session.endedAt = new Date().toLocaleString("en-US", { timeZone: TIME_ZONE });

  // Write report
  const reportPath = writeReport(session, reportsDir, base);
  log(`\n═══ Report written: ${reportPath} ═══`);
  log(`Open in browser: file://${reportPath}`);

  if (!dryRun && tickets.length > 0) {
    const archivePath = path.join(reportsDir, `${base}-tonight.md`);
    archiveTickets(archivePath, project.ticketsFile);
    log(`Tickets archived: ${archivePath}`);
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
