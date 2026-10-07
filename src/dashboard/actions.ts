import { PROJECT_NAME } from "../project.js";
import {
  POSTMORTEM_ID_PATTERN,
  REPORT_BASE,
  postmortemActionKey,
  ticketActionKey,
} from "../report.js";
import { readJsonFile, writeJsonAtomic } from "../state.js";
import { TICKET_ID_PATTERN } from "../tickets.js";

export interface ActionEntry {
  at: string | null;
  updatedAt: string;
}
export type ReportActions = Record<string, ActionEntry>;
export type ActionsStore = Record<string, ReportActions>;
export type MergeMode = "latest" | "tickWins";

export const ACTION_KEY = new RegExp(
  `^(?:${ticketActionKey(TICKET_ID_PATTERN)}|${postmortemActionKey(POSTMORTEM_ID_PATTERN)})$`,
);

const MAX_ACTION_KEYS = 500;

const isIso = (value: unknown): value is string =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  /^\d{4}-\d{2}-\d{2}T/.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseReportId(value: string | null): string {
  const parts = (value ?? "").split("/");
  const base = parts[parts.length - 1];
  const projects = parts.slice(0, -1);
  const valid =
    parts.length <= 2 &&
    REPORT_BASE.test(base) &&
    projects.every((project) => PROJECT_NAME.test(project));
  if (!valid) throw new Error("invalid report id");
  return value as string;
}

export function parseActionsBody(body: unknown): ReportActions {
  if (!isRecord(body)) throw new Error("body must be an object");
  const keys = Object.keys(body);
  if (keys.length > MAX_ACTION_KEYS) {
    throw new Error(`too many keys (max ${MAX_ACTION_KEYS})`);
  }
  const actions: ReportActions = {};
  for (const key of keys) {
    if (!ACTION_KEY.test(key)) throw new Error(`invalid action key: ${key}`);
    const raw = body[key];
    if (!isRecord(raw)) throw new Error(`${key}: entry must be an object`);
    if (raw.at !== null && !isIso(raw.at)) {
      throw new Error(`${key}: at must be an ISO date or null`);
    }
    if (!isIso(raw.updatedAt)) {
      throw new Error(`${key}: updatedAt must be an ISO date`);
    }
    actions[key] = { at: raw.at, updatedAt: raw.updatedAt };
  }
  return actions;
}

export function mergeActions(
  current: ReportActions,
  incoming: ReportActions,
  mode: MergeMode,
): ReportActions {
  const merged: ReportActions = { ...current };
  for (const [key, entry] of Object.entries(incoming)) {
    if (mode === "tickWins" && entry.at === null) continue;
    const existing = merged[key];
    if (!existing || incomingWins(existing, entry, mode)) merged[key] = entry;
  }
  return merged;
}

function incomingWins(
  existing: ActionEntry,
  entry: ActionEntry,
  mode: MergeMode,
): boolean {
  if (mode === "tickWins") return existing.at === null;
  return Date.parse(entry.updatedAt) > Date.parse(existing.updatedAt);
}

export function readActions(file: string): ActionsStore {
  return readJsonFile<ActionsStore>(file, {});
}

export function putActions(
  file: string,
  report: string,
  incoming: ReportActions,
  mode: MergeMode,
): ReportActions {
  const store = readActions(file);
  const merged = mergeActions(store[report] ?? {}, incoming, mode);
  writeJsonAtomic(file, { ...store, [report]: merged });
  return merged;
}

export function tickedKeys(actions: ReportActions | undefined): Set<string> {
  return new Set(
    Object.entries(actions ?? {})
      .filter(([, entry]) => entry.at !== null)
      .map(([key]) => key),
  );
}
