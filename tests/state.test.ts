import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile, statePaths, writeJsonAtomic } from "../src/state.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "nightshift-"));

describe("statePaths", () => {
  it("places prep.json and actions.json under <root>/state", () => {
    expect(statePaths("/r")).toEqual({
      prep: "/r/state/prep.json",
      actions: "/r/state/actions.json",
    });
  });
});

describe("readJsonFile", () => {
  it("returns the fallback for a missing file", () => {
    const dir = tempDir();
    expect(readJsonFile(join(dir, "nope.json"), { a: 1 })).toEqual({ a: 1 });
  });

  it("throws on invalid JSON", () => {
    const dir = tempDir();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{oops");
    expect(() => readJsonFile(bad, {})).toThrow(/bad\.json is not valid JSON/);
  });
});

describe("writeJsonAtomic", () => {
  it("round-trips, creating nested directories, 2-space indented with a trailing newline", () => {
    const dir = tempDir();
    const file = join(dir, "s", "x.json");
    writeJsonAtomic(file, { b: [1] });
    expect(readJsonFile(file, null)).toEqual({ b: [1] });
    expect(readFileSync(file, "utf-8")).toBe('{\n  "b": [\n    1\n  ]\n}\n');
  });

  it("leaves no temp file behind", () => {
    const dir = tempDir();
    writeJsonAtomic(join(dir, "s", "x.json"), { b: 1 });
    expect(readdirSync(join(dir, "s"))).toEqual(["x.json"]);
  });

  it("overwrites an existing file", () => {
    const dir = tempDir();
    const file = join(dir, "x.json");
    writeJsonAtomic(file, { v: 1 });
    writeJsonAtomic(file, { v: 2 });
    expect(readJsonFile(file, null)).toEqual({ v: 2 });
  });
});
