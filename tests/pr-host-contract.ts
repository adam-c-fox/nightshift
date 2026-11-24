import { describe, expect, it } from "vitest";
import type { PrHost, VoteSummary } from "../src/pr-host.js";
import type { PrContent } from "../src/pr.js";

export const LOGIN_ERROR = "Please run 'az login' to setup account.";

export interface FakeWorld {
  me: string;
  loggedIn: boolean;
  repoName: string;
  prSeesPushes?: boolean;
  prs: { id: number; source: string; target: string; author: string; title: string; draft: boolean; autoComplete: boolean; votes: VoteSummary }[];
  requiredChecks: { name: string; state: "passed" | "failed" | "pending"; failedStep?: string; logTail?: string }[];
  threads: Record<number, { id: number; resolved: boolean; file?: string; line?: number; comments: { id: number; author: string; text: string; bot?: boolean }[] }[]>;
}

export interface HostFixture {
  host: PrHost;
  pushes(): { branch: string; remoteBranch: string }[];
  createdPrs(): { source: string; target: string; draft: boolean; title: string }[];
  replies(): { prId: number; threadId: number; parentCommentId: number; text: string }[];
  resolved(): { prId: number; threadId: number }[];
}

const POLL = { intervalMs: 0, timeoutMs: 200 };
const REPO_PATH = "/r/app";
const BRANCH = "night/ENG-1";

const world = (over: Partial<FakeWorld> = {}): FakeWorld => ({
  me: "Me@Acme.com",
  loggedIn: true,
  repoName: "app",
  prs: [],
  requiredChecks: [],
  threads: {},
  ...over,
});

const pr = (id: number, source: string, over: Partial<FakeWorld["prs"][number]> = {}): FakeWorld["prs"][number] => ({
  id, source, target: "main", author: "Me@Acme.com", title: `PR ${id}`, draft: false, autoComplete: false,
  votes: { approved: 0, waiting: 0, rejected: 0 },
  ...over,
});

const content: PrContent = {
  ticketId: "ENG-1", title: "Fix export", summary: "Fixed the export.", verifyCommands: ["npm test"], risks: [], conflicts: [],
};

const thread = (id: number, over: Partial<FakeWorld["threads"][number][number]> = {}): FakeWorld["threads"][number][number] => ({
  id, resolved: false, comments: [{ id: 1, author: "Reviewer", text: "Please rename this" }], ...over,
});

const newestTicketPr = (prs: { prId: number; sourceBranch: string }[], branch: string) =>
  prs
    .filter(p => p.sourceBranch === branch || new RegExp(`^${branch}-\\d+$`).test(p.sourceBranch))
    .reduce<{ prId: number } | null>((best, p) => (!best || p.prId > best.prId ? p : best), null);

