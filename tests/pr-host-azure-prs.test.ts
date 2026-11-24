import { describe, expect, it, vi } from "vitest";
import type { Exec } from "../src/exec.js";
import { makeContext } from "../src/pr-hosts/azure-devops/az.js";
import { currentUser, listOpenPrs, prListArgs, toPullRequest, voteSummary } from "../src/pr-hosts/azure-devops/prs.js";

const env: Record<string, string> = { AZURE_DEVOPS_ORG: "myorg", AZURE_DEVOPS_PROJECT: "P" };
const ctxWith = (exec: Exec, extra: Record<string, string> = {}) => makeContext(n => ({ ...env, ...extra })[n], exec);

describe("voteSummary", () => {
  it("counts approvals, waiting and rejections", () => {
    expect(voteSummary([{ vote: 10 }, { vote: 5 }, { vote: 0 }, { vote: -5 }, { vote: -10 }])).toEqual({ approved: 2, waiting: 1, rejected: 1 });
  });

  it("is all zeros without reviewers", () => {
    expect(voteSummary(undefined)).toEqual({ approved: 0, waiting: 0, rejected: 0 });
  });
});

describe("prListArgs", () => {
  it("lists active PRs for a repository", () => {
    expect(prListArgs("https://dev.azure.com/o", "P", "app")).toEqual([
      "repos", "pr", "list", "--org", "https://dev.azure.com/o", "--project", "P", "--repository", "app", "--status", "active", "--top", "200",
    ]);
  });
});

describe("toPullRequest", () => {
  it("normalizes refs, author, draft flag, votes and url", () => {
    const ctx = ctxWith(vi.fn<Exec>());
    expect(toPullRequest(ctx, "app", {
      pullRequestId: 7, sourceRefName: "refs/heads/ENG-1", targetRefName: "refs/heads/main", autoCompleteSetBy: {},
      title: "t", description: "d", isDraft: true, createdBy: { uniqueName: "Me@Acme.com" }, reviewers: [{ vote: 10 }],
    })).toEqual({
      prId: 7, sourceBranch: "ENG-1", targetBranch: "main", autoComplete: true,
      url: "https://dev.azure.com/myorg/P/_git/app/pullrequest/7",
      title: "t", description: "d", author: "me@acme.com", isDraft: true, votes: { approved: 1, waiting: 0, rejected: 0 },
    });
  });

  it("leaves author undefined and flags false when absent", () => {
    const pr = toPullRequest(ctxWith(vi.fn<Exec>()), "app", { pullRequestId: 1, sourceRefName: "refs/heads/a", targetRefName: "refs/heads/b" });
    expect(pr).toMatchObject({ author: undefined, isDraft: false, autoComplete: false });
  });
});

describe("listOpenPrs", () => {
  it("resolves the repo from origin and lists active PRs with the project env", async () => {
    const raw = [{ pullRequestId: 7, sourceRefName: "refs/heads/ENG-1", targetRefName: "refs/heads/main" }];
    const exec = vi.fn<Exec>(async cmd =>
      cmd === "git" ? { stdout: "git@ssh.dev.azure.com:v3/o/P/app\n", stderr: "" } : { stdout: JSON.stringify(raw), stderr: "" });
    const ctx = ctxWith(exec);
    const result = await listOpenPrs(ctx, "/r/app");
    expect(result.repoName).toBe("app");
    expect(result.prs.map(p => p.prId)).toEqual([7]);
    const [gitCmd, gitArgs, gitOpts] = exec.mock.calls[0];
    expect([gitCmd, gitArgs, gitOpts.cwd]).toEqual(["git", ["remote", "get-url", "origin"], "/r/app"]);
    const [azCmd, azArgs, azOpts] = exec.mock.calls[1];
    expect(azCmd).toBe("az");
    expect(azArgs).toEqual([...prListArgs("https://dev.azure.com/myorg", "P", "app"), "--output", "json"]);
    expect(azOpts.env).toBe(ctx.env);
  });

  it("treats empty az output as no PRs", async () => {
    const exec: Exec = async cmd => ({ stdout: cmd === "git" ? "https://x/_git/app" : "", stderr: "" });
    expect(await listOpenPrs(ctxWith(exec), "/r/app")).toEqual({ repoName: "app", prs: [] });
  });

  it("fails naming the missing org or project", async () => {
    const exec: Exec = async cmd => ({ stdout: cmd === "git" ? "https://x/_git/app" : "[]", stderr: "" });
    await expect(listOpenPrs(makeContext(n => (n === "AZURE_DEVOPS_PROJECT" ? "P" : undefined), exec), "/r"))
      .rejects.toThrow("AZURE_DEVOPS_ORG not found in environment or .env file");
    await expect(listOpenPrs(makeContext(n => (n === "AZURE_DEVOPS_ORG" ? "o" : undefined), exec), "/r"))
      .rejects.toThrow("AZURE_DEVOPS_PROJECT not found in environment or .env file");
  });
});

describe("currentUser", () => {
  it("uses the AZURE_DEVOPS_USER override without calling az", async () => {
    const exec = vi.fn<Exec>();
    expect(await currentUser(ctxWith(exec, { AZURE_DEVOPS_USER: "Me@Acme.com" }))).toBe("me@acme.com");
    expect(exec).not.toHaveBeenCalled();
  });

  it("asks az account show and lowercases the name", async () => {
    const exec = vi.fn<Exec>(async () => ({ stdout: JSON.stringify({ user: { name: "Me@Acme.com" } }), stderr: "" }));
    expect(await currentUser(ctxWith(exec))).toBe("me@acme.com");
    expect(exec.mock.calls[0].slice(0, 2)).toEqual(["az", ["account", "show", "--output", "json"]]);
  });

  it("rejects with the original az error", async () => {
    const failure = new Error("Please run 'az login'");
    const exec: Exec = async () => { throw failure; };
    await expect(currentUser(ctxWith(exec))).rejects.toBe(failure);
  });
});
