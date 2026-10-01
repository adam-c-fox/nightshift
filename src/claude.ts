import { execSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { TicketResult, TestResult } from "./types.js";

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
    `Follow the TDD process in CLAUDE.md exactly.`,
    `When you are finished, end your final message with the ---REPORT--- block as specified in CLAUDE.md §6.`,
  ].join("\n");
}

function parseReportBlock(output: string): {
  status: string; summary: string;
  filesCreated: string[]; filesModified: string[];
  tests: TestResult[]; verifyCommands: string[]; notes: string;
} {
  const match = output.match(/---REPORT---\s*\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error("No ---REPORT--- block found in agent output");
  }

  const block = match[1];
  const get = (key: string): string => {
    const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : "";
  };

  const getList = (key: string): string[] => {
    const section = block.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m"));
    if (!section) return [];
    return section[1]
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.startsWith("-"))
      .map(l => l.replace(/^-\s*/, "").trim());
  };

  // Parse tests (structured list)
  const testsSection = block.match(/^tests:\s*\n([\s\S]*?)(?=^(?:verify|notes|status|--)/m);
  const tests: TestResult[] = [];
  if (testsSection) {
    const lines = testsSection[1].split("\n");
    let current: Partial<TestResult> | null = null;
    for (const line of lines) {
      const nameM = line.match(/^\s*-\s*name:\s*(.+)$/);
      const fileM = line.match(/^\s*file:\s*(.+)$/);
      const resultM = line.match(/^\s*result:\s*(pass|fail)$/);
      if (nameM) { current = { name: nameM[1].trim() }; }
      else if (fileM && current) { current.file = fileM[1].trim(); }
      else if (resultM && current) {
        current.result = resultM[1] as "pass" | "fail";
        tests.push(current as TestResult);
        current = null;
      }
    }
  }

  return {
    status: get("status"),
    summary: get("summary"),
    filesCreated: getList("files_created"),
    filesModified: getList("files_modified"),
    tests,
    verifyCommands: getList("verify"),
    notes: get("notes"),
  };
}

export interface ClaudeResult {
  success: boolean;
  rawOutput: string;
  report?: {
    status: string; summary: string;
    filesCreated: string[]; filesModified: string[];
    tests: TestResult[]; verifyCommands: string[]; notes: string;
  };
  parseError?: string;
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
  // Copy AGENTS.md → CLAUDE.md in the worktree
  const claudemdPath = path.join(worktreePath, "CLAUDE.md");
  if (dryRun) {
    console.log(`  [dry-run] Would copy AGENTS.md → ${claudemdPath}`);
  } else {
    copyFileSync(AGENTS_MD, claudemdPath);
  }

  const prompt = buildPrompt(ticketId, ticketName, context, linearDesc, linearUrl, linearState);

  if (dryRun) {
    console.log(`  [dry-run] Would run: claude -p (in ${worktreePath})`);
    console.log(`  [dry-run] Prompt:\n${prompt.slice(0, 500)}...`);
    return { success: true, rawOutput: "", report: {
      status: "done", summary: "dry run", filesCreated: [], filesModified: [],
      tests: [], verifyCommands: [], notes: "dry run – no changes"
    }};
  }

  const cmd = `claude -p "${prompt.replace(/"/g, '\\"')}" 2>&1`;
  const maxTurns = 40;
  const timeout = 45 * 60 * 1000; // 45 min max per ticket

  let output = "";
  try {
    output = execSync(
      `CLAUDE_CODE_MAX_TURNS=${maxTurns} claude -p "${prompt.replace(/"/g, '\\"')}"`,
      {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      },
    );
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
    // Non-zero exit might still have valid output
  }

  let report: ClaudeResult["report"];
  let parseError: string | undefined;

  try {
    report = parseReportBlock(output);
  } catch (e) {
    parseError = (e as Error).message;
  }

  return {
    success: true,
    rawOutput: output,
    report,
    parseError,
  };
}
