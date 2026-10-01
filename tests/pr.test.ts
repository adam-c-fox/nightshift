import { describe, expect, it } from "vitest";
import { buildPrTitle, buildPrWebUrl, orgUrl, pickNightPr, policyListArgs, repoNameFromRemote, summarizePolicies, waitForPolicies, type AzPullRequest, type PolicyEvaluation } from "../src/pr.js";

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

  it("ignores reviewer, non-blocking and not-applicable policies", () => {
    expect(summarizePolicies([policy("queued", "Minimum number of reviewers"), policy("rejected", "Build", false)])).toBe("none");
    expect(summarizePolicies([policy("approved"), policy("notApplicable")])).toBe("succeeded");
  });
});

describe("PR helpers", () => {
  it("builds the web URL, not the API URL", () => {
    expect(buildPrWebUrl("https://dev.azure.com/org/", "My Project", "repo", 42))
      .toBe("https://dev.azure.com/org/My%20Project/_git/repo/pullrequest/42");
  });

  it("accepts a bare org name", () => {
    expect(orgUrl("acme")).toBe("https://dev.azure.com/acme");
  });

  it("truncates the title summary to one line", () => {
    expect(buildPrTitle("ENG-1", "first line\nsecond")).toBe("night: ENG-1 – first line");
  });
});

describe("policyListArgs", () => {
  it("passes only flags the az command accepts", () => {
    expect(policyListArgs(42, "https://dev.azure.com/acme"))
      .toEqual(["repos", "pr", "policy", "list", "--id", "42", "--org", "https://dev.azure.com/acme"]);
  });
});

describe("waitForPolicies", () => {
  const fast = { timeoutMs: 1000, intervalMs: 1, noPolicyGraceMs: 0 };

  it("recovers from transient az errors", async () => {
    let calls = 0;
    const fetchEvaluations = () => {
      calls++;
      if (calls < 3) throw new Error("az hiccup");
      return [policy("approved")];
    };
    await expect(waitForPolicies(fetchEvaluations, fast)).resolves.toBe("succeeded");
  });

  it("gives up as unknown after repeated errors and logs them", async () => {
    const logged: string[] = [];
    const fetchEvaluations = () => { throw new Error("unrecognized arguments: --project"); };
    const verdict = await waitForPolicies(fetchEvaluations, { ...fast, maxConsecutiveErrors: 3, log: m => logged.push(m) });
    expect(verdict).toBe("unknown");
    expect(logged.join("\n")).toMatch(/unrecognized arguments/);
    expect(logged.length).toBeLessThanOrEqual(4);
  });

  it("reports failure as soon as a blocking policy is rejected", async () => {
    await expect(waitForPolicies(() => [policy("rejected")], fast)).resolves.toBe("failed");
  });
});

describe("repoNameFromRemote", () => {
  it("takes the last path segment of ssh, https and visualstudio remotes", () => {
    expect(repoNameFromRemote("git@ssh.dev.azure.com:v3/org/project/REPO")).toBe("REPO");
    expect(repoNameFromRemote("https://org@dev.azure.com/org/project/_git/REPO")).toBe("REPO");
    expect(repoNameFromRemote("https://org.visualstudio.com/project/_git/REPO.git")).toBe("REPO");
  });
});

describe("pickNightPr", () => {
  const pr = (id: number, source: string, target = "main"): AzPullRequest => ({
    pullRequestId: id,
    sourceRefName: `refs/heads/${source}`,
    targetRefName: `refs/heads/${target}`,
  });

  it("matches per-run branches and the legacy branch", () => {
    expect(pickNightPr([pr(5, "night/ENG-1-20261001-2305")], "ENG-1")?.prId).toBe(5);
    expect(pickNightPr([pr(6, "night/ENG-1")], "ENG-1")?.prId).toBe(6);
  });

  it("does not match another ticket or a non-night branch", () => {
    expect(pickNightPr([pr(7, "night/ENG-12-20261001-2305"), pr(8, "feature/ENG-1")], "ENG-1")).toBeNull();
  });

  it("picks the highest id among matches", () => {
    const picked = pickNightPr([pr(5, "night/ENG-1-20260930-2300"), pr(9, "night/ENG-1"), pr(7, "night/ENG-1-20260929-2300")], "ENG-1");
    expect(picked?.prId).toBe(9);
  });

  it("returns null for an empty list", () => {
    expect(pickNightPr([], "ENG-1")).toBeNull();
  });

  it("strips refs/heads/ from both branches", () => {
    expect(pickNightPr([pr(5, "night/ENG-1-20260930-2300", "develop")], "ENG-1")).toEqual({
      prId: 5, sourceBranch: "night/ENG-1-20260930-2300", targetBranch: "develop",
    });
  });
});
