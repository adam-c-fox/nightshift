import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_BRANCH } from "../src/pr.js";
import { azEnvFrom, orgUrl, parseAzOutput, prWebUrl, makeContext, repoNameFromRemote } from "../src/pr-hosts/azure-devops/az.js";
import {
  failedChecks, mainBuildDefinitions, mainPolicyListArgs, pipelineRunArgs, pipelineRunShowArgs, policyListArgs,
  prCreateArgs, repoShowArgs, summarizePolicies, summarizeRuns, waitForBranchBuilds, waitForPolicies, waitForPrCommit,
  type BuildDefinition, type PipelineRun, type PolicyConfiguration, type PolicyEvaluation,
} from "../src/pr-hosts/azure-devops/checks.js";

const policy = (status: string, type = "Build", isBlocking = true): PolicyEvaluation => ({
  status,
  configuration: { isEnabled: true, isBlocking, type: { displayName: type } },
});

describe("summarizePolicies", () => {
  it("succeeds only when every blocking CI policy is approved", () => {
    expect(summarizePolicies([policy("approved"), policy("approved", "Status")])).toBe("succeeded");
    expect(summarizePolicies([policy("approved"), policy("running")])).toBe("pending");
    expect(summarizePolicies([policy("approved"), policy("queued", "Status")])).toBe("pending");
  });

  it("fails on any rejected or broken blocking policy", () => {
    expect(summarizePolicies([policy("approved"), policy("rejected")])).toBe("failed");
    expect(summarizePolicies([policy("broken")])).toBe("failed");
  });

  it("stays pending while any required check is unfinished, even after a rejection", () => {
    expect(summarizePolicies([policy("rejected"), policy("running")])).toBe("pending");
    expect(summarizePolicies([policy("broken"), policy("queued", "Status")])).toBe("pending");
  });

  it("ignores reviewer, non-blocking and not-applicable policies", () => {
    expect(summarizePolicies([policy("queued", "Minimum number of reviewers"), policy("rejected", "Build", false)])).toBe("none");
    expect(summarizePolicies([policy("approved"), policy("notApplicable")])).toBe("succeeded");
  });
});

describe("failedChecks", () => {
  const named = (status: string, displayName: string | undefined, buildId?: number, type = "Build"): PolicyEvaluation => ({
    status,
    context: buildId === undefined ? undefined : { buildId },
    configuration: { isEnabled: true, isBlocking: true, type: { displayName: type }, settings: displayName ? { displayName } : undefined },
  });

  it("names the rejected and broken required checks with their build ids", () => {
    expect(failedChecks([named("rejected", "lint-format", 1), named("approved", "typecheck", 2), named("broken", "unit-tests", 3)]))
      .toEqual([{ name: "lint-format", buildId: 1 }, { name: "unit-tests", buildId: 3 }]);
  });

  it("falls back to the policy type name", () => {
    expect(failedChecks([named("rejected", undefined, 9, "Status")])).toEqual([{ name: "Status", buildId: 9 }]);
  });

  it("omits the build id when the evaluation has none", () => {
    expect(failedChecks([named("rejected", "lint-format")])).toEqual([{ name: "lint-format", buildId: undefined }]);
  });

  it("reads the real Azure DevOps policy list", () => {
    const evaluations = JSON.parse(readFileSync(new URL("./fixtures/fixture-policies.json", import.meta.url), "utf-8"));
    expect(summarizePolicies(evaluations)).toBe("failed");
    expect(failedChecks(evaluations)).toEqual([{ name: "lint-format", buildId: 101 }]);
  });

  it("is not affected by non-blocking rejections", () => {
    const optional = { ...named("rejected", "optional", 5), configuration: { isEnabled: true, isBlocking: false, type: { displayName: "Build" } } };
    expect(failedChecks([optional])).toEqual([]);
  });
});

describe("policyListArgs", () => {
  it("passes only flags the az command accepts", () => {
    expect(policyListArgs(42, "https://dev.azure.com/acme"))
      .toEqual(["repos", "pr", "policy", "list", "--id", "42", "--org", "https://dev.azure.com/acme"]);
  });
});

