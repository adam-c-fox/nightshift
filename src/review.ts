import { deriveOutcome } from "./status.js";
import type { AgentReport, FixRunResult, ReviewRunResult } from "./claude.js";
import type { FixResolution, ReviewFinding, TestResult, TicketReview } from "./types.js";

export interface ReviewDeps {
  hasChanges(): boolean;
  snapshot(): string;
  gateOpen(): boolean;
  review(): Promise<ReviewRunResult>;
  fix(findings: ReviewFinding[]): Promise<FixRunResult>;
  saveOutput(stage: "review" | "fix", raw: string): void;
  log(msg: string): void;
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
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

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

function failedReview(reason: string, publish: boolean, notes: string[]): ReviewStageOutcome {
  return { review: { outcome: "failed", reason, findings: [], resolutions: [] }, publish, needsReview: true, notes };
}

export async function reviewAndFix(publishable: boolean, deps: ReviewDeps): Promise<ReviewStageOutcome> {
  const quiet = (reason: string): ReviewStageOutcome =>
    ({ review: { outcome: "skipped", reason, findings: [], resolutions: [] }, publish: true, needsReview: false, notes: [] });

  if (!publishable) return quiet("implementation did not finish");
  if (!deps.hasChanges()) return quiet("no changes against base");
  if (!deps.gateOpen()) {
    return {
      review: { outcome: "skipped", reason: "budget cap reached", findings: [], resolutions: [] },
      publish: true, needsReview: true, notes: ["Review skipped: budget cap reached."],
    };
  }

  const before = deps.snapshot();
  deps.log("  Reviewing change");
  const run = await deps.review();
  deps.saveOutput("review", run.rawOutput);

  if (deps.snapshot() !== before) {
    const reason = "the review run modified the worktree";
    deps.log(`  Review failed: ${reason}; not publishing`);
    return failedReview(reason, false, [`Review failed: ${reason}; work kept on local branch, not pushed.`]);
  }

  const failure = run.failure ?? run.parseError;
  if (failure || !run.findings) {
    const reason = failure ?? "no findings reported";
    deps.log(`  Review failed: ${reason}`);
    return failedReview(reason, true, [`Review failed: ${reason}`]);
  }

  const findings = run.findings;
  if (findings.length === 0) {
    deps.log("  Review: no issues found");
    return { review: { outcome: "reviewed", findings, resolutions: [] }, publish: true, needsReview: false, notes: [] };
  }
  deps.log(`  Review: ${findings.length} issue(s) found`);

  if (!deps.gateOpen()) {
    return {
      review: { outcome: "reviewed", findings, resolutions: [] },
      ...settle(findings, [], [`Review found ${findings.length} issue(s); fix skipped: budget cap reached.`], true),
    };
  }

  deps.log("  Fixing review findings");
  const fix = await deps.fix(findings);
  deps.saveOutput("fix", fix.rawOutput);
  const agent = deriveOutcome(fix);

  if (!agent.publish) {
    return {
      review: { outcome: "reviewed", findings, resolutions: notFixed(findings, "the fix run did not finish") },
      ...settle(findings, [], [`Review found ${findings.length} issue(s). ${agent.notes.join(" ")}`], true),
    };
  }

  const reported = fix.fixes ?? [];
  const resolutions = findings.map((f): FixResolution =>
    reported.find(r => r.id === f.id) ?? { id: f.id, status: "not_fixed", how: "not reported by the fix run" });
  const fixedCount = resolutions.filter(r => r.status === "fixed").length;
  const notes = [
    `Review found ${findings.length} issue(s); ${fixedCount} fixed.`,
    ...(fix.fixesError ? [`Fix run gave no usable fixes list: ${fix.fixesError}`] : []),
    ...agent.notes,
  ];
  return {
    review: { outcome: "reviewed", findings, resolutions },
    fixReport: fix.report,
    ...settle(findings, resolutions, notes, agent.status === "needs_review"),
  };
}
