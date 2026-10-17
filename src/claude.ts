import { readFileSync } from "node:fs";
import path from "node:path";
import { runWithWatchdog } from "./process.js";
import type { ClassifiedCheck } from "./checks.js";
import type { CandidateVerdict, ConfirmBatch, Confidence, Decision, Followup, FixResolution, LinearComment, ReviewCandidate, ReviewFinding, ReviewLens, ReviewRisk, Ruling, RunUsage, Severity, TestResult, Verdict, VerifyResult } from "./types.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const REVIEW_MD = path.join(ROOT, "prompts", "review.md");
const FIX_MD = path.join(ROOT, "prompts", "fix.md");
const VERIFY_MD = path.join(ROOT, "prompts", "verify.md");
const CONFIRM_MD = path.join(ROOT, "prompts", "confirm.md");
const DEDUPE_MD = path.join(ROOT, "prompts", "dedupe.md");
const lensMd = (lens: ReviewLens) => path.join(ROOT, "prompts", `review-${lens}.md`);
const LAYER_SEPARATOR = "\n\n---\n\n";

export interface TicketBrief {
  ticketId: string;
  ticketName: string;
  context: string[];
  linearDesc: string;
  linearComments: LinearComment[];
  linearUrl: string;
  state: string;
}

function commentLines(comments: LinearComment[]): string[] {
  if (comments.length === 0) return [];
  const items = comments.map(c => `  - ${c.author}, ${c.createdAt.slice(0, 10)}: ${c.body.replace(/\n/g, "\n    ")}`);
  return [`**Linear comments (oldest first):**`, ...items, ``];
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
    ...commentLines(brief.linearComments),
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

export interface RelatedBranch {
  ticketId: string;
  branch: string;
}

const CHECK_LABELS: Record<ClassifiedCheck["status"], string> = {
  passed: "passed", regression: "REGRESSION (passed before the change, fails now)",
  "pre-existing": "pre-existing failure (failed before the change too)", new: "new check",
  "not-run": "DID NOT RUN (failed without starting; the tests it covers are unproven)",
};
const OUTPUT_CHARS = 4000;

function checkLine(c: ClassifiedCheck): string {
  const result = c.status === "new" ? `new check, ${c.passed ? "passed" : "FAILED"}` : CHECK_LABELS[c.status];
  return `- \`${c.command}\`: ${result} (${c.durationSec}s)`;
}

function checksSection(checks: ClassifiedCheck[] | undefined): string[] {
  if (!checks || checks.length === 0) return [];
  const failing = checks.filter(c => !c.passed).flatMap(c =>
    [``, `Output of \`${c.command}\` (last lines):`, "```", c.outputTail.slice(-OUTPUT_CHARS), "```"]);
  return [
    ``,
    `**Check results.** The runner already ran these on the worktree before and after the change, so you do not need to re-run them. You may run targeted commands to investigate a failure.`,
    ...checks.map(checkLine),
    ...failing,
  ];
}

function relatedSection(related: RelatedBranch[] | undefined, baseRef: string): string[] {
  if (!related || related.length === 0) return [];
  return [
    ``,
    ...related.map(r =>
      `Related ticket ${r.ticketId} was implemented earlier this session on branch ${r.branch}. Check that both sides of any shared contract agree: \`git diff ${baseRef}...${r.branch}\`.`),
  ];
}

export interface ReviewPromptExtras {
  checks?: ClassifiedCheck[];
  related?: RelatedBranch[];
}

function decisionsSection(report: AgentReport | undefined): string[] {
  const decisions = report?.decisions ?? [];
  if (decisions.length === 0) {
    return [
      ``,
      `The implementer's report lists no decisions. Pull any choice the ticket did not settle out of the Notes above and rule on each, with ids \`N1\`, \`N2\`, … in the order they appear in the Notes.`,
    ];
  }
  return [
    ``,
    `**Implementer's decisions the ticket did not settle: rule on each one.**`,
    ...decisions.map((d, i) => `- D${i + 1} (${d.file}): ${d.decision}`),
  ];
}

function finderPrompt(
  brief: TicketBrief, report: AgentReport | undefined, baseRef: string, extras: ReviewPromptExtras, decisions: string[],
): string {
  return [
    ...ticketSection(brief),
    `**The implementer's report (unverified claims: check them yourself):**`,
    ...reportSummary(report).map(l => `  ${l}`),
    ``,
    `**Base ref:** \`${baseRef}\``,
    `Inspect the change yourself with \`git diff ${baseRef}\` and \`git status --porcelain\` (untracked files are not in the diff; read them directly).`,
    ...checksSection(extras.checks),
    ...relatedSection(extras.related, baseRef),
    ...decisions,
    ``,
    `Review it now. Do not modify any file. End your final message with the ---REVIEW--- block.`,
  ].join("\n");
}

export function buildFinderPrompt(
  lens: ReviewLens, brief: TicketBrief, report: AgentReport | undefined, baseRef: string, extras: ReviewPromptExtras = {},
): string {
  return finderPrompt(
    brief, report, baseRef,
    { checks: extras.checks, related: lens === "reuse" ? extras.related : undefined },
    lens === "bugs" ? decisionsSection(report) : [],
  );
}

export function buildConfirmPrompt(
  brief: TicketBrief, report: AgentReport | undefined, baseRef: string, batch: ConfirmBatch, extras: ReviewPromptExtras = {},
): string {
  const listed = batch.candidates.map(c =>
    [
      `- id: ${c.id}`, `  lens: ${c.lens}`, `  kind: ${c.kind}`, `  severity: ${c.severity}`, `  confidence: ${c.confidence}`,
      `  data: ${c.data ? "yes" : "no"}`, `  file: ${c.file}`, `  issue: ${c.issue}`, `  suggestion: ${c.suggestion}`,
      ...(batch.groupedWith[c.id] ? [`  grouped_with: ${batch.groupedWith[c.id]}`] : []),
    ].join("\n"));
  const decisions = report?.decisions ?? [];
  return [
    ...ticketSection(brief),
    `**The implementer's report. Its notes and decisions are the implementer's own claims and choices, not ticket text:**`,
    ...reportSummary(report).map(l => `  ${l}`),
    ...(decisions.length > 0 ? [`  Decisions:`, ...decisions.map((d, i) => `  - D${i + 1} (${d.file}): ${d.decision}`)] : [`  Decisions: (none)`]),
    ``,
    `**Base ref:** \`${baseRef}\``,
    `Inspect the current change with \`git diff ${baseRef}\` and \`git status --porcelain\` (untracked files are not in the diff; read them directly).`,
    ...checksSection(extras.checks),
    ``,
    `These candidates were reported against the change:`,
    ``,
    ...listed,
    ``,
    `Check each one against the code. Do not modify any file. End your final message with the ---CONFIRM--- block.`,
  ].join("\n");
}

export function buildDedupePrompt(candidates: ReviewCandidate[]): string {
  const listed = candidates.map(c =>
    [`- id: ${c.id}`, `  lens: ${c.lens}`, `  kind: ${c.kind}`, `  file: ${c.file}`, `  issue: ${c.issue}`].join("\n"));
  return [
    `These candidates were reported against one change:`,
    ``,
    ...listed,
    ``,
    `Group the ones that report the same problem. End your final message with the ---DEDUPE--- block.`,
  ].join("\n");
}

export function buildFixPrompt(brief: TicketBrief, findings: ReviewFinding[]): string {
  const listed = findings.map(f =>
    [`- id: ${f.id}`, `  severity: ${f.severity}`, `  file: ${f.file}`, ...(f.evidence ? [`  evidence: ${f.evidence}`] : []), `  issue: ${f.issue}`, `  suggestion: ${f.suggestion}`].join("\n"));
  return [
    ...ticketSection(brief),
    `The change for this ticket is already in the worktree. These issues were found in it:`,
    ``,
    ...listed,
    ``,
    `Address every one of them as set out in the fix instructions, then end your final message with the ---REPORT--- block followed by the ---FIXES--- block.`,
  ].join("\n");
}

export function buildVerifyPrompt(
  brief: TicketBrief, baseRef: string, findings: ReviewFinding[], resolutions: FixResolution[],
): string {
  const claimed = findings.flatMap(f => {
    const r = resolutions.find(x => x.id === f.id);
    return r?.status === "fixed"
      ? [[`- id: ${f.id}`, `  severity: ${f.severity}`, `  file: ${f.file}`, `  issue: ${f.issue}`, `  fixer says: ${r.how}`].join("\n")]
      : [];
  });
  return [
    ...ticketSection(brief),
    `**Base ref:** \`${baseRef}\``,
    `Inspect the current change with \`git diff ${baseRef}\` and \`git status --porcelain\` (untracked files are not in the diff; read them directly).`,
    ``,
    `The fixer claims these issues are now fixed:`,
    ``,
    ...claimed,
    ``,
    `Check each one against the current code. Do not modify any file. End your final message with the ---VERIFY--- block.`,
  ].join("\n");
}

export interface AgentReport {
  status: string; title: string; summary: string;
  filesCreated: string[]; filesModified: string[];
  tests: TestResult[]; verifyCommands: string[]; notes: string;
  followups: Followup[];
  decisions: Decision[];
}

const VALID_STATUSES = ["done", "partial", "needs_review"];
const REPORT_START = "---REPORT---";
const REVIEW_START = "---REVIEW---";
const FIXES_START = "---FIXES---";
const VERIFY_START = "---VERIFY---";
const CONFIRM_START = "---CONFIRM---";
const DEDUPE_START = "---DEDUPE---";
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

function parseDecisions(lines: string[] | undefined): Decision[] {
  return parseRecords(lines, ["file", "decision"]).filter(r => r.decision).map(r => ({ file: r.file ?? "", decision: r.decision }));
}

function parseFollowups(lines: string[] | undefined): Followup[] {
  return parseRecords(lines, ["file", "note"]).filter(r => r.note).map(r => ({ file: r.file ?? "", note: r.note }));
}

export function extractBlock(output: string, marker: string): string[] {
  const lines = output.split(/\r?\n/);
  const startIdx = lines.map(l => l.trim()).lastIndexOf(marker);
  if (startIdx === -1) {
    throw new Error(`No ${marker} block found in agent output`);
  }
  const body = lines.slice(startIdx + 1);
  const endIdx = body.findIndex(l => l.trimEnd() === BLOCK_END);
  return endIdx === -1 ? body : body.slice(0, endIdx);
}

export function parseRecords(lines: string[] | undefined, fields: string[]): Record<string, string>[] {
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

export interface FoundFinding extends ReviewFinding {
  confidence?: Confidence;
  decision?: string;
}

export interface ParsedRuling {
  id: string;
  ruling: Ruling;
  reason: string;
}

export interface ParsedReview {
  findings: FoundFinding[];
  risks: ReviewRisk[];
  rulings: ParsedRuling[];
}

const RULINGS: Ruling[] = ["accept", "finding", "risk"];
const VERDICTS: Verdict[] = ["confirmed", "duplicate", "ticket_conflict", "rejected"];
const isYes = (value: string | undefined): boolean => /^(yes|true)$/i.test(value ?? "");

function parseRisks(lines: string[] | undefined): ReviewRisk[] {
  const body = (lines ?? []).map(l => l.trim()).filter(l => l !== "");
  if (body.length === 0 || body.join("") === "[]") return [];
  const records = parseRecords(lines, ["file", "risk", "data"]);
  const risks = records.filter(r => r.risk).map(r => ({ file: r.file ?? "", risk: r.risk, data: isYes(r.data) }));
  if (risks.length === 0) throw new Error("Malformed risks list in ---REVIEW--- block");
  return risks;
}

export function parseReviewBlock(output: string): ParsedReview {
  const groups = groupByTopLevelKey(extractBlock(output, REVIEW_START));
  const findings = parseRecords(groups.get("findings"), ["id", "severity", "confidence", "decision", "file", "issue", "suggestion"])
    .filter(r => r.issue)
    .map((r, i): FoundFinding => ({
      id: r.id || `R${i + 1}`,
      severity: SEVERITIES.includes(r.severity as Severity) ? r.severity as Severity : "major",
      confidence: r.confidence === "suspected" ? "suspected" : "proven",
      ...(r.decision ? { decision: r.decision } : {}),
      file: r.file ?? "",
      issue: r.issue,
      suggestion: r.suggestion ?? "",
    }));
  const rulings = parseRecords(groups.get("rulings"), ["id", "ruling", "reason"])
    .filter(r => r.id)
    .map((r): ParsedRuling => ({ id: r.id, ruling: RULINGS.includes(r.ruling as Ruling) ? r.ruling as Ruling : "unruled", reason: r.reason ?? "" }));
  return { findings, risks: parseRisks(groups.get("risks")), rulings };
}

export function parseConfirmBlock(output: string): CandidateVerdict[] {
  return parseRecords(extractBlock(output, CONFIRM_START), ["id", "verdict", "duplicate_of", "severity", "data", "happens", "evidence", "code", "ticket", "change", "note"])
    .filter(r => r.id)
    .map((r): CandidateVerdict => ({
      id: r.id,
      verdict: VERDICTS.includes(r.verdict as Verdict) ? r.verdict as Verdict : "unproven",
      ...(r.duplicate_of ? { duplicateOf: r.duplicate_of } : {}),
      ...(SEVERITIES.includes(r.severity as Severity) ? { severity: r.severity as Severity } : {}),
      ...(r.data ? { data: isYes(r.data) } : {}),
      ...(r.happens ? { happens: !/^(no|false)$/i.test(r.happens) } : {}),
      ...(r.evidence ? { evidence: r.evidence } : {}),
      ...(r.code ? { code: r.code } : {}),
      ...(r.ticket ? { ticket: r.ticket } : {}),
      ...(r.change ? { change: r.change } : {}),
      note: r.note ?? "",
    }));
}

export interface DedupeGroup {
  keep: string;
  same: string[];
}

export function parseDedupeBlock(output: string): DedupeGroup[] {
  return parseRecords(extractBlock(output, DEDUPE_START), ["keep", "same"])
    .filter(r => r.keep)
    .map((r): DedupeGroup => ({ keep: r.keep, same: (r.same ?? "").split(/[\s,[\]]+/).filter(id => id !== "") }))
    .filter(g => g.same.length > 0);
}

export function parseFixesBlock(output: string): FixResolution[] {
  return parseRecords(extractBlock(output, FIXES_START), ["id", "status", "how"])
    .filter(r => r.id)
    .map(r => ({ id: r.id, status: r.status === "fixed" ? "fixed" : "not_fixed", how: r.how ?? "" }));
}

export function parseVerifyBlock(output: string): VerifyResult[] {
  return parseRecords(extractBlock(output, VERIFY_START), ["id", "status", "note"])
    .filter(r => r.id)
    .map(r => ({ id: r.id, status: r.status === "resolved" ? "resolved" : "unresolved", note: r.note ?? "" }));
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
    followups: parseFollowups(groups.get("followups")),
    decisions: parseDecisions(groups.get("decisions")),
  };
}

export interface ClaudeResult {
  success: boolean;
  rawOutput: string;
  report?: AgentReport;
  parseError?: string;
  failure?: string;
  abortReason?: string;
  usage?: RunUsage;
}

export const MAX_TURNS = 80;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT: Effort = "high";
export const REVIEW_MODEL = "claude-opus-5-5";
export const DEDUPE_MODEL = "claude-sonnet-5-5";
const SAFETY_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const USAGE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

export interface ToolProfile {
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
  enforceAllowList?: boolean;
  tools?: string[];
  model?: string;
  effort?: Effort;
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
    "Bash(npm run build)", "Bash(npm run typecheck)", "Bash(npm test)", "Bash(npm test -w *)",
    "Bash(terraform init -backend=false*)", "Bash(terraform validate*)", "Bash(terraform fmt -check*)",
  ],
  disallowedTools: [
    "Edit", "Write", "NotebookEdit",
    "Bash(git * --output*)", "Bash(find * -delete*)", "Bash(find * -exec*)",
    "Bash(npx vitest * -u*)", "Bash(npx vitest * --update*)",
    ...NEVER_PUBLISH,
  ],
  enforceAllowList: true,
  model: REVIEW_MODEL,
};

