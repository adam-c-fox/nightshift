import { readdirSync } from "node:fs";
import path from "node:path";
import { readJsonFile } from "./state.js";

export type RunPhase =
  "starting" | "ticket" | "postmortem" | "report" | "finished";

export interface RunHeartbeat {
  pid: number;
  base: string;
  startedAtIso: string;
  ticketIndex: number;
  total: number;
  ticketId: string | null;
  phase: RunPhase;
  heartbeatAt: string;
  finishedAt?: string;
}

export const HEARTBEAT_INTERVAL_MS = 60_000;
export const STALE_AFTER_MS = 180_000;

export function heartbeatFile(logsDir: string): string {
  return path.join(logsDir, "run.json");
}

export interface HeartbeatDeps {
  write: (hb: RunHeartbeat) => void;
  now: () => Date;
  every: (fn: () => void, ms: number) => () => void;
}

export interface Heartbeat {
  phase(
    phase: RunPhase,
    ticket?: { index: number; total: number; id: string },
  ): void;
  finish(): void;
}

export function startHeartbeat(
  init: { pid: number; base: string; startedAt: Date },
  deps: HeartbeatDeps,
): Heartbeat {
  const state: RunHeartbeat = {
    pid: init.pid,
    base: init.base,
    startedAtIso: init.startedAt.toISOString(),
    ticketIndex: 0,
    total: 0,
    ticketId: null,
    phase: "starting",
    heartbeatAt: init.startedAt.toISOString(),
  };
  let finished = false;

  const beat = () => {
    if (finished) return;
    state.heartbeatAt = deps.now().toISOString();
    deps.write({ ...state });
  };

  beat();
  const cancel = deps.every(beat, HEARTBEAT_INTERVAL_MS);

  return {
    phase(phase, ticket) {
      state.phase = phase;
      state.ticketId = ticket?.id ?? null;
      if (ticket) {
        state.ticketIndex = ticket.index;
        state.total = ticket.total;
      }
      beat();
    },
    finish() {
      if (finished) return;
      cancel();
      state.phase = "finished";
      state.heartbeatAt = deps.now().toISOString();
      state.finishedAt = state.heartbeatAt;
      deps.write({ ...state });
      finished = true;
    },
  };
}

export type RunView =
  | { state: "idle" }
  | {
      state: "running" | "stale";
      heartbeat: RunHeartbeat;
      elapsedMs: number;
      sinceHeartbeatMs: number;
    };

export function runView(hb: RunHeartbeat | null, now: Date): RunView {
  if (!hb || hb.phase === "finished" || hb.finishedAt) return { state: "idle" };
  const sinceHeartbeatMs = now.getTime() - Date.parse(hb.heartbeatAt);
  return {
    state: sinceHeartbeatMs > STALE_AFTER_MS ? "stale" : "running",
    heartbeat: hb,
    elapsedMs: now.getTime() - Date.parse(hb.startedAtIso),
    sinceHeartbeatMs,
  };
}

export interface ProjectRun {
  project: string;
  view: RunView;
}

function readHeartbeat(file: string): RunHeartbeat | null {
  try {
    const value = readJsonFile<RunHeartbeat | null>(file, null);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function readProjectRuns(logsDir: string, now: Date): ProjectRun[] {
  let entries: string[];
  try {
    entries = readdirSync(logsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries
    .sort()
    .map((project) => ({
      project,
      view: runView(
        readHeartbeat(heartbeatFile(path.join(logsDir, project))),
        now,
      ),
    }))
    .filter((run) => run.view.state !== "idle");
}
