import { describe, expect, it } from "vitest";
import { parseOpenPrsArgs } from "../src/open-prs.js";

describe("parseOpenPrsArgs", () => {
  it("parses repo:ID pairs in order", () => {
    expect(parseOpenPrsArgs(["main:ENG-142", "terraform:INF-7"])).toEqual([
      { repo: "main", id: "ENG-142" },
      { repo: "terraform", id: "INF-7" },
    ]);
  });

  it("throws on missing colon, unknown repo or bad ID", () => {
    expect(() => parseOpenPrsArgs(["ENG-142"])).toThrow();
    expect(() => parseOpenPrsArgs(["web:ENG-142"])).toThrow();
    expect(() => parseOpenPrsArgs(["main:eng142"])).toThrow();
  });

  it("throws when no args are given", () => {
    expect(() => parseOpenPrsArgs([])).toThrow();
  });
});
