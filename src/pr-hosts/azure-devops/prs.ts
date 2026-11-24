import type { OpenPrList, PullRequest, VoteSummary } from "../../pr-host.js";
import { azJson, azOrg, azProject, prWebUrl, repoNameAt, type AzContext } from "./az.js";

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
  createdBy?: { uniqueName?: string };
  description?: string;
}

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

export const prListArgs = (org: string, project: string, repoName: string): string[] => [
  "repos", "pr", "list",
  "--org", org,
  "--project", project,
  "--repository", repoName,
  "--status", "active",
  "--top", "200",
];

const stripHeads = (ref: string) => ref.replace(/^refs\/heads\//, "");

export const toPullRequest = (ctx: AzContext, repoName: string, p: AzPullRequest): PullRequest => ({
  prId: p.pullRequestId,
  sourceBranch: stripHeads(p.sourceRefName),
  targetBranch: stripHeads(p.targetRefName),
  autoComplete: Boolean(p.autoCompleteSetBy),
  url: prWebUrl(ctx, repoName, p.pullRequestId),
  title: p.title,
  description: p.description,
  author: p.createdBy?.uniqueName?.toLowerCase(),
  isDraft: Boolean(p.isDraft),
  votes: voteSummary(p.reviewers),
});

export async function currentUser(ctx: AzContext): Promise<string> {
  const configured = ctx.lookup("AZURE_DEVOPS_USER");
  if (configured) return configured.toLowerCase();
  const account = (await azJson(ctx, ["account", "show"])) as { user: { name: string } };
  return account.user.name.toLowerCase();
}

export async function listOpenPrs(ctx: AzContext, repoPath: string): Promise<OpenPrList> {
  const repoName = await repoNameAt(ctx, repoPath);
  const prs = ((await azJson(ctx, prListArgs(azOrg(ctx), azProject(ctx), repoName))) ?? []) as AzPullRequest[];
  return { repoName, prs: prs.map(p => toPullRequest(ctx, repoName, p)) };
}
