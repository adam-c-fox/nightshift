import { describe, expect, it } from "vitest";
import {
  buildClockOff,
  priorityRank,
  RESET_SOON_MS,
  type ClockOffInput,
  type TicketPr,
} from "../src/dashboard/clock-off.js";
import type { Loaded } from "../src/dashboard/cache.js";
import type { IssueSnapshot, TodoIssue } from "../src/linear.js";
import { descriptionHash, type PrepRecord } from "../src/prep.js";
import type { Ticket } from "../src/types.js";
import type { UsageSummary } from "../src/budget.js";

const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"];

function issue(
  id: string,
  opts: { priority?: number; description?: string; comments?: string[] } = {},
): TodoIssue {
  const priority = opts.priority ?? 3;
  return {
    id: `uuid-${id}`,
    identifier: id,
    title: `Title ${id}`,
    url: `https://linear.app/acme/issue/${id}`,
    priority,
    priorityLabel: PRIORITY_LABELS[priority],
    estimate: 2,
    teamKey: id.split("-")[0],
    description: opts.description ?? "plain description",
    commentCreatedAt: opts.comments ?? [],
  };
}

function ticket(id: string, repo = "api"): Ticket {
  return { id, name: `Tonight ${id}`, context: [], repo };
}

function rec(description: string, extra: Partial<PrepRecord> = {}): PrepRecord {
  return {
    project: "acme",
    preppedAt: "2026-10-06T12:00:00.000Z",
    descHash: descriptionHash(description),
    outcome: "ready",
    ...extra,
  };
}

function snapshot(
  id: string,
  extra: Partial<IssueSnapshot> = {},
): IssueSnapshot {
  return {
    identifier: id,
    title: `Snap ${id}`,
    url: `https://linear.app/acme/issue/${id}`,
    state: "Todo",
    assignedToMe: true,
    description: "plain description",
    commentCreatedAt: [],
    ...extra,
  };
}

const ok = <T>(value: T): Loaded<T> => ({ ok: true, value });
const fail = (error: string): Loaded<never> => ({ ok: false, error });

const now = new Date("2026-10-07T20:00:00Z");
const project = { name: "acme", allowancePercent: 15, linearTeams: ["DEMO"] };
const usage: UsageSummary = { weeklyPercent: 40, resetInfo: "Oct 12" };

function input(overrides: Partial<ClockOffInput> = {}): ClockOffInput {
  return {
    project,
    todo: ok([]),
    tonight: ok({ tickets: [] }),
    snapshots: ok({}),
    prep: {},
    prs: ok({}),
    usage: ok(usage),
    now,
    ...overrides,
  };
}

const codes = (view: ReturnType<typeof buildClockOff>) =>
  view.warnings.map((w) => [w.code, w.ticketId]);

