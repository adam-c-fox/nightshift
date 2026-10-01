import { describe, expect, it } from "vitest";
import { localDate, runStamp } from "../src/time.js";

describe("local time helpers", () => {
  const lateEveningPT = new Date("2026-10-02T06:05:00Z");

  it("uses the Vancouver calendar date, not UTC", () => {
    expect(localDate(lateEveningPT)).toBe("2026-10-01");
  });

  it("builds a sortable per-run stamp", () => {
    expect(runStamp(lateEveningPT)).toBe("20261001-2305");
  });

  it("uses 00 for midnight, not 24", () => {
    expect(runStamp(new Date("2026-10-02T07:00:00Z"))).toBe("20261002-0000");
  });
});
