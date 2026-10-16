import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractFlag } from "./args.js";
import { agentEnv, buildAgentSettings, CLAUDE_TOKEN } from "./agent-env.js";
import { parseFixesBlock, parseReportBlock, runConfirm, runDedupe, runFixReview, type TicketBrief } from "./claude.js";
import { readCited, ticketText } from "./confirm.js";
import { getEnv, useProjectEnv } from "./env.js";
import { composeInstructions, GENERIC_AGENTS_MD } from "./instructions.js";
import { fetchTicket } from "./linear.js";
import { loadProject, projectEnvFiles } from "./project.js";
import { addedDecisions, captureChange, confirmFixReview, reviewFixerChange, type FixReviewStep, type ReviewDeps } from "./review.js";
import { TICKET_ID } from "./tickets.js";
import { localDate } from "./time.js";
import type { Confirmation, Decision, FixResolution, RecordedCandidate, ReviewFinding, ReviewRisk, RunRecord, RunUsage, SessionResult, TicketConflict } from "./types.js";
import { git, treeDiff, worktreeSnapshot, worktreeTree, type Worktree } from "./worktree.js";

const ROOT = path.resolve(import.meta.dirname, "..");

export interface ReplayFixArgs {
  project: string;
  ticket: string;
  base: string;
  preDiff: string;
  diff: string;
  report: string;
  fix: string;
  session: string;
}

export const REPLAY_FIX_USAGE =
  "usage: replay-fix-review --project <name> --ticket <ID> --base <sha> --pre-diff <file> --diff <file> --report <agent output file> --fix <fix output file> --session <session json>";

const FLAGS: [string, keyof ReplayFixArgs][] = [
  ["--project", "project"], ["--ticket", "ticket"], ["--base", "base"], ["--pre-diff", "preDiff"], ["--diff", "diff"],
  ["--report", "report"], ["--fix", "fix"], ["--session", "session"],
];

export function parseReplayFixArgs(argv: string[]): ReplayFixArgs {
  const parsed = FLAGS.reduce<{ values: Partial<ReplayFixArgs>; rest: string[] }>(
    (acc, [flag, key]) => {
      const { value, rest } = extractFlag(acc.rest, flag);
      if (value === undefined) throw new Error(`${flag} is required\n${REPLAY_FIX_USAGE}`);
      return { values: { ...acc.values, [key]: value }, rest };
    },
    { values: {}, rest: argv },
  );
  if (parsed.rest.length > 0) throw new Error(`unknown argument "${parsed.rest[0]}"\n${REPLAY_FIX_USAGE}`);
  const args = parsed.values as ReplayFixArgs;
  if (!TICKET_ID.test(args.ticket)) throw new Error(`expected a ticket ID like ENG-123\n${REPLAY_FIX_USAGE}`);
  return args;
}

export interface ReplayFixResult {
  step: FixReviewStep;
  candidates: RecordedCandidate[];
  confirmation?: Confirmation;
  stopped?: string;
  confirmed: ReviewFinding[];
  risks: ReviewRisk[];
  conflicts: TicketConflict[];
}

const tokensIn = (u: RunUsage): number => u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
const count = new Intl.NumberFormat("en-US");
const usageLine = (inTokens: number, outTokens: number, cost: number): string =>
  `${count.format(inTokens)} in / ${count.format(outTokens)} out, $${cost.toFixed(2)}`;

const conflictLine = (c: TicketConflict): string =>
  `  ${c.from} ticket conflict ${c.file}: ${c.ticket ? `asks for "${c.ticket}"${c.quoted ? "" : " (not found verbatim in the ticket)"}` : "no ticket line quoted"}, ${c.consequence}`;

export function replayFixSummary({ step, candidates, confirmation, stopped, confirmed, risks, conflicts }: ReplayFixResult, runs: RunRecord[]): string {
  const measured = runs.flatMap(r => (r.usage ? [r.usage] : []));
  const { run } = step;
  return [
    `Fix review: ${run.outcome}${run.reason ? `: ${run.reason}` : ` (${run.files} files, ${run.candidates} candidates)`}`,
    ...(step.verification?.results ?? []).map(r => `  ${r.id} ${r.status}: ${r.note}`),
    candidates.length > 0 ? "Fixer candidates:" : "Fixer candidates: none",
    ...candidates.map(c => {
      return `  ${c.id} [${c.severity} ${c.kind}] ${c.file} ${c.issue}${c.verdict ? ` -> ${c.verdict.verdict}: ${c.verdict.note}` : ""}`;
    }),
    ...(stopped ? [`Fix confirm stopped: ${stopped}`] : []),
    ...(confirmation && confirmation.outcome !== "confirmed" ? [`Fix confirm ${confirmation.outcome}${confirmation.reason ? `: ${confirmation.reason}` : ""}`] : []),
    confirmed.length > 0 ? "Confirmed findings:" : "Confirmed findings: none",
    ...confirmed.map(f => `  ${f.id}${f.from ? ` (from ${f.from})` : ""} ${f.severity} ${f.file}: ${f.issue}`),
    risks.length > 0 ? "Risks:" : "Risks: none",
    ...risks.map(r => `  ${r.file}${r.data ? " [data]" : ""}: ${r.risk}`),
    conflicts.length > 0 ? "Ticket conflicts:" : "Ticket conflicts: none",
    ...conflicts.map(conflictLine),
    "Usage:",
    ...runs.map(r => `  ${r.stage}: ${r.usage ? usageLine(tokensIn(r.usage), r.usage.outputTokens, r.usage.costUsd) : "no usage recorded"}`),
    `  total: ${usageLine(measured.reduce((n, u) => n + tokensIn(u), 0), measured.reduce((n, u) => n + u.outputTokens, 0), measured.reduce((n, u) => n + u.costUsd, 0))}`,
  ].join("\n");
}

