import { spawn } from "node:child_process";
import { globSync, statSync } from "node:fs";
import path from "node:path";
import type { RepoConfig } from "./project.js";
import type { ReviewFinding } from "./types.js";

export interface CheckCommand {
  name: string;
  command: string;
  cwd?: string;
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

const SKIPPED_SEGMENTS = new Set(["node_modules", ".git", ".terraform"]);

function expandDirs(kind: string, label: string, globs: string[], wtPath: string): string[] {
  const dirs = [...new Set(
    globs.flatMap(g => globSync(g, { cwd: wtPath }))
      .filter(f => !f.split(path.sep).some(segment => SKIPPED_SEGMENTS.has(segment)) && statSync(path.join(wtPath, f)).isFile())
      .map(f => path.dirname(f)),
  )].sort();
  if (dirs.length === 0) throw new Error(`${kind} "${label}": "${globs.join('", "')}" matched nothing in ${wtPath}`);
  return dirs;
}

function expand(kind: string, entries: { name?: string; command: string; in?: string[] }[], wtPath: string): CheckCommand[] {
  return entries.flatMap(({ name = "", command, in: globs }) => {
    const label = name || command;
    if (!globs) return [{ name: label, command }];
    return expandDirs(kind, label, globs, wtPath).map(dir => ({ name: `${label} (${dir})`, command, cwd: dir }));
  });
}

export const repoCheckCommands = (repo: RepoConfig, wtPath: string): CheckCommand[] => expand("check", repo.checks, wtPath);

export const repoSetupCommands = (repo: Pick<RepoConfig, "setup">, wtPath: string): CheckCommand[] => expand("setup", repo.setup, wtPath);

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
  for (const { name, command, cwd: subdir } of commands) {
    const started = Date.now();
    const { status, output } = await exec(command, { cwd: subdir ? path.join(cwd, subdir) : cwd, env, timeoutMs: CHECK_TIMEOUT_MS });
    results.push({ name, command, ...(subdir ? { cwd: subdir } : {}), passed: status === 0, durationSec: Math.round((Date.now() - started) / 1000), outputTail: tail(output) });
  }
  return results;
}

const NEVER_STARTED_PATTERNS = [/No workspaces found/i, /npm error missing script/i, /ERR_MODULE_NOT_FOUND[^\n]*\.config\./i, /: command not found/i, /\bspawn \S+ ENOENT/i];

export const didNotRun = (check: CheckResult): boolean =>
  !check.passed && (check.durationSec === 0 || NEVER_STARTED_PATTERNS.some(p => p.test(check.outputTail)));

export function classifyChecks(baseline: CheckResult[], after: CheckResult[]): ClassifiedCheck[] {
  return after.map((check): ClassifiedCheck => {
    const before = baseline.find(b => b.name === check.name && b.command === check.command && b.cwd === check.cwd);
    const status: CheckStatus = !before ? (didNotRun(check) ? "not-run" : "new") : check.passed ? "passed" : before.passed ? "regression" : didNotRun(check) ? "not-run" : "pre-existing";
    return { ...check, status };
  });
}

export const regressions = (checks: ClassifiedCheck[]): ClassifiedCheck[] => checks.filter(c => c.status === "regression");

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
      file: c.cwd ?? ".",
      issue: `${c.command} fails after the change (passed before it)${detail ? `: ${detail}` : ""}`,
      suggestion: `Make ${c.command} pass again.`,
    };
  });
}
