import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  PROJECT_NAME,
  parseProjectConfig,
  readRawProjectConfig,
} from "../project.js";
import { writeJsonAtomic } from "../state.js";
import { ticketsHeader } from "../tickets.js";
import { requiredEnvKeys } from "./project-checks.js";

export interface RepoInput {
  name: string;
  path: string;
  toolchain: string;
  description: string;
}

export interface ProjectInput {
  repos: RepoInput[];
  defaultRepo?: string;
  allowancePercent?: number | null;
  testDb?: string | null;
  linearTeams?: string[];
}

type Json = Record<string, unknown>;

const COPIED_FILES = ["AGENTS.md", ".env.example"];

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRepoInput(value: unknown, index: number): RepoInput {
  if (!isObject(value)) throw new Error(`repos[${index}] must be an object`);
  for (const field of ["name", "path", "toolchain", "description"]) {
    if (typeof value[field] !== "string") {
      throw new Error(`repos[${index}].${field} must be a string`);
    }
  }
  const { name, path, toolchain, description } = value as unknown as RepoInput;
  return { name, path, toolchain, description };
}

function optionalString(body: Json, key: string): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }
  throw new Error(`${key} must be a string`);
}

export function parseProjectInput(body: unknown): ProjectInput {
  if (!isObject(body)) throw new Error("body must be an object");
  if (!Array.isArray(body.repos)) throw new Error("repos must be a list");
  const input: ProjectInput = { repos: body.repos.map(parseRepoInput) };

  const defaultRepo = optionalString(body, "defaultRepo");
  if (defaultRepo !== undefined) input.defaultRepo = defaultRepo ?? "";

  const percent = body.allowancePercent;
  if (
    percent !== undefined &&
    percent !== null &&
    typeof percent !== "number"
  ) {
    throw new Error("allowancePercent must be a number or null");
  }
  if (percent !== undefined) input.allowancePercent = percent;

  const testDb = optionalString(body, "testDb");
  if (testDb !== undefined) input.testDb = testDb;

  const teams = body.linearTeams;
  if (teams !== undefined) {
    if (!Array.isArray(teams) || !teams.every((t) => typeof t === "string")) {
      throw new Error("linearTeams must be a list of strings");
    }
    input.linearTeams = teams;
  }
  return input;
}

function mergeRepos(existing: unknown, repos: RepoInput[]): Json {
  const previous = isObject(existing) ? existing : {};
  const merged: Json = {};
  for (const repo of repos) {
    if (repo.name in merged)
      throw new Error(`repo ${repo.name} is listed twice`);
    const before = isObject(previous[repo.name]) ? previous[repo.name] : {};
    merged[repo.name] = {
      ...(before as Json),
      path: repo.path,
      toolchain: repo.toolchain,
      description: repo.description,
    };
  }
  return merged;
}

function setOrDelete(target: Json, key: string, value: unknown, keep: boolean) {
  if (keep) target[key] = value;
  else delete target[key];
}

export function mergeProjectConfig(raw: unknown, input: ProjectInput): Json {
  const merged: Json = isObject(raw) ? { ...raw } : {};
  merged.repos = mergeRepos(merged.repos, input.repos);
  setOrDelete(merged, "defaultRepo", input.defaultRepo, !!input.defaultRepo);
  setOrDelete(merged, "testDb", input.testDb, !!input.testDb);
  setOrDelete(
    merged,
    "allowancePercent",
    input.allowancePercent,
    typeof input.allowancePercent === "number",
  );
  setOrDelete(
    merged,
    "linearTeams",
    input.linearTeams,
    (input.linearTeams?.length ?? 0) > 0,
  );
  return merged;
}

export function saveProjectConfig(
  name: string,
  input: ProjectInput,
  projectsDir: string,
): void {
  const { dir, configFile, raw } = readRawProjectConfig(name, projectsDir);
  const merged = mergeProjectConfig(raw, input);
  parseProjectConfig(name, dir, merged, existsSync);
  writeJsonAtomic(configFile, merged);
}

export interface CreatedProject {
  dir: string;
  envFile: string;
  envKeys: string[];
}

function writeProjectFiles(dir: string, config: Json, exampleDir: string) {
  writeJsonAtomic(path.join(dir, "project.json"), config);
  for (const file of COPIED_FILES) {
    const source = path.join(exampleDir, file);
    if (existsSync(source)) copyFileSync(source, path.join(dir, file));
  }
  const exampleTonight = readFileSync(
    path.join(exampleDir, "tonight.md"),
    "utf-8",
  );
  writeFileSync(path.join(dir, "tonight.md"), ticketsHeader(exampleTonight));
}

export function createProject(
  name: string,
  input: ProjectInput,
  projectsDir: string,
  exampleDir: string,
): CreatedProject {
  if (!PROJECT_NAME.test(name))
    throw new Error(`invalid project name "${name}"`);
  const dir = path.join(projectsDir, name);
  if (existsSync(dir)) throw new Error(`projects/${name} already exists`);
  const config = mergeProjectConfig({}, input);
  parseProjectConfig(name, dir, config, existsSync);

  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(dir);
  try {
    writeProjectFiles(dir, config, exampleDir);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    dir,
    envFile: path.join(dir, ".env"),
    envKeys: requiredEnvKeys(dir, exampleDir),
  };
}
