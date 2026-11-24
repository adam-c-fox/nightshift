import { capFailures, stripTimestamps, tailLines, type CiFailure } from "../../ci-logs.js";
import type { CheckWaitOptions, CiVerdict } from "../../pr-host.js";
import { DEFAULT_BASE_BRANCH, buildPrDescription, buildPrTitle, type ExistingPr, type FailedCheck, type PRResult, type PrContent } from "../../pr.js";
import { azJson, azOrg, azProject, prWebUrl, repoNameAt, type AzContext } from "./az.js";

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const NO_POLICY_GRACE_MS = 60_000;
const FRESHNESS_GRACE_MS = 60_000;
const PUSH_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_POLICY_ERRORS = 5;
const CI_POLICY_TYPES = ["build", "status"];
const TAIL_LINES = 150;

export interface PolicyWaitResult {
  status: PipelineStatus;
  failedChecks: FailedCheck[];
  unknownReason?: string;
}

type PipelineStatus = PRResult["pipelineStatus"];

export interface PolicyEvaluation {
  status: string;
  context?: { buildId?: number };
  configuration?: {
    isEnabled?: boolean;
    isBlocking?: boolean;
    type?: { displayName?: string };
    settings?: { displayName?: string };
  };
}

function requiredChecks(evaluations: PolicyEvaluation[]): PolicyEvaluation[] {
  return evaluations.filter(e => {
    const config = e.configuration;
    const type = config?.type?.displayName?.toLowerCase() ?? "";
    return config?.isEnabled !== false
      && config?.isBlocking === true
      && CI_POLICY_TYPES.includes(type)
      && e.status.toLowerCase() !== "notapplicable";
  });
}

const FAILED_STATUSES = ["rejected", "broken"];
const TERMINAL_STATUSES = ["approved", ...FAILED_STATUSES];

export function summarizePolicies(evaluations: PolicyEvaluation[]): CiVerdict {
  const statuses = requiredChecks(evaluations).map(e => e.status.toLowerCase());
  if (statuses.length === 0) return "none";
  if (!statuses.every(s => TERMINAL_STATUSES.includes(s))) return "pending";
  return statuses.some(s => FAILED_STATUSES.includes(s)) ? "failed" : "succeeded";
}

export function failedChecks(evaluations: PolicyEvaluation[]): FailedCheck[] {
  return requiredChecks(evaluations)
    .filter(e => FAILED_STATUSES.includes(e.status.toLowerCase()))
    .map(e => ({
      name: e.configuration?.settings?.displayName || e.configuration?.type?.displayName || "unnamed check",
      buildId: e.context?.buildId,
    }));
}

export interface PolicyConfiguration {
  isEnabled?: boolean;
  isBlocking?: boolean;
  type?: { displayName?: string };
  settings?: { buildDefinitionId?: number; displayName?: string };
}

export interface BuildDefinition { id: number; name: string }
export interface PipelineRun { status: string; result?: string }

export function mainBuildDefinitions(policies: PolicyConfiguration[]): BuildDefinition[] {
  const byId = new Map<number, BuildDefinition>();
  for (const p of policies) {
    const id = p.settings?.buildDefinitionId;
    if (id === undefined || p.isEnabled === false || p.isBlocking !== true || p.type?.displayName?.toLowerCase() !== "build") continue;
    if (!byId.has(id)) byId.set(id, { id, name: p.settings?.displayName || `build ${id}` });
  }
  return [...byId.values()];
}

export const repoShowArgs = (org: string, project: string, repository: string): string[] =>
  ["repos", "show", "--org", org, "--project", project, "--repository", repository];

export const mainPolicyListArgs = (org: string, project: string, repositoryId: string): string[] =>
  ["repos", "policy", "list", "--org", org, "--project", project, "--repository-id", repositoryId, "--branch", DEFAULT_BASE_BRANCH];

export const pipelineRunArgs = (org: string, project: string, definitionId: number, branch: string): string[] =>
  ["pipelines", "run", "--org", org, "--project", project, "--id", String(definitionId), "--branch", branch];

export const pipelineRunShowArgs = (org: string, project: string, runId: number): string[] =>
  ["pipelines", "runs", "show", "--org", org, "--project", project, "--id", String(runId)];

export const policyListArgs = (prId: number, org: string): string[] =>
  ["repos", "pr", "policy", "list", "--id", String(prId), "--org", org];

export const prShowArgs = (prId: number, org: string): string[] =>
  ["repos", "pr", "show", "--id", String(prId), "--org", org];