export function describePrHostContract(label: string, fixture: (world: FakeWorld) => HostFixture): void {
  describe(`${label} PrHost contract`, () => {
    it("listOpenPrs returns every PR normalized", async () => {
      const votes = { approved: 2, waiting: 1, rejected: 1 };
      const { host } = fixture(world({
        prs: [
          pr(5, BRANCH, { author: "Me@Acme.com", draft: true, autoComplete: true, votes }),
          pr(6, "feature/x", { target: "develop", author: "Other@Acme.com" }),
        ],
      }));
      const list = await host.listOpenPrs(REPO_PATH);
      expect(list.repoName).toBe("app");
      expect(list.prs).toEqual([
        expect.objectContaining({ prId: 5, sourceBranch: BRANCH, targetBranch: "main", author: "me@acme.com", isDraft: true, autoComplete: true, votes, title: "PR 5" }),
        expect.objectContaining({ prId: 6, sourceBranch: "feature/x", targetBranch: "develop", author: "other@acme.com", isDraft: false, autoComplete: false }),
      ]);
      for (const p of list.prs) expect(p.url).toContain(String(p.prId));
    });

    it("currentUser returns the lowercased user and rejects with the CLI error when logged out", async () => {
      expect(await fixture(world()).host.currentUser()).toBe("me@acme.com");
      await expect(fixture(world({ loggedIn: false })).host.currentUser()).rejects.toThrow(LOGIN_ERROR);
    });

    it("listOpenPrs gives branches the ticket matching rule can use", async () => {
      const { host } = fixture(world({
        prs: [pr(5, BRANCH), pr(9, `${BRANCH}-3`), pr(7, `${BRANCH}-2`), pr(10, `${BRANCH}x`)],
      }));
      const { prs } = await host.listOpenPrs(REPO_PATH);
      expect(prs.map(p => p.sourceBranch)).toEqual([BRANCH, `${BRANCH}-3`, `${BRANCH}-2`, `${BRANCH}x`]);
      expect(newestTicketPr(prs, BRANCH)?.prId).toBe(9);
    });

    it("openPr into main pushes once, opens one draft PR and reports passing checks", async () => {
      const f = fixture(world({ requiredChecks: [{ name: "build", state: "passed" }] }));
      const result = await f.host.openPr(content, BRANCH, "main", REPO_PATH, POLL);
      expect(f.pushes()).toEqual([{ branch: BRANCH, remoteBranch: BRANCH }]);
      expect(f.createdPrs()).toEqual([{ source: BRANCH, target: "main", draft: true, title: "Fix export (ENG-1)" }]);
      expect(result.pipelineStatus).toBe("succeeded");
      expect(result.failedChecks).toEqual([]);
      expect(result.url).toContain(String(result.prId));
    });

    it("openPr reports a failed required check by name", async () => {
      const f = fixture(world({ requiredChecks: [{ name: "build", state: "passed" }, { name: "unit tests", state: "failed" }] }));
      const result = await f.host.openPr(content, BRANCH, "main", REPO_PATH, POLL);
      expect(result.pipelineStatus).toBe("failed");
      expect(result.failedChecks.map(c => c.name)).toEqual(["unit tests"]);
    });

    it("openPr returns unknown when no required check ever reports", async () => {
      const f = fixture(world({ requiredChecks: [] }));
      const result = await f.host.openPr(content, BRANCH, "main", REPO_PATH, POLL);
      expect(result.pipelineStatus).toBe("unknown");
    });

    it("openPr into a stacked target still reports the required checks", async () => {
      const passing = fixture(world({ requiredChecks: [{ name: "build", state: "passed" }] }));
      const parent = "night/ENG-0";
      const ok = await passing.host.openPr(content, BRANCH, parent, REPO_PATH, POLL);
      expect(passing.createdPrs()).toEqual([expect.objectContaining({ source: BRANCH, target: parent, draft: true })]);
      expect(ok.pipelineStatus).toBe("succeeded");

      const failing = fixture(world({ requiredChecks: [{ name: "build", state: "failed" }] }));
      const bad = await failing.host.openPr(content, BRANCH, parent, REPO_PATH, POLL);
      expect(bad.pipelineStatus).toBe("failed");
      expect(bad.failedChecks.map(c => c.name)).toEqual(["build"]);
    });

    it("updatePr pushes to the PR branch and ignores verdicts that predate the push", async () => {
      const existing = { prId: 5, sourceBranch: BRANCH, targetBranch: "main", autoComplete: false, url: "https://example.test/pr/5" };
      const failing = fixture(world({ prs: [pr(5, BRANCH)], requiredChecks: [{ name: "build", state: "failed" }] }));
      const result = await failing.host.updatePr(existing, "local-work", REPO_PATH, POLL);
      expect(failing.pushes()).toEqual([{ branch: "local-work", remoteBranch: BRANCH }]);
      expect(result.prId).toBe(5);
      expect(result.pipelineStatus).toBe("failed");

      const unseen = fixture(world({ prs: [pr(5, BRANCH)], prSeesPushes: false, requiredChecks: [{ name: "build", state: "passed" }] }));
      expect((await unseen.host.updatePr(existing, "local-work", REPO_PATH, POLL)).pipelineStatus).toBe("unknown");
    });

    it("ciVerdict maps the world's checks", async () => {
      const verdict = (requiredChecks: FakeWorld["requiredChecks"]) =>
        fixture(world({ requiredChecks })).host.ciVerdict(REPO_PATH, 5);
      expect(await verdict([{ name: "build", state: "pending" }])).toBe("pending");
      expect(await verdict([{ name: "build", state: "passed" }])).toBe("succeeded");
      expect(await verdict([{ name: "build", state: "passed" }, { name: "tests", state: "failed" }])).toBe("failed");
      expect(await verdict([])).toBe("none");
    });

    it("ciFailures returns the failed step and log tail, or an error entry when logs are missing", async () => {
      const withLogs = fixture(world({ requiredChecks: [{ name: "build", state: "failed", failedStep: "npm test", logTail: "line one\nline two" }] }));
      const opened = await withLogs.host.openPr(content, BRANCH, "main", REPO_PATH, POLL);
      const [failure] = await withLogs.host.ciFailures(REPO_PATH, opened.failedChecks);
      expect(failure).toMatchObject({ check: "build", task: "npm test" });
      expect(failure.tail).toContain("line two");
      expect(failure.error).toBeUndefined();

      const noLogs = fixture(world({ requiredChecks: [{ name: "build", state: "failed", failedStep: "npm test" }] }));
      const openedNoLogs = await noLogs.host.openPr(content, BRANCH, "main", REPO_PATH, POLL);
      const [missing] = await noLogs.host.ciFailures(REPO_PATH, openedNoLogs.failedChecks);
      expect(missing.check).toBe("build");
      expect(missing.error).toBeTruthy();
    });

    it("listThreads returns unresolved threads without bot comments, keeping file and line", async () => {
      const { host } = fixture(world({
        threads: {
          5: [
            thread(1, { file: "src/a.ts", line: 12, comments: [{ id: 1, author: "Reviewer", text: "Rename this" }, { id: 2, author: "Build bot", text: "Build queued", bot: true }, { id: 3, author: "Reviewer", text: "Thanks" }] }),
            thread(2, { resolved: true }),
            thread(3),
          ],
        },
      }));
      expect(await host.listThreads("app", 5)).toEqual([
        { id: 1, file: "src/a.ts", line: 12, comments: [{ id: 1, author: "Reviewer", text: "Rename this" }, { id: 3, author: "Reviewer", text: "Thanks" }] },
        { id: 3, file: undefined, line: undefined, comments: [{ id: 1, author: "Reviewer", text: "Please rename this" }] },
      ]);
    });

    it("replyToThread returns a new comment id and records it; resolveThread records the resolution", async () => {
      const f = fixture(world({ threads: { 5: [thread(1)] } }));
      const id = await f.host.replyToThread("app", 5, 1, 1, "Done, renamed.");
      expect(id).toBeGreaterThan(1);
      expect(f.replies()).toEqual([{ prId: 5, threadId: 1, parentCommentId: 1, text: "Done, renamed." }]);
      await f.host.resolveThread("app", 5, 1);
      expect(f.resolved()).toEqual([{ prId: 5, threadId: 1 }]);
    });
  });
}
