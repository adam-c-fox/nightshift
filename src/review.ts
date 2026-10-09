import { deriveOutcome } from "./status.js";
import type { AgentReport, FixRunResult, FoundFinding, ParsedRuling, ReviewRunResult, VerifyRunResult } from "./claude.js";
import type {
  ConfirmStage, Decision, DecisionRuling, Followup, FixResolution, FixVerification, LensRun, ReviewCandidate, ReviewFinding,
  ReviewLens, ReviewRisk, ReviewStage, TestResult, TicketReview,
} from "./types.js";
import { lensLabel, lensStage } from "./types.js";
import { confirmAll, sortVerdicts, type ConfirmDeps } from "./confirm.js";

export interface ReviewDeps extends ConfirmDeps {
  hasChanges(): boolean;
  lenses: ReviewLens[];
  find(lens: ReviewLens, pass: number): Promise<ReviewRunResult>;
  decisions?: Decision[];
  fix(findings: ReviewFinding[]): Promise<FixRunResult>;
  regressions?: ReviewFinding[];
  recheck?(): Promise<ReviewFinding[]>;
  verify?(findings: ReviewFinding[], resolutions: FixResolution[]): Promise<VerifyRunResult>;
  saveOutput(stage: ReviewStage | ConfirmStage | "fix" | "verify", raw: string): void;
}

