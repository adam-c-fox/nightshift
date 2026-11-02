import { readJsonFile, writeJsonAtomic } from "./state.js";
import type { ThreadEndState, ThreadRecord } from "./types.js";

export type PrCommentState = Record<string, Record<number, ThreadRecord>>;

export const MAX_THREAD_ATTEMPTS = 2;

export const prKey = (repoName: string, prId: number): string => `${repoName}#${prId}`;

export const loadPrCommentState = (file: string): PrCommentState => readJsonFile<PrCommentState>(file, {});

export const savePrCommentState = (file: string, state: PrCommentState): void => writeJsonAtomic(file, state);

export function pruneClosed(state: PrCommentState, repoName: string, activePrIds: number[]): PrCommentState {
  const prefix = `${repoName}#`;
  const active = new Set(activePrIds.map(id => prKey(repoName, id)));
  return Object.fromEntries(Object.entries(state).filter(([key]) => !key.startsWith(prefix) || active.has(key)));
}

export function nextRecord(
  prev: ThreadRecord | undefined,
  end: ThreadEndState,
  lastHumanId: number,
  replyId: number | undefined,
  now: string,
): ThreadRecord {
  const replyIds = replyId === undefined ? (prev?.replyIds ?? []) : [...(prev?.replyIds ?? []), replyId];
  const priorAttempts = prev?.endState === "retry" ? prev.attempts : 0;
  const attempts = priorAttempts + (end === "retry" ? 1 : 0);
  const endState = end === "retry" && attempts >= MAX_THREAD_ATTEMPTS ? "gave_up" : end;
  const handledCommentId = endState === "retry"
    ? (prev?.handledCommentId ?? 0)
    : Math.max(lastHumanId, replyId ?? 0);
  return { handledCommentId, replyIds, endState, attempts, updatedAt: now };
}
