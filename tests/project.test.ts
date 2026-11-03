import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listProjects,
  loadAllProjects,
  loadProject,
  parseProjectConfig as parseConfigStrict,
  projectForLinearProject,
  projectEnvFiles,
  readRawProjectConfig,
} from "../src/project.js";

const everything = () => true;
const parseProjectConfig = (name: string, dir: string, raw: unknown, exists: (p: string) => boolean) =>
  parseConfigStrict(name, dir, { linearProjects: ["Acme"], ...(raw as object) }, exists);
const repos = {
  main: { path: "/r/app", description: "app", checks: [{ name: "tests", command: "npm test" }] },
  infra: {
    path: "/r/tf",
    description: "infra",
    setup: [{ command: "make init", in: "env/*/main.tf" }],
    checks: [{ name: "validate", command: "make validate", in: ["env/*/main.tf", "mod/*/main.tf"] }],
    network: ["registry.example.com"],
    allowLocalBinding: true,
    tools: ["make"],
  },
};
const parsedRepos = {
  main: { ...repos.main, setup: [], network: [], allowLocalBinding: false, tools: [] },
  infra: {
    ...repos.infra,
    setup: [{ command: "make init", in: ["env/*/main.tf"] }],
    checks: [{ name: "validate", command: "make validate", in: ["env/*/main.tf", "mod/*/main.tf"] }],
  },
};
const withRepo = (patch: object) => ({ repos: { app: { ...repos.main, ...patch } } });
const parse = (raw: unknown) => parseProjectConfig("a", "/p/a", raw, everything);

