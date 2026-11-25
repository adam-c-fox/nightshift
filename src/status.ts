import type { ClaudeResult } from "./claude.js";
import type { Issue, WorkflowStep } from "./issue-tracker.js";
import type { TicketStatus } from "./types.js";

const REVIEWABLE_STATUSES: TicketStatus[] = ["done", "needs_review"];

export const reviewMove = (issue: Issue | null, status: TicketStatus): WorkflowStep | undefined =>
  issue && REVIEWABLE_STATUSES.includes(status) ? issue.reviewTarget : undefined;

export interface Outcome {
  status: TicketStatus;
  notes: string[];
  publish: boolean;
}

export function deriveOutcome(result: ClaudeResult): Outcome {
  if (result.abortReason) {
    return { status: "needs_review", notes: [`Agent aborted: ${result.abortReason}. Work kept on local branch, not pushed.`], publish: false };
  }
  if (!result.success) {
    return { status: "needs_review", notes: [`Agent did not finish: ${result.failure ?? "unknown failure"}. Work kept on local branch, not pushed.`], publish: false };
  }
  if (!result.report) {
    return { status: "needs_review", notes: ["Agent did not produce a valid ---REPORT--- block."], publish: true };
  }
  const failing = result.report.tests.filter(t => t.result === "fail").map(t => t.name);
  if (result.report.status === "done" && failing.length > 0) {
    return { status: "needs_review", notes: [`Reported done with failing test(s): ${failing.join(", ")}.`], publish: true };
  }
  return { status: result.report.status as TicketStatus, notes: [], publish: true };
}
