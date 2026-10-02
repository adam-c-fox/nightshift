import type { RepoKind } from "./types.js";

export interface ProcessedTicket {
  branch: string;
  repo: RepoKind;
}

const TICKET_ID = /\b[A-Z][A-Z0-9]*-\d+\b/g;

export function relatedTickets(
  ownId: string, repo: RepoKind, texts: string[], processed: Map<string, ProcessedTicket>,
): { ticketId: string; branch: string }[] {
  const mentioned = new Set(texts.flatMap(t => t.match(TICKET_ID) ?? []));
  mentioned.delete(ownId);
  return [...mentioned].flatMap(ticketId => {
    const done = processed.get(ticketId);
    return done && done.repo === repo ? [{ ticketId, branch: done.branch }] : [];
  });
}
