import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Exec } from "../src/exec.js";
import {
  listThreads, replyToThread, resolveThread, threadListArgs, threadReplyArgs, threadStatusArgs, toReviewThread,
  type AzComment, type AzThread, type ThreadTarget,
} from "../src/pr-hosts/azure-devops/threads.js";
import { makeContext } from "../src/pr-hosts/azure-devops/az.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/pr-threads.json", import.meta.url), "utf-8")).value as AzThread[];
const target: ThreadTarget = { org: "https://dev.azure.com/o", project: "P", repoName: "R", prId: 5 };
const human = (id: number, content: string, extra: Partial<AzComment> = {}): AzComment => ({
  id, content, commentType: "text", author: { displayName: "Rev", descriptor: "aad.X" }, ...extra,
});
const thread = (id: number, comments: AzComment[], extra: Partial<AzThread> = {}): AzThread => ({
  id, status: "active", comments, threadContext: null, ...extra,
});

describe("toReviewThread", () => {
  it("keeps open threads from the fixture and drops closed ones", () => {
    const kept = fixture.map(toReviewThread).filter(t => t !== null);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(fixture.length);
    for (const t of kept) {
      expect(t.file ?? "").not.toMatch(/^\//);
      expect(t.comments.length).toBeGreaterThanOrEqual(0);
    }
    const line = kept.find(t => t.file !== undefined);
    expect(line?.line).toEqual(expect.any(Number));
  });

  it("accepts active and pending, drops other statuses and deleted threads", () => {
    const ids = [
      thread(1, [human(1, "a")], { status: "pending" }),
      thread(2, [human(1, "b")], { status: "wontFix" }),
      thread(3, [human(1, "c")], { status: "closed" }),
      thread(4, [human(1, "d")], { isDeleted: true }),
      thread(5, [human(1, "e")], { status: undefined }),
      thread(6, [human(1, "f")]),
    ].map(toReviewThread).filter(t => t !== null).map(t => t.id);
    expect(ids).toEqual([1, 6]);
  });

  it("drops deleted, non-text and s2s comments but keeps a thread left without comments", () => {
    const t = thread(1, [
      human(1, "x", { isDeleted: true }),
      human(2, "y", { author: { descriptor: "s2s.BOT" } }),
      human(3, "z", { commentType: "system" }),
      human(4, "kept"),
    ]);
    expect(toReviewThread(t)?.comments).toEqual([{ id: 4, author: "Rev", text: "kept" }]);
    expect(toReviewThread(thread(2, [human(1, "x", { isDeleted: true })]))?.comments).toEqual([]);
  });

  it("strips the leading slash from the path, keeps the line and defaults author and text", () => {
    const t = thread(1, [{ id: 1, commentType: "text" }], { threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 12 } } });
    expect(toReviewThread(t)).toEqual({ id: 1, file: "src/a.ts", line: 12, comments: [{ id: 1, author: "unknown", text: "" }] });
  });

  it("leaves file and line unset without a thread context", () => {
    const t = toReviewThread(thread(1, [human(1, "a")]));
    expect(t?.file).toBeUndefined();
    expect(t?.line).toBeUndefined();
  });
});

describe("thread az commands", () => {
  it("builds the list args", () => {
    expect(threadListArgs(target)).toEqual([
      "devops", "invoke", "--org", "https://dev.azure.com/o", "--area", "git", "--resource", "pullRequestThreads",
      "--route-parameters", "project=P", "repositoryId=R", "pullRequestId=5",
      "--api-version", "7.1", "--http-method", "GET",
    ]);
  });

  it("builds the reply args", () => {
    expect(threadReplyArgs(target, 9, "/f.json")).toEqual([
      "devops", "invoke", "--org", "https://dev.azure.com/o", "--area", "git", "--resource", "pullRequestThreadComments",
      "--route-parameters", "project=P", "repositoryId=R", "pullRequestId=5", "threadId=9",
      "--api-version", "7.1", "--http-method", "POST", "--in-file", "/f.json",
    ]);
  });

  it("builds the status args", () => {
    expect(threadStatusArgs(target, 9, "/f.json")).toEqual([
      "devops", "invoke", "--org", "https://dev.azure.com/o", "--area", "git", "--resource", "pullRequestThreads",
      "--route-parameters", "project=P", "repositoryId=R", "pullRequestId=5", "threadId=9",
      "--api-version", "7.1", "--http-method", "PATCH", "--in-file", "/f.json",
    ]);
  });
});

function recordingContext(reply: unknown) {
  const calls: { args: string[]; body?: unknown; fileExistedDuringCall?: boolean; inFile?: string }[] = [];
  const exec: Exec = async (_cmd, args) => {
    const i = args.indexOf("--in-file");
    const inFile = i === -1 ? undefined : args[i + 1];
    calls.push({ args, inFile, fileExistedDuringCall: inFile ? existsSync(inFile) : undefined, body: inFile ? JSON.parse(readFileSync(inFile, "utf-8")) : undefined });
    return { stdout: JSON.stringify(reply), stderr: "" };
  };
  const lookup = (name: string) => ({ AZURE_DEVOPS_ORG: "o", AZURE_DEVOPS_PROJECT: "P" })[name];
  return { ctx: makeContext(lookup, exec), calls };
}

describe("thread operations", () => {
  it("listThreads issues the GET and maps open threads", async () => {
    const { ctx, calls } = recordingContext({ value: [thread(1, [human(1, "a")]), thread(2, [human(1, "b")], { status: "closed" })] });
    expect(await listThreads(ctx, "R", 5)).toEqual([{ id: 1, file: undefined, line: undefined, comments: [{ id: 1, author: "Rev", text: "a" }] }]);
    expect(calls[0].args.slice(0, -2)).toEqual(threadListArgs(target));
  });

  it("replyToThread posts the comment body, returns the new id and removes the temp file", async () => {
    const { ctx, calls } = recordingContext({ id: 42 });
    expect(await replyToThread(ctx, "R", 5, 9, 3, "Done")).toBe(42);
    expect(calls[0].body).toEqual({ content: "Done", parentCommentId: 3, commentType: 1 });
    expect(calls[0].fileExistedDuringCall).toBe(true);
    expect(calls[0].args.slice(0, -2)).toEqual(threadReplyArgs(target, 9, calls[0].inFile!));
    expect(existsSync(calls[0].inFile!)).toBe(false);
  });

  it("resolveThread patches the status to fixed and removes the temp file", async () => {
    const { ctx, calls } = recordingContext({ id: 9 });
    await resolveThread(ctx, "R", 5, 9);
    expect(calls[0].body).toEqual({ status: "fixed" });
    expect(calls[0].args.slice(0, -2)).toEqual(threadStatusArgs(target, 9, calls[0].inFile!));
    expect(existsSync(calls[0].inFile!)).toBe(false);
  });

  it("removes the temp file when the call fails", async () => {
    let inFile = "";
    const exec: Exec = async (_c, args) => { inFile = args[args.indexOf("--in-file") + 1]; throw new Error("boom"); };
    const ctx = makeContext(name => ({ AZURE_DEVOPS_ORG: "o", AZURE_DEVOPS_PROJECT: "P" })[name], exec);
    await expect(resolveThread(ctx, "R", 5, 9)).rejects.toThrow("boom");
    expect(existsSync(inFile)).toBe(false);
  });
});
