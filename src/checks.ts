import { execFileSync, spawn } from "node:child_process";
import type { RepoKind, ReviewFinding } from "./types.js";

export interface CheckCommand {
  name: string;
  command: string;
}

export interface CheckResult extends CheckCommand {
  passed: boolean;
  durationSec: number;
  outputTail: string;
}

export type CheckStatus = "passed" | "regression" | "pre-existing" | "new";

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

export function checkCommands(repo: RepoKind, workspaces: string[]): CheckCommand[] {
  if (repo === "terraform") {
    return [
      { name: "terraform init", command: "terraform init -backend=false" },
      { name: "terraform validate", command: "terraform validate" },
      { name: "terraform fmt", command: "terraform fmt -check -recursive" },
    ];
  }
  return [
    { name: "build", command: "npm run build" },
    { name: "typecheck", command: "npm run typecheck" },
    { name: "lint", command: "npm run lint" },
    { name: "format", command: "npm run format" },
    { name: "tests (root)", command: "npx vitest run" },
    ...workspaces.map(w => ({ name: `tests (${w})`, command: `npm test -w ${w}` })),
  ];
}

export function discoverWorkspaces(cwd: string, query: (cwd: string) => string = npmQuery): string[] {
  try {
    const entries = JSON.parse(query(cwd)) as { location?: unknown }[];
    return entries.map(e => e.location).filter((l): l is string => typeof l === "string" && l !== "");
  } catch {
    return [];
  }
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

export function classifyChecks(baseline: CheckResult[], after: CheckResult[]): ClassifiedCheck[] {
  return after.map((check): ClassifiedCheck => {
    const before = baseline.find(b => b.command === check.command);
    const status: CheckStatus = !before ? "new" : check.passed ? "passed" : before.passed ? "regression" : "pre-existing";
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
