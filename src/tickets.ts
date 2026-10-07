import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isValidPercent, REPO_NAME_PATTERN } from "./project.js";
import type { Ticket } from "./types.js";

export interface TicketRepos {
  names: string[];
  defaultRepo: string;
}

const COMMENT = /<!--[\s\S]*?-->/g;
const REPO_LINE = new RegExp(`^repo:\\s*(${REPO_NAME_PATTERN})\\s*$`, "i");
const ALLOWANCE_LINE = /^allowance:\s*(.*?)\s*$/i;
export const TICKET_ID_PATTERN = "[A-Z]+-\\d+";
export const TICKET_ID = new RegExp(`^${TICKET_ID_PATTERN}$`);
const HEADING = new RegExp(`^##\\s+(${TICKET_ID_PATTERN})\\s*[–-]\\s*(.*)`);

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

export function loadAllowance(file: string): number | undefined {
  try {
    return parseAllowance(readFileSync(file, "utf-8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export function parseAllowance(raw: string): number | undefined {
  const values = headerLines(raw).masked.flatMap(line => ALLOWANCE_LINE.exec(line.trim())?.[1] ?? []);
  if (values.length > 1) throw new Error("tonight.md: allowance is set more than once");
  if (values.length === 0) return undefined;
  const percent = Number(values[0]);
  if (!/^\d+$/.test(values[0]) || !isValidPercent(percent)) {
    throw new Error(`tonight.md: allowance must be a whole number from 1 to 100, got "${values[0]}"`);
  }
  return percent;
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

    if (current && ALLOWANCE_LINE.test(trimmed)) throw new Error("tonight.md: allowance: must go above the first ticket");

    const repoMatch = trimmed.match(REPO_LINE);
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

function headerLines(raw: string): { lines: string[]; masked: string[]; hasTickets: boolean } {
  const lines = raw.split("\n");
  const masked = raw.replace(COMMENT, c => c.replace(/[^\n]/g, " ")).split("\n");
  const firstTicket = masked.findIndex(line => HEADING.test(line.trim()));
  const end = firstTicket === -1 ? lines.length : firstTicket;
  return { lines: lines.slice(0, end), masked: masked.slice(0, end), hasTickets: firstTicket !== -1 };
}

export function ticketsHeader(raw: string): string {
  const { lines, masked, hasTickets } = headerLines(raw);
  const kept = lines.filter((_, i) => !ALLOWANCE_LINE.test(masked[i].trim()));
  return kept.join("\n") + (hasTickets ? "\n" : "");
}

export function archiveTickets(dest: string, file: string): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(file, dest);
  writeFileSync(file, ticketsHeader(readFileSync(file, "utf-8")), "utf-8");
}
