import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  descriptionHash,
  prepState,
  readPrepStore,
  upsertPrepRecord,
  type PrepRecord,
} from "../src/prep.js";
import { TICKET_ID } from "../src/tickets.js";

const preppedAt = "2026-10-01T10:00:00.000Z";
const rec: PrepRecord = {
  project: "acme",
  preppedAt,
  descHash: descriptionHash("D"),
  outcome: "ready",
};

const tempFile = () =>
  join(mkdtempSync(join(tmpdir(), "nightshift-")), "state", "prep.json");

describe("TICKET_ID", () => {
  it("accepts only whole upper-case ticket ids", () => {
    expect(TICKET_ID.test("ENG-142")).toBe(true);
    expect(TICKET_ID.test("eng-1")).toBe(false);
    expect(TICKET_ID.test("ENG-")).toBe(false);
    expect(TICKET_ID.test("ENG-1 ")).toBe(false);
  });
});

describe("descriptionHash", () => {
  it("is the sha256 hex digest", () => {
    expect(descriptionHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(descriptionHash("")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("prepState", () => {
  it("is fresh when the description matches and there are no newer comments", () => {
    expect(prepState(rec, { description: "D", commentCreatedAt: [] })).toEqual({
      state: "fresh",
      preppedAt,
    });
  });

  it("is stale when the description changed", () => {
    expect(
      prepState(rec, { description: "D2", commentCreatedAt: [] }).state,
    ).toBe("stale");
  });

  it("is new_comments only for comments after the prep", () => {
    const issue = (at: string) => ({
      description: "D",
      commentCreatedAt: [at],
    });
    expect(prepState(rec, issue("2026-10-01T11:00:00Z")).state).toBe(
      "new_comments",
    );
    expect(prepState(rec, issue("2026-10-01T09:00:00Z")).state).toBe("fresh");
  });

  it("reports not_ready with its blockers", () => {
    const notReady: PrepRecord = {
      ...rec,
      outcome: "not_ready",
      blockers: "needs API spec",
    };
    expect(
      prepState(notReady, { description: "D", commentCreatedAt: [] }),
    ).toEqual({
      state: "not_ready",
      blockers: "needs API spec",
      preppedAt,
    });
  });

  it("lets a hash mismatch win over not_ready", () => {
    const notReady: PrepRecord = {
      ...rec,
      outcome: "not_ready",
      blockers: "needs API spec",
    };
    expect(
      prepState(notReady, { description: "D2", commentCreatedAt: [] }).state,
    ).toBe("stale");
  });

  it("infers prep from the description sections when there is no record", () => {
    for (const heading of ["Decisions", "Pointers", "Acceptance criteria"]) {
      const description = `x\n## ${heading}\n- a`;
      expect(
        prepState(undefined, { description, commentCreatedAt: [] }),
      ).toEqual({
        state: "inferred",
      });
    }
  });

  it("is none without a record or a prep section", () => {
    expect(
      prepState(undefined, {
        description: "### Decisions",
        commentCreatedAt: [],
      }),
    ).toEqual({ state: "none" });
    expect(
      prepState(undefined, { description: "", commentCreatedAt: [] }),
    ).toEqual({
      state: "none",
    });
  });
});

describe("prep store", () => {
  it("reads a missing store as empty", () => {
    expect(readPrepStore(tempFile())).toEqual({});
  });

  it("upserts records by ticket id", () => {
    const file = tempFile();
    const rec2: PrepRecord = { ...rec, project: "other" };
    upsertPrepRecord(file, "ENG-1", rec);
    upsertPrepRecord(file, "ENG-2", rec2);
    expect(readPrepStore(file)).toEqual({ "ENG-1": rec, "ENG-2": rec2 });
    const replacement: PrepRecord = {
      ...rec,
      outcome: "not_ready",
      blockers: "x",
    };
    upsertPrepRecord(file, "ENG-1", replacement);
    expect(readPrepStore(file)).toEqual({
      "ENG-1": replacement,
      "ENG-2": rec2,
    });
  });

  it("does not overwrite a corrupt store", () => {
    const file = tempFile();
    upsertPrepRecord(file, "ENG-1", rec);
    writeFileSync(file, "{");
    expect(() => upsertPrepRecord(file, "ENG-2", rec)).toThrow(
      /not valid JSON/,
    );
    expect(readFileSync(file, "utf-8")).toBe("{");
  });
});
