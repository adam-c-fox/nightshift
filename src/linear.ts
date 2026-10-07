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

async function linearRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": authorizationHeader(requireEnv("LINEAR_API_KEY")),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linear API ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
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

export async function fetchTicket(identifier: string): Promise<LinearTicket | null> {
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

  const json = await linearRequest<IssueResponse>(query, { id: identifier });

  if (json.errors?.length && !json.data?.issue) {
    const notFound = json.errors.every(e => /not found/i.test(e.message));
    if (notFound) return null;
    throw new Error(`Linear API error: ${json.errors.map(e => e.message).join("; ").slice(0, 200)}`);
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