describe("parseProjectConfig", () => {
  it("resolves paths against the project dir and applies defaults", () => {
    const project = parseProjectConfig(
      "acme",
      "/p/acme",
      { repos, defaultRepo: "main", testDb: "test-db.sh" },
      everything,
    );
    expect(project).toEqual({
      name: "acme",
      dir: "/p/acme",
      repos: parsedRepos,
      defaultRepo: "main",
      testDbScript: "/p/acme/test-db.sh",
      linearProjects: ["Acme"],
      envFile: "/p/acme/.env",
    });
  });

  it("defaults the repo when there is only one", () => {
    expect(
      parseProjectConfig(
        "a",
        "/p/a",
        { repos: { app: repos.main } },
        everything,
      ).defaultRepo,
    ).toBe("app");
  });

  it("rejects a repo key that isn't a lowercase repo name", () => {
    expect(() =>
      parseProjectConfig("a", "/p/a", { repos: { Main: repos.main } }, everything),
    ).toThrow(/repo "Main".*lowercase/);
  });

  it("rejects an inherited property name as defaultRepo", () => {
    expect(() =>
      parseProjectConfig(
        "a",
        "/p/a",
        { repos, defaultRepo: "constructor" },
        everything,
      ),
    ).toThrow(/defaultRepo "constructor"/);
  });

  it("requires defaultRepo when there are several repos", () => {
    expect(() =>
      parseProjectConfig("a", "/p/a", { repos }, everything),
    ).toThrow(/defaultRepo/);
  });

  it("rejects a defaultRepo that isn't one of the repos", () => {
    expect(() =>
      parseProjectConfig(
        "a",
        "/p/a",
        { repos, defaultRepo: "web" },
        everything,
      ),
    ).toThrow(/defaultRepo "web"/);
  });

  it("tells the user to migrate a leftover toolchain key", () => {
    expect(() => parse(withRepo({ toolchain: "node" }))).toThrow(
      /repo app: "toolchain" was removed; list setup, checks, network and tools instead \(see docs\/setup\.md\)/,
    );
  });

  it("rejects unknown keys on a repo and on a check", () => {
    expect(() => parse(withRepo({ check: [] }))).toThrow(/repo app has unknown key "check"/);
    expect(() => parse(withRepo({ checks: [{ name: "t", command: "x", cmd: "y" }] }))).toThrow(
      /checks\[0\] has unknown key "cmd"/,
    );
    expect(() => parse(withRepo({ setup: [{ command: "x", name: "n" }] }))).toThrow(/setup\[0\] has unknown key "name"/);
  });

  it.each([
    [{ checks: undefined }, /checks must be a list/],
    [{ checks: [] }, /at least one check/],
    [{ checks: [{ command: "x" }] }, /needs a name/],
    [{ checks: [{ name: "t" }] }, /needs a command/],
    [{ checks: [{ name: "t", command: "x" }, { name: "t", command: "y" }] }, /two checks named "t"/],
    [{ checks: [{ name: "t", command: "x", in: [] }] }, /"in" must be a glob or a list of globs/],
    [{ checks: [{ name: "t", command: "x", in: 3 }] }, /"in" must be a glob or a list of globs/],
    [{ setup: "make" }, /setup must be a list/],
    [{ network: "a.com" }, /network must be a list/],
    [{ tools: [""] }, /tools must be a list/],
    [{ allowLocalBinding: "yes" }, /allowLocalBinding must be true or false/],
  ])("rejects an invalid repo %j", (patch, message) => {
    expect(() => parse(withRepo(patch))).toThrow(message);
  });

  it("defaults setup, network, tools and allowLocalBinding", () => {
    expect(parse(withRepo({})).repos.app).toEqual(parsedRepos.main);
  });

  it("accepts a single glob string for in", () => {
    const { repos: parsed } = parse(withRepo({ checks: [{ name: "t", command: "x", in: "a/*/b" }] }));
    expect(parsed.app.checks[0].in).toEqual(["a/*/b"]);
  });

  it("rejects a repo path that doesn't exist", () => {
    expect(() =>
      parseProjectConfig(
        "a",
        "/p/a",
        { repos: { app: repos.main } },
        (p) => p !== "/r/app",
      ),
    ).toThrow(/app.*\/r\/app/);
  });

  it("rejects a relative repo path", () => {
    const bad = { repos: { app: { ...repos.main, path: "app" } } };
    expect(() => parseProjectConfig("a", "/p/a", bad, everything)).toThrow(
      /absolute/,
    );
  });

  it("rejects a missing test-db script", () => {
    expect(() =>
      parseProjectConfig(
        "a",
        "/p/a",
        { repos: { app: repos.main }, testDb: "db.sh" },
        (p) => p !== "/p/a/db.sh",
      ),
    ).toThrow(/db\.sh/);
  });

  it("rejects allowancePercent, which moved to the root .env", () => {
    expect(() => parse({ repos: { app: repos.main }, allowancePercent: 15 })).toThrow(
      /allowancePercent moved to NIGHTLY_ALLOWANCE_PERCENT in the root \.env/,
    );
  });

  it.each([undefined, [], [""], "Acme"])("rejects linearProjects %j", (value) => {
    expect(() =>
      parseConfigStrict("a", "/p/a", { repos: { app: repos.main }, linearProjects: value }, everything),
    ).toThrow(/linearProjects must be a non-empty list of Linear project names/);
  });

  it("rejects a project with no repos", () => {
    expect(() =>
      parseProjectConfig("a", "/p/a", { repos: {} }, everything),
    ).toThrow(/at least one repo/);
  });

  it("keeps the configured Linear team keys", () => {
    const project = parseProjectConfig(
      "a",
      "/p/a",
      { repos, defaultRepo: "main", linearTeams: ["DEMO", "ENG"] },
      everything,
    );
    expect(project.linearTeams).toEqual(["DEMO", "ENG"]);
  });

  it("leaves linearTeams undefined when absent or empty", () => {
    const base = { repos, defaultRepo: "main" };
    expect(
      parseProjectConfig("a", "/p/a", base, everything).linearTeams,
    ).toBeUndefined();
    expect(
      parseProjectConfig("a", "/p/a", { ...base, linearTeams: [] }, everything)
        .linearTeams,
    ).toBeUndefined();
  });

  it.each([[["demo"]], ["DEMO"], [["ENG", 3]]])(
    "rejects linearTeams %j",
    (teams) => {
      expect(() =>
        parseProjectConfig(
          "a",
          "/p/a",
          { repos, defaultRepo: "main", linearTeams: teams },
          everything,
        ),
      ).toThrow(/linearTeams/);
    },
  );
});

