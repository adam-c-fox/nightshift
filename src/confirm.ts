import { readFileSync } from "node:fs";
import path from "node:path";
import type { ConfirmRunResult, DedupeGroup, DedupeRunResult, TicketBrief } from "./claude.js";
import type {
  CandidateVerdict, Citation, ConfirmBatch, ConfirmBatchRun, ConfirmStage, Confirmation, RecordedCandidate, ReviewCandidate, ReviewFinding, ReviewRisk,
  Severity, TicketConflict,
} from "./types.js";

export const CONFIRM_BATCH = 4;
export const NOT_COVERED_NOTE = "not covered by the confirm step";

export interface ConfirmDeps {
  snapshot(): string;
  gateOpen(): boolean;
  confirm(batch: ConfirmBatch): Promise<ConfirmRunResult>;
  dedupe?(candidates: ReviewCandidate[]): Promise<DedupeRunResult>;
  source(file: string): string | undefined;
  ticketText: string;
  saveOutput(stage: ConfirmStage, raw: string): void;
  log(msg: string): void;
}

export interface Group {
  keep: ReviewCandidate;
  same: ReviewCandidate[];
}

export type ConfirmOutcome =
  | { candidates: RecordedCandidate[]; confirmation: Confirmation; notes: string[] }
  | { stopped: string };

export function groupCandidates(candidates: ReviewCandidate[], groups: DedupeGroup[]): Group[] {
  const byId = new Map(candidates.map(c => [c.id, c]));
  const used = new Set<string>();
  const members = new Map<string, ReviewCandidate[]>();
  for (const g of groups) {
    if (!byId.has(g.keep) || used.has(g.keep)) continue;
    const same = [...new Set(g.same)].filter(id => byId.has(id) && id !== g.keep && !used.has(id));
    if (same.length === 0) continue;
    used.add(g.keep);
    same.forEach(id => used.add(id));
    members.set(g.keep, same.map(id => byId.get(id)!));
  }
  const memberIds = new Set([...members.values()].flat().map(c => c.id));
  return candidates.filter(c => !memberIds.has(c.id)).map(c => ({ keep: c, same: members.get(c.id) ?? [] }));
}

export function batchGroups(groups: Group[], size = CONFIRM_BATCH): ConfirmBatch[] {
  const files = [...new Set(groups.map(g => g.keep.file))];
  const ordered = groups.map((g, i) => ({ g, i })).sort((a, b) => files.indexOf(a.g.keep.file) - files.indexOf(b.g.keep.file) || a.i - b.i).map(x => x.g);
  const batches: ConfirmBatch[] = [];
  for (let i = 0; i < ordered.length; i += size) {
    const chunk = ordered.slice(i, i + size);
    batches.push({
      n: batches.length + 1,
      candidates: chunk.flatMap(g => [g.keep, ...g.same]),
      groupedWith: Object.fromEntries(chunk.flatMap(g => g.same.map(m => [m.id, g.keep.id]))),
    });
  }
  return batches;
}

export function readCited(root: string, file: string): string | undefined {
  if (path.isAbsolute(file)) return undefined;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, file);
  if (!resolved.startsWith(resolvedRoot + path.sep)) return undefined;
  try {
    return readFileSync(resolved, "utf-8");
  } catch {
    return undefined;
  }
}