export const DEDUPE_PROFILE: ToolProfile = {
  permissionMode: "default",
  allowedTools: [],
  disallowedTools: ["Edit", "Write", "NotebookEdit", ...NEVER_PUBLISH],
  enforceAllowList: true,
  tools: [],
  model: DEDUPE_MODEL,
  effort: "low",
};

export const POSTMORTEM_PROFILE: ToolProfile = {
  permissionMode: "default",
  allowedTools: [
    "Read", "Grep", "Glob",
    "Bash(git log *)", "Bash(git diff *)", "Bash(git show *)",
    "Bash(grep *)", "Bash(rg *)", "Bash(ls *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
  ],
  disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash(git * --output*)", ...NEVER_PUBLISH],
  enforceAllowList: true,
};

export function buildClaudeArgs(operatingInstructions: string, profile: ToolProfile = EDIT_PROFILE, addDirs: string[] = []): string[] {
  return [
    "-p",
    "--output-format", "json",
    "--max-turns", String(MAX_TURNS),
    ...(profile.model ? ["--model", profile.model] : []),
    "--effort", profile.effort ?? EFFORT,
    ...(profile.tools ? ["--tools", profile.tools.join(",")] : []),
    "--permission-mode", profile.permissionMode,
    ...(profile.allowedTools.length > 0 ? ["--allowedTools", profile.allowedTools.join(",")] : []),
    "--disallowedTools", profile.disallowedTools.join(","),
    "--append-system-prompt", operatingInstructions,
    ...addDirs.flatMap(dir => ["--add-dir", dir]),
  ];
}

