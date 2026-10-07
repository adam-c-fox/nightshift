import { esc, STATUS_COLORS } from "../../report.js";
import {
  PREP_STATE_LABELS,
  type PrepRecord,
  type PrepState,
  type PrepStateName,
} from "../../prep.js";
import type { ClockOffRow, ClockOffView, PrLookup } from "../clock-off.js";
import {
  errorBox,
  fragmentSlot,
  launchButton,
  page,
  refreshButton,
} from "./layout.js";

export const PREP_COLORS: Record<PrepStateName, string> = {
  fresh: "#22c55e",
  stale: "#eab308",
  new_comments: "#f97316",
  not_ready: "#ef4444",
  inferred: "#6c5ce7",
  none: "#6b7280",
};

const EMPTY = "—";
const RUNS_POLL_SECONDS = 30;

export function badge(text: string, color: string, title?: string): string {
  const titleAttr = title ? ` title="${esc(title)}"` : "";
  return `<span class="badge" style="background:${color}"${titleAttr}>${esc(text)}</span>`;
}

function prepTitle(prep: PrepState): string {
  const parts = [];
  if (prep.preppedAt) parts.push(`prepped ${prep.preppedAt.slice(0, 10)}`);
  if (prep.blockers) parts.push(`blockers: ${prep.blockers}`);
  return parts.join("; ");
}

function recordedLabel(record: PrepRecord): string {
  return `recorded: ${record.outcome === "ready" ? "ready" : "not ready"}`;
}

function prepCell(row: ClockOffRow): string {
  if (row.prep) {
    return badge(
      PREP_STATE_LABELS[row.prep.state],
      PREP_COLORS[row.prep.state],
      prepTitle(row.prep),
    );
  }
  return row.prepRecord
    ? `<span class="dim">${esc(recordedLabel(row.prepRecord))}</span>`
    : "?";
}

function prCell(pr: PrLookup): string {
  if (pr === "unknown") return `<span title="PR status unknown">?</span>`;
  if (!pr) return EMPTY;
  const link = `<a href="${esc(pr.url)}" target="_blank" rel="noopener">#${pr.prId}</a>`;
  return pr.autoComplete
    ? `${link} ${badge("auto-complete", STATUS_COLORS.error)}`
    : link;
}

function idCell(row: ClockOffRow): string {
  return row.url
    ? `<a href="${esc(row.url)}" target="_blank" rel="noopener">${esc(row.id)}</a>`
    : esc(row.id);
}

function titleCell(row: ClockOffRow): string {
  const state =
    !row.inTodo && row.linearState
      ? ` <span class="state">(${esc(row.linearState)})</span>`
      : "";
  return `${esc(row.title)}${state}`;
}

