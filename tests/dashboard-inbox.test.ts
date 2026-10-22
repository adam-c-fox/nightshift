import { describe, expect, it } from "vitest";
import { budgetUsedPct, openNightBudget } from "../src/budget.js";
import {
  buildInbox,
  INBOX_STATUSES,
  nightRows,
  prRefs,
  type InboxItem,
  type NightData,
  type PrLive,
} from "../src/dashboard/inbox.js";
import type { ActionsStore } from "../src/dashboard/actions.js";
import { REPORT_BASE } from "../src/report.js";
import type {
  NightRecord,
  PostmortemSuggestion,
  SessionPostmortem,
  TicketResult,
} from "../src/types.js";

const U1 = "https://dev.azure.com/o/p/_git/web/pullrequest/11";
const U3 = "https://dev.azure.com/o/p/_git/web/pullrequest/13";

const ticket = (
  id: string,
  status: TicketResult["status"],
  over: Partial<TicketResult> = {},
): TicketResult => ({
  ticket: { id, name: `Ticket ${id}`, context: [], repo: "web" },
  linear: null,
  status,
  summary: `Summary ${id}`,
  filesCreated: [],
  filesModified: [],
  tests: [],
  verifyCommands: [],
  notes: "",
  followups: [],
  worktreePath: "/w",
  branch: "b",
  durationSec: 1,
  ...over,
});

const suggestion = (id: string): PostmortemSuggestion => ({
  id,
  target: "AGENTS.md",
  tickets: [],
  problem: "p",
  cause: "c",
  change: "x",
});

const record = (
  tickets: TicketResult[],
  over: Partial<NightRecord> = {},
): NightRecord => ({
  date: "2026-10-02",
  startedAt: "",
  endedAt: "",
  tickets,
  budget: {
    ...openNightBudget({ weeklyPercent: 3, resetInfo: "Oct 7" }, 15),
    currentPct: 8.25,
  },
  gateHit: false,
  skipReason: "",
  noTasks: false,
  startedAtIso: "2026-10-02T06:00:00.000Z",
  endedAtIso: "2026-10-02T08:30:00.000Z",
  dryRun: false,
  ...over,
});

const night = (
  reportId: string,
  rec: NightRecord | null,
  error?: string,
): NightData => {
  const parts = reportId.split("/");
  const base = parts[parts.length - 1];
  const match = REPORT_BASE.exec(base)!;
  return {
    file: {
      reportId,
      project: parts.length === 2 ? parts[0] : "legacy",
      base,
      date: match[1],
      seq: Number(match[2] ?? 0),
      htmlFile: `/r/${reportId}.html`,
      jsonFile: rec ? `/r/${reportId}.json` : null,
      href: `/reports/${reportId}.html`,
    },
    record: rec,
    ...(error ? { error } : {}),
  };
};

const postmortem = (...ids: string[]): SessionPostmortem => ({
  outcome: "done",
  suggestions: ids.map(suggestion),
});

const N2_ID = "acme/nightshift-2026-10-02";
const N1_ID = "acme/nightshift-2026-10-01";

const n2 = (over: Partial<NightRecord> = {}) =>
  night(
    N2_ID,
    record(
      [
        ticket("ENG-1", "done", { prUrl: U1, prId: 11 }),
        ticket("ENG-2", "needs_review"),
        ticket("ENG-3", "partial", { prUrl: U3, prId: 13 }),
      ],
      { postmortem: postmortem("P1", "P2"), ...over },
    ),
  );

const n1 = () =>
  night(
    N1_ID,
    record(
      [
        ticket("ENG-1", "needs_review", { prUrl: U1, prId: 11 }),
        ticket("ENG-4", "error"),
        ticket("ENG-5", "skipped"),
      ],
      {
        date: "2026-10-01",
        startedAtIso: "2026-10-01T06:00:00.000Z",
        endedAtIso: "2026-10-01T07:00:00.000Z",
      },
    ),
  );