function withEnforcedAllowList(settings: string): string {
  const parsed = JSON.parse(settings);
  return JSON.stringify({ ...parsed, sandbox: { ...parsed.sandbox, autoAllowBashIfSandboxed: false } });
}

export function agentRunArgs(base: string[], settings: string, profile: ToolProfile = EDIT_PROFILE): string[] {
  return profile.enforceAllowList
    ? [...base, "--settings", withEnforcedAllowList(settings), "--strict-mcp-config", "--setting-sources", "project"]
    : [...base, "--settings", settings, "--strict-mcp-config", "--setting-sources", "user"];
}

export interface RunAgentOptions {
  shouldAbort?: () => string | undefined;
  checkIntervalMs?: number;
  env: NodeJS.ProcessEnv;
  settings: string;
  instructions?: string;
}

export interface ClaudeRun {
  stdout: string;
  rawOutput: string;
  failure?: string;
  abortReason?: string;
  usage?: RunUsage;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseRunOutput(stdout: string): { text: string; usage?: RunUsage } {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { text: stdout };
  }
  if (typeof parsed?.result !== "string") return { text: stdout };
  const u = parsed.usage ?? {};
  return {
    text: parsed.result,
    usage: {
      inputTokens: count(u.input_tokens), outputTokens: count(u.output_tokens),
      cacheReadTokens: count(u.cache_read_input_tokens), cacheCreationTokens: count(u.cache_creation_input_tokens),
      costUsd: count(parsed.total_cost_usd), turns: count(parsed.num_turns), durationMs: count(parsed.duration_ms),
      models: Object.keys(parsed.modelUsage ?? {}),
    },
  };
}

