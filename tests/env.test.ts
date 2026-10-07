import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getEnv, lookupEnv, parseEnv, useProjectEnv } from "../src/env.js";
import { authorizationHeader } from "../src/linear.js";

describe("parseEnv", () => {
  it("handles comments, quotes and export prefixes", () => {
    expect(parseEnv(["# c", "A=1", 'B="two words"', "export C='x'", "D=val # trailing", "", "bad line"].join("\n")))
      .toEqual({ A: "1", B: "two words", C: "x", D: "val" });
  });
});

describe("authorizationHeader", () => {
  it("sends personal keys raw and OAuth tokens as bearer", () => {
    expect(authorizationHeader("lin_api_abc")).toBe("lin_api_abc");
    expect(authorizationHeader("lin_oauth_abc")).toBe("Bearer lin_oauth_abc");
  });
});

describe("lookupEnv", () => {
  it("takes the first layer with a non-empty value", () => {
    expect(lookupEnv("A", [{ A: "" }, { A: "project" }, { A: "root" }])).toBe("project");
    expect(lookupEnv("A", [{}, {}, { A: "root" }])).toBe("root");
    expect(lookupEnv("A", [{}, {}])).toBeUndefined();
  });
});

describe("useProjectEnv", () => {
  afterEach(() => useProjectEnv(join(tmpdir(), "nightshift-missing", ".env")));

  it("reads values from the project's env file", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-"));
    writeFileSync(join(dir, ".env"), "NIGHTSHIFT_TEST_ONLY_VALUE=from-project\n");
    useProjectEnv(join(dir, ".env"));
    expect(getEnv("NIGHTSHIFT_TEST_ONLY_VALUE")).toBe("from-project");
  });

  it("treats a missing project env file as empty", () => {
    useProjectEnv(join(tmpdir(), "nightshift-missing", ".env"));
    expect(getEnv("NIGHTSHIFT_TEST_ONLY_VALUE")).toBeUndefined();
  });
});
