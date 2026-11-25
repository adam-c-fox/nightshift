import { describe, expect, it } from "vitest";
import type { TicketResult } from "../src/types.js";
import { buildPrDescription, buildPrTitle, commitSubject, findOpenTicketPr, prContent, pickTicketPr, prAction, type ExistingPr } from "../src/pr.js";
import type { PrHost, PullRequest } from "../src/pr-host.js";

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

  const conflicts = [{ from: "S1", file: "src/export.ts", ticket: "Drop rows with no id", quoted: true, consequence: "Silently loses records.", change: "Keep them and flag them", data: false }];

  it("adds a decision section with the ticket line and suggested change before the closer-look section", () => {
    const text = buildPrDescription("ENG-1", "Done.", ["npx vitest run"], undefined, [{ file: "src/a.ts", risk: "Confirm the default." }], undefined, conflicts);
    expect(text).toContain('Needs a decision before merge:\n- `src/export.ts`: The ticket asks for "Drop rows with no id". Silently loses records. Suggested change: Keep them and flag them.');
    expect(text.indexOf("Done.")).toBeLessThan(text.indexOf("Needs a decision before merge:"));
    expect(text.indexOf("Needs a decision before merge:")).toBeLessThan(text.indexOf("Worth a closer look:"));
    expect(text.indexOf("Needs a decision before merge:")).toBeLessThan(text.indexOf("To verify locally:"));
    expect(text.toLowerCase()).not.toMatch(/review|night|automated|generated/);
  });

  it("leaves out the ticket sentence when no ticket line was quoted", () => {
    const text = buildPrDescription("ENG-1", "Done.", [], undefined, [], undefined, [{ ...conflicts[0], ticket: "", consequence: "Loses records?", change: "Keep them." }]);
    expect(text).toContain("- `src/export.ts`: Loses records? Suggested change: Keep them.");
    expect(text).not.toContain("The ticket asks for");
  });

  it("leaves out the ticket sentence when the quoted line was not found in the ticket", () => {
    const text = buildPrDescription("ENG-1", "Done.", [], undefined, [], undefined, [{ ...conflicts[0], quoted: false }]);
    expect(text).toContain("- `src/export.ts`: Silently loses records. Suggested change: Keep them and flag them.");
    expect(text).not.toContain("The ticket asks for");
  });

  it("leaves out the suggested change when there is none", () => {
    const text = buildPrDescription("ENG-1", "Done.", [], undefined, [], undefined, [{ ...conflicts[0], change: undefined }]);
    expect(text).toContain('- `src/export.ts`: The ticket asks for "Drop rows with no id". Silently loses records.');
    expect(text).not.toMatch(/Suggested change|undefined|no change/);
  });

  it("omits the decision section without conflicts", () => {
    expect(buildPrDescription("ENG-1", "Done.", [], undefined, [], undefined, [])).not.toContain("decision");
    expect(text).not.toContain("decision");
  });

  it("omits the closer-look section without risks", () => {
    expect(buildPrDescription("ENG-1", "Done.", [], undefined, [])).not.toContain("closer look");
    expect(text).not.toContain("closer look");
  });

  it("says which PR to merge first when stacked", () => {
    const stacked = buildPrDescription("ENG-2", "Done.", [], undefined, [], { ticketId: "ENG-1", prId: 41 });
    expect(stacked).toContain("Stacked on PR #41 (ENG-1); merge that first.");
    expect(text).not.toContain("Stacked on");
  });

  it("keeps the 4000 character cap with many risks", () => {
    const risks = Array.from({ length: 200 }, (_, i) => ({ file: `f${i}.ts`, risk: "x".repeat(100) }));
    expect(buildPrDescription("ENG-1", "Done.", [], undefined, risks).length).toBe(4000);
  });

  it("carries no trace of automation", () => {
    expect(text.toLowerCase()).not.toMatch(/night|automated|generated/);
  });
});

describe("pickTicketPr", () => {
  const branch = "adamfox/eng-1-fix-export";
  const pr = (id: number, source: string, target = "main", extra: Partial<PullRequest> = {}): PullRequest => ({
    prId: id, sourceBranch: source, targetBranch: target, autoComplete: false, url: `https://host/pr/${id}`,
    isDraft: false, votes: { approved: 0, waiting: 0, rejected: 0 }, ...extra,
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
    const withAuto = pr(5, branch, "main", { autoComplete: true });
    expect(pickTicketPr([withAuto], branch)?.autoComplete).toBe(true);
    expect(pickTicketPr([pr(5, branch)], branch)?.autoComplete).toBe(false);
  });

  it("returns null for an empty list", () => {
    expect(pickTicketPr([], branch)).toBeNull();
  });

  it("returns the branches and url of the match", () => {
    expect(pickTicketPr([pr(5, branch, "develop")], branch)).toEqual({
      prId: 5, sourceBranch: branch, targetBranch: "develop", autoComplete: false, url: "https://host/pr/5",
    });
  });
});

describe("findOpenTicketPr", () => {
  it("lists the repo's open PRs through the host and picks the ticket's PR", async () => {
    const listed: string[] = [];
    const host = {
      listOpenPrs: async (repoPath: string) => {
        listed.push(repoPath);
        return { repoName: "app", prs: [{ prId: 3, sourceBranch: "ns/eng-1-x", targetBranch: "main", autoComplete: false, url: "u", isDraft: false, votes: { approved: 0, waiting: 0, rejected: 0 } }] };
      },
    } as unknown as PrHost;
    await expect(findOpenTicketPr(host, "ns/eng-1-x", "/r/app")).resolves.toMatchObject({ prId: 3, url: "u" });
    await expect(findOpenTicketPr(host, "ns/eng-2-y", "/r/app")).resolves.toBeNull();
    expect(listed).toEqual(["/r/app", "/r/app"]);
  });
});

describe("prAction", () => {
  const existing = (autoComplete: boolean): ExistingPr => ({ prId: 5, sourceBranch: "night/ENG-1", targetBranch: "main", autoComplete, url: "" });

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
    issue: { id: "l", identifier: "ENG-1", name: "Export", description: "", comments: [], state: "Todo", url: "https://linear.app/x/ENG-1" },
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

  it("carries the review's conflicts into the PR content", () => {
    const conflicts = [{ from: "S1", file: "src/export.ts", ticket: "Drop rows", quoted: true, consequence: "Loses data.", change: "Keep them.", data: true }];
    const content = prContent({ ...result, review: { ...result.review!, conflicts } });
    expect(content.conflicts).toEqual(conflicts);
    expect(prContent(result).conflicts).toEqual([]);
  });
});

describe("commitSubject", () => {
  it("keeps the ticket id suffix for a normal id", () => {
    expect(commitSubject("ENG-1", "fix: a", "")).toBe("fix: a (ENG-1)");
  });

  it("leaves the suffix off for a PR- id", () => {
    expect(commitSubject("PR-123", "fix: a (PR-123)", "")).toBe("fix: a");
  });
});
