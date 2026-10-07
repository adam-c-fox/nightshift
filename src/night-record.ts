import { accessSync } from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./state.js";
import type { NightRecord, SessionResult } from "./types.js";

export function nightRecord(
  session: SessionResult,
  startedAt: Date,
  endedAt: Date,
  dryRun: boolean,
): NightRecord {
  return {
    ...session,
    startedAtIso: startedAt.toISOString(),
    endedAtIso: endedAt.toISOString(),
    dryRun,
  };
}

export function nightRecordFile(reportsDir: string, base: string): string {
  return path.join(reportsDir, `${base}.json`);
}

export function writeNightRecord(
  reportsDir: string,
  base: string,
  record: NightRecord,
): string {
  const file = nightRecordFile(reportsDir, base);
  writeJsonAtomic(file, record);
  return file;
}

export function readNightRecord(file: string): NightRecord {
  accessSync(file);
  const record = readJsonFile<Partial<NightRecord> | null>(file, null);
  if (
    !record ||
    !Array.isArray(record.tickets) ||
    typeof record.startedAtIso !== "string"
  ) {
    throw new Error(`${file} is not a night record`);
  }
  return record as NightRecord;
}
