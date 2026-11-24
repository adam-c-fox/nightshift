const TOTAL_CHARS = 20_000;
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/;

export interface CiFailure {
  check: string;
  task: string;
  issues: string[];
  tail: string;
  error?: string;
}

export const stripTimestamps = (lines: string[]): string[] => lines.map(l => l.replace(TIMESTAMP_PREFIX, ""));

export const tailLines = (lines: string[], count: number): string[] => lines.slice(-count);

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

export function formatCiFailures(failures: CiFailure[]): string {
  return failures.map(f => [
    `### Check: ${f.check}${f.task ? ` (failed step: ${f.task})` : ""}`,
    ...f.issues.map(i => `Issue: ${i}`),
    ...(f.error ? [`Logs unavailable: ${f.error}`] : []),
    ...(f.tail ? ["Log tail:", f.tail] : []),
  ].join("\n")).join("\n\n");
}
