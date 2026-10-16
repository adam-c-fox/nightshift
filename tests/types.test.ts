import { describe, expect, it } from "vitest";
import { roundStage } from "../src/types.js";

describe("roundStage", () => {
  it("returns the bare name for the first round", () => {
    expect(roundStage("fix")).toBe("fix");
    expect(roundStage("fix", 1)).toBe("fix");
  });

  it("suffixes later rounds with the round number", () => {
    expect(roundStage("fix", 2)).toBe("fix-2");
    expect(roundStage("review-fixer", 3)).toBe("review-fixer-3");
  });
});
