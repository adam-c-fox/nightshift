import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { envLookup, parseEnv, ROOT_ENV_FILE } from "../env.js";
import type { LinearTeam } from "../linear.js";
import {
  PROJECT_NAME,
  parseProjectConfig,
  readRawProjectConfig,
  resolveDefaultRepo,
  resolveTestDbPath,
} from "../project.js";
import type { Loaded } from "./cache.js";

export type CheckLevel = "pass" | "warn" | "fail";

export interface ConfigCheck {
  name: string;
  level: CheckLevel;
  reason: string;
  keys?: { present: string[]; missing: string[] };
}

export interface CheckDeps {
  projectsDir: string;
  exampleDir: string;
  rootDir?: string;
  teams: () => Promise<Loaded<LinearTeam[]>>;
  azLogin: () => Promise<{ ok: boolean; reason: string }>;
}

type FileCheckDeps = Pick<CheckDeps, "projectsDir" | "exampleDir" | "rootDir">;

export const IGNORED_ENV_KEYS = ["NIGHTSHIFT_PROJECT"];

const ENV_EXAMPLE = ".env.example";
const PAT_KEYS = ["AZURE_DEVOPS_EXT_PAT", "AZURE_DEVOPS_PAT"];
const LEVEL_ORDER: CheckLevel[] = ["pass", "warn", "fail"];
const DEFAULT_ROOT_DIR = path.dirname(ROOT_ENV_FILE);

type RawProject = {
  repos?: Record<string, { path?: unknown }>;
  defaultRepo?: unknown;
  testDb?: unknown;
  linearTeams?: unknown;
};

function check(name: string, level: CheckLevel, reason: string): ConfigCheck {
  return { name, level, reason };
}

function messageOf(e: unknown): string {
  return (e as Error).message;
}

function keysInExample(dir: string): string[] | undefined {
  const file = path.join(dir, ENV_EXAMPLE);
  if (!existsSync(file)) return undefined;
  return Object.keys(parseEnv(readFileSync(file, "utf-8")));
}

export function requiredEnvKeys(
  projectDir: string,
  exampleDir: string,
  rootDir = DEFAULT_ROOT_DIR,
): string[] {
  const projectKeys =
    keysInExample(projectDir) ?? keysInExample(exampleDir) ?? [];
  const keys = [...(keysInExample(rootDir) ?? []), ...projectKeys];
  return [...new Set(keys)].filter((key) => !IGNORED_ENV_KEYS.includes(key));
}

function projectLookup(projectDir: string, rootDir: string) {
  return envLookup([path.join(projectDir, ".env"), path.join(rootDir, ".env")]);
}

function loadRaw(
  name: string,
  projectsDir: string,
): { raw: RawProject; configError?: string } {
  try {
    return {
      raw: (readRawProjectConfig(name, projectsDir).raw ?? {}) as RawProject,
    };
  } catch (e) {
    return { raw: {}, configError: messageOf(e) };
  }
}

function configCheck(
  name: string,
  projectDir: string,
  raw: RawProject,
  configError: string | undefined,
): ConfigCheck {
  if (configError) return check("config", "fail", configError);
  try {
    parseProjectConfig(name, projectDir, raw, existsSync);
    return check("config", "pass", "project.json is valid");
  } catch (e) {
    return check("config", "fail", messageOf(e));
  }
}

function repoCheck(repoName: string, repoPath: unknown): ConfigCheck {
  const name = `repo ${repoName}`;
  if (typeof repoPath !== "string") return check(name, "fail", "has no path");
  if (!existsSync(repoPath)) {
    return check(name, "fail", `${repoPath} does not exist`);
  }
  if (!existsSync(path.join(repoPath, ".git"))) {
    return check(name, "fail", `${repoPath} is not a git repository`);
  }
  return check(name, "pass", `${repoPath} is a git repository`);
}

function defaultRepoCheck(raw: RawProject): ConfigCheck[] {
  const repoNames = Object.keys(raw.repos ?? {});
  if (repoNames.length === 0) return [];
  try {
    const repo = resolveDefaultRepo(repoNames, raw.defaultRepo);
    return [check("defaultRepo", "pass", `defaults to ${repo}`)];
  } catch (e) {
    return [check("defaultRepo", "fail", messageOf(e))];
  }
}

