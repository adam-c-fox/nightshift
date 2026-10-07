import { CI_BADGES, esc, STATUS_COLORS } from "../../report.js";
import type { PolicyVerdict } from "../../pr.js";
import type { ProjectRun } from "../../heartbeat.js";
import type { InboxItem, NightRow, PrLive } from "../inbox.js";
import { badge } from "./clock-off.js";

const EMPTY = "—";
const SUMMARY_LIMIT = 160;
const NEUTRAL_COLOR = "#6b7280";
const PENDING_COLOR = "#eab308";
const MINUTE_MS = 60_000;

type ActivePr = Extract<PrLive, { state: "active" }>;
type TicketItem = Extract<InboxItem, { kind: "ticket" }>;
type PostmortemItem = Extract<InboxItem, { kind: "postmortem" }>;

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const rest = String(minutes % 60).padStart(2, "0");
  return `${Math.floor(minutes / 60)}h ${rest}m`;
}

function runBanner(run: ProjectRun): string {
  const { view } = run;
  if (view.state === "idle") return "";
  const project = esc(run.project);
  const { heartbeat } = view;
  if (view.state === "stale") {
    return `<div class="run-banner stale">${project} run looks stopped: last heartbeat ${formatDuration(view.sinceHeartbeatMs)} ago (pid ${heartbeat.pid})</div>`;
  }
  const ticket = heartbeat.ticketId
    ? `${esc(heartbeat.ticketId)} (${heartbeat.ticketIndex} of ${heartbeat.total})`
    : `(${heartbeat.total} tickets)`;
  return `<div class="run-banner">🌙 Running ${project}: ${ticket} · ${esc(heartbeat.phase)} · ${formatDuration(view.elapsedMs)}</div>`;
}

export function runBannerHTML(runs: ProjectRun[]): string {
  return runs.map(runBanner).filter(Boolean).join("\n");
}

function summaryLine(summary: string): string {
  const oneLine = summary.replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_LIMIT
    ? `${oneLine.slice(0, SUMMARY_LIMIT - 1)}…`
    : oneLine;
}

function ciBadge(ci: PolicyVerdict | "unknown"): string {
  if (ci === "pending") return badge("CI pending", PENDING_COLOR);
  if (ci === "none") return badge("no CI", NEUTRAL_COLOR);
  const known = CI_BADGES[ci] ?? CI_BADGES.unknown;
  return badge(known.label, known.color);
}

function votesText(votes: ActivePr["votes"]): string {
  return `✓${votes.approved} ⏳${votes.waiting} ✗${votes.rejected}`;
}

function prLink(item: TicketItem): string {
  const label = `PR #${item.prId}`;
  return item.prUrl
    ? `<a href="${esc(item.prUrl)}" target="_blank" rel="noopener">${label}</a>`
    : label;
}

function prHTML(item: TicketItem): string {
  const { pr } = item;
  if (!pr || pr.state === "closed" || item.prId === undefined) return "";
  if (pr.state === "unknown") {
    return `<span class="pr">PR #${item.prId} · status unknown (${esc(pr.reason)})</span>`;
  }
  const parts = [
    prLink(item),
    ciBadge(pr.ci),
    `<span class="votes">${votesText(pr.votes)}</span>`,
  ];
  if (pr.isDraft) parts.push(`<span class="dim">draft</span>`);
  if (pr.autoComplete) parts.push(badge("auto-complete", STATUS_COLORS.error));
  return `<span class="pr">${parts.join(" ")}</span>`;
}

function ticketBody(item: TicketItem): string {
  const status = badge(
    item.status.replace("_", " "),
    STATUS_COLORS[item.status] ?? NEUTRAL_COLOR,
  );
  const link = `<a href="${esc(item.reportHref)}#ticket-${esc(item.ticketId)}">${esc(item.ticketId)}</a>`;
  return [
    status,
    `<strong>${link}</strong>`,
    `<span class="name">${esc(item.name)}</span>`,
    prHTML(item),
    `<span class="summary dim">${esc(summaryLine(item.summary))}</span>`,
  ]
    .filter(Boolean)
    .join(" ");
}

