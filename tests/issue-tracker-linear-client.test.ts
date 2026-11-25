import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchIssueSnapshots,
  fetchTeams,
  fetchTicket,
  fetchTodoIssues,
  isFinished,
  saveIssueForNight,
  pickInProgressState,
  pickInReviewState,
  setIssueState,
  shouldMarkInProgress,
  todoFilter,
} from "../src/issue-trackers/linear/client.js";

describe("isFinished", () => {
  it.each([["completed", true], ["canceled", true], ["started", false], ["unstarted", false], ["backlog", false]])(
    "%s -> %s", (type, expected) => expect(isFinished(type)).toBe(expected),
  );
});

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

describe("pickInReviewState", () => {
  const states = [
    { id: "progress", name: "In Progress", type: "started", position: 2 },
    { id: "review", name: "in review", type: "started", position: 3 },
  ];

  it("finds the state named In Review regardless of case", () => {
    expect(pickInReviewState(states)?.id).toBe("review");
  });

  it("returns undefined when the team has no In Review state", () => {
    expect(pickInReviewState(states.filter(s => s.id !== "review"))).toBeUndefined();
  });
});

describe("setIssueState", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates the issue state and throws when Linear reports failure", async () => {
    const bodies: unknown[] = [];
    const respond = (success: boolean) => vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ data: { issueUpdate: { success } } }));
    });

    vi.stubGlobal("fetch", respond(true));
    await setIssueState("issue-1", "progress", { apiKey: "lin_api_x" });
    expect(bodies[0]).toMatchObject({ variables: { id: "issue-1", stateId: "progress" } });

    vi.stubGlobal("fetch", respond(false));
    await expect(setIssueState("issue-1", "progress", { apiKey: "lin_api_x" })).rejects.toThrow(/not updated/);
  });
});

describe("saveIssueForNight", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const lookup = (stateNodes: unknown[]) => ({ data: { viewer: { id: "viewer-1" }, issue: { team: { states: { nodes: stateNodes } } } } });

  it("sets description, the viewer and the Todo state in one issueUpdate", async () => {
    const bodies: { variables: unknown }[] = [];
    const replies = [lookup([{ id: "todo-1" }]), { data: { issueUpdate: { success: true } } }];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(replies.shift()));
    }));
    await saveIssueForNight("issue-1", "New text", { apiKey: "lin_api_x" });
    expect(bodies[0].variables).toMatchObject({ id: "issue-1", stateName: "Todo" });
    expect(bodies[1].variables).toEqual({ id: "issue-1", description: "New text", assigneeId: "viewer-1", stateId: "todo-1" });
  });

  it("throws without mutating when the team has no Todo state", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(lookup([]))));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveIssueForNight("issue-1", "x", { apiKey: "lin_api_x" })).rejects.toThrow(/Todo/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when Linear reports failure", async () => {
    const replies = [lookup([{ id: "todo-1" }]), { data: { issueUpdate: { success: false } } }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(replies.shift()))));
    await expect(saveIssueForNight("issue-1", "x", { apiKey: "lin_api_x" })).rejects.toThrow(/not updated/);
  });
});

describe("fetchTicket", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const issue = (comments: unknown[]) => ({
    id: "issue-1", identifier: "ENG-1", title: "Poll", description: "Desc",
    state: { name: "Todo", type: "unstarted" }, team: { states: { nodes: [] } }, url: "u",
    comments: { nodes: comments },
  });

  it("returns the comments oldest first with their author", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { issue: issue([
      { body: "Second", createdAt: "2026-10-02T09:00:00.000Z", user: { name: "Sam" } },
      { body: "First", createdAt: "2026-10-01T09:00:00.000Z", user: { name: "Adam" } },
      { body: "Linked a PR", createdAt: "2026-10-03T09:00:00.000Z", user: null },
    ]) } }))));

    const ticket = await fetchTicket("ENG-1", { apiKey: "lin_api_x" });

    expect(ticket?.comments).toEqual([
      { author: "Adam", createdAt: "2026-10-01T09:00:00.000Z", body: "First" },
      { author: "Sam", createdAt: "2026-10-02T09:00:00.000Z", body: "Second" },
      { author: "integration", createdAt: "2026-10-03T09:00:00.000Z", body: "Linked a PR" },
    ]);
  });
});

const fakeFetch = (...bodies: unknown[]) => {
  let call = 0;
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const body = bodies[Math.min(call++, bodies.length - 1)];
    return new Response(JSON.stringify(body), { status: 200 });
  });
};

const sentBody = (fetchMock: ReturnType<typeof fakeFetch>, call = 0) =>
  JSON.parse(String(fetchMock.mock.calls[call][1]?.body));

