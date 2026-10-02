import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TicketResult } from "../src/types.js";
import { buildPrDescription, buildPrTitle, buildPrWebUrl, prContent, orgUrl, pickTicketPr, policyListArgs, prAction, prCreateArgs, repoNameFromRemote, failedChecks, summarizePolicies, waitForPolicies, waitForPrCommit, type AzPullRequest, type ExistingPr, type PolicyEvaluation } from "../src/pr.js";

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

describe("PR helpers", () => {
  it("builds the web URL, not the API URL", () => {
    expect(buildPrWebUrl("https://dev.azure.com/org/", "My Project", "repo", 42))
      .toBe("https://dev.azure.com/org/My%20Project/_git/repo/pullrequest/42");
  });

  it("accepts a bare org name", () => {
    expect(orgUrl("acme")).toBe("https://dev.azure.com/acme");
  });

});

describe("buildPrTitle", () => {
  it("appends the ticket id to the agent's title", () => {
    expect(buildPrTitle("DEMO-500", "feat: add export_runs schema", "ignored")).toBe("feat: add export_runs schema (DEMO-500)");
  });

  it("never doubles a ticket id the agent already added", () => {
    expect(buildPrTitle("DEMO-500", "fix: handle empty rows (DEMO-500)", "")).toBe("fix: handle empty rows (DEMO-500)");
  });

  it("falls back to the first summary line capped at 80 chars", () => {
    expect(buildPrTitle("ENG-1", "", "first line\nsecond")).toBe("first line (ENG-1)");
    expect(buildPrTitle("ENG-1", "  ", "x".repeat(200))).toBe(`${"x".repeat(80)} (ENG-1)`);
  });

  it("never mentions the runner", () => {
    expect(buildPrTitle("ENG-1", "", "Fixed it").toLowerCase()).not.toContain("night");
  });
});

