import { describe, expect, it, vi } from "vitest";
import { ExecError, execAsync, type Exec } from "../src/dashboard/exec.js";
import {
  azLoginStatus,
  azProjectFrom,
  listActivePrs,
  prCiVerdict,
  type AzProject,
} from "../src/dashboard/azure.js";
import { policyListArgs, prListArgs } from "../src/pr.js";

const org = "https://dev.azure.com/myorg";
const az: AzProject = {
  org,
  project: "P",
  env: { AZURE_DEVOPS_EXT_PAT: "pat" },
};

describe("azProjectFrom", () => {
  it("builds the org url and env from the lookup", () => {
    const lookup = (n: string) =>
      ({ AZURE_DEVOPS_ORG: "myorg", AZURE_DEVOPS_PROJECT: "P" })[n];
    const result = azProjectFrom(lookup);
    expect(result.org).toBe(org);
    expect(result.project).toBe("P");
  });

  it("throws when the org or project is missing", () => {
    expect(() =>
      azProjectFrom((n) => (n === "AZURE_DEVOPS_PROJECT" ? "P" : undefined)),
    ).toThrow(/AZURE_DEVOPS_ORG is not set/);
    expect(() =>
      azProjectFrom((n) => (n === "AZURE_DEVOPS_ORG" ? "o" : undefined)),
    ).toThrow(/AZURE_DEVOPS_PROJECT is not set/);
  });
});

describe("listActivePrs", () => {
  it("resolves the repo from origin and lists active PRs with the project env", async () => {
    const prs = [
      {
        pullRequestId: 7,
        sourceRefName: "refs/heads/ENG-1",
        targetRefName: "refs/heads/main",
      },
    ];
    const exec = vi.fn<Exec>(async (cmd) =>
      cmd === "git"
        ? { stdout: "git@ssh.dev.azure.com:v3/o/P/app\n", stderr: "" }
        : { stdout: JSON.stringify(prs), stderr: "" },
    );
    const result = await listActivePrs(exec, az, "/r/app");
    expect(result).toEqual({ repoName: "app", prs });
    const [gitCmd, gitArgs, gitOpts] = exec.mock.calls[0];
    expect(gitCmd).toBe("git");
    expect(gitArgs).toEqual(["remote", "get-url", "origin"]);
    expect(gitOpts.cwd).toBe("/r/app");
    const [azCmd, azArgs, azOpts] = exec.mock.calls[1];
    expect(azCmd).toBe("az");
    expect(azArgs).toEqual([
      ...prListArgs(org, "P", "app"),
      "--output",
      "json",
    ]);
    expect(azOpts.env).toBe(az.env);
  });

  it("treats empty az output as no PRs", async () => {
    const exec: Exec = async (cmd) => ({
      stdout: cmd === "git" ? "https://x/_git/app" : "",
      stderr: "",
    });
    expect(await listActivePrs(exec, az, "/r/app")).toEqual({
      repoName: "app",
      prs: [],
    });
  });
});

describe("prCiVerdict", () => {
  it("summarizes the policy evaluations", async () => {
    const evaluations = [
      {
        status: "approved",
        configuration: {
          isEnabled: true,
          isBlocking: true,
          type: { displayName: "Build" },
        },
      },
    ];
    const exec = vi.fn<Exec>(async () => ({
      stdout: JSON.stringify(evaluations),
      stderr: "",
    }));
    expect(await prCiVerdict(exec, az, 7)).toBe("succeeded");
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe("az");
    expect(args).toEqual([...policyListArgs(7, org), "--output", "json"]);
    expect(opts.env).toBe(az.env);
  });
});

describe("azLoginStatus", () => {
  it("reports the logged in user", async () => {
    const exec: Exec = async () => ({
      stdout: '{"user":{"name":"adam@x"}}',
      stderr: "",
    });
    expect(await azLoginStatus(exec)).toEqual({
      ok: true,
      reason: "logged in as adam@x",
    });
  });

  it("asks for az login when the command fails", async () => {
    const exec: Exec = async () => {
      throw new ExecError(
        "Please run 'az login'",
        "",
        "Please run 'az login'",
        1,
      );
    };
    const status = await azLoginStatus(exec);
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/az login/);
  });

  it("reports a missing az CLI", async () => {
    const exec: Exec = async () => {
      throw new ExecError("spawn az ENOENT", "", "", "ENOENT");
    };
    expect(await azLoginStatus(exec)).toEqual({
      ok: false,
      reason: "az CLI not found",
    });
  });
});

describe("execAsync", () => {
  it("resolves with stdout", async () => {
    const result = await execAsync(
      "node",
      ["-e", "process.stdout.write('hi')"],
      { timeoutMs: 5000 },
    );
    expect(result.stdout).toBe("hi");
  });

  it("rejects with an ExecError carrying the first stderr line and exit code", async () => {
    const error = await execAsync(
      "node",
      ["-e", "console.error('bad');process.exit(3)"],
      { timeoutMs: 5000 },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ExecError);
    expect(error.message).toBe("bad");
    expect(error.code).toBe(3);
  });
});