export async function execClaude(
  worktreePath: string, prompt: string, systemPrompt: string, profile: ToolProfile, options: RunAgentOptions, addDirs: string[] = [],
): Promise<ClaudeRun> {
  const args = agentRunArgs(buildClaudeArgs(systemPrompt, profile, addDirs), options.settings, profile);
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
  const { text, usage } = parseRunOutput(proc.stdout);
  const rawOutput = [text, proc.stderr, failure ?? ""].filter(Boolean).join("\n");
  return { stdout: text, rawOutput, failure, abortReason: proc.abortReason, usage };
}

export function parseOrError<T>(stdout: string, failure: string | undefined, parse: (output: string) => T): { value?: T; error?: string } {
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
  linearComments: LinearComment[],
  linearUrl: string,
  linearState: string,
  dryRun: boolean,
  options: RunAgentOptions,
): Promise<ClaudeResult> {
  const prompt = buildPrompt({ ticketId, ticketName, context, linearDesc, linearComments, linearUrl, state: linearState });

  if (dryRun) {
    console.log(`  [dry-run] Would run: claude ${buildClaudeArgs("<instructions>").slice(0, -2).join(" ")} (in ${worktreePath})`);
    console.log(`  [dry-run] Prompt:\n${prompt.slice(0, 500)}...`);
    return { success: true, rawOutput: "", report: {
      status: "done", title: "", summary: "dry run", filesCreated: [], filesModified: [],
      tests: [], verifyCommands: [], notes: "dry run – no changes", followups: [], decisions: [],
    }};
  }

  if (options.instructions === undefined) throw new Error("instructions missing");
  const run = await execClaude(worktreePath, prompt, options.instructions, EDIT_PROFILE, options);
  const { value: report, error: parseError } = parseOrError(run.stdout, run.failure, parseReportBlock);
  return { success: run.failure === undefined, rawOutput: run.rawOutput, report, parseError, failure: run.failure, abortReason: run.abortReason, usage: run.usage };
}