const activePr: PrLive = {
  state: "active",
  autoComplete: false,
  isDraft: false,
  votes: { approved: 1, waiting: 0, rejected: 0 },
  ci: "succeeded",
};

const prLive = (url: string): PrLive =>
  url === U1
    ? activePr
    : url === U3
      ? { state: "closed" }
      : { state: "unknown", reason: "?" };

const keys = (items: InboxItem[]) =>
  items.map((item) => `${item.reportId.split("/")[1].slice(-5)} ${item.key}`);

describe("INBOX_STATUSES", () => {
  it("lists the statuses that need attention", () => {
    expect(INBOX_STATUSES).toEqual(["needs_review", "partial", "error"]);
  });
});

describe("buildInbox", () => {
  it("lists attention items newest first", () => {
    expect(keys(buildInbox([n2(), n1()], {}, prLive))).toEqual([
      "10-02 ticket:ENG-1",
      "10-02 ticket:ENG-2",
      "10-02 postmortem:P1",
      "10-02 postmortem:P2",
      "10-01 ticket:ENG-4",
    ]);
  });

  it("fills ticket and postmortem items", () => {
    const items = buildInbox([n2()], {}, prLive);
    expect(items[0]).toEqual({
      kind: "ticket",
      reportId: N2_ID,
      project: "acme",
      date: "2026-10-02",
      key: "ticket:ENG-1",
      reportHref: `/reports/${N2_ID}.html`,
      ticketId: "ENG-1",
      name: "Ticket ENG-1",
      status: "done",
      summary: "Summary ENG-1",
      prUrl: U1,
      prId: 11,
      pr: activePr,
    });
    expect(items[2]).toMatchObject({
      kind: "postmortem",
      key: "postmortem:P1",
      suggestion: suggestion("P1"),
    });
  });

  it("drops ticked items and keeps null ticks", () => {
    const entry = { at: "x", updatedAt: "x" };
    const actions: ActionsStore = {
      [N2_ID]: {
        "ticket:ENG-2": entry,
        "postmortem:P1": entry,
        "ticket:ENG-1": { at: null, updatedAt: "x" },
      },
    };
    expect(keys(buildInbox([n2(), n1()], actions, prLive))).toEqual([
      "10-02 ticket:ENG-1",
      "10-02 postmortem:P2",
      "10-01 ticket:ENG-4",
    ]);
  });

  it("keeps an item whose live PR state is unknown", () => {
    const items = buildInbox([n2()], {}, () => ({
      state: "unknown",
      reason: "az down",
    }));
    const first = items.find((item) => item.key === "ticket:ENG-3");
    expect(first).toMatchObject({
      pr: { state: "unknown", reason: "az down" },
    });
  });

  it("omits suggestions when the postmortem failed", () => {
    const failed = n2({ postmortem: { outcome: "failed", suggestions: [] } });
    expect(
      buildInbox([failed], {}, prLive).filter((i) => i.kind === "postmortem"),
    ).toEqual([]);
  });

  it("omits suggestions of a postmortem that is not done", () => {
    const skipped = n2({
      postmortem: { outcome: "skipped", suggestions: [suggestion("P1")] },
    });
    expect(
      buildInbox([skipped], {}, prLive).filter((i) => i.kind === "postmortem"),
    ).toEqual([]);
  });

  it("ignores dry runs and link-only nights", () => {
    const dry = n2({ dryRun: true });
    const linkOnly = night("acme/nightshift-2026-10-03", null);
    expect(buildInbox([linkOnly, dry], {}, prLive)).toEqual([]);
  });

  it("drops tickets whose PR is closed", () => {
    const items = buildInbox([n2()], {}, () => ({ state: "closed" }));
    expect(keys(items)).toEqual([
      "10-02 ticket:ENG-2",
      "10-02 postmortem:P1",
      "10-02 postmortem:P2",
    ]);
  });
});

