import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractFlag } from "./args.js";
import { agentEnv, buildAgentSettings, CLAUDE_TOKEN } from "./agent-env.js";
import type { ClassifiedCheck } from "./checks.js";
import { parseReportBlock, runConfirm, runFinder, type AgentReport, type ReviewPromptExtras, type TicketBrief } from "./claude.js";
import { getEnv, useProjectEnv } from "./env.js";
import { composeInstructions, GENERIC_AGENTS_MD } from "./instructions.js";
import { fetchTicket } from "./linear.js";
import { parseGolden, scoreSummary, scoreTicket, type TicketScore } from "./golden.js";
import { loadProject, projectEnvFiles, PROJECTS_DIR } from "./project.js";
import { findAndConfirm, type FindAndConfirmResult } from "./review.js";
import { TICKET_ID } from "./tickets.js";
import { localDate } from "./time.js";
import { REVIEW_LENSES, lensLabel, lensStage, type CheckRecord, type RunRecord, type RunUsage, type TicketReview, type TicketResult } from "./types.js";
import { git, installDependencies, npmCi, worktreeSnapshot, type Worktree } from "./worktree.js";

const ROOT = path.resolve(import.meta.dirname, "..");

export interface ReplayArgs {
  project: string;
  ticket: string;
  base: string;
  diff: string;
  report: string;
  related: { ticketId: string; branch: string }[];
  session?: string;
  install: boolean;
}

export const REPLAY_USAGE =
  "usage: replay-review --project <name> --ticket <ID> --base <sha> --diff <file> --report <agent output file> [--related ID=branch ...] [--session <session.json>] [--no-install]";

function extractAll(argv: string[], flag: string): { values: string[]; rest: string[] } {
  const values: string[] = [];
  let rest = argv;
  for (let next = extractFlag(rest, flag); next.value !== undefined; next = extractFlag(rest, flag)) {
    values.push(next.value);
    rest = next.rest;
  }
  return { values, rest };
}

function parseRelated(value: string): ReplayArgs["related"][number] {
  const [ticketId, ...branch] = value.split("=");
  if (!ticketId || !TICKET_ID.test(ticketId) || branch.join("=") === "") throw new Error(`--related expects ID=branch, got "${value}"`);
  return { ticketId, branch: branch.join("=") };
}

export function parseReplayArgs(argv: string[]): ReplayArgs {
  const required = ["--project", "--ticket", "--base", "--diff", "--report"].reduce<{ values: Record<string, string>; rest: string[] }>(
    (acc, flag) => {
      const { value, rest } = extractFlag(acc.rest, flag);
      if (value === undefined) throw new Error(`${flag} is required\n${REPLAY_USAGE}`);
      return { values: { ...acc.values, [flag]: value }, rest };
    },
    { values: {}, rest: argv },
  );
  const { values: related, rest: afterRelated } = extractAll(required.rest, "--related");
  const { value: session, rest: afterSession } = extractFlag(afterRelated, "--session");
  const rest = afterSession.filter(a => a !== "--no-install");
  const install = rest.length === afterSession.length;
  if (rest.length > 0) throw new Error(`unknown argument "${rest[0]}"\n${REPLAY_USAGE}`);
  const { "--project": project, "--ticket": ticket, "--base": base, "--diff": diff, "--report": report } = required.values;
  if (!TICKET_ID.test(ticket!)) throw new Error(`expected a ticket ID like ENG-123\n${REPLAY_USAGE}`);
  return { project: project!, ticket: ticket!, base: base!, diff: diff!, report: report!, related: related.map(parseRelated), install, ...(session !== undefined ? { session } : {}) };
}

const tokensIn = (u: RunUsage): number => u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
const count = new Intl.NumberFormat("en-US");
const usageLine = (inTokens: number, outTokens: number, cost: number): string =>
  `${count.format(inTokens)} in / ${count.format(outTokens)} out, $${cost.toFixed(2)}`;

export function replaySummary(found: FindAndConfirmResult, runs: RunRecord[], score?: TicketScore): string {
  const text = summaryText(found, runs);
  return score ? `${text}\n\n${scoreSummary(score)}` : text;
}