export interface PrCreateInput {
  org: string;
  project: string;
  repository: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export function prCreateArgs(pr: PrCreateInput): string[] {
  return [
    "repos", "pr", "create",
    "--org", pr.org, "--project", pr.project, "--repository", pr.repository,
    "--source-branch", pr.sourceBranch, "--target-branch", pr.targetBranch,
    "--title", pr.title, "--description", pr.description, "--draft", "true",
  ];
}

export function summarizeRuns(runs: PipelineRun[]): "pending" | "succeeded" | "failed" {
  if (!runs.every(r => r.status.toLowerCase() === "completed")) return "pending";
  return runs.every(r => r.result?.toLowerCase() === "succeeded") ? "succeeded" : "failed";
}

const NO_MAIN_BUILD_POLICY = "no build policy on main to run for the branch";
const BRANCH_BUILD_UNFINISHED = "branch build did not finish or could not be queued";
const MAIN_POLICY_LOOKUP_FAILED = "could not look up main's build policies";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function errorText(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  return err.stderr?.toString().trim() || err.message || String(e);
}

export async function waitForPolicies(
  fetchEvaluations: () => Promise<PolicyEvaluation[]>,
  opts: {
    timeoutMs: number;
    intervalMs: number;
    noPolicyGraceMs?: number;
    maxConsecutiveErrors?: number;
    requireFreshEvaluation?: boolean;
    freshnessGraceMs?: number;
    log?: (msg: string) => void;
  },
): Promise<PolicyWaitResult> {
  const grace = opts.noPolicyGraceMs ?? NO_POLICY_GRACE_MS;
  const maxErrors = opts.maxConsecutiveErrors ?? MAX_CONSECUTIVE_POLICY_ERRORS;
  const log = opts.log ?? (() => {});
  const start = Date.now();
  const freshnessGrace = opts.freshnessGraceMs ?? FRESHNESS_GRACE_MS;
  let consecutiveErrors = 0;
  let sawPending = false;
  let failed: FailedCheck[] = [];
  while (Date.now() - start < opts.timeoutMs) {
    let verdict: CiVerdict = "pending";
    try {
      const evaluations = await fetchEvaluations();
      verdict = summarizePolicies(evaluations);
      failed = failedChecks(evaluations);
      consecutiveErrors = 0;
      if (verdict === "pending") sawPending = true;
    } catch (e) {
      consecutiveErrors++;
      log(`  Policy check failed (${consecutiveErrors}/${maxErrors}): ${errorText(e)}`);
      if (consecutiveErrors >= maxErrors) return { status: "unknown", failedChecks: [] };
    }
    const fresh = !opts.requireFreshEvaluation || sawPending || Date.now() - start >= freshnessGrace;
    if ((verdict === "succeeded" || verdict === "failed") && fresh) return { status: verdict, failedChecks: verdict === "failed" ? failed : [] };
    if (verdict === "none" && Date.now() - start >= grace) return { status: "unknown", failedChecks: [] };
    await sleep(opts.intervalMs);
  }
  return { status: "unknown", failedChecks: [] };
}

export async function waitForBranchBuilds(
  definitions: BuildDefinition[],
  opts: {
    queueRun: (definition: BuildDefinition) => Promise<number>;
    fetchRun: (runId: number) => Promise<PipelineRun>;
    timeoutMs: number;
    intervalMs: number;
    maxConsecutiveErrors?: number;
    log?: (msg: string) => void;
  },
): Promise<PolicyWaitResult> {
  const log = opts.log ?? (() => {});
  const maxErrors = opts.maxConsecutiveErrors ?? MAX_CONSECUTIVE_POLICY_ERRORS;
  const unknown = (unknownReason: string): PolicyWaitResult => ({ status: "unknown", failedChecks: [], unknownReason });
  if (definitions.length === 0) return unknown(NO_MAIN_BUILD_POLICY);
  const start = Date.now();
  const queued: { definition: BuildDefinition; runId: number }[] = [];
  try {
    for (const definition of definitions) queued.push({ definition, runId: await opts.queueRun(definition) });
  } catch (e) {
    log(`  Queueing branch build failed: ${errorText(e)}`);
    return unknown(BRANCH_BUILD_UNFINISHED);
  }
  let consecutiveErrors = 0;
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const runs: PipelineRun[] = [];
      for (const q of queued) runs.push(await opts.fetchRun(q.runId));
      consecutiveErrors = 0;
      const verdict = summarizeRuns(runs);
      if (verdict === "succeeded") return { status: "succeeded", failedChecks: [] };
      if (verdict === "failed") {
        const failed = queued.filter((_, i) => runs[i].result?.toLowerCase() !== "succeeded").map(q => ({ name: q.definition.name, buildId: q.runId }));
        return { status: "failed", failedChecks: failed };
      }
    } catch (e) {
      consecutiveErrors++;
      log(`  Branch build check failed (${consecutiveErrors}/${maxErrors}): ${errorText(e)}`);
      if (consecutiveErrors >= maxErrors) return unknown(BRANCH_BUILD_UNFINISHED);
    }
    await sleep(opts.intervalMs);
  }
  return unknown(BRANCH_BUILD_UNFINISHED);
}

