import type { UsageSummary } from "../budget.js";
import { TODO_STATE, type IssueSnapshot, type TodoIssue } from "../linear.js";
import {
  prepState,
  type PrepRecord,
  type PrepState,
  type PrepStore,
} from "../prep.js";
import { projectForLinearProject, type Project } from "../project.js";
import type { Ticket } from "../types.js";
import type { Loaded } from "./cache.js";

export interface TicketPr {
  prId: number;
  url: string;
  autoComplete: boolean;
}

export type PrLookup = TicketPr | null | "unknown";

export interface EveningInput {
  projects: Pick<Project, "name" | "linearProjects" | "repos" | "defaultRepo">[];
  todo: Loaded<TodoIssue[]>;
  queue: Loaded<{ tickets: Ticket[]; allowance?: number }>;
  rootAllowance: number;
  snapshots: Loaded<Record<string, IssueSnapshot | null>>;
  prep: PrepStore;
  prs: Loaded<Record<string, PrLookup>>;
  openPrs: Record<string, Loaded<number>>;
  usage: Loaded<UsageSummary>;
  now: Date;
}

export interface ClockOffRow {
  id: string;
  title: string;
  url?: string;
  team?: string;
  priority: string;
  priorityRank: number;
  estimate: number | null;
  inTodo: boolean;
  linearState?: string;
  prep: PrepState | null;
  prepRecord?: PrepRecord;
  tonightPosition: number | null;
  repo?: string;
  pr: PrLookup;
}

export type WarningCode =
  | "unprepped"
  | "stale"
  | "not_ready"
  | "not_todo"
  | "not_assigned"
  | "not_found"
  | "auto_complete"
  | "reset_soon"
  | "unmapped";

export interface ClockOffWarning {
  code: WarningCode;
  ticketId?: string;
  message: string;
}

export type QueueRow = ClockOffRow & {
  project: string;
  repo: string;
  repos: string[];
  position: number;
};

export interface EveningView {
  allowance: { percent: number; source: "tonight.md" | "nightly default" };
  usage: Loaded<{
    weeklyPercent: number;
    resetInfo: string;
    resetAt?: string;
    resetSoon: boolean;
    codex?: UsageSummary;
    codexError?: string;
  }>;
  queue: QueueRow[];
  sweep: { project: string; openPrs: Loaded<number> }[];
  tabs: { project: string; rows: ClockOffRow[] }[];
  warnings: ClockOffWarning[];
  linearError?: string;
  queueError?: string;
  prError?: string;
}

export const RESET_SOON_MS = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const NO_PRIORITY = 0;
const NO_PRIORITY_LABEL = "No priority";

export function priorityRank(priority: number): number {
  return priority === NO_PRIORITY ? 5 : priority;
}

function warn(
  code: WarningCode,
  message: string,
  ticketId?: string,
): ClockOffWarning {
  return { code, message, ...(ticketId ? { ticketId } : {}) };
}

function linearStateWarning(
  id: string,
  snapshot: IssueSnapshot | null | undefined,
): ClockOffWarning | undefined {
  if (!snapshot)
    return warn(
      "not_found",
      `${id} is in tonight.md but wasn't found in Linear`,
      id,
    );
  if (snapshot.state !== TODO_STATE)
    return warn(
      "not_todo",
      `${id} is in tonight.md but is ${snapshot.state} in Linear`,
      id,
    );
  if (!snapshot.assignedToMe)
    return warn(
      "not_assigned",
      `${id} is in tonight.md but isn't assigned to you`,
      id,
    );
  return undefined;
}

function prepWarning(
  id: string,
  state: PrepState | null,
): ClockOffWarning | undefined {
  switch (state?.state) {
    case "none":
      return warn(
        "unprepped",
        `${id} is in tonight.md but hasn't been prepped`,
        id,
      );
    case "stale":
      return warn("stale", `${id}'s description changed after /prep`, id);
    case "not_ready":
      return warn(
        "not_ready",
        state.blockers
          ? `${id} was marked not ready: ${state.blockers}`
          : `${id} was marked not ready`,
        id,
      );
    default:
      return undefined;
  }
}

function usageView(
  usage: EveningInput["usage"],
  now: Date,
): { view: EveningView["usage"]; warning?: ClockOffWarning } {
  if (!usage.ok) return { view: usage };
  const { weeklyPercent, resetInfo, resetAtIso, codex, codexError } = usage.value;
  const untilReset =
    resetAtIso === undefined ? NaN : Date.parse(resetAtIso) - now.getTime();
  const resetSoon = untilReset > 0 && untilReset <= RESET_SOON_MS;
  const view = {
    ok: true as const,
    value: {
      weeklyPercent,
      resetInfo,
      ...(resetAtIso !== undefined ? { resetAt: resetAtIso } : {}),
      resetSoon,
      ...(codex ? { codex } : {}),
      ...(codexError !== undefined ? { codexError } : {}),
    },
  };
  if (!resetSoon) return { view };
  const hours = Math.max(1, Math.round(untilReset / MS_PER_HOUR));
  return {
    view,
    warning: warn(
      "reset_soon",
      `Weekly usage resets in ${hours}h; consider allowance: 100`,
    ),
  };
}

