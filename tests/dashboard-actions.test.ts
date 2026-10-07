import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTION_KEY,
  mergeActions,
  parseActionsBody,
  parseReportId,
  putActions,
  readActions,
  tickedKeys,
  type ReportActions,
} from "../src/dashboard/actions.js";

const tempFile = () =>
  join(mkdtempSync(join(tmpdir(), "nightshift-")), "actions.json");

const entry = (at: string | null, updatedAt: string) => ({ at, updatedAt });

describe("parseReportId", () => {
  it.each([
    "acme/nightshift-2026-10-01",
    "nightshift-2026-10-01-2",
    "my.proj/nightshift-2026-10-01",
  ])("accepts %s", (id) => {
    expect(parseReportId(id)).toBe(id);
  });

  it.each([
    null,
    "",
    "../nightshift-2026-10-01",
    "acme/../nightshift-2026-10-01",
    "acme/x/nightshift-2026-10-01",
    "acme/nightshift-2026-10-01.html",
    "acme/nightshift-2026-10-01-postmortem",
    ".a/nightshift-2026-10-01",
  ])("rejects %s", (id) => {
    expect(() => parseReportId(id)).toThrow("invalid report id");
  });
});

describe("ACTION_KEY", () => {
  it("accepts ticket and postmortem keys only", () => {
    expect(ACTION_KEY.test("ticket:ENG-1")).toBe(true);
    expect(ACTION_KEY.test("postmortem:P1")).toBe(true);
    expect(ACTION_KEY.test("ticket:eng-1")).toBe(false);
    expect(ACTION_KEY.test("note:x")).toBe(false);
    expect(ACTION_KEY.test("ticket:ENG-1\n")).toBe(false);
  });
});

describe("parseActionsBody", () => {
  const iso = "2026-10-02T00:00:00.000Z";

  it("accepts a valid body", () => {
    const body = { "ticket:ENG-1": { at: iso, updatedAt: iso } };
    expect(parseActionsBody(body)).toEqual(body);
  });

  it("rejects an unknown key", () => {
    expect(() =>
      parseActionsBody({ "note:x": { at: null, updatedAt: iso } }),
    ).toThrow(/key/);
  });

  it("rejects a non-string at", () => {
    expect(() =>
      parseActionsBody({ "ticket:ENG-1": { at: 5, updatedAt: iso } }),
    ).toThrow(/at/);
  });

  it("rejects a missing updatedAt", () => {
    expect(() => parseActionsBody({ "ticket:ENG-1": { at: null } })).toThrow(
      /updatedAt/,
    );
  });

  it("rejects an updatedAt that is not ISO", () => {
    expect(() =>
      parseActionsBody({
        "ticket:ENG-1": { at: null, updatedAt: "yesterday" },
      }),
    ).toThrow(/updatedAt/);
  });

  it("rejects an array body", () => {
    expect(() => parseActionsBody([])).toThrow();
  });

  it("rejects more than 500 keys", () => {
    const body: Record<string, unknown> = {};
    for (let i = 1; i <= 501; i++) {
      body[`ticket:ENG-${i}`] = { at: null, updatedAt: iso };
    }
    expect(() => parseActionsBody(body)).toThrow(/500/);
  });
});

describe("mergeActions latest", () => {
  const key = "ticket:ENG-1";
  const current: ReportActions = {
    [key]: entry("2026-10-02T00:00:00.000Z", "2026-10-02T00:00:00.000Z"),
    "ticket:ENG-2": entry(null, "2026-10-02T00:00:00.000Z"),
  };

  it("replaces with a newer updatedAt", () => {
    const incoming = { [key]: entry(null, "2026-10-03T00:00:00.000Z") };
    expect(mergeActions(current, incoming, "latest")[key]).toEqual(
      incoming[key],
    );
  });

  it("keeps current for an older updatedAt", () => {
    const incoming = { [key]: entry(null, "2026-10-01T00:00:00.000Z") };
    expect(mergeActions(current, incoming, "latest")[key]).toEqual(
      current[key],
    );
  });

  it("keeps current for an equal updatedAt", () => {
    const incoming = { [key]: entry(null, "2026-10-02T00:00:00.000Z") };
    expect(mergeActions(current, incoming, "latest")[key]).toEqual(
      current[key],
    );
  });

  it("adds new keys and keeps keys only in current", () => {
    const added = entry("2026-10-03T00:00:00.000Z", "2026-10-03T00:00:00.000Z");
    const merged = mergeActions(current, { "ticket:ENG-3": added }, "latest");
    expect(merged).toEqual({ ...current, "ticket:ENG-3": added });
  });
});

describe("mergeActions tickWins", () => {
  const key = "ticket:ENG-1";

  it("lets an incoming tick beat a newer untick", () => {
    const current = { [key]: entry(null, "2026-10-03T00:00:00.000Z") };
    const incoming = {
      [key]: entry("2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"),
    };
    expect(mergeActions(current, incoming, "tickWins")[key]).toEqual(
      incoming[key],
    );
  });

  it("keeps current when both are ticked", () => {
    const current = {
      [key]: entry("2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"),
    };
    const incoming = {
      [key]: entry("2026-10-05T00:00:00.000Z", "2026-10-05T00:00:00.000Z"),
    };
    expect(mergeActions(current, incoming, "tickWins")[key]).toEqual(
      current[key],
    );
  });

  it("ignores an incoming untick", () => {
    const current = {
      [key]: entry("2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"),
    };
    const incoming = { [key]: entry(null, "2026-10-09T00:00:00.000Z") };
    expect(mergeActions(current, incoming, "tickWins")).toEqual(current);
  });

  it("ignores an incoming untick for an unknown key", () => {
    const incoming = { [key]: entry(null, "2026-10-09T00:00:00.000Z") };
    expect(mergeActions({}, incoming, "tickWins")).toEqual({});
  });
});

describe("putActions", () => {
  const first = "acme/nightshift-2026-10-01";
  const second = "acme/nightshift-2026-10-02";
  const incoming = {
    "ticket:ENG-1": entry(
      "2026-10-02T00:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
    ),
  };

  it("creates the store on a missing file and returns the report actions", () => {
    const file = tempFile();
    expect(putActions(file, first, incoming, "latest")).toEqual(incoming);
    expect(readActions(file)).toEqual({ [first]: incoming });
  });

  it("keeps other reports on a second put", () => {
    const file = tempFile();
    putActions(file, first, incoming, "latest");
    putActions(file, second, incoming, "latest");
    expect(readActions(file)).toEqual({
      [first]: incoming,
      [second]: incoming,
    });
  });

  it("leaves a corrupt store untouched", () => {
    const file = tempFile();
    writeFileSync(file, "{");
    expect(() => putActions(file, first, incoming, "latest")).toThrow(
      /not valid JSON/,
    );
    expect(readFileSync(file, "utf-8")).toBe("{");
  });
});

describe("tickedKeys", () => {
  it("returns only keys with a tick", () => {
    expect(tickedKeys({ a: entry("x", "x"), b: entry(null, "x") })).toEqual(
      new Set(["a"]),
    );
  });

  it("returns an empty set for undefined", () => {
    expect(tickedKeys(undefined)).toEqual(new Set());
  });
});