export interface ReviewStageOutcome {
  review: TicketReview;
  publish: boolean;
  needsReview: boolean;
  notes: string[];
  fixReport?: AgentReport;
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
    decisions: unionBy([...(base.decisions ?? []), ...fix.decisions], d => `${d.file}\0${d.decision}`),
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

interface Verified {
  resolutions: FixResolution[];
  verification?: FixVerification;
  notes: string[];
  needsReview: boolean;
  publish: boolean;
}

async function verifyFixes(findings: ReviewFinding[], resolutions: FixResolution[], deps: ReviewDeps): Promise<Verified> {
  const claimed = findings.filter(f => resolutions.find(r => r.id === f.id)?.status === "fixed");
  const unchanged: Verified = { resolutions, notes: [], needsReview: false, publish: true };
  if (!deps.verify || claimed.length === 0) return unchanged;
  const unverified = (outcome: "skipped" | "failed", reason: string, note: string, needsReview: boolean, publish = true): Verified =>
    ({ ...unchanged, verification: { outcome, reason, results: [] }, notes: [note], needsReview, publish });

  if (!deps.gateOpen()) {
    return unverified("skipped", "budget cap reached", "Fixes unverified: budget cap reached.", claimed.some(f => f.severity !== "minor"));
  }

  const before = deps.snapshot();
  deps.log("  Verifying fixes");
  const run = await deps.verify(findings, resolutions);
  deps.saveOutput("verify", run.rawOutput);
  if (deps.snapshot() !== before) {
    const reason = "the verification run modified the worktree";
    deps.log(`  Verification failed: ${reason}; not publishing`);
    return unverified("failed", reason, `Fix verification failed: ${reason}; work kept on local branch, not pushed.`, true, false);
  }
  const failure = run.failure ?? run.parseError;
  if (failure || !run.results) {
    const reason = failure ?? "no verification reported";
    deps.log(`  Verification failed: ${reason}`);
    return unverified("failed", reason, `Fix verification failed: ${reason}`, true);
  }

  const results = claimed.map(f => run.results!.find(r => r.id === f.id) ?? { id: f.id, status: "unresolved" as const, note: "not verified" });
  const open = results.filter(r => r.status === "unresolved");
  const corrected = resolutions.map((r): FixResolution => {
    const result = open.find(o => o.id === r.id);
    return result ? { ...r, status: "not_fixed", how: `${r.how}; still open: ${result.note}` } : r;
  });
  const notes = open.length > 0 ? [`Fix verification: ${open.length} claimed fix(es) still open (${open.map(o => o.id).join(", ")}).`] : [];
  return { resolutions: corrected, verification: { outcome: "verified", results }, notes, needsReview: false, publish: true };
}

function failedReview(reason: string, publish: boolean, notes: string[], regressions: ReviewFinding[] = []): ReviewStageOutcome {
  const unchecked = regressions.length > 0 ? [`Unreviewed check regressions: ${regressionNames(regressions)}.`] : [];
  return { review: { outcome: "failed", reason, findings: [], resolutions: [] }, publish, needsReview: true, notes: [...notes, ...unchecked] };
}

const regressionNames = (findings: ReviewFinding[]): string =>
  findings.map(f => f.issue.split(" fails after the change")[0]).join(", ");

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

const LENS_PREFIX: Record<ReviewLens, string> = { bugs: "B", spec: "S", reuse: "U" };

const pendingFinding = (lens: ReviewLens, f: FoundFinding): Pending => ({
  lens, kind: "finding", severity: f.severity, confidence: f.confidence ?? "proven",
  file: f.file, issue: f.issue, suggestion: f.suggestion, data: false, ...(f.decision ? { decision: f.decision } : {}),
});

const pendingRisk = (lens: ReviewLens, r: ReviewRisk): Pending => ({
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

const withIds = (lenses: ReviewLens[], pending: Pending[]): ReviewCandidate[] =>
  lenses.flatMap(lens => pending.filter(p => p.lens === lens).map((p, i): ReviewCandidate => ({ id: `${LENS_PREFIX[lens]}${i + 1}`, ...p })));

const dataRiskNotes = (risks: ReviewRisk[]): string[] => {
  const files = [...new Set(risks.filter(r => r.data).map(r => r.file))];
  return files.length > 0 ? [`Unconfirmed risk to recorded data: ${files.join(", ")}`] : [];
};

const lensNotes = (runs: LensRun[]): string[] =>
  runs.filter(r => r.outcome !== "reviewed").map(r => `Review lens ${lensLabel(r.lens, r.pass)} ${r.outcome}: ${r.reason}.`);

const allLensesFailedReason = (runs: LensRun[]): string =>
  runs.length === 1 ? runs[0].reason! : runs.map(r => `${lensLabel(r.lens, r.pass)}: ${r.reason}`).join("; ");

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

  const conflictNotes = conflicts.length > 0 ? [`Ticket conflicts to decide: ${[...new Set(conflicts.map(c => c.file))].join(", ")}.`] : [];
  const dataNotes = dataRiskNotes(risks);
  return {
    findings: [...regressions, ...findings],
    risks,
    record: { lenses, candidates: recorded, ...(confirmation ? { confirmation } : {}), ...decisions, ...(conflicts.length > 0 ? { conflicts } : {}) },
    notes: [...notes, ...conflictNotes, ...dataNotes],
    needsReview: notes.length > 0 || conflictNotes.length > 0 || dataNotes.length > 0,
  };
}

export async function reviewAndFix(publishable: boolean, deps: ReviewDeps): Promise<ReviewStageOutcome> {
  const quiet = (reason: string): ReviewStageOutcome =>
    ({ review: { outcome: "skipped", reason, findings: [], resolutions: [] }, publish: true, needsReview: false, notes: [] });

  const regressions = deps.regressions ?? [];
  if (!publishable) return quiet("implementation did not finish");
  if (!deps.hasChanges()) return quiet("no changes against base");
  if (!deps.gateOpen()) {
    return {
      review: { outcome: "skipped", reason: "budget cap reached", findings: [], resolutions: [] },
      publish: true, needsReview: true,
      notes: ["Review skipped: budget cap reached.", ...(regressions.length > 0 ? [`Check regressions: ${regressionNames(regressions)}.`] : [])],
    };
  }

  const found = await findAndConfirm(deps);
  if (found.stopped) return found.stopped;
  const { findings, risks, record } = found;

  if (findings.length === 0) {
    deps.log("  Review: no issues found");
    return { review: { outcome: "reviewed", findings, resolutions: [], risks, ...record }, publish: true, needsReview: found.needsReview, notes: found.notes };
  }
  deps.log(`  Review: ${findings.length} issue(s) found`);

  if (!deps.gateOpen()) {
    return {
      review: { outcome: "reviewed", findings, resolutions: [], risks, ...record },
      ...settle(findings, [], [...found.notes, `Review found ${findings.length} issue(s); fix skipped: budget cap reached.`], true),
    };
  }

  deps.log("  Fixing review findings");
  const fix = await deps.fix(findings);
  deps.saveOutput("fix", fix.rawOutput);
  const agent = deriveOutcome(fix);

  if (!agent.publish) {
    return {
      review: { outcome: "reviewed", findings, resolutions: notFixed(findings, "the fix run did not finish"), risks, ...record },
      ...settle(findings, [], [...found.notes, `Review found ${findings.length} issue(s). ${agent.notes.join(" ")}`], true),
    };
  }

  const reported = fix.fixes ?? [];
  const resolutions = findings.map((f): FixResolution =>
    reported.find(r => r.id === f.id) ?? { id: f.id, status: "not_fixed", how: "not reported by the fix run" });
  const fixedCount = resolutions.filter(r => r.status === "fixed").length;
  const remaining = deps.recheck ? await deps.recheck() : [];
  const stillFailing = remaining.length > 0 ? [`Checks still failing after the fix: ${regressionNames(remaining)}.`] : [];
  const verified = await verifyFixes(findings, resolutions, deps);
  const notes = [
    ...found.notes,
    `Review found ${findings.length} issue(s); ${fixedCount} fixed.`,
    ...(fix.fixesError ? [`Fix run gave no usable fixes list: ${fix.fixesError}`] : []),
    ...agent.notes,
    ...stillFailing,
    ...verified.notes,
  ];
  const settled = settle(findings, verified.resolutions, notes, found.needsReview || agent.status === "needs_review" || remaining.length > 0 || verified.needsReview);
  return {
    review: { outcome: "reviewed", findings, resolutions: verified.resolutions, risks, ...record, ...(verified.verification && { verification: verified.verification }) },
    fixReport: fix.report,
    ...settled,
    publish: settled.publish && verified.publish,
  };
}
