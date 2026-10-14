import { NOT_COVERED_NOTE } from "./confirm.js";
import { lensLabel, type ReviewCandidate, type RunRecord, type TicketReview } from "./types.js";

export type Expect = "finding" | "surfaced";
export type Origin = "change" | "fix";
export interface GoldenMatch { files: string[]; all: string[][] }
export interface GoldenNoise { id: string; source?: string; file: string; issue: string; match: GoldenMatch }
export interface GoldenItem extends GoldenNoise { expect: Expect; origin: Origin; guard?: boolean }
export interface GoldenSet { version: 1; ticket: string; sources?: string[]; items: GoldenItem[]; noise: GoldenNoise[] }

type Raw = Record<string, unknown>;

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string");
const requireString = (raw: Raw, field: string, where: string): string => {
  if (typeof raw[field] !== "string" || raw[field] === "") throw new Error(`${where} is missing ${field}`);
  return raw[field];
};

function parseMatch(value: unknown, id: string): GoldenMatch {
  const { files, all } = (value ?? {}) as Raw;
  if (!isStrings(files) || files.length === 0) throw new Error(`item ${id}: match.files must be a non-empty array of strings`);
  if (!Array.isArray(all) || all.length === 0 || !all.every(g => isStrings(g) && g.length > 0)) {
    throw new Error(`item ${id}: match.all must be a non-empty array of non-empty string arrays`);
  }
  return { files, all: all as string[][] };
}

function parseNoise(value: unknown, index: number, label: string): GoldenNoise {
  const raw = (value ?? {}) as Raw;
  const id = requireString(raw, "id", `${label} ${index}`);
  return {
    id, ...(typeof raw.source === "string" ? { source: raw.source } : {}),
    file: requireString(raw, "file", `${label} ${id}`), issue: requireString(raw, "issue", `${label} ${id}`), match: parseMatch(raw.match, id),
  };
}

function parseItem(value: unknown, index: number): GoldenItem {
  const raw = (value ?? {}) as Raw;
  const noise = parseNoise(raw, index, "item");
  if (raw.expect !== "finding" && raw.expect !== "surfaced") throw new Error(`item ${noise.id}: expect must be finding or surfaced`);
  if (raw.origin !== "change" && raw.origin !== "fix") throw new Error(`item ${noise.id}: origin must be change or fix`);
  return { ...noise, expect: raw.expect, origin: raw.origin, guard: raw.guard === true };
}

export function parseGolden(json: unknown): GoldenSet {
  const raw = (json ?? {}) as Raw;
  if (raw.version !== 1) throw new Error(`unsupported golden version ${String(raw.version)}, expected 1`);
  const ticket = requireString(raw, "ticket", "golden set");
  if (!Array.isArray(raw.items)) throw new Error("golden set items must be an array");
  if (raw.noise !== undefined && !Array.isArray(raw.noise)) throw new Error("golden set noise must be an array");
  const items = raw.items.map(parseItem);
  const noise = ((raw.noise as unknown[] | undefined) ?? []).map((n, i) => parseNoise(n, i, "noise"));
  const ids = [...items, ...noise].map(e => e.id);
  const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repeated !== undefined) throw new Error(`duplicate id ${repeated}`);
  return { version: 1, ticket, ...(isStrings(raw.sources) ? { sources: raw.sources } : {}), items, noise };
}

export type MatchKind = "match" | "possible" | "none";

const plain = (file: string): string => file.replace(/^\.\//, "");
const sameFile = (a: string, b: string): boolean => {
  const [x, y] = [plain(a), plain(b)];
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
};

export function matchCandidate(match: GoldenMatch, candidate: Pick<ReviewCandidate, "file" | "issue" | "suggestion">): MatchKind {
  const text = `${candidate.issue}\n${candidate.suggestion}`.toLowerCase();
  const hits = match.all.map(group => group.some(term => text.includes(term.toLowerCase())));
  const listed = match.files.some(f => sameFile(f, candidate.file));
  const every = hits.every(Boolean);
  if (listed && every) return "match";
  return (listed && hits.some(Boolean)) || (every && !listed) ? "possible" : "none";
}

export function candidateOrigin(candidate: ReviewCandidate, review: Pick<TicketReview, "lenses" | "decisions">): string {
  const runs = (review.lenses ?? []).filter(l => l.lens === candidate.lens);
  if (runs.length === 0) return candidate.lens;
  let position = Number(candidate.id.slice(1));
  for (const run of runs) {
    if (position <= run.candidates) return lensLabel(run.lens, run.pass);
    position -= run.candidates;
  }
  const ruling = (review.decisions ?? []).find(d => d.reason === candidate.issue || d.decision === candidate.issue);
  return ruling ? `decision ${ruling.id}` : "decision";
}

export interface CandidateHit { id: string; origin: string; outcome: string; duplicateOf?: string; primaryOutcome?: string; resolution?: string }
export interface ItemScore {
  id: string; file: string; issue: string; expect?: Expect; origin?: Origin; guard?: boolean;
  outcome: string; found: boolean; met: boolean; hits: CandidateHit[]; possible: string[];
}
export interface Counts { items: number; found: number; confirmed: number; surfaced: number; met: number; lost: number }
export interface TicketScore {
  ticket: string; confirmation?: string; items: ItemScore[]; guards: ItemScore[]; fixItems: ItemScore[]; noise: ItemScore[];
  counts: Counts; guardCounts: Counts; noiseConfirmed: number; unmatchedConfirmed: { id: string; file: string; issue: string }[]; runs: RunRecord[];
}

type Reviewed = NonNullable<TicketReview["candidates"]>[number];

const OUTCOME_RANK = ["confirmed", "ticket_conflict", "unproven", "duplicate", "unconfirmed", "missing", "rejected"];
const SURFACED = ["confirmed", "ticket_conflict", "unproven"];
const rankOf = (outcome: string): number => (outcome === "not found" ? OUTCOME_RANK.length + 1 : OUTCOME_RANK.includes(outcome) ? OUTCOME_RANK.indexOf(outcome) : OUTCOME_RANK.length);
const LOST = ["rejected", "duplicate", "missing"];

function primaryOf(candidate: Reviewed, byId: Map<string, Reviewed>): Reviewed | undefined {
  const seen = new Set<string>();
  let current: Reviewed | undefined = candidate;
  while (current?.verdict?.verdict === "duplicate") {
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);
    current = byId.get(current.verdict.duplicateOf ?? "");
  }
  return current;
}