function rowHTML(row: ClockOffRow, project: string): string {
  const cell = (label: string, content: string, cls = "") =>
    `<td data-label="${label}"${cls ? ` class="${cls}"` : ""}>${content}</td>`;
  return `<tr${row.inTodo ? "" : ' class="not-todo"'}>
${cell("ID", idCell(row))}
${cell("Title", titleCell(row))}
${cell("Priority", esc(row.priority))}
${cell("Est.", row.estimate === null ? EMPTY : String(row.estimate))}
${cell("Prep", prepCell(row))}
${cell("Tonight", row.tonightPosition === null ? EMPTY : `#${row.tonightPosition}`)}
${cell("PR", prCell(row.pr))}
${cell("Action", launchButton({ kind: "prep", id: row.id, project }, "Prep"), "action")}
</tr>`;
}

function tableHTML(view: ClockOffView): string {
  const headers = [
    "ID",
    "Title",
    "Priority",
    "Est.",
    "Prep",
    "Tonight",
    "PR",
    "",
  ];
  return `<table class="tickets">
<thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
<tbody>
${view.rows.map((row) => rowHTML(row, view.project)).join("\n")}
</tbody>
</table>`;
}

function usageHTML(usage: ClockOffView["usage"]): string {
  return usage.ok
    ? `<span>Weekly: <strong>${Math.round(usage.value.weeklyPercent)}%</strong> used · resets ${esc(usage.value.resetInfo)}</span>`
    : `<span class="dim">Usage unavailable: ${esc(usage.error)}</span>`;
}

function barHTML(view: ClockOffView): string {
  const teams = view.teams
    ? `<span class="dim">Teams: ${esc(view.teams.join(", "))}</span>`
    : "";
  return `<div class="bar">
<span>Tonight's allowance: <strong>${view.allowance.percent}%</strong> (${esc(view.allowance.source)})</span>
${usageHTML(view.usage)}
${teams}
<span class="spacer"></span>
<span class="actions">${launchButton({ kind: "tonight", project: view.project }, "Plan tonight")}${refreshButton("all", "Refresh")}</span>
</div>`;
}

function bannersHTML(view: ClockOffView): string {
  const banner = (text: string) => `<div class="banner">${esc(text)}</div>`;
  return [
    view.linearError &&
      banner(
        `Linear unavailable: ${view.linearError}. Showing tonight.md only.`,
      ),
    view.tonightError &&
      banner(`tonight.md has a problem: ${view.tonightError}`),
    view.prError && banner(`PR status unavailable: ${view.prError}`),
  ]
    .filter(Boolean)
    .join("\n");
}

function warningsHTML(view: ClockOffView): string {
  if (view.warnings.length === 0) return "";
  const items = view.warnings.map(
    (w) => `<li data-code="${esc(w.code)}">⚠️ ${esc(w.message)}</li>`,
  );
  return `<ul class="warnings">\n${items.join("\n")}\n</ul>`;
}

function emptyHTML(view: ClockOffView): string {
  const where = view.teams?.length ? ` in ${esc(view.teams.join(", "))}` : "";
  return `<p class="dim">No Todo tickets assigned to you${where}</p>`;
}

export function clockOffHTML(view: ClockOffView): string {
  const body =
    view.rows.length > 0
      ? tableHTML(view)
      : view.linearError
        ? ""
        : emptyHTML(view);
  return [barHTML(view), bannersHTML(view), warningsHTML(view), body]
    .filter(Boolean)
    .join("\n");
}

export function clockOffErrorHTML(project: string, error: string): string {
  const link = `<a href="/projects/${esc(encodeURIComponent(project))}">Open project</a>`;
  return `${errorBox(`Project "${project}" can't be loaded: ${error}`)}<p>${link}</p>`;
}

function projectSelect(projects: string[], selected: string): string {
  const options = projects.map(
    (p) =>
      `<option value="${esc(p)}"${p === selected ? " selected" : ""}>${esc(p)}</option>`,
  );
  return `<div class="project-picker"><label for="project">Project</label><select id="project">${options.join("")}</select></div>`;
}

export function homeHTML(opts: {
  projects: string[];
  selected: string | undefined;
}): string {
  if (opts.projects.length === 0) {
    return page({
      title: "Nightshift",
      nav: "tonight",
      body: `<p>No projects yet. <a href="/projects/new">Create one</a>.</p>`,
    });
  }
  const selected =
    opts.selected && opts.projects.includes(opts.selected)
      ? opts.selected
      : opts.projects[0];
  const clockOffUrl = `/fragments/clock-off?project=${encodeURIComponent(selected)}`;
  const body = [
    projectSelect(opts.projects, selected),
    fragmentSlot("/fragments/runs", "run status", { poll: RUNS_POLL_SECONDS }),
    "<h2>Before clocking off</h2>",
    fragmentSlot(clockOffUrl, "tickets"),
    "<h2>Outstanding</h2>",
    fragmentSlot("/fragments/inbox", "inbox"),
    "<h2>Nights</h2>",
    fragmentSlot("/fragments/nights", "nights"),
  ].join("\n");
  return page({ title: "Nightshift", nav: "tonight", body });
}