export const roundOneFindings = (findings: ReviewFinding[], reported: FixResolution[], fixLog: string): ReviewFinding[] => {
  const given = findings.filter(f => reported.some(r => r.id === f.id));
  if (given.length === 0) throw new Error(`${fixLog} reports no fixes for the findings in the session`);
  return given;
};

async function replay(args: ReplayFixArgs): Promise<ReplayFixResult> {
  const project = loadProject(args.project);
  useProjectEnv(project.envFile);
  const claudeToken = getEnv(CLAUDE_TOKEN);
  if (claudeToken) process.env[CLAUDE_TOKEN] = claudeToken;
  const { path: repoPath, toolchain } = project.repos[project.defaultRepo];

  const linear = await fetchTicket(args.ticket);
  if (!linear) throw new Error(`ticket ${args.ticket} not found in Linear`);
  const brief: TicketBrief = {
    ticketId: args.ticket, ticketName: linear.name, context: [], linearDesc: linear.description,
    linearComments: linear.comments, linearUrl: linear.url, state: linear.state,
  };
  const session: SessionResult = JSON.parse(readFileSync(args.session, "utf-8"));
  const sessionFindings = session.tickets.find(t => t.ticket.id === args.ticket)?.review?.findings;
  if (!sessionFindings) throw new Error(`no review findings for ${args.ticket} in ${args.session}`);
  const fixText = readFileSync(args.fix, "utf-8");
  const reported = parseFixesBlock(fixText);
  const findings = roundOneFindings(sessionFindings, reported, args.fix);
  const resolutions = findings.flatMap(f => reported.filter(r => r.id === f.id).slice(0, 1));
  const implementerReport = parseReportBlock(readFileSync(args.report, "utf-8"));
  const added = addedDecisions(parseReportBlock(fixText), implementerReport.decisions);
  const preDiff = path.resolve(args.preDiff);
  const diff = path.resolve(args.diff);

  const logDir = path.join(ROOT, "logs", project.name, `replay-fix-${localDate()}`);
  mkdirSync(logDir, { recursive: true });
  const options = {
    env: agentEnv(process.env),
    settings: buildAgentSettings(toolchain, ROOT, { secretFiles: projectEnvFiles() }),
    instructions: composeInstructions(readFileSync(GENERIC_AGENTS_MD, "utf-8"), project.name, project.instructions),
  };

  const scratch = mkdtempSync(path.join(tmpdir(), "replay-fix-review-"));
  const wt: Worktree = { wtPath: scratch, branch: "", baseRef: args.base, baseBranch: "", startedFromPr: false };
  const runs: RunRecord[] = [];
  const record = <T extends { usage?: RunUsage }>(stage: string, run: T): T => {
    runs.push({ stage, usage: run.usage });
    return run;
  };
  let worktreeAdded = false;
  try {
    git(["worktree", "add", "--detach", scratch, args.base], repoPath);
    worktreeAdded = true;
    git(["apply", preDiff], scratch);
    const from = worktreeTree(wt);
    git(["apply", "-R", preDiff], scratch);
    git(["apply", diff], scratch);

    const deps: ReviewDeps = {
      hasChanges: () => true,
      snapshot: () => worktreeSnapshot(wt),
      gateOpen: () => true,
      lenses: [],
      find: () => Promise.reject(new Error("replay does not find")),
      source: file => readCited(scratch, file),
      ticketText: ticketText(brief),
      dedupe: async (candidates, stage = "fix-review-dedupe") => record(stage, await runDedupe(scratch, candidates, options)),
      confirm: async (batch, stage = `fix-review-confirm-${batch.n}`) => record(stage, await runConfirm(scratch, brief, implementerReport, args.base, batch, options)),
      fix: () => Promise.reject(new Error("replay does not fix")),
      saveOutput: (stage, raw) => writeFileSync(path.join(logDir, `${args.ticket}-${stage}.txt`), raw, "utf-8"),
      log: console.log,
    };
    const fixReview = {
      capture: () => worktreeTree(wt),
      diff: (a: string, b: string) => ({ files: treeDiff(wt, a, b, ["--name-status"]), patch: treeDiff(wt, a, b) }),
      run: async (round: number, scope: Parameters<typeof runFixReview>[3], fs: ReviewFinding[], rs: FixResolution[], ds: Decision[]) =>
        record("fix-review", await runFixReview(scratch, brief, args.base, scope, fs, rs, ds, options)),
    };
    const change = captureChange(fixReview, from, 1, deps);
    const step = await reviewFixerChange(1, change, findings, resolutions, added, deps, fixReview);
    const confirm = step.pending.length > 0 ? await confirmFixReview(1, step.pending, [], findings, deps) : undefined;
    const result: ReplayFixResult = confirm?.stopped !== undefined
      ? { step, candidates: confirm.candidates, confirmed: [], risks: [], conflicts: [], stopped: confirm.stopped }
      : { step, candidates: confirm?.candidates ?? [], confirmed: confirm?.findings ?? [], risks: confirm?.risks ?? [], conflicts: confirm?.conflicts ?? [], ...(confirm ? { confirmation: confirm.confirmation } : {}) };
    console.log(`\n${replayFixSummary(result, runs)}\nLogs: ${logDir}`);
    return result;
  } finally {
    if (worktreeAdded) git(["worktree", "remove", "--force", scratch], repoPath);
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  try {
    await replay(parseReplayFixArgs(process.argv.slice(2)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
