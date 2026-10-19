import { describe, expect, it, vi } from "vitest";
import {
  buildPrepRecord,
  parsePrepMarkArgs,
  refreshDashboard,
} from "../src/prep-mark.js";
import { prepStatusLines } from "../src/prep-status.js";
import { descriptionHash, type PrepRecord } from "../src/prep.js";
import type { TodoIssue } from "../src/linear.js";

const preppedAt = "2026-10-07T20:00:00.000Z";

const issue = (identifier: string, description: string): TodoIssue => ({
  id: `id-${identifier}`,
  identifier,
  title: `Title ${identifier}`,
  url: `https://linear.app/acme/issue/${identifier}`,
  priority: 2,
  priorityLabel: "High",
  estimate: 3,
  teamKey: "ENG",
  description,
  commentCreatedAt: [],
});

const recFor = (description: string): PrepRecord => ({
  project: "acme",
  preppedAt,
  descHash: descriptionHash(description),
  outcome: "ready",
});

describe("parsePrepMarkArgs", () => {
  it("parses the ID and project", () => {
    expect(parsePrepMarkArgs(["ENG-1", "--project", "acme"])).toEqual({
      id: "ENG-1",
      project: "acme",
    });
  });

  it("parses repo and not-ready blockers", () => {
    expect(
      parsePrepMarkArgs([
        "ENG-1",
        "--project",
        "acme",
        "--repo",
        "app",
        "--not-ready",
        "needs API spec",
      ]),
    ).toEqual({
      id: "ENG-1",
      project: "acme",
      repo: "app",
      notReady: "needs API spec",
    });
  });

  it("rejects a malformed ticket ID", () => {
    expect(() => parsePrepMarkArgs(["eng-1", "--project", "a"])).toThrow(
      /ticket ID/,
    );
  });

  it("requires --project", () => {
    expect(() => parsePrepMarkArgs(["ENG-1"])).toThrow(/--project/);
  });

  it("rejects unknown arguments", () => {
    expect(() =>
      parsePrepMarkArgs(["ENG-1", "--project", "a", "extra"]),
    ).toThrow(/unknown argument "extra"/);
  });

  it("rejects empty --not-ready", () => {
    expect(() =>
      parsePrepMarkArgs(["ENG-1", "--project", "a", "--not-ready", ""]),
    ).toThrow(/--not-ready/);
  });
});

describe("buildPrepRecord", () => {
  const now = new Date("2026-10-07T20:00:00Z");

  it("records a ready prep without blockers", () => {
    const record = buildPrepRecord(
      { id: "ENG-1", project: "acme", repo: "app" },
      "D",
      now,
    );
    expect(record).toEqual({
      project: "acme",
      repo: "app",
      preppedAt,
      descHash: descriptionHash("D"),
      outcome: "ready",
    });
    expect(record).not.toHaveProperty("blockers");
  });

  it("records a not-ready prep with blockers", () => {
    expect(
      buildPrepRecord(
        { id: "ENG-1", project: "acme", repo: "app", notReady: "x" },
        "D",
        now,
      ),
    ).toEqual({
      project: "acme",
      repo: "app",
      preppedAt,
      descHash: descriptionHash("D"),
      outcome: "not_ready",
      blockers: "x",
    });
  });
});

describe("refreshDashboard", () => {
  it("asks the dashboard to reload its Linear data", async () => {
    const fetchFn = vi.fn(async () => new Response('{"ok":true}'));
    await refreshDashboard(fetchFn, "http://127.0.0.1:4100");
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:4100/api/refresh",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nightshift": "1" },
        body: JSON.stringify({ what: "linear" }),
      }),
    );
  });

  it("resolves when the dashboard is not running", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(refreshDashboard(fetchFn)).resolves.toBeUndefined();
  });
});

describe("prepStatusLines", () => {
  it("reports prep state for each Todo issue", () => {
    const lines = prepStatusLines(
      [issue("ENG-1", "D"), issue("ENG-2", "## Decisions")],
      { "ENG-1": recFor("D") },
    );
    expect(lines).toEqual([
      {
        id: "ENG-1",
        title: "Title ENG-1",
        team: "ENG",
        priority: "High",
        estimate: 3,
        url: "https://linear.app/acme/issue/ENG-1",
        prep: "fresh",
        preppedAt,
      },
      {
        id: "ENG-2",
        title: "Title ENG-2",
        team: "ENG",
        priority: "High",
        estimate: 3,
        url: "https://linear.app/acme/issue/ENG-2",
        prep: "inferred",
      },
    ]);
  });

  it("includes blockers for a not-ready record", () => {
    const [line] = prepStatusLines([issue("ENG-1", "D")], {
      "ENG-1": { ...recFor("D"), outcome: "not_ready", blockers: "x" },
    });
    expect(line).toMatchObject({ prep: "not_ready", blockers: "x" });
  });
});
