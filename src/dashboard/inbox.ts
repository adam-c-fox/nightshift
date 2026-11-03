import { budgetUsedPct } from "../budget.js";
import type { PolicyVerdict, VoteSummary } from "../pr.js";
import {
  countTickets,
  postmortemActionKey,
  sweepActionKey,
  ticketActionKey,
  type TicketCounts,
} from "../report.js";
import type {
  NightRecord,
  PostmortemSuggestion,
  ThreadOutcome,
  TicketResult,
  TicketStatus,
} from "../types.js";
import { tickedKeys, type ActionsStore } from "./actions.js";
import type { NightFile } from "./reports.js";

export interface NightData {
  file: NightFile;
  record: NightRecord | null;
  error?: string;
}

export type PrLive =
  | {
      state: "active";
      autoComplete: boolean;
      isDraft: boolean;
      votes: VoteSummary;
      ci: PolicyVerdict | "unknown";
      title?: string;
    }
  | { state: "closed" }
  | { state: "unknown"; reason: string };

interface ItemBase {
  reportId: string;
  project: string;
  date: string;
  key: string;
  reportHref: string;
}

export type InboxItem =
  | (ItemBase & {
      kind: "ticket";
      ticketId: string;
      name: string;
      status: TicketStatus;
      summary: string;
      prUrl?: string;
      prId?: number;
      pr?: PrLive;
      threadsNeedingYou?: number;
    })
  | (ItemBase & { kind: "sweep"; error: string })
  | (ItemBase & { kind: "postmortem"; suggestion: PostmortemSuggestion });

export interface PrRef {
  project: string;
  repo: string;
  prId: number;
  url: string;
}

export const INBOX_STATUSES: TicketStatus[] = [
  "needs_review",
  "partial",
  "error",
];

interface RecordedNight {
  file: NightFile;
  record: NightRecord;
}

const recordedNights = (nights: NightData[]): RecordedNight[] =>
  nights.flatMap(({ file, record }) =>
    record && !record.dryRun ? [{ file, record }] : [],
  );

const needsYou = (o: ThreadOutcome): boolean =>
  o.endState === "needs_person" ||
  o.endState === "gave_up" ||
  o.endState === "replied" ||
  o.replyError !== undefined;

const suggestionsOf = (record: NightRecord): PostmortemSuggestion[] =>
  record.postmortem?.outcome === "done" ? record.postmortem.suggestions : [];

export function prRefs(nights: NightData[]): PrRef[] {
  const refs = new Map<string, PrRef>();
  for (const { file, record } of recordedNights(nights)) {
    for (const result of record.tickets) {
      const { prUrl, prId } = result;
      if (prUrl === undefined || prId === undefined || refs.has(prUrl))
        continue;
      refs.set(prUrl, {
        project: result.ticket.project ?? file.project,
        repo: result.ticket.repo,
        prId,
        url: prUrl,
      });
    }
  }
  return [...refs.values()];
}

function itemBase(file: NightFile, key: string, project = file.project): ItemBase {
  return {
    reportId: file.reportId,
    project,
    date: file.date,
    key,
    reportHref: file.href,
  };
}

export function buildInbox(
  nights: NightData[],
  actions: ActionsStore,
  prLive: (url: string) => PrLive,
): InboxItem[] {
  const seenPrUrls = new Set<string>();
  const items: InboxItem[] = [];
  for (const { file, record } of recordedNights(nights)) {
    const ticked = tickedKeys(actions[file.reportId]);
    const sweepKey = sweepActionKey();
    if (record.prSweep?.error && !ticked.has(sweepKey)) {
      items.push({
        ...itemBase(file, sweepKey),
        kind: "sweep",
        error: record.prSweep.error,
      });
    }
    for (const result of record.tickets) {
      const key = ticketActionKey(result.ticket.id);
      const { prUrl } = result;
      const superseded = prUrl !== undefined && seenPrUrls.has(prUrl);
      if (prUrl !== undefined) seenPrUrls.add(prUrl);
      if (superseded || ticked.has(key)) continue;
      const pr = prUrl === undefined ? undefined : prLive(prUrl);
      if (pr?.state === "closed") continue;
      if (
        !INBOX_STATUSES.includes(result.status) &&
        !pr &&
        threadsNeedingYou(result) === 0
      )
        continue;
      items.push(ticketItem(file, key, result, pr));
    }
    for (const suggestion of suggestionsOf(record)) {
      const key = postmortemActionKey(suggestion.id);
      if (!ticked.has(key)) {
        items.push({ ...itemBase(file, key), kind: "postmortem", suggestion });
      }
    }
  }
  return items;
}

const threadsNeedingYou = (result: TicketResult): number =>
  (result.prComments ?? []).filter(needsYou).length;

function ticketItem(
  file: NightFile,
  key: string,
  result: TicketResult,
  pr: PrLive | undefined,
): InboxItem {
  const threads = threadsNeedingYou(result);
  return {
    ...itemBase(file, key, result.ticket.project),
    kind: "ticket",
    ticketId: result.ticket.id,
    name: result.ticket.name,
    status: result.status,
    summary: result.summary,
    ...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}),
    ...(result.prId !== undefined ? { prId: result.prId } : {}),
    ...(pr ? { pr } : {}),
    ...(threads > 0 ? { threadsNeedingYou: threads } : {}),
  };
}

export interface NightRow {
  reportId: string;
  project: string;
  projects: string[];
  date: string;
  href: string;
  linkOnly: boolean;
  dryRun: boolean;
  counts?: TicketCounts;
  budgetUsedPct?: number;
  budgetUnavailable?: boolean;
  codexUsedPct?: number;
  codexUnavailable?: boolean;
  durationSec?: number;
  suggestions?: number;
  outstanding?: number;
  error?: string;
}

const durationSec = (record: NightRecord): number =>
  Math.round(
    (Date.parse(record.endedAtIso) - Date.parse(record.startedAtIso)) / 1000,
  );

export function nightRows(nights: NightData[], inbox: InboxItem[]): NightRow[] {
  return nights.map(({ file, record, error }) => {
    const row: NightRow = {
      reportId: file.reportId,
      project: file.project,
      projects: record?.projects ?? [file.project],
      date: file.date,
      href: file.href,
      linkOnly: record === null,
      dryRun: record?.dryRun ?? false,
    };
    if (!record) return error ? { ...row, error } : row;
    const budget = record.budget.unavailable
      ? { budgetUnavailable: true }
      : { budgetUsedPct: budgetUsedPct(record.budget) };
    const codex = !record.codexBudget
      ? {}
      : record.codexBudget.unavailable
        ? { codexUnavailable: true }
        : { codexUsedPct: budgetUsedPct(record.codexBudget) };
    return {
      ...row,
      counts: countTickets(record.tickets),
      ...budget,
      ...codex,
      durationSec: durationSec(record),
      suggestions: suggestionsOf(record).length,
      outstanding: inbox.filter((item) => item.reportId === file.reportId)
        .length,
    };
  });
}
