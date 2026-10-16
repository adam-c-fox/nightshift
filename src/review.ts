import { deriveOutcome } from "./status.js";
import type { AgentReport, FixReviewRunResult, FixRunResult, FixScope, FoundFinding, ParsedRuling, ReviewRunResult } from "./claude.js";
import type {
  CandidateLens, Confirmation, ConfirmStage, Decision, DecisionRuling, Followup, FixResolution, FixReviewRun, FixVerification, LensRun, RecordedCandidate, ReviewCandidate,
  ReviewFinding, ReviewLens, ReviewRisk, ReviewStage, TestResult, TicketConflict, TicketReview, VerifyResult,
} from "./types.js";
import { lensLabel, lensStage, roundStage } from "./types.js";
import { confirmAll, sortVerdicts, type ConfirmDeps } from "./confirm.js";

export type FixStage = "fix" | "fix-diff" | "fix-review" | `${"fix" | "fix-diff" | "fix-review"}-${number}`;

export interface FixReviewDeps {
  capture(): string;
  diff(from: string, to: string): { files: string; patch: string };
  run(round: number, scope: FixScope, findings: ReviewFinding[], resolutions: FixResolution[], added: Decision[]): Promise<FixReviewRunResult>;
}

export interface ReviewDeps extends ConfirmDeps {
  hasChanges(): boolean;
  lenses: ReviewLens[];
  find(lens: ReviewLens, pass: number): Promise<ReviewRunResult>;
  decisions?: Decision[];
  fix(findings: ReviewFinding[], round: number): Promise<FixRunResult>;
  regressions?: ReviewFinding[];
  recheck?(): Promise<ReviewFinding[]>;
  fixReview?: FixReviewDeps;
  saveOutput(stage: ReviewStage | ConfirmStage | FixStage, raw: string): void;
}

export interface ReviewStageOutcome {
  review: TicketReview;
  publish: boolean;
  needsReview: boolean;
  notes: string[];
  fixReports: AgentReport[];
}

