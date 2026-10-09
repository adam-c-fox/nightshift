import { execFileSync } from "node:child_process";
import { getEnv, requireEnv } from "./env.js";
import type { PipelineStatus, ReviewRisk, TicketConflict, TicketResult } from "./types.js";

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const NO_POLICY_GRACE_MS = 60_000;
const FRESHNESS_GRACE_MS = 60_000;
const AZ_TIMEOUT_MS = 60_000;
const CI_POLICY_TYPES = ["build", "status"];
export const DEFAULT_BASE_BRANCH = "main";

export interface FailedCheck {
  name: string;
  buildId: number | undefined;
}

export interface PRResult {
  prId: number;
  url: string;
  pipelineStatus: PipelineStatus;
  failedChecks: FailedCheck[];
  unknownReason?: string;
  durationSec: number;
}

export interface PolicyWaitResult {
  status: PipelineStatus;
  failedChecks: FailedCheck[];
  unknownReason?: string;
}

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

export type PolicyVerdict = PipelineStatus | "pending" | "none";

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

export function summarizePolicies(evaluations: PolicyEvaluation[]): PolicyVerdict {
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

export function orgUrl(org: string): string {
  const trimmed = org.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://dev.azure.com/${trimmed}`;
}

export function buildPrWebUrl(org: string, project: string, repoName: string, prId: number): string {
  return `${orgUrl(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${prId}`;
}

const SUMMARY_TITLE_MAX = 80;

export function buildPrTitle(ticketId: string, title: string, summary: string): string {
  const text = title.trim() || summary.split("\n")[0].trim().slice(0, SUMMARY_TITLE_MAX);
  const withoutId = text.replace(new RegExp(`\\s*\\(${ticketId}\\)\\s*$`), "").trim();
  return `${withoutId} (${ticketId})`;
}

export interface PrContent {
  ticketId: string;
  title: string;
  summary: string;
  verifyCommands: string[];
  ticketUrl?: string;
  risks: ReviewRisk[];
  conflicts: TicketConflict[];
  stackedOn?: { ticketId: string; prId: number };
}

export function prContent(result: TicketResult): PrContent {
  return {
    ticketId: result.ticket.id, title: result.title ?? "", summary: result.summary,
    verifyCommands: result.verifyCommands, ticketUrl: result.linear?.url,
    risks: result.review?.risks ?? [],
    conflicts: result.review?.conflicts ?? [],
  };
}

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

export function buildPrDescription(
  ticketId: string, summary: string, verifyCommands: string[], ticketUrl?: string, risks: ReviewRisk[] = [],
  stackedOn?: { ticketId: string; prId: number }, conflicts: TicketConflict[] = [],
): string {
  const ticket = ticketUrl ? `[${ticketId}](${ticketUrl})` : ticketId;
  const needsDecision = conflicts.length > 0
    ? ["", "Needs a decision before merge:", ...conflicts.map(c =>
        `- \`${c.file}\`: ${c.ticket ? `The ticket asks for "${c.ticket}". ` : ""}${sentence(c.consequence)} Suggested change: ${sentence(c.change)}`)]
    : [];
  const worthALook = risks.length > 0
    ? ["", "Worth a closer look:", ...risks.map(r => `- \`${r.file}\`: ${r.risk}`)]
    : [];
  const verify = verifyCommands.length > 0
    ? ["", "To verify locally:", ...verifyCommands.map(c => `- \`${c}\``)]
    : [];
  const stacked = stackedOn ? [`Stacked on PR #${stackedOn.prId} (${stackedOn.ticketId}); merge that first.`, ""] : [];
  return [`Ticket: ${ticket}`, "", ...stacked, summary, ...needsDecision, ...worthALook, ...verify].join("\n").slice(0, 4000);
}

export function azEnvFrom(lookup: (name: string) => string | undefined): NodeJS.ProcessEnv {
  const pat = lookup("AZURE_DEVOPS_EXT_PAT") ?? lookup("AZURE_DEVOPS_PAT");
  return pat ? { ...process.env, AZURE_DEVOPS_EXT_PAT: pat } : process.env;
}

const azEnv = () => azEnvFrom(getEnv);

export function parseAzOutput(out: string): unknown {
  return out.trim() === "" ? null : JSON.parse(out);
}

export function az(args: string[], cwd?: string): unknown {
  const out = execFileSync("az", [...args, "--output", "json"], {
    encoding: "utf-8",
    cwd,
    env: azEnv(),
    timeout: AZ_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseAzOutput(out);
}

export function pushBranch(worktreePath: string, localBranch: string, remoteBranch: string = localBranch): void {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "push", "origin", `${localBranch}:refs/heads/${remoteBranch}`], {
    cwd: worktreePath,
    env: azEnv(),
    encoding: "utf-8",
    timeout: 5 * 60 * 1000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface AzReviewer { displayName?: string; vote: number }
export interface AzPullRequest {
  pullRequestId: number;
  sourceRefName: string;
  targetRefName: string;
  autoCompleteSetBy?: unknown;
  title?: string;
  status?: string;
  isDraft?: boolean;
  reviewers?: AzReviewer[];
}
export interface VoteSummary { approved: number; waiting: number; rejected: number }

const APPROVING_VOTES = [10, 5];
const WAITING_VOTE = -5;
const REJECTING_VOTE = -10;

export function voteSummary(reviewers: AzReviewer[] | undefined): VoteSummary {
  const votes = (reviewers ?? []).map(r => r.vote);
  return {
    approved: votes.filter(v => APPROVING_VOTES.includes(v)).length,
    waiting: votes.filter(v => v === WAITING_VOTE).length,
    rejected: votes.filter(v => v === REJECTING_VOTE).length,
  };
}
export interface ExistingPr { prId: number; sourceBranch: string; targetBranch: string; autoComplete: boolean }

export function repoNameFromRemote(remoteUrl: string): string {
  const last = remoteUrl.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

const stripHeads = (ref: string) => ref.replace(/^refs\/heads\//, "");

export function pickTicketPr(prs: AzPullRequest[], expectedBranch: string): ExistingPr | null {
  const exact = `refs/heads/${expectedBranch}`;
  const isTicketBranch = (ref: string) => ref === exact || (ref.startsWith(`${exact}-`) && /^\d+$/.test(ref.slice(exact.length + 1)));
  const matches = prs.filter(p => isTicketBranch(p.sourceRefName));
  if (matches.length === 0) return null;
  const best = matches.reduce((a, b) => (b.pullRequestId > a.pullRequestId ? b : a));
  return { prId: best.pullRequestId, sourceBranch: stripHeads(best.sourceRefName), targetBranch: stripHeads(best.targetRefName), autoComplete: Boolean(best.autoCompleteSetBy) };
}

export type PrAction = "update" | "open" | "hold";

export function prAction(existing: ExistingPr | null, startedFromPr: boolean): PrAction {
  if (!existing || !startedFromPr) return "open";
  return existing.autoComplete ? "hold" : "update";
}

export const ORIGIN_URL_ARGS = ["remote", "get-url", "origin"];

export const prListArgs = (org: string, project: string, repoName: string): string[] => [
  "repos", "pr", "list",
  "--org", org,
  "--project", project,
  "--repository", repoName,
  "--status", "active",
  "--top", "200",
];

function originUrl(cwd: string): string {
  return execFileSync("git", ORIGIN_URL_ARGS, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function findOpenTicketPr(expectedBranch: string, repoPath: string): ExistingPr | null {
  const org = orgUrl(requireEnv("AZURE_DEVOPS_ORG"));
  const project = requireEnv("AZURE_DEVOPS_PROJECT");
  const prs = (az(prListArgs(org, project, repoNameFromRemote(originUrl(repoPath)))) ?? []) as AzPullRequest[];
  return pickTicketPr(prs, expectedBranch);
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

export function summarizeRuns(runs: PipelineRun[]): "pending" | "succeeded" | "failed" {
  if (!runs.every(r => r.status.toLowerCase() === "completed")) return "pending";
  return runs.every(r => r.result?.toLowerCase() === "succeeded") ? "succeeded" : "failed";
}

const NO_MAIN_BUILD_POLICY = "no build policy on main to run for the branch";
const BRANCH_BUILD_UNFINISHED = "branch build did not finish or could not be queued";
const MAIN_POLICY_LOOKUP_FAILED = "could not look up main's build policies";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const MAX_CONSECUTIVE_POLICY_ERRORS = 5;

export function policyListArgs(prId: number, org: string): string[] {
  return ["repos", "pr", "policy", "list", "--id", String(prId), "--org", org];
}

function errorText(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  return err.stderr?.toString().trim() || err.message || String(e);
}

export async function waitForPolicies(
  fetchEvaluations: () => PolicyEvaluation[],
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
    let verdict: PolicyVerdict = "pending";
    try {
      const evaluations = fetchEvaluations();
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
    queueRun: (definition: BuildDefinition) => number;
    fetchRun: (runId: number) => PipelineRun;
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
    for (const definition of definitions) queued.push({ definition, runId: opts.queueRun(definition) });
  } catch (e) {
    log(`  Queueing branch build failed: ${errorText(e)}`);
    return unknown(BRANCH_BUILD_UNFINISHED);
  }
  let consecutiveErrors = 0;
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const runs = queued.map(q => opts.fetchRun(q.runId));
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
  fetchCommit: () => string | undefined,
  sha: string,
  opts: { timeoutMs: number; intervalMs: number; log?: (msg: string) => void },
): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    try {
      if (fetchCommit() === sha) return true;
    } catch (e) {
      log(`  PR commit check failed: ${errorText(e)}`);
    }
    await sleep(opts.intervalMs);
  }
  return false;
}

interface PolicyWaitOptions { timeoutMs?: number; intervalMs?: number; log?: (msg: string) => void }

function waitForPrPolicies(
  prId: number, org: string, options: PolicyWaitOptions, extra: { timeoutMs?: number; requireFreshEvaluation?: boolean } = {},
): Promise<PolicyWaitResult> {
  return waitForPolicies(
    () => (az(policyListArgs(prId, org)) ?? []) as PolicyEvaluation[],
    {
      timeoutMs: extra.timeoutMs ?? options.timeoutMs ?? POLL_TIMEOUT_MS,
      intervalMs: options.intervalMs ?? POLL_INTERVAL_MS,
      requireFreshEvaluation: extra.requireFreshEvaluation,
      log: options.log,
    },
  );
}

function waitForBranchPipelines(
  branch: string, org: string, project: string, repoPath: string, options: PolicyWaitOptions, timeoutMs?: number,
): Promise<PolicyWaitResult> {
  let definitions: BuildDefinition[];
  try {
    const repo = az(repoShowArgs(org, project, repoNameFromRemote(originUrl(repoPath)))) as { id: string };
    definitions = mainBuildDefinitions((az(mainPolicyListArgs(org, project, repo.id)) ?? []) as PolicyConfiguration[]);
  } catch (e) {
    options.log?.(`  Looking up main's build policies failed: ${errorText(e)}`);
    return Promise.resolve({ status: "unknown", failedChecks: [], unknownReason: MAIN_POLICY_LOOKUP_FAILED });
  }
  return waitForBranchBuilds(definitions, {
    queueRun: d => (az(pipelineRunArgs(org, project, d.id, branch)) as { id: number }).id,
    fetchRun: id => az(pipelineRunShowArgs(org, project, id)) as PipelineRun,
    timeoutMs: timeoutMs ?? options.timeoutMs ?? POLL_TIMEOUT_MS,
    intervalMs: options.intervalMs ?? POLL_INTERVAL_MS,
    log: options.log,
  });
}

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
    "--title", pr.title, "--description", pr.description,
  ];
}

export function prShowArgs(prId: number, org: string): string[] {
  return ["repos", "pr", "show", "--id", String(prId), "--org", org];
}

export async function createAndCheckPR(
  content: PrContent,
  branch: string,
  targetBranch: string,
  worktreePath: string,
  options: PolicyWaitOptions = {},
): Promise<PRResult> {
  const org = orgUrl(requireEnv("AZURE_DEVOPS_ORG"));
  const project = requireEnv("AZURE_DEVOPS_PROJECT");
  const start = Date.now();

  pushBranch(worktreePath, branch);

  const created = az(prCreateArgs({
    org,
    project,
    repository: repoNameFromRemote(originUrl(worktreePath)),
    sourceBranch: branch,
    targetBranch,
    title: buildPrTitle(content.ticketId, content.title, content.summary),
    description: buildPrDescription(content.ticketId, content.summary, content.verifyCommands, content.ticketUrl, content.risks, content.stackedOn, content.conflicts),
  }), worktreePath) as { pullRequestId: number; repository: { name: string } };

  const prId = created.pullRequestId;
  const url = buildPrWebUrl(org, project, created.repository.name, prId);
  const { status: pipelineStatus, failedChecks, unknownReason } = targetBranch === DEFAULT_BASE_BRANCH
    ? await waitForPrPolicies(prId, org, options)
    : await waitForBranchPipelines(branch, org, project, worktreePath, options);

  return { prId, url, pipelineStatus, failedChecks, unknownReason, durationSec: Math.round((Date.now() - start) / 1000) };
}

export function existingPrWebUrl(existing: ExistingPr, repoPath: string): string {
  return buildPrWebUrl(
    requireEnv("AZURE_DEVOPS_ORG"), requireEnv("AZURE_DEVOPS_PROJECT"), repoNameFromRemote(originUrl(repoPath)), existing.prId,
  );
}

export async function updateAndCheckPR(
  existing: ExistingPr,
  localBranch: string,
  worktreePath: string,
  options: PolicyWaitOptions = {},
): Promise<PRResult> {
  const org = orgUrl(requireEnv("AZURE_DEVOPS_ORG"));
  const project = requireEnv("AZURE_DEVOPS_PROJECT");
  const start = Date.now();

  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const url = existingPrWebUrl(existing, worktreePath);
  pushBranch(worktreePath, localBranch, existing.sourceBranch);

  const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS;
  const seen = await waitForPrCommit(
    () => (az(prShowArgs(existing.prId, org)) as { lastMergeSourceCommit?: { commitId?: string } } | null)?.lastMergeSourceCommit?.commitId,
    sha,
    { timeoutMs, intervalMs: options.intervalMs ?? POLL_INTERVAL_MS, log: options.log },
  );
  const remaining = Math.max(0, timeoutMs - (Date.now() - start));
  const waited: PolicyWaitResult = !seen
    ? { status: "unknown", failedChecks: [] }
    : existing.targetBranch === DEFAULT_BASE_BRANCH
      ? await waitForPrPolicies(existing.prId, org, options, { timeoutMs: remaining, requireFreshEvaluation: true })
      : await waitForBranchPipelines(existing.sourceBranch, org, project, worktreePath, options, remaining);
  const { status: pipelineStatus, failedChecks, unknownReason } = waited;

  return { prId: existing.prId, url, pipelineStatus, failedChecks, unknownReason, durationSec: Math.round((Date.now() - start) / 1000) };
}
