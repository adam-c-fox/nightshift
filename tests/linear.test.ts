import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTicket, markInProgress, pickInProgressState, shouldMarkInProgress } from "../src/linear.js";

describe("pickInProgressState", () => {
  const states = [
    { id: "todo", name: "Todo", type: "unstarted", position: 1 },
    { id: "review", name: "In Review", type: "started", position: 3 },
    { id: "progress", name: "In Progress", type: "started", position: 2 },
    { id: "done", name: "Done", type: "completed", position: 4 },
  ];

  it("prefers the started state named In Progress", () => {
    expect(pickInProgressState(states)?.id).toBe("progress");
  });

  it("falls back to the first started state by position", () => {
    const renamed = states.map(s => (s.id === "progress" ? { ...s, name: "Doing" } : s));
    expect(pickInProgressState(renamed)?.id).toBe("progress");
  });

  it("returns undefined when the team has no started state", () => {
    expect(pickInProgressState(states.filter(s => s.type !== "started"))).toBeUndefined();
  });
});

describe("shouldMarkInProgress", () => {
  it("moves tickets that have not started yet", () => {
    expect(["backlog", "unstarted", "triage"].map(shouldMarkInProgress)).toEqual([true, true, true]);
  });

  it("never moves a ticket backwards or out of a finished state", () => {
    expect(["started", "completed", "canceled", "unknown"].map(shouldMarkInProgress)).toEqual([false, false, false, false]);
  });
});

describe("markInProgress", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("updates the issue state and throws when Linear reports failure", async () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_api_x");
    const bodies: unknown[] = [];
    const respond = (success: boolean) => vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ data: { issueUpdate: { success } } }));
    });

    vi.stubGlobal("fetch", respond(true));
    await markInProgress("issue-1", "progress");
    expect(bodies[0]).toMatchObject({ variables: { id: "issue-1", stateId: "progress" } });

    vi.stubGlobal("fetch", respond(false));
    await expect(markInProgress("issue-1", "progress")).rejects.toThrow(/not updated/);
  });
});

describe("fetchTicket", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const issue = (comments: unknown[]) => ({
    id: "issue-1", identifier: "ENG-1", title: "Poll", description: "Desc",
    state: { name: "Todo", type: "unstarted" }, team: { states: { nodes: [] } }, url: "u",
    comments: { nodes: comments },
  });

  it("returns the comments oldest first with their author", async () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_api_x");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { issue: issue([
      { body: "Second", createdAt: "2026-10-02T09:00:00.000Z", user: { name: "Sam" } },
      { body: "First", createdAt: "2026-10-01T09:00:00.000Z", user: { name: "Adam" } },
      { body: "Linked a PR", createdAt: "2026-10-03T09:00:00.000Z", user: null },
    ]) } }))));

    const ticket = await fetchTicket("ENG-1");

    expect(ticket?.comments).toEqual([
      { author: "Adam", createdAt: "2026-10-01T09:00:00.000Z", body: "First" },
      { author: "Sam", createdAt: "2026-10-02T09:00:00.000Z", body: "Second" },
      { author: "integration", createdAt: "2026-10-03T09:00:00.000Z", body: "Linked a PR" },
    ]);
  });
});