const sentAuthorization = (fetchMock: ReturnType<typeof fakeFetch>) =>
  (fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization;

const notFoundResponse = { data: null, errors: [{ message: "Entity not found: Issue" }] };

describe("fetchTicket with missing issue", () => {
  it("resolves to null when Linear answers data null with a not found error", async () => {
    const fetch = fakeFetch(notFoundResponse);
    await expect(fetchTicket("ENG-404", { apiKey: "lin_api_x", fetch })).resolves.toBeNull();
  });

  it("uses the client's key and fetch", async () => {
    const fetch = fakeFetch(notFoundResponse);
    await fetchTicket("ENG-404", { apiKey: "lin_api_x", fetch });
    expect(sentAuthorization(fetch)).toBe("lin_api_x");
  });
});

describe("todoFilter", () => {
  it("filters on the Todo state only", () => {
    expect(todoFilter()).toEqual({ state: { name: { eq: "Todo" } } });
  });
});

describe("fetchTodoIssues", () => {
  const node = {
    id: "u1", identifier: "DEMO-1", title: "T", url: "https://l/1", priority: 2,
    priorityLabel: "High", estimate: null, description: null, team: { key: "DEMO" },
    project: { name: "Large Group Memo Summarization" },
    comments: { nodes: [{ createdAt: "2026-10-01T00:00:00Z" }] },
  };
  const response = { data: { viewer: { assignedIssues: { nodes: [node] } } } };

  it("sends the Todo filter with the client's key and maps the nodes", async () => {
    const fetch = fakeFetch(response);
    const issues = await fetchTodoIssues({ apiKey: "lin_api_x", fetch });

    expect(sentBody(fetch).variables.filter).toEqual(todoFilter());
    expect(sentAuthorization(fetch)).toBe("lin_api_x");
    expect(issues).toEqual([
      {
        id: "u1", identifier: "DEMO-1", title: "T", url: "https://l/1", priority: 2,
        priorityLabel: "High", estimate: null, teamKey: "DEMO", projectName: "Large Group Memo Summarization", description: "",
        commentCreatedAt: ["2026-10-01T00:00:00Z"],
      },
    ]);
  });

  it("gives a null projectName for a ticket with no Linear project", async () => {
    const fetch = fakeFetch({ data: { viewer: { assignedIssues: { nodes: [{ ...node, project: null }] } } } });
    const [issue] = await fetchTodoIssues({ apiKey: "k", fetch });
    expect(issue.projectName).toBeNull();
  });

  it("sends OAuth tokens as bearer", async () => {
    const fetch = fakeFetch(response);
    await fetchTodoIssues({ apiKey: "lin_oauth_y", fetch });
    expect(sentAuthorization(fetch)).toBe("Bearer lin_oauth_y");
  });

  it("rejects on an HTTP error", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(fetchTodoIssues({ apiKey: "k", fetch })).rejects.toThrow(/Linear API 401: nope/);
  });

  it("rejects on a GraphQL error with no data", async () => {
    const fetch = fakeFetch({ errors: [{ message: "boom" }] });
    await expect(fetchTodoIssues({ apiKey: "k", fetch })).rejects.toThrow(/Linear API error: boom/);
  });
});

describe("fetchIssueSnapshots", () => {
  const snapshotNode = (identifier: string, assignee: { isMe: boolean } | null = { isMe: false }) => ({
    identifier, title: "A", url: "u", description: "d", state: { name: "In Progress" },
    assignee, comments: { nodes: [] },
  });
  const snapshot = (identifier: string, assignedToMe = false) => ({
    identifier, title: "A", url: "u", state: "In Progress", assignedToMe,
    description: "d", commentCreatedAt: [],
  });
  const client = (fetch: ReturnType<typeof fakeFetch>) => ({ apiKey: "k", fetch });

  it("does not call Linear for no ids", async () => {
    const fetch = fakeFetch({});
    await expect(fetchIssueSnapshots(client(fetch), [])).resolves.toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aliases each id as a variable and maps a missing issue to null", async () => {
    const fetch = fakeFetch({
      data: { i0: snapshotNode("ENG-1"), i1: null },
      errors: [{ message: "Entity not found" }],
    });
    const result = await fetchIssueSnapshots(client(fetch), ["ENG-1", "ENG-2"]);

    const body = sentBody(fetch);
    expect(body.query).toContain("i0: issue(id: $i0)");
    expect(body.query).toContain("i1: issue(id: $i1)");
    expect(body.variables).toEqual({ i0: "ENG-1", i1: "ENG-2" });
    expect(result).toEqual({ "ENG-1": snapshot("ENG-1"), "ENG-2": null });
  });

  it("maps a missing assignee to not assigned to me", async () => {
    const fetch = fakeFetch({ data: { i0: snapshotNode("ENG-1", null) } });
    const result = await fetchIssueSnapshots(client(fetch), ["ENG-1"]);
    expect(result["ENG-1"]?.assignedToMe).toBe(false);
  });

  it("retries each id on its own when the batch answers data null with not found errors", async () => {
    const fetch = fakeFetch(
      notFoundResponse,
      { data: { i0: snapshotNode("ENG-1", { isMe: true }) } },
      notFoundResponse,
    );
    const result = await fetchIssueSnapshots(client(fetch), ["ENG-1", "ENG-2"]);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sentBody(fetch, 1).variables).toEqual({ i0: "ENG-1" });
    expect(sentBody(fetch, 2).variables).toEqual({ i0: "ENG-2" });
    expect(result).toEqual({ "ENG-1": snapshot("ENG-1", true), "ENG-2": null });
  });

  it("rejects on a GraphQL error that is not a missing issue", async () => {
    const fetch = fakeFetch({ data: null, errors: [{ message: "boom" }] });
    await expect(fetchIssueSnapshots(client(fetch), ["ENG-1"])).rejects.toThrow(/Linear API error: boom/);
  });
});

describe("fetchTeams", () => {
  it("returns the teams sorted by key", async () => {
    const fetch = fakeFetch({ data: { teams: { nodes: [{ key: "OPS", name: "Ops" }, { key: "ENG", name: "Eng" }] } } });
    await expect(fetchTeams({ apiKey: "k", fetch })).resolves.toEqual([
      { key: "ENG", name: "Eng" },
      { key: "OPS", name: "Ops" },
    ]);
  });
});
