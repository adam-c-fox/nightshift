import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createProject,
  mergeProjectConfig,
  parseProjectInput,
  saveProjectConfig,
  type ProjectInput,
} from "../src/dashboard/project-edit.js";
import { loadProject } from "../src/project.js";
import { ticketsHeader } from "../src/tickets.js";

const EXAMPLE = join(import.meta.dirname, "..", "projects", "example");
const EXAMPLE_TONIGHT = readFileSync(join(EXAMPLE, "tonight.md"), "utf-8");
const EXAMPLE_ENV = readFileSync(join(EXAMPLE, ".env.example"), "utf-8");
const AGENTS = "# Agent rules\nBe careful.\n";

let root: string;
let projectsDir: string;
let exampleDir: string;
let repo: string;

function repoInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "app",
    path: repo,
    toolchain: "node",
    description: "d",
    ...overrides,
  };
}

function input(overrides: Partial<ProjectInput> = {}): ProjectInput {
  return { repos: [repoInput()], ...overrides };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nightshift-"));
  projectsDir = join(root, "projects");
  exampleDir = join(projectsDir, "example");
  repo = join(root, "repo");
  mkdirSync(repo);
  mkdirSync(exampleDir, { recursive: true });
  writeFileSync(join(exampleDir, "AGENTS.md"), AGENTS);
  writeFileSync(join(exampleDir, ".env.example"), EXAMPLE_ENV);
  writeFileSync(join(exampleDir, "tonight.md"), EXAMPLE_TONIGHT);
});

describe("parseProjectInput", () => {
  it("returns a well-formed body as is", () => {
    const body = {
      repos: [{ name: "app", path: "/r", toolchain: "node", description: "" }],
      allowancePercent: 20,
      linearTeams: ["DEMO"],
    };
    expect(parseProjectInput(body)).toEqual(body);
  });

  it("rejects wrong types", () => {
    expect(() => parseProjectInput({ repos: "x" })).toThrow(/repos/);
    expect(() =>
      parseProjectInput({ repos: [], allowancePercent: "20" }),
    ).toThrow(/allowancePercent/);
    expect(() => parseProjectInput({ repos: [], linearTeams: [1] })).toThrow(
      /linearTeams/,
    );
  });

  it("rejects a repo with a non-string field and a non-object body", () => {
    expect(() =>
      parseProjectInput({ repos: [repoInput({ path: 1 })] }),
    ).toThrow(/path/);
    expect(() => parseProjectInput(null)).toThrow();
  });
});

