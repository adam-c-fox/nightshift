import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const PROJECTS_DIR = path.resolve(import.meta.dirname, "..", "projects");
export const REPO_NAME_PATTERN = "[a-z0-9][a-z0-9_-]*";
export const REPO_NAME = new RegExp(`^${REPO_NAME_PATTERN}$`);
export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const NIGHT_DIR_NAME = "night";
export const LINEAR_TEAM_KEY = /^[A-Z][A-Z0-9]*$/;

export interface RepoCommand {
  command: string;
  in?: string[];
}

export interface RepoCheck extends RepoCommand {
  name: string;
}

export interface RepoConfig {
  path: string;
  description: string;
  setup: RepoCommand[];
  checks: RepoCheck[];
  network: string[];
  allowLocalBinding: boolean;
  tools: string[];
}

export interface Project {
  name: string;
  dir: string;
  repos: Record<string, RepoConfig>;
  defaultRepo: string;
  instructions: string;
  testDbScript?: string;
  linearProjects: string[];
  linearTeams?: string[];
  ticketsFile: string;
  envFile: string;
}

type RawConfig = {
  repos?: Record<string, Record<string, unknown>>;
  defaultRepo?: unknown;
  testDb?: unknown;
  allowancePercent?: unknown;
  linearProjects?: unknown;
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

const REPO_KEYS = ["path", "description", "setup", "checks", "network", "allowLocalBinding", "tools"];
const SETUP_KEYS = ["command", "in"];
const CHECK_KEYS = ["name", "command", "in"];

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isNonEmptyString);

function parseCommands(repoName: string, label: string, raw: unknown, keys: string[], fail: (reason: string) => never): RepoCheck[] {
  if (!Array.isArray(raw)) return fail(`repo ${repoName} ${label} must be a list`);
  return raw.map((entry: Record<string, unknown>, i) => {
    const where = `repo ${repoName} ${label}[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail(`${where} must be an object`);
    const unknown = Object.keys(entry).find(key => !keys.includes(key));
    if (unknown) fail(`${where} has unknown key "${unknown}" (expected ${keys.join(", ")})`);
    if (keys.includes("name") && !isNonEmptyString(entry.name)) fail(`${where} needs a name`);
    if (!isNonEmptyString(entry.command)) fail(`${where} needs a command`);
    const globs = entry.in === undefined ? undefined : typeof entry.in === "string" ? [entry.in] : entry.in;
    if (globs !== undefined && (!isStringList(globs) || globs.length === 0)) fail(`${where} "in" must be a glob or a list of globs`);
    return { name: entry.name as string, command: entry.command, ...(globs ? { in: globs as string[] } : {}) };
  });
}

function parseRepo(repoName: string, repo: Record<string, unknown>, fail: (reason: string) => never): RepoConfig {
  if ("toolchain" in repo) {
    fail(`repo ${repoName}: "toolchain" was removed; list setup, checks, network and tools instead (see docs/setup.md)`);
  }
  const unknown = Object.keys(repo).find(key => !REPO_KEYS.includes(key));
  if (unknown) fail(`repo ${repoName} has unknown key "${unknown}" (expected ${REPO_KEYS.join(", ")})`);
  const checks = parseCommands(repoName, "checks", repo.checks, CHECK_KEYS, fail);
  if (checks.length === 0) fail(`repo ${repoName} needs at least one check`);
  const duplicate = checks.find((c, i) => checks.findIndex(o => o.name === c.name) !== i);
  if (duplicate) fail(`repo ${repoName} has two checks named "${duplicate.name}"`);
  const setup = repo.setup === undefined ? [] : parseCommands(repoName, "setup", repo.setup, SETUP_KEYS, fail)
    .map(({ name: _name, ...step }) => step);
  const network = repo.network ?? [];
  const tools = repo.tools ?? [];
  if (!isStringList(network)) fail(`repo ${repoName} network must be a list of domains`);
  if (!isStringList(tools)) fail(`repo ${repoName} tools must be a list of command prefixes`);
  const allowLocalBinding = repo.allowLocalBinding ?? false;
  if (typeof allowLocalBinding !== "boolean") fail(`repo ${repoName} allowLocalBinding must be true or false`);
  return {
    path: repo.path as string,
    description: String(repo.description ?? ""),
    setup, checks,
    network: network as string[],
    allowLocalBinding: allowLocalBinding as boolean,
    tools: tools as string[],
  };
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
    const parsed = parseRepo(repoName, repo, fail);
    if (typeof repo.path !== "string" || !path.isAbsolute(repo.path)) {
      fail(`repo ${repoName} path must be absolute`);
    }
    if (!exists(repo.path as string))
      fail(`repo ${repoName} path ${repo.path} does not exist`);
    repos[repoName] = parsed;
  }

  const defaultRepo = reasoned(fail, () =>
    resolveDefaultRepo(Object.keys(repos), config.defaultRepo),
  );
  const testDbScript = reasoned(fail, () =>
    resolveTestDbPath(dir, config.testDb, exists),
  );

  if (config.allowancePercent !== undefined)
    fail("allowancePercent moved to NIGHTLY_ALLOWANCE_PERCENT in the root .env");

  const linearProjects = config.linearProjects;
  if (!isStringList(linearProjects) || linearProjects.length === 0)
    fail("linearProjects must be a non-empty list of Linear project names");

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
    linearProjects: linearProjects as string[],
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
  if (name === NIGHT_DIR_NAME) {
    throw new Error(`"${NIGHT_DIR_NAME}" is reserved for night output`);
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

export function loadAllProjects(projectsDir = PROJECTS_DIR): Project[] {
  const projects = listProjects(projectsDir).map((name) => loadProject(name, projectsDir));
  const owners = new Map<string, string>();
  for (const project of projects) {
    for (const linearProject of project.linearProjects) {
      const owner = owners.get(linearProject);
      if (owner !== undefined) {
        throw new Error(`Linear project "${linearProject}" is claimed by both ${owner} and ${project.name}`);
      }
      owners.set(linearProject, project.name);
    }
  }
  return projects;
}

export function projectForLinearProject(
  projects: Pick<Project, "name" | "linearProjects">[],
  linearProject: string | null,
): string | undefined {
  if (linearProject === null) return undefined;
  return projects.find((p) => p.linearProjects.includes(linearProject))?.name;
}