export async function waitForPrCommit(
  fetchCommit: () => Promise<string | undefined>,
  sha: string,
  opts: { timeoutMs: number; intervalMs: number; log?: (msg: string) => void },
): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    try {
      if ((await fetchCommit()) === sha) return true;
    } catch (e) {
      log(`  PR commit check failed: ${errorText(e)}`);
    }
    await sleep(opts.intervalMs);
  }
  return false;
}

async function pushBranch(ctx: AzContext, worktreePath: string, localBranch: string, remoteBranch: string = localBranch): Promise<void> {
  await ctx.exec("git", ["-c", "core.hooksPath=/dev/null", "push", "origin", `${localBranch}:refs/heads/${remoteBranch}`], {
    cwd: worktreePath,
    env: ctx.env,
    timeoutMs: PUSH_TIMEOUT_MS,
  });
}

const fetchPolicies = async (ctx: AzContext, prId: number): Promise<PolicyEvaluation[]> =>
  ((await azJson(ctx, policyListArgs(prId, azOrg(ctx)))) ?? []) as PolicyEvaluation[];

function waitForPrPolicies(
  ctx: AzContext, prId: number, options: CheckWaitOptions, extra: { timeoutMs?: number; requireFreshEvaluation?: boolean } = {},
): Promise<PolicyWaitResult> {
  return waitForPolicies(() => fetchPolicies(ctx, prId), {
    timeoutMs: extra.timeoutMs ?? options.timeoutMs ?? POLL_TIMEOUT_MS,
    intervalMs: options.intervalMs ?? POLL_INTERVAL_MS,
    requireFreshEvaluation: extra.requireFreshEvaluation,
    log: options.log,
  });
}

async function waitForBranchPipelines(
  ctx: AzContext, branch: string, repoPath: string, options: CheckWaitOptions, timeoutMs?: number,
): Promise<PolicyWaitResult> {
  const org = azOrg(ctx);
  const project = azProject(ctx);
  let definitions: BuildDefinition[];
  try {
    const repo = (await azJson(ctx, repoShowArgs(org, project, await repoNameAt(ctx, repoPath)))) as { id: string };
    definitions = mainBuildDefinitions(((await azJson(ctx, mainPolicyListArgs(org, project, repo.id))) ?? []) as PolicyConfiguration[]);
  } catch (e) {
    options.log?.(`  Looking up main's build policies failed: ${errorText(e)}`);
    return { status: "unknown", failedChecks: [], unknownReason: MAIN_POLICY_LOOKUP_FAILED };
  }
  return waitForBranchBuilds(definitions, {
    queueRun: async d => ((await azJson(ctx, pipelineRunArgs(org, project, d.id, branch))) as { id: number }).id,
    fetchRun: async id => (await azJson(ctx, pipelineRunShowArgs(org, project, id))) as PipelineRun,
    timeoutMs: timeoutMs ?? options.timeoutMs ?? POLL_TIMEOUT_MS,
    intervalMs: options.intervalMs ?? POLL_INTERVAL_MS,
    log: options.log,
  });
}

export async function openPr(
  ctx: AzContext, content: PrContent, branch: string, targetBranch: string, worktreePath: string, opts: CheckWaitOptions = {},
): Promise<PRResult> {
  const org = azOrg(ctx);
  const project = azProject(ctx);
  const start = Date.now();
  await pushBranch(ctx, worktreePath, branch);

  const created = (await azJson(ctx, prCreateArgs({
    org,
    project,
    repository: await repoNameAt(ctx, worktreePath),
    sourceBranch: branch,
    targetBranch,
    title: buildPrTitle(content.ticketId, content.title, content.summary),
    description: buildPrDescription(content.ticketId, content.summary, content.verifyCommands, content.ticketUrl, content.risks, content.stackedOn, content.conflicts),
  }), worktreePath)) as { pullRequestId: number; repository: { name: string } };

  const prId = created.pullRequestId;
  const url = prWebUrl(ctx, created.repository.name, prId);
  const { status: pipelineStatus, failedChecks, unknownReason } = targetBranch === DEFAULT_BASE_BRANCH
    ? await waitForPrPolicies(ctx, prId, opts)
    : await waitForBranchPipelines(ctx, branch, worktreePath, opts);

  return { prId, url, pipelineStatus, failedChecks, unknownReason, durationSec: Math.round((Date.now() - start) / 1000) };
}

