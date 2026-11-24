import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ExecError, type Exec } from "../src/exec.js";
import { createPrHost, detectPrHost } from "../src/pr-host.js";
import { azureDevOps } from "../src/pr-hosts/azure-devops/index.js";
import { LOGIN_ERROR, describePrHostContract, type FakeWorld, type HostFixture } from "./pr-host-contract.js";

const HEAD_SHA = "newsha";
const STALE_SHA = "oldsha";
const REPO_ID = "repo-id";
const POLICY_BUILD_BASE = 1000;
const DEFINITION_BASE = 2000;
const RUN_BASE = 3000;

const lookup = (name: string) => ({ AZURE_DEVOPS_ORG: "o", AZURE_DEVOPS_PROJECT: "P" })[name];
const json = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "" });
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
const routeParam = (args: string[], name: string) =>
  args.slice(args.indexOf("--route-parameters") + 1).find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);

const votesToReviewers = ({ approved, waiting, rejected }: FakeWorld["prs"][number]["votes"]) => [
  ...Array(approved).fill({ vote: 10 }), ...Array(waiting).fill({ vote: -5 }), ...Array(rejected).fill({ vote: -10 }),
];

function azureFixture(world: FakeWorld): HostFixture {
  const pushes: ReturnType<HostFixture["pushes"]> = [];
  const created: ReturnType<HostFixture["createdPrs"]> = [];
  const replies: ReturnType<HostFixture["replies"]> = [];
  const resolved: ReturnType<HostFixture["resolved"]> = [];
  let pushedToExisting = false;
  let policyCallsSincePush = 0;
  let nextCommentId = 100;
  const origin = `https://dev.azure.com/o/P/_git/${world.repoName}`;

  const evaluation = (check: FakeWorld["requiredChecks"][number], index: number, status: string) => ({
    status,
    context: { buildId: POLICY_BUILD_BASE + index },
    configuration: { isEnabled: true, isBlocking: true, type: { displayName: "Build" }, settings: { displayName: check.name } },
  });
  const realStatus = { passed: "approved", failed: "rejected", pending: "running" } as const;

  const policyEvaluations = () => {
    const stage = pushedToExisting ? policyCallsSincePush++ : 2;
    const status = (check: FakeWorld["requiredChecks"][number]) =>
      stage === 0 ? "approved" : stage === 1 ? "running" : realStatus[check.state];
    return world.requiredChecks.map((check, i) => evaluation(check, i, status(check)));
  };

  const buildIndex = (buildId: number) => buildId % 1000;

  const invoke = (args: string[]) => {
    const resource = flag(args, "--resource");
    const method = flag(args, "--http-method");
    const prId = Number(routeParam(args, "pullRequestId"));
    if (resource === "timeline") {
      const check = world.requiredChecks[buildIndex(Number(routeParam(args, "buildId")))];
      return json({ records: [{ type: "Task", name: check.failedStep ?? "step", result: "failed", log: { id: 7 }, issues: [] }] });
    }
    if (resource === "logs") {
      const check = world.requiredChecks[buildIndex(Number(routeParam(args, "buildId")))];
      if (check.logTail === undefined) throw new ExecError("log not found", "", "log not found", 1);
      return json({ value: check.logTail.split("\n") });
    }
    if (resource === "pullRequestThreads" && method === "GET") {
      const threads = (world.threads[prId] ?? []).map(t => ({
        id: t.id,
        status: t.resolved ? "fixed" : "active",
        threadContext: t.file ? { filePath: `/${t.file}`, rightFileStart: { line: t.line } } : null,
        comments: t.comments.map(c => ({
          id: c.id, content: c.text, commentType: "text", author: { displayName: c.author, descriptor: c.bot ? "s2s.bot" : "aad.user" },
        })),
      }));
      return json({ value: threads });
    }
    const body = JSON.parse(readFileSync(flag(args, "--in-file"), "utf-8"));
    const threadId = Number(routeParam(args, "threadId"));
    if (resource === "pullRequestThreadComments" && method === "POST") {
      replies.push({ prId, threadId, parentCommentId: body.parentCommentId, text: body.content });
      return json({ id: nextCommentId++ });
    }
    if (resource === "pullRequestThreads" && method === "PATCH") {
      resolved.push({ prId, threadId });
      return json({ id: threadId });
    }
    throw new Error(`unexpected devops invoke: ${args.join(" ")}`);
  };

  const exec: Exec = async (cmd, args, opts) => {
    if (cmd === "git") {
      if (args.includes("remote")) return { stdout: `${origin}\n`, stderr: "" };
      if (args.includes("rev-parse")) return { stdout: `${HEAD_SHA}\n`, stderr: "" };
      if (args.includes("push")) {
        const [branch, remoteRef] = args[args.length - 1].split(":");
        const remoteBranch = remoteRef.replace(/^refs\/heads\//, "");
        pushes.push({ branch, remoteBranch });
        if (world.prs.some(p => p.source === remoteBranch)) pushedToExisting = true;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected git: ${args.join(" ")}`);
    }
    if (cmd !== "az") throw new Error(`unexpected command: ${cmd}`);
    if (!world.loggedIn) throw new ExecError(LOGIN_ERROR, "", LOGIN_ERROR, 1);
    expect(opts.timeoutMs).toBeGreaterThan(0);
    const firstFlag = args.findIndex(a => a.startsWith("--"));
    const verb = args.slice(0, firstFlag === -1 ? args.length : firstFlag).join(" ");
    switch (verb) {
      case "account show":
        return json({ user: { name: world.me } });
      case "repos pr list":
        return json(world.prs.map(p => ({
          pullRequestId: p.id,
          sourceRefName: `refs/heads/${p.source}`,
          targetRefName: `refs/heads/${p.target}`,
          title: p.title,
          description: "",
          status: "active",
          isDraft: p.draft,
          ...(p.autoComplete ? { autoCompleteSetBy: { id: "u" } } : {}),
          createdBy: { uniqueName: p.author },
          reviewers: votesToReviewers(p.votes),
        })));
      case "repos pr create": {
        created.push({
          source: flag(args, "--source-branch"), target: flag(args, "--target-branch"),
          draft: flag(args, "--draft") === "true", title: flag(args, "--title"),
        });
        return json({ pullRequestId: 200, repository: { name: world.repoName } });
      }
      case "repos pr show": {
        const seen = pushedToExisting && world.prSeesPushes !== false;
        return json({ pullRequestId: Number(flag(args, "--id")), lastMergeSourceCommit: { commitId: seen ? HEAD_SHA : STALE_SHA } });
      }
      case "repos pr policy list":
        return json(policyEvaluations());
      case "repos show":
        return json({ id: REPO_ID });
      case "repos policy list":
        return json(world.requiredChecks.map((check, i) => ({
          isEnabled: true, isBlocking: true, type: { displayName: "Build" },
          settings: { buildDefinitionId: DEFINITION_BASE + i, displayName: check.name },
        })));
      case "pipelines run":
        return json({ id: RUN_BASE + (Number(flag(args, "--id")) - DEFINITION_BASE) });
      case "pipelines runs show": {
        const check = world.requiredChecks[buildIndex(Number(flag(args, "--id")))];
        return json(check.state === "pending" ? { status: "inProgress" } : { status: "completed", result: check.state === "passed" ? "succeeded" : "failed" });
      }
      case "devops invoke":
        return invoke(args);
    }
    throw new Error(`unexpected az: ${args.join(" ")}`);
  };

  return {
    host: createPrHost("azure-devops", lookup, exec),
    pushes: () => pushes,
    createdPrs: () => created,
    replies: () => replies,
    resolved: () => resolved,
  };
}

describePrHostContract("azure-devops", azureFixture);

describe("azure-devops origin detection", () => {
  const cases: [string, { org: string; project: string } | undefined][] = [
    ["git@ssh.dev.azure.com:v3/acme/My%20Project/app", { org: "acme", project: "My Project" }],
    ["https://dev.azure.com/acme/Proj/_git/app", { org: "acme", project: "Proj" }],
    ["https://acme@dev.azure.com/acme/My%20Project/_git/app", { org: "acme", project: "My Project" }],
    ["https://acme.visualstudio.com/Proj/_git/app", { org: "acme", project: "Proj" }],
    ["ssh://git@ssh.dev.azure.com/v3/acme/My%20Project/app", { org: "acme", project: "My Project" }],
    ["git@ssh.dev.azure.com:v3/acme/Proj/app.git", { org: "acme", project: "Proj" }],
    ["https://dev.azure.com/acme/Proj/_git/app/", { org: "acme", project: "Proj" }],
    ["https://acme.visualstudio.com/Proj/_git/app.git", { org: "acme", project: "Proj" }],
    ["https://dev.azure.com/acme/_git/app", { org: "acme", project: "app" }],
    ["https://acme.visualstudio.com/_git/app", { org: "acme", project: "app" }],
    ["https://acme.visualstudio.com/DefaultCollection/_git/app", { org: "acme", project: "app" }],
    ["https://acme.visualstudio.com/DefaultCollection/Proj/_git/app", { org: "acme", project: "Proj" }],
    ["https://dev.azure.com/My%20Org/Proj/_git/app", { org: "My Org", project: "Proj" }],
    ["https://github.com/acme/app.git", undefined],
    ["git@github.com:acme/app.git", undefined],
  ];

  it.each(cases)("%s", (url, expected) => {
    expect(azureDevOps.matchesRemote(url)).toBe(expected !== undefined);
    expect(azureDevOps.envFromRemote(url)).toEqual(
      expected ? { AZURE_DEVOPS_ORG: expected.org, AZURE_DEVOPS_PROJECT: expected.project } : {},
    );
    expect(detectPrHost(url)).toBe(expected ? "azure-devops" : undefined);
  });
});
