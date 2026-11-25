import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StructuredStepOptions, StructuredStepResult } from "../src/claude.js";
import {
  SessionError,
  createSessions,
  fallbackCommand,
  parseAnswers,
  parseApproval,
  parseBlockers,
  parseFeedback,
  parseSessionRequest,
  shellQuote,
  skillPrompt,
  terminalCommand,
  type PrepSession,
} from "../src/dashboard/sessions.js";
import type { Issue } from "../src/issue-tracker.js";
import type { Survey } from "../src/prep-flow.js";
import type { Project } from "../src/project.js";
import { descriptionHash, mergePrepSections, type PrepRecord } from "../src/prep.js";
import type { RunUsage } from "../src/types.js";

const usage: RunUsage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0.5,
  turns: 3,
  durationMs: 10,
  models: ["m"],
};

const surveyOutput = {
  repo: "app",
  gaps: [{ title: "Gap", question: "Q", recommended: "Rec", alternative: "Alt" }],
  pointers: ["see src/a.ts"],
};
const draftOutput = { acceptanceCriteria: ["it works"], decisions: [], pointers: [] };
const ok = (output: unknown, sessionId = "claude-1"): StructuredStepResult => ({
  ok: true,
  output,
  sessionId,
  usage,
});

const baseIssue: Issue = {
  id: "lin-1",
  identifier: "ENG-142",
  name: "Fix it",
  description: "Original",
  comments: [],
  state: "Todo",
  url: "https://tracker/ENG-142",
};

type Responder = (opts: StructuredStepOptions) => Promise<StructuredStepResult>;