describe("priorityRank", () => {
  it("keeps 1..4 and sends none to last", () => {
    expect([1, 2, 3, 4, 0].map(priorityRank)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("buildClockOff rows", () => {
  it("lists tonight tickets first, then Todo by priority with none last", () => {
    const description = "desc one";
    const view = buildClockOff(
      input({
        todo: ok([
          issue("DEMO-3", { priority: 4 }),
          issue("DEMO-1", { priority: 2, description }),
          issue("DEMO-2", { priority: 0 }),
        ]),
        tonight: ok({ tickets: [ticket("DEMO-2")] }),
        prep: { "DEMO-1": rec(description) },
      }),
    );
    expect(view.rows.map((r) => r.id)).toEqual(["DEMO-2", "DEMO-1", "DEMO-3"]);
    expect(view.rows.map((r) => r.tonightPosition)).toEqual([1, null, null]);
    const demo1 = view.rows[1];
    expect(demo1.prep?.state).toBe("fresh");
    expect(demo1.prepRecord?.descHash).toBe(descriptionHash(description));
    expect(demo1).toMatchObject({
      title: "Title DEMO-1",
      priority: "High",
      priorityRank: 2,
      estimate: 2,
      team: "DEMO",
      inTodo: true,
      linearState: "Todo",
    });
    expect(view.rows[0].repo).toBe("api");
    expect(view.teams).toEqual(["DEMO"]);
    expect(view.project).toBe("acme");
  });

  it("is empty when there is nothing to show", () => {
    const view = buildClockOff(input());
    expect(view.rows).toEqual([]);
    expect(view.warnings).toEqual([]);
  });

  it("shows new comments on the row without a warning", () => {
    const description = "desc";
    const view = buildClockOff(
      input({
        todo: ok([
          issue("A-1", {
            description,
            comments: ["2026-10-07T09:00:00.000Z"],
          }),
        ]),
        tonight: ok({ tickets: [ticket("A-1")] }),
        prep: { "A-1": rec(description) },
      }),
    );
    expect(view.rows[0].prep?.state).toBe("new_comments");
    expect(view.warnings).toEqual([]);
  });
});

describe("buildClockOff allowance", () => {
  it("uses tonight.md when it sets one", () => {
    const view = buildClockOff(
      input({ tonight: ok({ tickets: [], allowance: 40 }) }),
    );
    expect(view.allowance).toEqual({ percent: 40, source: "tonight.md" });
  });

  it("falls back to the project default", () => {
    const view = buildClockOff(input());
    expect(view.allowance).toEqual({
      percent: 15,
      source: "project default",
    });
  });
});

describe("buildClockOff prep warnings", () => {
  it("warns on unprepped, stale and not ready tickets in tonight order", () => {
    const view = buildClockOff(
      input({
        todo: ok([
          issue("A-1"),
          issue("A-2", { description: "changed" }),
          issue("A-3", { description: "d3" }),
          issue("A-4", { description: "## Decisions\n- x" }),
        ]),
        tonight: ok({
          tickets: ["A-1", "A-2", "A-3", "A-4"].map((id) => ticket(id)),
        }),
        prep: {
          "A-2": rec("original"),
          "A-3": rec("d3", { outcome: "not_ready", blockers: "needs spec" }),
        },
      }),
    );
    expect(codes(view)).toEqual([
      ["unprepped", "A-1"],
      ["stale", "A-2"],
      ["not_ready", "A-3"],
    ]);
    expect(view.warnings.map((w) => w.message)).toEqual([
      "A-1 is in tonight.md but hasn't been prepped",
      "A-2's description changed after /prep",
      "A-3 was marked not ready: needs spec",
    ]);
  });

  it("does not warn about prep for tickets that are not in tonight.md", () => {
    const view = buildClockOff(input({ todo: ok([issue("A-1")]) }));
    expect(view.warnings).toEqual([]);
  });
});

describe("buildClockOff tonight tickets outside Todo", () => {
  it("warns by what Linear says and keeps the rows", () => {
    const view = buildClockOff(
      input({
        tonight: ok({ tickets: ["B-1", "B-2", "B-3"].map((id) => ticket(id)) }),
        snapshots: ok({
          "B-1": snapshot("B-1", { state: "In Progress" }),
          "B-2": snapshot("B-2", { assignedToMe: false }),
          "B-3": null,
        }),
      }),
    );
    expect(view.warnings).toEqual([
      {
        code: "not_todo",
        ticketId: "B-1",
        message: "B-1 is in tonight.md but is In Progress in Linear",
      },
      {
        code: "not_assigned",
        ticketId: "B-2",
        message: "B-2 is in tonight.md but isn't assigned to you",
      },
      {
        code: "not_found",
        ticketId: "B-3",
        message: "B-3 is in tonight.md but wasn't found in Linear",
      },
    ]);
    expect(view.rows.map((r) => r.id)).toEqual(["B-1", "B-2", "B-3"]);
    expect(view.rows.every((r) => !r.inTodo)).toBe(true);
    expect(view.rows[0]).toMatchObject({
      linearState: "In Progress",
      title: "Snap B-1",
      prep: { state: "none" },
    });
    expect(view.rows[2]).toMatchObject({
      title: "Tonight B-3",
      prep: null,
    });
    expect(view.rows[2].linearState).toBeUndefined();
  });

  it("computes the prep state from the snapshot description", () => {
    const view = buildClockOff(
      input({
        tonight: ok({ tickets: [ticket("B-1")] }),
        snapshots: ok({
          "B-1": snapshot("B-1", { state: "In Progress", description: "d" }),
        }),
        prep: { "B-1": rec("d") },
      }),
    );
    expect(view.rows[0].prep?.state).toBe("fresh");
  });

  it("stays quiet for a Todo ticket of mine that the team filter hid", () => {
    const view = buildClockOff(
      input({
        tonight: ok({ tickets: [ticket("Z-9")] }),
        snapshots: ok({ "Z-9": snapshot("Z-9", { description: "d" }) }),
        prep: { "Z-9": rec("d") },
      }),
    );
    expect(view.warnings).toEqual([]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({
      id: "Z-9",
      inTodo: false,
      linearState: "Todo",
      tonightPosition: 1,
    });
  });
});

describe("buildClockOff pull requests", () => {
  const withAutoComplete: TicketPr = {
    prId: 7,
    url: "u",
    autoComplete: true,
  };

  it("warns when a PR has auto-complete set", () => {
    const view = buildClockOff(
      input({
        todo: ok([issue("DEMO-1", { description: "d" })]),
        tonight: ok({ tickets: [ticket("DEMO-1")] }),
        prep: { "DEMO-1": rec("d") },
        prs: ok({ "DEMO-1": withAutoComplete }),
      }),
    );
    expect(view.rows[0].pr).toEqual(withAutoComplete);
    expect(view.warnings).toEqual([
      {
        code: "auto_complete",
        ticketId: "DEMO-1",
        message:
          "PR #7 for DEMO-1 has auto-complete set; the runner won't push to it",
      },
    ]);
  });

  it("marks every row unknown when the lookup failed", () => {
    const view = buildClockOff(
      input({
        todo: ok([issue("DEMO-1"), issue("DEMO-2")]),
        tonight: ok({ tickets: [ticket("B-1")] }),
        snapshots: ok({ "B-1": null }),
        prs: fail("az not logged in"),
      }),
    );
    expect(view.rows.map((r) => r.pr)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
    expect(view.prError).toBe("az not logged in");
    expect(view.warnings.some((w) => w.code === "auto_complete")).toBe(false);
  });

  it.each<[string, TicketPr | null | "unknown", TicketPr | null | "unknown"]>([
    ["no PR", null, null],
    [
      "a PR",
      { prId: 3, url: "u", autoComplete: false },
      { prId: 3, url: "u", autoComplete: false },
    ],
    ["an unknown repo list", "unknown", "unknown"],
  ])("passes %s through to the row", (_name, given, expected) => {
    const view = buildClockOff(
      input({
        todo: ok([issue("DEMO-1")]),
        tonight: ok({ tickets: [ticket("DEMO-1")] }),
        prep: { "DEMO-1": rec("plain description") },
        prs: ok({ "DEMO-1": given }),
      }),
    );
    expect(view.rows[0].pr).toEqual(expected);
    expect(view.warnings).toEqual([]);
    expect(view.prError).toBeUndefined();
  });

  it("treats a missing entry as no PR", () => {
    const view = buildClockOff(input({ todo: ok([issue("DEMO-1")]) }));
    expect(view.rows[0].pr).toBeNull();
  });
});

describe("buildClockOff usage reset", () => {
  const withReset = (resetAtIso?: string) =>
    buildClockOff(
      input({
        usage: ok({
          weeklyPercent: 70,
          resetInfo: "Oct 8",
          ...(resetAtIso ? { resetAtIso } : {}),
        }),
      }),
    );

  it("warns when the weekly window resets within a day", () => {
    const view = withReset("2026-10-08T10:00:00.000Z");
    expect(view.usage).toEqual({
      ok: true,
      value: {
        weeklyPercent: 70,
        resetInfo: "Oct 8",
        resetAt: "2026-10-08T10:00:00.000Z",
        resetSoon: true,
      },
    });
    expect(view.warnings).toEqual([
      {
        code: "reset_soon",
        message: "Weekly usage resets in 14h; consider allowance: 100",
      },
    ]);
    expect(RESET_SOON_MS).toBe(86_400_000);
  });

  it("does not warn when the reset is further away", () => {
    const view = withReset("2026-10-09T02:00:00.000Z");
    expect(view.warnings).toEqual([]);
    expect(view.usage.ok && view.usage.value.resetSoon).toBe(false);
  });

  it("does not warn when the reset time is unknown", () => {
    const view = withReset();
    expect(view.warnings).toEqual([]);
    expect(view.usage.ok && view.usage.value.resetAt).toBeUndefined();
  });

  it("does not warn when the reset time has already passed", () => {
    expect(withReset("2026-10-07T19:00:00.000Z").warnings).toEqual([]);
  });

  it("passes the codex usage and its error through", () => {
    const codex = { weeklyPercent: 7, resetInfo: "Oct 10" };
    expect(buildClockOff(input({ usage: ok({ ...usage, codex }) })).usage).toMatchObject({ ok: true, value: { codex } });
    expect(buildClockOff(input({ usage: ok({ ...usage, codexError: "no login" }) })).usage).toMatchObject({ ok: true, value: { codexError: "no login" } });
  });

  it("leaves codex out when the usage has none", () => {
    const view = buildClockOff(input());
    expect(view.usage.ok && view.usage.value).not.toHaveProperty("codex");
    expect(view.usage.ok && view.usage.value).not.toHaveProperty("codexError");
  });

  it("passes a usage failure through without a warning", () => {
    const view = buildClockOff(input({ usage: fail("x") }));
    expect(view.usage).toEqual({ ok: false, error: "x" });
    expect(view.warnings).toEqual([]);
  });
});

describe("buildClockOff warning order", () => {
  it("lists tonight.md warnings, then auto-complete, then reset", () => {
    const view = buildClockOff(
      input({
        todo: ok([issue("A-1"), issue("A-2", { description: "d" })]),
        tonight: ok({ tickets: [ticket("A-2"), ticket("A-1")] }),
        prep: { "A-2": rec("other") },
        prs: ok({ "A-1": { prId: 1, url: "u", autoComplete: true } }),
        usage: ok({
          weeklyPercent: 1,
          resetInfo: "soon",
          resetAtIso: "2026-10-08T00:00:00.000Z",
        }),
      }),
    );
    expect(view.warnings.map((w) => w.code)).toEqual([
      "stale",
      "unprepped",
      "auto_complete",
      "reset_soon",
    ]);
  });
});

describe("buildClockOff when Linear is unavailable", () => {
  it("still lists tonight.md tickets with their prep records", () => {
    const view = buildClockOff(
      input({
        todo: fail("LINEAR_API_KEY is not set"),
        snapshots: fail("LINEAR_API_KEY is not set"),
        tonight: ok({ tickets: [ticket("C-1"), ticket("C-2", "web")] }),
        prep: { "C-1": rec("d", { outcome: "ready", repo: "api" }) },
      }),
    );
    expect(view.linearError).toBe("LINEAR_API_KEY is not set");
    expect(view.rows.map((r) => r.id)).toEqual(["C-1", "C-2"]);
    expect(view.rows.map((r) => r.title)).toEqual([
      "Tonight C-1",
      "Tonight C-2",
    ]);
    expect(view.rows.map((r) => r.prep)).toEqual([null, null]);
    expect(view.rows[0].prepRecord).toBeDefined();
    expect(view.rows[1].prepRecord).toBeUndefined();
    expect(view.rows.map((r) => r.repo)).toEqual(["api", "web"]);
    expect(view.rows.map((r) => r.inTodo)).toEqual([false, false]);
    expect(view.warnings).toEqual([]);
  });

  it("reports a snapshot failure when tonight tickets are missing from Todo", () => {
    const view = buildClockOff(
      input({
        todo: ok([issue("C-1")]),
        snapshots: fail("boom"),
        tonight: ok({ tickets: [ticket("C-1"), ticket("C-2")] }),
      }),
    );
    expect(view.linearError).toBe("boom");
    expect(view.rows.map((r) => r.id)).toEqual(["C-1", "C-2"]);
    expect(view.rows[1].prep).toBeNull();
    expect(codes(view)).toEqual([["unprepped", "C-1"]]);
  });

  it("ignores a snapshot failure when every tonight ticket is in Todo", () => {
    const view = buildClockOff(
      input({
        todo: ok([issue("C-1")]),
        snapshots: fail("boom"),
        tonight: ok({ tickets: [ticket("C-1")] }),
      }),
    );
    expect(view.linearError).toBeUndefined();
  });
});

describe("buildClockOff when tonight.md does not parse", () => {
  it("still lists Todo rows and shows the parse error", () => {
    const error = 'Ticket X-1: unknown repo "web"';
    const view = buildClockOff(
      input({
        todo: ok([issue("DEMO-1"), issue("DEMO-2", { priority: 1 })]),
        tonight: fail(error),
        prep: { "DEMO-1": rec("plain description") },
      }),
    );
    expect(view.tonightError).toBe(error);
    expect(view.rows.map((r) => r.id)).toEqual(["DEMO-2", "DEMO-1"]);
    expect(view.rows.map((r) => r.tonightPosition)).toEqual([null, null]);
    expect(view.warnings).toEqual([]);
    expect(view.allowance).toEqual({
      percent: 15,
      source: "project default",
    });
  });
});

describe("buildClockOff without team filter", () => {
  it("omits teams", () => {
    const view = buildClockOff(
      input({ project: { name: "acme", allowancePercent: 15 } }),
    );
    expect(view.teams).toBeUndefined();
  });
});
