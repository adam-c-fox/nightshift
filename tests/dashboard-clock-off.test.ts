import { describe, expect, it } from "vitest";
import {
  buildEvening,
  priorityRank,
  RESET_SOON_MS,
  type EveningInput,
  type TicketPr,
} from "../src/dashboard/clock-off.js";
import type { Loaded } from "../src/dashboard/cache.js";
import type { IssueSnapshot, TodoIssue } from "../src/linear.js";
import { descriptionHash, type PrepRecord } from "../src/prep.js";
import type { Project } from "../src/project.js";
import type { Ticket } from "../src/types.js";
import type { UsageSummary } from "../src/budget.js";

const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"];

function issue(
  id: string,
  opts: { priority?: number; description?: string; comments?: string[]; project?: string | null } = {},
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
    projectName: opts.project === undefined ? "Demo" : opts.project,
    description: opts.description ?? "plain description",
    commentCreatedAt: opts.comments ?? [],
  };
}

function ticket(id: string, repo = "api", project = "acme"): Ticket {
  return { id, name: `Tonight ${id}`, context: [], repo, project };
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

function repoConfig(): Project["repos"][string] {
  return { path: "/r", checks: [] } as unknown as Project["repos"][string];
}

const ok = <T>(value: T): Loaded<T> => ({ ok: true, value });
const fail = (error: string): Loaded<never> => ({ ok: false, error });

const now = new Date("2026-10-07T20:00:00Z");
const projects: EveningInput["projects"] = [
  { name: "acme", linearProjects: ["Demo"], repos: { api: repoConfig(), web: repoConfig() }, defaultRepo: "api" },
  { name: "beta", linearProjects: ["Beta"], repos: { app: repoConfig() }, defaultRepo: "app" },
];
const usage: UsageSummary = { weeklyPercent: 40, resetInfo: "Oct 12" };

function input(overrides: Partial<EveningInput> = {}): EveningInput {
  return {
    projects,
    todo: ok([]),
    queue: ok({ tickets: [] }),
    rootAllowance: 15,
    snapshots: ok({}),
    prep: {},
    prs: ok({}),
    openPrs: {},
    usage: ok(usage),
    now,
    ...overrides,
  };
}

const codes = (view: ReturnType<typeof buildEvening>) =>
  view.warnings.map((w) => [w.code, w.ticketId]);

const tab = (view: ReturnType<typeof buildEvening>, name: string) =>
  view.tabs.find((t) => t.project === name)!.rows;

describe("priorityRank", () => {
  it("keeps 1..4 and sends none to last", () => {
    expect([1, 2, 3, 4, 0].map(priorityRank)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("buildEvening queue", () => {
  it("lists queue rows in queue order across projects", () => {
    const view = buildEvening(
      input({
        todo: ok([issue("DEMO-1"), issue("BETA-1", { project: "Beta" })]),
        queue: ok({
          tickets: [ticket("BETA-1", "app", "beta"), ticket("DEMO-1", "web")],
        }),
      }),
    );
    expect(view.queue.map((r) => [r.id, r.project, r.repo, r.position])).toEqual([
      ["BETA-1", "beta", "app", 1],
      ["DEMO-1", "acme", "web", 2],
    ]);
    expect(view.queue[0].repos).toEqual(["app"]);
    expect(view.queue[1].repos).toEqual(["api", "web"]);
  });

  it("keeps rows for queued tickets that are not in Todo", () => {
    const view = buildEvening(
      input({
        queue: ok({ tickets: [ticket("B-1")] }),
        snapshots: ok({ "B-1": snapshot("B-1", { state: "In Progress" }) }),
      }),
    );
    expect(view.queue[0]).toMatchObject({
      id: "B-1",
      inTodo: false,
      linearState: "In Progress",
      title: "Snap B-1",
    });
  });

  it("lists a sweep entry per project with its open PR count", () => {
    const view = buildEvening(input({ openPrs: { acme: ok(2) } }));
    expect(view.sweep).toEqual([
      { project: "acme", openPrs: ok(2) },
      { project: "beta", openPrs: { ok: false, error: "not loaded" } },
    ]);
  });

  it("reports a queue that failed to parse and shows no queue rows", () => {
    const view = buildEvening(input({ queue: fail("unknown project") }));
    expect(view.queue).toEqual([]);
    expect(view.queueError).toBe("unknown project");
  });
});

describe("buildEvening tabs", () => {
  it("puts a Todo ticket only in the tab of the project that owns its Linear project", () => {
    const view = buildEvening(
      input({
        todo: ok([
          issue("DEMO-1"),
          issue("BETA-1", { project: "Beta" }),
        ]),
        queue: ok({ tickets: [ticket("DEMO-1")] }),
      }),
    );
    expect(tab(view, "acme").map((r) => [r.id, r.tonightPosition])).toEqual([
      ["DEMO-1", 1],
    ]);
    expect(tab(view, "beta").map((r) => [r.id, r.tonightPosition])).toEqual([
      ["BETA-1", null],
    ]);
  });

  it("orders a tab by priority with none last", () => {
    const view = buildEvening(
      input({
        todo: ok([
          issue("DEMO-3", { priority: 4 }),
          issue("DEMO-1", { priority: 2 }),
          issue("DEMO-2", { priority: 0 }),
        ]),
      }),
    );
    expect(tab(view, "acme").map((r) => r.id)).toEqual([
      "DEMO-1",
      "DEMO-3",
      "DEMO-2",
    ]);
  });

  it("shows a Todo ticket with no Linear project or an unclaimed one in no tab and warns", () => {
    const view = buildEvening(
      input({
        todo: ok([
          issue("X-1", { project: null }),
          issue("X-2", { project: "Other" }),
        ]),
      }),
    );
    expect(view.tabs.every((t) => t.rows.length === 0)).toBe(true);
    expect(view.warnings).toEqual([
      {
        code: "unmapped",
        ticketId: "X-1",
        message: "X-1 isn't in a Linear project any nightshift project claims (no project)",
      },
      {
        code: "unmapped",
        ticketId: "X-2",
        message: "X-2 isn't in a Linear project any nightshift project claims (Other)",
      },
    ]);
  });

  it("shows new comments on the row without a warning", () => {
    const description = "desc";
    const view = buildEvening(
      input({
        todo: ok([issue("A-1", { description, comments: ["2026-10-07T09:00:00.000Z"] })]),
        queue: ok({ tickets: [ticket("A-1")] }),
        prep: { "A-1": rec(description) },
      }),
    );
    expect(view.queue[0].prep?.state).toBe("new_comments");
    expect(view.warnings).toEqual([]);
  });
});

describe("buildEvening allowance", () => {
  it("uses the queue header when it sets one", () => {
    const view = buildEvening(input({ queue: ok({ tickets: [], allowance: 40 }) }));
    expect(view.allowance).toEqual({ percent: 40, source: "tonight.md" });
  });

  it("falls back to the nightly default", () => {
    const view = buildEvening(input({ rootAllowance: 25 }));
    expect(view.allowance).toEqual({ percent: 25, source: "nightly default" });
  });
});

describe("buildEvening queue warnings", () => {
  it("warns on unprepped, stale and not ready tickets in queue order", () => {
    const view = buildEvening(
      input({
        todo: ok([
          issue("A-1"),
          issue("A-2", { description: "changed" }),
          issue("A-3", { description: "d3" }),
          issue("A-4", { description: "## Decisions\n- x" }),
        ]),
        queue: ok({ tickets: ["A-1", "A-2", "A-3", "A-4"].map((id) => ticket(id)) }),
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
  });

  it("does not warn about prep for tickets that are not queued", () => {
    const view = buildEvening(input({ todo: ok([issue("A-1")]) }));
    expect(view.warnings).toEqual([]);
  });

  it("warns by what Linear says about queued tickets outside Todo, across projects", () => {
    const view = buildEvening(
      input({
        queue: ok({
          tickets: [ticket("B-1"), ticket("B-2", "app", "beta"), ticket("B-3")],
        }),
        snapshots: ok({
          "B-1": snapshot("B-1", { state: "In Progress" }),
          "B-2": snapshot("B-2", { assignedToMe: false }),
          "B-3": null,
        }),
      }),
    );
    expect(codes(view)).toEqual([
      ["not_todo", "B-1"],
      ["not_assigned", "B-2"],
      ["not_found", "B-3"],
    ]);
  });
});

describe("buildEvening pull requests", () => {
  const withAutoComplete: TicketPr = { prId: 7, url: "u", autoComplete: true };

  it("warns once when a queued Todo ticket's PR has auto-complete set", () => {
    const view = buildEvening(
      input({
        todo: ok([issue("DEMO-1", { description: "d" })]),
        queue: ok({ tickets: [ticket("DEMO-1")] }),
        prep: { "DEMO-1": rec("d") },
        prs: ok({ "DEMO-1": withAutoComplete }),
      }),
    );
    expect(view.queue[0].pr).toEqual(withAutoComplete);
    expect(view.warnings).toEqual([
      {
        code: "auto_complete",
        ticketId: "DEMO-1",
        message: "PR #7 for DEMO-1 has auto-complete set; the runner won't push to it",
      },
    ]);
  });

  it("marks every row unknown when the lookup failed", () => {
    const view = buildEvening(
      input({
        todo: ok([issue("DEMO-1")]),
        queue: ok({ tickets: [ticket("DEMO-2")] }),
        snapshots: ok({ "DEMO-2": null }),
        prs: fail("az not logged in"),
      }),
    );
    expect([view.queue[0].pr, tab(view, "acme")[0].pr]).toEqual(["unknown", "unknown"]);
    expect(view.prError).toBe("az not logged in");
  });

  it("treats a missing entry as no PR", () => {
    const view = buildEvening(input({ todo: ok([issue("DEMO-1")]) }));
    expect(tab(view, "acme")[0].pr).toBeNull();
  });
});

describe("buildEvening usage reset", () => {
  const withReset = (resetAtIso?: string) =>
    buildEvening(
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
    expect(buildEvening(input({ usage: ok({ ...usage, codex }) })).usage).toMatchObject({ ok: true, value: { codex } });
    expect(buildEvening(input({ usage: ok({ ...usage, codexError: "no login" }) })).usage).toMatchObject({ ok: true, value: { codexError: "no login" } });
  });

  it("leaves codex out when the usage has none", () => {
    const view = buildEvening(input());
    expect(view.usage.ok && view.usage.value).not.toHaveProperty("codex");
    expect(view.usage.ok && view.usage.value).not.toHaveProperty("codexError");
  });

  it("passes a usage failure through without a warning", () => {
    const view = buildEvening(input({ usage: fail("x") }));
    expect(view.usage).toEqual({ ok: false, error: "x" });
    expect(view.warnings).toEqual([]);
  });
});

describe("buildEvening warning order", () => {
  it("lists tonight.md warnings, then auto-complete, then reset", () => {
    const view = buildEvening(
      input({
        todo: ok([issue("A-1"), issue("A-2", { description: "d" })]),
        queue: ok({ tickets: [ticket("A-2"), ticket("A-1")] }),
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

describe("buildEvening when Linear is unavailable", () => {
  it("still lists tonight.md tickets with their prep records", () => {
    const view = buildEvening(
      input({
        todo: fail("LINEAR_API_KEY is not set"),
        snapshots: fail("LINEAR_API_KEY is not set"),
        queue: ok({ tickets: [ticket("C-1"), ticket("C-2", "web")] }),
        prep: { "C-1": rec("d", { outcome: "ready", repo: "api" }) },
      }),
    );
    expect(view.linearError).toBe("LINEAR_API_KEY is not set");
    expect(view.queue.map((r) => r.id)).toEqual(["C-1", "C-2"]);
    expect(view.queue.map((r) => r.title)).toEqual([
      "Tonight C-1",
      "Tonight C-2",
    ]);
    expect(view.queue.map((r) => r.prep)).toEqual([null, null]);
    expect(view.queue[0].prepRecord).toBeDefined();
    expect(view.queue[1].prepRecord).toBeUndefined();
    expect(view.queue.map((r) => r.repo)).toEqual(["api", "web"]);
    expect(view.queue.map((r) => r.inTodo)).toEqual([false, false]);
    expect(view.warnings).toEqual([]);
  });

  it("reports a snapshot failure when tonight tickets are missing from Todo", () => {
    const view = buildEvening(
      input({
        todo: ok([issue("C-1")]),
        snapshots: fail("boom"),
        queue: ok({ tickets: [ticket("C-1"), ticket("C-2")] }),
      }),
    );
    expect(view.linearError).toBe("boom");
    expect(view.queue.map((r) => r.id)).toEqual(["C-1", "C-2"]);
    expect(view.queue[1].prep).toBeNull();
    expect(codes(view)).toEqual([["unprepped", "C-1"]]);
  });

  it("ignores a snapshot failure when every tonight ticket is in Todo", () => {
    const view = buildEvening(
      input({
        todo: ok([issue("C-1")]),
        snapshots: fail("boom"),
        queue: ok({ tickets: [ticket("C-1")] }),
      }),
    );
    expect(view.linearError).toBeUndefined();
  });
});

describe("buildEvening when the queue does not parse", () => {
  it("still lists Todo rows in tabs and shows the parse error", () => {
    const error = 'Ticket X-1: unknown project "gone"';
    const view = buildEvening(
      input({
        todo: ok([issue("DEMO-1"), issue("DEMO-2", { priority: 1 })]),
        queue: fail(error),
        prep: { "DEMO-1": rec("plain description") },
      }),
    );
    expect(view.queueError).toBe(error);
    expect(view.queue).toEqual([]);
    expect(tab(view, "acme").map((r) => [r.id, r.tonightPosition])).toEqual([
      ["DEMO-2", null],
      ["DEMO-1", null],
    ]);
    expect(view.warnings).toEqual([]);
    expect(view.allowance).toEqual({ percent: 15, source: "nightly default" });
  });
});
