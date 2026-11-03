import { describe, expect, it } from "vitest";
import type { ConfigCheck } from "../src/dashboard/project-checks.js";
import {
  LEVEL_COLORS,
  projectChecksHTML,
  projectPageHTML,
  projectsListHTML,
} from "../src/dashboard/views/projects.js";

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

  it("links each project and offers no new-project button", () => {
    expect(html).toContain('href="/projects/acme"');
    expect(html).not.toContain("/projects/new");
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

describe("projectPageHTML", () => {
  const html = projectPageHTML("acme");

  it("renders the checks slot and a re-check button", () => {
    expect(html).toContain("<h1>acme</h1>");
    expect(html).toContain('data-fragment="/fragments/project-checks?name=acme"');
    expect(html).toContain('data-refresh="all"');
    expect(html).toContain("Re-check");
  });

  it("has no editing form", () => {
    expect(html).not.toContain("<form");
    expect(html).not.toContain("project-form");
  });
});