export interface ReviewRunResult {
  success: boolean;
  rawOutput: string;
  findings?: FoundFinding[];
  risks?: ReviewRisk[];
  rulings?: ParsedRuling[];
  parseError?: string;
  failure?: string;
  abortReason?: string;
  usage?: RunUsage;
}

const layered = (...files: string[]): string => files.map(f => readFileSync(f, "utf-8")).join(LAYER_SEPARATOR);

export const finderSystemPrompt = (lens: ReviewLens): string => layered(REVIEW_MD, lensMd(lens));
export const confirmSystemPrompt = (): string => layered(REVIEW_MD, CONFIRM_MD);
export const dedupeSystemPrompt = (): string => readFileSync(DEDUPE_MD, "utf-8");

async function execFinder(worktreePath: string, prompt: string, systemPrompt: string, options: RunAgentOptions): Promise<ReviewRunResult> {
  const run = await execClaude(worktreePath, prompt, systemPrompt, REVIEW_PROFILE, options);
  const { value: parsed, error: parseError } = parseOrError(run.stdout, run.failure, parseReviewBlock);
  return { success: run.failure === undefined, rawOutput: run.rawOutput, findings: parsed?.findings, risks: parsed?.risks, rulings: parsed?.rulings, parseError, failure: run.failure, abortReason: run.abortReason, usage: run.usage };
}

