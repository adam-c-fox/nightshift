import path from "node:path";
import { ROOT } from "./state.js";
import { REPO_NAME } from "./project.js";
import {
  COMMENT,
  HEADING,
  REPO_LINE,
  loadFile,
  parseSections,
  validateBases,
  validateRepos,
  type TicketRepos,
} from "./tickets.js";
import type { Ticket } from "./types.js";

export const QUEUE_FILE = path.join(ROOT, "tonight.md");

export type QueueRepos = Record<string, TicketRepos>;

export function parseQueue(raw: string, repos: QueueRepos): Ticket[] {
  const tickets = parseSections(raw).map((section): Ticket => {
    const fail = (reason: string): never => {
      throw new Error(`Ticket ${section.id}: ${reason}`);
    };
    if (section.project === undefined) return fail("needs a project: line");
    const projectRepos = repos[section.project];
    if (projectRepos === undefined) {
      return fail(`unknown project "${section.project}" (known: ${Object.keys(repos).join(", ")})`);
    }
    const ticket = { ...section, project: section.project, repo: section.repo ?? projectRepos.defaultRepo };
    validateRepos([ticket], projectRepos.names);
    return ticket;
  });
  const repeated = tickets.find((t, i) => tickets.findIndex((o) => o.id === t.id) !== i);
  if (repeated) throw new Error(`Ticket ${repeated.id}: listed twice`);
  validateBases(tickets);
  return tickets;
}

export function loadQueue(file: string, repos: QueueRepos): Ticket[] {
  return loadFile(file, (raw) => parseQueue(raw, repos), []);
}

interface Section {
  id: string;
  lines: string[];
  masked: string[];
}

function splitQueue(raw: string): { header: string; sections: Section[] } {
  const lines = raw.split("\n");
  const masked = raw.replace(COMMENT, (c) => c.replace(/[^\n]/g, " ")).split("\n");
  const starts = masked.flatMap((line, i) => (HEADING.test(line.trim()) ? [i] : []));
  if (starts.length === 0) return { header: raw, sections: [] };
  const sections = starts.map((start, n): Section => {
    let end = starts[n + 1] ?? lines.length;
    while (end > start + 1 && lines[end - 1].trim() === "") end--;
    return {
      id: HEADING.exec(masked[start].trim())![1],
      lines: lines.slice(start, end),
      masked: masked.slice(start, end),
    };
  });
  return { header: lines.slice(0, starts[0]).join("\n") + (starts[0] > 0 ? "\n" : ""), sections };
}

function joinQueue(header: string, sections: Section[]): string {
  const gap = header === "" || header.endsWith("\n\n") ? "" : header.endsWith("\n") ? "\n" : "\n\n";
  return header + (sections.length ? gap + sections.map((s) => s.lines.join("\n")).join("\n\n") + "\n" : "");
}

function rewrite(raw: string, repos: QueueRepos, edit: (sections: Section[]) => Section[]): string {
  const { header, sections } = splitQueue(raw);
  const result = joinQueue(header, edit(sections));
  parseQueue(result, repos);
  return result;
}

function requireSection(sections: Section[], id: string): Section {
  const section = sections.find((s) => s.id === id);
  if (!section) throw new Error(`${id} is not in the queue`);
  return section;
}

export function addToQueue(
  raw: string,
  repos: QueueRepos,
  t: { id: string; name: string; project: string; repo: string },
): string {
  return rewrite(raw, repos, (sections) => {
    if (sections.some((s) => s.id === t.id)) throw new Error(`${t.id} is already in the queue`);
    const lines = [`## ${t.id} – ${t.name.replace(/\s+/g, " ").trim()}`, `project: ${t.project}`, `repo: ${t.repo}`];
    return [...sections, { id: t.id, lines, masked: lines }];
  });
}

export function removeFromQueue(raw: string, repos: QueueRepos, id: string): string {
  return rewrite(raw, repos, (sections) => {
    requireSection(sections, id);
    return sections.filter((s) => s.id !== id);
  });
}

export function moveInQueue(raw: string, repos: QueueRepos, order: string[]): string {
  return rewrite(raw, repos, (sections) => {
    const ids = sections.map((s) => s.id);
    if (order.length !== ids.length || !ids.every((id) => order.includes(id)) || new Set(order).size !== order.length) {
      throw new Error("order must list exactly the tickets in the queue");
    }
    return order.map((id) => requireSection(sections, id));
  });
}

export function setQueueRepo(raw: string, repos: QueueRepos, id: string, repo: string): string {
  if (!REPO_NAME.test(repo)) throw new Error(`Ticket ${id}: unknown repo "${repo}"`);
  return rewrite(raw, repos, (sections) => {
    const target = requireSection(sections, id);
    const at = target.masked.findIndex((line) => REPO_LINE.test(line.trim()));
    const lines = [...target.lines];
    const masked = [...target.masked];
    if (at === -1) {
      lines.splice(1, 0, `repo: ${repo}`);
      masked.splice(1, 0, `repo: ${repo}`);
    } else {
      lines[at] = `repo: ${repo}`;
      masked[at] = `repo: ${repo}`;
    }
    return sections.map((s) => (s === target ? { ...target, lines, masked } : s));
  });
}
