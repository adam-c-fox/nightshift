import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Ticket, RepoKind } from "./types.js";

const TICKETS_FILE = path.resolve(import.meta.dirname, "..", "tickets", "tonight.md");
const COMMENT = /<!--[\s\S]*?-->/g;
const HEADING = /^##\s+([A-Z]+-\d+)\s*[–-]\s*(.*)/;

export function loadTickets(file = TICKETS_FILE): Ticket[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return parseTickets(raw);
}

export function parseTickets(raw: string): Ticket[] {
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

    // New ticket heading: "## ENG-142 – Some name"
    const headingMatch = trimmed.match(HEADING);
    if (headingMatch) {
      flush();
      current = {
        id: headingMatch[1],
        name: headingMatch[2].trim() || headingMatch[1],
        repo: "main" as RepoKind,
      };
      continue;
    }

    // repo: main | terraform
    const repoMatch = trimmed.match(/^repo:\s*(main|terraform)\s*$/i);
    if (repoMatch && current) {
      current.repo = repoMatch[1].toLowerCase() as RepoKind;
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
  return tickets;
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

export function archiveTickets(dest: string, file = TICKETS_FILE): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(file, dest);
  writeFileSync(file, ticketsHeader(readFileSync(file, "utf-8")), "utf-8");
}