function ownOutcome(candidate: Reviewed): string {
  if (!candidate.verdict) return "unconfirmed";
  if (candidate.verdict.verdict === "unproven" && candidate.verdict.note === NOT_COVERED_NOTE) return "missing";
  return candidate.verdict.verdict;
}

function resolutionOf(candidate: Reviewed, review: TicketReview): string | undefined {
  const finding = review.findings.find(f => f.from === candidate.id);
  if (!finding) return undefined;
  const resolution = review.resolutions.find(r => r.id === finding.id);
  if (!resolution) return finding.id;
  if (resolution.status === "not_fixed") return `${finding.id} not fixed`;
  const verified = review.verification?.results.find(r => r.id === finding.id)?.status;
  return `${finding.id} fixed${verified === "resolved" ? ", verified" : verified === "unresolved" ? ", still open" : ""}`;
}

function hitFor(candidate: Reviewed, matched: Set<string>, byId: Map<string, Reviewed>, review: TicketReview): CandidateHit {
  const hit = { id: candidate.id, origin: candidateOrigin(candidate, review) };
  if (candidate.verdict?.verdict !== "duplicate") {
    const resolution = candidate.verdict?.verdict === "confirmed" ? resolutionOf(candidate, review) : undefined;
    return { ...hit, outcome: ownOutcome(candidate), ...(resolution ? { resolution } : {}) };
  }
  const primary = primaryOf(candidate, byId);
  if (primary && matched.has(primary.id)) return { ...hit, outcome: ownOutcome(primary) };
  return {
    ...hit, outcome: "duplicate", duplicateOf: primary?.id ?? candidate.verdict.duplicateOf,
    ...(primary ? { primaryOutcome: ownOutcome(primary) } : {}),
  };
}

function scoreEntry(entry: GoldenNoise & Partial<GoldenItem>, review: TicketReview, candidates: Reviewed[], byId: Map<string, Reviewed>): ItemScore {
  const kinds = candidates.map(c => ({ c, kind: matchCandidate(entry.match, c) }));
  const matched = new Set(kinds.filter(k => k.kind === "match").map(k => k.c.id));
  const hits = candidates.filter(c => matched.has(c.id)).map(c => hitFor(c, matched, byId, review));
  const outcome = hits.map(h => h.outcome).sort((a, b) => rankOf(a) - rankOf(b))[0] ?? "not found";
  const met = entry.expect === "finding" ? outcome === "confirmed" : entry.expect === "surfaced" && SURFACED.includes(outcome);
  return {
    id: entry.id, file: entry.file, issue: entry.issue,
    ...(entry.expect ? { expect: entry.expect } : {}), ...(entry.origin ? { origin: entry.origin } : {}), ...(entry.guard ? { guard: true } : {}),
    outcome, found: hits.length > 0, met, hits, possible: kinds.filter(k => k.kind === "possible").map(k => k.c.id),
  };
}

const countItems = (items: ItemScore[]): Counts => ({
  items: items.length,
  found: items.filter(i => i.found).length,
  confirmed: items.filter(i => i.outcome === "confirmed").length,
  surfaced: items.filter(i => SURFACED.includes(i.outcome)).length,
  met: items.filter(i => i.met).length,
  lost: items.filter(i => i.found && LOST.includes(i.outcome)).length,
});