export async function runFinder(
  worktreePath: string, lens: ReviewLens, brief: TicketBrief, report: AgentReport | undefined, baseRef: string, options: RunAgentOptions,
  extras: ReviewPromptExtras = {},
): Promise<ReviewRunResult> {
  return execFinder(worktreePath, buildFinderPrompt(lens, brief, report, baseRef, extras), finderSystemPrompt(lens), options);
}

export interface FixRunResult extends ClaudeResult {
  fixes?: FixResolution[];
  fixesError?: string;
}

export async function runFix(
  worktreePath: string, brief: TicketBrief, findings: ReviewFinding[], options: RunAgentOptions,
): Promise<FixRunResult> {
  const prompt = buildFixPrompt(brief, findings);
  if (options.instructions === undefined) throw new Error("instructions missing");
  const systemPrompt = [options.instructions, readFileSync(FIX_MD, "utf-8")].join("\n\n---\n\n");
  const run = await execClaude(worktreePath, prompt, systemPrompt, EDIT_PROFILE, options);
  const parsedReport = parseOrError(run.stdout, run.failure, parseReportBlock);
  const parsedFixes = parseOrError(run.stdout, run.failure, parseFixesBlock);
  return {
    success: run.failure === undefined, rawOutput: run.rawOutput,
    report: parsedReport.value, parseError: parsedReport.error,
    fixes: parsedFixes.value, fixesError: parsedFixes.error,
    failure: run.failure, abortReason: run.abortReason, usage: run.usage,
  };
}

