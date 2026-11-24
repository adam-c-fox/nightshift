import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReviewThread } from "../../pr-host.js";
import { azJson, azOrg, azProject, type AzContext } from "./az.js";

export interface AzComment { id: number; content?: string; commentType?: string; isDeleted?: boolean; author?: { displayName?: string; descriptor?: string }; publishedDate?: string }
export interface AzThread { id: number; status?: string; isDeleted?: boolean; properties?: Record<string, unknown>; threadContext?: { filePath?: string; rightFileStart?: { line: number } } | null; comments: AzComment[] }
export interface ThreadTarget { org: string; project: string; repoName: string; prId: number }

const OPEN_STATUSES = ["active", "pending"];

const isTextComment = (c: AzComment): boolean =>
  c.commentType === "text" && !c.isDeleted && !c.author?.descriptor?.startsWith("s2s.");

export function toReviewThread(thread: AzThread): ReviewThread | null {
  if (!OPEN_STATUSES.includes(thread.status ?? "") || thread.isDeleted) return null;
  return {
    id: thread.id,
    file: thread.threadContext?.filePath?.replace(/^\//, ""),
    line: thread.threadContext?.rightFileStart?.line,
    comments: thread.comments.filter(isTextComment).map(c => ({ id: c.id, author: c.author?.displayName ?? "unknown", text: c.content ?? "" })),
  };
}

function invokeArgs(t: ThreadTarget, resource: string, method: string, threadId?: number, inFile?: string): string[] {
  return [
    "devops", "invoke", "--org", t.org, "--area", "git", "--resource", resource,
    "--route-parameters", `project=${t.project}`, `repositoryId=${t.repoName}`, `pullRequestId=${t.prId}`,
    ...(threadId === undefined ? [] : [`threadId=${threadId}`]),
    "--api-version", "7.1", "--http-method", method,
    ...(inFile ? ["--in-file", inFile] : []),
  ];
}

export const threadListArgs = (t: ThreadTarget): string[] => invokeArgs(t, "pullRequestThreads", "GET");
export const threadReplyArgs = (t: ThreadTarget, threadId: number, inFile: string): string[] =>
  invokeArgs(t, "pullRequestThreadComments", "POST", threadId, inFile);
export const threadStatusArgs = (t: ThreadTarget, threadId: number, inFile: string): string[] =>
  invokeArgs(t, "pullRequestThreads", "PATCH", threadId, inFile);

const targetOf = (ctx: AzContext, repoName: string, prId: number): ThreadTarget =>
  ({ org: azOrg(ctx), project: azProject(ctx), repoName, prId });

async function withBody<T>(body: unknown, call: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nightshift-thread-"));
  try {
    const file = path.join(dir, "body.json");
    await writeFile(file, JSON.stringify(body));
    return await call(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function listThreads(ctx: AzContext, repoName: string, prId: number): Promise<ReviewThread[]> {
  const { value } = (await azJson(ctx, threadListArgs(targetOf(ctx, repoName, prId)))) as { value: AzThread[] };
  return value.map(toReviewThread).filter((t): t is ReviewThread => t !== null);
}

export async function replyToThread(
  ctx: AzContext, repoName: string, prId: number, threadId: number, parentCommentId: number, text: string,
): Promise<number> {
  const body = { content: text, parentCommentId, commentType: 1 };
  const t = targetOf(ctx, repoName, prId);
  return withBody(body, async file => ((await azJson(ctx, threadReplyArgs(t, threadId, file))) as { id: number }).id);
}

export async function resolveThread(ctx: AzContext, repoName: string, prId: number, threadId: number): Promise<void> {
  const t = targetOf(ctx, repoName, prId);
  await withBody({ status: "fixed" }, async file => { await azJson(ctx, threadStatusArgs(t, threadId, file)); });
}
