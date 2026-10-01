const BASE_URL = "https://api.linear.app/graphql";

function getApiKey(): string {
  const envKey = process.env.LINEAR_API_KEY;
  if (envKey) return envKey;

  // Fallback: read from nightshift/.env
  try {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const envPath = resolve(import.meta.dirname, "..", ".env");
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(/^LINEAR_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* fall through */ }

  throw new Error("LINEAR_API_KEY not found in env or .env file");
}

export interface LinearTicket {
  id: string;
  identifier: string;
  name: string;
  description: string;
  state: string;
  url: string;
}

export async function fetchTicket(identifier: string): Promise<LinearTicket | null> {
  const query = `
    query GetIssue($id: String!) {
      issue(id: $id) {
        id
        identifier
        name
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
      "Authorization": getApiKey(),
    },
    body: JSON.stringify({ query, variables: { id: identifier } }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linear API ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    data?: { issue?: {
      id: string; identifier: string; name: string;
      description: string | null;
      state: { name: string } | null;
      url: string;
    } };
  };

  const issue = json.data?.issue;
  if (!issue) return null;

  return {
    id: issue.id,
    identifier: issue.identifier,
    name: issue.name,
    description: issue.description ?? "",
    state: issue.state?.name ?? "unknown",
    url: issue.url,
  };
}