function postmortemBody(item: PostmortemItem): string {
  const { suggestion } = item;
  const link = `<a href="${esc(item.reportHref)}#postmortem">${esc(suggestion.id)}</a>`;
  return [
    badge("postmortem", "#6c5ce7"),
    `<strong>${link}</strong>`,
    `<span class="name">${esc(suggestion.target)}</span>`,
    `<span class="summary dim">${esc(suggestion.problem)}</span>`,
    `<span class="summary">Change: ${esc(suggestion.change)}</span>`,
  ].join(" ");
}

function inboxLabel(item: InboxItem): string {
  return item.kind === "ticket" ? item.ticketId : item.suggestion.id;
}

function inboxItemHTML(item: InboxItem): string {
  const tick = `<input type="checkbox" class="inbox-tick" data-report="${esc(item.reportId)}" data-key="${esc(item.key)}" aria-label="Mark ${esc(inboxLabel(item))} actioned">`;
  const when = `<span class="dim when">${esc(item.date)} · ${esc(item.project)}</span>`;
  const body = item.kind === "ticket" ? ticketBody(item) : postmortemBody(item);
  return `<li class="inbox-item">${tick} ${when} <div class="inbox-body">${body}</div></li>`;
}

export function inboxHTML(items: InboxItem[]): string {
  if (items.length === 0) return `<p class="empty">Nothing outstanding.</p>`;
  return `<ul class="inbox">\n${items.map(inboxItemHTML).join("\n")}\n</ul>`;
}

function countsCell(counts: NonNullable<NightRow["counts"]>): string {
  const part = (value: number, symbol: string, status: string) =>
    `<span style="color:${STATUS_COLORS[status]}">${value}${symbol}</span>`;
  const parts = [
    part(counts.done, "✓", "done"),
    part(counts.partial, "~", "partial"),
    part(counts.needsReview, "!", "needs_review"),
    part(counts.skipped, "–", "skipped"),
  ];
  return `${parts.join(" ")} / ${counts.total}`;
}

function budgetCell(row: NightRow): string {
  if (row.budgetUsedPct !== undefined) return `${row.budgetUsedPct}%`;
  return row.budgetUnavailable ? `<span class="dim">unavailable</span>` : EMPTY;
}

function nightRowHTML(row: NightRow): string {
  const cell = (label: string, content: string) =>
    `<td data-label="${label}">${content}</td>`;
  const dryRun = row.dryRun ? ` ${badge("dry run", NEUTRAL_COLOR)}` : "";
  const titleAttr = row.error ? ` title="${esc(row.error)}"` : "";
  const link = `<a href="${esc(row.href)}">Report</a>`;
  const stats = row.linkOnly
    ? [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]
    : [
        row.counts ? countsCell(row.counts) : EMPTY,
        budgetCell(row),
        row.durationSec === undefined
          ? EMPTY
          : formatDuration(row.durationSec * 1000),
        String(row.suggestions ?? EMPTY),
        String(row.outstanding ?? EMPTY),
      ];
  const [tickets, budget, duration, suggestions, outstanding] = stats;
  return `<tr${titleAttr}>
${cell("Date", `${esc(row.date)}${dryRun}`)}
${cell("Project", esc(row.project))}
${cell("Tickets", tickets)}
${cell("Budget used", budget)}
${cell("Duration", duration)}
${cell("Suggestions", suggestions)}
${cell("Outstanding", outstanding)}
${cell("Report", link)}
</tr>`;
}

export function nightsHTML(rows: NightRow[]): string {
  if (rows.length === 0) return `<p class="empty">No reports yet.</p>`;
  const headers = [
    "Date",
    "Project",
    "Tickets",
    "Budget used",
    "Duration",
    "Suggestions",
    "Outstanding",
    "Report",
  ];
  return `<table class="tickets nights">
<thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
<tbody>
${rows.map(nightRowHTML).join("\n")}
</tbody>
</table>`;
}
