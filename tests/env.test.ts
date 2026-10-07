import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envLookup, getEnv, lookupEnv, parseEnv, ROOT_ENV_FILE, useProjectEnv } from "../src/env.js";
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

describe("envLookup", () => {
  afterEach(() => vi.unstubAllEnvs());

  const writeEnvFiles = () => {
    const dir = mkdtempSync(join(tmpdir(), "env-"));
    const a = join(dir, "a.env");
    const b = join(dir, "b.env");
    writeFileSync(a, "K=fromA\nE=\n");
    writeFileSync(b, "K=fromB\nE=fromB\nM=m\n");
    return { a, b, missing: join(dir, "missing.env") };
  };

  it("takes the first file with a non-empty value and ignores missing files", () => {
    const { a, b, missing } = writeEnvFiles();
    const lookup = envLookup([missing, a, b]);
    expect(lookup("K")).toBe("fromA");
    expect(lookup("E")).toBe("fromB");
    expect(lookup("M")).toBe("m");
    expect(lookup("NIGHTSHIFT_TEST_ABSENT")).toBeUndefined();
  });

  it("prefers process.env over the files", () => {
    const { a, b } = writeEnvFiles();
    vi.stubEnv("K", "env");
    expect(envLookup([a, b])("K")).toBe("env");
  });
});

describe("ROOT_ENV_FILE", () => {
  it("points at the repo root .env", () => {
    expect(ROOT_ENV_FILE).toMatch(/\.env$/);
  });
});
