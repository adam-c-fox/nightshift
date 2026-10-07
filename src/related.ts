
export interface PushedBranch {
  branch: string;
  prId: number;
}

export interface ProcessedTicket {
  branch: string;
  repo: string;
  pushed?: PushedBranch;
}

const TICKET_ID = /\b[A-Z][A-Z0-9]*-\d+\b/g;

export function relatedTickets(
  ownId: string, repo: string, texts: string[], processed: Map<string, ProcessedTicket>,
): { ticketId: string; branch: string }[] {
  const mentioned = new Set(texts.flatMap(t => t.match(TICKET_ID) ?? []));
  mentioned.delete(ownId);
  return [...mentioned].flatMap(ticketId => {
    const done = processed.get(ticketId);
    return done && done.repo === repo ? [{ ticketId, branch: done.branch }] : [];
  });
}
