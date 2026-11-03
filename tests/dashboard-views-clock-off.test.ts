import { describe, expect, it } from "vitest";
import {
  eveningErrorHTML,
  eveningHTML,
  homeHTML,
} from "../src/dashboard/views/clock-off.js";
import { CLIENT_SCRIPT, page } from "../src/dashboard/views/layout.js";
import type { ClockOffRow, EveningView, QueueRow } from "../src/dashboard/clock-off.js";

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

function queueRow(id: string, position: number, project: string, repos: string[], extra: Partial<QueueRow> = {}): QueueRow {
  return { ...row(id, { tonightPosition: position }), project, repo: repos[0], repos, position, ...extra };
}

function view(extra: Partial<EveningView> = {}): EveningView {
  return {
    allowance: { percent: 40, source: "tonight.md" },
    usage: {
      ok: true,
      value: { weeklyPercent: 70, resetInfo: "Oct 8", resetSoon: false },
    },
    queue: [
      queueRow("DEMO-1", 1, "acme", ["api", "web"], {
        pr: { prId: 8, url: "https://dev.azure.com/pr/8", autoComplete: true },
      }),
      queueRow("BETA-1", 2, "beta", ["app"]),
    ],
    sweep: [
      { project: "acme", openPrs: { ok: true, value: 2 } },
      { project: "beta", openPrs: { ok: true, value: 0 } },
    ],
    tabs: [
      { project: "acme", rows: [row("DEMO-1", { tonightPosition: 1 }), row("DEMO-2", { prep: { state: "none" } })] },
      { project: "beta", rows: [row("BETA-1", { tonightPosition: 2 }), row("BETA-2")] },
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
    expect(CLIENT_SCRIPT).toContain("/api/queue");
  });
});