function unmappedWarning(issue: TodoIssue): ClockOffWarning {
  return warn(
    "unmapped",
    `${issue.identifier} isn't in a Linear project any nightshift project claims (${issue.projectName ?? "no project"})`,
    issue.identifier,
  );
}

export function buildEvening(input: EveningInput): EveningView {
  const { projects, todo, queue, snapshots, prep, prs, openPrs, usage, now } =
    input;
  const queueTickets = queue.ok ? queue.value.tickets : [];
  const todoIssues = todo.ok ? todo.value : [];
  const queueById = new Map(
    queueTickets.map((t, i) => [t.id, { ticket: t, position: i + 1 }]),
  );

  const linearWarnings = new Map<string, ClockOffWarning>();

  const lookupPr = (id: string): PrLookup =>
    prs.ok ? (prs.value[id] ?? null) : "unknown";

  const baseRow = (id: string) => {
    const queued = queueById.get(id);
    const prepRecord = prep[id];
    const repo = queued?.ticket.repo ?? prepRecord?.repo;
    return {
      tonightPosition: queued?.position ?? null,
      ...(prepRecord ? { prepRecord } : {}),
      ...(repo ? { repo } : {}),
      pr: lookupPr(id),
    };
  };

  const todoRow = (issue: TodoIssue): ClockOffRow => ({
    id: issue.identifier,
    title: issue.title,
    url: issue.url,
    team: issue.teamKey,
    priority: issue.priorityLabel,
    priorityRank: priorityRank(issue.priority),
    estimate: issue.estimate,
    inTodo: true,
    linearState: TODO_STATE,
    prep: prepState(prep[issue.identifier], issue),
    ...baseRow(issue.identifier),
  });

  let snapshotsNeeded = false;
  const offTodoRow = (ticket: Ticket): ClockOffRow => {
    snapshotsNeeded = true;
    const snapshot = snapshots.ok
      ? (snapshots.value[ticket.id] ?? null)
      : undefined;
    if (snapshots.ok) {
      const stateWarning = linearStateWarning(ticket.id, snapshot);
      if (stateWarning) linearWarnings.set(ticket.id, stateWarning);
    }
    return {
      id: ticket.id,
      title: snapshot?.title ?? ticket.name,
      ...(snapshot ? { url: snapshot.url, linearState: snapshot.state } : {}),
      priority: NO_PRIORITY_LABEL,
      priorityRank: priorityRank(NO_PRIORITY),
      estimate: null,
      inTodo: false,
      prep: snapshot ? prepState(prep[ticket.id], snapshot) : null,
      ...baseRow(ticket.id),
    };
  };

  const todoRows = new Map(todoIssues.map((i) => [i.identifier, todoRow(i)]));
  const projectOf = (issue: TodoIssue) =>
    projectForLinearProject(projects, issue.projectName);

  const queueRows: QueueRow[] = queueTickets.map((ticket, i) => ({
    ...(todoRows.get(ticket.id) ?? offTodoRow(ticket)),
    project: ticket.project ?? "",
    repo: ticket.repo,
    repos: Object.keys(
      projects.find((p) => p.name === ticket.project)?.repos ?? {},
    ),
    position: i + 1,
  }));

  const tabs = projects.map((p) => ({
    project: p.name,
    rows: todoIssues
      .filter((issue) => projectOf(issue) === p.name)
      .map((issue) => todoRows.get(issue.identifier)!)
      .sort((a, b) => a.priorityRank - b.priorityRank),
  }));

  const warnings: ClockOffWarning[] = [];
  for (const row of queueRows) {
    const warning = linearWarnings.get(row.id) ?? prepWarning(row.id, row.prep);
    if (warning) warnings.push(warning);
  }
  for (const issue of todoIssues) {
    if (projectOf(issue) === undefined) warnings.push(unmappedWarning(issue));
  }
  const autoComplete = new Set<string>();
  for (const row of [...queueRows, ...tabs.flatMap((t) => t.rows)]) {
    if (!row.pr || row.pr === "unknown" || !row.pr.autoComplete) continue;
    if (autoComplete.has(row.id)) continue;
    autoComplete.add(row.id);
    warnings.push(
      warn(
        "auto_complete",
        `PR #${row.pr.prId} for ${row.id} has auto-complete set; the runner won't push to it`,
        row.id,
      ),
    );
  }
  const usageResult = usageView(usage, now);
  if (usageResult.warning) warnings.push(usageResult.warning);

  const linearError = !todo.ok
    ? todo.error
    : snapshotsNeeded && !snapshots.ok
      ? snapshots.error
      : undefined;

  return {
    allowance:
      queue.ok && queue.value.allowance !== undefined
        ? { percent: queue.value.allowance, source: "tonight.md" }
        : { percent: input.rootAllowance, source: "nightly default" },
    usage: usageResult.view,
    queue: queueRows,
    sweep: projects.map((p) => ({
      project: p.name,
      openPrs: openPrs[p.name] ?? { ok: false, error: "not loaded" },
    })),
    tabs,
    warnings,
    ...(linearError !== undefined ? { linearError } : {}),
    ...(!queue.ok ? { queueError: queue.error } : {}),
    ...(!prs.ok ? { prError: prs.error } : {}),
  };
}
