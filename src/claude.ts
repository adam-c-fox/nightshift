import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { TestResult } from "./types.js";

const AGENTS_MD = path.resolve(import.meta.dirname, "..", "AGENTS.md");

function buildPrompt(ticketId: string, ticketName: string, context: string[], linearDesc: string, linearUrl: string, state: string): string {
  const ctx = context.length > 0 ? context.map(c => `  - ${c}`).join("\n") : "  - (none provided)";
  return [
    `## Ticket: ${ticketId} – ${ticketName}`,
    ``,
    `**Linear URL:** ${linearUrl}`,
    `**Linear state:** ${state}`,
    `**Linear description:**`,
    `  ${linearDesc || "(no description)"}`,
    ``,
    `**Additional context from the operator:**`,
    ctx,
    ``,
    `---`,
    `Work on this ticket now.`,
    `Follow the TDD process in the operating instructions exactly.`,
    `When you are finished, end your final message with the ---REPORT--- block as specified in the operating instructions §6.`,
  ].join("\n");
}

export interface AgentReport {
  status: string; summary: string;
  filesCreated: string[]; filesModified: string[];
  tests: TestResult[]; verifyCommands: string[]; notes: string;
}

const VALID_STATUSES = ["done", "partial", "needs_review"];
const REPORT_START = "---REPORT---";
const REPORT_END = "---";

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

export function parseReportBlock(output: string): AgentReport {
  const lines = output.split(/\r?\n/);
  const startIdx = lines.map(l => l.trim()).lastIndexOf(REPORT_START);
  if (startIdx === -1) {
    throw new Error("No ---REPORT--- block found in agent output");
  }

  const body = lines.slice(startIdx + 1);
  const endIdx = body.findIndex(l => l.trimEnd() === REPORT_END);
  const blockLines = endIdx === -1 ? body : body.slice(0, endIdx);
  const groups = groupByTopLevelKey(blockLines);

  const status = scalar(groups.get("status")).toLowerCase();

  return {
    status: VALID_STATUSES.includes(status) ? status : "needs_review",
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
}

export const MAX_TURNS = 80;
const SAFETY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const ALLOWED_TOOLS = [
  "Bash(npm *)", "Bash(npx *)", "Bash(node *)",
  "Bash(git *)", "Bash(terraform *)",
  "Bash(grep *)", "Bash(rg *)", "Bash(find *)", "Bash(ls *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
];
const DISALLOWED_TOOLS = ["Bash(git push *)", "Bash(git config *)"];

export function buildClaudeArgs(operatingInstructions: string): string[] {
  return [
    "-p",
    "--max-turns", String(MAX_TURNS),
    "--permission-mode", "acceptEdits",
    "--allowedTools", ALLOWED_TOOLS.join(","),
    "--disallowedTools", DISALLOWED_TOOLS.join(","),
    "--append-system-prompt", operatingInstructions,
  ];
}

export function runAgent(
  worktreePath: string,
  ticketId: string,
  ticketName: string,
  context: string[],
  linearDesc: string,
  linearUrl: string,
  linearState: string,
  dryRun: boolean,
): ClaudeResult {
  const prompt = buildPrompt(ticketId, ticketName, context, linearDesc, linearUrl, linearState);

  if (dryRun) {
    console.log(`  [dry-run] Would run: claude ${buildClaudeArgs("<AGENTS.md>").slice(0, -2).join(" ")} (in ${worktreePath})`);
    console.log(`  [dry-run] Prompt:\n${prompt.slice(0, 500)}...`);
    return { success: true, rawOutput: "", report: {
      status: "done", summary: "dry run", filesCreated: [], filesModified: [],
      tests: [], verifyCommands: [], notes: "dry run – no changes",
    }};
  }

  const proc = spawnSync("claude", buildClaudeArgs(readFileSync(AGENTS_MD, "utf-8")), {
    cwd: worktreePath,
    input: prompt,
    encoding: "utf-8",
    timeout: SAFETY_TIMEOUT_MS,
    maxBuffer: 50 * 1024 * 1024,
  });

  const stdout = proc.stdout ?? "";
  const failure = proc.error
    ? `claude failed to run: ${proc.error.message}`
    : proc.status !== 0
      ? `claude exited with status ${proc.status}${proc.signal ? ` (${proc.signal})` : ""}`
      : undefined;
  const rawOutput = [stdout, proc.stderr ?? "", failure ?? ""].filter(Boolean).join("\n");

  let report: AgentReport | undefined;
  let parseError: string | undefined;
  try {
    report = parseReportBlock(stdout);
  } catch (e) {
    parseError = failure ? `${failure}; ${(e as Error).message}` : (e as Error).message;
  }

  return { success: failure === undefined, rawOutput, report, parseError };
}