export function scoreTicket(golden: GoldenSet, review: TicketReview, runs: RunRecord[] = []): TicketScore {
  const candidates = review.candidates ?? [];
  const byId = new Map(candidates.map(c => [c.id, c]));
  const scored = golden.items.map(i => scoreEntry(i, review, candidates, byId));
  const noise = golden.noise.map(n => scoreEntry(n, review, candidates, byId));
  const fixItems = scored.filter(i => i.origin === "fix");
  const guards = scored.filter(i => i.origin !== "fix" && i.guard);
  const items = scored.filter(i => i.origin !== "fix" && !i.guard);
  const entries = [...golden.items, ...golden.noise];
  const unmatchedConfirmed = candidates
    .filter(c => ownOutcome(c) === "confirmed" && !entries.some(e => matchCandidate(e.match, c) === "match"))
    .map(c => ({ id: c.id, file: c.file, issue: c.issue }));
  const confirmation = review.confirmation && `${review.confirmation.outcome}${review.confirmation.reason ? ` (${review.confirmation.reason})` : ""}`;
  return {
    ticket: golden.ticket, ...(confirmation ? { confirmation } : {}), items, guards, fixItems, noise,
    counts: countItems(items), guardCounts: countItems(guards), noiseConfirmed: noise.filter(n => n.outcome === "confirmed").length, unmatchedConfirmed, runs,
  };
}

const hitText = (hit: CandidateHit): string => {
  const merged = hit.duplicateOf ? ` of ${hit.duplicateOf}${hit.primaryOutcome ? ` (${hit.primaryOutcome})` : ""}` : "";
  return `${hit.id} (${hit.origin}) ${hit.outcome}${merged}${hit.resolution ? ` → ${hit.resolution}` : ""}`;
};

const itemLine = (item: ItemScore, prefix = ""): string => {
  const hits = item.hits.length > 0 ? item.hits.map(hitText).join("; ") : "not found";
  const fixNote = prefix === "fix " && !item.found ? " (fix-origin, needs a fix replay)" : "";
  return `  ${prefix}${item.id} ${item.file}: ${hits}${fixNote}${item.met ? "  [met]" : ""}`;
};

const ratio = (n: number, of: number): string => `${n}/${of}`;
const countsLine = (c: Counts): string =>
  `found ${ratio(c.found, c.items)}, confirmed ${ratio(c.confirmed, c.items)}, surfaced ${ratio(c.surfaced, c.items)}, met ${ratio(c.met, c.items)}, lost at confirm ${c.lost}`;

const costLine = (runs: RunRecord[], perStage = true): string => {
  const stages = !perStage ? [] : runs.map(r => (r.usage ? `${r.stage} $${r.usage.costUsd.toFixed(2)} (${r.usage.turns} turns)` : `${r.stage} no usage`));
  const total = runs.reduce((n, r) => n + (r.usage?.costUsd ?? 0), 0);
  return `  cost: ${[...stages, `total $${total.toFixed(2)}`].join(", ")}`;
};

export function scoreSummary(score: TicketScore): string {
  const everyItem = [...score.items, ...score.guards, ...score.fixItems, ...score.noise];
  return [
    score.ticket,
    ...score.items.map(i => itemLine(i)),
    ...score.guards.map(i => itemLine(i, "guard ")),
    ...score.fixItems.map(i => itemLine(i, "fix ")),
    ...score.noise.map(i => itemLine(i, "noise ")),
    ...everyItem.filter(i => i.possible.length > 0).map(i => `  possible: ${i.id} ~ ${i.possible.join(", ")}`),
    ...(score.unmatchedConfirmed.length > 0 ? score.unmatchedConfirmed.map(u => `  unmatched confirmed: ${u.id} ${u.file}: ${u.issue}`) : ["  unmatched confirmed: none"]),
    `  items: ${countsLine(score.counts)}`,
    `  guards: confirmed ${ratio(score.guardCounts.confirmed, score.guardCounts.items)}`,
    `  noise confirmed: ${ratio(score.noiseConfirmed, score.noise.length)}`,
    ...(score.confirmation && score.confirmation !== "confirmed" ? [`  confirm: ${score.confirmation}`] : []),
    costLine(score.runs),
  ].join("\n");
}

const sumCounts = (all: Counts[]): Counts => ({
  items: all.reduce((n, c) => n + c.items, 0), found: all.reduce((n, c) => n + c.found, 0), confirmed: all.reduce((n, c) => n + c.confirmed, 0),
  surfaced: all.reduce((n, c) => n + c.surfaced, 0), met: all.reduce((n, c) => n + c.met, 0), lost: all.reduce((n, c) => n + c.lost, 0),
});

export function totalSummary(scores: TicketScore[]): string {
  const guards = sumCounts(scores.map(s => s.guardCounts));
  return [
    "total",
    `  items: ${countsLine(sumCounts(scores.map(s => s.counts)))}`,
    `  guards: confirmed ${ratio(guards.confirmed, guards.items)}`,
    `  noise confirmed: ${ratio(scores.reduce((n, s) => n + s.noiseConfirmed, 0), scores.reduce((n, s) => n + s.noise.length, 0))}`,
    costLine(scores.flatMap(s => s.runs), false),
  ].join("\n");
}
