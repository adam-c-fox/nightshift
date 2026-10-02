import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { SessionResult, TicketResult } from "./types.js";
import { budgetUsedPct } from "./budget.js";

const REPORTS_DIR = path.resolve(import.meta.dirname, "..", "reports");

const STATUS_COLORS: Record<string, string> = {
  done: "#22c55e",
  partial: "#eab308",
  needs_review: "#f97316",
  skipped: "#6b7280",
  error: "#ef4444",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CI_BADGES: Record<string, { label: string; color: string }> = {
  succeeded: { label: "CI passed", color: "#22c55e" },
  failed: { label: "CI failed", color: "#ef4444" },
  unknown: { label: "CI unknown", color: "#eab308" },
};

function prLinksHTML(t: TicketResult): string {
  if (!t.prUrl) return "";
  const badge = t.pipelineStatus ? CI_BADGES[t.pipelineStatus] : undefined;
  return `<div class="pr-row">
        <a href="${esc(t.prUrl)}" target="_blank" class="pr-link">Open PR${t.prId ? ` #${t.prId}` : ""} →</a>
        ${badge ? `<span class="ci-badge" style="background:${badge.color}">${badge.label}</span>` : ""}
      </div>`;
}

function ticketCardHTML(t: TicketResult): string {
  const color = STATUS_COLORS[t.status] ?? "#6b7280";
  const files = [
    ...t.filesCreated.map(f => `<li class="file created">+ ${esc(f)}</li>`),
    ...t.filesModified.map(f => `<li class="file modified">~ ${esc(f)}</li>`),
  ].join("");

  const tests = t.tests.length > 0
    ? `<div class="tests">${t.tests.map(tst =>
        `<div class="test ${tst.result}">
           <span class="badge">${tst.result === "pass" ? "✅" : "❌"}</span>
           <span class="test-name">${esc(tst.name)}</span>
           <span class="test-file">${esc(tst.file)}</span>
         </div>`).join("")}</div>`
    : `<div class="tests"><div class="test none">No tests reported</div></div>`;

  const verify = t.verifyCommands.length > 0
    ? `<div class="verify"><strong>Verify locally:</strong><ol>${
        t.verifyCommands.map(c => `<li><code>${esc(c)}</code></li>`).join("")
      }</ol></div>`
    : "";

  const notes = t.notes
    ? `<div class="notes"><strong>Notes:</strong> ${esc(t.notes)}</div>`
    : "";

  return `
  <div class="card" id="ticket-${esc(t.ticket.id)}">
    <div class="card-header">
      <span class="status" style="background:${color}">${t.status.toUpperCase()}</span>
      <span class="ticket-id">${esc(t.ticket.id)}</span>
      <span class="ticket-name">${esc(t.ticket.name)}</span>
      <span class="ticket-duration">${t.durationSec}s</span>
    </div>
    <div class="card-body">
      <p class="summary">${esc(t.summary)}</p>
      ${prLinksHTML(t)}
      ${t.linear ? `<a href="${esc(t.linear.url)}" target="_blank" class="linear-link">Open in Linear →</a>` : ""}
      ${files ? `<ul class="files">${files}</ul>` : ""}
      ${tests}
      ${verify}
      ${notes}
      <div class="meta">
        <span>Branch: <code>${esc(t.branch)}</code></span>
        <span>Worktree: <code>${esc(t.worktreePath)}</code></span>
      </div>
    </div>
  </div>`;
}

export function generateHTML(session: SessionResult): string {
  const completed = session.tickets.filter(t => t.status === "done").length;
  const partial = session.tickets.filter(t => t.status === "partial").length;
  const review = session.tickets.filter(t => t.status === "needs_review").length;
  const skipped = session.tickets.filter(t => t.status === "skipped" || t.status === "error").length;
  const b = session.budget;
  const used = budgetUsedPct(b);
  const pctColor = b.currentPct >= b.capPct ? "#ef4444" : b.currentPct >= b.capPct - 3 ? "#eab308" : "#22c55e";
  const fillWidth = Math.min(b.currentPct, 100);
  const startWidth = Math.min(Math.max(0, b.startPct), 100);
  const capLeft = Math.min(b.capPct, 100);

  const gateBanner = session.gateHit ? `<div class="gate-hit">⛔ ${esc(session.skipReason)}</div>` : "";
  const budgetBar = b.unavailable
    ? `
    <div class="budget">
      ${gateBanner}
    </div>`
    : `
    <div class="budget">
      <div class="budget-label">Tonight's allocation: <strong>${b.allocationPct}%</strong> of weekly
        ${b.resetInfo ? `<span class="budget-reset">resets ${esc(b.resetInfo)}</span>` : ""}
      </div>
      <div class="budget-track">
        <div class="budget-fill" style="width:${fillWidth}%;background:${pctColor}"></div>
        <div class="budget-start" style="left:${startWidth}%"></div>
        <div class="budget-marker" style="left:${capLeft}%"></div>
      </div>
      <div class="budget-figures">
        <span>Started at <strong>${Math.max(0, b.startPct)}%</strong></span>
        <span>Ended at <strong>${b.currentPct}%</strong> (used ${used}% of ${b.allocationPct}%)</span>
        <span>Cap <strong>${b.capPct}%</strong></span>
      </div>
      ${gateBanner}
    </div>`;

  const ticketsHTML = session.noTasks
    ? `<div class="no-tasks">
         <div class="no-tasks-icon">🌙</div>
         <p>No tickets in <code>tonight.md</code>. Nothing to process.</p>
         <p class="hint">Add tickets to <code>nightshift/tickets/tonight.md</code> before tonight's 23:00 run.</p>
       </div>`
    : session.tickets.map(ticketCardHTML).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nightshift Report – ${esc(session.date)}</title>
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
    --text: #e2e4eb; --text-dim: #8b8fa3; --accent: #6c5ce7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: var(--bg); color: var(--text); padding: 2rem; max-width: 860px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .date { color: var(--text-dim); font-size: 0.9rem; margin-bottom: 1.5rem; }
  .summary-bar { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
          padding: 0.5rem 1rem; font-size: 0.85rem; }
  .stat strong { display: block; font-size: 1.3rem; }
  .budget { margin-bottom: 2rem; }
  .budget-label { font-size: 0.9rem; margin-bottom: 0.4rem; }
  .budget-figures { display: flex; gap: 1.5rem; flex-wrap: wrap; font-size: 0.85rem; color: var(--text-dim); margin-top: 0.6rem; }
  .budget-figures strong { color: var(--text); }
  .budget-start { position: absolute; top: -3px; width: 2px; height: 16px; background: var(--text-dim); border-radius: 1px; }
  .budget-reset { color: var(--text-dim); margin-left: 0.5rem; font-size: 0.8rem; }
  .budget-track { height: 10px; background: var(--surface); border-radius: 5px; position: relative; overflow: visible; }
  .budget-fill { position: relative; height: 100%; border-radius: 5px; transition: width 0.3s; }
  .budget-marker { position: absolute; top: -3px; width: 2px; height: 16px; background: #ef4444; border-radius: 1px; }
  .gate-hit { color: #ef4444; font-weight: 600; margin-top: 0.5rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
          margin-bottom: 1rem; overflow: hidden; }
  .card-header { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem;
                 border-bottom: 1px solid var(--border); }
  .status { color: #fff; font-size: 0.7rem; font-weight: 700; padding: 0.2rem 0.6rem;
            border-radius: 4px; letter-spacing: 0.5px; }
  .ticket-id { font-weight: 700; font-family: ui-monospace, monospace; }
  .ticket-name { flex: 1; color: var(--text-dim); }
  .ticket-duration { color: var(--text-dim); font-size: 0.8rem; }
  .card-body { padding: 1rem; }
  .summary { margin-bottom: 0.75rem; }
  .linear-link { color: var(--accent); text-decoration: none; font-size: 0.85rem; display: inline-block; margin-bottom: 0.75rem; }
  .linear-link:hover { text-decoration: underline; }
  .pr-row { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
  .pr-link { color: var(--accent); text-decoration: none; font-size: 0.85rem; font-weight: 600; }
  .pr-link:hover { text-decoration: underline; }
  .ci-badge { color: #fff; font-size: 0.7rem; font-weight: 700; padding: 0.2rem 0.6rem; border-radius: 4px; letter-spacing: 0.5px; }
  .files { list-style: none; margin-bottom: 0.75rem; }
  .file { font-family: ui-monospace, monospace; font-size: 0.85rem; padding: 0.1rem 0; }
  .file.created { color: #22c55e; }
  .file.modified { color: #eab308; }
  .tests { margin-bottom: 0.75rem; }
  .test { display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0; font-size: 0.85rem; }
  .test-name { flex: 1; }
  .test-file { color: var(--text-dim); font-family: ui-monospace, monospace; font-size: 0.8rem; }
  .test.pass .badge { color: #22c55e; }
  .test.fail .badge { color: #ef4444; }
  .test.none { color: var(--text-dim); font-style: italic; }
  .verify { margin-bottom: 0.75rem; font-size: 0.9rem; }
  .verify ol { margin-left: 1.2rem; margin-top: 0.3rem; }
  .verify code { background: var(--bg); padding: 0.15rem 0.4rem; border-radius: 4px;
                 font-size: 0.85rem; display: inline-block; margin: 0.1rem 0; }
  .notes { color: var(--text-dim); font-size: 0.9rem; margin-bottom: 0.75rem; }
  .meta { display: flex; gap: 1.5rem; font-size: 0.8rem; color: var(--text-dim);
          border-top: 1px solid var(--border); padding-top: 0.75rem; margin-top: 0.5rem; }
  .meta code { background: var(--bg); padding: 0.1rem 0.3rem; border-radius: 3px; }
  .no-tasks { text-align: center; padding: 3rem 1rem; }
  .no-tasks-icon { font-size: 3rem; margin-bottom: 1rem; }
  .no-tasks p { color: var(--text-dim); }
  .hint { font-size: 0.85rem; margin-top: 0.5rem; }
  .hint code { background: var(--surface); padding: 0.15rem 0.4rem; border-radius: 4px; }
  .footer { margin-top: 2rem; text-align: center; color: var(--text-dim); font-size: 0.8rem; }
</style>
</head>
<body>
  <h1>🌙 Nightshift Report</h1>
  <div class="date">${esc(session.date)} · ${esc(session.startedAt)} → ${esc(session.endedAt)}</div>

  <div class="summary-bar">
    <div class="stat"><strong>${session.tickets.length}</strong>tickets</div>
    <div class="stat"><strong style="color:#22c55e">${completed}</strong>done</div>
    <div class="stat"><strong style="color:#eab308">${partial}</strong>partial</div>
    <div class="stat"><strong style="color:#f97316">${review}</strong>review</div>
    <div class="stat"><strong style="color:#6b7280">${skipped}</strong>skipped</div>
  </div>

  ${budgetBar}

  ${ticketsHTML}

  <div class="footer">Generated by nightshift · ${new Date().toISOString()}</div>
</body>
</html>`;
}

export function writeReport(session: SessionResult): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const filename = `nightshift-${session.date}.html`;
  const filePath = path.join(REPORTS_DIR, filename);
  const html = generateHTML(session);
  writeFileSync(filePath, html, "utf-8");
  return filePath;
}
