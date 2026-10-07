import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Toolchain } from "./types.js";

export const PROJECTS_DIR = path.resolve(import.meta.dirname, "..", "projects");
const TOOLCHAINS: readonly Toolchain[] = ["node", "terraform"];
export const REPO_NAME_PATTERN = "[a-z0-9][a-z0-9_-]*";
export const REPO_NAME = new RegExp(`^${REPO_NAME_PATTERN}$`);
export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const DEFAULT_ALLOWANCE_PERCENT = 15;
export const LINEAR_TEAM_KEY = /^[A-Z][A-Z0-9]*$/;

export interface RepoConfig {
  path: string;
  toolchain: Toolchain;
  description: string;
}

export interface Project {
  name: string;
  dir: string;
  repos: Record<string, RepoConfig>;
  defaultRepo: string;
  instructions: string;
  testDbScript?: string;
  allowancePercent: number;
  linearTeams?: string[];
  ticketsFile: string;
  envFile: string;
}

type RawConfig = {
  repos?: Record<string, Partial<RepoConfig>>;
  defaultRepo?: unknown;
  testDb?: unknown;
  allowancePercent?: unknown;
  linearTeams?: unknown;
};

export function isValidPercent(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 100
  );
}

export function resolveDefaultRepo(
  repoNames: string[],
  configured: unknown,
): string {
  const defaultRepo =
    configured ??
    (repoNames.length === 1
      ? repoNames[0]
      : reject(`set defaultRepo to one of ${repoNames.join(", ")}`));
  if (typeof defaultRepo !== "string" || !repoNames.includes(defaultRepo)) {
    reject(
      `defaultRepo "${defaultRepo}" is not one of ${repoNames.join(", ")}`,
    );
  }
  return defaultRepo as string;
}

export function resolveTestDbPath(
  dir: string,
  testDb: unknown,
  exists: (p: string) => boolean,
): string | undefined {
  if (testDb === undefined) return undefined;
  const script = path.resolve(dir, String(testDb));
  if (!exists(script)) reject(`testDb script ${script} does not exist`);
  return script;
}

function reject(reason: string): never {
  throw new Error(reason);
}

function reasoned<T>(fail: (reason: string) => never, resolve: () => T): T {
  try {
    return resolve();
  } catch (e) {
    return fail((e as Error).message);
  }
}

export function parseProjectConfig(
  name: string,
  dir: string,
  raw: unknown,
  exists: (p: string) => boolean,
): Omit<Project, "instructions"> {
  const fail = (reason: string): never => {
    throw new Error(`project "${name}": ${reason}`);
  };
  const config = (raw ?? {}) as RawConfig;
  const entries = Object.entries(config.repos ?? {});
  if (entries.length === 0) fail("needs at least one repo");

  const repos: Record<string, RepoConfig> = {};
  for (const [repoName, repo] of entries) {
    if (!REPO_NAME.test(repoName)) {
      fail(
        `repo "${repoName}" must be a lowercase name (letters, digits, "_" or "-", starting with a letter or digit)`,
      );
    }
    if (!TOOLCHAINS.includes(repo.toolchain as Toolchain)) {
      fail(
        `repo ${repoName} has unknown toolchain "${repo.toolchain}" (expected ${TOOLCHAINS.join(" or ")})`,
      );
    }
    if (typeof repo.path !== "string" || !path.isAbsolute(repo.path)) {
      fail(`repo ${repoName} path must be absolute`);
    }
    if (!exists(repo.path!))
      fail(`repo ${repoName} path ${repo.path} does not exist`);
    repos[repoName] = {
      path: repo.path!,
      toolchain: repo.toolchain as Toolchain,
      description: String(repo.description ?? ""),
    };
  }

  const defaultRepo = reasoned(fail, () =>
    resolveDefaultRepo(Object.keys(repos), config.defaultRepo),
  );
  const testDbScript = reasoned(fail, () =>
    resolveTestDbPath(dir, config.testDb, exists),
  );

  const allowancePercent = config.allowancePercent ?? DEFAULT_ALLOWANCE_PERCENT;
  if (!isValidPercent(allowancePercent))
    fail("allowancePercent must be a whole number from 1 to 100");

  const linearTeams = config.linearTeams ?? [];
  if (
    !Array.isArray(linearTeams) ||
    !linearTeams.every(
      (team) => typeof team === "string" && LINEAR_TEAM_KEY.test(team),
    )
  ) {
    fail('linearTeams must be a list of Linear team keys like "ENG"');
  }
  const teams = linearTeams as string[];

  return {
    name,
    dir,
    repos,
    defaultRepo,
    testDbScript,
    allowancePercent: allowancePercent as number,
    ...(teams.length > 0 ? { linearTeams: teams } : {}),
    ticketsFile: path.join(dir, "tonight.md"),
    envFile: path.join(dir, ".env"),
  };
}

export function listProjects(projectsDir = PROJECTS_DIR): string[] {
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        existsSync(path.join(projectsDir, d.name, "project.json")),
    )
    .map((d) => d.name)
    .sort();
}

export function projectEnvFiles(projectsDir = PROJECTS_DIR): string[] {
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(projectsDir, d.name, ".env"))
    .sort();
}

export function readRawProjectConfig(
  name: string,
  projectsDir = PROJECTS_DIR,
): { dir: string; configFile: string; raw: unknown } {
  if (!PROJECT_NAME.test(name)) {
    throw new Error(`invalid project name "${name}"`);
  }
  const dir = path.join(projectsDir, name);
  const configFile = path.join(dir, "project.json");
  if (!existsSync(configFile)) {
    throw new Error(
      `project "${name}" not found in ${projectsDir} (available: ${listProjects(projectsDir).join(", ") || "none"})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configFile, "utf-8"));
  } catch (e) {
    throw new Error(
      `project "${name}": ${configFile} is not valid JSON: ${(e as Error).message}`,
    );
  }
  return { dir, configFile, raw };
}

export function loadProject(name: string, projectsDir = PROJECTS_DIR): Project {
  const { dir, raw } = readRawProjectConfig(name, projectsDir);
  const parsed = parseProjectConfig(name, dir, raw, existsSync);
  const agentsFile = path.join(dir, "AGENTS.md");
  return {
    ...parsed,
    instructions: existsSync(agentsFile)
      ? readFileSync(agentsFile, "utf-8")
      : "",
  };
}