describe("eveningHTML", () => {
  const html = eveningHTML(view());
  const at = (needle: string) => html.indexOf(needle);

  it("orders the summary, the queue and the tabs", () => {
    expect(at("Tonight's allowance")).toBeGreaterThan(-1);
    expect(at("Tonight's allowance")).toBeLessThan(at("Tonight's queue"));
    expect(at("data-queue-id")).toBeLessThan(at('aria-label="Projects"'));
    expect(at("PR comment sweep")).toBeLessThan(at("data-queue-id"));
  });

  it("shows the summary with allowance, usage, counts, warnings and the buttons", () => {
    expect(html).toContain("Tonight's allowance: <strong>40%</strong> (tonight.md)");
    expect(html).toContain("70%");
    expect(html).toContain("2 tickets · 2 projects swept");
    expect(html).toContain('data-code="auto_complete"');
    expect(html).toContain("&quot;kind&quot;:&quot;tonight&quot;}");
    expect(html).not.toContain("&quot;kind&quot;:&quot;tonight&quot;,&quot;project");
    expect(html).toContain('data-refresh="all"');
    expect(html).not.toContain('id="project"');
  });

  it("pins a sweep row with each project's open PRs and no handles or move buttons", () => {
    const sweep = html.match(/<tr class="sweep">[\s\S]*?<\/tr>/)![0];
    expect(sweep).toContain("acme");
    expect(sweep).toContain("2 open PRs");
    expect(sweep).toContain("0 open PRs");
    expect(sweep).not.toContain("draggable");
    expect(sweep).not.toContain("data-queue-op");
  });

  it("renders each queue row with its project, repo select and keyboard buttons", () => {
    const first = html.match(/<tr draggable="true" data-queue-id="DEMO-1"[\s\S]*?<\/tr>/)![0];
    expect(first).toContain('data-label="Project"');
    expect(first).toContain(">acme<");
    expect(first).toContain('href="https://linear.app/acme/issue/DEMO-1"');
    expect(first).toContain("Title DEMO-1");
    expect(first).toContain("fresh");
    expect(first).toContain('<option value="api" selected>');
    expect(first).toContain('<option value="web">');
    expect(first).not.toContain('value="app"');
    expect(first).toContain('aria-label="Move DEMO-1 up"');
    expect(first).toContain('aria-label="Move DEMO-1 down"');
    expect(first).toContain('data-queue-op="remove"');
    expect(first).toMatch(/aria-label="Move DEMO-1 up" disabled/);
    expect(html).toMatch(/aria-label="Move BETA-1 down" disabled/);
  });

  it("makes the tabs links with the first project current by default", () => {
    expect(html).toContain('<a href="?tab=acme" aria-current="page">acme (2 Todo)</a>');
    expect(html).toContain('<a href="?tab=beta">beta (2 Todo)</a>');
    expect(html).toContain("DEMO-2");
    expect(html).not.toContain("BETA-2");
  });

  it("shows the selected tab and falls back to the first for an unknown one", () => {
    const beta = eveningHTML(view(), "beta");
    expect(beta).toContain('<a href="?tab=beta" aria-current="page">');
    expect(beta).toContain("BETA-2");
    expect(eveningHTML(view(), "nope")).toContain('<a href="?tab=acme" aria-current="page">');
  });

  it("shows in queue #N or a + add button in a tab", () => {
    expect(html).toContain("in queue #1");
    expect(html).toMatch(/data-queue-op="add" data-id="DEMO-2" data-project="acme">\+ add</);
    expect(html).not.toMatch(/data-queue-op="add" data-id="DEMO-1"/);
  });

  it("renders a prep launch button per tab row with escaped JSON", () => {
    expect(html).toContain(
      'data-launch="{&quot;kind&quot;:&quot;prep&quot;,&quot;id&quot;:&quot;DEMO-2&quot;,&quot;project&quot;:&quot;acme&quot;}"',
    );
  });

  it("labels every cell for the stacked mobile layout", () => {
    for (const label of ["#", "Project", "ID", "Title", "Prep", "Repo", "Action", "Priority", "Est.", "Tonight", "PR"]) {
      expect(html).toContain(`data-label="${label}"`);
    }
  });

  it("colours the prep badge by state", () => {
    expect(html).toContain("#22c55e");
    expect(html).toContain("none");
  });

  it("escapes Linear titles and attribute values", () => {
    const out = eveningHTML(
      view({
        queue: [queueRow("DEMO-1", 1, "acme", ["api"], { title: "<img onerror=x>", url: 'https://x/"onmouseover="y' })],
      }),
    );
    expect(out).toContain("&lt;img onerror=x&gt;");
    expect(out).not.toContain("<img onerror=x>");
    expect(out).not.toContain('"onmouseover="y');
  });

  it("shows the Linear, queue and PR errors", () => {
    const out = eveningHTML(
      view({ linearError: "down", queueError: "unknown project", prError: "az not logged in" }),
    );
    expect(out).toContain("Linear unavailable: down. Showing the queue only.");
    expect(out).toContain("tonight.md has a problem: unknown project");
    expect(out).toContain("PR status unavailable: az not logged in");
  });

  it("shows codex weekly usage with its nightly allowance", () => {
    const out = eveningHTML(view({ usage: { ok: true, value: { weeklyPercent: 70, resetInfo: "Oct 8", resetSoon: false, codex: { weeklyPercent: 7.4, resetInfo: "Oct 10" } } } }));
    expect(out).toContain("Codex weekly: <strong>7%</strong> used · resets Oct 10 · 20% a night");
  });

  it("shows codex usage unavailable and nothing without codex", () => {
    const out = eveningHTML(view({ usage: { ok: true, value: { weeklyPercent: 70, resetInfo: "Oct 8", resetSoon: false, codexError: "not logged in" } } }));
    expect(out).toContain('<span class="dim">Codex usage unavailable: not logged in</span>');
    expect(html).not.toContain("Codex");
  });

  it("shows usage unavailable", () => {
    expect(eveningHTML(view({ usage: { ok: false, error: "no credentials" } }))).toContain("Usage unavailable: no credentials");
  });

  it("marks PR lookups that failed and rows outside Todo", () => {
    const out = eveningHTML(
      view({ queue: [queueRow("DEMO-3", 1, "acme", ["api"], { pr: "unknown", inTodo: false, linearState: "In Progress" })] }),
    );
    expect(out).toContain("not-todo");
    expect(out).toContain("In Progress");
  });

  it("shows empty states", () => {
    const empty = eveningHTML(view({ queue: [], tabs: [{ project: "acme", rows: [] }, { project: "beta", rows: [] }] }));
    expect(empty).toContain("Nothing queued");
    expect(empty).toContain("No Todo tickets assigned to you in acme");
    expect(eveningHTML(view({ tabs: [{ project: "acme", rows: [] }], linearError: "down" }))).not.toContain("No Todo tickets");
  });
});

describe("homeHTML", () => {
  it("points to setup when there are no projects", () => {
    const html = homeHTML({ projects: [] });
    expect(html).toContain("/nightshift-setup");
    expect(html).not.toContain("data-fragment=");
  });

  it("renders the fragment slots without a project picker", () => {
    const html = homeHTML({ projects: ["acme", "beta"] });
    expect(html).toContain('data-fragment="/fragments/evening"');
    expect(html).toContain('data-poll="30"');
    expect(html).toContain('data-fragment="/fragments/runs"');
    expect(html).toContain('data-fragment="/fragments/inbox"');
    expect(html).toContain('data-fragment="/fragments/nights"');
    expect(html).not.toContain("<select");
    expect(html).toContain("Loading tickets…");
  });

  it("passes the selected tab to the evening fragment, encoded", () => {
    expect(homeHTML({ projects: ["a&b"], tab: "a&b" })).toContain("/fragments/evening?tab=a%26b");
  });
});

describe("eveningErrorHTML", () => {
  it("explains the failure and links to the projects", () => {
    const html = eveningErrorHTML("bad");
    expect(html).toContain("Tonight can't be loaded: bad");
    expect(html).toContain('href="/projects"');
  });
});
