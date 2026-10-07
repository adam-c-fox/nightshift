import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Ticket } from "./types.js";

export interface TicketRepos {
  names: string[];
  defaultRepo: string;
}


const COMMENT = /<!--[\s\S]*?-->/g;
const HEADING = /^##\s+([A-Z]+-\d+)\s*[–-]\s*(.*)/;

export function loadTickets(file: string, repos: TicketRepos): Ticket[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return parseTickets(raw, repos);
}

export function parseTickets(raw: string, repos: TicketRepos): Ticket[] {
  const lines = raw.replace(COMMENT, "").split(/\r?\n/);
  const tickets: Ticket[] = [];
  let current: Omit<Ticket, "context"> | null = null;
  let contextLines: string[] = [];

  const flush = () => {
    if (current) {
      tickets.push({ ...current, context: contextLines });
    }
    current = null;
    contextLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    const headingMatch = trimmed.match(HEADING);
    if (headingMatch) {
      flush();
      current = {
        id: headingMatch[1],
        name: headingMatch[2].trim() || headingMatch[1],
        repo: repos.defaultRepo,
      };
      continue;
    }

    const repoMatch = trimmed.match(/^repo:\s*([a-z0-9][a-z0-9_-]*)\s*$/i);
    if (repoMatch && current) {
      current.repo = repoMatch[1].toLowerCase();
      continue;
    }

    const baseMatch = trimmed.match(/^base:\s*([A-Z]+-\d+)\s*$/i);
    if (baseMatch && current) {
      current.base = baseMatch[1].toUpperCase();
      continue;
    }

    // Bullet line → context
    const bulletMatch = trimmed.match(/^-\s+(.+)/);
    if (bulletMatch && current) {
      contextLines.push(bulletMatch[1].trim());
      continue;
    }
  }

  flush();
  validateRepos(tickets, repos.names);
  validateBases(tickets);
  return tickets;
}

function validateRepos(tickets: Ticket[], names: string[]): void {
  for (const t of tickets) {
    if (!names.includes(t.repo)) throw new Error(`Ticket ${t.id}: unknown repo "${t.repo}" (known: ${names.join(", ")})`);
  }
}

function validateBases(tickets: Ticket[]): void {
  tickets.forEach((ticket, i) => {
    if (!ticket.base) return;
    const fail = (reason: string) => { throw new Error(`Ticket ${ticket.id}: base ${ticket.base} ${reason}`); };
    if (ticket.base === ticket.id) fail("cannot be the ticket itself");
    const parent = tickets.slice(0, i).find(t => t.id === ticket.base);
    if (!parent) fail("must be a ticket listed earlier in the file");
    else if (parent.repo !== ticket.repo) fail("must be in the same repo");
  });
}

export function ticketsHeader(raw: string): string {
  const masked = raw.replace(COMMENT, c => c.replace(/[^\n]/g, " "));
  let offset = 0;
  for (const line of masked.split("\n")) {
    if (HEADING.test(line.trim())) return raw.slice(0, offset);
    offset += line.length + 1;
  }
  return raw;
}

export function archiveTickets(dest: string, file: string): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(file, dest);
  writeFileSync(file, ticketsHeader(readFileSync(file, "utf-8")), "utf-8");
}
