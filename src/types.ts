import type { CheckStatus } from "./checks.js";

export type Toolchain = "node" | "terraform";

export interface Ticket {
  id: string;            // e.g. "ENG-142"
  name: string;          // e.g. "CSV export fix"
  context: string[];     // bullet lines from tonight.md
  repo: string;
  base?: string;         // ID of an earlier ticket this one is stacked on
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
  inReviewState?: { id: string; name: string };
  url: string;
}

export type TicketStatus = "done" | "partial" | "needs_review" | "skipped" | "error";

export interface TestResult {
  name: string;
  file: string;
  result: "pass" | "fail";
}

export type Severity = "blocker" | "major" | "minor";

export type ReviewLens = "bugs" | "spec" | "reuse";
export const REVIEW_LENSES: ReviewLens[] = ["bugs", "bugs", "spec", "reuse"];

export type ReviewStage = `review-${ReviewLens}` | `review-${ReviewLens}-${number}`;

export const lensStage = (lens: ReviewLens, pass = 1): ReviewStage => pass > 1 ? `review-${lens}-${pass}` : `review-${lens}`;

export const lensLabel = (lens: ReviewLens, pass = 1): string => pass > 1 ? `${lens} (pass ${pass})` : lens;

export type Confidence = "proven" | "suspected";

export interface ReviewFinding {
  id: string;
  severity: Severity;
  file: string;
  issue: string;
  suggestion: string;
  from?: string;
}

export interface FixResolution {
  id: string;
  status: "fixed" | "not_fixed";
  how: string;
}

export interface ReviewRisk {
  file: string;
  risk: string;
  data?: boolean;
}

export interface LensRun {
  lens: ReviewLens;
  pass?: number;
  outcome: "reviewed" | "skipped" | "failed";
  reason?: string;
  candidates: number;
}

export interface ReviewCandidate {
  id: string;
  lens: ReviewLens;
  kind: "finding" | "risk";
  severity: Severity;
  confidence: Confidence;
  file: string;
  issue: string;
  suggestion: string;
  data: boolean;
  decision?: string;
}

export type Verdict = "confirmed" | "duplicate" | "unproven" | "rejected";

export interface CandidateVerdict {
  id: string;
  verdict: Verdict;
  duplicateOf?: string;
  severity?: Severity;
  data?: boolean;
  note: string;
}

export type Ruling = "accept" | "finding" | "risk" | "unruled";

export interface DecisionRuling {
  id: string;
  decision: string;
  file: string;
  ruling: Ruling;
  reason: string;
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
  lenses?: LensRun[];
  candidates?: (ReviewCandidate & { verdict?: CandidateVerdict })[];
  confirmation?: { outcome: "confirmed" | "skipped" | "failed"; reason?: string };
  decisions?: DecisionRuling[];
}

export interface CheckRecord {
  name: string;
  command: string;
  passed: boolean;
  durationSec: number;
  status?: CheckStatus;
}

export type PipelineStatus = "succeeded" | "failed" | "unknown";

export interface Followup {
  file: string;
  note: string;
}

export interface Decision {
  file: string;
  decision: string;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  turns: number;
  durationMs: number;
  models: string[];
}

export interface RunRecord {
  stage: string;
  usage?: RunUsage;
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
  decisions?: Decision[];
  worktreePath: string;
  branch: string;
  durationSec: number;
  prUrl?: string;
  prId?: number;
  pipelineStatus?: PipelineStatus;
  review?: TicketReview;
  checks?: CheckRecord[];
  runs?: RunRecord[];
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
  usage?: RunUsage;
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
  ticketError?: string;
  postmortem?: SessionPostmortem;
}

export interface NightRecord extends SessionResult {
  startedAtIso: string;
  endedAtIso: string;
  dryRun: boolean;
}
