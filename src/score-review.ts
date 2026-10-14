import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractFlag } from "./args.js";
import { parseGolden, scoreSummary, scoreTicket, totalSummary, type TicketScore } from "./golden.js";
import type { RunRecord, TicketReview } from "./types.js";

export const SCORE_USAGE = "usage: score-review --golden <dir> [--json <file>] <session.json|replay.json> [...]";

export interface ScoreArgs { golden: string; json?: string; records: string[] }

export function parseScoreArgs(argv: string[]): ScoreArgs {
  const { value: golden, rest: afterGolden } = extractFlag(argv, "--golden");
  if (golden === undefined) throw new Error(`--golden is required\n${SCORE_USAGE}`);
  const { value: json, rest: records } = extractFlag(afterGolden, "--json");
  const unknown = records.find(arg => arg.startsWith("--"));
  if (unknown !== undefined) throw new Error(`unknown argument "${unknown}"\n${SCORE_USAGE}`);
  if (records.length === 0) throw new Error(`at least one record file is required\n${SCORE_USAGE}`);
  return { golden, ...(json !== undefined ? { json } : {}), records };
}

export interface ReviewRecord { ticket: string; review: TicketReview; runs: RunRecord[]; file: string }

interface RecordFile {
  tickets?: { ticket: { id: string }; review?: TicketReview; runs?: RunRecord[] }[];
  version?: unknown;
  ticket?: { id?: unknown };
  review?: TicketReview;
  runs?: RunRecord[];
}

export function loadReviewRecords(json: unknown, file: string): ReviewRecord[] {
  const raw = (json ?? {}) as RecordFile;
  if (Array.isArray(raw.tickets)) {
    return raw.tickets.flatMap(t => (t.review ? [{ ticket: t.ticket.id, review: t.review, runs: (t.runs ?? []).filter(r => r.stage.startsWith("review-")), file }] : []));
  }
  if (raw.version === 1 && typeof raw.ticket?.id === "string" && raw.review && typeof raw.review === "object") {
    return [{ ticket: raw.ticket.id, review: raw.review, runs: raw.runs ?? [], file }];
  }
  throw new Error(`${file} is neither a night session nor a replay record`);
}

export interface ScoredRecord { file: string; score: TicketScore }

export function scoreRecords(
  goldenDir: string,
  files: string[],
  read: (file: string) => string = file => readFileSync(file, "utf-8"),
  exists: (file: string) => boolean = existsSync,
): { scored: ScoredRecord[]; skipped: string[] } {
  const scored: ScoredRecord[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    for (const record of loadReviewRecords(JSON.parse(read(file)), file)) {
      const goldenFile = path.join(goldenDir, `${record.ticket}.json`);
      if (exists(goldenFile)) scored.push({ file, score: scoreTicket(parseGolden(JSON.parse(read(goldenFile))), record.review, record.runs) });
      else skipped.push(`${record.ticket} (${path.basename(file)})`);
    }
  }
  return { scored, skipped };
}

function report(args: ScoreArgs): void {
  const { scored, skipped } = scoreRecords(args.golden, args.records);
  if (scored.length === 0) throw new Error(`no record matched a golden set in ${args.golden}`);
  for (const { file, score } of scored) console.log(`\n-- ${score.ticket} from ${path.basename(file)}\n${scoreSummary(score)}`);
  if (scored.length > 1) console.log(`\n${totalSummary(scored.map(s => s.score))}`);
  if (skipped.length > 0) console.log(`No golden set for: ${skipped.join(", ")}`);
  if (args.json) writeFileSync(args.json, `${JSON.stringify({ version: 1, scored }, null, 2)}\n`, "utf-8");
}

function main(): void {
  try {
    report(parseScoreArgs(process.argv.slice(2)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
