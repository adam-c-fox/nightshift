import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadReviewRecords, parseScoreArgs, scoreRecords } from "../src/score-review.js";
import type { TicketReview } from "../src/types.js";

const review = {
  candidates: [
    {
      id: "B1", lens: "bugs", kind: "finding", severity: "major", confidence: "proven", file: "src/a.ts", issue: "reads the first row only",
      suggestion: "", data: false, verdict: { id: "B1", verdict: "confirmed", note: "" },
    },
  ],
  findings: [],
  resolutions: [],
  lenses: [{ lens: "bugs", outcome: "reviewed", candidates: 1 }],
} as unknown as TicketReview;

const golden = {
  version: 1,
  ticket: "ENG-1",
  items: [{ id: "1-1", file: "src/a.ts", issue: "x", expect: "finding", origin: "change", match: { files: ["src/a.ts"], all: [["first row"]] } }],
};

const session = { tickets: [{ ticket: { id: "ENG-1" }, review, runs: [] }, { ticket: { id: "ENG-2" }, review }, { ticket: { id: "ENG-3" } }] };
const replay = { version: 1, ticket: { id: "ENG-1" }, review, runs: [], replay: {} };

describe("parseScoreArgs", () => {
  it("takes a golden dir and one or more record files", () => {
    expect(parseScoreArgs(["--golden", "g", "a.json", "b.json"])).toEqual({ golden: "g", records: ["a.json", "b.json"] });
  });

  it("takes an optional json output file", () => {
    expect(parseScoreArgs(["a.json", "--json", "out.json", "--golden", "g"])).toEqual({ golden: "g", json: "out.json", records: ["a.json"] });
  });

  it("requires the golden dir", () => {
    expect(() => parseScoreArgs(["a.json"])).toThrow("--golden is required");
  });

  it("requires at least one record file", () => {
    expect(() => parseScoreArgs(["--golden", "g"])).toThrow("record file");
  });

  it("rejects unknown flags", () => {
    expect(() => parseScoreArgs(["--golden", "g", "a.json", "--bogus"])).toThrow('unknown argument "--bogus"');
  });
});

describe("loadReviewRecords", () => {
  it("reads every reviewed ticket from a night session", () => {
    expect(loadReviewRecords(session, "s.json").map(r => r.ticket)).toEqual(["ENG-1", "ENG-2"]);
  });

  it("skips session tickets without a review", () => {
    expect(loadReviewRecords({ tickets: [{ ticket: { id: "ENG-3" } }] }, "s.json")).toEqual([]);
  });

  it("defaults runs to an empty list", () => {
    expect(loadReviewRecords(session, "s.json")[1]!.runs).toEqual([]);
  });

  it("keeps only the review runs of a session ticket, as a replay has", () => {
    const night = { tickets: [{ ticket: { id: "ENG-1" }, review, runs: [{ stage: "implement" }, { stage: "review-bugs" }, { stage: "review-confirm" }, { stage: "fix" }, { stage: "verify" }] }] };
    expect(loadReviewRecords(night, "s.json")[0]!.runs.map(r => r.stage)).toEqual(["review-bugs", "review-confirm"]);
  });

  it("reads a replay record", () => {
    expect(loadReviewRecords(replay, "replay.json")).toEqual([{ ticket: "ENG-1", review, runs: [], file: "replay.json" }]);
  });

  it("rejects a file that is neither", () => {
    expect(() => loadReviewRecords({ version: 2 }, "x.json")).toThrow("x.json is neither a night session nor a replay record");
  });
});

describe("scoreRecords", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("scores each ticket that has a golden set and skips the rest", () => {
    dir = mkdtempSync(join(tmpdir(), "score-review-"));
    mkdirSync(join(dir, "golden"));
    writeFileSync(join(dir, "golden", "ENG-1.json"), JSON.stringify(golden));
    writeFileSync(join(dir, "session-1.json"), JSON.stringify(session));
    const { scored, skipped } = scoreRecords(join(dir, "golden"), [join(dir, "session-1.json")]);
    expect(scored).toHaveLength(1);
    expect(scored[0]!.score.ticket).toBe("ENG-1");
    expect(scored[0]!.score.items[0]!.outcome).toBe("confirmed");
    expect(skipped).toEqual(["ENG-2 (session-1.json)"]);
  });
});