function summaryText(found: FindAndConfirmResult, runs: RunRecord[]): string {
  const measured = runs.flatMap(r => (r.usage ? [r.usage] : []));
  const usage = [
    "Usage:",
    ...runs.map(r => `  ${r.stage}: ${r.usage ? usageLine(tokensIn(r.usage), r.usage.outputTokens, r.usage.costUsd) : "no usage recorded"}`),
    `  total: ${usageLine(measured.reduce((n, u) => n + tokensIn(u), 0), measured.reduce((n, u) => n + u.outputTokens, 0), measured.reduce((n, u) => n + u.costUsd, 0))}`,
  ];
  if (found.stopped) return [`Review stopped: ${found.stopped.review.reason ?? "no reason recorded"}`, ...usage].join("\n");

  const { findings, risks, record } = found;
  return [
    "Lenses:",
    ...(record.lenses ?? []).map(l => `  ${lensLabel(l.lens, l.pass)} ${l.outcome}${l.reason ? `: ${l.reason}` : ` (${l.candidates} candidates)`}`),
    findings.length > 0 ? "Confirmed findings:" : "Confirmed findings: none",
    ...findings.map(f => `  ${f.id}${f.from ? ` (from ${f.from})` : ""} ${f.severity} ${f.file}: ${f.issue}`),
    risks.length > 0 ? "Risks:" : "Risks: none",
    ...risks.map(r => `  ${r.file}${r.data ? " [data]" : ""}: ${r.risk}`),
    ...(record.decisions?.length ? ["Rulings:", ...record.decisions.map(d => `  ${d.id} ${d.ruling}: ${d.reason}`)] : []),
    ...usage,
  ].join("\n");
}

export function briefFromSession(session: unknown, ticketId: string): { brief: TicketBrief; checks: ClassifiedCheck[] } {
  const tickets = (session as { tickets?: TicketResult[] } | null)?.tickets;
  const t = Array.isArray(tickets) ? tickets.find(x => x.ticket.id === ticketId) : undefined;
  if (!t) throw new Error(`ticket ${ticketId} is not in the session`);
  const brief: TicketBrief = {
    ticketId, ticketName: t.linear?.name ?? t.ticket.name ?? "", context: t.ticket.context ?? [], linearDesc: t.linear?.description ?? "",
    linearComments: t.linear?.comments ?? [], linearUrl: t.linear?.url ?? "", state: t.linear?.state ?? "",
  };
  const checks = (t.checks ?? []).map((c: CheckRecord): ClassifiedCheck => ({
    name: c.name, command: c.command, passed: c.passed, durationSec: c.durationSec, outputTail: "", status: c.status ?? (c.passed ? "passed" : "pre-existing"),
  }));
  return { brief, checks };
}

export function prepareScratch(repoPath: string, scratch: string, base: string, diff: string): void {
  git(["worktree", "add", "--detach", scratch, base], repoPath);
  git(["apply", diff], scratch);
}

const npmBuild = (wtPath: string): void => {
  execFileSync("npm", ["run", "build"], { cwd: wtPath, stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });
};