describe("buildPrDescription", () => {
  const text = buildPrDescription("ENG-1", "Fixed the export.", ["npx vitest run"], "https://linear.app/x/issue/ENG-1");

  it("links the ticket and lists summary and verify commands", () => {
    expect(text).toContain("[ENG-1](https://linear.app/x/issue/ENG-1)");
    expect(text).toContain("Fixed the export.");
    expect(text).toContain("- `npx vitest run`");
  });

  it("names the bare ticket id without a url and omits verify without commands", () => {
    const bare = buildPrDescription("ENG-1", "Done.", []);
    expect(bare).toContain("ENG-1");
    expect(bare).not.toContain("Verify");
  });

  it("adds a closer-look section with the risks before the verify commands", () => {
    const withRisks = buildPrDescription("ENG-1", "Done.", ["npx vitest run"], undefined, [{ file: "src/a.ts", risk: "Confirm the default." }]);
    expect(withRisks).toContain("Worth a closer look:\n- `src/a.ts`: Confirm the default.");
    expect(withRisks.indexOf("Worth a closer look:")).toBeLessThan(withRisks.indexOf("To verify locally:"));
  });

  it("omits the closer-look section without risks", () => {
    expect(buildPrDescription("ENG-1", "Done.", [], undefined, [])).not.toContain("closer look");
    expect(text).not.toContain("closer look");
  });

  it("keeps the 4000 character cap with many risks", () => {
    const risks = Array.from({ length: 200 }, (_, i) => ({ file: `f${i}.ts`, risk: "x".repeat(100) }));
    expect(buildPrDescription("ENG-1", "Done.", [], undefined, risks).length).toBe(4000);
  });

  it("carries no trace of automation", () => {
    expect(text.toLowerCase()).not.toMatch(/night|automated|generated/);
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
      "--title", "t", "--description", "d",
    ]);
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
    await expect(waitForPolicies(fetchEvaluations, fast)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("gives up as unknown after repeated errors and logs them", async () => {
    const logged: string[] = [];
    const fetchEvaluations = () => { throw new Error("unrecognized arguments: --project"); };
    const { status: verdict } = await waitForPolicies(fetchEvaluations, { ...fast, maxConsecutiveErrors: 3, log: m => logged.push(m) });
    expect(verdict).toBe("unknown");
    expect(logged.join("\n")).toMatch(/unrecognized arguments/);
    expect(logged.length).toBeLessThanOrEqual(4);
  });

  it("reports failure as soon as a blocking policy is rejected", async () => {
    await expect(waitForPolicies(() => [policy("rejected")], fast)).resolves.toMatchObject({ status: "failed" });
  });
});

describe("waitForPolicies with requireFreshEvaluation", () => {
  const opts = { timeoutMs: 1000, intervalMs: 1, noPolicyGraceMs: 0, requireFreshEvaluation: true, freshnessGraceMs: 60_000 };
  const sequence = (...evaluations: PolicyEvaluation[][]) => {
    let i = 0;
    return () => evaluations[Math.min(i++, evaluations.length - 1)];
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
    const fetch = () => {
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
    await expect(waitForPolicies(() => [policy("rejected")], { ...opts, freshnessGraceMs: 0 })).resolves.toMatchObject({ status: "failed" });
  });

  it("times out as unknown when only stale terminal verdicts are ever seen", async () => {
    await expect(waitForPolicies(() => [policy("rejected")], { ...opts, timeoutMs: 30 })).resolves.toMatchObject({ status: "unknown" });
  });
});

describe("waitForPrCommit", () => {
  const fast = { timeoutMs: 1000, intervalMs: 1 };

  it("resolves true once the PR reports the pushed commit", async () => {
    const seen = ["old", "old", "abc"];
    let i = 0;
    await expect(waitForPrCommit(() => seen[Math.min(i++, seen.length - 1)], "abc", fast)).resolves.toBe(true);
  });

  it("resolves false when the commit never shows up", async () => {
    await expect(waitForPrCommit(() => "old", "abc", { ...fast, timeoutMs: 30 })).resolves.toBe(false);
  });

  it("tolerates transient fetch errors and logs them", async () => {
    let calls = 0;
    const logged: string[] = [];
    const fetchCommit = () => {
      if (++calls < 3) throw new Error("az hiccup");
      return "abc";
    };
    await expect(waitForPrCommit(fetchCommit, "abc", { ...fast, log: m => logged.push(m) })).resolves.toBe(true);
    expect(logged.join("\n")).toMatch(/az hiccup/);
  });
});

describe("repoNameFromRemote", () => {
  it("takes the last path segment of ssh, https and visualstudio remotes", () => {
    expect(repoNameFromRemote("git@ssh.dev.azure.com:v3/org/project/REPO")).toBe("REPO");
    expect(repoNameFromRemote("https://org@dev.azure.com/org/project/_git/REPO")).toBe("REPO");
    expect(repoNameFromRemote("https://org.visualstudio.com/project/_git/REPO.git")).toBe("REPO");
  });
});

describe("pickTicketPr", () => {
  const branch = "adamfox/eng-1-fix-export";
  const pr = (id: number, source: string, target = "main"): AzPullRequest => ({
    pullRequestId: id,
    sourceRefName: `refs/heads/${source}`,
    targetRefName: `refs/heads/${target}`,
  });

  it("matches the exact branch and numbered variants", () => {
    expect(pickTicketPr([pr(5, branch)], branch)?.prId).toBe(5);
    expect(pickTicketPr([pr(6, `${branch}-2`)], branch)?.prId).toBe(6);
  });

  it("does not match other branches, other tickets or non-numeric suffixes", () => {
    const others = [pr(7, "adamfox/eng-12-other"), pr(8, `${branch}-extra`), pr(9, `night/ENG-1`), pr(10, `${branch}2`)];
    expect(pickTicketPr(others, branch)).toBeNull();
  });

  it("picks the highest id among matches", () => {
    expect(pickTicketPr([pr(5, branch), pr(9, `${branch}-3`), pr(7, `${branch}-2`)], branch)?.prId).toBe(9);
  });

  it("flags a PR that has auto-complete set", () => {
    const withAuto = { ...pr(5, branch), autoCompleteSetBy: { displayName: "Adam" } };
    expect(pickTicketPr([withAuto], branch)?.autoComplete).toBe(true);
    expect(pickTicketPr([pr(5, branch)], branch)?.autoComplete).toBe(false);
  });

  it("returns null for an empty list", () => {
    expect(pickTicketPr([], branch)).toBeNull();
  });

  it("strips refs/heads/ from both branches", () => {
    expect(pickTicketPr([pr(5, branch, "develop")], branch)).toEqual({
      prId: 5, sourceBranch: branch, targetBranch: "develop", autoComplete: false,
    });
  });
});

describe("prAction", () => {
  const existing = (autoComplete: boolean): ExistingPr => ({ prId: 5, sourceBranch: "night/ENG-1", targetBranch: "main", autoComplete });

  it("opens a new PR when there is none or its branch was not started from", () => {
    expect(prAction(null, false)).toBe("open");
    expect(prAction(existing(false), false)).toBe("open");
    expect(prAction(existing(true), false)).toBe("open");
  });

  it("updates the PR when the worktree started from it", () => {
    expect(prAction(existing(false), true)).toBe("update");
  });

  it("holds when the PR has auto-complete set", () => {
    expect(prAction(existing(true), true)).toBe("hold");
  });
});

describe("PR content", () => {
  const result: TicketResult = {
    ticket: { id: "ENG-1", name: "Export", context: [], repo: "main" },
    linear: { id: "l", identifier: "ENG-1", name: "Export", description: "", state: "Todo", stateType: "unstarted", url: "https://linear.app/x/ENG-1" },
    status: "needs_review", title: "feat: stream csv export", summary: "Streams rows to the response.",
    filesCreated: [], filesModified: [], tests: [], verifyCommands: ["npx vitest run"],
    notes: "Review found 2 issue(s); 1 fixed. Flaky reviewer note.",
    followups: [],
    worktreePath: "/w", branch: "b", durationSec: 1,
    review: {
      outcome: "reviewed",
      findings: [{ id: "R1", severity: "blocker", file: "src/export.ts", issue: "Buffers everything in memory.", suggestion: "Use a stream." }],
      resolutions: [{ id: "R1", status: "fixed", how: "Switched to a stream." }],
    },
  };

  it("never carries review text into the title or description", () => {
    const content = prContent(result);
    const text = [
      buildPrTitle(content.ticketId, content.title, content.summary),
      buildPrDescription(content.ticketId, content.summary, content.verifyCommands, content.ticketUrl),
    ].join("\n");
    for (const leaked of ["Buffers everything", "Use a stream", "Switched to a stream", "R1", "blocker", "src/export.ts", "Review found", "Flaky reviewer", "review"]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("feat: stream csv export (ENG-1)");
    expect(text).toContain("Streams rows to the response.");
  });

  it("threads the review's risks into the content", () => {
    const risks = [{ file: "src/export.ts", risk: "Confirm the batch size." }];
    const content = prContent({ ...result, review: { ...result.review!, risks } });
    expect(content.risks).toEqual(risks);
    expect(buildPrDescription(content.ticketId, content.summary, content.verifyCommands, content.ticketUrl, content.risks))
      .toContain("- `src/export.ts`: Confirm the batch size.");
    expect(prContent(result).risks).toEqual([]);
  });
});
