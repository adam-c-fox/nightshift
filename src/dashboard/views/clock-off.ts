import { esc, STATUS_COLORS } from "../../report.js";
import { CODEX_ALLOWANCE_PCT } from "../../codex.js";
import type { UsageSummary } from "../../budget.js";
import {
  PREP_STATE_LABELS,
  type PrepRecord,
  type PrepState,
  type PrepStateName,
} from "../../prep.js";
import type {
  ClockOffRow,
  EveningView,
  PrLookup,
  QueueRow,
} from "../clock-off.js";
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
const TAG_COLORS = ["#2f7d6d", "#7a5cc4", "#c07a00", "#3b82f6", "#db2777"];
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

const cell = (label: string, content: string, cls = "") =>
  `<td data-label="${label}"${cls ? ` class="${cls}"` : ""}>${content}</td>`;

function addCell(row: ClockOffRow, project: string): string {
  if (row.tonightPosition !== null) return `in queue #${row.tonightPosition}`;
  return `<button type="button" class="btn" data-queue-op="add" data-id="${esc(row.id)}" data-project="${esc(project)}">+ add</button>`;
}

function tabRowHTML(row: ClockOffRow, project: string): string {
  return `<tr${row.inTodo ? "" : ' class="not-todo"'}>
${cell("ID", idCell(row), "id")}
${cell("Title", titleCell(row))}
${cell("Priority", esc(row.priority))}
${cell("Est.", row.estimate === null ? EMPTY : String(row.estimate))}
${cell("Prep", prepCell(row))}
${cell("Tonight", addCell(row, project))}
${cell("PR", prCell(row.pr))}
${cell("Action", launchButton({ kind: "prep", id: row.id, project }, "Prep"), "action")}
</tr>`;
}

function tabTableHTML(project: string, rows: ClockOffRow[]): string {
  const headers = ["ID", "Title", "Priority", "Est.", "Prep", "Tonight", "PR", ""];
  return `<table class="tickets">
<thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
<tbody>
${rows.map((row) => tabRowHTML(row, project)).join("\n")}
</tbody>
</table>`;
}

type Tag = (project: string) => string;

function tagFor(view: EveningView): Tag {
  const order = view.tabs.map((t) => t.project);
  return (project) =>
    badge(project, TAG_COLORS[Math.max(0, order.indexOf(project)) % TAG_COLORS.length]);
}

function queueButton(op: string, id: string, label: string, text: string, disabled = false): string {
  return `<button type="button" class="btn" data-queue-op="${op}" data-id="${esc(id)}" aria-label="${esc(label)}"${disabled ? " disabled" : ""}>${text}</button>`;
}

function repoSelect(row: QueueRow): string {
  const options = row.repos.map(
    (repo) =>
      `<option value="${esc(repo)}"${repo === row.repo ? " selected" : ""}>${esc(repo)}</option>`,
  );
  return `<select data-queue-repo data-id="${esc(row.id)}" aria-label="Repo for ${esc(row.id)}">${options.join("")}</select>`;
}

function queueRowHTML(row: QueueRow, last: boolean, tag: Tag): string {
  const actions = [
    queueButton("up", row.id, `Move ${row.id} up`, "↑", row.position === 1),
    queueButton("down", row.id, `Move ${row.id} down`, "↓", last),
    queueButton("remove", row.id, `Remove ${row.id}`, "Remove"),
  ].join(" ");
  return `<tr draggable="true" data-queue-id="${esc(row.id)}"${row.inTodo ? "" : ' class="not-todo"'}>
<td class="grip" aria-hidden="true">⠿</td>
${cell("#", String(row.position))}
${cell("Project", tag(row.project))}
${cell("ID", idCell(row), "id")}
${cell("Title", titleCell(row))}
${cell("Prep", prepCell(row))}
${cell("Repo", repoSelect(row))}
${cell("Action", actions, "action")}
</tr>`;
}

function sweepRowHTML(view: EveningView, tag: Tag): string {
  const parts = view.sweep.map(({ project, openPrs }) => {
    const count = openPrs.ok
      ? `${openPrs.value} open PR${openPrs.value === 1 ? "" : "s"}`
      : "PRs unknown";
    return `${tag(project)} ${esc(count)}`;
  });
  return `<tr class="sweep"><td></td><td>–</td><td colspan="6">PR comment sweep · ${parts.join(" · ")}</td></tr>`;
}

function queueTableHTML(view: EveningView): string {
  const tag = tagFor(view);
  const headers = ["", "#", "Project", "ID", "Title", "Prep", "Repo", ""];
  const rows = view.queue.map((row, i) =>
    queueRowHTML(row, i === view.queue.length - 1, tag),
  );
  const empty =
    view.queue.length === 0
      ? `<p class="dim">Nothing queued. Add tickets from the tabs below, or Plan tonight.</p>`
      : "";
  return `<table class="tickets queue">
<thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
<tbody>
${[sweepRowHTML(view, tag), ...rows].join("\n")}
</tbody>
</table>
${empty}`;
}

