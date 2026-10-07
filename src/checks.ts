import { execFileSync, spawn } from "node:child_process";
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ReviewFinding, Toolchain } from "./types.js";

export interface CheckCommand {
  name: string;
  command: string;
}

export interface CheckResult extends CheckCommand {
  passed: boolean;
  durationSec: number;
  outputTail: string;
}

export type CheckStatus = "passed" | "regression" | "pre-existing" | "new" | "not-run";

export interface ClassifiedCheck extends CheckResult {
  status: CheckStatus;
}

export interface ExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ExecResult {
  status: number | null;
  output: string;
}

export type CheckExec = (command: string, options: ExecOptions) => Promise<ExecResult>;

const CHECK_TIMEOUT_MS = 15 * 60 * 1000;
const TAIL_LINES = 80;
const MAX_BUFFER_CHARS = 256 * 1024;
const FINDING_DETAIL_CHARS = 200;

export function checkCommands(toolchain: Toolchain, dirs: string[]): CheckCommand[] {
  if (toolchain === "terraform") {
    return [
      ...dirs.map(dir => ({
        name: `terraform validate (${dir})`,
        command: `terraform -chdir=${dir} init -backend=false -input=false && terraform -chdir=${dir} validate`,
      })),
      { name: "terraform fmt", command: "terraform fmt -check -recursive" },
    ];
  }
  return [
    { name: "build", command: "npm run build" },
    { name: "typecheck", command: "npm run typecheck" },
    { name: "lint", command: "npm run lint" },
    { name: "format", command: "npm run format" },
    { name: "tests (root)", command: "npx vitest run" },
    ...dirs.map(w => ({ name: `tests (${w})`, command: `npm test -w ${w}` })),
  ];
}

const insideCwd = (cwd: string, loc: string): boolean => {
  const rel = path.relative(cwd, path.resolve(cwd, loc));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

function queriedWorkspaces(cwd: string, query: (cwd: string) => string): string[] {
  try {
    const entries = JSON.parse(query(cwd)) as { location?: unknown }[];
    return entries
      .map(e => e.location)
      .filter((l): l is string => typeof l === "string" && insideCwd(cwd, l))
      .map(l => path.relative(cwd, path.resolve(cwd, l)));
  } catch {
    return [];
  }
}

function declaredWorkspaceGlobs(cwd: string): string[] | null {
  const manifestPath = path.join(cwd, "package.json");
  if (!existsSync(manifestPath)) return null;
  const { workspaces } = JSON.parse(readFileSync(manifestPath, "utf-8")) as { workspaces?: string[] | { packages?: string[] } };
  if (!workspaces) return null;
  return Array.isArray(workspaces) ? workspaces : workspaces.packages ?? [];
}

const isPackageDir = (cwd: string, dir: string): boolean =>
  statSync(path.join(cwd, dir)).isDirectory() && existsSync(path.join(cwd, dir, "package.json"));

export function discoverWorkspaces(cwd: string, query: (cwd: string) => string = npmQuery): string[] {
  const queried = queriedWorkspaces(cwd, query);
  if (queried.length > 0) return queried;
  const globs = declaredWorkspaceGlobs(cwd);
  if (globs === null) return [];
  const expanded = [...new Set(globs.flatMap(g => globSync(g, { cwd })).filter(d => insideCwd(cwd, d) && isPackageDir(cwd, d)))].sort();
  if (expanded.length === 0) throw new Error(`workspace discovery broken in ${cwd}`);
  return expanded;
}

const NON_ROOT_TERRAFORM_DIRS = new Set(["modules", ".terraform", ".git", "node_modules"]);

export function discoverTerraformRoots(cwd: string): string[] {
  const roots = [...new Set(globSync("**/*.tf", { cwd })
    .map(f => path.dirname(f))
    .filter(dir => !dir.split(path.sep).some(part => NON_ROOT_TERRAFORM_DIRS.has(part))))].sort();
  if (roots.length === 0) throw new Error(`no terraform root modules in ${cwd}`);
  return roots;
}

const npmQuery = (cwd: string) =>
  execFileSync("npm", ["query", ".workspace"], { cwd, encoding: "utf-8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });

export const tail = (text: string, lines = TAIL_LINES): string => text.replace(/\s+$/, "").split(/\r?\n/).slice(-lines).join("\n");

export const execShell: CheckExec = (command, { cwd, env, timeoutMs }) =>
  new Promise(resolve => {
    const child = spawn("sh", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const collect = (d: string) => { output = (output + d).slice(-MAX_BUFFER_CHARS); };
    child.stdout.setEncoding("utf-8").on("data", collect);
    child.stderr.setEncoding("utf-8").on("data", collect);
    const killGroup = (signal: NodeJS.Signals) => {
      try { process.kill(-child.pid!, signal); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    const finish = (status: number | null, extra = "") => {
      clearTimeout(timer);
      const note = timedOut ? `\ntimed out after ${Math.round(timeoutMs / 1000)}s` : extra;
      resolve({ status: timedOut ? null : status, output: output + note });
    };
    child.on("error", e => finish(null, `\n${e.message}`));
    child.on("close", code => finish(code));
  });

export async function runChecks(
  cwd: string, commands: CheckCommand[], env: NodeJS.ProcessEnv, exec: CheckExec = execShell,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const { name, command } of commands) {
    const started = Date.now();
    const { status, output } = await exec(command, { cwd, env, timeoutMs: CHECK_TIMEOUT_MS });
    results.push({ name, command, passed: status === 0, durationSec: Math.round((Date.now() - started) / 1000), outputTail: tail(output) });
  }
  return results;
}

const NEVER_STARTED_PATTERNS = [/No workspaces found/i, /npm error missing script/i, /ERR_MODULE_NOT_FOUND[^\n]*(vitest|\.config\.)/i, /: command not found/i, /\bspawn \S+ ENOENT/i];

export const didNotRun = (check: CheckResult): boolean =>
  !check.passed && (check.durationSec === 0 || NEVER_STARTED_PATTERNS.some(p => p.test(check.outputTail)));

export function classifyChecks(baseline: CheckResult[], after: CheckResult[]): ClassifiedCheck[] {
  return after.map((check): ClassifiedCheck => {
    const before = baseline.find(b => b.command === check.command);
    const status: CheckStatus = !before ? (didNotRun(check) ? "not-run" : "new") : check.passed ? "passed" : before.passed ? "regression" : didNotRun(check) ? "not-run" : "pre-existing";
    return { ...check, status };
  });
}

export const regressions = (checks: ClassifiedCheck[]): ClassifiedCheck[] => checks.filter(c => c.status === "regression");

const checkFile = (command: string): string => command.match(/ -w (\S+)/)?.[1] ?? ".";

export function firstFailingLine(outputTail: string): string {
  const lines = outputTail.split(/\r?\n/).map(l => l.trim()).filter(l => l !== "");
  const line = lines.find(l => /\b(error|fail(ed|ure|s)?)\b|✗|×|FAIL/i.test(l)) ?? lines[lines.length - 1] ?? "";
  return line.slice(0, FINDING_DETAIL_CHARS);
}

export function regressionFindings(checks: ClassifiedCheck[]): ReviewFinding[] {
  return regressions(checks).map((c, i) => {
    const detail = firstFailingLine(c.outputTail);
    return {
      id: `C${i + 1}`,
      severity: "blocker",
      file: checkFile(c.command),
      issue: `${c.command} fails after the change (passed before it)${detail ? `: ${detail}` : ""}`,
      suggestion: `Make ${c.command} pass again.`,
    };
  });
}