export async function updatePr(
  ctx: AzContext, existing: ExistingPr, localBranch: string, worktreePath: string, opts: CheckWaitOptions = {},
): Promise<PRResult> {
  const org = azOrg(ctx);
  azProject(ctx);
  const start = Date.now();
  const { stdout } = await ctx.exec("git", ["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: PUSH_TIMEOUT_MS });
  const sha = stdout.trim();
  await pushBranch(ctx, worktreePath, localBranch, existing.sourceBranch);

  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
  const seen = await waitForPrCommit(
    async () => ((await azJson(ctx, prShowArgs(existing.prId, org))) as { lastMergeSourceCommit?: { commitId?: string } } | null)?.lastMergeSourceCommit?.commitId,
    sha,
    { timeoutMs, intervalMs: opts.intervalMs ?? POLL_INTERVAL_MS, log: opts.log },
  );
  const remaining = Math.max(0, timeoutMs - (Date.now() - start));
  const waited: PolicyWaitResult = !seen
    ? { status: "unknown", failedChecks: [] }
    : existing.targetBranch === DEFAULT_BASE_BRANCH
      ? await waitForPrPolicies(ctx, existing.prId, opts, { timeoutMs: remaining, requireFreshEvaluation: true })
      : await waitForBranchPipelines(ctx, existing.sourceBranch, worktreePath, opts, remaining);
  const { status: pipelineStatus, failedChecks, unknownReason } = waited;

  return { prId: existing.prId, url: existing.url, pipelineStatus, failedChecks, unknownReason, durationSec: Math.round((Date.now() - start) / 1000) };
}

export async function ciVerdict(ctx: AzContext, _repoPath: string, prId: number): Promise<CiVerdict> {
  return summarizePolicies(await fetchPolicies(ctx, prId));
}

export interface TimelineRecord {
  type: string;
  name: string;
  result?: string | null;
  log?: { id?: number } | null;
  issues?: { type?: string; message?: string }[] | null;
}

export interface FailedTask {
  name: string;
  logId: number | undefined;
  issues: string[];
}

export function failedTasks(records: TimelineRecord[]): FailedTask[] {
  return records
    .filter(r => r.type === "Task" && r.result === "failed")
    .map(r => ({
      name: r.name,
      logId: r.log?.id,
      issues: (r.issues ?? []).filter(i => i.type !== "warning" && i.message).map(i => i.message!),
    }));
}

export function ciTimelineArgs(org: string, project: string, buildId: number): string[] {
  return ["devops", "invoke", "--area", "build", "--resource", "timeline", "--route-parameters", `project=${project}`, `buildId=${buildId}`, "--org", org];
}

export function ciLogArgs(org: string, project: string, buildId: number, logId: number): string[] {
  return ["devops", "invoke", "--area", "build", "--resource", "logs", "--route-parameters", `project=${project}`, `buildId=${buildId}`, `logId=${logId}`, "--org", org];
}

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0];

async function failuresForCheck(ctx: AzContext, check: FailedCheck): Promise<CiFailure[]> {
  const org = azOrg(ctx);
  const project = azProject(ctx);
  const unavailable = (error: string): CiFailure[] => [{ check: check.name, task: "", issues: [], tail: "", error }];
  if (check.buildId === undefined) return unavailable("no build id on the policy evaluation");
  const buildId = check.buildId;
  let tasks: FailedTask[];
  try {
    const timeline = (await azJson(ctx, ciTimelineArgs(org, project, buildId))) as { records?: TimelineRecord[] } | null;
    tasks = failedTasks(timeline?.records ?? []);
  } catch (e) {
    return unavailable(`could not fetch build timeline: ${firstLine(e)}`);
  }
  if (tasks.length === 0) return unavailable("no failed task found in the build timeline");
  return Promise.all(tasks.map(async task => {
    const base = { check: check.name, task: task.name, issues: task.issues };
    if (task.logId === undefined) return { ...base, tail: "", error: "task has no log" };
    try {
      const log = (await azJson(ctx, ciLogArgs(org, project, buildId, task.logId))) as { value?: string[] } | null;
      return { ...base, tail: tailLines(stripTimestamps(log?.value ?? []), TAIL_LINES).join("\n") };
    } catch (e) {
      return { ...base, tail: "", error: `could not fetch log: ${firstLine(e)}` };
    }
  }));
}

export async function ciFailures(ctx: AzContext, _repoPath: string, checks: FailedCheck[]): Promise<CiFailure[]> {
  const perCheck = await Promise.all(checks.map(check => failuresForCheck(ctx, check)));
  return capFailures(perCheck.flat());
}
