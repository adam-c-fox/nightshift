import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { describeRemote } from "../src/pr-host-cli.js";

const AZURE_URL = "https://dev.azure.com/acme/My%20Proj/_git/app";
const run = (...args: string[]) => spawnSync("npx", ["tsx", "src/pr-host-cli.ts", ...args], { encoding: "utf-8" });

describe("describeRemote", () => {
  it("names the host and the env derived from an Azure remote", () => {
    expect(describeRemote(AZURE_URL)).toEqual({
      prHost: "azure-devops",
      env: { AZURE_DEVOPS_ORG: "acme", AZURE_DEVOPS_PROJECT: "My Proj" },
    });
  });

  it("reports an unsupported remote", () => {
    expect(describeRemote("git@github.com:acme/app.git")).toEqual({
      error: "no supported PR host for git@github.com:acme/app.git (supported: azure-devops)",
    });
  });
});

describe("pr-host command", () => {
  it("prints one JSON line and exits 0 for a supported remote", () => {
    const result = run(AZURE_URL);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      prHost: "azure-devops",
      env: { AZURE_DEVOPS_ORG: "acme", AZURE_DEVOPS_PROJECT: "My Proj" },
    });
  });

  it("exits 1 with the error on stderr for an unsupported remote", () => {
    const result = run("git@github.com:acme/app.git");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no supported PR host for git@github.com:acme/app.git (supported: azure-devops)");
  });

  it("exits 1 with usage when the argument count is wrong", () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
  });
}, 60_000);
