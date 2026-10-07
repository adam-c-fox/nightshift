import { readFileSync } from "node:fs";
import path from "node:path";
import { execClaude, extractBlock, parseOrError, parseRecords, POSTMORTEM_PROFILE, type RunAgentOptions } from "./claude.js";
import type { PostmortemSuggestion, SessionPostmortem, SessionResult, TicketResult } from "./types.js";

const SKILL_MD = path.resolve(import.meta.dirname, "..", ".claude", "skills", "postmortem", "SKILL.md");
const POSTMORTEM_START = "---POSTMORTEM---";
const FIELDS = ["id", "target", "tickets", "problem", "cause", "change"];
const LOG_SUFFIXES = ["output", "review", "fix", "verify", "diff"];

export type UsageGate = "open" | "hit" | "unreadable";

export interface SkipInput {
  dryRun: boolean;
  tickets: TicketResult[];
  gate: () => UsageGate;
}

export function postmortemSkipReason({ dryRun, tickets, gate }: SkipInput): string | undefined {
  if (dryRun) return "dry run";
  if (!tickets.some(t => t.status !== "skipped" && t.status !== "error")) return "no tickets worked";
  const usage = gate();
  if (usage === "hit") return "budget cap reached";
  if (usage === "unreadable") return "could not read usage";
  return undefined;
}

export function postmortemSystemPrompt(skill: string): string {
  return skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\s*/, "");
}

export const buildPostmortemPrompt = (date: string, logsRel: string): string =>
  `Review the night of ${date}. Session: ${logsRel}/session-${date}.json. Suggest fixes only; do not edit anything. End your final message with the ---POSTMORTEM--- block.`;

export function parsePostmortemBlock(output: string): PostmortemSuggestion[] {
  const lines = extractBlock(output, POSTMORTEM_START);
  const records = parseRecords(lines, FIELDS);
  const body = lines.map(l => l.trim()).filter(l => l !== "" && !/^suggestions:\s*(\[\])?$/.test(l));
  if (body.length > 0 && records.length === 0) throw new Error("Malformed suggestions list in ---POSTMORTEM--- block");
  return records
    .filter(r => r.change)
    .map((r, i) => ({
      id: r.id || `P${i + 1}`,
      target: r.target ?? "",
      tickets: (r.tickets ?? "").split(",").map(t => t.trim()).filter(Boolean),
      problem: r.problem ?? "",
      cause: r.cause ?? "",
      change: r.change,
    }));
}

export function sessionLogData(session: SessionResult, logExists: (name: string) => boolean, logsRel: string): object {
  return {
    ...session,
    tickets: session.tickets.map(t => ({
      ...t,
      logFiles: LOG_SUFFIXES.map(s => `${t.ticket.id}-${s}.txt`).filter(logExists).map(f => `${logsRel}/${f}`),
    })),
  };
}

export function postmortemMarkdown(date: string, suggestions: PostmortemSuggestion[]): string {
  const items = suggestions.map(s => [
    `## ${s.id} – ${s.target}`, "",
    `Tickets: ${s.tickets.join(", ")}`, "",
    `- Problem: ${s.problem}`, `- Cause: ${s.cause}`, `- Change: ${s.change}`,
  ].join("\n"));
  return [
    `# Nightshift postmortem – ${date}`, "",
    "Suggestions only; nothing has been edited. Ask Claude to implement the ones you pick by id.", "",
    ...(items.length > 0 ? items.flatMap(i => [i, ""]) : ["No suggestions.", ""]),
  ].join("\n");
}

export async function runPostmortem(
  cwd: string, date: string, logsRel: string, addDirs: string[], options: RunAgentOptions,
): Promise<{ rawOutput: string; outcome: Omit<SessionPostmortem, "file"> }> {
  const system = postmortemSystemPrompt(readFileSync(SKILL_MD, "utf-8"));
  const run = await execClaude(cwd, buildPostmortemPrompt(date, logsRel), system, POSTMORTEM_PROFILE, options, addDirs);
  const { value, error } = parseOrError(run.stdout, run.failure, parsePostmortemBlock);
  const outcome = value
    ? { outcome: "done" as const, suggestions: value }
    : { outcome: "failed" as const, reason: error, suggestions: [] };
  return { rawOutput: run.rawOutput, outcome };
}
