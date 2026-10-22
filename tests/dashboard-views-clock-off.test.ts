import { describe, expect, it } from "vitest";
import {
  clockOffErrorHTML,
  clockOffHTML,
  homeHTML,
} from "../src/dashboard/views/clock-off.js";
import { CLIENT_SCRIPT, page } from "../src/dashboard/views/layout.js";
import type { ClockOffRow, ClockOffView } from "../src/dashboard/clock-off.js";

function row(id: string, extra: Partial<ClockOffRow> = {}): ClockOffRow {
  return {
    id,
    title: `Title ${id}`,
    url: `https://linear.app/acme/issue/${id}`,
    priority: "High",
    priorityRank: 2,
    estimate: 2,
    inTodo: true,
    prep: { state: "fresh", preppedAt: "2026-10-01T10:00:00.000Z" },
    tonightPosition: null,
    pr: null,
    ...extra,
  };
}

function view(extra: Partial<ClockOffView> = {}): ClockOffView {
  return {
    project: "acme",
    allowance: { percent: 40, source: "tonight.md" },
    usage: {
      ok: true,
      value: { weeklyPercent: 70, resetInfo: "Oct 8", resetSoon: false },
    },
    rows: [
      row("DEMO-1", {
        tonightPosition: 1,
        pr: { prId: 8, url: "https://dev.azure.com/pr/8", autoComplete: true },
      }),
      row("DEMO-2", { prep: { state: "none" } }),
    ],
    warnings: [
      {
        code: "auto_complete",
        ticketId: "DEMO-1",
        message: "DEMO-1 has auto-complete set on its PR",
      },
    ],
    ...extra,
  };
}

describe("page", () => {
  const html = page({ title: "T", nav: "tonight", body: "<p>x</p>" });

  it("renders the shell with theme, nav and client script", () => {
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    expect(html).toContain("--bg: #0f1117");
    expect(html).toContain('href="/" aria-current="page"');
    expect(html).not.toContain('href="/projects" aria-current="page"');
    expect(html).toContain("X-Nightshift");
    expect(html).toContain("<p>x</p>");
    expect(html).toContain('id="toast"');
  });

  it("marks the projects link current on the projects page", () => {
    const projects = page({ title: "T", nav: "projects", body: "" });
    expect(projects).toContain('href="/projects" aria-current="page"');
  });

  it("ships a client script that parses", () => {
    expect(() => new Function(CLIENT_SCRIPT)).not.toThrow();
  });

  it("sends the CSRF header on every POST and PUT", () => {
    expect(CLIENT_SCRIPT).toContain('"X-Nightshift": "1"');
    expect(CLIENT_SCRIPT).toContain("/api/launch");
    expect(CLIENT_SCRIPT).toContain("/api/refresh");
  });
});

