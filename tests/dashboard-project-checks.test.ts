import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fileChecks,
  overallLevel,
  projectChecks,
  requiredEnvKeys,
  type CheckDeps,
  type ConfigCheck,
} from "../src/dashboard/project-checks.js";
import { resolveDefaultRepo, resolveTestDbPath } from "../src/project.js";

const ROOT_KEYS =
  "LINEAR_API_KEY=\nCLAUDE_CODE_OAUTH_TOKEN=\nNIGHTSHIFT_PROJECT=\n";
const PROJECT_KEYS =
  "AZURE_DEVOPS_ORG=\nAZURE_DEVOPS_PROJECT=\nAZURE_DEVOPS_PAT=\nBRANCH_PREFIX=\n";
const ENV_KEYS = [
  "LINEAR_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AZURE_DEVOPS_ORG",
  "AZURE_DEVOPS_PROJECT",
  "AZURE_DEVOPS_PAT",
  "AZURE_DEVOPS_EXT_PAT",
  "BRANCH_PREFIX",
];
const ok = <T>(value: T) => ({ ok: true as const, value });
const failed = (error: string) => ({ ok: false as const, error });

let root: string;
let projectsDir: string;
let repo: string;
let plain: string;

function writeProject(
  name: string,
  config: unknown,
  files: Record<string, string> = {},
) {
  const dir = join(projectsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "project.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
}

function goodConfig(overrides: Record<string, unknown> = {}) {
  return {
    repos: { app: { path: repo, toolchain: "node", description: "d" } },
    testDb: "db.sh",
    linearTeams: ["DEMO"],
    ...overrides,
  };
}

const goodFiles = {
  "AGENTS.md": "# agents",
  "db.sh": "#!/bin/sh",
  ".env": "LINEAR_API_KEY=secretvalue\nCLAUDE_CODE_OAUTH_TOKEN=\n",
};

function deps(overrides: Partial<CheckDeps> = {}): CheckDeps {
  return {
    projectsDir,
    exampleDir: join(projectsDir, "example"),
    rootDir: root,
    teams: async () => ok([{ key: "DEMO", name: "G" }]),
    azLogin: async () => ({ ok: true, reason: "logged in as a" }),
    ...overrides,
  };
}

const byName = (checks: ConfigCheck[], name: string) =>
  checks.find((check) => check.name === name)!;

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, "");
  root = mkdtempSync(join(tmpdir(), "nightshift-"));
  projectsDir = join(root, "projects");
  mkdirSync(join(projectsDir, "example"), { recursive: true });
  writeFileSync(join(root, ".env.example"), ROOT_KEYS);
  writeFileSync(join(projectsDir, "example", ".env.example"), PROJECT_KEYS);
  repo = join(root, "r");
  mkdirSync(join(repo, ".git"), { recursive: true });
  plain = join(root, "plain");
  mkdirSync(plain);
  writeProject("good", goodConfig(), goodFiles);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("fileChecks", () => {
  it("runs every check in order for a healthy project", () => {
    const checks = fileChecks("good", deps());
    expect(checks.map((c) => c.name)).toEqual([
      "config",
      "repo app",
      "defaultRepo",
      "AGENTS.md",
      ".env",
      "testDb",
    ]);
    expect(byName(checks, "config").level).toBe("pass");
    expect(byName(checks, "repo app").level).toBe("pass");
    expect(byName(checks, "defaultRepo")).toMatchObject({
      level: "pass",
      reason: expect.stringMatching(/defaults to app/),
    });
    expect(byName(checks, "AGENTS.md").level).toBe("pass");
    expect(byName(checks, "testDb").level).toBe("pass");
  });

  it("reports present and missing env keys across the union of both examples", () => {
    const env = byName(fileChecks("good", deps()), ".env");
    expect(env.level).toBe("warn");
    expect(env.keys).toEqual({
      present: ["LINEAR_API_KEY"],
      missing: [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "AZURE_DEVOPS_ORG",
        "AZURE_DEVOPS_PROJECT",
        "BRANCH_PREFIX",
      ],
    });
  });

  it("counts a key as present when the root .env or process env has it", () => {
    writeFileSync(join(root, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=rootsecret\n");
    vi.stubEnv("AZURE_DEVOPS_ORG", "fromprocess");
    const env = byName(fileChecks("good", deps()), ".env");
    expect(env.keys!.present).toEqual([
      "LINEAR_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AZURE_DEVOPS_ORG",
    ]);
  });

  it("passes when every required key is present", () => {
    writeFileSync(
      join(projectsDir, "good", ".env"),
      ENV_KEYS.filter((key) => !key.includes("PAT"))
        .map((key) => `${key}=v`)
        .join("\n"),
    );
    const env = byName(fileChecks("good", deps()), ".env");
    expect(env.level).toBe("pass");
    expect(env.keys!.missing).toEqual([]);
  });

  it("never leaks env values", () => {
    expect(JSON.stringify(fileChecks("good", deps()))).not.toContain(
      "secretvalue",
    );
  });

  it("fails a repo that is not a git repository", () => {
    writeProject(
      "good",
      goodConfig({
        repos: { app: { path: plain, toolchain: "node", description: "d" } },
      }),
      goodFiles,
    );
    const checks = fileChecks("good", deps());
    expect(byName(checks, "repo app")).toMatchObject({
      level: "fail",
      reason: expect.stringMatching(/not a git repository/),
    });
  });

  it("fails a repo whose path is missing, and the config check with it", () => {
    writeProject(
      "good",
      goodConfig({
        repos: {
          app: {
            path: join(root, "gone"),
            toolchain: "node",
            description: "d",
          },
        },
      }),
      goodFiles,
    );
    const checks = fileChecks("good", deps());
    expect(byName(checks, "repo app")).toMatchObject({
      level: "fail",
      reason: expect.stringMatching(/does not exist/),
    });
    expect(byName(checks, "config")).toMatchObject({
      level: "fail",
      reason: expect.stringMatching(/does not exist/),
    });
  });

  it("fails config on bad JSON and still runs the file checks", () => {
    writeProject("good", "{", goodFiles);
    const checks = fileChecks("good", deps());
    expect(byName(checks, "config")).toMatchObject({
      level: "fail",
      reason: expect.stringMatching(/not valid JSON/),
    });
    expect(byName(checks, "AGENTS.md").level).toBe("pass");
    expect(byName(checks, ".env").level).toBe("warn");
  });

  it("fails config for an unknown project", () => {
    const [check] = fileChecks("nope", deps());
    expect(check).toMatchObject({ name: "config", level: "fail" });
  });

  it("fails a defaultRepo that is not one of the repos", () => {
    const other = join(root, "r2");
    mkdirSync(join(other, ".git"), { recursive: true });
    writeProject(
      "good",
      goodConfig({
        repos: {
          app: { path: repo, toolchain: "node", description: "d" },
          web: { path: other, toolchain: "node", description: "d" },
        },
        defaultRepo: "x",
      }),
      goodFiles,
    );
    expect(byName(fileChecks("good", deps()), "defaultRepo")).toMatchObject({
      level: "fail",
      reason: expect.stringMatching(/not one of/),
    });
  });

  it("warns when AGENTS.md is missing", () => {
    rmSync(join(projectsDir, "good", "AGENTS.md"));
    expect(byName(fileChecks("good", deps()), "AGENTS.md").level).toBe("warn");
  });

  it("fails when .env is missing and keys are missing", () => {
    rmSync(join(projectsDir, "good", ".env"));
    const env = byName(fileChecks("good", deps()), ".env");
    expect(env.level).toBe("fail");
    expect(env.reason).toMatch(/fill in projects\/good\/.env/);
    expect(env.keys!.present).toEqual([]);
    expect(env.keys!.missing).toHaveLength(5);
  });

  it("passes testDb as not configured when absent", () => {
    writeProject("good", goodConfig({ testDb: undefined }), goodFiles);
    expect(byName(fileChecks("good", deps()), "testDb")).toMatchObject({
      level: "pass",
      reason: expect.stringMatching(/not configured/),
    });
  });

  it("fails testDb when the script is missing", () => {
    rmSync(join(projectsDir, "good", "db.sh"));
    expect(byName(fileChecks("good", deps()), "testDb")).toMatchObject({
      level: "fail",
      reason: expect.stringMatching(/does not exist/),
    });
  });
});

describe("requiredEnvKeys", () => {
  it("uses the example project keys plus the root keys, minus NIGHTSHIFT_PROJECT", () => {
    expect(
      requiredEnvKeys(
        join(projectsDir, "good"),
        join(projectsDir, "example"),
        root,
      ),
    ).toEqual([
      "LINEAR_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AZURE_DEVOPS_ORG",
      "AZURE_DEVOPS_PROJECT",
      "BRANCH_PREFIX",
    ]);
  });

  it("prefers the project's own .env.example", () => {
    writeFileSync(join(projectsDir, "good", ".env.example"), "CUSTOM_KEY=\n");
    expect(
      requiredEnvKeys(
        join(projectsDir, "good"),
        join(projectsDir, "example"),
        root,
      ),
    ).toEqual(["LINEAR_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CUSTOM_KEY"]);
  });
});

describe("projectChecks", () => {
  it("appends passing linearTeams and az login checks", async () => {
    const checks = await projectChecks("good", deps());
    expect(checks.slice(-2)).toEqual([
      expect.objectContaining({ name: "linearTeams", level: "pass" }),
      expect.objectContaining({
        name: "az login",
        level: "pass",
        reason: "logged in as a",
      }),
    ]);
  });

  it("fails unknown team keys", async () => {
    const checks = await projectChecks(
      "good",
      deps({ teams: async () => ok([{ key: "ENG", name: "E" }]) }),
    );
    expect(byName(checks, "linearTeams")).toMatchObject({
      level: "fail",
      reason: expect.stringMatching(/unknown team keys: DEMO/),
    });
  });

  it("warns when teams cannot be loaded", async () => {
    const checks = await projectChecks(
      "good",
      deps({ teams: async () => failed("no key") }),
    );
    expect(byName(checks, "linearTeams")).toMatchObject({
      level: "warn",
      reason: expect.stringMatching(/couldn't check/),
    });
  });

  it("passes without calling teams when no linearTeams are configured", async () => {
    writeProject("good", goodConfig({ linearTeams: undefined }), goodFiles);
    const teams = vi.fn(async () => ok([]));
    const checks = await projectChecks("good", deps({ teams }));
    expect(byName(checks, "linearTeams")).toMatchObject({
      level: "pass",
      reason: expect.stringMatching(/all your Todo tickets/),
    });
    expect(teams).not.toHaveBeenCalled();
  });

  it("fails az login when not logged in", async () => {
    const checks = await projectChecks(
      "good",
      deps({ azLogin: async () => ({ ok: false, reason: "not logged in" }) }),
    );
    expect(byName(checks, "az login")).toMatchObject({
      level: "fail",
      reason: "not logged in",
    });
  });

  it("passes az login from a PAT in the env chain without running az", async () => {
    writeFileSync(
      join(projectsDir, "good", ".env"),
      "AZURE_DEVOPS_PAT=secretpat\n",
    );
    const azLogin = vi.fn(async () => ({
      ok: false,
      reason: "should not run",
    }));
    const checks = await projectChecks("good", deps({ azLogin }));
    expect(byName(checks, "az login")).toMatchObject({
      level: "pass",
      reason: "using the PAT from .env",
    });
    expect(azLogin).not.toHaveBeenCalled();
    expect(JSON.stringify(checks)).not.toContain("secretpat");
  });

  it("accepts AZURE_DEVOPS_EXT_PAT from the root .env", async () => {
    writeFileSync(join(root, ".env"), "AZURE_DEVOPS_EXT_PAT=rootpat\n");
    const azLogin = vi.fn(async () => ({
      ok: false,
      reason: "should not run",
    }));
    const checks = await projectChecks("good", deps({ azLogin }));
    expect(byName(checks, "az login").level).toBe("pass");
    expect(azLogin).not.toHaveBeenCalled();
  });
});

describe("overallLevel", () => {
  const check = (level: ConfigCheck["level"]): ConfigCheck => ({
    name: "n",
    level,
    reason: "r",
  });

  it("returns the worst level", () => {
    expect(overallLevel([check("pass"), check("warn")])).toBe("warn");
    expect(overallLevel([check("pass"), check("fail"), check("warn")])).toBe(
      "fail",
    );
  });

  it("is pass for no checks", () => {
    expect(overallLevel([])).toBe("pass");
  });
});

describe("shared project rules", () => {
  it("resolveDefaultRepo picks the only repo", () => {
    expect(resolveDefaultRepo(["app"], undefined)).toBe("app");
  });

  it("resolveDefaultRepo demands a choice among several repos", () => {
    expect(() => resolveDefaultRepo(["a", "b"], undefined)).toThrow(
      "set defaultRepo to one of a, b",
    );
  });

  it("resolveDefaultRepo rejects an unknown repo", () => {
    expect(() => resolveDefaultRepo(["a", "b"], "x")).toThrow(
      'defaultRepo "x" is not one of a, b',
    );
  });

  it("resolveTestDbPath resolves against the project dir", () => {
    expect(resolveTestDbPath("/p", "db.sh", () => true)).toBe("/p/db.sh");
    expect(resolveTestDbPath("/p", undefined, () => false)).toBeUndefined();
    expect(() => resolveTestDbPath("/p", "db.sh", () => false)).toThrow(
      "testDb script /p/db.sh does not exist",
    );
  });
});
