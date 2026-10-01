import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import path from "node:path";
import type { TicketResult, SessionResult } from "./types.js";
import { loadTickets } from "./tickets.js";
import { checkBudget, budgetGateMessage } from "./budget.js";
import { fetchTicket } from "./linear.js";
import { runAgent } from "./claude.js";
import { writeReport } from "./report.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKTREES_DIR = path.join(ROOT, "worktrees");
const LOGS_DIR = path.join(ROOT, "logs");

const REPOS: Record<string, string> = {
  main: "/path/to/app",
  terraform: "/path/to/infra",
};

const DRY_RUN = process.argv.includes("--dry-run");

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(LOGS_DIR, `nightshift-${today}.log`);
    const { appendFileSync } = require("node:fs");
    appendFileSync(logPath, line + "\n");
  } catch { /* best effort */ }
}

function run(cmd: string, cwd?: string): string {
  return execSync(cmd, { encoding: "utf-8", cwd, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
}

function createWorktree(repoPath: string, ticketId: string): string {
  const branch = `night/${ticketId}`;
  const wtPath = path.join(WORKTREES_DIR, ticketId);

  // Clean up stale worktree if it exists
  if (existsSync(wtPath)) {
    log(`Cleaning stale worktree: ${wtPath}`);
    run(`git worktree remove --force "${wtPath}"`, repoPath);
  }

  // Create worktree
  run(`git worktree add "${wtPath}" -b "${branch}"`, repoPath);
  log(`Worktree created: ${wtPath} (branch: ${branch})`);

  // Symlink node_modules from main repo (speeds up vitest)
  if (repoPath.includes("example-app") && !repoPath.includes("TF")) {
    const srcNM = path.join(repoPath, "node_modules");
    const dstNM = path.join(wtPath, "node_modules");
    if (existsSync(srcNM) && !existsSync(dstNM)) {
      symlinkSync(srcNM, dstNM, "dir");
      log(`Symlinked node_modules → ${dstNM}`);
    }
  }

  return wtPath;
}

function commitWorktree(wtPath: string, ticketId: string, summary: string): void {
  try {
    const status = run(`git status --porcelain`, wtPath).trim();
    if (status === "") {
      log(`No changes to commit for ${ticketId}`);
      return;
    }
    const safeSummary = summary.replace(/"/g, '\\"').slice(0, 120);
    run(`git add -A`, wtPath);
    run(`git commit -m "night: ${ticketId} – ${safeSummary}"`, wtPath);
    log(`Committed: night/${ticketId}`);
  } catch (e) {
    log(`Commit failed for ${ticketId}: ${(e as Error).message}`);
  }
}

function processTicket(ticketId: string, ticketName: string, context: string[], repo: string, dryRun: boolean): TicketResult {
  const repoPath = REPOS[repo];
  const branch = `night/${ticketId}`;
  const startTime = Date.now();
  const wtPath = path.join(WORKTREES_DIR, ticketId);

  log(`\n── Ticket ${ticketId} – ${ticketName} [${repo}] ──`);

  // Fetch from Linear
  let linear = null;
  let linearDesc = "", linearUrl = "", linearState = "";
  try {
    linear = await_fetchTicket(ticketId);
    if (linear) {
      linearDesc = linear.description;
      linearUrl = linear.url;
      linearState = linear.state;
      log(`  Linear: ${linear.name} [${linear.state}]`);
    } else {
      log(`  Linear: ticket ${ticketId} not found (using tonight.md context only)`);
    }
  } catch (e) {
    log(`  Linear fetch error: ${(e as Error).message}`);
  }

  // Create worktree
  if (dryRun) {
    log(`  [dry-run] Would create worktree at ${wtPath}`);
  } else {
    createWorktree(repoPath, ticketId);
  }

  // Run agent
  const result = runAgent(
    wtPath, ticketId, ticketName, context,
    linearDesc, linearUrl, linearState, dryRun
  );

  // Build TicketResult
  const report = result.report;
  const status = report?.status ?? "needs_review";
  const ticketResult: TicketResult = {
    ticket: { id: ticketId, name: ticketName, context, repo },
    linear,
    status: (status as TicketResult["status"]) ?? "needs_review",
    summary: report?.summary ?? (result.parseError ? `Parse error: ${result.parseError}` : "Agent produced no report."),
    filesCreated: report?.filesCreated ?? [],
    filesModified: report?.filesModified ?? [],
    tests: report?.tests ?? [],
    verifyCommands: report?.verifyCommands ?? [],
    notes: report?.notes ?? (result.parseError ? "Agent did not produce a valid ---REPORT--- block." : ""),
    worktreePath: wtPath,
    branch,
    durationSec: Math.round((Date.now() - startTime) / 1000),
  };

  // Commit
  if (!dryRun) {
    commitWorktree(wtPath, ticketId, ticketResult.summary);
  }

  // Save raw output for debugging
  if (!dryRun) {
    try {
      mkdirSync(LOGS_DIR, { recursive: true });
      const outPath = path.join(LOGS_DIR, `${ticketId}-output.txt`);
      writeFileSync(outPath, result.rawOutput, "utf-8");
    } catch { /* best effort */ }
  }

  log(`  Result: ${ticketResult.status} (${ticketResult.durationSec}s)`);
  return ticketResult;
}

// Wrapper because fetchTicket is async but processTicket is sync in the loop
// (we call it from an async main)
let _ticketCache: Map<string, Awaited<ReturnType<typeof fetchTicket>>>;
async function await_fetchTicket(id: string) {
  _ticketCache ??= new Map();
  if (_ticketCache.has(id)) return _ticketCache.get(id)!;
  const t = await fetchTicket(id);
  _ticketCache.set(id, t);
  return t;
}

async function main() {
  const date = new Date().toISOString().slice(0, 10);
  const startedAt = new Date().toLocaleString("en-US", { timeZone: "America/Vancouver" });
  log(`═══ Nightshift session ${date} started ${DRY_RUN ? "(DRY RUN)" : ""} ═══`);

  mkdirSync(WORKTREES_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  // Budget check
  const budget = checkBudget();
  log(budgetGateMessage(budget));

  // Load tickets
  const tickets = loadTickets();
  log(`Loaded ${tickets.length} ticket(s) from tonight.md`);

  const results: TicketResult[] = [];
  let gateHit = budget.gateHit;

  for (const ticket of tickets) {
    // Re-check budget before each ticket
    if (!DRY_RUN) {
      const recheck = checkBudget();
      if (recheck.gateHit && !gateHit) {
        log(`⚠️  Budget gate hit mid-session at ${recheck.weeklyPercent}% – stopping.`);
        gateHit = true;
      }
    }

    if (gateHit) {
      log(`  Skipping ${ticket.id} – budget gate active`);
      results.push({
        ticket, linear: null, status: "skipped",
        summary: "Skipped – weekly budget gate active.",
        filesCreated: [], filesModified: [], tests: [],
        verifyCommands: [], notes: "",
        worktreePath: "", branch: `night/${ticket.id}`, durationSec: 0,
      });
      continue;
    }

    try {
      const r = await processTicket(
        ticket.id, ticket.name, ticket.context, ticket.repo, DRY_RUN
      );
      results.push(r);
    } catch (e) {
      log(`  ERROR processing ${ticket.id}: ${(e as Error).message}`);
      results.push({
        ticket, linear: null, status: "error",
        summary: (e as Error).message,
        filesCreated: [], filesModified: [], tests: [],
        verifyCommands: [], notes: "",
        worktreePath: "", branch: `night/${ticket.id}`, durationSec: 0,
      });
    }
  }

  // Final budget snapshot
  const finalBudget = DRY_RUN ? budget : checkBudget();
  const endedAt = new Date().toLocaleString("en-US", { timeZone: "America/Vancouver" });

  const session: SessionResult = {
    date,
    startedAt,
    endedAt,
    tickets: results,
    budget: finalBudget,
    gateHit,
    noTasks: tickets.length === 0,
  };

  // Write report
  const reportPath = writeReport(session);
  log(`\n═══ Report written: ${reportPath} ═══`);
  log(`Open in browser: file://${reportPath}`);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
