export type RepoKind = "main" | "terraform";

export interface Ticket {
  id: string;            // e.g. "ENG-142"
  name: string;          // e.g. "CSV export fix"
  context: string[];     // bullet lines from tonight.md
  repo: RepoKind;
}

export interface LinearTicket {
  id: string;
  identifier: string;
  name: string;
  description: string;
  state: string;
  url: string;
  branchName: string;
}

export type TicketStatus = "done" | "partial" | "needs_review" | "skipped" | "error";

export interface TestResult {
  name: string;
  file: string;
  result: "pass" | "fail";
}

export type PipelineStatus = "succeeded" | "failed" | "unknown";

export interface TicketResult {
  ticket: Ticket;
  linear: LinearTicket | null;
  status: TicketStatus;
  title?: string;
  summary: string;
  filesCreated: string[];
  filesModified: string[];
  tests: TestResult[];
  verifyCommands: string[];
  notes: string;
  worktreePath: string;
  branch: string;
  durationSec: number;
  prUrl?: string;
  prId?: number;
  pipelineStatus?: PipelineStatus;
}

export interface NightBudget {
  startPct: number;
  capPct: number;
  currentPct: number;
  allocationPct: number;
  gateHit: boolean;
  unavailable: boolean;
  resetInfo: string;
}

export interface SessionResult {
  date: string;
  startedAt: string;
  endedAt: string;
  tickets: TicketResult[];
  budget: NightBudget;
  gateHit: boolean;
  skipReason: string;
  noTasks: boolean;
}