function setup(options: { live?: boolean; issue?: Issue | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  let clock = Date.parse("2026-11-25T00:00:00Z");
  let issue: Issue | null = options.issue === undefined ? baseIssue : options.issue;
  let n = 0;
  const responders: Responder[] = [];
  const steps: StructuredStepOptions[] = [];
  const records: [string, PrepRecord][] = [];
  const saved: string[] = [];
  const state = { live: options.live ?? false, recordFails: false, alive: false };
  const killed: [number, string][] = [];
  const onSaved = vi.fn();
  const tracker = {
    getIssue: vi.fn(async () => issue),
    saveForNight: vi.fn(async (i: Issue, description: string) => {
      saved.push(description);
      issue = { ...i, description };
    }),
  };
  const sessions = createSessions({
    dir,
    root: "/root",
    loadProject: () => ({
      defaultRepo: "app",
      repos: {
        app: { path: "/code/app", description: "the app" },
        lib: { path: "/code/lib", description: "the lib" },
      },
    }) as unknown as Project,
    tracker: () => tracker as never,
    runStep: async (opts) => {
      steps.push(opts);
      const next = responders.shift();
      if (!next) throw new Error("no responder queued");
      return next(opts);
    },
    recordPrep: (id, record) => {
      if (state.recordFails) throw new Error("disk full");
      records.push([id, record]);
    },
    runsLive: () => state.live,
    onSaved,
    now: () => new Date(clock),
    uuid: () => `sid-${++n}`,
    kill: (pid, signal) => killed.push([pid, signal]),
    isAlive: () => state.alive,
    readSkillTexts: () => ({ gapsMd: "GAPS-MD", draftMd: "DRAFT-MD" }),
  });
  const queue = (...r: Array<StructuredStepResult | Responder>) =>
    responders.push(...r.map((x): Responder => (typeof x === "function" ? x : async () => x)));
  const setIssue = (description: string) => {
    issue = { ...baseIssue, description };
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  const fileFor = (sid: string) => join(dir, `${sid}.json`);
  const reachAnswering = async () => {
    queue(ok(surveyOutput));
    const { session } = await sessions.start({ id: "ENG-142", project: "acme" });
    await sessions.settled();
    return session.id;
  };
  const reachReviewing = async () => {
    const sid = await reachAnswering();
    queue(ok(draftOutput));
    sessions.answer(sid, [{ gapId: "g1", choice: "recommended" }]);
    await sessions.settled();
    return sid;
  };
  return {
    sessions, dir, queue, steps, records, saved, state, killed, onSaved, tracker,
    setIssue, advance, fileFor, reachAnswering, reachReviewing,
  };
}

const get = (t: ReturnType<typeof setup>, sid: string): PrepSession => t.sessions.get(sid)!;

const statusOf = (fn: () => unknown): Promise<number | undefined> =>
  Promise.resolve()
    .then(fn)
    .then(
      () => undefined,
      (e) => (e instanceof SessionError ? e.status : -1),
    );

const never = (opts: StructuredStepOptions) =>
  new Promise<StructuredStepResult>((resolve) =>
    opts.signal?.addEventListener("abort", () => resolve({ ok: false, error: "aborted" })),
  );

describe("start and survey", () => {
  it("shows the ticket title while the survey runs", async () => {
    const t = setup();
    t.queue(never);
    await t.sessions.start({ id: "ENG-142", project: "acme" });
    await vi.waitFor(() => expect(get(t, "sid-1").ticket.title).toBe(baseIssue.name));
  });

  it("creates a surveying session and ends in answering with the survey", async () => {
    const t = setup();
    t.queue(ok(surveyOutput, "claude-9"));
    const { session, created } = await t.sessions.start({ id: "ENG-142", project: "acme" });
    expect(created).toBe(true);
    expect(session).toMatchObject({ id: "sid-1", state: "surveying", running: true });
    await t.sessions.settled();
    const done = get(t, "sid-1");
    expect(done).toMatchObject({
      state: "answering",
      running: false,
      claudeSessionId: "claude-9",
      ticketId: "ENG-142",
      project: "acme",
      kind: "prep",
      ticket: {
        title: "Fix it",
        url: "https://tracker/ENG-142",
        description: "Original",
        descHash: descriptionHash("Original"),
      },
    });
    expect(done.survey?.gaps[0]).toMatchObject({ id: "g1", title: "Gap" });
    expect(done.usage).toEqual([usage]);
    expect(done.pid).toBeUndefined();
    expect(t.steps[0]).toMatchObject({
      root: "/root",
      cwd: "/code/app",
      addDirs: ["/code/lib"],
    });
    expect(t.steps[0]?.resumeId).toBeUndefined();
    expect(t.steps[0]?.prompt).toContain("GAPS-MD");
  });

  it("returns the open session for the same ticket without a new step", async () => {
    const t = setup();
    const first = await t.reachAnswering();
    const again = await t.sessions.start({ id: "ENG-142", project: "acme" });
    expect(again).toMatchObject({ created: false });
    expect(again.session.id).toBe(first);
    expect(t.steps).toHaveLength(1);
  });

  it("starts a new session once the earlier one is terminal", async () => {
    const t = setup();
    const first = await t.reachAnswering();
    t.sessions.cancel(first);
    t.queue(ok(surveyOutput));
    const next = await t.sessions.start({ id: "ENG-142", project: "acme" });
    expect(next.created).toBe(true);
    expect(next.session.id).not.toBe(first);
  });

  it("refuses to start during a night run", async () => {
    const t = setup({ live: true });
    await expect(t.sessions.start({ id: "ENG-142", project: "acme" })).rejects.toMatchObject({
      status: 409,
      message: "a night run is in progress",
    });
    expect(readdirSync(t.dir)).toEqual([]);
  });

  it("fails the survey step when the ticket is missing and retry re-fetches it", async () => {
    const t = setup({ issue: null });
    await t.sessions.start({ id: "ENG-142", project: "acme" });
    await t.sessions.settled();
    expect(get(t, "sid-1")).toMatchObject({ state: "surveying", running: false });
    expect(get(t, "sid-1").error).toMatch(/ENG-142/);
    t.setIssue("Original");
    t.queue(ok(surveyOutput));
    t.sessions.retry("sid-1");
    await t.sessions.settled();
    expect(get(t, "sid-1")).toMatchObject({ state: "answering", running: false });
    expect(get(t, "sid-1").error).toBeUndefined();
  });

  it("fails the step when the model output is invalid", async () => {
    const t = setup();
    t.queue(ok({ repo: "nope", gaps: [], pointers: [] }));
    await t.sessions.start({ id: "ENG-142", project: "acme" });
    await t.sessions.settled();
    expect(get(t, "sid-1")).toMatchObject({ state: "surveying", running: false });
    expect(get(t, "sid-1").error).toMatch(/unknown repo/);
    expect(get(t, "sid-1").usage).toEqual([usage]);
  });

  it("persists the child pid while the step runs and clears it after", async () => {
    const t = setup();
    let release!: () => void;
    t.queue(async (opts) => {
      opts.onSpawn?.(4242);
      await new Promise<void>((r) => (release = r));
      return ok(surveyOutput);
    });
    await t.sessions.start({ id: "ENG-142", project: "acme" });
    await vi.waitFor(() => expect(get(t, "sid-1").pid).toBe(4242));
    release();
    await t.sessions.settled();
    expect(get(t, "sid-1").pid).toBeUndefined();
  });

  it("keeps the last 200 activity lines", async () => {
    const t = setup();
    t.queue(async (opts) => {
      for (let i = 0; i < 250; i++) opts.onActivity(`Read f${i}`);
      return ok(surveyOutput);
    });
    await t.sessions.start({ id: "ENG-142", project: "acme" });
    await t.sessions.settled();
    const { activity } = get(t, "sid-1");
    expect(activity).toHaveLength(200);
    expect(activity[0]?.text).toBe("Read f50");
    expect(activity[199]).toEqual({ at: "2026-11-25T00:00:00.000Z", text: "Read f249" });
  });
});

describe("answer and revise", () => {
  it("drafts from the answers by resuming the survey session", async () => {
    const t = setup();
    const sid = await t.reachAnswering();
    t.queue(ok(draftOutput));
    t.sessions.answer(sid, [{ gapId: "g1", choice: "recommended" }]);
    expect(get(t, sid)).toMatchObject({ state: "drafting", running: true });
    await t.sessions.settled();
    expect(get(t, sid)).toMatchObject({
      state: "reviewing",
      running: false,
      draft: mergePrepSections("Original", draftOutput),
      answers: [{ gapId: "g1", choice: "recommended" }],
    });
    expect(get(t, sid).usage).toHaveLength(2);
    expect(t.steps[1]).toMatchObject({ resumeId: "claude-1", cwd: "/code/app" });
    expect(t.steps[1]?.prompt).toContain("DRAFT-MD");
    expect(t.steps[1]?.prompt).toContain("Rec");
  });

  it("revises by resuming, merging from the ticket again and keeping the old draft", async () => {
    const t = setup();
    const sid = await t.reachReviewing();
    const first = get(t, sid).draft;
    const revised = { acceptanceCriteria: ["better"], decisions: [], pointers: [] };
    t.queue(ok(revised));
    t.sessions.revise(sid, "make it better");
    expect(get(t, sid)).toMatchObject({ state: "revising", running: true });
    await t.sessions.settled();
    expect(get(t, sid)).toMatchObject({
      state: "reviewing",
      draft: mergePrepSections("Original", revised),
      revisions: [first],
      feedback: "make it better",
    });
    expect(t.steps[2]).toMatchObject({ resumeId: "claude-1" });
    expect(t.steps[2]?.prompt).toContain("make it better");
    expect(t.steps[2]?.prompt).toContain(first);
  });

  it("409s answer while reviewing and revise while answering", async () => {
    const t = setup();
    const answering = await t.reachAnswering();
    expect(await statusOf(() => t.sessions.revise(answering, "x"))).toBe(409);
    t.queue(ok(draftOutput));
    t.sessions.answer(answering, [{ gapId: "g1", choice: "recommended" }]);
    expect(await statusOf(() => t.sessions.answer(answering, []))).toBe(409);
    await t.sessions.settled();
    expect(await statusOf(() => t.sessions.answer(answering, []))).toBe(409);
  });

  it("409s while a step is running and during a night run", async () => {
    const t = setup();
    const sid = await t.reachReviewing();
    t.queue(never);
    t.sessions.revise(sid, "x");
    expect(await statusOf(() => t.sessions.revise(sid, "y"))).toBe(409);
    t.sessions.cancel(sid);
    await t.sessions.settled();

    const u = setup();
    const s2 = await u.reachAnswering();
    u.state.live = true;
    await expect(
      Promise.resolve().then(() => u.sessions.answer(s2, [{ gapId: "g1", choice: "recommended" }])),
    ).rejects.toMatchObject({ status: 409, message: "a night run is in progress" });
    expect(get(u, s2).state).toBe("answering");
  });

  it("keeps stored inputs when a draft step fails and retry reuses them", async () => {
    const t = setup();
    const sid = await t.reachAnswering();
    t.queue({ ok: false, error: "boom" });
    t.sessions.answer(sid, [{ gapId: "g1", choice: "your_call" }]);
    await t.sessions.settled();
    expect(get(t, sid)).toMatchObject({
      state: "drafting",
      running: false,
      error: "boom",
      answers: [{ gapId: "g1", choice: "your_call" }],
    });
    t.queue(ok(draftOutput));
    t.sessions.retry(sid);
    expect(get(t, sid).error).toBeUndefined();
    await t.sessions.settled();
    expect(get(t, sid)).toMatchObject({ state: "reviewing" });
    expect(t.steps[2]).toMatchObject({ resumeId: "claude-1" });
    expect(t.steps[2]?.prompt).toBe(t.steps[1]?.prompt);
  });

  it("retries a failed revise with the stored feedback", async () => {
    const t = setup();
    const sid = await t.reachReviewing();
    t.queue({ ok: false, error: "boom" });
    t.sessions.revise(sid, "again");
    await t.sessions.settled();
    t.queue(ok(draftOutput));
    t.sessions.retry(sid);
    await t.sessions.settled();
    expect(t.steps[3]?.prompt).toBe(t.steps[2]?.prompt);
    expect(get(t, sid)).toMatchObject({ state: "reviewing", revisions: [expect.any(String)] });
  });

  it("retries a failed survey from scratch, without resuming", async () => {
    const t = setup();
    t.queue({ ok: false, error: "boom" });
    await t.sessions.start({ id: "ENG-142", project: "acme" });
    await t.sessions.settled();
    t.queue(ok(surveyOutput));
    t.sessions.retry("sid-1");
    await t.sessions.settled();
    expect(t.steps[1]?.resumeId).toBeUndefined();
    expect(get(t, "sid-1").state).toBe("answering");
  });

  it("409s retry when nothing failed", async () => {
    const t = setup();
    const sid = await t.reachAnswering();
    expect(await statusOf(() => t.sessions.retry(sid))).toBe(409);
  });
});

describe("approve", () => {
  it("saves the submitted text, records ready and refreshes", async () => {
    const t = setup();
    const sid = await t.reachReviewing();
    await t.sessions.approve(sid, "Final text");
    expect(t.tracker.saveForNight).toHaveBeenCalledWith(expect.objectContaining({ id: "lin-1" }), "Final text");
    expect(t.records).toEqual([
      [
        "ENG-142",
        {
          project: "acme",
          repo: "app",
          preppedAt: "2026-11-25T00:00:00.000Z",
          descHash: descriptionHash("Final text"),
          outcome: "ready",
        },
      ],
    ]);
    expect(t.onSaved).toHaveBeenCalledTimes(1);
    expect(get(t, sid)).toMatchObject({ state: "saved", running: false });
  });

  it("refuses with 409 when the ticket changed, returning to reviewing with the submitted text", async () => {
    const t = setup();
    const sid = await t.reachReviewing();
    t.setIssue("Someone else edited this");
    await expect(t.sessions.approve(sid, "Final text")).rejects.toMatchObject({
      status: 409,
      message: "ENG-142 changed in the tracker since this prep started; cancel this prep and start again to pick up the new description",
    });
    expect(t.saved).toEqual([]);
    expect(t.records).toEqual([]);
    expect(get(t, sid)).toMatchObject({ state: "reviewing", running: false, draft: "Final text" });
  });

  it("is idempotent when retried after the tracker save already landed", async () => {
    const t = setup();
    const sid = await t.reachReviewing();
    t.state.recordFails = true;
    await expect(t.sessions.approve(sid, "Final text")).rejects.toMatchObject({ status: 502 });
    expect(get(t, sid)).toMatchObject({
      state: "saving",
      running: false,
      approvedDescription: "Final text",
    });
    expect(get(t, sid).error).toMatch(/disk full/);
    t.state.recordFails = false;
    t.sessions.retry(sid);
    await t.sessions.settled();
    expect(get(t, sid)).toMatchObject({ state: "saved", running: false });
    expect(t.saved.every((d) => d === "Final text")).toBe(true);
    expect(t.records).toHaveLength(1);
  });

  it("409s outside reviewing", async () => {
    const t = setup();
    const sid = await t.reachAnswering();
    await expect(t.sessions.approve(sid, "x")).rejects.toMatchObject({ status: 409 });
  });
});

describe("notReady", () => {
  it("records not_ready without touching the tracker", async () => {
    const t = setup();
    const sid = await t.reachAnswering();
    t.sessions.notReady(sid, "needs design");
    expect(t.records).toEqual([
      [
        "ENG-142",
        {
          project: "acme",
          repo: "app",
          preppedAt: "2026-11-25T00:00:00.000Z",
          descHash: descriptionHash("Original"),
          outcome: "not_ready",
          blockers: "needs design",
        },
      ],
    ]);
    expect(t.tracker.saveForNight).not.toHaveBeenCalled();
    expect(get(t, sid)).toMatchObject({ state: "not_ready", blockers: "needs design", running: false });
  });

  it("works from reviewing and 409s from other states", async () => {
    const t = setup();
    const sid = await t.reachReviewing();
    t.sessions.notReady(sid, "x");
    expect(get(t, sid).state).toBe("not_ready");
    expect(await statusOf(() => t.sessions.notReady(sid, "x"))).toBe(409);

    t.queue(never);
    const running = await t.sessions.start({ id: "ENG-7", project: "acme" });
    expect(await statusOf(() => t.sessions.notReady(running.session.id, "x"))).toBe(409);
    t.sessions.cancel(running.session.id);
    await t.sessions.settled();
  });
});

describe("cancel", () => {
  it("aborts the running step and stays cancelled when it settles", async () => {
    const t = setup();
    let signal: AbortSignal | undefined;
    t.queue((opts) => {
      signal = opts.signal;
      return never(opts);
    });
    await t.sessions.start({ id: "ENG-142", project: "acme" });
    await vi.waitFor(() => expect(signal).toBeDefined());
    t.sessions.cancel("sid-1");
    expect(signal?.aborted).toBe(true);
    expect(get(t, "sid-1")).toMatchObject({ state: "cancelled", running: false });
    await t.sessions.settled();
    expect(get(t, "sid-1")).toMatchObject({ state: "cancelled", running: false });
    expect(get(t, "sid-1").error).toBeUndefined();
  });

  it("409s on a terminal session", async () => {
    const t = setup();
    const sid = await t.reachAnswering();
    t.sessions.cancel(sid);
    expect(await statusOf(() => t.sessions.cancel(sid))).toBe(409);
  });
});

describe("caps and lookup", () => {
  it("429s a third running step and frees the slot when one finishes", async () => {
    const t = setup();
    t.queue(never, never);
    await t.sessions.start({ id: "ENG-1", project: "acme" });
    await t.sessions.start({ id: "ENG-2", project: "acme" });
    await expect(t.sessions.start({ id: "ENG-3", project: "acme" })).rejects.toMatchObject({
      status: 429,
      message: "2 steps are already running; try again when one finishes",
    });
    t.sessions.cancel("sid-1");
    await Promise.resolve();
    t.queue(ok(surveyOutput));
    await expect(t.sessions.start({ id: "ENG-3", project: "acme" })).resolves.toMatchObject({ created: true });
    t.sessions.cancel("sid-2");
    await t.sessions.settled();
  });

  it("404s unknown and malformed session ids", async () => {
    const t = setup();
    expect(t.sessions.get("nope")).toBeUndefined();
    expect(await statusOf(() => t.sessions.cancel("nope"))).toBe(404);
    expect(await statusOf(() => t.sessions.retry("../etc/passwd"))).toBe(404);
    expect(await statusOf(() => t.sessions.approve("nope", "x"))).toBe(404);
  });

  it("lists only non-terminal sessions, oldest first", async () => {
    const t = setup();
    const a = await t.reachAnswering();
    t.advance(1000);
    t.queue(ok(surveyOutput));
    const b = (await t.sessions.start({ id: "ENG-2", project: "acme" })).session.id;
    await t.sessions.settled();
    t.advance(1000);
    t.queue(ok(surveyOutput));
    const c = (await t.sessions.start({ id: "ENG-3", project: "acme" })).session.id;
    await t.sessions.settled();
    t.sessions.cancel(b);
    expect(t.sessions.listOpen().map((s) => s.id)).toEqual([a, c]);
  });
});

describe("recover", () => {
  const writeSession = (t: ReturnType<typeof setup>, over: Partial<PrepSession>) => {
    const session: PrepSession = {
      id: "old",
      kind: "prep",
      ticketId: "ENG-1",
      project: "acme",
      state: "drafting",
      running: true,
      pid: 999,
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
      ticket: { title: "t", url: "u", description: "d", descHash: "h" },
      activity: [],
      revisions: [],
      usage: [],
      ...over,
    };
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(t.fileFor(session.id), JSON.stringify(session));
  };

  it("kills a live orphan, marks the step interrupted and clears the pid", () => {
    const t = setup();
    t.state.alive = true;
    writeSession(t, {});
    t.sessions.recover();
    expect(t.killed).toEqual([[999, "SIGTERM"]]);
    expect(get(t, "old")).toMatchObject({ running: false, error: "interrupted", state: "drafting" });
    expect(get(t, "old").pid).toBeUndefined();
  });

  it("does not kill a dead pid and leaves idle sessions alone", () => {
    const t = setup();
    writeSession(t, {});
    writeSession(t, { id: "idle", running: false, state: "answering", pid: undefined });
    t.sessions.recover();
    expect(t.killed).toEqual([]);
    expect(get(t, "old").error).toBe("interrupted");
    expect(get(t, "idle").error).toBeUndefined();
  });

  it("deletes sessions untouched for 30 days in any state, keeping newer ones", () => {
    const t = setup();
    writeSession(t, { id: "ancient", state: "saved", running: false, updatedAt: "2026-10-25T00:00:00.000Z" });
    writeSession(t, { id: "recent", state: "saved", running: false, updatedAt: "2026-10-27T00:00:00.000Z" });
    t.sessions.recover();
    expect(t.sessions.get("ancient")).toBeUndefined();
    expect(t.sessions.get("recent")).toBeDefined();
  });

  it("lets retry re-run an interrupted step", async () => {
    const t = setup();
    writeSession(t, { state: "surveying", pid: undefined });
    t.sessions.recover();
    t.queue(ok(surveyOutput));
    t.sessions.retry("old");
    await t.sessions.settled();
    expect(get(t, "old").state).toBe("answering");
  });

  it("writes through a temp file and leaves no tmp files behind", async () => {
    const t = setup();
    await t.reachAnswering();
    expect(readdirSync(t.dir)).toEqual(["sid-1.json"]);
  });
});

describe("parseSessionRequest", () => {
  const prep = { kind: "prep", id: "ENG-142", project: "acme" };

  it("returns a valid prep request", () => {
    expect(parseSessionRequest(prep, ["acme"])).toEqual(prep);
  });

  it("drops fields that are not part of the request", () => {
    expect(parseSessionRequest({ ...prep, extra: "x" }, ["acme"])).toEqual(prep);
  });

  it.each([
    [{ kind: "prep", id: "eng-1", project: "acme" }, /ticket ID/],
    [{ kind: "prep", id: "ENG-1; rm -rf ~", project: "acme" }, /ticket ID/],
    [{ kind: "prep", project: "acme" }, /ticket ID/],
    [{ kind: "prep", id: 142, project: "acme" }, /ticket ID/],
    [{ kind: "prep", id: "ENG-1", project: "nope" }, /unknown project/],
    [{ kind: "prep", id: "ENG-1" }, /unknown project/],
    [{ kind: "prep", id: "ENG-1", project: ["acme"] }, /unknown project/],
    [{ kind: "tonight" }, /kind/],
    [{ kind: "shell" }, /kind/],
    [{ kind: "prep ", id: "ENG-1", project: "acme" }, /kind/],
    [null, /kind/],
    ["prep", /kind/],
    [[], /kind/],
  ])("rejects %j", (body, reason) => {
    expect(() => parseSessionRequest(body, ["acme"])).toThrow(reason);
  });
});

describe("skillPrompt, shellQuote and fallbackCommand", () => {
  const prep = { kind: "prep", id: "ENG-142", project: "acme" } as const;

  it("names the skill and its arguments", () => {
    expect(skillPrompt(prep)).toBe("/prep ENG-142 acme");
    expect(skillPrompt({ kind: "tonight" })).toBe("/tonight");
  });

  it("single-quotes and escapes embedded quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("builds a cd and claude command", () => {
    expect(fallbackCommand(prep, "/Users/a/night shift")).toBe(
      "cd '/Users/a/night shift' && claude '/prep ENG-142 acme'",
    );
  });

  it("builds the terminal command for a session", async () => {
    const t = setup();
    const sid = await t.reachAnswering();
    expect(terminalCommand(get(t, sid), "/r")).toBe("cd '/r' && claude '/prep ENG-142 acme'");
  });
});

describe("input parsers", () => {
  const survey: Survey = {
    repo: "app",
    pointers: [],
    gaps: [
      { id: "g1", title: "A", question: "q", recommended: "r", alternative: "a" },
      { id: "g2", title: "B", question: "q", recommended: "r" },
    ],
  };
  const answers = (...list: unknown[]) => ({ answers: list });

  it("parseAnswers returns one answer per gap in gap order", () => {
    expect(
      parseAnswers(
        answers(
          { gapId: "g2", choice: "other", text: "mine", junk: 1 },
          { gapId: "g1", choice: "alternative", text: "ignored" },
        ),
        survey,
      ),
    ).toEqual([
      { gapId: "g1", choice: "alternative" },
      { gapId: "g2", choice: "other", text: "mine" },
    ]);
  });

  it.each([
    ["not an object", null, /answers/],
    ["answers not an array", { answers: "x" }, /answers/],
    ["too few", answers({ gapId: "g1", choice: "recommended" }), /one answer per gap/],
    [
      "too many",
      answers(
        { gapId: "g1", choice: "recommended" },
        { gapId: "g2", choice: "recommended" },
        { gapId: "g2", choice: "recommended" },
      ),
      /one answer per gap/,
    ],
    [
      "duplicate gap",
      answers({ gapId: "g1", choice: "recommended" }, { gapId: "g1", choice: "recommended" }),
      /gap g1/,
    ],
    [
      "unknown gap",
      answers({ gapId: "g1", choice: "recommended" }, { gapId: "g9", choice: "recommended" }),
      /unknown gap g9/,
    ],
    [
      "bad choice",
      answers({ gapId: "g1", choice: "nope" }, { gapId: "g2", choice: "recommended" }),
      /choice/,
    ],
    [
      "alternative without one",
      answers({ gapId: "g1", choice: "recommended" }, { gapId: "g2", choice: "alternative" }),
      /no alternative/,
    ],
    [
      "other without text",
      answers({ gapId: "g1", choice: "other" }, { gapId: "g2", choice: "recommended" }),
      /text/,
    ],
    [
      "other with empty text",
      answers({ gapId: "g1", choice: "other", text: "  " }, { gapId: "g2", choice: "recommended" }),
      /text/,
    ],
    [
      "other over 2000",
      answers({ gapId: "g1", choice: "other", text: "x".repeat(2001) }, { gapId: "g2", choice: "recommended" }),
      /text/,
    ],
    ["entry not an object", answers("x", "y"), /answer/],
  ])("parseAnswers rejects %s", (_name, body, reason) => {
    expect(() => parseAnswers(body, survey)).toThrow(reason);
  });

  it("parseAnswers accepts 2000 characters of text", () => {
    const text = "x".repeat(2000);
    expect(
      parseAnswers(answers({ gapId: "g1", choice: "other", text }, { gapId: "g2", choice: "your_call" }), survey)[0],
    ).toEqual({ gapId: "g1", choice: "other", text });
  });

  it("parseFeedback returns 1 to 4000 characters and rejects the rest", () => {
    expect(parseFeedback({ feedback: "tighten" })).toBe("tighten");
    expect(parseFeedback({ feedback: "x".repeat(4000) })).toHaveLength(4000);
    for (const body of [{ feedback: "" }, { feedback: "  " }, { feedback: "x".repeat(4001) }, { feedback: 1 }, {}, null]) {
      expect(() => parseFeedback(body)).toThrow(/feedback/);
    }
  });

  it("parseApproval returns the description and rejects bad ones", () => {
    expect(parseApproval({ description: "text\nmore" })).toBe("text\nmore");
    expect(parseApproval({ description: "x".repeat(60000) })).toHaveLength(60000);
    for (const body of [{ description: "" }, { description: "x".repeat(60001) }, { description: 1 }, {}, null]) {
      expect(() => parseApproval(body)).toThrow(/description/);
    }
  });

  it("parseBlockers returns 1 to 500 single-line characters and rejects the rest", () => {
    expect(parseBlockers({ blockers: " waiting on design " })).toBe("waiting on design");
    expect(parseBlockers({ blockers: "x".repeat(500) })).toHaveLength(500);
    for (const body of [
      { blockers: "" },
      { blockers: "  " },
      { blockers: "x".repeat(501) },
      { blockers: "a\nb" },
      { blockers: "a\rb" },
      { blockers: 1 },
      {},
      null,
    ]) {
      expect(() => parseBlockers(body)).toThrow(/blockers/);
    }
  });
});