export interface VerifyRunResult {
  success: boolean;
  rawOutput: string;
  results?: VerifyResult[];
  parseError?: string;
  failure?: string;
  abortReason?: string;
  usage?: RunUsage;
}

export async function runVerify(
  worktreePath: string, brief: TicketBrief, baseRef: string, findings: ReviewFinding[], resolutions: FixResolution[], options: RunAgentOptions,
): Promise<VerifyRunResult> {
  const prompt = buildVerifyPrompt(brief, baseRef, findings, resolutions);
  const systemPrompt = layered(REVIEW_MD, VERIFY_MD);
  const run = await execClaude(worktreePath, prompt, systemPrompt, REVIEW_PROFILE, options);
  const { value: results, error: parseError } = parseOrError(run.stdout, run.failure, parseVerifyBlock);
  return { success: run.failure === undefined, rawOutput: run.rawOutput, results, parseError, failure: run.failure, abortReason: run.abortReason, usage: run.usage };
}

export interface ConfirmRunResult {
  success: boolean;
  rawOutput: string;
  verdicts?: CandidateVerdict[];
  parseError?: string;
  failure?: string;
  abortReason?: string;
  usage?: RunUsage;
}

export async function runConfirm(
  worktreePath: string, brief: TicketBrief, report: AgentReport | undefined, baseRef: string, batch: ConfirmBatch, options: RunAgentOptions,
  extras: ReviewPromptExtras = {},
): Promise<ConfirmRunResult> {
  const prompt = buildConfirmPrompt(brief, report, baseRef, batch, extras);
  const run = await execClaude(worktreePath, prompt, confirmSystemPrompt(), REVIEW_PROFILE, options);
  const { value: verdicts, error: parseError } = parseOrError(run.stdout, run.failure, parseConfirmBlock);
  return { success: run.failure === undefined, rawOutput: run.rawOutput, verdicts, parseError, failure: run.failure, abortReason: run.abortReason, usage: run.usage };
}

export interface DedupeRunResult {
  success: boolean;
  rawOutput: string;
  groups?: DedupeGroup[];
  parseError?: string;
  failure?: string;
  abortReason?: string;
  usage?: RunUsage;
}

export async function runDedupe(worktreePath: string, candidates: ReviewCandidate[], options: RunAgentOptions): Promise<DedupeRunResult> {
  const run = await execClaude(worktreePath, buildDedupePrompt(candidates), dedupeSystemPrompt(), DEDUPE_PROFILE, options);
  const { value: groups, error: parseError } = parseOrError(run.stdout, run.failure, parseDedupeBlock);
  return { success: run.failure === undefined, rawOutput: run.rawOutput, groups, parseError, failure: run.failure, abortReason: run.abortReason, usage: run.usage };
}
