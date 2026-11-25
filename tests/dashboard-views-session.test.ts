import { describe, expect, it } from "vitest";
import { CLIENT_SCRIPT } from "../src/dashboard/views/layout.js";
import type { PrepSession, SessionState } from "../src/dashboard/sessions.js";
import { openPrepsHTML, sessionFragmentHTML, sessionPageHTML } from "../src/dashboard/views/session.js";

const usage = (costUsd: number) => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd, turns: 1, durationMs: 1, models: [],
});

const session = (over: Partial<PrepSession> = {}): PrepSession => ({
  id: "sid-1",
  kind: "prep",
  ticketId: "ENG-1",
  project: "acme",
  state: "surveying",
  running: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ticket: { title: "Add export", url: "https://linear.app/x/issue/ENG-1", description: "", descHash: "h" },
  activity: [],
  revisions: [],
  usage: [],
  ...over,
});

const survey = {
  repo: "app",
  gaps: [
    { id: "g1", title: "Format", question: "Which format?", recommended: "CSV", alternative: "JSON" },
    { id: "g2", title: "Limit", question: "Row limit?", recommended: "None" },
  ],
  pointers: ["src/export.ts"],
};

const render = (over: Partial<PrepSession> = {}) => sessionFragmentHTML(session(over), "/code/ns");

describe("sessionPageHTML", () => {
  it("is a page with the session fragment slot", () => {
    const html = sessionPageHTML("sid-1", "ENG-1");
    expect(html).toContain('data-fragment="/fragments/session/sid-1"');
    expect(html).toContain("<title>Prep ENG-1</title>");
  });
});

