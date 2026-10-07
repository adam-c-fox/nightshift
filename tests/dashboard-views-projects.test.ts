import { describe, expect, it } from "vitest";
import type { Loaded } from "../src/dashboard/cache.js";
import type { ConfigCheck } from "../src/dashboard/project-checks.js";
import {
  LEVEL_COLORS,
  newProjectHTML,
  projectChecksHTML,
  projectFormHTML,
  projectPageHTML,
  projectsListHTML,
} from "../src/dashboard/views/projects.js";
import type { LinearTeam } from "../src/linear.js";

function ok(value: LinearTeam[]): Loaded<LinearTeam[]> {
  return { ok: true, value };
}

function fail(error: string): Loaded<LinearTeam[]> {
  return { ok: false, error };
}

const TEAMS = ok([
  { key: "DEMO", name: "G" },
  { key: "ENG", name: "E" },
]);

const RAW = {
  repos: { app: { path: "/r", toolchain: "terraform", description: "d" } },
  allowancePercent: 20,
  linearTeams: ["DEMO"],
};

function editForm(
  extra: { raw?: Record<string, unknown>; teams?: Loaded<LinearTeam[]> } = {},
): string {
  return projectFormHTML({
    name: "acme",
    raw: extra.raw ?? RAW,
    teams: extra.teams ?? TEAMS,
    mode: "edit",
  });
}

