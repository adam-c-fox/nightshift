import { describe, expect, it } from "vitest";
import { extractFlag, parseRunArgs } from "../src/args.js";

describe("extractFlag", () => {
  it("returns undefined and the untouched argv when the flag is absent", () => {
    expect(extractFlag(["a", "--dry-run"], "--project")).toEqual({ value: undefined, rest: ["a", "--dry-run"] });
  });

  it("returns the value after the flag", () => {
    expect(extractFlag(["--project", "acme"], "--project").value).toBe("acme");
  });

  it.each([[["--project"]], [["--project", "--dry-run"]]])("throws naming the flag when %j has no value", (argv) => {
    expect(() => extractFlag(argv, "--project")).toThrow("--project needs a value");
  });

  it("leaves out the flag and its value from rest", () => {
    expect(extractFlag(["x", "--project", "acme", "y"], "--project").rest).toEqual(["x", "y"]);
  });
});

describe("parseRunArgs", () => {
  it("parses all flags in any order", () => {
    expect(parseRunArgs(["--allowance", "100", "--dry-run", "--project", "acme"]))
      .toEqual({ dryRun: true, project: "acme", allowancePercent: 100 });
  });

  it("leaves unset flags undefined", () => {
    expect(parseRunArgs([])).toEqual({ dryRun: false });
  });

  it.each([["--allowance"], ["--allowance", "--dry-run"], ["--allowance", "abc"], ["--allowance", "0"], ["--allowance", "101"], ["--allowance", "12.5"]])(
    "rejects %j", (...argv) => {
      expect(() => parseRunArgs(argv)).toThrow(/--allowance/);
    },
  );

  it("rejects --project without a name", () => {
    expect(() => parseRunArgs(["--project", "--dry-run"])).toThrow(/--project/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseRunArgs(["--alowance", "50"])).toThrow(/--alowance/);
  });
});
