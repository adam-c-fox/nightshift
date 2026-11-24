import type { PipelineStatus, ReviewRisk, TicketConflict, TicketResult } from "./types.js";
import type { PrHost, PullRequest } from "./pr-host.js";

export const DEFAULT_BASE_BRANCH = "main";

export interface FailedCheck {
  name: string;
  buildId: number | undefined;
}

export interface PRResult {
  prId: number;
  url: string;
  pipelineStatus: PipelineStatus;
  failedChecks: FailedCheck[];
  unknownReason?: string;
  durationSec: number;
}

const SUMMARY_TITLE_MAX = 80;

export function buildPrTitle(ticketId: string, title: string, summary: string): string {
  const text = title.trim() || summary.split("\n")[0].trim().slice(0, SUMMARY_TITLE_MAX);
  const withoutId = text.replace(new RegExp(`\\s*\\(${ticketId}\\)\\s*$`), "").trim();
  return `${withoutId} (${ticketId})`;
}

export function commitSubject(ticketId: string, title: string, summary: string): string {
  const full = buildPrTitle(ticketId, title, summary);
  return ticketId.startsWith("PR-") ? full.slice(0, -` (${ticketId})`.length) : full;
}

export interface PrContent {
  ticketId: string;
  title: string;
  summary: string;
  verifyCommands: string[];
  ticketUrl?: string;
  risks: ReviewRisk[];
  conflicts: TicketConflict[];
  stackedOn?: { ticketId: string; prId: number };
}

export function prContent(result: TicketResult): PrContent {
  return {
    ticketId: result.ticket.id, title: result.title ?? "", summary: result.summary,
    verifyCommands: result.verifyCommands, ticketUrl: result.linear?.url,
    risks: result.review?.risks ?? [],
    conflicts: result.review?.conflicts ?? [],
  };
}

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

export function buildPrDescription(
  ticketId: string, summary: string, verifyCommands: string[], ticketUrl?: string, risks: ReviewRisk[] = [],
  stackedOn?: { ticketId: string; prId: number }, conflicts: TicketConflict[] = [],
): string {
  const ticket = ticketUrl ? `[${ticketId}](${ticketUrl})` : ticketId;
  const needsDecision = conflicts.length > 0
    ? ["", "Needs a decision before merge:", ...conflicts.map(c =>
        `- \`${c.file}\`: ${c.ticket && c.quoted ? `The ticket asks for "${c.ticket}". ` : ""}${sentence(c.consequence)}${c.change ? ` Suggested change: ${sentence(c.change)}` : ""}`)]
    : [];
  const worthALook = risks.length > 0
    ? ["", "Worth a closer look:", ...risks.map(r => `- \`${r.file}\`: ${r.risk}`)]
    : [];
  const verify = verifyCommands.length > 0
    ? ["", "To verify locally:", ...verifyCommands.map(c => `- \`${c}\``)]
    : [];
  const stacked = stackedOn ? [`Stacked on PR #${stackedOn.prId} (${stackedOn.ticketId}); merge that first.`, ""] : [];
  return [`Ticket: ${ticket}`, "", ...stacked, summary, ...needsDecision, ...worthALook, ...verify].join("\n").slice(0, 4000);
}

export interface ExistingPr { prId: number; sourceBranch: string; targetBranch: string; autoComplete: boolean; url: string }

export function pickTicketPr(prs: PullRequest[], expectedBranch: string): ExistingPr | null {
  const isTicketBranch = (branch: string) => branch === expectedBranch || (branch.startsWith(`${expectedBranch}-`) && /^\d+$/.test(branch.slice(expectedBranch.length + 1)));
  const matches = prs.filter(p => isTicketBranch(p.sourceBranch));
  if (matches.length === 0) return null;
  const { prId, sourceBranch, targetBranch, autoComplete, url } = matches.reduce((a, b) => (b.prId > a.prId ? b : a));
  return { prId, sourceBranch, targetBranch, autoComplete, url };
}

export type PrAction = "update" | "open" | "hold";

export function prAction(existing: ExistingPr | null, startedFromPr: boolean): PrAction {
  if (!existing || !startedFromPr) return "open";
  return existing.autoComplete ? "hold" : "update";
}

export async function findOpenTicketPr(host: PrHost, expectedBranch: string, repoPath: string): Promise<ExistingPr | null> {
  return pickTicketPr((await host.listOpenPrs(repoPath)).prs, expectedBranch);
}