describe("clockOffHTML", () => {
  const html = clockOffHTML(view());

  it("shows the allowance, usage, warnings and PR", () => {
    expect(html).toContain(
      "Tonight's allowance: <strong>40%</strong> (tonight.md)",
    );
    expect(html).toContain("70%");
    expect(html).toContain("Oct 8");
    expect(html).toContain('data-code="auto_complete"');
    expect(html).toContain("#1");
    expect(html).toContain("#8");
    expect(html).toContain("auto-complete");
  });

  it("links the ticket to Linear in a new tab", () => {
    expect(html).toContain('href="https://linear.app/acme/issue/DEMO-1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });

  it("renders launch buttons with escaped JSON", () => {
    expect(html).toContain(
      'data-launch="{&quot;kind&quot;:&quot;prep&quot;,&quot;id&quot;:&quot;DEMO-1&quot;,&quot;project&quot;:&quot;acme&quot;}"',
    );
    expect(html).toContain(
      'data-launch="{&quot;kind&quot;:&quot;tonight&quot;,&quot;project&quot;:&quot;acme&quot;}"',
    );
  });

  it("labels every cell for the stacked mobile layout", () => {
    for (const label of [
      "ID",
      "Title",
      "Priority",
      "Est.",
      "Prep",
      "Tonight",
      "PR",
    ]) {
      expect(html).toContain(`data-label="${label}"`);
    }
  });

  it("colours the prep badge by state", () => {
    expect(html).toContain("#22c55e");
    expect(html).toContain("fresh");
    expect(html).toContain("none");
  });

  it("escapes Linear titles", () => {
    const out = clockOffHTML(
      view({ rows: [row("DEMO-1", { title: "<img onerror=x>" })] }),
    );
    expect(out).toContain("&lt;img onerror=x&gt;");
    expect(out).not.toContain("<img onerror=x>");
  });

  it("escapes attribute values", () => {
    const out = clockOffHTML(
      view({
        rows: [row("DEMO-1", { url: 'https://x/"onmouseover="y' })],
      }),
    );
    expect(out).not.toContain('"onmouseover="y');
  });

  it("shows Linear unavailable with the recorded prep state", () => {
    const out = clockOffHTML(
      view({
        linearError: "LINEAR_API_KEY is not set",
        rows: [
          row("DEMO-1", {
            prep: null,
            prepRecord: {
              project: "acme",
              preppedAt: "2026-10-01T10:00:00.000Z",
              descHash: "h",
              outcome: "ready",
            },
          }),
          row("DEMO-2", { prep: null }),
        ],
      }),
    );
    expect(out).toContain(
      "Linear unavailable: LINEAR_API_KEY is not set. Showing tonight.md only.",
    );
    expect(out).toContain("recorded: ready");
    expect(out).toContain(">?<");
  });

  it("shows tonight.md and PR errors", () => {
    const out = clockOffHTML(
      view({ tonightError: "unknown repo", prError: "az not logged in" }),
    );
    expect(out).toContain("tonight.md has a problem: unknown repo");
    expect(out).toContain("PR status unavailable: az not logged in");
  });

  it("shows codex weekly usage with its nightly allowance", () => {
    const out = clockOffHTML(view({ usage: { ok: true, value: { weeklyPercent: 70, resetInfo: "Oct 8", resetSoon: false, codex: { weeklyPercent: 7.4, resetInfo: "Oct 10" } } } }));
    expect(out).toContain("Codex weekly: <strong>7%</strong> used · resets Oct 10 · 20% a night");
  });

  it("shows codex usage unavailable", () => {
    const out = clockOffHTML(view({ usage: { ok: true, value: { weeklyPercent: 70, resetInfo: "Oct 8", resetSoon: false, codexError: "not logged in" } } }));
    expect(out).toContain('<span class="dim">Codex usage unavailable: not logged in</span>');
  });

  it("shows nothing about codex without codex usage", () => {
    expect(clockOffHTML(view())).not.toContain("Codex");
  });

  it("shows usage unavailable", () => {
    const out = clockOffHTML(
      view({ usage: { ok: false, error: "no credentials" } }),
    );
    expect(out).toContain("Usage unavailable: no credentials");
  });

  it("marks PR lookups that failed and rows outside Todo", () => {
    const out = clockOffHTML(
      view({
        rows: [
          row("DEMO-3", {
            pr: "unknown",
            inTodo: false,
            linearState: "In Progress",
          }),
        ],
      }),
    );
    expect(out).toContain("not-todo");
    expect(out).toContain("In Progress");
    expect(out).toContain('title="PR status unknown"');
  });

  it("shows the project default allowance and teams", () => {
    const out = clockOffHTML(
      view({
        allowance: { percent: 25, source: "project default" },
        teams: ["DEMO"],
      }),
    );
    expect(out).toContain("(project default)");
    expect(out).toContain("Teams: DEMO");
  });

  it("shows the empty state", () => {
    const out = clockOffHTML(view({ rows: [], warnings: [], teams: ["DEMO"] }));
    expect(out).toContain("No Todo tickets assigned to you in DEMO");
    expect(out).not.toContain('class="tickets"');
  });

  it("omits the empty state when Linear is down", () => {
    const out = clockOffHTML(view({ rows: [], linearError: "down" }));
    expect(out).not.toContain("No Todo tickets");
  });
});

describe("homeHTML", () => {
  it("offers project creation when there are no projects", () => {
    const html = homeHTML({ projects: [], selected: undefined });
    expect(html).toContain("/projects/new");
    expect(html).not.toContain("data-fragment=");
  });

  it("renders the select and fragment slots", () => {
    const html = homeHTML({ projects: ["acme", "beta"], selected: "acme" });
    expect(html).toContain('data-fragment="/fragments/clock-off?project=acme"');
    expect(html).toContain('data-poll="30"');
    expect(html).toContain('data-fragment="/fragments/runs"');
    expect(html).toContain('data-fragment="/fragments/inbox"');
    expect(html).toContain('data-fragment="/fragments/nights"');
    expect(html).toContain('<option value="acme" selected>');
    expect(html).toContain("Loading tickets…");
  });

  it("defaults to the first project", () => {
    const html = homeHTML({ projects: ["acme", "beta"], selected: undefined });
    expect(html).toContain("project=acme");
  });

  it("encodes the project in the fragment URL", () => {
    const html = homeHTML({ projects: ["a&b"], selected: "a&b" });
    expect(html).toContain("project=a%26b");
  });
});

describe("clockOffErrorHTML", () => {
  it("links to the project page", () => {
    const html = clockOffErrorHTML("acme", "bad");
    expect(html).toContain('href="/projects/acme"');
    expect(html).toContain("Project &quot;acme&quot; can't be loaded: bad");
  });
});
