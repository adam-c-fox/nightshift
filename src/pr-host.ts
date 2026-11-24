import type { CiFailure } from "./ci-logs.js";
import { execAsync, type Exec } from "./exec.js";
import type { ExistingPr, FailedCheck, PRResult, PrContent } from "./pr.js";
import { azureDevOps } from "./pr-hosts/azure-devops/index.js";
import type { PipelineStatus } from "./types.js";

/** Project env lookup (process env, then project .env, then root .env). */
export type EnvLookup = (name: string) => string | undefined;

/** Reviewer verdicts on a PR. */
export interface VoteSummary { approved: number; waiting: number; rejected: number }
/** Combined state of a PR's required checks. */
export type CiVerdict = PipelineStatus | "pending" | "none";

/** An open PR, normalized. */
export interface PullRequest extends ExistingPr {
  title?: string;
  description?: string;
  /** Lowercased identity comparable with currentUser(). */
  author?: string;
  isDraft: boolean;
  votes: VoteSummary;
}
/** Open PRs for one local repo. repoName is the host's name for it: the prKey/state key, passed back to thread calls. */
export interface OpenPrList { repoName: string; prs: PullRequest[] }

/** One human text comment in a review thread (bots and system comments already dropped). */
export interface ThreadComment { id: number; author: string; text: string }
/** An unresolved review thread. Comment ids increase over time. */
export interface ReviewThread { id: number; file?: string; line?: number; comments: ThreadComment[] }

/** Polling knobs for check waits. */
export interface CheckWaitOptions { timeoutMs?: number; intervalMs?: number; log?: (msg: string) => void }

/** Every method is async; errors are the host's own, passed through unchanged. */
export interface PrHost {
  /** The authenticated user, lowercased, as PullRequest.author reports it. Doubles as the login check. */
  currentUser(): Promise<string>;
  /** Active PRs for the repo checked out at repoPath. */
  listOpenPrs(repoPath: string): Promise<OpenPrList>;
  /** Push branch, open a draft PR into targetBranch, wait for its required checks (stacked targets included). */
  openPr(content: PrContent, branch: string, targetBranch: string, worktreePath: string, opts?: CheckWaitOptions): Promise<PRResult>;
  /** Push localBranch to an existing PR's branch, wait until the PR sees the commit, then wait for fresh checks. */
  updatePr(existing: ExistingPr, localBranch: string, worktreePath: string, opts?: CheckWaitOptions): Promise<PRResult>;
  /** Current required-check verdict of one PR, without waiting. */
  ciVerdict(repoPath: string, prId: number): Promise<CiVerdict>;
  /** Failed step names, issues and log tails for checks openPr/updatePr reported as failed. */
  ciFailures(repoPath: string, checks: FailedCheck[]): Promise<CiFailure[]>;
  /** Unresolved review threads with their human comments. */
  listThreads(repoName: string, prId: number): Promise<ReviewThread[]>;
  /** Reply in a thread; returns the new comment id. */
  replyToThread(repoName: string, prId: number, threadId: number, parentCommentId: number, text: string): Promise<number>;
  /** Mark a thread resolved. */
  resolveThread(repoName: string, prId: number, threadId: number): Promise<void>;
}

/** Static facts about a host, usable before a project's env is loaded. */
export interface PrHostDescriptor {
  /** Builds the host; reads its env lazily, so construction never throws. */
  create(lookup: EnvLookup, exec: Exec): PrHost;
  /** Whether a git origin URL lives on this host. */
  matchesRemote(remoteUrl: string): boolean;
  /** The project .env values derivable from an origin URL on this host. */
  envFromRemote(remoteUrl: string): Record<string, string>;
  /** Project .env keys this host needs set. */
  envKeys: string[];
  /** Credential env keys; optional, and ignored when comparing .env to .env.example. */
  secretEnvKeys: string[];
  /** Domains the agent sandbox must never reach. */
  agentDeniedDomains: string[];
}

/** Every supported host. Adding a host = one entry here. */
export const PR_HOSTS = { "azure-devops": azureDevOps } satisfies Record<string, PrHostDescriptor>;
/** One supported PR host; the value of project.json "prHost". */
export type PrHostKind = keyof typeof PR_HOSTS;
export const PR_HOST_KINDS = Object.keys(PR_HOSTS) as PrHostKind[];

/** Union over all hosts, so agent-env and the .env check need no project context. */
export const PR_HOST_SECRET_KEYS = PR_HOST_KINDS.flatMap(k => PR_HOSTS[k].secretEnvKeys);
export const PR_HOST_DENIED_DOMAINS = PR_HOST_KINDS.flatMap(k => PR_HOSTS[k].agentDeniedDomains);

export const createPrHost = (kind: PrHostKind, lookup: EnvLookup, exec: Exec = execAsync): PrHost =>
  PR_HOSTS[kind].create(lookup, exec);

export const detectPrHost = (remoteUrl: string): PrHostKind | undefined =>
  PR_HOST_KINDS.find(k => PR_HOSTS[k].matchesRemote(remoteUrl));
