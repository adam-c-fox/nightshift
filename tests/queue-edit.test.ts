import { describe, expect, it } from "vitest";
import { parseQueueOp } from "../src/dashboard/queue-edit.js";

describe("parseQueueOp notes and allowance", () => {
  it("accepts a notes op", () => {
    expect(parseQueueOp({ op: "notes", id: "GSAI-1", notes: ["a", "b"] })).toEqual({ op: "notes", id: "GSAI-1", notes: ["a", "b"] });
  });

  it("rejects bad notes ops", () => {
    expect(() => parseQueueOp({ op: "notes", id: "nope", notes: [] })).toThrow(/ticket ID/);
    expect(() => parseQueueOp({ op: "notes", id: "GSAI-1", notes: "a" })).toThrow(/list of strings/);
    expect(() => parseQueueOp({ op: "notes", id: "GSAI-1", notes: [1] })).toThrow(/list of strings/);
    expect(() => parseQueueOp({ op: "notes", id: "GSAI-1" })).toThrow(/list of strings/);
  });

  it("accepts an integer percent or null", () => {
    expect(parseQueueOp({ op: "allowance", percent: 50 })).toEqual({ op: "allowance", percent: 50 });
    expect(parseQueueOp({ op: "allowance", percent: null })).toEqual({ op: "allowance", percent: null });
  });

  it("rejects a missing, fractional, out-of-range or string percent", () => {
    for (const percent of [undefined, 0, 101, 1.5, "50"]) {
      expect(() => parseQueueOp({ op: "allowance", percent })).toThrow(/1 to 100/);
    }
  });
});