export function buildIfScripted(wtPath: string, log: (msg: string) => void, run: (wtPath: string) => void = npmBuild): boolean {
  const pkg = JSON.parse(readFileSync(path.join(wtPath, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
  if (!pkg.scripts?.build) return false;
  try {
    run(wtPath);
    return true;
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? (e as Error).message);
    log(`Build failed in the replay worktree; finders may not run tests: ${stderr.split("\n")[0]}`);
    return false;
  }
}

export function replayLogDir(logsRoot: string, date: string, exists: (dir: string) => boolean): string {
  const first = path.join(logsRoot, `replay-${date}`);
  if (!exists(first)) return first;
  for (let n = 2; ; n++) {
    const dir = `${first}-${n}`;
    if (!exists(dir)) return dir;
  }
}

export const goldenPath = (projectName: string, ticket: string, projectsDir = PROJECTS_DIR): string =>
  path.join(projectsDir, projectName, "golden", `${ticket}.json`);

export interface ReplayMeta {
  installed: boolean;
  pipeline: { commit: string; dirty: boolean };
  startedAt: string;
  endedAt: string;
}

export interface ReplayRecord {
  version: 1;
  ticket: { id: string };
  review: TicketReview;
  runs: RunRecord[];
  replay: { base: string; diff: string; report: string; related: ReplayArgs["related"]; session?: string } & ReplayMeta;
}

export function replayRecord(args: ReplayArgs, found: FindAndConfirmResult, runs: RunRecord[], meta: ReplayMeta): ReplayRecord {
  const review: TicketReview = found.stopped
    ? found.stopped.review
    : { outcome: "reviewed", findings: found.findings, resolutions: [], risks: found.risks, ...found.record };
  return {
    version: 1,
    ticket: { id: args.ticket },
    review,
    runs,
    replay: {
      base: args.base, diff: path.resolve(args.diff), report: path.resolve(args.report), related: args.related,
      ...(args.session !== undefined ? { session: path.resolve(args.session) } : {}), ...meta,
    },
  };
}

function prepareReplayWorktree(args: ReplayArgs, repoPath: string, toolchain: string, scratch: string): boolean {
  prepareScratch(repoPath, scratch, args.base, path.resolve(args.diff));
  const installed = args.install && toolchain === "node";
  if (installed) {
    installDependencies(scratch, npmCi, console.log);
    buildIfScripted(scratch, console.log);
  }
  return installed;
}

interface ReviewInputs {
  brief: TicketBrief;
  extras: ReviewPromptExtras;
  report: AgentReport;
  options: Parameters<typeof runFinder>[5];
  logDir: string;
}

async function runReview(args: ReplayArgs, scratch: string, inputs: ReviewInputs): Promise<{ found: FindAndConfirmResult; runs: RunRecord[] }> {
  const { brief, extras, report, options, logDir } = inputs;
  const wt: Worktree = { wtPath: scratch, branch: "", baseRef: args.base, baseBranch: "", startedFromPr: false };
  const runs: RunRecord[] = [];
  const record = <T extends { usage?: RunUsage }>(stage: string, run: T): T => {
    runs.push({ stage, usage: run.usage });
    return run;
  };
  const found = await findAndConfirm({
    hasChanges: () => true,
    snapshot: () => worktreeSnapshot(wt),
    gateOpen: () => true,
    lenses: REVIEW_LENSES,
    decisions: report.decisions,
    find: async (lens, pass) => record(lensStage(lens, pass), await runFinder(scratch, lens, brief, report, args.base, options, extras)),
    confirm: async candidates => record("review-confirm", await runConfirm(scratch, brief, args.base, candidates, options)),
    fix: () => Promise.reject(new Error("replay does not fix")),
    saveOutput: (stage, raw) => writeFileSync(path.join(logDir, `${args.ticket}-${stage}.txt`), raw, "utf-8"),
    log: console.log,
  });
  return { found, runs };
}

function writeOutputs(args: ReplayArgs, projectName: string, logDir: string, found: FindAndConfirmResult, runs: RunRecord[], meta: ReplayMeta): void {
  const record = replayRecord(args, found, runs, meta);
  writeFileSync(path.join(logDir, "replay.json"), `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  const golden = goldenPath(projectName, args.ticket);
  let score: TicketScore | undefined;
  if (existsSync(golden)) {
    score = scoreTicket(parseGolden(JSON.parse(readFileSync(golden, "utf-8"))), record.review, runs);
    writeFileSync(path.join(logDir, "score.json"), `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  }
  console.log(`\n${replaySummary(found, runs, score)}\nLogs: ${logDir}`);
}

async function replay(args: ReplayArgs): Promise<FindAndConfirmResult> {
  const project = loadProject(args.project);
  useProjectEnv(project.envFile);
  const claudeToken = getEnv(CLAUDE_TOKEN);
  if (claudeToken) process.env[CLAUDE_TOKEN] = claudeToken;
  const { path: repoPath, toolchain } = project.repos[project.defaultRepo];

  let from: { brief: TicketBrief; checks?: ClassifiedCheck[] };
  if (args.session) from = briefFromSession(JSON.parse(readFileSync(args.session, "utf-8")), args.ticket);
  else {
    const linear = await fetchTicket(args.ticket);
    if (!linear) throw new Error(`ticket ${args.ticket} not found in Linear`);
    from = {
      brief: {
        ticketId: args.ticket, ticketName: linear.name, context: [], linearDesc: linear.description,
        linearComments: linear.comments, linearUrl: linear.url, state: linear.state,
      },
    };
  }
  const report = parseReportBlock(readFileSync(args.report, "utf-8"));

  const logDir = replayLogDir(path.join(ROOT, "logs", project.name), localDate(), existsSync);
  mkdirSync(logDir, { recursive: true });
  const options = {
    env: agentEnv(process.env),
    settings: buildAgentSettings(toolchain, ROOT, { secretFiles: projectEnvFiles() }),
    instructions: composeInstructions(readFileSync(GENERIC_AGENTS_MD, "utf-8"), project.name, project.instructions),
  };
  const extras: ReviewPromptExtras = from.checks ? { related: args.related, checks: from.checks } : { related: args.related };

  const scratch = mkdtempSync(path.join(tmpdir(), "replay-review-"));
  try {
    const installed = prepareReplayWorktree(args, repoPath, toolchain, scratch);
    const startedAt = new Date().toISOString();
    const { found, runs } = await runReview(args, scratch, { brief: from.brief, extras, report, options, logDir });
    const meta = {
      installed,
      pipeline: { commit: git(["rev-parse", "HEAD"], ROOT).trim(), dirty: git(["status", "--porcelain", "--untracked-files=no"], ROOT).trim() !== "" },
      startedAt, endedAt: new Date().toISOString(),
    };
    writeOutputs(args, project.name, logDir, found, runs, meta);
    return found;
  } finally {
    if (existsSync(path.join(scratch, ".git"))) git(["worktree", "remove", "--force", scratch], repoPath);
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  try {
    await replay(parseReplayArgs(process.argv.slice(2)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
