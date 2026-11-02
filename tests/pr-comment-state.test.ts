import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPrCommentState, MAX_THREAD_ATTEMPTS, nextRecord, prKey, pruneClosed, savePrCommentState,
} from "../src/pr-comment-state.js";
import { statePaths } from "../src/state.js";
import type { ThreadRecord } from "../src/types.js";

const t = "2026-11-02T00:00:00Z";
const rec = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  handledCommentId: 1, replyIds: [], endState: "answered", attempts: 0, updatedAt: t, ...over,
});

describe("nextRecord", () => {
  it("first retry is not handled", () => {
    expect(nextRecord(undefined, "retry", 9, undefined, t)).toEqual({
      handledCommentId: 0, replyIds: [], endState: "retry", attempts: 1, updatedAt: t,
    });
  });

  it("keeps the previous handled id on a retry", () => {
    expect(nextRecord(rec({ handledCommentId: 4 }), "retry", 9, undefined, t).handledCommentId).toBe(4);
  });

  it("second retry gives up and counts as handled", () => {
    const first = nextRecord(undefined, "retry", 9, undefined, t);
    expect(MAX_THREAD_ATTEMPTS).toBe(2);
    expect(nextRecord(first, "retry", 9, undefined, t)).toMatchObject({ endState: "gave_up", handledCommentId: 9, attempts: 2 });
  });

  it("a handled state records the reply id and covers it", () => {
    const next = nextRecord(rec({ replyIds: [3] }), "resolved", 9, 12, t);
    expect(next).toMatchObject({ endState: "resolved", handledCommentId: 12, replyIds: [3, 12] });
  });

  it("a handled state without a reply covers the last human comment", () => {
    expect(nextRecord(undefined, "needs_person", 9, undefined, t)).toMatchObject({ handledCommentId: 9, replyIds: [], attempts: 0 });
  });
});

describe("nextRecord after a handled thread reopens", () => {
  it("starts the attempt count again", () => {
    const gaveUp = rec({ endState: "gave_up", attempts: MAX_THREAD_ATTEMPTS, handledCommentId: 3 });
    expect(nextRecord(gaveUp, "retry", 5, undefined, t)).toMatchObject({ endState: "retry", attempts: 1, handledCommentId: 3 });
  });
});

describe("pruneClosed", () => {
  it("drops closed PRs of that repo only", () => {
    const state = { [prKey("a", 1)]: { 1: rec() }, [prKey("a", 2)]: { 1: rec() }, [prKey("b", 1)]: { 1: rec() } };
    expect(Object.keys(pruneClosed(state, "a", [2]))).toEqual(["a#2", "b#1"]);
  });
});

describe("load and save", () => {
  it("loads a missing file as empty and round-trips", () => {
    const file = join(mkdtempSync(join(tmpdir(), "nightshift-")), "x", "p.json");
    expect(loadPrCommentState(file)).toEqual({});
    const state = { "a#1": { 3: rec() } };
    savePrCommentState(file, state);
    expect(loadPrCommentState(file)).toEqual(state);
  });
});

describe("statePaths", () => {
  it("places per-project PR comment state", () => {
    expect(statePaths("/r").prComments("nightshift_example")).toBe("/r/state/pr-comments/nightshift_example.json");
  });
});
