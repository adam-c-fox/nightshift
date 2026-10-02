import { readFileSync } from "node:fs";
import path from "node:path";
import { runWithWatchdog } from "./process.js";
import type { FixResolution, ReviewFinding, Severity, TestResult } from "./types.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const AGENTS_MD = path.join(ROOT, "AGENTS.md");
const REVIEW_MD = path.join(ROOT, "prompts", "review.md");
const FIX_MD = path.join(ROOT, "prompts", "fix.md");

export interface TicketBrief {
  ticketId: string;
  ticketName: string;
  context: string[];
  linearDesc: string;
  linearUrl: string;
  state: string;
}

function ticketSection(brief: TicketBrief): string[] {
  const ctx = brief.context.length > 0 ? brief.context.map(c => `  - ${c}`).join("\n") : "  - (none provided)";
  return [
    `## Ticket: ${brief.ticketId} – ${brief.ticketName}`,
    ``,
    `**Linear URL:** ${brief.linearUrl}`,
    `**Linear state:** ${brief.state}`,
    `**Linear description:**`,
    `  ${brief.linearDesc || "(no description)"}`,
    ``,
    `**Additional context from the operator:**`,
    ctx,
    ``,
    `---`,
  ];
}

function buildPrompt(brief: TicketBrief): string {
  return [
    ...ticketSection(brief),
    `Work on this ticket now.`,
    `Follow the TDD process in the operating instructions exactly.`,
    `When you are finished, end your final message with the ---REPORT--- block as specified in the operating instructions §6.`,
  ].join("\n");
}

function reportSummary(report: AgentReport | undefined): string[] {
  if (!report) return [`(the implementation produced no report)`];
  return [
    `Title: ${report.title || "(none)"}`,
    `Summary: ${report.summary || "(none)"}`,
    `Files created: ${report.filesCreated.join(", ") || "(none)"}`,
    `Files modified: ${report.filesModified.join(", ") || "(none)"}`,
    `Tests: ${report.tests.map(t => `${t.name} [${t.result}]`).join("; ") || "(none)"}`,
    `Notes: ${report.notes || "(none)"}`,
  ];
}

export function buildReviewPrompt(brief: TicketBrief, report: AgentReport | undefined, baseRef: string): string {
  return [
    ...ticketSection(brief),
    `**The implementer's report:**`,
    ...reportSummary(report).map(l => `  ${l}`),
    ``,
    `**Base ref:** \`${baseRef}\``,
    `Inspect the change yourself with \`git diff ${baseRef}\` and \`git status --porcelain\` (untracked files are not in the diff; read them directly).`,
    `Review it now. Do not modify any file. End your final message with the ---REVIEW--- block.`,
  ].join("\n");
}

export function buildFixPrompt(brief: TicketBrief, findings: ReviewFinding[]): string {
  const listed = findings.map(f =>
    [`- id: ${f.id}`, `  severity: ${f.severity}`, `  file: ${f.file}`, `  issue: ${f.issue}`, `  suggestion: ${f.suggestion}`].join("\n"));
  return [
    ...ticketSection(brief),
    `The change for this ticket is already in the worktree. These issues were found in it:`,
    ``,
    ...listed,
    ``,
    `Address every one of them as set out in the fix instructions, then end your final message with the ---REPORT--- block followed by the ---FIXES--- block.`,
  ].join("\n");
}

export interface AgentReport {
  status: string; title: string; summary: string;
  filesCreated: string[]; filesModified: string[];
  tests: TestResult[]; verifyCommands: string[]; notes: string;
}

const VALID_STATUSES = ["done", "partial", "needs_review"];
const REPORT_START = "---REPORT---";
const REVIEW_START = "---REVIEW---";
const FIXES_START = "---FIXES---";
const BLOCK_END = "---";
const SEVERITIES: Severity[] = ["blocker", "major", "minor"];