describe("sessionFragmentHTML", () => {
  it("polls only while a step is running", () => {
    expect(render({ running: true })).toContain('data-poll="1500"');
    expect(render({ running: false, state: "answering", survey })).not.toContain("data-poll");
    expect(render({ state: "saved" })).not.toContain("data-poll");
    expect(render({ state: "surveying", running: false, error: "boom" })).not.toContain("data-poll");
  });

  it("shows the ticket header and the latest activity while surveying", () => {
    const html = render({ running: true, activity: [{ at: "t", text: "Read src/a.ts" }, { at: "t", text: 'Grep "x"' }] });
    expect(html).toContain('href="https://linear.app/x/issue/ENG-1"');
    expect(html).toContain("Add export");
    expect(html).toContain("<li>Read src/a.ts</li>");
    expect(html).toContain("Reading the code");
  });

  it("renders one fieldset per gap with the recommended answer preselected", () => {
    const html = render({ state: "answering", survey });
    expect(html.match(/<fieldset/g)).toHaveLength(2);
    expect(html).toContain('name="gap-g1" value="recommended" checked');
    expect(html).toContain('name="gap-g1" value="alternative"');
    expect(html).not.toContain('name="gap-g2" value="alternative"');
    expect(html).toContain('name="gap-g2" value="your_call"');
    expect(html).toContain('name="gap-g2" value="other"');
    expect(html).toContain("src/export.ts");
    expect(html).toContain("Draft description");
    expect(html).toContain('data-session-action="not-ready"');
    expect(html).toContain("data-blockers");
  });

  it.each<[SessionState, string]>([
    ["drafting", "Drafting the description"],
    ["revising", "Revising the description"],
    ["saving", "Saving to Linear"],
  ])("shows progress while %s", (state, text) => {
    expect(render({ state, running: true })).toContain(text);
  });

  it("shows the new sections above an editable full draft while reviewing", () => {
    const draft = "Intro\n\n## Acceptance criteria\n- [ ] works\n\n## Other\nkeep\n";
    const html = render({ state: "reviewing", draft });
    const highlighted = html.match(/<pre class="highlight">([\s\S]*?)<\/pre>/)![1];
    expect(highlighted).toContain("## Acceptance criteria");
    expect(highlighted).not.toContain("Other");
    expect(html.indexOf("highlight")).toBeLessThan(html.indexOf("data-draft"));
    expect(html).toMatch(/<textarea[^>]*data-draft>Intro/);
    expect(html).toContain("Approve and save");
    expect(html).toContain("Ask for changes…");
    expect(html).toContain("data-feedback");
    expect(html).toContain("Not ready…");
  });

  it("shows the saved result with a link, the repo and ready", () => {
    const html = render({ state: "saved", survey });
    expect(html).toContain("Saved to Linear");
    expect(html).toContain("Open ENG-1");
    expect(html).toContain("Repo: app");
    expect(html).toContain("ready");
  });

  it("shows the not ready blockers and the cancelled state", () => {
    expect(render({ state: "not_ready", blockers: "needs a design" })).toContain("needs a design");
    expect(render({ state: "cancelled" })).toContain("Cancelled");
  });

  it("shows an error with Retry and Cancel, naming an interruption", () => {
    const failed = render({ state: "drafting", error: "claude exited 1" });
    expect(failed).toContain("Failed: claude exited 1");
    expect(failed).toContain('data-session-action="retry"');
    expect(failed).toContain('data-session-action="cancel"');
    expect(render({ state: "surveying", error: "interrupted" })).toContain("Interrupted");
  });

  it("sums the usage cost as an estimate in every state", () => {
    const html = render({ state: "cancelled", usage: [usage(0.4), usage(0.35)] });
    expect(html).toContain("est. cost so far $0.75");
  });

  it("offers the terminal command to copy in every state", () => {
    for (const state of ["surveying", "reviewing", "saved"] as const) {
      const html = render({ state });
      expect(html).toContain("Run in terminal instead");
      expect(html).toContain("data-copy=\"cd '/code/ns' &amp;&amp; claude '/prep ENG-1 acme'\"");
    }
  });

  it("escapes ticket and model text", () => {
    const evil = "<script>alert(1)</script>";
    const html = render({
      state: "answering",
      ticket: { title: evil, url: "javascript:alert(1)", description: "", descHash: "h" },
      survey: { repo: "app", gaps: [{ id: "g1", title: evil, question: evil, recommended: evil, alternative: evil }], pointers: [evil] },
    });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("javascript:");
    const reviewing = render({ state: "reviewing", draft: `## Decisions\n${evil}`, activity: [{ at: "t", text: evil }] });
    expect(reviewing).not.toContain("<script>alert");
    expect(render({ state: "cancelled", error: evil, running: false })).not.toContain("<script>alert");
    expect(render({ state: "not_ready", blockers: evil })).not.toContain("<script>alert");
  });
});

describe("openPrepsHTML", () => {
  it("renders nothing when there are no open sessions", () => {
    expect(openPrepsHTML([])).toBe("");
    expect(openPrepsHTML([session({ state: "saved" }), session({ state: "cancelled" })])).toBe("");
  });

  it("lists open sessions with link, state, needs-you badge and cost", () => {
    const html = openPrepsHTML([
      session({ id: "a", ticketId: "ENG-1", state: "answering", usage: [usage(0.5)] }),
      session({ id: "b", ticketId: "ENG-2", state: "drafting", running: true }),
      session({ id: "c", ticketId: "ENG-3", state: "saved" }),
    ]);
    expect(html).toContain('href="/prep/a">ENG-1');
    expect(html).toContain("needs your answers");
    expect(html.match(/needs you</g)).toHaveLength(1);
    expect(html).toContain("est. $0.50");
    expect(html).toContain('href="/prep/b">ENG-2');
    expect(html).not.toContain("ENG-3");
  });
});

describe("session client script", () => {
  it("parses and wires polling, session actions, prep and copy", () => {
    expect(() => new Function(CLIENT_SCRIPT)).not.toThrow();
    for (const needle of ["dataset.poll", "clearTimeout(el.pollTimer)", "data-session-action", "data-prep", "data-copy", "/api/sessions"]) {
      expect(CLIENT_SCRIPT).toContain(needle);
    }
  });
});
