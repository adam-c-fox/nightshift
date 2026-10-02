import { deriveOutcome } from "./status.js";
import { buildPrTitle, type FailedCheck, type PRResult } from "./pr.js";
import { formatCiFailures, type CiFailure } from "./ci-logs.js";
import type { ClaudeResult } from "./claude.js";
import type { CommitOutcome } from "./worktree.js";
import type { TicketStatus } from "./types.js";

export const MAX_CI_FIX_ATTEMPTS = 2;

export type CiFixStop = "budget" | "no_changes" | "agent" | "exhausted";

export interface CiFixDeps {
  runAgent(context: string[]): Promise<ClaudeResult>;
  commit(subject: string): CommitOutcome;
  publish(): Promise<PRResult>;
  fetchLogs(checks: FailedCheck[]): Promise<CiFailure[]>;
  gateOpen(): boolean;
  log(msg: string): void;
}

export interface CiFixOutcome {
  pr: PRResult;
  attempts: number;
  stopped?: CiFixStop;
  agentStatus?: TicketStatus;
  notes: string[];
}

export function ciFixContext(prId: number, logs: string): string[] {
  return [
    `Required checks failed on PR #${prId}. Fix only these failures; do not change anything unrelated.`,
    `Re-run the same commands locally (for example npm run lint, npm run format, npx vitest run) until they pass, then end with the usual report.\n${logs}`,
  ];
}

export async function fixFailingChecks(
  initial: PRResult,
  ticket: { ticketId: string; title: string },
  deps: CiFixDeps,
): Promise<CiFixOutcome> {
  let pr = initial;
  let attempts = 0;
  let agentStatus: TicketStatus | undefined;
  const notes: string[] = [];
  const outcome = (stopped?: CiFixStop): CiFixOutcome => ({ pr, attempts, stopped, agentStatus, notes });

  while (pr.pipelineStatus === "failed" && attempts < MAX_CI_FIX_ATTEMPTS) {
    if (!deps.gateOpen()) return outcome("budget");
    attempts++;
    deps.log(`  CI fix attempt ${attempts}/${MAX_CI_FIX_ATTEMPTS}: ${pr.failedChecks.map(c => c.name).join(", ")}`);

    const failures = await deps.fetchLogs(pr.failedChecks);
    const result = await deps.runAgent(ciFixContext(pr.prId, formatCiFailures(failures)));
    const agent = deriveOutcome(result);
    if (!agent.publish) {
      notes.push(...agent.notes);
      return outcome("agent");
    }
    agentStatus = agent.status;
    notes.push(...agent.notes);

    const report = result.report;
    const subject = buildPrTitle(ticket.ticketId, report?.title || ticket.title, report?.summary ?? "");
    if (deps.commit(subject) === "no_changes") return outcome("no_changes");
    pr = await deps.publish();
  }
  return outcome(pr.pipelineStatus === "failed" ? "exhausted" : undefined);
}
