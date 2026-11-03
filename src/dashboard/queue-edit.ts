import { REPO_NAME, PROJECT_NAME } from "../project.js";
import { TICKET_ID } from "../tickets.js";

export type QueueOp =
  | { op: "add"; id: string; project: string; repo?: string }
  | { op: "remove"; id: string }
  | { op: "move"; order: string[] }
  | { op: "repo"; id: string; repo: string };

const isString = (value: unknown): value is string => typeof value === "string";

function ticketId(value: unknown): string {
  if (!isString(value) || !TICKET_ID.test(value)) throw new Error("invalid ticket ID");
  return value;
}

function repoName(value: unknown): string {
  if (!isString(value) || !REPO_NAME.test(value)) throw new Error("invalid repo name");
  return value;
}

export function parseQueueOp(body: unknown): QueueOp {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  switch (fields.op) {
    case "add": {
      if (!isString(fields.project) || !PROJECT_NAME.test(fields.project)) throw new Error("unknown project");
      return {
        op: "add",
        id: ticketId(fields.id),
        project: fields.project,
        ...(fields.repo !== undefined ? { repo: repoName(fields.repo) } : {}),
      };
    }
    case "remove":
      return { op: "remove", id: ticketId(fields.id) };
    case "move":
      if (!Array.isArray(fields.order)) throw new Error("order must be a list of ticket IDs");
      return { op: "move", order: fields.order.map(ticketId) };
    case "repo":
      return { op: "repo", id: ticketId(fields.id), repo: repoName(fields.repo) };
    default:
      throw new Error("op must be add, remove, move or repo");
  }
}