const unescapeQuotes = (s: string): string => s.replace(/\\(["'`\\])/g, "$1");

const squash = (s: string): string => unescapeQuotes(s).replace(/\s+/g, " ").trim();

export function citationHolds(evidence: string | undefined, code: string | undefined, source: (file: string) => string | undefined): Citation {
  if (!evidence?.trim() || !code?.trim()) return "missing";
  const cleaned = squash(code).replace(/^`+|`+$/g, "").trim();
  if (cleaned.replace(/\s/g, "").length < 8) return "missing";
  const match = /^([^\s:]+):(\d+)(?:-(\d+))?$/.exec(evidence.trim().replace(/^[`'"]+|[`'"]+$/g, ""));
  if (!match) return "unreadable";
  const text = source(match[1]);
  if (text === undefined) return "unreadable";
  const lines = text.split(/\r?\n/);
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  if (start < 1 || end < start || end > lines.length) return "unreadable";
  const window = squash(lines.slice(Math.max(0, start - 3), Math.min(lines.length, end + 2)).join(" "));
  return window.includes(cleaned) ? "holds" : "mismatch";
}

export const ticketText = (brief: TicketBrief): string =>
  [brief.linearDesc, ...brief.linearComments.map(c => c.body), ...brief.context].join("\n");

const normaliseTicket = (s: string): string =>
  unescapeQuotes(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .split("\n").map(l => l.replace(/^\s*(?:[-+*]|\d+\.)\s+/, "")).join(" ")
    .replace(/[*_`>#]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

export function ticketQuoted(quote: string | undefined, text: string): boolean {
  if (!quote) return false;
  const needle = normaliseTicket(quote).replace(/^"+|"+$/g, "").trim();
  return needle.length >= 12 && normaliseTicket(text).includes(needle);
}

type Source = (file: string) => string | undefined;

const unproven = (c: ReviewCandidate, v: CandidateVerdict, from: CandidateVerdict["verdict"], citation?: Citation): CandidateVerdict =>
  ({ ...v, verdict: "unproven", data: v.data ?? c.data, ...(citation ? { citation } : {}), adjusted: { from } });

const checked = (c: ReviewCandidate, v: CandidateVerdict, source: Source, ticket: string): CandidateVerdict => {
  if (v.verdict === "confirmed") return { ...v, citation: citationHolds(v.evidence, v.code, source) };
  if (v.verdict === "rejected") {
    const citation = citationHolds(v.evidence, v.code, source);
    if (v.happens !== false) {
      return ticketQuoted(v.ticket, ticket)
        ? { ...v, verdict: "ticket_conflict", data: v.data ?? c.data, quoted: true, citation, adjusted: { from: "rejected" } }
        : unproven(c, v, "rejected", citation);
    }
    return citation === "holds" ? { ...v, citation } : unproven(c, v, "rejected", citation);
  }
  if (v.verdict === "ticket_conflict") {
    return { ...v, quoted: ticketQuoted(v.ticket, ticket), ...(v.evidence ? { citation: citationHolds(v.evidence, v.code, source) } : {}) };
  }
  return v;
};

const KEPT: CandidateVerdict["verdict"][] = ["confirmed", "ticket_conflict", "unproven"];

export function judgeBatch(batch: ConfirmBatch, verdicts: CandidateVerdict[], source: Source, ticket: string): RecordedCandidate[] {
  const evidenced = batch.candidates.map((c): RecordedCandidate => {
    const v = verdicts.find(x => x.id === c.id);
    return { ...c, verdict: v ? checked(c, v, source, ticket) : { id: c.id, verdict: "unproven", note: NOT_COVERED_NOTE } };
  });
  const byId = new Map(evidenced.map(c => [c.id, c]));
  const kept = (c: RecordedCandidate, seen: Set<string>): boolean => {
    const v = c.verdict!;
    if (v.verdict !== "duplicate") return KEPT.includes(v.verdict);
    const next = v.duplicateOf ? byId.get(v.duplicateOf) : undefined;
    if (!next || seen.has(next.id)) return false;
    return kept(next, new Set([...seen, next.id]));
  };
  return evidenced.map(c =>
    c.verdict!.verdict === "duplicate" && !kept(c, new Set([c.id])) ? { ...c, verdict: unproven(c, c.verdict!, "duplicate") } : c);
}

const toFinding = (c: ReviewCandidate, n: number, severity: Severity, evidence?: string): ReviewFinding =>
  ({ id: `R${n}`, severity, file: c.file, issue: c.issue, suggestion: c.suggestion, from: c.id, ...(evidence ? { evidence } : {}) });

const toRisk = (c: ReviewCandidate, data: boolean = c.data): ReviewRisk => ({ file: c.file, risk: c.issue, data });

export function sortVerdicts(candidates: RecordedCandidate[], firstFinding = 1): { findings: ReviewFinding[]; risks: ReviewRisk[]; conflicts: TicketConflict[] } {
  const findings: ReviewFinding[] = [];
  const risks: ReviewRisk[] = [];
  const conflicts: TicketConflict[] = [];
  const addFinding = (c: ReviewCandidate, severity: Severity, evidence?: string) =>
    findings.push(toFinding(c, firstFinding + findings.length, severity, evidence));
  for (const c of candidates) {
    const v = c.verdict;
    if (!v) {
      if (c.kind === "finding") addFinding(c, c.severity);
      else risks.push(toRisk(c));
    } else if (v.verdict === "confirmed") addFinding(c, v.severity ?? c.severity, v.citation === "holds" ? v.evidence : undefined);
    else if (v.verdict === "unproven") risks.push(toRisk(c, v.data ?? c.data));
    else if (v.verdict === "ticket_conflict") {
      conflicts.push({
        from: c.id, file: c.file, ticket: v.ticket ?? "", quoted: v.quoted ?? false, consequence: v.adjusted ? c.issue : v.note || c.issue,
        change: v.change || "no change suggested", data: v.data ?? c.data,
        ...(v.citation === "holds" && v.evidence ? { evidence: v.evidence } : {}),
      });
    }
  }
  return { findings, risks, conflicts };
}

const BUDGET = "budget cap reached";

export async function confirmAll(candidates: ReviewCandidate[], deps: ConfirmDeps): Promise<ConfirmOutcome> {
  if (!deps.gateOpen()) {
    return { candidates, confirmation: { outcome: "skipped", reason: BUDGET }, notes: [`Review candidates unconfirmed: ${BUDGET}.`] };
  }

  let groups: Group[] = candidates.map(c => ({ keep: c, same: [] }));
  let dedupe: Confirmation["dedupe"];
  if (deps.dedupe && candidates.length >= 2) {
    const before = deps.snapshot();
    deps.log(`  Grouping ${candidates.length} candidate(s)`);
    const run = await deps.dedupe(candidates);
    deps.saveOutput("review-dedupe", run.rawOutput);
    if (deps.snapshot() !== before) return { stopped: "the dedupe run modified the worktree" };
    const failure = run.failure ?? run.parseError;
    if (failure || !run.groups) {
      const reason = failure ?? "no groups reported";
      deps.log(`  Dedupe failed: ${reason}`);
      dedupe = { outcome: "failed", reason, merged: 0 };
    } else {
      groups = groupCandidates(candidates, run.groups);
      dedupe = { outcome: "grouped", merged: candidates.length - groups.length };
    }
  }

  const batches = batchGroups(groups);
  const judged = new Map<string, RecordedCandidate>();
  const runs: ConfirmBatchRun[] = [];
  const notes: string[] = [];
  const idsOf = (b: ConfirmBatch) => b.candidates.map(c => c.id);
  for (const [i, batch] of batches.entries()) {
    if (!deps.gateOpen()) {
      const skipped = batches.slice(i);
      runs.push(...skipped.map((b): ConfirmBatchRun => ({ n: b.n, ids: idsOf(b), outcome: "skipped", reason: BUDGET })));
      const count = skipped.reduce((sum, b) => sum + b.candidates.length, 0);
      notes.push(i === 0 ? `Review candidates unconfirmed: ${BUDGET}.` : `Confirm stopped after batch ${i} of ${batches.length}: ${BUDGET}; ${count} candidate(s) unconfirmed.`);
      break;
    }
    const before = deps.snapshot();
    deps.log(`  Confirming batch ${batch.n} of ${batches.length} (${batch.candidates.length} candidate(s))`);
    const run = await deps.confirm(batch);
    deps.saveOutput(`review-confirm-${batch.n}`, run.rawOutput);
    if (deps.snapshot() !== before) return { stopped: `confirm batch ${batch.n} modified the worktree` };
    const failure = run.failure ?? run.parseError;
    if (failure || !run.verdicts) {
      const reason = failure ?? "no verdicts reported";
      deps.log(`  Confirm batch ${batch.n} failed: ${reason}`);
      runs.push({ n: batch.n, ids: idsOf(batch), outcome: "failed", reason });
      notes.push(`Confirm batch ${batch.n} of ${batches.length} failed: ${reason}; ${batch.candidates.length} candidate(s) unconfirmed.`);
      continue;
    }
    judgeBatch(batch, run.verdicts, deps.source, deps.ticketText).forEach(c => judged.set(c.id, c));
    runs.push({ n: batch.n, ids: idsOf(batch), outcome: "confirmed" });
  }

  const confirmedRuns = runs.filter(r => r.outcome === "confirmed").length;
  const firstFailure = runs.find(r => r.outcome === "failed");
  const outcome: Confirmation["outcome"] =
    confirmedRuns === runs.length ? "confirmed" : confirmedRuns > 0 ? "partial" : firstFailure ? "failed" : "skipped";
  const reason = outcome === "failed" ? firstFailure!.reason : outcome === "skipped" ? BUDGET : undefined;
  return {
    candidates: candidates.map(c => judged.get(c.id) ?? c),
    confirmation: { outcome, ...(reason ? { reason } : {}), ...(dedupe ? { dedupe } : {}), batches: runs },
    notes,
  };
}
