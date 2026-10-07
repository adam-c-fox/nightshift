import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listProjects,
  loadProject,
  parseProjectConfig,
  projectEnvFiles,
} from "../src/project.js";

const everything = () => true;
const repos = {
  main: { path: "/r/app", toolchain: "node", description: "app" },
  infra: { path: "/r/tf", toolchain: "terraform", description: "infra" },
};

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
      repos,
      defaultRepo: "main",
      testDbScript: "/p/acme/test-db.sh",
      allowancePercent: 15,
      ticketsFile: "/p/acme/tonight.md",
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

  it("rejects an unknown toolchain", () => {
    const bad = { repos: { app: { ...repos.main, toolchain: "python" } } };
    expect(() => parseProjectConfig("a", "/p/a", bad, everything)).toThrow(
      /app.*toolchain "python"/,
    );
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

  it.each([0, 101, 12.5, "15"])("rejects allowancePercent %s", (pct) => {
    expect(() =>
      parseProjectConfig(
        "a",
        "/p/a",
        { repos: { app: repos.main }, allowancePercent: pct },
        everything,
      ),
    ).toThrow(/allowancePercent/);
  });

  it("rejects a project with no repos", () => {
    expect(() =>
      parseProjectConfig("a", "/p/a", { repos: {} }, everything),
    ).toThrow(/at least one repo/);
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
        repos: { app: { path: repo, toolchain: "node", description: "app" } },
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
});