function unquote(value: string): string {
  const v = value.trim();
  const quoted = v.match(/^(["'])([\s\S]*)\1$/);
  return quoted ? quoted[2] : v;
}

function groupByTopLevelKey(lines: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    const key = line.match(/^([a-z_]+):(.*)$/);
    if (key) {
      current = [key[2]];
      groups.set(key[1], current);
    } else if (current) {
      current.push(line);
    }
  }
  return groups;
}

function scalar(lines: string[] | undefined): string {
  if (!lines) return "";
  const [first, ...rest] = lines;
  const head = /^\s*[|>][+-]?\s*$/.test(first) ? "" : first.trim();
  const text = [head, ...rest.map(l => l.trim())].filter(l => l !== "").join(" ");
  return unquote(text);
}

function listItems(lines: string[] | undefined): string[] {
  if (!lines) return [];
  return lines
    .map(l => l.trim())
    .filter(l => l.startsWith("-"))
    .map(l => unquote(l.replace(/^-\s*/, "")))
    .filter(l => l !== "");
}

function parseTests(lines: string[] | undefined): TestResult[] {
  const tests: TestResult[] = [];
  let current: Partial<TestResult> | null = null;
  const flush = () => {
    if (current?.name) {
      tests.push({ name: current.name, file: current.file ?? "", result: current.result ?? "fail" });
    }
    current = null;
  };
  for (const raw of lines ?? []) {
    const line = raw.trim().replace(/^-\s*/, "");
    const field = line.match(/^(name|file|result):\s*(.*)$/);
    if (!field) continue;
    if (/^\s*-/.test(raw) && field[1] === "name") flush();
    current ??= {};
    const value = unquote(field[2]);
    if (field[1] === "name") current.name = value;
    else if (field[1] === "file") current.file = value;
    else current.result = value.toLowerCase() === "pass" ? "pass" : "fail";
  }
  flush();
  return tests;
}

function extractBlock(output: string, marker: string): string[] {
  const lines = output.split(/\r?\n/);
  const startIdx = lines.map(l => l.trim()).lastIndexOf(marker);
  if (startIdx === -1) {
    throw new Error(`No ${marker} block found in agent output`);
  }
  const body = lines.slice(startIdx + 1);
  const endIdx = body.findIndex(l => l.trimEnd() === BLOCK_END);
  return endIdx === -1 ? body : body.slice(0, endIdx);
}

function parseRecords(lines: string[] | undefined, fields: string[]): Record<string, string>[] {
  const records: Record<string, string>[] = [];
  let current: Record<string, string> | undefined;
  for (const raw of lines ?? []) {
    const field = raw.trim().replace(/^-\s*/, "").match(/^([a-z_]+):\s*(.*)$/);
    if (!field || !fields.includes(field[1])) continue;
    if (current === undefined || /^\s*-/.test(raw)) {
      current = {};
      records.push(current);
    }
    current[field[1]] = unquote(field[2]);
  }
  return records;
}

export function parseReviewBlock(output: string): ReviewFinding[] {
  const groups = groupByTopLevelKey(extractBlock(output, REVIEW_START));
  return parseRecords(groups.get("findings"), ["id", "severity", "file", "issue", "suggestion"])
    .filter(r => r.issue)
    .map((r, i) => ({
      id: r.id || `R${i + 1}`,
      severity: SEVERITIES.includes(r.severity as Severity) ? r.severity as Severity : "major",
      file: r.file ?? "",
      issue: r.issue,
      suggestion: r.suggestion ?? "",
    }));
}

export function parseFixesBlock(output: string): FixResolution[] {
  return parseRecords(extractBlock(output, FIXES_START), ["id", "status", "how"])
    .filter(r => r.id)
    .map(r => ({ id: r.id, status: r.status === "fixed" ? "fixed" : "not_fixed", how: r.how ?? "" }));
}

export function parseReportBlock(output: string): AgentReport {
  const groups = groupByTopLevelKey(extractBlock(output, REPORT_START));

  const status = scalar(groups.get("status")).toLowerCase();

  return {
    status: VALID_STATUSES.includes(status) ? status : "needs_review",
    title: scalar(groups.get("title")),
    summary: scalar(groups.get("summary")),
    filesCreated: listItems(groups.get("files_created")),
    filesModified: listItems(groups.get("files_modified")),
    tests: parseTests(groups.get("tests")),
    verifyCommands: listItems(groups.get("verify")),
    notes: scalar(groups.get("notes")),
  };
}

export interface ClaudeResult {
  success: boolean;
  rawOutput: string;
  report?: AgentReport;
  parseError?: string;
  failure?: string;
  abortReason?: string;
}

export const MAX_TURNS = 80;
const SAFETY_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const USAGE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

export interface ToolProfile {
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
}

const NEVER_PUBLISH = ["Bash(git push *)", "Bash(git config *)", "Bash(git commit *)"];

export const EDIT_PROFILE: ToolProfile = {
  permissionMode: "acceptEdits",
  allowedTools: [
    "Bash(npm *)", "Bash(npx *)", "Bash(node *)",
    "Bash(git *)", "Bash(terraform *)",
    "Bash(grep *)", "Bash(rg *)", "Bash(find *)", "Bash(ls *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
  ],
  disallowedTools: NEVER_PUBLISH,
};

export const REVIEW_PROFILE: ToolProfile = {
  permissionMode: "default",
  allowedTools: [
    "Read", "Grep", "Glob",
    "Bash(git diff *)", "Bash(git status*)", "Bash(git log *)", "Bash(git show *)",
    "Bash(grep *)", "Bash(rg *)", "Bash(find *)", "Bash(ls *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
    "Bash(npx vitest run*)", "Bash(npm run lint)", "Bash(npm run format)", "Bash(npx tsc --noEmit*)",
  ],
  disallowedTools: [
    "Edit", "Write", "NotebookEdit",
    "Bash(git * --output*)", "Bash(find * -delete*)", "Bash(find * -exec*)",
    "Bash(npx vitest * -u*)", "Bash(npx vitest * --update*)",
    ...NEVER_PUBLISH,
  ],
};

export function buildClaudeArgs(operatingInstructions: string, profile: ToolProfile = EDIT_PROFILE): string[] {
  return [
    "-p",
    "--max-turns", String(MAX_TURNS),
    "--permission-mode", profile.permissionMode,
    "--allowedTools", profile.allowedTools.join(","),
    "--disallowedTools", profile.disallowedTools.join(","),
    "--append-system-prompt", operatingInstructions,
  ];
}

export function agentRunArgs(base: string[], settings: string): string[] {
  return [...base, "--settings", settings, "--strict-mcp-config", "--setting-sources", "user"];
}

export interface RunAgentOptions {
  shouldAbort?: () => string | undefined;
  checkIntervalMs?: number;
  env: NodeJS.ProcessEnv;
  settings: string;
}

interface ClaudeRun {
  stdout: string;
  rawOutput: string;
  failure?: string;
  abortReason?: string;
}

async function execClaude(
  worktreePath: string, prompt: string, systemPrompt: string, profile: ToolProfile, options: RunAgentOptions,
): Promise<ClaudeRun> {
  const args = agentRunArgs(buildClaudeArgs(systemPrompt, profile), options.settings);
  const proc = await runWithWatchdog("claude", args, {
    cwd: worktreePath,
    input: prompt,
    env: options.env,
    timeoutMs: SAFETY_TIMEOUT_MS,
    checkIntervalMs: options.checkIntervalMs ?? USAGE_CHECK_INTERVAL_MS,
    shouldAbort: options.shouldAbort,
  });

  const failure = proc.error
    ? `claude failed to run: ${proc.error.message}`
    : proc.abortReason
      ? `claude stopped: ${proc.abortReason}`
      : proc.status !== 0
      ? `claude exited with status ${proc.status}${proc.signal ? ` (${proc.signal})` : ""}`
      : undefined;
  const rawOutput = [proc.stdout, proc.stderr, failure ?? ""].filter(Boolean).join("\n");
  return { stdout: proc.stdout, rawOutput, failure, abortReason: proc.abortReason };
}

function parseOrError<T>(stdout: string, failure: string | undefined, parse: (output: string) => T): { value?: T; error?: string } {
  try {
    return { value: parse(stdout) };
  } catch (e) {
    return { error: failure ? `${failure}; ${(e as Error).message}` : (e as Error).message };
  }
}

export async function runAgent(
  worktreePath: string,
  ticketId: string,
  ticketName: string,
  context: string[],
  linearDesc: string,
  linearUrl: string,
  linearState: string,
  dryRun: boolean,
  options: RunAgentOptions,
): Promise<ClaudeResult> {
  const prompt = buildPrompt({ ticketId, ticketName, context, linearDesc, linearUrl, state: linearState });

  if (dryRun) {
    console.log(`  [dry-run] Would run: claude ${buildClaudeArgs("<AGENTS.md>").slice(0, -2).join(" ")} (in ${worktreePath})`);
    console.log(`  [dry-run] Prompt:\n${prompt.slice(0, 500)}...`);
    return { success: true, rawOutput: "", report: {
      status: "done", title: "", summary: "dry run", filesCreated: [], filesModified: [],
      tests: [], verifyCommands: [], notes: "dry run – no changes",
    }};
  }

  const run = await execClaude(worktreePath, prompt, readFileSync(AGENTS_MD, "utf-8"), EDIT_PROFILE, options);
  const { value: report, error: parseError } = parseOrError(run.stdout, run.failure, parseReportBlock);
  return { success: run.failure === undefined, rawOutput: run.rawOutput, report, parseError, failure: run.failure, abortReason: run.abortReason };
}

export interface ReviewRunResult {
  success: boolean;
  rawOutput: string;
  findings?: ReviewFinding[];
  parseError?: string;
  failure?: string;
  abortReason?: string;
}

export async function runReview(
  worktreePath: string, brief: TicketBrief, report: AgentReport | undefined, baseRef: string, options: RunAgentOptions,
): Promise<ReviewRunResult> {
  const prompt = buildReviewPrompt(brief, report, baseRef);
  const run = await execClaude(worktreePath, prompt, readFileSync(REVIEW_MD, "utf-8"), REVIEW_PROFILE, options);
  const { value: findings, error: parseError } = parseOrError(run.stdout, run.failure, parseReviewBlock);
  return { success: run.failure === undefined, rawOutput: run.rawOutput, findings, parseError, failure: run.failure, abortReason: run.abortReason };
}

export interface FixRunResult extends ClaudeResult {
  fixes?: FixResolution[];
  fixesError?: string;
}

export async function runFix(
  worktreePath: string, brief: TicketBrief, findings: ReviewFinding[], options: RunAgentOptions,
): Promise<FixRunResult> {
  const prompt = buildFixPrompt(brief, findings);
  const systemPrompt = [readFileSync(AGENTS_MD, "utf-8"), readFileSync(FIX_MD, "utf-8")].join("\n\n---\n\n");
  const run = await execClaude(worktreePath, prompt, systemPrompt, EDIT_PROFILE, options);
  const parsedReport = parseOrError(run.stdout, run.failure, parseReportBlock);
  const parsedFixes = parseOrError(run.stdout, run.failure, parseFixesBlock);
  return {
    success: run.failure === undefined, rawOutput: run.rawOutput,
    report: parsedReport.value, parseError: parsedReport.error,
    fixes: parsedFixes.value, fixesError: parsedFixes.error,
    failure: run.failure, abortReason: run.abortReason,
  };
}
