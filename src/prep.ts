import { createHash } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "./state.js";

export type PrepOutcome = "ready" | "not_ready";

export interface PrepRecord {
  project: string;
  repo?: string;
  preppedAt: string;
  descHash: string;
  outcome: PrepOutcome;
  blockers?: string;
}

export type PrepStore = Record<string, PrepRecord>;

export type PrepStateName =
  "fresh" | "stale" | "new_comments" | "not_ready" | "inferred" | "none";

export interface PrepState {
  state: PrepStateName;
  preppedAt?: string;
  blockers?: string;
}

export const PREP_STATE_LABELS: Record<PrepStateName, string> = {
  fresh: "fresh",
  stale: "stale",
  new_comments: "new comments",
  not_ready: "not ready",
  inferred: "inferred",
  none: "none",
};

export interface PrepSections {
  acceptanceCriteria: string[];
  decisions: string[];
  pointers: string[];
}

const SECTION_HEADINGS: Record<keyof PrepSections, string> = {
  acceptanceCriteria: "Acceptance criteria",
  decisions: "Decisions",
  pointers: "Pointers",
};

export const PREP_SECTIONS = new RegExp(
  `^##\\s+(${Object.values(SECTION_HEADINGS).join("|")})\\s*$`,
  "im",
);

function sectionBlock(key: keyof PrepSections, items: string[]): string[] {
  const bullet = key === "acceptanceCriteria" ? "- [ ] " : "- ";
  return [`## ${SECTION_HEADINGS[key]}`, ...items.map((item) => bullet + item)];
}

export function mergePrepSections(
  description: string,
  sections: PrepSections,
): string {
  let lines = description.split("\n");
  const appended: string[][] = [];
  for (const key of Object.keys(SECTION_HEADINGS) as (keyof PrepSections)[]) {
    if (sections[key].length === 0) continue;
    const block = sectionBlock(key, sections[key]);
    const start = lines.findIndex(
      (line) =>
        PREP_SECTIONS.exec(line)?.[1].toLowerCase() ===
        SECTION_HEADINGS[key].toLowerCase(),
    );
    if (start === -1) {
      appended.push(block);
      continue;
    }
    let end = lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line));
    if (end === -1) end = lines.length;
    let trailing = end;
    while (trailing > start + 1 && lines[trailing - 1].trim() === "") trailing--;
    lines = [...lines.slice(0, start), ...block, ...lines.slice(trailing)];
  }
  let out = lines.join("\n");
  for (const block of appended) {
    const gap = out === "" || out.endsWith("\n\n") ? "" : out.endsWith("\n") ? "\n" : "\n\n";
    out += gap + block.join("\n");
  }
  return out;
}

export function descriptionHash(description: string): string {
  return createHash("sha256").update(description).digest("hex");
}

export function readPrepStore(file: string): PrepStore {
  return readJsonFile<PrepStore>(file, {});
}

export function upsertPrepRecord(
  file: string,
  id: string,
  record: PrepRecord,
): void {
  const store = readPrepStore(file);
  store[id] = record;
  writeJsonAtomic(file, store);
}

export function prepState(
  record: PrepRecord | undefined,
  issue: { description: string; commentCreatedAt: string[] },
): PrepState {
  if (!record)
    return {
      state: PREP_SECTIONS.test(issue.description) ? "inferred" : "none",
    };
  const { preppedAt } = record;
  if (record.descHash !== descriptionHash(issue.description))
    return { state: "stale", preppedAt };
  if (record.outcome === "not_ready")
    return { state: "not_ready", preppedAt, blockers: record.blockers };
  const preppedMs = Date.parse(preppedAt);
  const hasNewComment = issue.commentCreatedAt.some(
    (at) => Date.parse(at) > preppedMs,
  );
  return { state: hasNewComment ? "new_comments" : "fresh", preppedAt };
}
