import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openNightBudget } from "../src/budget.js";
import {
  nightRecord,
  nightRecordFile,
  readNightRecord,
  writeNightRecord,
} from "../src/night-record.js";
import type { SessionResult } from "../src/types.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "nightshift-"));

const session: SessionResult = {
  date: "2026-10-07",
  startedAt: "10/7/2026, 6:00:00 AM",
  endedAt: "10/7/2026, 8:30:00 AM",
  tickets: [],
  budget: openNightBudget({ weeklyPercent: 3, resetInfo: "Oct 7" }, 15),
  gateHit: false,
  skipReason: "",
  noTasks: true,
};

describe("nightRecord", () => {
  it("adds ISO timestamps and the dry-run flag to the session", () => {
    const record = nightRecord(
      session,
      new Date("2026-10-07T06:00:00Z"),
      new Date("2026-10-07T08:30:00Z"),
      false,
    );
    expect(record).toEqual({
      ...session,
      startedAtIso: "2026-10-07T06:00:00.000Z",
      endedAtIso: "2026-10-07T08:30:00.000Z",
      dryRun: false,
    });
  });
});

describe("writeNightRecord and readNightRecord", () => {
  it("round-trips a record at <reportsDir>/<base>.json", () => {
    const dir = tempDir();
    const record = nightRecord(
      session,
      new Date("2026-10-07T06:00:00Z"),
      new Date("2026-10-07T08:30:00Z"),
      true,
    );
    const file = writeNightRecord(dir, "nightshift-2026-10-07", record);
    expect(file).toBe(join(dir, "nightshift-2026-10-07.json"));
    expect(nightRecordFile(dir, "nightshift-2026-10-07")).toBe(file);
    expect(readNightRecord(file)).toEqual(record);
  });

  it("rejects a file that is not a night record", () => {
    const file = join(tempDir(), "x.json");
    writeFileSync(file, "{}");
    expect(() => readNightRecord(file)).toThrow(/is not a night record/);
  });

  it("propagates ENOENT for a missing file", () => {
    expect(() => readNightRecord(join(tempDir(), "missing.json"))).toThrow(
      /ENOENT/,
    );
  });
});
