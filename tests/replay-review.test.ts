import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TicketScore } from "../src/golden.js";
import { briefFromSession, buildIfScripted, goldenPath, parseReplayArgs, prepareScratch, replayLogDir, replayRecord, replaySummary } from "../src/replay-review.js";
import type { FindAndConfirmResult } from "../src/review.js";
import type { RunRecord, RunUsage } from "../src/types.js";

const required = ["--project", "acme", "--ticket", "ENG-1", "--base", "abc123", "--diff", "d.txt", "--report", "r.txt"];

describe("parseReplayArgs", () => {
  it("parses the required flags in any order", () => {
    expect(parseReplayArgs(["--report", "r.txt", "--base", "abc123", "--project", "acme", "--diff", "d.txt", "--ticket", "ENG-1"]))
      .toEqual({ project: "acme", ticket: "ENG-1", base: "abc123", diff: "d.txt", report: "r.txt", related: [], install: true });
  });

  it("collects repeated --related flags as ticket and branch", () => {
    expect(parseReplayArgs([...required, "--related", "ENG-2=feat/two", "--related", "ENG-3=feat/three"]).related)
      .toEqual([{ ticketId: "ENG-2", branch: "feat/two" }, { ticketId: "ENG-3", branch: "feat/three" }]);
  });

  it.each(["--project", "--ticket", "--base", "--diff", "--report"])("throws naming %s when it is missing", flag => {
    const i = required.indexOf(flag);
    const argv = [...required.slice(0, i), ...required.slice(i + 2)];
    expect(() => parseReplayArgs(argv)).toThrow(`${flag} is required`);
  });

  it("rejects a ticket that is not an ID", () => {
    expect(() => parseReplayArgs([...required.slice(0, 3), "nope", ...required.slice(4)])).toThrow("expected a ticket ID");
  });

  it("accepts a session file", () => {
    expect(parseReplayArgs([...required, "--session", "s.json"]).session).toBe("s.json");
  });

  it("turns installing off with --no-install", () => {
    expect(parseReplayArgs([...required, "--no-install"]).install).toBe(false);
  });

  it("rejects a related value without a branch", () => {
    expect(() => parseReplayArgs([...required, "--related", "ENG-2"])).toThrow("--related expects ID=branch");
  });

  it("rejects unknown arguments", () => {
    expect(() => parseReplayArgs([...required, "--bogus"])).toThrow('unknown argument "--bogus"');
  });
});

const usage = (over: Partial<RunUsage> = {}): RunUsage => ({
  inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheCreationTokens: 300, costUsd: 0.5, turns: 4, durationMs: 1000, models: ["m"], ...over,
});

const found: FindAndConfirmResult = {
  findings: [{ id: "R1", severity: "major", file: "src/a.ts", issue: "reads first row only", suggestion: "loop", from: "B2" }],
  risks: [{ file: "src/b.ts", risk: "invalid CSV rejects the export", data: true }, { file: "src/c.ts", risk: "no retry", data: false }],
  record: {
    lenses: [
      { lens: "bugs", outcome: "reviewed", candidates: 3 },
      { lens: "spec", outcome: "failed", reason: "timed out", candidates: 0 },
    ],
    decisions: [{ id: "D1", decision: "null on miss", file: "src/a.ts", ruling: "accept", reason: "holds on every path" }],
  },
  notes: [],
  needsReview: true,
};

const runs: RunRecord[] = [
  { stage: "review-bugs", usage: usage() },
  { stage: "review-spec" },
  { stage: "review-confirm", usage: usage({ inputTokens: 500, outputTokens: 50, costUsd: 0.25 }) },
];

describe("replaySummary", () => {
  const text = replaySummary(found, runs);

  it("prints each confirmed finding with its id, origin, severity and file", () => {
    expect(text).toContain("R1 (from B2) major src/a.ts: reads first row only");
  });

  it("prints risks with their data flag", () => {
    expect(text).toContain("src/b.ts [data]: invalid CSV rejects the export");
    expect(text).toContain("src/c.ts: no retry");
    expect(text).not.toContain("src/c.ts [data]");
  });

  it("prints rulings and lens outcomes", () => {
    expect(text).toContain("D1 accept: holds on every path");
    expect(text).toContain("bugs reviewed (3 candidates)");
    expect(text).toContain("spec failed: timed out");
  });

  it("prints usage per run and in total", () => {
    expect(text).toContain("review-bugs: 6,300 in / 200 out, $0.50");
    expect(text).toContain("review-spec: no usage recorded");
    expect(text).toContain("total: 12,100 in / 250 out, $0.75");
  });

  it("says when nothing was found", () => {
    const empty = replaySummary({ ...found, findings: [], risks: [], record: {} }, []);
    expect(empty).toContain("Confirmed findings: none");
    expect(empty).toContain("Risks: none");
  });

  it("reports why a stopped review stopped", () => {
    const stopped = replaySummary({ stopped: { review: { outcome: "failed", reason: "worktree changed", findings: [], resolutions: [] }, publish: false, needsReview: true, notes: [] } }, runs);
    expect(stopped).toContain("Review stopped: worktree changed");
    expect(stopped).toContain("total:");
  });
});

