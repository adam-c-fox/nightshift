import { describe, expect, it } from "vitest";
import {
  formatDuration,
  inboxHTML,
  nightsHTML,
  runBannerHTML,
} from "../src/dashboard/views/morning.js";
import type { InboxItem, NightRow } from "../src/dashboard/inbox.js";
import type { ProjectRun, RunHeartbeat } from "../src/heartbeat.js";

const REPORT_ID = "acme/nightshift-2026-10-02";
const REPORT_HREF = "/reports/acme/nightshift-2026-10-02.html";

function heartbeat(extra: Partial<RunHeartbeat> = {}): RunHeartbeat {
  return {
    pid: 4242,
    base: "nightshift-2026-10-02",
    startedAtIso: "2026-10-02T01:00:00.000Z",
    ticketIndex: 2,
    total: 5,
    ticketId: "DEMO-4",
    phase: "ticket",
    heartbeatAt: "2026-10-02T02:04:00.000Z",
    ...extra,
  };
}

function run(
  state: "running" | "stale",
  hb = heartbeat(),
  sinceHeartbeatMs = 30_000,
): ProjectRun {
  return {
    project: "acme",
    view: { state, heartbeat: hb, elapsedMs: 65 * 60_000, sinceHeartbeatMs },
  };
}

function ticketItem(extra: Partial<InboxItem> = {}): InboxItem {
  return {
    kind: "ticket",
    reportId: REPORT_ID,
    project: "acme",
    date: "2026-10-02",
    key: "ticket:DEMO-9",
    reportHref: REPORT_HREF,
    ticketId: "DEMO-9",
    name: "Fix the exporter",
    status: "needs_review",
    summary: "Stopped early",
    prUrl: "https://dev.azure.com/pr/9",
    prId: 9,
    pr: {
      state: "active",
      autoComplete: true,
      isDraft: false,
      votes: { approved: 1, waiting: 0, rejected: 1 },
      ci: "failed",
    },
    ...extra,
  } as InboxItem;
}

const postmortemItem: InboxItem = {
  kind: "postmortem",
  reportId: REPORT_ID,
  project: "acme",
  date: "2026-10-02",
  key: "postmortem:P1",
  reportHref: REPORT_HREF,
  suggestion: {
    id: "P1",
    target: "AGENTS.md",
    tickets: ["DEMO-9"],
    problem: "Tests were skipped",
    cause: "unclear",
    change: "Require a red run",
  },
};

function night(extra: Partial<NightRow> = {}): NightRow {
  return {
    reportId: REPORT_ID,
    project: "acme",
    date: "2026-10-02",
    href: REPORT_HREF,
    linkOnly: false,
    dryRun: false,
    counts: { total: 9, done: 5, partial: 2, needsReview: 1, skipped: 1 },
    budgetUsedPct: 42,
    durationSec: 9000,
    suggestions: 3,
    outstanding: 2,
    ...extra,
  };
}

describe("formatDuration", () => {
  it("formats minutes, hours and sub-minute spans", () => {
    expect(formatDuration(65_000)).toBe("1m");
    expect(formatDuration(3_900_000)).toBe("1h 05m");
    expect(formatDuration(30_000)).toBe("<1m");
  });
});

