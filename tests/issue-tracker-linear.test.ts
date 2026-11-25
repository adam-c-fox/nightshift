import { describe, expect, it } from "vitest";
import { ISSUE_TRACKERS, createIssueTracker } from "../src/issue-tracker.js";
import { linear } from "../src/issue-trackers/linear/index.js";
import { describeIssueTrackerContract, type FakeIssueState, type FakeTrackerWorld, type TrackerFixture } from "./issue-tracker-contract.js";

const STATES: Record<FakeIssueState, { name: string; type: string; position: number }> = {
  backlog: { name: "Backlog", type: "backlog", position: 0 },
  ready: { name: "Todo", type: "unstarted", position: 1 },
  started: { name: "In Progress", type: "started", position: 2 },
  review: { name: "In Review", type: "started", position: 3 },
  done: { name: "Done", type: "completed", position: 4 },
  canceled: { name: "Canceled", type: "canceled", position: 5 },
};

const respond = (body: unknown) => new Response(JSON.stringify(body));

function linearFixture(world: FakeTrackerWorld): TrackerFixture {
  const moves: { identifier: string; to: string }[] = [];
  const states = (Object.keys(STATES) as FakeIssueState[])
    .filter(key => key !== "review" || world.hasReviewState !== false)
    .map(key => ({ id: `state-${key}`, ...STATES[key] }));
  const byIdentifier = (identifier: string) => world.issues.find(i => i.identifier === identifier);
  const byId = (id: string) => world.issues.find(i => `id-${i.identifier}` === id);

  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, any> };
    const operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "Teams";
    if (operation === "GetIssue") {
      const found = byIdentifier(variables.id);
      if (!found) return respond({ data: { issue: null } });
      return respond({ data: { issue: {
        id: `id-${found.identifier}`, identifier: found.identifier, title: found.title, description: found.description,
        state: { name: STATES[found.state].name, type: STATES[found.state].type },
        team: { states: { nodes: states } }, url: `https://linear.test/${found.identifier}`,
        comments: { nodes: found.comments.map(c => ({ body: c.body, createdAt: c.createdAt, user: { name: c.author } })) },
      } } });
    }
    if (operation === "SetIssueState") {
      const found = byId(variables.id);
      moves.push({ identifier: found!.identifier, to: variables.stateId });
      return respond({ data: { issueUpdate: { success: true } } });
    }
    if (operation === "SaveForNightLookup") {
      return respond({ data: { viewer: { id: "viewer-1" }, issue: { team: { states: { nodes: states.filter(s => s.name === variables.stateName).map(s => ({ id: s.id })) } } } } });
    }
    if (operation === "SaveForNight") {
      const found = byId(variables.id)!;
      found.description = variables.description;
      found.assignedToMe = variables.assigneeId === "viewer-1";
      found.state = (Object.keys(STATES) as FakeIssueState[]).find(key => `state-${key}` === variables.stateId)!;
      return respond({ data: { issueUpdate: { success: true } } });
    }
    if (operation === "TodoIssues") {
      const wanted = variables.filter.state.name.eq;
      const nodes = world.issues
        .filter(i => i.assignedToMe && STATES[i.state].name === wanted)
        .map(i => ({
          id: `id-${i.identifier}`, identifier: i.identifier, title: i.title, url: `https://linear.test/${i.identifier}`,
          priority: i.priority, priorityLabel: "High", estimate: i.estimate, description: i.description,
          team: { key: i.teamKey }, project: i.projectName ? { name: i.projectName } : null,
          comments: { nodes: i.comments.map(c => ({ createdAt: c.createdAt })) },
        }));
      return respond({ data: { viewer: { assignedIssues: { nodes } } } });
    }
    if (operation === "Snapshots") {
      const data = Object.fromEntries(Object.entries(variables).map(([alias, identifier]) => {
        const found = byIdentifier(identifier as string);
        return [alias, found ? {
          identifier: found.identifier, title: found.title, url: `https://linear.test/${found.identifier}`,
          description: found.description, state: { name: STATES[found.state].name },
          assignee: found.assignedToMe ? { isMe: true } : { isMe: false },
          comments: { nodes: found.comments.map(c => ({ createdAt: c.createdAt })) },
        } : null];
      }));
      return respond({ data });
    }
    return respond({ data: { teams: { nodes: world.teams } } });
  }) as unknown as typeof fetch;

  const lookup = (name: string) => (world.hasKey && name === "LINEAR_API_KEY" ? "key" : undefined);
  return { tracker: createIssueTracker("linear", lookup, fetchFn), moves: () => moves };
}

describeIssueTrackerContract("linear", linearFixture);

describe("linear descriptor", () => {
  it("declares its credential key and the connector the agent is denied", () => {
    expect(ISSUE_TRACKERS.linear).toBe(linear);
    expect(linear.envKeys).toEqual(["LINEAR_API_KEY"]);
    expect(linear.agentDeniedTools).toEqual(["mcp__claude_ai_Linear"]);
  });
});
