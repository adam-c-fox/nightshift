import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { lensLabel } from "./types.js";
import type { CheckRecord, FixResolution, FixVerification, LensRun, ReviewFinding, RunRecord, RunUsage, SessionPostmortem, SessionResult, TicketResult, TicketReview, VerifyResult } from "./types.js";
import { budgetUsedPct } from "./budget.js";
import { DASHBOARD_ORIGIN } from "./dashboard/address.js";

export const REPORTS_DIR = path.resolve(import.meta.dirname, "..", "reports");

export const STATUS_COLORS: Record<string, string> = {
  done: "#22c55e",
  partial: "#eab308",
  needs_review: "#f97316",
  skipped: "#6b7280",
  error: "#ef4444",
};

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function prose(s: string): string {
  return esc(s).replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
}

export const CI_BADGES: Record<string, { label: string; color: string }> = {
  succeeded: { label: "CI passed", color: "#22c55e" },
  failed: { label: "CI failed", color: "#ef4444" },
  unknown: { label: "CI unknown", color: "#eab308" },
};

function prLinksHTML(t: TicketResult): string {
  if (!t.prUrl) return "";
  const badge = t.pipelineStatus ? CI_BADGES[t.pipelineStatus] : undefined;
  return `<span class="pr-row">
        <a href="${esc(t.prUrl)}" target="_blank" class="pr-link">PR${t.prId ? ` #${t.prId}` : ""} →</a>
        ${badge ? `<span class="ci-badge" style="background:${badge.color}">${badge.label}</span>` : ""}
      </span>`;
}

export const REPORT_BASE = /^nightshift-(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/;

export const ticketActionKey = (id: string): string => `ticket:${id}`;
export const POSTMORTEM_ID_PATTERN = "[A-Za-z0-9_-]{1,32}";
export const postmortemActionKey = (id: string): string => `postmortem:${id}`;

export const THEME_CSS = `
  :root {
    --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
    --text: #e2e4eb; --text-dim: #8b8fa3; --accent: #6c5ce7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: var(--bg); color: var(--text); }`;

export interface TicketCounts { total: number; done: number; partial: number; needsReview: number; skipped: number }

export function countTickets(tickets: TicketResult[]): TicketCounts {
  const count = (...statuses: string[]) => tickets.filter(t => statuses.includes(t.status)).length;
  return {
    total: tickets.length,
    done: count("done"),
    partial: count("partial"),
    needsReview: count("needs_review"),
    skipped: count("skipped", "error"),
  };
}

function actionedBoxHTML(key: string, label: string): string {
  return `<input type="checkbox" class="actioned" data-key="${esc(key)}" title="Mark actioned" aria-label="Mark ${esc(label)} actioned">`;
}

function resolutionLabel(resolution: FixResolution, verify: VerifyResult | undefined, verification: FixVerification | undefined): string {
  if (resolution.status === "fixed") return verify ? "Fixed · verified" : verification ? "Fixed (unverified)" : "Fixed";
  return verify?.status === "unresolved" ? "Claimed fixed" : "Not fixed";
}

function findingHTML(finding: ReviewFinding, resolution: FixResolution | undefined, verification?: FixVerification): string {
  const verify = verification?.results.find(r => r.id === finding.id);
  const resolved = resolution
    ? `<div class="res res-${resolution.status}"><strong>${resolutionLabel(resolution, verify, verification)}:</strong> ${prose(resolution.how)}</div>`
    : "";
  return `<li class="finding">
           <div class="finding-head">
             <span class="sev sev-${finding.severity}">${finding.severity}</span>
             <span class="finding-id">${esc(finding.id)}</span>${finding.from ? `<span class="finding-from">(from ${esc(finding.from)})</span>` : ""}
             <code class="finding-file">${esc(finding.file)}</code>
           </div>
           <div>${prose(finding.issue)}</div>
           <div class="finding-suggestion">Suggestion: ${prose(finding.suggestion)}</div>
           ${resolved}
         </li>`;
}

function risksHTML(t: TicketResult): string {
  const risks = t.review?.risks ?? [];
  if (risks.length === 0) return "";
  const items = risks.map(r => `<li>${r.data ? `<span class="data-risk">recorded data</span> ` : ""}<code class="finding-file">${esc(r.file)}</code> ${prose(r.risk)}</li>`).join("");
  return `<div class="review"><strong>Worth a closer look</strong><ul class="risks">${items}</ul></div>`;
}

const CHECK_RESULTS: Record<NonNullable<CheckRecord["status"]>, string> = {
  passed: "passed", regression: "regression", "pre-existing": "failed (pre-existing)", new: "new", "not-run": "did not run",
};

function checkResult(c: CheckRecord): string {
  if (c.status === "new") return c.passed ? "passed (new)" : "failed (new)";
  return c.status ? CHECK_RESULTS[c.status] : c.passed ? "passed" : "failed";
}

function checksHTML(t: TicketResult): string {
  if (!t.checks || t.checks.length === 0) return "";
  const rows = t.checks.map(c =>
    `<tr class="${c.passed ? "check-pass" : "check-fail"}"><td>${esc(c.name)}</td><td>${esc(checkResult(c))}</td><td>${c.durationSec}s</td></tr>`).join("");
  return `<div class="checks"><strong>Checks</strong><table><tr><th>Check</th><th>Result</th><th>Time</th></tr>${rows}</table></div>`;
}

const LENS_MARK: Record<LensRun["outcome"], (l: LensRun) => string> = {
  reviewed: l => `${lensLabel(l.lens, l.pass)} ✓`,
  skipped: l => `${lensLabel(l.lens, l.pass)} skipped (${l.reason ?? ""})`,
  failed: l => `${lensLabel(l.lens, l.pass)} failed (${l.reason ?? ""})`,
};

function candidateTally(review: TicketReview): string {
  const candidates = review.candidates ?? [];
  if (candidates.length === 0) return "";
  const count = (...verdicts: string[]) => candidates.filter(c => c.verdict && verdicts.includes(c.verdict.verdict)).length;
  const outcome = candidates.some(c => c.verdict)
    ? `${count("confirmed")} confirmed, ${count("unproven")} unproven, ${count("duplicate", "rejected")} dropped`
    : "unconfirmed";
  return ` · ${candidates.length} candidates → ${outcome}`;
}

function stagesHTML(review: TicketReview): string {
  if (!review.lenses || review.lenses.length === 0) return "";
  return `<div class="review review-stages">Review: ${review.lenses.map(l => esc(LENS_MARK[l.outcome](l))).join(" · ")}${candidateTally(review)}</div>`;
}

function droppedHTML(review: TicketReview): string {
  const dropped = (review.candidates ?? []).filter(c => c.verdict?.verdict === "duplicate" || c.verdict?.verdict === "rejected");
  if (dropped.length === 0) return "";
  const items = dropped.map(c => {
    const why = c.verdict!.verdict === "duplicate" ? `duplicate of ${c.verdict!.duplicateOf ?? "?"}` : "rejected";
    return `<li><span class="finding-id">${esc(c.id)}</span> ${esc(why)}: <code class="finding-file">${esc(c.file)}</code> ${esc(c.issue)} <span class="dropped-why">— ${esc(c.verdict!.note)}</span></li>`;
  }).join("");
  return `<details class="dropped"><summary>Dropped candidates (${dropped.length})</summary><ul>${items}</ul></details>`;
}

function rulingsHTML(review: TicketReview): string {
  const rulings = review.decisions ?? [];
  if (rulings.length === 0) return "";
  const items = rulings.map(r => `<li><span class="finding-id">${esc(r.id)}</span> ${esc(r.ruling)}: ${esc(r.decision)} <span class="dropped-why">— ${esc(r.reason)}</span></li>`).join("");
  return `<details class="rulings"><summary>Decision rulings (${rulings.length})</summary><ul>${items}</ul></details>`;
}

function reviewHTML(t: TicketResult): string {
  const review = t.review;
  if (!review) return "";
  if (review.outcome !== "reviewed") {
    return `<div class="review review-${review.outcome}">Review ${review.outcome}: ${esc(review.reason ?? "")}</div>${stagesHTML(review)}`;
  }
  const details = `${droppedHTML(review)}${rulingsHTML(review)}`;
  if (review.findings.length === 0) {
    return `<div class="review"><strong>Review: no issues found</strong></div>${stagesHTML(review)}${details}${risksHTML(t)}`;
  }
  const items = review.findings.map(f => findingHTML(f, review.resolutions.find(r => r.id === f.id), review.verification)).join("");
  const v = review.verification;
  const verifyLine = v && v.outcome !== "verified" ? `<div class="review review-${v.outcome}">Fix verification ${v.outcome}: ${esc(v.reason ?? "")}</div>` : "";
  return `<div class="review"><strong>Review: ${review.findings.length} issue(s) found</strong></div>${stagesHTML(review)}<div class="review"><ul class="findings">${items}</ul></div>${details}${verifyLine}${risksHTML(t)}`;
}

const postmortemProblem = (pm: SessionPostmortem): string | undefined =>
  pm.outcome === "skipped" ? `Postmortem not run: ${pm.reason}` : pm.outcome === "failed" ? `Postmortem failed: ${pm.reason}` : undefined;

function postmortemHTML(pm: SessionPostmortem | undefined): string {
  if (!pm) return "";
  const problem = postmortemProblem(pm);
  const body = problem
    ? `<div class="postmortem-flag">⚠️ ${esc(problem)}</div>`
    : pm.suggestions.length === 0
      ? `<p class="hint">No suggestions.</p>`
      : pm.suggestions.map(s => `<div class="finding suggestion">
           <div class="finding-head">${actionedBoxHTML(postmortemActionKey(s.id), s.id)}<span class="finding-id">${esc(s.id)}</span><code class="finding-file">${esc(s.target)}</code><span class="finding-file">${esc(s.tickets.join(", "))}</span></div>
           <div>${prose(s.problem)}</div>
           <div class="finding-suggestion">Cause: ${prose(s.cause)}</div>
           <div class="finding-suggestion">Change: ${prose(s.change)}</div>
         </div>`).join("");
  const file = pm.file ? `<p class="hint">Suggestions saved to <code>${esc(pm.file)}</code>. Ask Claude to implement the ones you pick by id.</p>` : "";
  const meta = problem ? `<span class="postmortem-flag">⚠️ ${esc(problem)}</span>` : `<span class="section-meta">${pm.suggestions.length} suggestion(s)</span>`;
  return `<details class="postmortem" id="postmortem">
    <summary><span class="chevron">▸</span><h2>Postmortem</h2>${meta}</summary>
    ${body}${file}
  </details>`;
}

const totalInput = (u: RunUsage): number => u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;

function tokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function usageTotals(runs: RunRecord[]): { input: number; output: number; cost: number; unmeasured: number; measured: number } {
  const totals = { input: 0, output: 0, cost: 0, unmeasured: 0, measured: 0 };
  for (const { usage } of runs) {
    if (!usage) { totals.unmeasured++; continue; }
    totals.measured++;
    totals.input += totalInput(usage);
    totals.output += usage.outputTokens;
    totals.cost += usage.costUsd;
  }
  return totals;
}

type UsageTotals = ReturnType<typeof usageTotals>;

const tokenSummary = (totals: UsageTotals): string => `${tokenCount(totals.input)} in / ${tokenCount(totals.output)} out`;
const costLabel = (totals: UsageTotals): string => `$${totals.cost.toFixed(2)}`;
const unmeasuredNote = (totals: UsageTotals): string =>
  totals.unmeasured > 0 ? ` · ${totals.unmeasured} run${totals.unmeasured === 1 ? "" : "s"} unmeasured` : "";

function stageShares(runs: RunRecord[], cost: number): string {
  if (cost <= 0) return "";
  const byStage = new Map<string, number>();
  for (const { stage, usage } of runs) if (usage) byStage.set(stage, (byStage.get(stage) ?? 0) + usage.costUsd);
  return [...byStage].map(([stage, c]) => ` · ${esc(stage)} ${Math.round((c / cost) * 100)}%`).join("");
}

function usageHTML(t: TicketResult): string {
  if (!t.runs || t.runs.length === 0) return "";
  const totals = usageTotals(t.runs);
  return `<div class="usage">Usage: ${tokenSummary(totals)} · ${costLabel(totals)} API-equivalent${unmeasuredNote(totals)}${stageShares(t.runs, totals.cost)}</div>`;
}

function nightUsageStat(tickets: TicketResult[], postmortem?: SessionPostmortem): string {
  const runs = [...tickets.flatMap(t => t.runs ?? []), ...(postmortem?.usage ? [{ stage: "postmortem", usage: postmortem.usage }] : [])];
  if (runs.length === 0) return "";
  const totals = usageTotals(runs);
  return `<div class="stat night-usage"><strong>${costLabel(totals)}</strong>API-equivalent · ${tokenSummary(totals)}${unmeasuredNote(totals)}</div>`;
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
    ? `<div class="notes"><strong>Notes:</strong> ${prose(t.notes)}</div>`
    : "";

  const followups = t.followups.length > 0
    ? `<div class="followups"><strong>Spotted, not fixed:</strong><ul>${
        t.followups.map(f => `<li><code>${esc(f.file)}</code> ${prose(f.note)}</li>`).join("")
      }</ul></div>`
    : "";

  return `
  <details class="card" id="ticket-${esc(t.ticket.id)}">
    <summary class="card-header">
      <span class="chevron">▸</span>
      ${actionedBoxHTML(ticketActionKey(t.ticket.id), t.ticket.id)}
      <span class="status" style="background:${color}">${t.status.toUpperCase()}</span>
      <span class="ticket-id">${esc(t.ticket.id)}</span>
      <span class="ticket-name">${esc(t.ticket.name)}</span>
      ${prLinksHTML(t)}
      <span class="ticket-duration">${t.durationSec}s</span>
    </summary>
    <div class="card-body">
      <p class="summary">${prose(t.summary)}</p>
      ${t.linear ? `<a href="${esc(t.linear.url)}" target="_blank" class="linear-link">Open in Linear →</a>` : ""}
      ${files ? `<ul class="files">${files}</ul>` : ""}
      ${tests}
      ${verify}
      ${usageHTML(t)}
      ${checksHTML(t)}
      ${reviewHTML(t)}
      ${followups}
      ${notes}
      <div class="meta">
        <span>Branch: <code>${esc(t.branch)}</code></span>
        ${t.ticket.base ? `<span>Stacked on <code>${esc(t.ticket.base)}</code></span>` : ""}
        <span>Worktree: <code>${esc(t.worktreePath)}</code></span>
      </div>
    </div>
  </details>`;
}

export const ACTIONED_SCRIPT = `(() => {
  const match = location.pathname.match(/\\/reports\\/((?:[^/]+\\/)?[^/]+)\\.html$/);
  const reportId = match ? decodeURIComponent(match[1]) : null;
  const overHttp = location.protocol === "http:" || location.protocol === "https:";
  const apiUrl = (overHttp ? "" : "${DASHBOARD_ORIGIN}") + "/api/actions?report=" + encodeURIComponent(reportId || "");
  const put = async entries => fetch(apiUrl, { method: "PUT", headers: { "Content-Type": "application/json", "X-Nightshift": "1" }, body: JSON.stringify(entries) });
  const get = async () => (await fetch(apiUrl)).json();
  const storeKey = "nightshift:actioned:" + location.pathname;
  const readLocal = () => { try { return JSON.parse(localStorage.getItem(storeKey) || "{}"); } catch { return {}; } };
  const writeLocal = state => { try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch {} };
  const boxes = [...document.querySelectorAll("input.actioned")];
  const refresh = () => {
    for (const box of boxes) box.closest(".card, .suggestion")?.classList.toggle("is-actioned", box.checked);
    const count = document.getElementById("actioned-count");
    if (count) count.textContent = boxes.filter(box => box.checked).length + " / " + boxes.length;
  };
  const apply = ticked => { for (const box of boxes) box.checked = Boolean(ticked[box.dataset.key]); refresh(); };
  if (overHttp && reportId) {
    get().then(map => apply(Object.fromEntries(Object.entries(map).filter(([, v]) => v && v.at).map(([k, v]) => [k, v.at])))).catch(() => {});
  } else {
    const saved = readLocal();
    apply(saved);
    const entries = Object.fromEntries(Object.entries(saved).map(([k, at]) => [k, { at, updatedAt: at }]));
    if (reportId && Object.keys(entries).length > 0) put(entries).catch(() => {});
  }
  for (const box of boxes) box.addEventListener("change", () => {
    const now = new Date().toISOString();
    if (overHttp && reportId) put({ [box.dataset.key]: { at: box.checked ? now : null, updatedAt: now } }).catch(() => {});
    else { const state = readLocal(); if (box.checked) state[box.dataset.key] = now; else delete state[box.dataset.key]; writeLocal(state); }
    refresh();
  });
  const openTarget = hash => {
    const target = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
    if (target instanceof HTMLDetailsElement) target.open = true;
  };
  document.addEventListener("click", event => {
    const link = event.target.closest?.('a[href^="#"]');
    if (link) openTarget(link.getAttribute("href"));
    const toggle = event.target.closest?.("[data-expand]");
    if (toggle) for (const d of document.querySelectorAll("details")) d.open = toggle.dataset.expand === "open";
  });
  openTarget(location.hash);
})();`;

export function generateHTML(session: SessionResult): string {
  const counts = countTickets(session.tickets);
  const b = session.budget;
  const used = budgetUsedPct(b);
  const pctColor = b.currentPct >= b.capPct ? "#ef4444" : b.currentPct >= b.capPct - 3 ? "#eab308" : "#22c55e";
  const fillWidth = Math.min(b.currentPct, 100);
  const startWidth = Math.min(Math.max(0, b.startPct), 100);
  const capLeft = Math.min(b.capPct, 100);

  const pmProblem = session.postmortem && postmortemProblem(session.postmortem);
  const pmStat = !session.postmortem ? "" : pmProblem
    ? `<div class="stat postmortem-flag"><a href="#postmortem" style="color:inherit"><strong>⚠️</strong>${esc(pmProblem)}</a></div>`
    : `<div class="stat"><a href="#postmortem" style="color:inherit"><strong>${session.postmortem.suggestions.length}</strong>postmortem suggestions</a></div>`;
  const suggestionCount = session.postmortem?.outcome === "done" ? session.postmortem.suggestions.length : 0;
  const actionableCount = session.tickets.length + suggestionCount;
  const actionedStat = actionableCount === 0 ? "" : `<div class="stat"><strong id="actioned-count">0 / ${actionableCount}</strong>actioned</div>`;
  const toolbar = actionableCount === 0 ? "" : `<div class="toolbar">
    <button type="button" data-expand="open">Expand all</button>
    <button type="button" data-expand="closed">Collapse all</button>
  </div>`;
  const gateBanner = session.gateHit ? `<div class="gate-hit">⛔ ${esc(session.skipReason)}</div>` : "";
  const ticketErrorBanner = session.ticketError
    ? `<div class="gate-hit">⛔ Tickets could not be loaded: ${esc(session.ticketError)}</div>`
    : "";
  const effectiveAllocation = b.capPct - b.startPct;
  const allocationLabel = effectiveAllocation < b.allocationPct
    ? `${b.allocationPct}% requested, ${effectiveAllocation}% available`
    : `${b.allocationPct}%`;
  const budgetBar = b.unavailable
    ? `
    <div class="budget">
      ${gateBanner}
    </div>`
    : `
    <div class="budget">
      <div class="budget-label">Tonight's allocation: <strong>${allocationLabel}</strong> of weekly
        ${b.resetInfo ? `<span class="budget-reset">resets ${esc(b.resetInfo)}</span>` : ""}
      </div>
      <div class="budget-track">
        <div class="budget-fill" style="width:${fillWidth}%;background:${pctColor}"></div>
        <div class="budget-start" style="left:${startWidth}%"></div>
        <div class="budget-marker" style="left:${capLeft}%"></div>
      </div>
      <div class="budget-figures">
        <span>Started at <strong>${Math.max(0, b.startPct)}%</strong></span>
        <span>Ended at <strong>${b.currentPct}%</strong> (used ${used}% of ${effectiveAllocation < b.allocationPct ? effectiveAllocation : b.allocationPct}%)</span>
        <span>Cap <strong>${b.capPct}%</strong></span>
      </div>
      ${gateBanner}
    </div>`;

  const ticketsHTML = session.noTasks
    ? `<div class="no-tasks">
         <div class="no-tasks-icon">🌙</div>
         <p>No tickets in <code>tonight.md</code>. Nothing to process.</p>
         <p class="hint">Add tickets to <code>projects/&lt;project&gt;/tonight.md</code> before tonight's 23:00 run.</p>
       </div>`
    : session.tickets.map(ticketCardHTML).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nightshift Report – ${esc(session.date)}</title>
<style>${THEME_CSS}
  body { padding: 2rem; max-width: 860px; margin: 0 auto; }
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
          margin-bottom: 0.6rem; overflow: hidden; transition: opacity 0.15s; }
  .card-header { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem; cursor: pointer; list-style: none; }
  .card[open] > .card-header { border-bottom: 1px solid var(--border); }
  summary::-webkit-details-marker { display: none; }
  summary:hover .chevron { color: var(--text); }
  .chevron { color: var(--text-dim); font-size: 0.8rem; transition: transform 0.15s; display: inline-block; width: 0.8rem; }
  details[open] > summary .chevron { transform: rotate(90deg); }
  input.actioned { width: 1.05rem; height: 1.05rem; accent-color: #22c55e; cursor: pointer; flex: none; }
  .is-actioned { opacity: 0.5; }
  .card.is-actioned .ticket-name, .suggestion.is-actioned .finding-id { text-decoration: line-through; }
  .toolbar { display: flex; justify-content: flex-end; gap: 0.5rem; margin-bottom: 0.6rem; }
  .toolbar button { background: var(--surface); color: var(--text-dim); border: 1px solid var(--border); border-radius: 6px;
                    padding: 0.25rem 0.7rem; font: inherit; font-size: 0.8rem; cursor: pointer; }
  .toolbar button:hover { color: var(--text); }
  .status { color: #fff; font-size: 0.7rem; font-weight: 700; padding: 0.2rem 0.6rem;
            border-radius: 4px; letter-spacing: 0.5px; }
  .ticket-id { font-weight: 700; font-family: ui-monospace, monospace; }
  .ticket-name { flex: 1; color: var(--text-dim); }
  .ticket-duration { color: var(--text-dim); font-size: 0.8rem; }
  .card-body { padding: 1rem; }
  .summary { margin-bottom: 0.75rem; }
  .linear-link { color: var(--accent); text-decoration: none; font-size: 0.85rem; display: inline-block; margin-bottom: 0.75rem; }
  .linear-link:hover { text-decoration: underline; }
  .pr-row { display: inline-flex; align-items: center; gap: 0.5rem; }
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
  .review { font-size: 0.9rem; margin-bottom: 0.75rem; }
  .review-skipped, .review-failed { color: var(--text-dim); }
  .finding-from, .data-risk { color: var(--text-dim); font-size: 0.8rem; margin-left: 0.4rem; }
  .data-risk { color: #f97316; font-weight: 600; }
  details.dropped, details.rulings { font-size: 0.85rem; color: var(--text-dim); margin: 0.5rem 0; }
  details.dropped ul, details.rulings ul { padding-left: 1.2rem; margin: 0.3rem 0; }
  .dropped-why { color: var(--text-dim); }
  .usage { color: var(--text-dim); font-size: 0.9rem; margin-bottom: 0.75rem; }
  .checks { font-size: 0.9rem; margin-bottom: 0.75rem; }
  .checks table { border-collapse: collapse; margin-top: 0.3rem; }
  .checks th, .checks td { text-align: left; padding: 0.15rem 0.9rem 0.15rem 0; font-size: 0.85rem; }
  .checks th { color: var(--text-dim); font-weight: 600; }
  .check-pass td:nth-child(2) { color: #22c55e; }
  .check-fail td:nth-child(2) { color: #ef4444; }
  .risks { margin: 0.3rem 0 0 1.2rem; }
  .findings { list-style: none; margin-top: 0.4rem; }
  .finding { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.75rem; margin-bottom: 0.5rem; }
  .finding-head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.2rem; }
  .finding-id { font-weight: 700; font-family: ui-monospace, monospace; }
  .finding-file { color: var(--text-dim); font-size: 0.8rem; }
  .finding-suggestion { color: var(--text-dim); }
  .sev { color: #fff; font-size: 0.65rem; font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 4px; letter-spacing: 0.5px; text-transform: uppercase; }
  .sev-blocker { background: #ef4444; }
  .sev-major { background: #f97316; }
  .sev-minor { background: #6b7280; }
  .res { margin-top: 0.3rem; }
  .res-fixed { color: #22c55e; }
  .res-not_fixed { color: #ef4444; }
  .postmortem { margin-top: 2rem; }
  .postmortem > summary { display: flex; align-items: center; gap: 0.75rem; cursor: pointer; list-style: none; margin-bottom: 0.5rem; }
  .postmortem h2 { font-size: 1.1rem; }
  .postmortem > summary .postmortem-flag { margin-bottom: 0; }
  .section-meta { color: var(--text-dim); font-size: 0.85rem; }
  .postmortem-flag { color: #ef4444; font-weight: 600; margin-bottom: 0.5rem; }
  .followups { color: var(--text-dim); font-size: 0.9rem; margin-bottom: 0.75rem; }
  .followups ul { padding-left: 1.25rem; }
  .notes { color: var(--text-dim); font-size: 0.9rem; margin-bottom: 0.75rem; }
  .meta { display: flex; gap: 1.5rem; font-size: 0.8rem; color: var(--text-dim);
          border-top: 1px solid var(--border); padding-top: 0.75rem; margin-top: 0.5rem; }
  code.inline { background: var(--bg); padding: 0.1rem 0.3rem; border-radius: 3px; }
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
    <div class="stat"><strong>${counts.total}</strong>tickets</div>
    <div class="stat"><strong style="color:#22c55e">${counts.done}</strong>done</div>
    <div class="stat"><strong style="color:#eab308">${counts.partial}</strong>partial</div>
    <div class="stat"><strong style="color:#f97316">${counts.needsReview}</strong>review</div>
    <div class="stat"><strong style="color:#6b7280">${counts.skipped}</strong>skipped</div>
    ${nightUsageStat(session.tickets, session.postmortem)}
    ${pmStat}
    ${actionedStat}
  </div>

  ${ticketErrorBanner}
  ${budgetBar}

  ${toolbar}
  ${ticketsHTML}

  ${postmortemHTML(session.postmortem)}

  <div class="footer">Generated by nightshift · ${new Date().toISOString()}</div>
<script>${ACTIONED_SCRIPT}</script>
</body>
</html>`;
}

export function reportFilename(date: string, exists: (name: string) => boolean): string {
  const base = `nightshift-${date}`;
  if (!exists(`${base}.html`)) return `${base}.html`;
  for (let n = 2; ; n++) {
    if (!exists(`${base}-${n}.html`)) return `${base}-${n}.html`;
  }
}

export function reportBase(date: string, exists: (name: string) => boolean): string {
  return reportFilename(date, exists).replace(/\.html$/, "");
}

export function writeReport(session: SessionResult, dir: string, base: string): string {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${base}.html`);
  writeFileSync(filePath, generateHTML(session), "utf-8");
  return filePath;
}