const session = {
  tickets: [
    {
      ticket: { id: "ENG-1", name: "Old name", context: ["keep it small"] },
      linear: { name: "CSV export", description: "Export rows", comments: [{ author: "a", body: "b", createdAt: "t" }], url: "https://linear.app/x/ENG-1", state: "In Progress" },
      checks: [
        { name: "tests", command: "npm test", passed: true, durationSec: 3 },
        { name: "lint", command: "npm run lint", passed: false, durationSec: 2 },
        { name: "types", command: "npm run typecheck", passed: false, durationSec: 1, status: "regression" },
      ],
    },
    { ticket: { id: "ENG-2", name: "Other" }, linear: null },
  ],
};

describe("briefFromSession", () => {
  it("builds the brief from the night's context and Linear snapshot", () => {
    expect(briefFromSession(session, "ENG-1").brief).toEqual({
      ticketId: "ENG-1", ticketName: "CSV export", context: ["keep it small"], linearDesc: "Export rows",
      linearComments: [{ author: "a", body: "b", createdAt: "t" }], linearUrl: "https://linear.app/x/ENG-1", state: "In Progress",
    });
  });

  it("falls back to the ticket's own fields without a Linear snapshot", () => {
    expect(briefFromSession(session, "ENG-2").brief).toEqual({
      ticketId: "ENG-2", ticketName: "Other", context: [], linearDesc: "", linearComments: [], linearUrl: "", state: "",
    });
  });

  it("rebuilds the night's checks for the prompt", () => {
    expect(briefFromSession(session, "ENG-1").checks).toEqual([
      { name: "tests", command: "npm test", passed: true, durationSec: 3, outputTail: "", status: "passed" },
      { name: "lint", command: "npm run lint", passed: false, durationSec: 2, outputTail: "", status: "pre-existing" },
      { name: "types", command: "npm run typecheck", passed: false, durationSec: 1, outputTail: "", status: "regression" },
    ]);
    expect(briefFromSession(session, "ENG-2").checks).toEqual([]);
  });

  it("throws naming the ticket when the session lacks it", () => {
    expect(() => briefFromSession(session, "ENG-9")).toThrow("ticket ENG-9 is not in the session");
    expect(() => briefFromSession({}, "ENG-9")).toThrow("ticket ENG-9 is not in the session");
  });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

describe("prepareScratch", () => {
  it("applies the diff without committing and leaves new files untracked", () => {
    const root = mkdtempSync(path.join(tmpdir(), "replay-scratch-"));
    const repo = path.join(root, "repo");
    const scratch = path.join(root, "scratch");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      git(repo, "config", "user.email", "t@test");
      git(repo, "config", "user.name", "t");
      writeFileSync(path.join(repo, "a.txt"), "one\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "init");
      const base = git(repo, "rev-parse", "HEAD").trim();
      writeFileSync(path.join(repo, "a.txt"), "two\n");
      writeFileSync(path.join(repo, "new.txt"), "fresh\n");
      git(repo, "add", "-N", "new.txt");
      const diffFile = path.join(root, "change.diff");
      writeFileSync(diffFile, git(repo, "diff"));
      git(repo, "reset", "-q", "--hard");
      git(repo, "clean", "-fdq");

      prepareScratch(repo, scratch, base, diffFile);

      expect(git(scratch, "status", "--porcelain").split("\n").filter(Boolean)).toEqual([" M a.txt", "?? new.txt"]);
      expect(git(scratch, "rev-parse", "HEAD").trim()).toBe(base);
      git(repo, "worktree", "remove", "--force", scratch);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildIfScripted", () => {
  const withPackage = (pkg: object): string => {
    const dir = mkdtempSync(path.join(tmpdir(), "replay-build-"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    return dir;
  };

  it("runs the build script when package.json has one", () => {
    const dir = withPackage({ scripts: { build: "tsc" } });
    const ran: string[] = [];
    expect(buildIfScripted(dir, () => {}, cwd => { ran.push(cwd); })).toBe(true);
    expect(ran).toEqual([dir]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips when there is no build script", () => {
    const dir = withPackage({ scripts: { test: "vitest" } });
    const ran: string[] = [];
    expect(buildIfScripted(dir, () => {}, cwd => { ran.push(cwd); })).toBe(false);
    expect(ran).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("logs and carries on when the build fails", () => {
    const dir = withPackage({ scripts: { build: "tsc" } });
    const logs: string[] = [];
    const fail = () => { throw Object.assign(new Error("boom"), { stderr: "error TS1\nmore" }); };
    expect(buildIfScripted(dir, m => logs.push(m), fail)).toBe(false);
    expect(logs).toEqual(["Build failed in the replay worktree; finders may not run tests: error TS1"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("replayLogDir", () => {
  it("uses the date when the directory is free", () => {
    expect(replayLogDir("/logs/acme", "2026-10-09", () => false)).toBe("/logs/acme/replay-2026-10-09");
  });

  it("takes the next free numbered suffix", () => {
    const taken = new Set(["/logs/acme/replay-2026-10-09", "/logs/acme/replay-2026-10-09-2"]);
    expect(replayLogDir("/logs/acme", "2026-10-09", d => taken.has(d))).toBe("/logs/acme/replay-2026-10-09-3");
  });
});

describe("replayRecord", () => {
  const args = parseReplayArgs([...required, "--related", "ENG-2=feat/two", "--session", "s.json"]);
  const meta = { installed: true, pipeline: { commit: "deadbeef", dirty: false }, startedAt: "2026-10-09T01:00:00.000Z", endedAt: "2026-10-09T01:05:00.000Z" };
  const withCandidates: FindAndConfirmResult = {
    ...found,
    record: {
      ...found.record,
      candidates: [{ id: "B2", lens: "bugs", kind: "finding", severity: "major", confidence: "proven", file: "src/a.ts", issue: "reads first row only", suggestion: "loop", data: false, verdict: { id: "B2", verdict: "confirmed", note: "reproduced" } }],
    },
  };

  it("records candidates with verdicts, lenses, runs, args and the pipeline commit", () => {
    const record = replayRecord(args, withCandidates, runs, meta);
    expect(record.version).toBe(1);
    expect(record.ticket).toEqual({ id: "ENG-1" });
    expect(record.review.outcome).toBe("reviewed");
    expect(record.review.findings).toEqual(found.findings);
    expect(record.review.risks).toEqual(found.risks);
    expect(record.review.lenses).toEqual(found.record.lenses);
    expect(record.review.candidates?.[0]).toMatchObject({ id: "B2", verdict: { verdict: "confirmed" } });
    expect(record.runs).toEqual(runs);
    expect(record.replay).toEqual({
      base: "abc123", diff: path.resolve("d.txt"), report: path.resolve("r.txt"), related: [{ ticketId: "ENG-2", branch: "feat/two" }],
      session: path.resolve("s.json"), ...meta,
    });
  });

  it("omits the session when none was given", () => {
    expect("session" in replayRecord(parseReplayArgs(required), found, runs, meta).replay).toBe(false);
  });

  it("records a stopped review with its reason", () => {
    const stopped = { review: { outcome: "failed" as const, reason: "worktree changed", findings: [], resolutions: [] }, publish: false, needsReview: true, notes: [] };
    const record = replayRecord(args, { stopped }, runs, meta);
    expect(record.review).toEqual(stopped.review);
  });
});

describe("goldenPath", () => {
  it("points at the project's golden directory", () => {
    expect(goldenPath("acme", "ENG-1", "/p")).toBe("/p/acme/golden/ENG-1.json");
  });
});

describe("replaySummary with a score", () => {
  it("appends the score when a golden set is given", () => {
    const counts = { items: 0, found: 0, confirmed: 0, surfaced: 0, met: 0, lost: 0 };
    const score: TicketScore = { ticket: "ENG-1", items: [], guards: [], fixItems: [], noise: [], counts, guardCounts: counts, noiseConfirmed: 0, unmatchedConfirmed: [], runs: [] };
    const plain = replaySummary(found, runs);
    const scored = replaySummary(found, runs, score);
    expect(scored.startsWith(`${plain}\n\n`)).toBe(true);
    expect(replaySummary({ stopped: { review: { outcome: "failed", reason: "x", findings: [], resolutions: [] }, publish: false, needsReview: true, notes: [] } }, runs, score)).toContain("\n\n");
  });
});