describe("projectsListHTML", () => {
  const html = projectsListHTML([
    {
      name: "acme",
      level: "warn",
      reason: ".env: missing CLAUDE_CODE_OAUTH_TOKEN",
    },
    {
      name: "example",
      level: "fail",
      reason: "repo app: /path/to/app does not exist",
    },
    { name: "calm", level: "pass", reason: "All checks pass" },
  ]);

  it("links each project and offers a new-project button", () => {
    expect(html).toContain('href="/projects/acme"');
    expect(html).toContain('href="/projects/new"');
    expect(html).toContain("New project");
  });

  it("colours the status pill by level", () => {
    expect(html).toContain(LEVEL_COLORS.warn);
    expect(html).toContain("#eab308");
    expect(html).toContain("#ef4444");
    expect(html).toContain("#22c55e");
  });

  it("shows the reason and tags the example project as a template", () => {
    expect(html).toContain(".env: missing CLAUDE_CODE_OAUTH_TOKEN");
    expect(html).toContain("template");
    expect(html.match(/>template</g)).toHaveLength(1);
  });

  it("shows an empty state", () => {
    expect(projectsListHTML([])).toContain("No projects yet.");
  });

  it("escapes project names and reasons", () => {
    const out = projectsListHTML([
      { name: "a", level: "warn", reason: "<script>x</script>" },
    ]);
    expect(out).not.toContain("<script>x");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("projectChecksHTML", () => {
  const checks: ConfigCheck[] = [
    { name: "config", level: "pass", reason: "valid" },
    {
      name: ".env",
      level: "warn",
      reason: "missing CLAUDE_CODE_OAUTH_TOKEN",
      keys: {
        present: ["LINEAR_API_KEY"],
        missing: ["CLAUDE_CODE_OAUTH_TOKEN"],
      },
    },
  ];

  it("lists each check with its level colour, name and reason", () => {
    const html = projectChecksHTML(checks);
    expect(html).toContain("config");
    expect(html).toContain("valid");
    expect(html).toContain(LEVEL_COLORS.pass);
    expect(html).toContain(LEVEL_COLORS.warn);
  });

  it("shows env key names as present and missing", () => {
    const html = projectChecksHTML(checks);
    expect(html).toContain("present: LINEAR_API_KEY");
    expect(html).toContain("missing: CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("omits the empty side of the key summary", () => {
    const html = projectChecksHTML([
      {
        name: ".env",
        level: "pass",
        reason: "all set",
        keys: { present: ["A", "B"], missing: [] },
      },
    ]);
    expect(html).toContain("present: A, B");
    expect(html).not.toContain("missing:");
  });
});

describe("projectFormHTML", () => {
  it("prefills the repo, allowance and posts to the project endpoint", () => {
    const html = editForm();
    expect(html).toContain('value="/r"');
    expect(html).toContain('<option value="terraform" selected>');
    expect(html).toContain('value="20"');
    expect(html).toContain("/api/projects/acme");
    expect(html).toContain('id="project-form"');
    expect(html).toContain('data-mode="edit"');
    expect(html).toContain('data-name="acme"');
  });

  it("renders a checkbox per team with the configured ones checked", () => {
    const html = editForm();
    expect(html).toMatch(/value="DEMO"[^>]*\bchecked\b/);
    expect(html).toMatch(/value="ENG"(?![^>]*\bchecked\b)[^>]*>/);
    expect(html).toContain("DEMO — G");
  });

  it("keeps configured teams that Linear no longer lists", () => {
    const html = editForm({
      raw: { ...RAW, linearTeams: ["OLD"] },
      teams: ok([{ key: "ENG", name: "E" }]),
    });
    expect(html).toMatch(/value="OLD"[^>]*\bchecked\b/);
  });

  it("falls back to a text input when Linear is unavailable", () => {
    const html = editForm({ teams: fail("no key") });
    expect(html).toContain("Linear unavailable: no key");
    expect(html).toContain("Team keys, comma separated");
    expect(html).toMatch(/<input type="text"[^>]*value="DEMO"/);
    expect(html).not.toContain('type="checkbox"');
  });

  it("ties every control to a label", () => {
    const html = editForm();
    const controlIds = [
      ...html.matchAll(/<(?:input|select)\b[^>]*\bid="([^"]+)"/g),
    ]
      .map((m) => m[1])
      .filter((id) => !id.startsWith("repo-__i__"));
    expect(controlIds.length).toBeGreaterThan(6);
    for (const id of controlIds) {
      expect(html).toContain(`for="${id}"`);
    }
    expect(new Set(controlIds).size).toBe(controlIds.length);
  });

  it("offers add and remove for repos and a hidden row template", () => {
    const html = editForm();
    expect(html).toContain('<template id="repo-row">');
    expect(html).toContain("Add repo");
    expect(html).toContain("Remove");
    expect(html).toContain('class="repo-row"');
  });

  it("has a live result region and sends the CSRF header", () => {
    const html = editForm();
    expect(html).toContain('<div class="form-result" aria-live="polite">');
    expect(html).toContain("X-Nightshift");
  });

  it("escapes values", () => {
    const html = editForm({
      raw: {
        repos: {
          app: { path: "/r", toolchain: "node", description: '"><script>' },
        },
      },
    });
    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("prefills defaultRepo and testDb", () => {
    const html = editForm({
      raw: { ...RAW, defaultRepo: "app", testDb: "/db/test.sqlite" },
    });
    expect(html).toContain('value="app"');
    expect(html).toContain('value="/db/test.sqlite"');
    expect(html).toContain("only needed with 2+ repos");
    expect(html).toContain('placeholder="15"');
  });

  it("create mode adds a name field and the create hint", () => {
    const html = projectFormHTML({ raw: {}, teams: ok([]), mode: "create" });
    expect(html).toContain('data-mode="create"');
    expect(html).toContain('id="project-name" name="name"');
    expect(html).toContain("absolute path, or leave blank and add it later");
    expect(html.indexOf('id="project-name"')).toBeLessThan(
      html.indexOf('id="default-repo"'),
    );
  });

  it("edit mode has no name field", () => {
    expect(editForm()).not.toContain('id="project-name"');
  });

  it("never renders secrets", () => {
    const html = editForm({ raw: { ...RAW, token: "s3cr3t-value" } });
    expect(html).not.toContain("s3cr3t-value");
  });
});

describe("projectPageHTML", () => {
  it("renders the checks slot, a re-check button and the edit form", () => {
    const html = projectPageHTML("acme", RAW, undefined, TEAMS);
    expect(html).toContain("<h1>acme</h1>");
    expect(html).toContain(
      'data-fragment="/fragments/project-checks?name=acme"',
    );
    expect(html).toContain('data-refresh="all"');
    expect(html).toContain("Re-check");
    expect(html).toContain('id="project-form"');
  });

  it("shows an error instead of the form when project.json is invalid", () => {
    const html = projectPageHTML("acme", null, "not valid JSON: x", ok([]));
    expect(html).toContain("can't be read");
    expect(html).toContain("not valid JSON: x");
    expect(html).not.toContain("<form");
    expect(html).toContain('data-fragment="/fragments/project-checks');
  });
});

describe("newProjectHTML", () => {
  it("renders the create form", () => {
    const html = newProjectHTML(ok([]));
    expect(html).toContain('name="name"');
    expect(html).toContain('pattern="[A-Za-z0-9][A-Za-z0-9._-]*"');
    expect(html).toContain('/api/projects"');
    expect(html).toContain("<h1>");
  });
});
