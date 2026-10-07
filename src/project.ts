import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Toolchain } from "./types.js";

export const PROJECTS_DIR = path.resolve(import.meta.dirname, "..", "projects");
const TOOLCHAINS: readonly Toolchain[] = ["node", "terraform"];
export const REPO_NAME_PATTERN = "[a-z0-9][a-z0-9_-]*";
export const REPO_NAME = new RegExp(`^${REPO_NAME_PATTERN}$`);
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_ALLOWANCE_PERCENT = 15;

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
  ticketsFile: string;
  envFile: string;
}

type RawConfig = {
  repos?: Record<string, Partial<RepoConfig>>;
  defaultRepo?: unknown;
  testDb?: unknown;
  allowancePercent?: unknown;
};

export function isValidPercent(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 100
  );
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

  const names = Object.keys(repos);
  const defaultRepo =
    config.defaultRepo ??
    (names.length === 1
      ? names[0]
      : fail(`set defaultRepo to one of ${names.join(", ")}`));
  if (typeof defaultRepo !== "string" || !Object.hasOwn(repos, defaultRepo)) {
    fail(`defaultRepo "${defaultRepo}" is not one of ${names.join(", ")}`);
  }

  let testDbScript: string | undefined;
  if (config.testDb !== undefined) {
    testDbScript = path.resolve(dir, String(config.testDb));
    if (!exists(testDbScript))
      fail(`testDb script ${testDbScript} does not exist`);
  }

  const allowancePercent = config.allowancePercent ?? DEFAULT_ALLOWANCE_PERCENT;
  if (!isValidPercent(allowancePercent))
    fail("allowancePercent must be a whole number from 1 to 100");

  return {
    name,
    dir,
    repos,
    defaultRepo: defaultRepo as string,
    testDbScript,
    allowancePercent: allowancePercent as number,
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

export function loadProject(name: string, projectsDir = PROJECTS_DIR): Project {
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
  const parsed = parseProjectConfig(name, dir, raw, existsSync);
  const agentsFile = path.join(dir, "AGENTS.md");
  return {
    ...parsed,
    instructions: existsSync(agentsFile)
      ? readFileSync(agentsFile, "utf-8")
      : "",
  };
}