describe("prRefs", () => {
  it("lists each PR once, newest first, skipping dry runs", () => {
    expect(prRefs([n2(), n1()])).toEqual([
      { url: U1, prId: 11, repo: "web", project: "acme" },
      { url: U3, prId: 13, repo: "web", project: "acme" },
    ]);
    expect(prRefs([n2({ dryRun: true }), n1()])).toEqual([
      { url: U1, prId: 11, repo: "web", project: "acme" },
    ]);
  });

  it("skips link-only nights", () => {
    expect(prRefs([night("acme/nightshift-2026-10-03", null)])).toEqual([]);
  });
});

describe("nightRows", () => {
  const legacy = night("nightshift-2026-09-01", null);
  const broken = night("acme/nightshift-2026-09-02", null, "Unexpected token");

  it("summarises recorded nights", () => {
    const nights = [n2(), n1(), legacy];
    const rows = nightRows(nights, buildInbox(nights, {}, prLive));
    const row = rows[0];
    expect(row).toMatchObject({
      reportId: N2_ID,
      project: "acme",
      date: "2026-10-02",
      href: `/reports/${N2_ID}.html`,
      linkOnly: false,
      dryRun: false,
      suggestions: 2,
      outstanding: 4,
      durationSec: 9000,
      counts: { total: 3, done: 1, partial: 1, needsReview: 1, skipped: 0 },
    });
    expect(row.budgetUsedPct).toBe(
      budgetUsedPct((nights[0].record as NightRecord).budget),
    );
    expect(rows[1]).toMatchObject({ outstanding: 1, suggestions: 0 });
  });

  it("marks nights without a record as link-only", () => {
    const nights = [legacy, broken];
    const rows = nightRows(nights, []);
    expect(rows[0]).toEqual({
      reportId: "nightshift-2026-09-01",
      project: "legacy",
      date: "2026-09-01",
      href: "/reports/nightshift-2026-09-01.html",
      linkOnly: true,
      dryRun: false,
    });
    expect(rows[1]).toMatchObject({
      linkOnly: true,
      error: "Unexpected token",
    });
    expect(rows[1].counts).toBeUndefined();
  });

  it("reports the codex usage of a night", () => {
    const base = record([]);
    const codexBudget = { ...openNightBudget({ weeklyPercent: 10, resetInfo: "" }, 20), currentPct: 14 };
    const [row] = nightRows([night(N2_ID, { ...base, codexBudget })], []);
    expect(row.codexUsedPct).toBe(budgetUsedPct(codexBudget));
    expect(row).not.toHaveProperty("codexUnavailable");
  });

  it("reports an unavailable codex budget instead of a percentage", () => {
    const base = record([]);
    const codexBudget = { ...base.budget, unavailable: true };
    const [row] = nightRows([night(N2_ID, { ...base, codexBudget })], []);
    expect(row.codexUnavailable).toBe(true);
    expect(row).not.toHaveProperty("codexUsedPct");
  });

  it("leaves codex out for a night recorded without it", () => {
    const [row] = nightRows([night(N2_ID, record([]))], []);
    expect(row).not.toHaveProperty("codexUsedPct");
    expect(row).not.toHaveProperty("codexUnavailable");
  });

  it("reports an unavailable budget instead of a percentage", () => {
    const base = record([]);
    const unavailable = night(N2_ID, {
      ...base,
      budget: { ...base.budget, unavailable: true },
    });
    const [row] = nightRows([unavailable], []);
    expect(row.budgetUnavailable).toBe(true);
    expect(row).not.toHaveProperty("budgetUsedPct");
  });

  it("flags dry runs", () => {
    const [row] = nightRows([n2({ dryRun: true })], []);
    expect(row.dryRun).toBe(true);
  });

  it("omits the suggestion count when the postmortem did not run", () => {
    const [row] = nightRows([n2({ postmortem: undefined })], []);
    expect(row.suggestions).toBe(0);
  });
});
