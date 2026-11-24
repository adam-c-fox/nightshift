import { describe, expect, it } from "vitest";
import { ExecError, type Exec, type ExecOptions } from "../src/exec.js";
import type { PrContent } from "../src/pr.js";
import { makeContext } from "../src/pr-hosts/azure-devops/az.js";
import { ciFailures, ciVerdict, openPr, updatePr } from "../src/pr-hosts/azure-devops/checks.js";

const lookup = (name: string) => ({ AZURE_DEVOPS_ORG: "o", AZURE_DEVOPS_PROJECT: "P" })[name];
const POLL = { intervalMs: 0, timeoutMs: 200 };
const content: PrContent = { ticketId: "ENG-1", title: "Fix export", summary: "Fixed.", verifyCommands: [], risks: [], conflicts: [] };
const existing = { prId: 5, sourceBranch: "night/ENG-1", targetBranch: "main", autoComplete: false, url: "https://example.test/pr/5" };

const policy = (status: string) => [{
  status, context: { buildId: 9 },
  configuration: { isEnabled: true, isBlocking: true, type: { displayName: "Build" }, settings: { displayName: "build", buildDefinitionId: 2 } },
}];

type Handler = (args: string[], opts: ExecOptions) => unknown;

function recorder(handlers: Record<string, Handler>) {
  const calls: { label: string; args: string[]; opts: ExecOptions }[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    const named = args.findIndex(a => a.startsWith("--"));
    const verbs = cmd === "git" ? args.filter(a => ["push", "rev-parse", "remote"].includes(a)) : args.slice(0, named < 0 ? args.length : named);
    const label = `${cmd} ${verbs.join(" ")}`;
    calls.push({ label, args, opts });
    const handler = handlers[label];
    if (!handler) throw new Error(`unexpected ${label}`);
    const out = handler(args, opts);
    return { stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "" };
  };
  return { ctx: makeContext(lookup, exec), labels: () => calls.map(c => c.label), calls };
}

const git = { "git remote": () => "https://dev.azure.com/o/P/_git/app\n", "git rev-parse": () => "newsha\n", "git push": () => "" };
const created = { "az repos pr create": () => ({ pullRequestId: 7, repository: { name: "app" } }) };

describe("azure checks sequences", () => {
  it("openPr into main pushes, creates a draft and polls PR policies", async () => {
    const r = recorder({ ...git, ...created, "az repos pr policy list": () => policy("approved") });
    const result = await openPr(r.ctx, content, "night/ENG-1", "main", "/wt", POLL);
    expect(r.labels()).toEqual(["git push", "git remote", "az repos pr create", "az repos pr policy list"]);
    const push = r.calls.find(c => c.label === "git push")!;
    expect(push.args).toEqual(["-c", "core.hooksPath=/dev/null", "push", "origin", "night/ENG-1:refs/heads/night/ENG-1"]);
    expect(push.opts).toMatchObject({ cwd: "/wt", timeoutMs: 5 * 60 * 1000 });
    expect(r.calls.find(c => c.label === "az repos pr create")!.args).toContain("true");
    expect(result).toMatchObject({ prId: 7, pipelineStatus: "succeeded", url: "https://dev.azure.com/o/P/_git/app/pullrequest/7" });
  });

  it("openPr into a stacked target runs main's build policies on the branch", async () => {
    const r = recorder({
      ...git, ...created,
      "az repos show": () => ({ id: "rid" }),
      "az repos policy list": () => [{ isEnabled: true, isBlocking: true, type: { displayName: "Build" }, settings: { buildDefinitionId: 2, displayName: "build" } }],
      "az pipelines run": () => ({ id: 30 }),
      "az pipelines runs show": () => ({ status: "completed", result: "failed" }),
    });
    const result = await openPr(r.ctx, content, "night/ENG-1", "night/ENG-0", "/wt", POLL);
    expect(r.labels()).toEqual([
      "git push", "git remote", "az repos pr create", "git remote", "az repos show", "az repos policy list", "az pipelines run", "az pipelines runs show",
    ]);
    expect(result).toMatchObject({ pipelineStatus: "failed", failedChecks: [{ name: "build", buildId: 30 }] });
  });

  it("updatePr pushes to the PR branch, waits for the commit, then needs a fresh policy list", async () => {
    let shows = 0;
    let lists = 0;
    const r = recorder({
      ...git,
      "az repos pr show": () => ({ lastMergeSourceCommit: { commitId: ++shows < 3 ? "old" : "newsha" } }),
      "az repos pr policy list": () => policy(++lists === 1 ? "running" : "rejected"),
    });
    const result = await updatePr(r.ctx, existing, "local", "/wt", { intervalMs: 0, timeoutMs: 400, log: () => {} });
    expect(r.labels().filter(l => l !== "git remote")).toEqual([
      "git rev-parse", "git push", "az repos pr show", "az repos pr show", "az repos pr show", "az repos pr policy list", "az repos pr policy list",
    ]);
    expect(r.calls.find(c => c.label === "git push")!.args.at(-1)).toBe("local:refs/heads/night/ENG-1");
    expect(result).toMatchObject({ prId: 5, url: existing.url, pipelineStatus: "failed" });
  });

  it("updatePr reports unknown when the PR never sees the commit", async () => {
    const r = recorder({ ...git, "az repos pr show": () => ({ lastMergeSourceCommit: { commitId: "old" } }) });
    const result = await updatePr(r.ctx, existing, "local", "/wt", { intervalMs: 0, timeoutMs: 30 });
    expect(result.pipelineStatus).toBe("unknown");
    expect(r.labels()).not.toContain("az repos pr policy list");
  });

  it("ciVerdict summarises the policy list, treating null as none", async () => {
    const pending = recorder({ "az repos pr policy list": () => policy("running") });
    expect(await ciVerdict(pending.ctx, "/r", 5)).toBe("pending");
    const empty = recorder({ "az repos pr policy list": () => "" });
    expect(await ciVerdict(empty.ctx, "/r", 5)).toBe("none");
  });
});

describe("azure ciFailures", () => {
  const timeline = { records: [{ type: "Task", name: "npm test", result: "failed", log: { id: 4 }, issues: [{ type: "error", message: "boom" }] }] };

  it("returns the failed task with a timestamp-stripped log tail", async () => {
    const r = recorder({
      "az devops invoke": args => (args.includes("timeline") ? timeline : { value: ["2026-01-01T00:00:00.0Z one", "two"] }),
    });
    const failures = await ciFailures(r.ctx, "/r", [{ name: "build", buildId: 9 }]);
    expect(failures).toEqual([{ check: "build", task: "npm test", issues: ["boom"], tail: "one\ntwo" }]);
  });

  it("keeps an error entry when the log fetch fails", async () => {
    const r = recorder({
      "az devops invoke": args => {
        if (args.includes("timeline")) return timeline;
        throw new ExecError("log not found", "", "log not found", 1);
      },
    });
    const [failure] = await ciFailures(r.ctx, "/r", [{ name: "build", buildId: 9 }]);
    expect(failure).toMatchObject({ task: "npm test", tail: "", error: "could not fetch log: log not found" });
  });
});
