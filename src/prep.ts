import { createHash } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "./state.js";

export type PrepOutcome = "ready" | "not_ready";

export interface PrepRecord {
  project: string;
  repo?: string;
  preppedAt: string;
  descHash: string;
  outcome: PrepOutcome;
  blockers?: string;
}

export type PrepStore = Record<string, PrepRecord>;

export type PrepStateName =
  "fresh" | "stale" | "new_comments" | "not_ready" | "inferred" | "none";

export interface PrepState {
  state: PrepStateName;
  preppedAt?: string;
  blockers?: string;
}

export const PREP_STATE_LABELS: Record<PrepStateName, string> = {
  fresh: "fresh",
  stale: "stale",
  new_comments: "new comments",
  not_ready: "not ready",
  inferred: "inferred",
  none: "none",
};

export const PREP_SECTIONS =
  /^##\s+(Decisions|Acceptance criteria|Pointers)\s*$/im;

export function descriptionHash(description: string): string {
  return createHash("sha256").update(description).digest("hex");
}

export function readPrepStore(file: string): PrepStore {
  return readJsonFile<PrepStore>(file, {});
}

export function upsertPrepRecord(
  file: string,
  id: string,
  record: PrepRecord,
): void {
  const store = readPrepStore(file);
  store[id] = record;
  writeJsonAtomic(file, store);
}

export function prepState(
  record: PrepRecord | undefined,
  issue: { description: string; commentCreatedAt: string[] },
): PrepState {
  if (!record)
    return {
      state: PREP_SECTIONS.test(issue.description) ? "inferred" : "none",
    };
  const { preppedAt } = record;
  if (record.descHash !== descriptionHash(issue.description))
    return { state: "stale", preppedAt };
  if (record.outcome === "not_ready")
    return { state: "not_ready", preppedAt, blockers: record.blockers };
  const preppedMs = Date.parse(preppedAt);
  const hasNewComment = issue.commentCreatedAt.some(
    (at) => Date.parse(at) > preppedMs,
  );
  return { state: hasNewComment ? "new_comments" : "fresh", preppedAt };
}
