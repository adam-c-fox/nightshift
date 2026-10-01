import { requireEnv } from "./env.js";
import type { LinearTicket } from "./types.js";

export type { LinearTicket };

const BASE_URL = "https://api.linear.app/graphql";

interface IssueResponse {
  data?: { issue?: {
    id: string; identifier: string; title: string;
    description: string | null;
    state: { name: string } | null;
    url: string;
  } | null };
  errors?: { message: string }[];
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
        state { name }
        url
      }
    }
  `;

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": authorizationHeader(requireEnv("LINEAR_API_KEY")),
    },
    body: JSON.stringify({ query, variables: { id: identifier } }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linear API ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as IssueResponse;

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
    state: issue.state?.name ?? "unknown",
    url: issue.url,
  };
}