describe("runBannerHTML", () => {
  it("renders nothing without runs", () => {
    expect(runBannerHTML([])).toBe("");
  });

  it("shows ticket, position and elapsed time for a running run", () => {
    const html = runBannerHTML([run("running")]);
    expect(html).toContain('class="run-banner"');
    expect(html).toContain("DEMO-4");
    expect(html).toContain("2 of 5");
    expect(html).toContain("1h 05m");
    expect(html).toContain("acme");
  });

  it("says starting during the starting phase", () => {
    const html = runBannerHTML([
      run("running", heartbeat({ phase: "starting", ticketId: null })),
    ]);
    expect(html).toContain("starting");
  });

  it("flags a stale run with last heartbeat and pid", () => {
    const html = runBannerHTML([run("stale", heartbeat(), 600_000)]);
    expect(html).toContain('class="run-banner stale"');
    expect(html).toContain("looks stopped");
    expect(html).toContain("10m ago");
    expect(html).toContain("pid 4242");
  });

  it("skips idle projects", () => {
    expect(runBannerHTML([{ project: "acme", view: { state: "idle" } }])).toBe(
      "",
    );
  });

  it("escapes the project name", () => {
    const html = runBannerHTML([{ ...run("running"), project: "<b>x</b>" }]);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("inboxHTML", () => {
  it("says when nothing is outstanding", () => {
    expect(inboxHTML([])).toBe('<p class="empty">Nothing outstanding.</p>');
  });

  it("renders a tick box wired to the report and action key", () => {
    const html = inboxHTML([ticketItem()]);
    expect(html).toContain('<ul class="inbox">');
    expect(html).toContain('<li class="inbox-item">');
    expect(html).toContain('class="inbox-tick"');
    expect(html).toContain(`data-report="${REPORT_ID}"`);
    expect(html).toContain('data-key="ticket:DEMO-9"');
    expect(html).toContain('aria-label="Mark DEMO-9 actioned"');
  });

  it("renders the PR with CI, votes and auto-complete", () => {
    const html = inboxHTML([ticketItem()]);
    expect(html).toContain(`href="${REPORT_HREF}#ticket-DEMO-9"`);
    expect(html).toContain('href="https://dev.azure.com/pr/9"');
    expect(html).toContain("PR #9");
    expect(html).toContain("CI failed");
    expect(html).toContain("✓1");
    expect(html).toContain("⏳0");
    expect(html).toContain("✗1");
    expect(html).toContain("auto-complete");
    expect(html).toContain("#f97316");
  });

  it("labels pending, missing and unknown CI", () => {
    const withCi = (ci: "pending" | "none" | "unknown") =>
      inboxHTML([
        ticketItem({
          pr: {
            state: "active",
            autoComplete: false,
            isDraft: true,
            votes: { approved: 0, waiting: 0, rejected: 0 },
            ci,
          },
        } as Partial<InboxItem>),
      ]);
    expect(withCi("pending")).toContain("CI pending");
    expect(withCi("none")).toContain("no CI");
    expect(withCi("unknown")).toContain("CI unknown");
    expect(withCi("pending")).toContain("draft");
    expect(withCi("pending")).not.toContain("auto-complete");
  });

  it("shows why PR status is unknown", () => {
    const html = inboxHTML([
      ticketItem({
        pr: { state: "unknown", reason: "az not signed in" },
      } as Partial<InboxItem>),
    ]);
    expect(html).toContain("PR #9 · status unknown (az not signed in)");
  });

  it("renders a ticket without a PR", () => {
    const html = inboxHTML([
      ticketItem({ prUrl: undefined, prId: undefined, pr: undefined }),
    ]);
    expect(html).toContain("DEMO-9");
    expect(html).not.toContain("PR #");
  });

  it("renders postmortem items", () => {
    const html = inboxHTML([postmortemItem]);
    expect(html).toContain('data-key="postmortem:P1"');
    expect(html).toContain(`href="${REPORT_HREF}#postmortem"`);
    expect(html).toContain("postmortem");
    expect(html).toContain("AGENTS.md");
    expect(html).toContain("Tests were skipped");
    expect(html).toContain("Change: Require a red run");
  });

  it("escapes summaries", () => {
    const html = inboxHTML([ticketItem({ summary: "<script>x</script>" })]);
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("truncates long summaries to 160 characters", () => {
    const html = inboxHTML([ticketItem({ summary: "a".repeat(400) })]);
    expect(html).toContain("a".repeat(159) + "…");
    expect(html).not.toContain("a".repeat(161));
  });

  it("escapes the report id and key attributes", () => {
    const html = inboxHTML([ticketItem({ reportId: 'a"b', key: 'k"1' })]);
    expect(html).toContain('data-report="a&quot;b"');
    expect(html).toContain('data-key="k&quot;1"');
  });
});

describe("nightsHTML", () => {
  it("says when there are no reports", () => {
    expect(nightsHTML([])).toBe('<p class="empty">No reports yet.</p>');
  });

  it("renders a full row", () => {
    const html = nightsHTML([night()]);
    expect(html).toContain("2h 30m");
    expect(html.replace(/<[^>]+>/g, "")).toContain("5✓ 2~ 1! 1– / 9");
    expect(html).toContain("42%");
    expect(html).toContain(`href="${REPORT_HREF}"`);
    expect(html).toContain("2026-10-02");
    expect(html).toContain("acme");
    expect(html).toContain("#22c55e");
  });

  it("labels every cell for the stacked mobile layout", () => {
    const html = nightsHTML([night()]);
    for (const label of [
      "Date",
      "Project",
      "Tickets",
      "Budget used",
      "Duration",
      "Suggestions",
      "Outstanding",
      "Report",
    ]) {
      expect(html).toContain(`data-label="${label}"`);
    }
    expect(html).toContain('class="tickets nights"');
  });

  it("renders a link-only legacy row with dashes", () => {
    const html = nightsHTML([
      night({
        project: "legacy",
        linkOnly: true,
        counts: undefined,
        budgetUsedPct: undefined,
        durationSec: undefined,
        suggestions: undefined,
        outstanding: undefined,
      }),
    ]);
    expect(html).toContain("legacy");
    expect(html).toContain("—");
    expect(html).toContain(`href="${REPORT_HREF}"`);
    expect(html).not.toContain("%");
  });

  it("shows unavailable budget", () => {
    const html = nightsHTML([
      night({ budgetUsedPct: undefined, budgetUnavailable: true }),
    ]);
    expect(html).toContain("unavailable");
  });

  it("puts the error in the row title", () => {
    const html = nightsHTML([
      night({ linkOnly: true, error: 'bad "json"', counts: undefined }),
    ]);
    expect(html).toContain('title="bad &quot;json&quot;"');
  });

  it("tags dry runs", () => {
    expect(nightsHTML([night({ dryRun: true })])).toContain("dry run");
    expect(nightsHTML([night()])).not.toContain("dry run");
  });
});
