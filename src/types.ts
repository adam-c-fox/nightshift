export type RepoKind = "main" | "terraform";

export interface Ticket {
  id: string;            // e.g. "ENG-142"
  name: string;          // e.g. "CSV export fix"
  context: string[];     // bullet lines from tonight.md
  repo: RepoKind;
}

export interface LinearComment {
  author: string;
  createdAt: string;
  body: string;
}

export interface LinearTicket {
  id: string;
  identifier: string;
  name: string;
  description: string;
  comments: LinearComment[];
  state: string;
  stateType: string;
  inProgressState?: { id: string; name: string };
  url: string;
}

export type TicketStatus = "done" | "partial" | "needs_review" | "skipped" | "error";

export interface TestResult {
  name: string;
  file: string;
  result: "pass" | "fail";
}

export type Severity = "blocker" | "major" | "minor";

export interface ReviewFinding {
  id: string;
  severity: Severity;
  file: string;
  issue: string;
  suggestion: string;
}

export interface FixResolution {
  id: string;
  status: "fixed" | "not_fixed";
  how: string;
}

export interface ReviewRisk {
  file: string;
  risk: string;
}

export interface VerifyResult {
  id: string;
  status: "resolved" | "unresolved";
  note: string;
}

export interface FixVerification {
  outcome: "verified" | "skipped" | "failed";
  reason?: string;
  results: VerifyResult[];
}

export interface TicketReview {
  outcome: "reviewed" | "skipped" | "failed";
  reason?: string;
  findings: ReviewFinding[];
  resolutions: FixResolution[];
  risks?: ReviewRisk[];
  verification?: FixVerification;
}

export interface CheckRecord {
  name: string;
  command: string;
  passed: boolean;
  durationSec: number;
  status?: "passed" | "regression" | "pre-existing" | "new";
}

export type PipelineStatus = "succeeded" | "failed" | "unknown";

export interface Followup {
  file: string;
  note: string;
}

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
  followups: Followup[];
  worktreePath: string;
  branch: string;
  durationSec: number;
  prUrl?: string;
  prId?: number;
  pipelineStatus?: PipelineStatus;
  review?: TicketReview;
  checks?: CheckRecord[];
}

export interface NightBudget {
  startPct: number;
  capPct: number;
  currentPct: number;
  allocationPct: number;
  gateHit: boolean;
  unavailable: boolean;
  resetInfo: string;
  sessionPercent?: number;
}

export interface PostmortemSuggestion {
  id: string;
  target: string;
  tickets: string[];
  problem: string;
  cause: string;
  change: string;
}

export interface SessionPostmortem {
  outcome: "done" | "skipped" | "failed";
  reason?: string;
  suggestions: PostmortemSuggestion[];
  file?: string;
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
  postmortem?: SessionPostmortem;
}