function envCheck(
  name: string,
  projectDir: string,
  deps: FileCheckDeps,
): ConfigCheck {
  const rootDir = deps.rootDir ?? DEFAULT_ROOT_DIR;
  const lookup = projectLookup(projectDir, rootDir);
  const required = requiredEnvKeys(projectDir, deps.exampleDir, rootDir);
  const keys = {
    present: required.filter((key) => lookup(key)),
    missing: required.filter((key) => !lookup(key)),
  };
  const hasKeys = keys.missing.length === 0;
  if (!existsSync(path.join(projectDir, ".env"))) {
    return hasKeys
      ? { ...check(".env", "pass", "all keys come from the environment"), keys }
      : {
          ...check(".env", "fail", `fill in projects/${name}/.env`),
          keys,
        };
  }
  return hasKeys
    ? { ...check(".env", "pass", "all required keys are set"), keys }
    : {
        ...check(
          ".env",
          "warn",
          `${keys.missing.length} required key(s) not set`,
        ),
        keys,
      };
}

function testDbCheck(projectDir: string, raw: RawProject): ConfigCheck {
  try {
    const script = resolveTestDbPath(projectDir, raw.testDb, existsSync);
    return script
      ? check("testDb", "pass", `${script} exists`)
      : check("testDb", "pass", "not configured");
  } catch (e) {
    return check("testDb", "fail", messageOf(e));
  }
}

export function fileChecks(name: string, deps: FileCheckDeps): ConfigCheck[] {
  if (!PROJECT_NAME.test(name)) {
    return [check("config", "fail", `invalid project name "${name}"`)];
  }
  const projectDir = path.join(deps.projectsDir, name);
  const { raw, configError } = loadRaw(name, deps.projectsDir);
  return [
    configCheck(name, projectDir, raw, configError),
    ...Object.entries(raw.repos ?? {}).map(([repoName, repo]) =>
      repoCheck(repoName, repo?.path),
    ),
    ...defaultRepoCheck(raw),
    existsSync(path.join(projectDir, "AGENTS.md"))
      ? check("AGENTS.md", "pass", "present")
      : check(
          "AGENTS.md",
          "warn",
          "missing; agents get no project instructions",
        ),
    envCheck(name, projectDir, deps),
    testDbCheck(projectDir, raw),
  ];
}

function configuredTeams(raw: RawProject): string[] {
  return Array.isArray(raw.linearTeams)
    ? raw.linearTeams.filter((team): team is string => typeof team === "string")
    : [];
}

async function linearTeamsCheck(
  configured: string[],
  teams: CheckDeps["teams"],
): Promise<ConfigCheck> {
  if (configured.length === 0) {
    return check("linearTeams", "pass", "not set; all your Todo tickets");
  }
  const loaded = await teams();
  if (!loaded.ok) {
    return check("linearTeams", "warn", `couldn't check: ${loaded.error}`);
  }
  const known = new Set(loaded.value.map((team) => team.key));
  const unknown = configured.filter((key) => !known.has(key));
  return unknown.length > 0
    ? check("linearTeams", "fail", `unknown team keys: ${unknown.join(", ")}`)
    : check("linearTeams", "pass", `${configured.join(", ")} found in Linear`);
}

async function azLoginCheck(
  lookup: (name: string) => string | undefined,
  azLogin: CheckDeps["azLogin"],
): Promise<ConfigCheck> {
  if (PAT_KEYS.some((key) => lookup(key))) {
    return check("az login", "pass", "using the PAT from .env");
  }
  const status = await azLogin();
  return check("az login", status.ok ? "pass" : "fail", status.reason);
}

export async function projectChecks(
  name: string,
  deps: CheckDeps,
): Promise<ConfigCheck[]> {
  const checks = fileChecks(name, deps);
  if (!PROJECT_NAME.test(name)) return checks;
  const { raw } = loadRaw(name, deps.projectsDir);
  const lookup = projectLookup(
    path.join(deps.projectsDir, name),
    deps.rootDir ?? DEFAULT_ROOT_DIR,
  );
  return [
    ...checks,
    await linearTeamsCheck(configuredTeams(raw), deps.teams),
    await azLoginCheck(lookup, deps.azLogin),
  ];
}

export function overallLevel(checks: ConfigCheck[]): CheckLevel {
  return checks.reduce<CheckLevel>(
    (worst, { level }) =>
      LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(worst) ? level : worst,
    "pass",
  );
}
