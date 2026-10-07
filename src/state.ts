import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

export interface StatePaths {
  prep: string;
  actions: string;
}

export function statePaths(root: string = ROOT): StatePaths {
  return {
    prep: path.join(root, "state", "prep.json"),
    actions: path.join(root, "state", "actions.json"),
  };
}

export function readJsonFile<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2) + "\n");
  renameSync(temp, file);
}
