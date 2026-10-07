import { requireEnv } from "./env.js";
import type { LinearComment, LinearTicket, TicketStatus } from "./types.js";

export type { LinearComment, LinearTicket };

const BASE_URL = "https://api.linear.app/graphql";

export interface WorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
}

interface IssueResponse {
  data?: { issue?: {
    id: string; identifier: string; title: string;
    description: string | null;
    state: { name: string; type: string } | null;
    team: { states: { nodes: WorkflowState[] } } | null;
    url: string;
    comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] } | null;
  } | null };
  errors?: { message: string }[];
}

const NOT_STARTED_TYPES = ["backlog", "unstarted", "triage"];

export function shouldMarkInProgress(stateType: string): boolean {
  return NOT_STARTED_TYPES.includes(stateType);
}

export function pickInProgressState(states: WorkflowState[]): WorkflowState | undefined {
  const started = states.filter(s => s.type === "started").sort((a, b) => a.position - b.position);
  return started.find(s => s.name.toLowerCase() === "in progress") ?? started[0];
}

const FINISHED_TYPES = ["completed", "canceled"];
const REVIEWABLE_STATUSES: TicketStatus[] = ["done", "needs_review"];

export function shouldMarkInReview(status: TicketStatus, stateType: string): boolean {
  return REVIEWABLE_STATUSES.includes(status) && !FINISHED_TYPES.includes(stateType);
}

export function pickInReviewState(states: WorkflowState[]): WorkflowState | undefined {
  return states.find(s => s.name.toLowerCase() === "in review");
}

export interface LinearClient {
  apiKey: string;
  fetch?: typeof fetch;
}

class LinearNotFoundError extends Error {}

type GraphqlErrors = { message: string }[];

function isNotFound(errors: GraphqlErrors): boolean {
  return errors.every(e => /not found/i.test(e.message));
}

function formatErrors(errors: GraphqlErrors): string {
  return errors.map(e => e.message).join("; ").slice(0, 200);
}

function throwOnMissingData(json: { data?: unknown; errors?: GraphqlErrors }): void {
  if (json.data != null || !json.errors?.length) return;
  if (isNotFound(json.errors)) throw new LinearNotFoundError(formatErrors(json.errors));
  throw new Error(`Linear API error: ${formatErrors(json.errors)}`);
}

