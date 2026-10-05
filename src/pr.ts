import { execFileSync } from "node:child_process";
import { getEnv, requireEnv } from "./env.js";
import type { PipelineStatus, ReviewRisk, TicketResult } from "./types.js";

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const NO_POLICY_GRACE_MS = 60_000;
const FRESHNESS_GRACE_MS = 60_000;
const AZ_TIMEOUT_MS = 60_000;
const CI_POLICY_TYPES = ["build", "status"];

export interface FailedCheck {
  name: string;
  buildId: number | undefined;
}

export interface PRResult {
  prId: number;
  url: string;
  pipelineStatus: PipelineStatus;
  failedChecks: FailedCheck[];
  durationSec: number;
}

export interface PolicyWaitResult {
  status: PipelineStatus;
  failedChecks: FailedCheck[];
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
  stackedOn?: { ticketId: string; prId: number };
}

export function prContent(result: TicketResult): PrContent {
  return {
    ticketId: result.ticket.id, title: result.title ?? "", summary: result.summary,
    verifyCommands: result.verifyCommands, ticketUrl: result.linear?.url,
    risks: result.review?.risks ?? [],
  };
}

export function buildPrDescription(
  ticketId: string, summary: string, verifyCommands: string[], ticketUrl?: string, risks: ReviewRisk[] = [],
  stackedOn?: { ticketId: string; prId: number },
): string {
  const ticket = ticketUrl ? `[${ticketId}](${ticketUrl})` : ticketId;
  const worthALook = risks.length > 0
    ? ["", "Worth a closer look:", ...risks.map(r => `- \`${r.file}\`: ${r.risk}`)]
    : [];
  const verify = verifyCommands.length > 0
    ? ["", "To verify locally:", ...verifyCommands.map(c => `- \`${c}\``)]
    : [];
  const stacked = stackedOn ? [`Stacked on PR #${stackedOn.prId} (${stackedOn.ticketId}); merge that first.`, ""] : [];
  return [`Ticket: ${ticket}`, "", ...stacked, summary, ...worthALook, ...verify].join("\n").slice(0, 4000);
}

function azEnv(): NodeJS.ProcessEnv {
  const pat = getEnv("AZURE_DEVOPS_EXT_PAT") ?? getEnv("AZURE_DEVOPS_PAT");
  return pat ? { ...process.env, AZURE_DEVOPS_EXT_PAT: pat } : process.env;
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
  return out.trim() === "" ? null : JSON.parse(out);
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

export interface AzPullRequest { pullRequestId: number; sourceRefName: string; targetRefName: string; autoCompleteSetBy?: unknown }
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

function originUrl(cwd: string): string {
  return execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function findOpenTicketPr(expectedBranch: string, repoPath: string): ExistingPr | null {
  const org = orgUrl(requireEnv("AZURE_DEVOPS_ORG"));
  const project = requireEnv("AZURE_DEVOPS_PROJECT");
  const prs = (az([
    "repos", "pr", "list",
    "--org", org,
    "--project", project,
    "--repository", repoNameFromRemote(originUrl(repoPath)),
    "--status", "active",
    "--top", "200",
  ]) ?? []) as AzPullRequest[];
  return pickTicketPr(prs, expectedBranch);
}

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
    description: buildPrDescription(content.ticketId, content.summary, content.verifyCommands, content.ticketUrl, content.risks, content.stackedOn),
  }), worktreePath) as { pullRequestId: number; repository: { name: string } };

  const prId = created.pullRequestId;
  const url = buildPrWebUrl(org, project, created.repository.name, prId);
  const { status: pipelineStatus, failedChecks } = await waitForPrPolicies(prId, org, options);

  return { prId, url, pipelineStatus, failedChecks, durationSec: Math.round((Date.now() - start) / 1000) };
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
  const { status: pipelineStatus, failedChecks }: PolicyWaitResult = seen
    ? await waitForPrPolicies(existing.prId, org, options, { timeoutMs: remaining, requireFreshEvaluation: true })
    : { status: "unknown", failedChecks: [] };

  return { prId: existing.prId, url, pipelineStatus, failedChecks, durationSec: Math.round((Date.now() - start) / 1000) };
}