interface Refinable {
  title: string;
  summary: string;
  filesCreated: string[];
  filesModified: string[];
  tests: TestResult[];
  followups: Followup[];
  decisions?: Decision[];
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

const unionBy = <T>(items: T[], key: (item: T) => string): T[] => {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
};

export function mergeFixReport(base: Refinable, fix: AgentReport): Refinable {
  const refined = new Map(fix.tests.map(t => [t.name, t]));
  const replaced = base.tests.map(t => refined.get(t.name) ?? t);
  const added = fix.tests.filter(t => !base.tests.some(b => b.name === t.name));
  return {
    title: fix.title || base.title,
    summary: fix.summary || base.summary,
    filesCreated: union(base.filesCreated, fix.filesCreated),
    filesModified: union(base.filesModified, fix.filesModified),
    tests: [...replaced, ...added],
    followups: unionBy([...base.followups, ...fix.followups], f => `${f.file}\0${f.note}`),
    decisions: unionBy([...(base.decisions ?? []), ...fix.decisions], decisionKey),
  };
}

const unresolved = (findings: ReviewFinding[], resolutions: FixResolution[]): ReviewFinding[] =>
  findings.filter(f => resolutions.find(r => r.id === f.id)?.status !== "fixed");

const notFixed = (findings: ReviewFinding[], how: string): FixResolution[] =>
  findings.map(f => ({ id: f.id, status: "not_fixed", how }));

function settle(
  findings: ReviewFinding[], resolutions: FixResolution[], notes: string[], extraNeedsReview = false,
): Pick<ReviewStageOutcome, "publish" | "needsReview" | "notes"> {
  const open = unresolved(findings, resolutions);
  const blocking = open.some(f => f.severity === "blocker");
  const major = open.some(f => f.severity === "major");
  return { publish: !blocking, needsReview: extraNeedsReview || blocking || major, notes };
}

function failedReview(reason: string, publish: boolean, notes: string[], regressions: ReviewFinding[] = []): ReviewStageOutcome {
  const unchecked = regressions.length > 0 ? [`Unreviewed check regressions: ${regressionNames(regressions)}.`] : [];
  return { review: { outcome: "failed", reason, findings: [], resolutions: [] }, fixReports: [], publish, needsReview: true, notes: [...notes, ...unchecked] };
}

const regressionNames = (findings: ReviewFinding[]): string => findings.map(regressionCommand).join(", ");

type Pending = Omit<ReviewCandidate, "id">;
type ReviewRecord = Pick<TicketReview, "lenses" | "candidates" | "confirmation" | "decisions" | "conflicts">;

export interface FoundReview {
  stopped?: undefined;
  findings: ReviewFinding[];
  risks: ReviewRisk[];
  record: ReviewRecord;
  notes: string[];
  needsReview: boolean;
}

export type FindAndConfirmResult = FoundReview | { stopped: ReviewStageOutcome };

const LENS_PREFIX: Record<CandidateLens, string> = { bugs: "B", spec: "S", reuse: "U", fixer: "F" };

const pendingFinding = (lens: CandidateLens, f: FoundFinding): Pending => ({
  lens, kind: "finding", severity: f.severity, confidence: f.confidence ?? "proven",
  file: f.file, issue: f.issue, suggestion: f.suggestion, data: false, ...(f.decision ? { decision: f.decision } : {}),
});

const pendingRisk = (lens: CandidateLens, r: ReviewRisk): Pending => ({
  lens, kind: "risk", severity: "major", confidence: "suspected", file: r.file, issue: r.risk, suggestion: "", data: r.data ?? false,
});

const riskCandidate = (file: string, text: string): Pending =>
  pendingRisk("bugs", { file, risk: text });

interface LensStep {
  run: LensRun;
  pending: Pending[];
  rulings: ParsedRuling[];
}

const lensStep = (lens: ReviewLens, pass: number, outcome: LensRun["outcome"], reason?: string, pending: Pending[] = [], rulings: ParsedRuling[] = []): LensStep =>
  ({ run: { lens, ...(pass > 1 ? { pass } : {}), outcome, ...(reason ? { reason } : {}), candidates: pending.length }, pending, rulings });

async function runLens(lens: ReviewLens, pass: number, deps: ReviewDeps, regressions: ReviewFinding[]): Promise<LensStep | { stopped: ReviewStageOutcome }> {
  const label = lensLabel(lens, pass);
  if (!deps.gateOpen()) return lensStep(lens, pass, "skipped", "budget cap reached");

  const before = deps.snapshot();
  deps.log(`  Reviewing change (${pass > 1 ? `${lens}, pass ${pass}` : lens})`);
  const run = await deps.find(lens, pass);
  deps.saveOutput(lensStage(lens, pass), run.rawOutput);

  if (deps.snapshot() !== before) {
    const reason = `the ${label} review run modified the worktree`;
    deps.log(`  Review failed: ${reason}; not publishing`);
    return { stopped: failedReview(reason, false, [`Review failed: ${reason}; work kept on local branch, not pushed.`], regressions) };
  }

  const failure = run.failure ?? run.parseError;
  if (failure || !run.findings) {
    const reason = failure ?? "no findings reported";
    deps.log(`  Review (${label}) failed: ${reason}`);
    return lensStep(lens, pass, "failed", reason);
  }
  const pending = [...run.findings.map(f => pendingFinding(lens, f)), ...(run.risks ?? []).map(r => pendingRisk(lens, r))];
  return lensStep(lens, pass, "reviewed", undefined, pending, run.rulings ?? []);
}

interface Ruled {
  rulings: DecisionRuling[];
  risks: Pending[];
  notes: string[];
}

const RULING_STRICTNESS: ParsedRuling["ruling"][] = ["accept", "risk", "finding"];

const strictest = (rulings: ParsedRuling[]): ParsedRuling | undefined =>
  rulings.reduce<ParsedRuling | undefined>((top, r) => !top || RULING_STRICTNESS.indexOf(r.ruling) > RULING_STRICTNESS.indexOf(top.ruling) ? r : top, undefined);

function ruleOnDecisions(decisions: Decision[], parsed: ParsedRuling[], pending: Pending[]): Ruled {
  const listed = decisions.map((d, i) => ({ ...d, id: `D${i + 1}` }));
  const unlistedIds = [...new Set(parsed.map(p => p.id).filter(id => !listed.some(d => d.id === id)))];
  const entries = [
    ...listed.map(d => ({ decision: d, parsed: strictest(parsed.filter(p => p.id === d.id)) })),
    ...unlistedIds.map(id => ({ decision: { id, file: "", decision: "(taken from the notes)" }, parsed: strictest(parsed.filter(p => p.id === id)) })),
  ];
  const ruled: Ruled = { rulings: [], risks: [], notes: [] };
  for (const { decision, parsed: ruling } of entries) {
    const record = (kind: DecisionRuling["ruling"], reason: string) =>
      ruled.rulings.push({ id: decision.id, decision: decision.decision, file: decision.file, ruling: kind, reason });
    if (ruling?.ruling === "accept") record("accept", ruling.reason);
    else if (ruling?.ruling === "risk") {
      record("risk", ruling.reason);
      ruled.risks.push(riskCandidate(decision.file, ruling.reason));
    } else if (ruling?.ruling === "finding" && pending.some(p => p.kind === "finding" && p.decision === decision.id)) {
      record("finding", ruling.reason);
    } else if (ruling?.ruling === "finding") {
      record("risk", ruling.reason);
      ruled.risks.push(riskCandidate(decision.file, ruling.reason));
    } else {
      record("unruled", "not ruled on");
      ruled.risks.push(riskCandidate(decision.file, decision.decision));
      ruled.notes.push(`Decision ${decision.id} not ruled on`);
    }
  }
  return ruled;
}

const withIds = (lenses: CandidateLens[], pending: Pending[]): ReviewCandidate[] =>
  lenses.flatMap(lens => pending.filter(p => p.lens === lens).map((p, i): ReviewCandidate => ({ id: `${LENS_PREFIX[lens]}${i + 1}`, ...p })));

const dataRiskNotes = (risks: ReviewRisk[]): string[] => {
  const files = [...new Set(risks.filter(r => r.data).map(r => r.file))];
  return files.length > 0 ? [`Unconfirmed risk to recorded data: ${files.join(", ")}`] : [];
};

const lensNotes = (runs: LensRun[]): string[] =>
  runs.filter(r => r.outcome !== "reviewed").map(r => `Review lens ${lensLabel(r.lens, r.pass)} ${r.outcome}: ${r.reason}.`);

const allLensesFailedReason = (runs: LensRun[]): string =>
  runs.length === 1 ? runs[0].reason! : runs.map(r => `${lensLabel(r.lens, r.pass)}: ${r.reason}`).join("; ");

const conflictNotes = (conflicts: TicketConflict[]): string[] =>
  conflicts.length > 0 ? [`Ticket conflicts to decide: ${[...new Set(conflicts.map(c => c.file))].join(", ")}.`] : [];

const withRecord = (outcome: ReviewStageOutcome, record: ReviewRecord): ReviewStageOutcome =>
  ({ ...outcome, review: { ...outcome.review, ...record } });

export async function findAndConfirm(deps: ReviewDeps): Promise<FindAndConfirmResult> {
  const regressions = deps.regressions ?? [];
  const steps: LensStep[] = [];
  for (const [i, lens] of deps.lenses.entries()) {
    const pass = deps.lenses.slice(0, i + 1).filter(l => l === lens).length;
    const step = await runLens(lens, pass, deps, regressions);
    if ("stopped" in step) return step;
    steps.push(step);
  }
  const lenses = steps.map(s => s.run);
  if (!lenses.some(r => r.outcome === "reviewed")) {
    const reason = allLensesFailedReason(lenses);
    deps.log(`  Review failed: ${reason}`);
    return { stopped: withRecord(failedReview(reason, true, [`Review failed: ${reason}`], regressions), { lenses }) };
  }

  const found = steps.flatMap(s => s.pending);
  const ruled = ruleOnDecisions(deps.decisions ?? [], steps.flatMap(s => s.rulings), found);
  const candidates = withIds([...new Set([...deps.lenses, ...[...found, ...ruled.risks].map(p => p.lens)])], [...found, ...ruled.risks]);
  const notes = [...lensNotes(lenses), ...ruled.notes];
  const decisions = ruled.rulings.length > 0 ? { decisions: ruled.rulings } : {};

  let recorded: ReviewCandidate[] = candidates;
  let confirmation: TicketReview["confirmation"];
  if (candidates.length > 0) {
    const step = await confirmAll(candidates, deps);
    if ("stopped" in step) {
      deps.log(`  Review failed: ${step.stopped}; not publishing`);
      const outcome = failedReview(step.stopped, false, [`Review failed: ${step.stopped}; work kept on local branch, not pushed.`], regressions);
      return { stopped: withRecord(outcome, { lenses, candidates, ...decisions }) };
    }
    recorded = step.candidates;
    confirmation = step.confirmation;
    notes.push(...step.notes);
  }
  const { findings, risks, conflicts } = sortVerdicts(recorded);

  const conflictNote = conflictNotes(conflicts);
  const dataNotes = dataRiskNotes(risks);
  return {
    findings: [...regressions, ...findings],
    risks,
    record: { lenses, candidates: recorded, ...(confirmation ? { confirmation } : {}), ...decisions, ...(conflicts.length > 0 ? { conflicts } : {}) },
    notes: [...notes, ...conflictNote, ...dataNotes],
    needsReview: notes.length > 0 || conflictNote.length > 0 || dataNotes.length > 0,
  };
}

const MAX_FIX_ROUNDS = 2;

const decisionKey = (d: Decision): string => `${d.file}\0${d.decision}`;

const regressionCommand = (f: ReviewFinding): string => f.issue.split(" fails after the change")[0];

export const highestId = (prefix: string, items: { id: string }[]): number =>
  Math.max(0, ...items.filter(i => i.id.startsWith(prefix)).map(i => Number(i.id.slice(prefix.length)) || 0));

export const fixerCandidates = (pending: Pending[], after: number): ReviewCandidate[] =>
  pending.map((p, i) => ({ id: `${LENS_PREFIX.fixer}${after + i + 1}`, ...p }));

export const addedDecisions = (report: AgentReport | undefined, known: Decision[]): Decision[] => {
  const keys = new Set(known.map(decisionKey));
  return (report?.decisions ?? []).filter(d => !keys.has(decisionKey(d)));
};

type FixConfirmation = { stopped: string; candidates: ReviewCandidate[] } | {
  stopped?: undefined; candidates: RecordedCandidate[]; confirmation: Confirmation; notes: string[];
  findings: ReviewFinding[]; risks: ReviewRisk[]; conflicts: TicketConflict[];
};

export async function confirmFixReview(
  round: number, pending: Pending[], existing: ReviewCandidate[], findings: ReviewFinding[], deps: ReviewDeps,
): Promise<FixConfirmation> {
  const candidates = fixerCandidates(pending, highestId(LENS_PREFIX.fixer, existing));
  const step = await confirmAll(candidates, deps, roundStage("fix-review", round));
  if ("stopped" in step) return { stopped: step.stopped, candidates };
  return { ...step, ...sortVerdicts(step.candidates, highestId("R", findings) + 1) };
}

const fixReviewRun = (round: number, outcome: FixReviewRun["outcome"], files: number, candidates = 0, reason?: string): FixReviewRun =>
  ({ round, outcome, ...(reason ? { reason } : {}), files, candidates });

export interface FixerChange {
  from: string;
  to: string;
  files: string;
  count: number;
}

export function captureChange(fixReview: FixReviewDeps, from: string, round: number, deps: ReviewDeps): FixerChange {
  const to = fixReview.capture();
  const { files, patch } = fixReview.diff(from, to);
  deps.saveOutput(roundStage("fix-diff", round), patch);
  return { from, to, files, count: files.split("\n").filter(line => line.trim()).length };
}

export interface FixReviewStep {
  resolutions: FixResolution[];
  verification?: FixVerification;
  reopened: VerifyResult[];
  pending: Pending[];
  notes: string[];
  needsReview: boolean;
  publish: boolean;
  stop: boolean;
  run: FixReviewRun;
}

export async function reviewFixerChange(
  round: number, change: FixerChange, toFix: ReviewFinding[], resolutions: FixResolution[], added: Decision[], deps: ReviewDeps, fixReview: FixReviewDeps,
): Promise<FixReviewStep> {
  const claimed = toFix.filter(f => resolutions.find(r => r.id === f.id)?.status === "fixed");
  const step = (over: Partial<FixReviewStep> & Pick<FixReviewStep, "run">): FixReviewStep =>
    ({ resolutions, reopened: [], pending: [], notes: [], needsReview: false, publish: true, stop: false, ...over });
  const record = (outcome: FixReviewRun["outcome"], reason?: string) => fixReviewRun(round, outcome, change.count, 0, reason);
  const unverified = (outcome: "skipped" | "failed", reason: string): Pick<FixReviewStep, "verification"> =>
    claimed.length > 0 ? { verification: { outcome, reason, results: [] } } : {};

  if (change.from === change.to && claimed.length === 0) return step({ run: record("skipped", "the fixer changed nothing") });
  if (!deps.gateOpen()) {
    return step({
      ...unverified("skipped", "budget cap reached"),
      notes: ["Fixer's changes unreviewed and fixes unverified: budget cap reached."],
      needsReview: claimed.some(f => f.severity !== "minor"),
      run: record("skipped", "budget cap reached"),
    });
  }

  const before = deps.snapshot();
  deps.log(`  Reviewing the fixer's changes${round > 1 ? `, round ${round}` : ""}`);
  const run = await fixReview.run(round, { from: change.from, to: change.to, files: change.files }, toFix, resolutions, added);
  deps.saveOutput(roundStage("fix-review", round), run.rawOutput);
  if (deps.snapshot() !== before) {
    const reason = "the fix review run modified the worktree";
    deps.log(`  Fix review failed: ${reason}; not publishing`);
    return step({
      ...unverified("failed", reason), notes: [`Fix review failed: ${reason}; work kept on local branch, not pushed.`],
      needsReview: true, publish: false, stop: true, run: record("failed", reason),
    });
  }
  const given = run.results;
  const failure = run.failure ?? run.parseError;
  if (failure || !given) {
    const reason = failure ?? "no fix review reported";
    deps.log(`  Fix review failed: ${reason}`);
    return step({ ...unverified("failed", reason), notes: [`Fix review failed: ${reason}`], needsReview: true, run: record("failed", reason) });
  }

  const results = claimed.map((f): VerifyResult => given.find(r => r.id === f.id) ?? { id: f.id, status: "unresolved", note: "not verified" });
  const open = results.filter(r => r.status === "unresolved");
  const pending = [...(run.findings ?? []).map(f => pendingFinding("fixer", f)), ...(run.risks ?? []).map(r => pendingRisk("fixer", r))];
  return step({
    resolutions: resolutions.map((r): FixResolution => {
      const result = open.find(o => o.id === r.id);
      return result ? { ...r, status: "not_fixed", how: `${r.how}; still open: ${result.note}` } : r;
    }),
    ...(claimed.length > 0 ? { verification: { outcome: "verified" as const, results } } : {}),
    reopened: open,
    pending,
    run: fixReviewRun(round, "reviewed", change.count, pending.length),
  });
}

interface RoundContext {
  deps: ReviewDeps;
  findings: ReviewFinding[];
  candidates: ReviewCandidate[];
  known: Decision[];
}

interface RoundOutcome {
  resolutions: FixResolution[];
  verification?: FixVerification;
  reopened: VerifyResult[];
  confirmed: ReviewFinding[];
  candidates: RecordedCandidate[];
  risks: ReviewRisk[];
  conflicts: TicketConflict[];
  remaining?: ReviewFinding[];
  notes: string[];
  needsReview: boolean;
  publish: boolean;
  stop: boolean;
  report?: AgentReport;
  run?: FixReviewRun;
}

async function fixRound(round: number, toFix: ReviewFinding[], ctx: RoundContext): Promise<RoundOutcome> {
  const { deps } = ctx;
  const fixReview = deps.fixReview;
  const from = fixReview?.capture();
  deps.log(round > 1 ? `  Fixing review findings (round ${round})` : "  Fixing review findings");
  const fix = await deps.fix(toFix, round);
  deps.saveOutput(roundStage("fix", round), fix.rawOutput);
  const agent = deriveOutcome(fix);
  const change = fixReview && from !== undefined ? captureChange(fixReview, from, round, deps) : undefined;
  const outcome: RoundOutcome = { resolutions: [], reopened: [], confirmed: [], candidates: [], risks: [], conflicts: [], notes: [], needsReview: false, publish: true, stop: false };

  const remaining = deps.recheck ? await deps.recheck() : [];

  if (!agent.publish) {
    const notes = agent.notes.join(" ");
    return {
      ...outcome, resolutions: notFixed(toFix, "the fix run did not finish"), remaining, notes: [round > 1 ? notes : `Review found ${toFix.length} issue(s). ${notes}`],
      needsReview: true, stop: true, ...(change ? { run: fixReviewRun(round, "skipped", change.count, 0, "the fix run did not finish") } : {}),
    };
  }

  const reported = fix.fixes ?? [];
  const resolutions = toFix.map((f): FixResolution =>
    reported.find(r => r.id === f.id) ?? { id: f.id, status: "not_fixed", how: "not reported by the fix run" });
  const fixedCount = resolutions.filter(r => r.status === "fixed").length;
  const added = addedDecisions(fix.report, ctx.known);
  const reviewed = fixReview && change ? await reviewFixerChange(round, change, toFix, resolutions, added, deps, fixReview) : undefined;
  const notes = [
    round > 1 ? `Second fix round: ${fixedCount} of ${toFix.length} issue(s) fixed.` : `Review found ${toFix.length} issue(s); ${fixedCount} fixed.`,
    ...(fix.fixesError ? [`Fix run gave no usable fixes list: ${fix.fixesError}`] : []),
    ...agent.notes,
    ...(reviewed?.notes ?? []),
  ];
  const settled: RoundOutcome = {
    ...outcome, resolutions: reviewed?.resolutions ?? resolutions, remaining, notes,
    needsReview: agent.status === "needs_review" || (reviewed?.needsReview ?? false),
    publish: reviewed?.publish ?? true, stop: reviewed?.stop ?? false,
    ...(fix.report ? { report: fix.report } : {}),
    ...(reviewed?.verification ? { verification: reviewed.verification } : {}),
    ...(reviewed ? { reopened: reviewed.reopened, run: reviewed.run } : {}),
  };
  if (!reviewed || reviewed.stop || reviewed.pending.length === 0) return settled;
  const step = await confirmFixReview(round, reviewed.pending, ctx.candidates, ctx.findings, deps);
  if (step.stopped !== undefined) {
    deps.log(`  Fix review failed: ${step.stopped}; not publishing`);
    return {
      ...settled, candidates: step.candidates, notes: [...notes, `Fix review failed: ${step.stopped}; work kept on local branch, not pushed.`], needsReview: true, publish: false, stop: true,
      run: { ...reviewed.run, confirmation: { outcome: "failed", reason: step.stopped } },
    };
  }
  const { findings, risks, conflicts } = step;
  const label = round > 1 ? `Fix review (round ${round})` : "Fix review";
  const confirmNotes = step.notes.map(n => `${label}: ${n}`);
  return {
    ...settled, confirmed: findings, candidates: step.candidates, risks, conflicts,
    notes: [...notes, ...confirmNotes, ...conflictNotes(conflicts)],
    needsReview: settled.needsReview || confirmNotes.length > 0 || conflicts.length > 0,
    run: { ...reviewed.run, confirmation: step.confirmation },
  };
}

const mergeResolutions = (earlier: FixResolution[], later: FixResolution[]): FixResolution[] => {
  const replaced = earlier.map(r => later.find(l => l.id === r.id) ?? r);
  return [...replaced, ...later.filter(l => !earlier.some(r => r.id === l.id))];
};

const mergeVerification = (rounds: RoundOutcome[]): FixVerification | undefined => {
  const given = rounds.flatMap(r => r.verification ? [r.verification] : []);
  if (given.length === 0) return undefined;
  const results = new Map<string, VerifyResult>();
  for (const r of rounds) {
    const reported = r.verification?.results ?? [];
    r.resolutions.filter(x => !reported.some(g => g.id === x.id)).forEach(x => results.delete(x.id));
    reported.forEach(x => results.set(x.id, x));
  }
  const failed = given.find(v => v.outcome !== "verified");
  return { outcome: failed?.outcome ?? "verified", ...(failed?.reason ? { reason: failed.reason } : {}), results: [...results.values()] };
};

function secondRoundSet(first: RoundOutcome, sent: ReviewFinding[], findings: ReviewFinding[]): { toFix: ReviewFinding[]; findings: ReviewFinding[] } {
  let all = findings;
  const regressions = (first.remaining ?? []).map((r): ReviewFinding => {
    const existing = all.find(f => f.id.startsWith("C") && regressionCommand(f) === regressionCommand(r));
    if (existing) return { ...r, id: existing.id };
    const added = { ...r, id: `C${highestId("C", all) + 1}` };
    all = [...all, added];
    return added;
  });
  const reopened = first.reopened.flatMap(o => sent.filter(f => f.id === o.id).map(f => ({ ...f, issue: `${f.issue} Still open after the last fix: ${o.note}` })));
  return { toFix: unionBy([...first.confirmed, ...reopened, ...regressions], f => f.id), findings: all };
}

function holdBackRegressions(findings: ReviewFinding[], resolutions: FixResolution[], remaining: ReviewFinding[]): { findings: ReviewFinding[]; resolutions: FixResolution[] } {
  const failing = new Set(remaining.map(regressionCommand));
  const heldIds = new Set(findings.filter(f => f.id.startsWith("C") && failing.has(regressionCommand(f))).map(f => f.id));
  const text = "still failing after the last fix round";
  const held = resolutions.map((r): FixResolution => heldIds.has(r.id) ? { ...r, status: "not_fixed", how: r.how ? `${r.how}; ${text}` : text } : r);
  const missing = [...heldIds].filter(id => !held.some(r => r.id === id)).map((id): FixResolution => ({ id, status: "not_fixed", how: text }));
  let all = findings;
  for (const r of remaining) {
    if (!all.some(f => f.id.startsWith("C") && regressionCommand(f) === regressionCommand(r))) all = [...all, { ...r, id: `C${highestId("C", all) + 1}` }];
  }
  return { findings: all, resolutions: [...held, ...missing] };
}

async function fixRounds(found: FoundReview, deps: ReviewDeps): Promise<ReviewStageOutcome> {
  let findings = [...found.findings];
  let toFix = findings;
  let resolutions: FixResolution[] = [];
  let candidates: RecordedCandidate[] = [...(found.record.candidates ?? [])];
  let known = deps.decisions ?? [];
  let remaining: ReviewFinding[] = [];
  let secondRoundSkipped = false;
  const rounds: RoundOutcome[] = [];

  for (let round = 1; round <= MAX_FIX_ROUNDS && toFix.length > 0; round++) {
    if (round > 1 && !deps.gateOpen()) {
      secondRoundSkipped = true;
      break;
    }
    const outcome = await fixRound(round, toFix, { deps, findings, candidates, known });
    rounds.push(outcome);
    resolutions = mergeResolutions(resolutions, outcome.resolutions);
    candidates = [...candidates, ...outcome.candidates];
    known = [...known, ...(outcome.report?.decisions ?? [])];
    findings = [...findings, ...outcome.confirmed];
    remaining = outcome.remaining ?? remaining;
    if (outcome.stop) break;
    if (round === 1) {
      const next = secondRoundSet(outcome, toFix, findings);
      findings = next.findings;
      toFix = next.toFix;
    }
  }

  const stillFailing = holdBackRegressions(findings, resolutions, remaining);
  findings = stillFailing.findings;
  resolutions = stillFailing.resolutions;

  const [first, second] = rounds;
  const fixerRisks = rounds.flatMap(r => r.risks);
  const fixerConflicts = rounds.flatMap(r => r.conflicts);
  const conflicts = [...(found.record.conflicts ?? []), ...fixerConflicts];
  const dataNotes = dataRiskNotes(fixerRisks);
  const verification = mergeVerification(rounds);
  const stillOpen = (verification?.results ?? []).filter(r => r.status === "unresolved");
  const sentAgain = first?.confirmed.filter(f => resolutions.find(r => r.id === f.id)?.status === "fixed").length ?? 0;
  const notes = [
    ...found.notes,
    ...(first?.notes ?? []),
    ...(second && first.confirmed.length > 0 ? [`Fix review found ${first.confirmed.length} new issue(s) in the fixer's changes; ${sentAgain} fixed in a second round.`] : []),
    ...(second?.notes ?? []),
    ...(second && second.confirmed.length > 0 ? [`Fix review (round 2) found ${second.confirmed.length} new issue(s); not fixed, no further rounds.`] : []),
    ...(stillOpen.length > 0 ? [`Fix review: ${stillOpen.length} claimed fix(es) still open (${stillOpen.map(o => o.id).join(", ")}).`] : []),
    ...dataNotes,
    ...(secondRoundSkipped ? ["Second fix round skipped: budget cap reached."] : []),
    ...(remaining.length > 0 ? [`Checks still failing after the fix: ${regressionNames(remaining)}.`] : []),
  ];
  const settled = settle(findings, resolutions, notes, found.needsReview || secondRoundSkipped || dataNotes.length > 0 || remaining.length > 0 || rounds.some(r => r.needsReview));
  const fixReviews = rounds.flatMap(r => r.run ? [r.run] : []);
  return {
    review: {
      outcome: "reviewed", findings, resolutions, risks: [...found.risks, ...fixerRisks], ...found.record,
      ...(conflicts.length > 0 ? { conflicts } : {}),
      ...(candidates.length > 0 ? { candidates } : {}),
      ...(verification ? { verification } : {}),
      ...(fixReviews.length > 0 ? { fixReviews } : {}),
    },
    fixReports: rounds.flatMap(r => r.report ? [r.report] : []),
    ...settled,
    publish: settled.publish && rounds.every(r => r.publish),
  };
}

export async function reviewAndFix(publishable: boolean, deps: ReviewDeps): Promise<ReviewStageOutcome> {
  const quiet = (reason: string): ReviewStageOutcome =>
    ({ review: { outcome: "skipped", reason, findings: [], resolutions: [] }, fixReports: [], publish: true, needsReview: false, notes: [] });

  const regressions = deps.regressions ?? [];
  if (!publishable) return quiet("implementation did not finish");
  if (!deps.hasChanges()) return quiet("no changes against base");
  if (!deps.gateOpen()) {
    return {
      review: { outcome: "skipped", reason: "budget cap reached", findings: [], resolutions: [] }, fixReports: [],
      publish: true, needsReview: true,
      notes: ["Review skipped: budget cap reached.", ...(regressions.length > 0 ? [`Check regressions: ${regressionNames(regressions)}.`] : [])],
    };
  }

  const found = await findAndConfirm(deps);
  if (found.stopped) return found.stopped;
  const { findings, risks, record } = found;

  if (findings.length === 0) {
    deps.log("  Review: no issues found");
    return { review: { outcome: "reviewed", findings, resolutions: [], risks, ...record }, fixReports: [], publish: true, needsReview: found.needsReview, notes: found.notes };
  }
  deps.log(`  Review: ${findings.length} issue(s) found`);

  if (!deps.gateOpen()) {
    return {
      review: { outcome: "reviewed", findings, resolutions: [], risks, ...record }, fixReports: [],
      ...settle(findings, [], [...found.notes, `Review found ${findings.length} issue(s); fix skipped: budget cap reached.`], true),
    };
  }

  return fixRounds(found, deps);
}