async function linearRequest<T extends { data?: unknown; errors?: { message: string }[] }>(
  query: string,
  variables: Record<string, unknown>,
  client: LinearClient = { apiKey: requireEnv("LINEAR_API_KEY") },
): Promise<T> {
  const res = await (client.fetch ?? fetch)(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": authorizationHeader(client.apiKey),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linear API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as T;
  throwOnMissingData(json);
  return json;
}

export async function setIssueState(issueId: string, stateId: string): Promise<void> {
  const mutation = `
    mutation SetIssueState($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }
  `;
  const json = await linearRequest<{ data?: { issueUpdate?: { success: boolean } }; errors?: { message: string }[] }>(
    mutation, { id: issueId, stateId },
  );
  if (!json.data?.issueUpdate?.success) {
    const reason = json.errors?.map(e => e.message).join("; ") ?? "no error given";
    throw new Error(`Linear issue ${issueId} not updated: ${reason.slice(0, 200)}`);
  }
}

export function authorizationHeader(apiKey: string): string {
  return apiKey.startsWith("lin_oauth_") ? `Bearer ${apiKey}` : apiKey;
}

export async function fetchTicket(identifier: string, client?: LinearClient): Promise<LinearTicket | null> {
  const query = `
    query GetIssue($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        state { name type }
        team { states { nodes { id name type position } } }
        url
        comments(first: 100) { nodes { body createdAt user { name } } }
      }
    }
  `;

  let json: IssueResponse;
  try {
    json = await linearRequest<IssueResponse>(query, { id: identifier }, client);
  } catch (error) {
    if (error instanceof LinearNotFoundError) return null;
    throw error;
  }

  if (json.errors?.length && !json.data?.issue) {
    if (isNotFound(json.errors)) return null;
    throw new Error(`Linear API error: ${formatErrors(json.errors)}`);
  }

  const issue = json.data?.issue;
  if (!issue) return null;

  return {
    id: issue.id,
    identifier: issue.identifier,
    name: issue.title,
    description: issue.description ?? "",
    comments: (issue.comments?.nodes ?? [])
      .map(c => ({ author: c.user?.name ?? "integration", createdAt: c.createdAt, body: c.body }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    state: issue.state?.name ?? "unknown",
    stateType: issue.state?.type ?? "unknown",
    inProgressState: pickInProgressState(issue.team?.states.nodes ?? []),
    inReviewState: pickInReviewState(issue.team?.states.nodes ?? []),
    url: issue.url,
  };
}

export const TODO_STATE = "Todo";

export interface TodoIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  priorityLabel: string;
  estimate: number | null;
  teamKey: string;
  description: string;
  commentCreatedAt: string[];
}

export interface IssueSnapshot {
  identifier: string;
  title: string;
  url: string;
  state: string;
  assignedToMe: boolean;
  description: string;
  commentCreatedAt: string[];
}

export interface LinearTeam {
  key: string;
  name: string;
}

interface CommentNodes {
  nodes: { createdAt: string }[];
}

export function todoFilter(teamKeys: string[] = []): Record<string, unknown> {
  const filter: Record<string, unknown> = { state: { name: { eq: TODO_STATE } } };
  if (teamKeys.length > 0) filter.team = { key: { in: teamKeys } };
  return filter;
}

export async function fetchTodoIssues(client: LinearClient, teamKeys?: string[]): Promise<TodoIssue[]> {
  const query = `
    query TodoIssues($filter: IssueFilter) {
      viewer { assignedIssues(first: 100, filter: $filter) { nodes {
        id identifier title url priority priorityLabel estimate description
        team { key } comments(first: 100) { nodes { createdAt } }
      } } }
    }
  `;
  const json = await linearRequest<{
    data?: { viewer: { assignedIssues: { nodes: {
      id: string; identifier: string; title: string; url: string;
      priority: number; priorityLabel: string; estimate: number | null;
      description: string | null; team: { key: string }; comments: CommentNodes;
    }[] } } };
    errors?: { message: string }[];
  }>(query, { filter: todoFilter(teamKeys) }, client);

  return (json.data?.viewer.assignedIssues.nodes ?? []).map(node => ({
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    priority: node.priority,
    priorityLabel: node.priorityLabel,
    estimate: node.estimate,
    teamKey: node.team.key,
    description: node.description ?? "",
    commentCreatedAt: node.comments.nodes.map(c => c.createdAt),
  }));
}

interface SnapshotNode {
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  state: { name: string } | null;
  assignee: { isMe: boolean } | null;
  comments: CommentNodes;
}

async function fetchSnapshotBatch(client: LinearClient, ids: string[]): Promise<Record<string, IssueSnapshot | null>> {
  const declarations = ids.map((_, i) => `$i${i}: String!`).join(", ");
  const selections = ids
    .map((_, i) => `i${i}: issue(id: $i${i}) { identifier title url description state { name } assignee { isMe } comments(first: 100) { nodes { createdAt } } }`)
    .join(" ");
  const variables = Object.fromEntries(ids.map((id, i) => [`i${i}`, id]));
  const json = await linearRequest<{
    data?: Record<string, SnapshotNode | null>;
    errors?: { message: string }[];
  }>(`query Snapshots(${declarations}) { ${selections} }`, variables, client);

  return Object.fromEntries(
    ids.map((id, i) => {
      const node = json.data?.[`i${i}`];
      const snapshot: IssueSnapshot | null = node
        ? {
            identifier: node.identifier,
            title: node.title,
            url: node.url,
            state: node.state?.name ?? "unknown",
            assignedToMe: node.assignee?.isMe ?? false,
            description: node.description ?? "",
            commentCreatedAt: node.comments.nodes.map(c => c.createdAt),
          }
        : null;
      return [id, snapshot];
    }),
  );
}

export async function fetchIssueSnapshots(client: LinearClient, ids: string[]): Promise<Record<string, IssueSnapshot | null>> {
  if (ids.length === 0) return {};
  try {
    return await fetchSnapshotBatch(client, ids);
  } catch (error) {
    if (!(error instanceof LinearNotFoundError)) throw error;
    if (ids.length === 1) return { [ids[0]]: null };
    const singles = await Promise.all(ids.map(id => fetchIssueSnapshots(client, [id])));
    return Object.assign({}, ...singles);
  }
}

export async function fetchTeams(client: LinearClient): Promise<LinearTeam[]> {
  const json = await linearRequest<{
    data?: { teams: { nodes: LinearTeam[] } };
    errors?: { message: string }[];
  }>("query { teams(first: 250) { nodes { key name } } }", {}, client);

  return (json.data?.teams.nodes ?? [])
    .map(({ key, name }) => ({ key, name }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
