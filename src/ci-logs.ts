import { az, type FailedCheck } from "./pr.js";

const TAIL_LINES = 150;
const TOTAL_CHARS = 20_000;
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/;

export interface TimelineRecord {
  type: string;
  name: string;
  result?: string | null;
  log?: { id?: number } | null;
  issues?: { type?: string; message?: string }[] | null;
}

export interface FailedTask {
  name: string;
  logId: number | undefined;
  issues: string[];
}

export interface CiFailure {
  check: string;
  task: string;
  issues: string[];
  tail: string;
  error?: string;
}

export interface CiSource {
  timeline(buildId: number): Promise<TimelineRecord[]>;
  log(buildId: number, logId: number): Promise<string[]>;
}

export const stripTimestamps = (lines: string[]): string[] => lines.map(l => l.replace(TIMESTAMP_PREFIX, ""));

export const tailLines = (lines: string[], count: number): string[] => lines.slice(-count);

export function failedTasks(records: TimelineRecord[]): FailedTask[] {
  return records
    .filter(r => r.type === "Task" && r.result === "failed")
    .map(r => ({
      name: r.name,
      logId: r.log?.id,
      issues: (r.issues ?? []).filter(i => i.type !== "warning" && i.message).map(i => i.message!),
    }));
}

export function ciTimelineArgs(org: string, project: string, buildId: number): string[] {
  return ["devops", "invoke", "--area", "build", "--resource", "timeline", "--route-parameters", `project=${project}`, `buildId=${buildId}`, "--org", org];
}

export function ciLogArgs(org: string, project: string, buildId: number, logId: number): string[] {
  return ["devops", "invoke", "--area", "build", "--resource", "logs", "--route-parameters", `project=${project}`, `buildId=${buildId}`, `logId=${logId}`, "--org", org];
}

export function azCiSource(org: string, project: string): CiSource {
  return {
    timeline: async buildId => ((az(ciTimelineArgs(org, project, buildId)) as { records?: TimelineRecord[] } | null)?.records ?? []),
    log: async (buildId, logId) => ((az(ciLogArgs(org, project, buildId, logId)) as { value?: string[] } | null)?.value ?? []),
  };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0];

async function failuresForCheck(check: FailedCheck, source: CiSource): Promise<CiFailure[]> {
  const unavailable = (error: string): CiFailure[] => [{ check: check.name, task: "", issues: [], tail: "", error }];
  if (check.buildId === undefined) return unavailable("no build id on the policy evaluation");
  let tasks: FailedTask[];
  try {
    tasks = failedTasks(await source.timeline(check.buildId));
  } catch (e) {
    return unavailable(`could not fetch build timeline: ${message(e)}`);
  }
  if (tasks.length === 0) return unavailable("no failed task found in the build timeline");
  return Promise.all(tasks.map(async task => {
    const base = { check: check.name, task: task.name, issues: task.issues };
    if (task.logId === undefined) return { ...base, tail: "", error: "task has no log" };
    try {
      const lines = stripTimestamps(await source.log(check.buildId!, task.logId));
      return { ...base, tail: tailLines(lines, TAIL_LINES).join("\n") };
    } catch (e) {
      return { ...base, tail: "", error: `could not fetch log: ${message(e)}` };
    }
  }));
}

function trimOldest(tail: string, maxChars: number): string {
  if (tail.length <= maxChars) return tail;
  const lines = tail.split("\n");
  while (lines.length > 1 && lines.join("\n").length > maxChars) lines.shift();
  return lines.join("\n").slice(-maxChars);
}

export function capFailures(failures: CiFailure[], maxChars: number = TOTAL_CHARS): CiFailure[] {
  const share = Math.floor(maxChars / Math.max(failures.length, 1));
  return failures.map(f => ({ ...f, tail: trimOldest(f.tail, share) }));
}

export async function fetchCiFailures(checks: FailedCheck[], source: CiSource): Promise<CiFailure[]> {
  const perCheck = await Promise.all(checks.map(check => failuresForCheck(check, source)));
  return capFailures(perCheck.flat());
}

export function formatCiFailures(failures: CiFailure[]): string {
  return failures.map(f => [
    `### Check: ${f.check}${f.task ? ` (failed step: ${f.task})` : ""}`,
    ...f.issues.map(i => `Issue: ${i}`),
    ...(f.error ? [`Logs unavailable: ${f.error}`] : []),
    ...(f.tail ? ["Log tail:", f.tail] : []),
  ].join("\n")).join("\n\n");
}