function codexUsageHTML({ codex, codexError }: { codex?: UsageSummary; codexError?: string }): string {
  if (codex) return `\n<span>Codex weekly: <strong>${Math.round(codex.weeklyPercent)}%</strong> used · resets ${esc(codex.resetInfo)} · ${CODEX_ALLOWANCE_PCT}% a night</span>`;
  return codexError === undefined ? "" : `\n<span class="dim">Codex usage unavailable: ${esc(codexError)}</span>`;
}

function usageHTML(usage: EveningView["usage"]): string {
  return usage.ok
    ? `<span>Weekly: <strong>${Math.round(usage.value.weeklyPercent)}%</strong> used · resets ${esc(usage.value.resetInfo)}</span>${codexUsageHTML(usage.value)}`
    : `<span class="dim">Usage unavailable: ${esc(usage.error)}</span>`;
}

function barHTML(view: EveningView): string {
  const queued = `${view.queue.length} ticket${view.queue.length === 1 ? "" : "s"} · ${view.sweep.length} project${view.sweep.length === 1 ? "" : "s"} swept`;
  return `<div class="bar">
<span>Tonight's allowance: <strong>${view.allowance.percent}%</strong> (${esc(view.allowance.source)})</span>
${usageHTML(view.usage)}
<span>Queued: <strong>${esc(queued)}</strong></span>
<span class="spacer"></span>
<span class="actions">${launchButton({ kind: "tonight" }, "Plan tonight")}${refreshButton("all", "Refresh")}</span>
</div>`;
}

function bannersHTML(view: EveningView): string {
  const banner = (text: string) => `<div class="banner">${esc(text)}</div>`;
  return [
    view.linearError &&
      banner(`Linear unavailable: ${view.linearError}. Showing the queue only.`),
    view.queueError &&
      banner(`tonight.md has a problem: ${view.queueError}`),
    view.prError && banner(`PR status unavailable: ${view.prError}`),
  ]
    .filter(Boolean)
    .join("\n");
}

function warningsHTML(view: EveningView): string {
  if (view.warnings.length === 0) return "";
  const items = view.warnings.map(
    (w) => `<li data-code="${esc(w.code)}">⚠️ ${esc(w.message)}</li>`,
  );
  return `<ul class="warnings">\n${items.join("\n")}\n</ul>`;
}

function tabsHTML(view: EveningView, selected: string): string {
  if (view.tabs.length === 0) return "";
  const links = view.tabs.map(({ project, rows }) => {
    const current = project === selected ? ' aria-current="page"' : "";
    return `<a href="?tab=${esc(encodeURIComponent(project))}"${current}>${esc(project)} (${rows.length} Todo)</a>`;
  });
  const rows = view.tabs.find((t) => t.project === selected)?.rows ?? [];
  const body =
    rows.length > 0
      ? tabTableHTML(selected, rows)
      : view.linearError
        ? ""
        : `<p class="dim">No Todo tickets assigned to you in ${esc(selected)}</p>`;
  return `<nav class="tabs" aria-label="Projects">${links.join("")}</nav>\n${body}`;
}

export function eveningHTML(view: EveningView, tab?: string): string {
  const selected = view.tabs.some((t) => t.project === tab)
    ? (tab as string)
    : (view.tabs[0]?.project ?? "");
  return [
    barHTML(view),
    bannersHTML(view),
    warningsHTML(view),
    "<h3>Tonight's queue</h3>",
    queueTableHTML(view),
    tabsHTML(view, selected),
  ]
    .filter(Boolean)
    .join("\n");
}

export function eveningErrorHTML(error: string): string {
  return `${errorBox(`Tonight can't be loaded: ${error}`)}<p><a href="/projects">Open projects</a></p>`;
}

export function homeHTML(opts: { projects: string[]; tab?: string }): string {
  if (opts.projects.length === 0) {
    return page({
      title: "Nightshift",
      nav: "tonight",
      body: `<p>No projects yet. Run /nightshift-setup to create one.</p>`,
    });
  }
  const query = opts.tab ? `?tab=${encodeURIComponent(opts.tab)}` : "";
  const body = [
    fragmentSlot("/fragments/runs", "run status", { poll: RUNS_POLL_SECONDS }),
    "<h2>Before clocking off</h2>",
    fragmentSlot(`/fragments/evening${query}`, "tickets"),
    "<h2>Outstanding</h2>",
    fragmentSlot("/fragments/inbox", "inbox"),
    "<h2>Nights</h2>",
    fragmentSlot("/fragments/nights", "nights"),
  ].join("\n");
  return page({ title: "Nightshift", nav: "tonight", body });
}
