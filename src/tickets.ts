import { readFileSync } from "node:fs";
import path from "node:path";
import type { Ticket, RepoKind } from "./types.js";

const TICKETS_FILE = path.resolve(import.meta.dirname, "..", "tickets", "tonight.md");

export function loadTickets(): Ticket[] {
  let raw: string;
  try {
    raw = readFileSync(TICKETS_FILE, "utf-8");
  } catch {
    return [];
  }

  const lines = raw.split("\n");
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
    const headingMatch = trimmed.match(/^##\s+([A-Z]+-\d+)\s*[–-]\s*(.*)/);
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

    // Blank line or non-ticket line → flush if we're outside a ticket
    if (trimmed === "" && current) {
      // Don't flush yet – could be a blank line within a ticket section
      // Only flush on next heading or EOF
    }
  }

  flush();
  return tickets;
}