describe("mergeProjectConfig", () => {
  const raw = {
    repos: {
      app: { path: "/old", toolchain: "node", description: "x", extra: true },
    },
    defaultRepo: "app",
    custom: { a: 1 },
    testDb: "db.sh",
  };

  it("applies the form values and keeps unknown keys", () => {
    const merged = mergeProjectConfig(raw, {
      repos: [
        { name: "app", path: "/new", toolchain: "node", description: "y" },
      ],
      defaultRepo: "",
      testDb: null,
      allowancePercent: 30,
      linearTeams: [],
    });
    expect(merged).toEqual({
      repos: {
        app: { path: "/new", toolchain: "node", description: "y", extra: true },
      },
      custom: { a: 1 },
      allowancePercent: 30,
    });
  });

  it("rejects duplicate repo names", () => {
    const twice = {
      name: "app",
      path: "/r",
      toolchain: "node",
      description: "",
    };
    expect(() => mergeProjectConfig(raw, { repos: [twice, twice] })).toThrow(
      /listed twice/,
    );
  });

  it("does not mutate the raw config", () => {
    const before = JSON.stringify(raw);
    mergeProjectConfig(raw, input({ defaultRepo: "" }));
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("saveProjectConfig", () => {
  function writeAcme() {
    const dir = join(projectsDir, "acme");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "project.json");
    writeFileSync(
      file,
      JSON.stringify({
        repos: { app: { path: repo, toolchain: "node", description: "old" } },
        custom: { keep: true },
      }),
    );
    return file;
  }

  it("rewrites the file, keeps unknown keys and loads", () => {
    const file = writeAcme();
    saveProjectConfig(
      "acme",
      input({
        repos: [repoInput({ description: "new" })],
        allowancePercent: 25,
      }),
      projectsDir,
    );
    const saved = JSON.parse(readFileSync(file, "utf-8"));
    expect(saved.custom).toEqual({ keep: true });
    expect(saved.repos.app.description).toBe("new");
    const project = loadProject("acme", projectsDir);
    expect(project.allowancePercent).toBe(25);
    expect(project.repos.app?.description).toBe("new");
  });

  it("leaves the file untouched when a repo path does not exist", () => {
    const file = writeAcme();
    const before = readFileSync(file);
    expect(() =>
      saveProjectConfig(
        "acme",
        input({ repos: [repoInput({ path: join(root, "missing") })] }),
        projectsDir,
      ),
    ).toThrow(/does not exist/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("leaves the file untouched on an unknown toolchain", () => {
    const file = writeAcme();
    const before = readFileSync(file);
    expect(() =>
      saveProjectConfig(
        "acme",
        input({ repos: [repoInput({ toolchain: "rust" })] }),
        projectsDir,
      ),
    ).toThrow(/unknown toolchain/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});

describe("createProject", () => {
  it("creates the config and files copied from the example, never an .env", () => {
    const created = createProject("newp", input(), projectsDir, exampleDir);
    const dir = join(projectsDir, "newp");
    expect(created.dir).toBe(dir);
    expect(created.envFile).toBe(join(dir, ".env"));
    expect(loadProject("newp", projectsDir).repos.app?.path).toBe(repo);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toBe(AGENTS);
    expect(readFileSync(join(dir, ".env.example"), "utf-8")).toBe(EXAMPLE_ENV);
    const tonight = readFileSync(join(dir, "tonight.md"), "utf-8");
    expect(tonight).toBe(ticketsHeader(EXAMPLE_TONIGHT));
    expect(tonight).not.toContain("## ENG-142");
    expect(tonight).toContain("<!--");
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("returns the env keys the project needs", () => {
    const created = createProject("newp", input(), projectsDir, exampleDir);
    expect(created.envKeys).toEqual([
      "LINEAR_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AZURE_DEVOPS_ORG",
      "AZURE_DEVOPS_PROJECT",
      "AZURE_DEVOPS_PAT",
      "BRANCH_PREFIX",
    ]);
  });

  it("refuses an existing directory and changes nothing", () => {
    const dir = join(projectsDir, "taken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.txt"), "x");
    expect(() =>
      createProject("taken", input(), projectsDir, exampleDir),
    ).toThrow(/already exists/);
    expect(readFileSync(join(dir, "keep.txt"), "utf-8")).toBe("x");
    expect(existsSync(join(dir, "project.json"))).toBe(false);
  });

  it("refuses an invalid project name", () => {
    expect(() =>
      createProject("../x", input(), projectsDir, exampleDir),
    ).toThrow(/invalid project name/);
    expect(existsSync(join(root, "x"))).toBe(false);
  });

  it("refuses the reserved name new because /projects/new is the create page", () => {
    expect(() =>
      createProject("new", input(), projectsDir, exampleDir),
    ).toThrow(/reserved/);
    expect(existsSync(join(projectsDir, "new"))).toBe(false);
  });

  it("leaves no directory behind when the config is invalid", () => {
    expect(() =>
      createProject(
        "newp",
        input({ repos: [repoInput({ path: join(root, "missing") })] }),
        projectsDir,
        exampleDir,
      ),
    ).toThrow(/does not exist/);
    expect(existsSync(join(projectsDir, "newp"))).toBe(false);
  });

  it("rejects a relative testDb because the script cannot exist yet", () => {
    expect(() =>
      createProject(
        "newp",
        input({ testDb: "db.sh" }),
        projectsDir,
        exampleDir,
      ),
    ).toThrow(/testDb/);
    expect(existsSync(join(projectsDir, "newp"))).toBe(false);
  });

  it("removes the directory when writing a file fails", () => {
    const missingExample = join(root, "no-example");
    mkdirSync(missingExample);
    mkdirSync(join(missingExample, "tonight.md"));
    expect(() =>
      createProject("newp", input(), projectsDir, missingExample),
    ).toThrow();
    expect(existsSync(join(projectsDir, "newp"))).toBe(false);
  });
});
