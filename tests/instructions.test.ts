import { describe, expect, it } from "vitest";
import { composeInstructions } from "../src/instructions.js";

describe("composeInstructions", () => {
  it("appends the project's instructions under a project heading", () => {
    expect(composeInstructions("# Generic\n", "acme", "Use pnpm.\n")).toBe("# Generic\n\n---\n\n# Project: acme\n\nUse pnpm.\n");
  });

  it("returns the generic instructions alone when the project has none", () => {
    expect(composeInstructions("# Generic\n", "acme", "  \n")).toBe("# Generic\n");
  });
});
