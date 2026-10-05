import type { ProcessedTicket } from "./related.js";
import type { Ticket } from "./types.js";

export interface StackParent {
  ticketId: string;
  branch: string;
  prId: number;
}

export type StackDecision =
  | { kind: "fresh" }
  | { kind: "stacked"; parent: StackParent }
  | { kind: "skip"; reason: string };

export function stackDecision(ticket: Ticket, processed: Map<string, ProcessedTicket>): StackDecision {
  if (!ticket.base) return { kind: "fresh" };
  const pushed = processed.get(ticket.base)?.pushed;
  if (!pushed) return { kind: "skip", reason: `Skipped – base ${ticket.base} was not pushed tonight.` };
  return { kind: "stacked", parent: { ticketId: ticket.base, ...pushed } };
}

export const stackedContext = (parent: StackParent): string =>
  `This branch is stacked on ${parent.ticketId} (branch ${parent.branch}, PR #${parent.prId}); that change is already in your base. Build on it; don't reimplement it.`;