describe("prCreateArgs", () => {
  it("names the repository instead of relying on az detection", () => {
    const args = prCreateArgs({
      org: "https://dev.azure.com/acme", project: "Proj", repository: "Repo",
      sourceBranch: "night/ENG-1", targetBranch: "main", title: "t", description: "d",
    });
    expect(args).toEqual([
      "repos", "pr", "create",
      "--org", "https://dev.azure.com/acme", "--project", "Proj", "--repository", "Repo",
      "--source-branch", "night/ENG-1", "--target-branch", "main",
      "--title", "t", "--description", "d", "--draft", "true",
    ]);
  });
});

describe("waitForPolicies", () => {
  const fast = { timeoutMs: 1000, intervalMs: 1, noPolicyGraceMs: 0 };

  it("recovers from transient az errors", async () => {
    let calls = 0;
    const fetchEvaluations = async () => {
      calls++;
      if (calls < 3) throw new Error("az hiccup");
      return [policy("approved")];
    };
    await expect(waitForPolicies(fetchEvaluations, fast)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("gives up as unknown after repeated errors and logs them", async () => {
    const logged: string[] = [];
    const fetchEvaluations = async () => { throw new Error("unrecognized arguments: --project"); };
    const { status: verdict } = await waitForPolicies(fetchEvaluations, { ...fast, maxConsecutiveErrors: 3, log: m => logged.push(m) });
    expect(verdict).toBe("unknown");
    expect(logged.join("\n")).toMatch(/unrecognized arguments/);
    expect(logged.length).toBeLessThanOrEqual(4);
  });

  it("reports failure as soon as a blocking policy is rejected", async () => {
    await expect(waitForPolicies(async () => [policy("rejected")], fast)).resolves.toMatchObject({ status: "failed" });
  });
});

describe("waitForPolicies with requireFreshEvaluation", () => {
  const opts = { timeoutMs: 1000, intervalMs: 1, noPolicyGraceMs: 0, requireFreshEvaluation: true, freshnessGraceMs: 60_000 };
  const sequence = (...evaluations: PolicyEvaluation[][]) => {
    let i = 0;
    return async () => evaluations[Math.min(i++, evaluations.length - 1)];
  };

  it("ignores a stale rejected verdict and waits for the verdict after a pending poll", async () => {
    const fetch = sequence([policy("rejected")], [policy("rejected")], [policy("running")], [policy("approved")]);
    await expect(waitForPolicies(fetch, opts)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("does not count a failed poll as evidence that the evaluation is fresh", async () => {
    let call = 0;
    const steps: (PolicyEvaluation[] | Error)[] = [
      [policy("rejected")], new Error("az hiccup"), [policy("rejected")], [policy("running")], [policy("approved")],
    ];
    const fetch = async () => {
      const step = steps[Math.min(call++, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    };
    await expect(waitForPolicies(fetch, opts)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("does not trust a stale approved verdict either", async () => {
    const fetch = sequence([policy("approved")], [policy("queued")], [policy("rejected")]);
    await expect(waitForPolicies(fetch, opts)).resolves.toMatchObject({ status: "failed" });
  });

  it("accepts a terminal verdict once the freshness grace has passed", async () => {
    await expect(waitForPolicies(async () => [policy("rejected")], { ...opts, freshnessGraceMs: 0 })).resolves.toMatchObject({ status: "failed" });
  });

  it("times out as unknown when only stale terminal verdicts are ever seen", async () => {
    await expect(waitForPolicies(async () => [policy("rejected")], { ...opts, timeoutMs: 30 })).resolves.toMatchObject({ status: "unknown" });
  });
});

describe("waitForPrCommit", () => {
  const fast = { timeoutMs: 1000, intervalMs: 1 };

  it("resolves true once the PR reports the pushed commit", async () => {
    const seen = ["old", "old", "abc"];
    let i = 0;
    await expect(waitForPrCommit(async () => seen[Math.min(i++, seen.length - 1)], "abc", fast)).resolves.toBe(true);
  });

  it("resolves false when the commit never shows up", async () => {
    await expect(waitForPrCommit(async () => "old", "abc", { ...fast, timeoutMs: 30 })).resolves.toBe(false);
  });

  it("tolerates transient fetch errors and logs them", async () => {
    let calls = 0;
    const logged: string[] = [];
    const fetchCommit = async () => {
      if (++calls < 3) throw new Error("az hiccup");
      return "abc";
    };
    await expect(waitForPrCommit(fetchCommit, "abc", { ...fast, log: m => logged.push(m) })).resolves.toBe(true);
    expect(logged.join("\n")).toMatch(/az hiccup/);
  });
});

describe("mainBuildDefinitions", () => {
  const config = (id: number | undefined, name: string, over: Partial<PolicyConfiguration> = {}): PolicyConfiguration => ({
    isEnabled: true, isBlocking: true, type: { displayName: "Build" }, settings: { buildDefinitionId: id, displayName: name }, ...over,
  });

  it("keeps enabled blocking build policies with their definition id and name", () => {
    expect(mainBuildDefinitions([config(7, "ci"), config(9, "lint")])).toEqual([{ id: 7, name: "ci" }, { id: 9, name: "lint" }]);
  });

  it("drops disabled, non-blocking, non-build and id-less policies", () => {
    expect(mainBuildDefinitions([
      config(1, "off", { isEnabled: false }),
      config(2, "soft", { isBlocking: false }),
      config(3, "reviewers", { type: { displayName: "Minimum number of reviewers" } }),
      config(undefined, "no-id"),
    ])).toEqual([]);
  });

  it("deduplicates definitions queued by several policies", () => {
    expect(mainBuildDefinitions([config(7, "ci"), config(7, "ci")])).toEqual([{ id: 7, name: "ci" }]);
  });

  it("falls back to a generic name", () => {
    expect(mainBuildDefinitions([config(4, "")])).toEqual([{ id: 4, name: "build 4" }]);
  });
});

describe("az argument builders for branch builds", () => {
  it("builds the repo, policy, run and run show commands", () => {
    expect(repoShowArgs("o", "p", "repo")).toEqual(["repos", "show", "--org", "o", "--project", "p", "--repository", "repo"]);
    expect(mainPolicyListArgs("o", "p", "rid")).toEqual(["repos", "policy", "list", "--org", "o", "--project", "p", "--repository-id", "rid", "--branch", DEFAULT_BASE_BRANCH]);
    expect(pipelineRunArgs("o", "p", 7, "feat/x")).toEqual(["pipelines", "run", "--org", "o", "--project", "p", "--id", "7", "--branch", "feat/x"]);
    expect(pipelineRunShowArgs("o", "p", 42)).toEqual(["pipelines", "runs", "show", "--org", "o", "--project", "p", "--id", "42"]);
  });
});

describe("summarizeRuns", () => {
  it("is pending until every run has completed", () => {
    expect(summarizeRuns([{ status: "completed", result: "succeeded" }, { status: "inProgress" }])).toBe("pending");
    expect(summarizeRuns([{ status: "notStarted" }])).toBe("pending");
  });

  it("succeeds only when every run succeeded", () => {
    expect(summarizeRuns([{ status: "completed", result: "succeeded" }, { status: "completed", result: "succeeded" }])).toBe("succeeded");
  });

  it("treats partiallySucceeded, failed and canceled as failed", () => {
    for (const result of ["partiallySucceeded", "failed", "canceled"]) {
      expect(summarizeRuns([{ status: "completed", result: "succeeded" }, { status: "completed", result }])).toBe("failed");
    }
  });
});

describe("waitForBranchBuilds", () => {
  const defs: BuildDefinition[] = [{ id: 7, name: "ci" }, { id: 9, name: "lint" }];
  const base = { timeoutMs: 1000, intervalMs: 1 };
  const done = (result: string): PipelineRun => ({ status: "completed", result });

  it("queues each definition once and succeeds when all runs succeed", async () => {
    const queued: number[] = [];
    const queueRun = async (d: BuildDefinition) => { queued.push(d.id); return d.id * 10; };
    const fetchRun = async () => done("succeeded");
    await expect(waitForBranchBuilds(defs, { ...base, queueRun, fetchRun })).resolves.toEqual({ status: "succeeded", failedChecks: [] });
    expect(queued).toEqual([7, 9]);
  });

  it("waits through pending polls", async () => {
    let polls = 0;
    const fetchRun = async (): Promise<PipelineRun> => (polls++ < 3 ? { status: "inProgress" } : done("succeeded"));
    await expect(waitForBranchBuilds([defs[0]], { ...base, queueRun: async () => 1, fetchRun })).resolves.toMatchObject({ status: "succeeded" });
  });

  it("carries the definition name and run id of failed runs", async () => {
    const fetchRun = async (id: number) => (id === 90 ? done("partiallySucceeded") : done("succeeded"));
    await expect(waitForBranchBuilds(defs, { ...base, queueRun: async d => d.id * 10, fetchRun }))
      .resolves.toEqual({ status: "failed", failedChecks: [{ name: "lint", buildId: 90 }] });
  });

  it("is unknown when the runs do not finish in time", async () => {
    const result = await waitForBranchBuilds(defs, { timeoutMs: 20, intervalMs: 1, queueRun: async () => 1, fetchRun: async () => ({ status: "inProgress" }) });
    expect(result).toMatchObject({ status: "unknown", failedChecks: [] });
    expect(result.unknownReason).toMatch(/branch build/);
  });

  it("is unknown when a run cannot be queued", async () => {
    const logged: string[] = [];
    const queueRun = async () => { throw new Error("TF401019: no permission"); };
    const result = await waitForBranchBuilds(defs, { ...base, queueRun, fetchRun: async () => done("succeeded"), log: m => logged.push(m) });
    expect(result.status).toBe("unknown");
    expect(result.unknownReason).toMatch(/branch build/);
    expect(logged.join("\n")).toMatch(/no permission/);
  });

  it("recovers from transient poll errors", async () => {
    let calls = 0;
    const fetchRun = async (): Promise<PipelineRun> => { if (calls++ < 2) throw new Error("hiccup"); return done("succeeded"); };
    await expect(waitForBranchBuilds([defs[0]], { ...base, queueRun: async () => 1, fetchRun })).resolves.toMatchObject({ status: "succeeded" });
  });

  it("gives up as unknown after repeated poll errors", async () => {
    const fetchRun = async (): Promise<PipelineRun> => { throw new Error("az down"); };
    const result = await waitForBranchBuilds(defs, { ...base, maxConsecutiveErrors: 3, queueRun: async () => 1, fetchRun });
    expect(result.status).toBe("unknown");
    expect(result.unknownReason).toMatch(/branch build/);
  });

  it("is unknown with its own reason when main has no build policy", async () => {
    const result = await waitForBranchBuilds([], { ...base, queueRun: async () => 1, fetchRun: async () => done("succeeded") });
    expect(result.status).toBe("unknown");
    expect(result.unknownReason).toMatch(/no build policy/);
  });
});

describe("repoNameFromRemote", () => {
  it("takes the last path segment of ssh, https and visualstudio remotes", () => {
    expect(repoNameFromRemote("git@ssh.dev.azure.com:v3/org/project/REPO")).toBe("REPO");
    expect(repoNameFromRemote("https://org@dev.azure.com/org/project/_git/REPO")).toBe("REPO");
    expect(repoNameFromRemote("https://org.visualstudio.com/project/_git/REPO.git")).toBe("REPO");
  });
});

describe("parseAzOutput", () => {
  it("returns null for empty output and parses JSON otherwise", () => {
    expect(parseAzOutput("")).toBeNull();
    expect(parseAzOutput('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
});

describe("azEnvFrom", () => {
  it("passes the PAT as AZURE_DEVOPS_EXT_PAT", () => {
    expect(azEnvFrom(n => (n === "AZURE_DEVOPS_PAT" ? "pat" : undefined)).AZURE_DEVOPS_EXT_PAT).toBe("pat");
  });

  it("adds nothing without a PAT", () => {
    const before = process.env.AZURE_DEVOPS_EXT_PAT;
    delete process.env.AZURE_DEVOPS_EXT_PAT;
    try {
      expect(azEnvFrom(() => undefined).AZURE_DEVOPS_EXT_PAT).toBeUndefined();
    } finally {
      if (before !== undefined) process.env.AZURE_DEVOPS_EXT_PAT = before;
    }
  });
});

describe("web urls", () => {
  it("builds the web URL, not the API URL", () => {
    const ctx = makeContext(n => ({ AZURE_DEVOPS_ORG: "https://dev.azure.com/org/", AZURE_DEVOPS_PROJECT: "My Project" })[n], async () => ({ stdout: "", stderr: "" }));
    expect(prWebUrl(ctx, "repo", 42)).toBe("https://dev.azure.com/org/My%20Project/_git/repo/pullrequest/42");
  });

  it("accepts a bare org name", () => {
    expect(orgUrl("acme")).toBe("https://dev.azure.com/acme");
  });
});
