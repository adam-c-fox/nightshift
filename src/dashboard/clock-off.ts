import type { UsageSummary } from "../budget.js";
import { TODO_STATE, type IssueSnapshot, type TodoIssue } from "../linear.js";
import {
  prepState,
  type PrepRecord,
  type PrepState,
  type PrepStore,
} from "../prep.js";
import type { Project } from "../project.js";
import type { Ticket } from "../types.js";
import type { Loaded } from "./cache.js";

export interface TicketPr {
  prId: number;
  url: string;
  autoComplete: boolean;
}

export type PrLookup = TicketPr | null | "unknown";

export interface ClockOffInput {
  project: Pick<Project, "name" | "allowancePercent" | "linearTeams">;
  todo: Loaded<TodoIssue[]>;
  tonight: Loaded<{ tickets: Ticket[]; allowance?: number }>;
  snapshots: Loaded<Record<string, IssueSnapshot | null>>;
  prep: PrepStore;
  prs: Loaded<Record<string, PrLookup>>;
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
  | "reset_soon";

export interface ClockOffWarning {
  code: WarningCode;
  ticketId?: string;
  message: string;
}

export interface ClockOffView {
  project: string;
  teams?: string[];
  allowance: { percent: number; source: "tonight.md" | "project default" };
  usage: Loaded<{
    weeklyPercent: number;
    resetInfo: string;
    resetAt?: string;
    resetSoon: boolean;
    codex?: UsageSummary;
    codexError?: string;
  }>;
  rows: ClockOffRow[];
  linearError?: string;
  tonightError?: string;
  prError?: string;
  warnings: ClockOffWarning[];
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
  usage: ClockOffInput["usage"],
  now: Date,
): { view: ClockOffView["usage"]; warning?: ClockOffWarning } {
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

export function buildClockOff(input: ClockOffInput): ClockOffView {
  const { project, todo, tonight, snapshots, prep, prs, usage, now } = input;
  const tonightTickets = tonight.ok ? tonight.value.tickets : [];
  const todoIssues = todo.ok ? todo.value : [];
  const todoById = new Map(todoIssues.map((i) => [i.identifier, i]));
  const tonightById = new Map(
    tonightTickets.map((t, i) => [t.id, { ticket: t, position: i + 1 }]),
  );

  const linearWarnings = new Map<string, ClockOffWarning>();
  const prepWarnings = new Map<string, ClockOffWarning>();
  const rows: ClockOffRow[] = [];

  const lookupPr = (id: string): PrLookup =>
    prs.ok ? (prs.value[id] ?? null) : "unknown";

  const baseRow = (id: string) => {
    const tonightEntry = tonightById.get(id);
    const prepRecord = prep[id];
    const repo = tonightEntry?.ticket.repo ?? prepRecord?.repo;
    return {
      tonightPosition: tonightEntry?.position ?? null,
      ...(prepRecord ? { prepRecord } : {}),
      ...(repo ? { repo } : {}),
      pr: lookupPr(id),
    };
  };

  for (const issue of todoIssues) {
    rows.push({
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
  }

  let snapshotsNeeded = false;
  for (const { ticket } of tonightById.values()) {
    if (todoById.has(ticket.id)) continue;
    snapshotsNeeded = true;
    const snapshot = snapshots.ok
      ? (snapshots.value[ticket.id] ?? null)
      : undefined;
    if (snapshots.ok) {
      const stateWarning = linearStateWarning(ticket.id, snapshot);
      if (stateWarning) linearWarnings.set(ticket.id, stateWarning);
    }
    rows.push({
      id: ticket.id,
      title: snapshot?.title ?? ticket.name,
      ...(snapshot ? { url: snapshot.url, linearState: snapshot.state } : {}),
      priority: NO_PRIORITY_LABEL,
      priorityRank: priorityRank(NO_PRIORITY),
      estimate: null,
      inTodo: false,
      prep: snapshot ? prepState(prep[ticket.id], snapshot) : null,
      ...baseRow(ticket.id),
    });
  }

  for (const row of rows) {
    if (row.tonightPosition === null || linearWarnings.has(row.id)) continue;
    const warning = prepWarning(row.id, row.prep);
    if (warning) prepWarnings.set(row.id, warning);
  }

  rows.sort((a, b) => {
    if (a.tonightPosition !== null && b.tonightPosition !== null)
      return a.tonightPosition - b.tonightPosition;
    if (a.tonightPosition !== null) return -1;
    if (b.tonightPosition !== null) return 1;
    return a.priorityRank - b.priorityRank;
  });

  const warnings: ClockOffWarning[] = [];
  for (const ticket of tonightTickets) {
    const warning =
      linearWarnings.get(ticket.id) ?? prepWarnings.get(ticket.id);
    if (warning) warnings.push(warning);
  }
  for (const row of rows) {
    if (row.pr && row.pr !== "unknown" && row.pr.autoComplete)
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
    project: project.name,
    ...(project.linearTeams ? { teams: project.linearTeams } : {}),
    allowance:
      tonight.ok && tonight.value.allowance !== undefined
        ? { percent: tonight.value.allowance, source: "tonight.md" }
        : { percent: project.allowancePercent, source: "project default" },
    usage: usageResult.view,
    rows,
    ...(linearError !== undefined ? { linearError } : {}),
    ...(!tonight.ok ? { tonightError: tonight.error } : {}),
    ...(!prs.ok ? { prError: prs.error } : {}),
    warnings,
  };
}