describe("readRawProjectConfig", () => {
  const setup = (content?: string) => {
    const root = mkdtempSync(join(tmpdir(), "projects-"));
    mkdirSync(join(root, "acme"));
    if (content !== undefined) {
      writeFileSync(join(root, "acme", "project.json"), content);
    }
    return root;
  };

  it("rejects names that aren't a plain directory name", () => {
    expect(() => readRawProjectConfig("../x", setup())).toThrow(
      /invalid project name/,
    );
  });

  it("reports a missing project", () => {
    expect(() => readRawProjectConfig("acme", setup())).toThrow(/not found/);
  });

  it("reports invalid JSON", () => {
    expect(() => readRawProjectConfig("acme", setup("{"))).toThrow(
      /is not valid JSON/,
    );
  });

  it("returns the untouched config with its paths", () => {
    const root = setup('{"repos":{},"custom":1}');
    const result = readRawProjectConfig("acme", root);
    expect((result.raw as { custom: number }).custom).toBe(1);
    expect(result.dir).toBe(join(root, "acme"));
    expect(result.configFile).toBe(join(root, "acme", "project.json"));
  });
});

describe("loadProject", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "projects-"));
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    mkdirSync(join(root, "acme"));
    writeFileSync(
      join(root, "acme", "project.json"),
      JSON.stringify({
        repos: { app: { path: repo, description: "app", checks: [{ name: "t", command: "x" }] } },
        linearProjects: ["Acme"],
      }),
    );
    writeFileSync(join(root, "acme", "AGENTS.md"), "# Acme\n");
    mkdirSync(join(root, "notaproject"));
    return root;
  };

  it("reads project.json and AGENTS.md", () => {
    const project = loadProject("acme", setup());
    expect(project.instructions).toBe("# Acme\n");
    expect(Object.keys(project.repos)).toEqual(["app"]);
  });

  it("names the available projects when the project doesn't exist", () => {
    expect(() => loadProject("nope", setup())).toThrow(
      /project "nope" not found.*available: acme/,
    );
  });

  it("lists only dirs with a project.json", () => {
    expect(listProjects(setup())).toEqual(["acme"]);
  });

  it("lists every project directory's .env, configured or not", () => {
    const root = setup();
    expect(projectEnvFiles(root)).toEqual([
      join(root, "acme", ".env"),
      join(root, "notaproject", ".env"),
    ]);
  });

  it("returns no env files when the projects dir is missing", () => {
    expect(projectEnvFiles(join(tmpdir(), "no-such-projects-dir"))).toEqual([]);
  });

  it("rejects names that aren't a plain directory name", () => {
    const root = setup();
    for (const name of ["../x", "a/b", "a\\b", ".hidden", ".."]) {
      expect(() => loadProject(name, root)).toThrow(/invalid project name/);
    }
  });

  it("names the file when project.json isn't valid JSON", () => {
    const root = setup();
    writeFileSync(join(root, "acme", "project.json"), "{ nope");
    expect(() => loadProject("acme", root)).toThrow(
      /project "acme": .*project\.json is not valid JSON: /,
    );
  });

  it("reserves the name night", () => {
    expect(() => readRawProjectConfig("night", setup())).toThrow(/"night" is reserved/);
  });
});

describe("loadAllProjects", () => {
  const projectIn = (root: string, name: string, linearProjects: string[]) => {
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    mkdirSync(join(root, name));
    writeFileSync(
      join(root, name, "project.json"),
      JSON.stringify({
        repos: { app: { path: repo, description: "app", checks: [{ name: "t", command: "x" }] } },
        linearProjects,
      }),
    );
  };

  it("loads every project", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-"));
    projectIn(root, "a", ["One"]);
    projectIn(root, "b", ["Two"]);
    expect(loadAllProjects(root).map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("rejects a Linear project claimed by two projects", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-"));
    projectIn(root, "a", ["Shared"]);
    projectIn(root, "b", ["Shared"]);
    expect(() => loadAllProjects(root)).toThrow(
      'Linear project "Shared" is claimed by both a and b',
    );
  });
});

describe("projectForLinearProject", () => {
  const projects = [{ name: "eoe", linearProjects: ["Client Implementation Automation"] }];

  it("finds the owning project", () => {
    expect(projectForLinearProject(projects, "Client Implementation Automation")).toBe("eoe");
  });

  it.each([null, "Unknown"])("returns undefined for %j", (name) => {
    expect(projectForLinearProject(projects, name)).toBeUndefined();
  });
});
