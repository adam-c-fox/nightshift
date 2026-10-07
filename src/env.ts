import { readFileSync } from "node:fs";
import path from "node:path";

const ENV_FILE = path.resolve(import.meta.dirname, "..", ".env");

export function parseEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    const quoted = value.match(/^(["'])(.*)\1/);
    if (quoted) {
      value = quoted[2];
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]] = value;
  }
  return values;
}

function readEnvFile(file: string): Record<string, string> {
  try {
    return parseEnv(readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

let rootFileValues: Record<string, string> | undefined;
let projectFileValues: Record<string, string> = {};

function rootValues(): Record<string, string> {
  rootFileValues ??= readEnvFile(ENV_FILE);
  return rootFileValues;
}

export function useProjectEnv(file: string): void {
  projectFileValues = readEnvFile(file);
}

export function lookupEnv(name: string, layers: Record<string, string | undefined>[]): string | undefined {
  for (const layer of layers) {
    const value = layer[name];
    if (value) return value;
  }
  return undefined;
}

export function getEnv(name: string): string | undefined {
  return lookupEnv(name, [process.env, projectFileValues, rootValues()]);
}

export function requireEnv(name: string): string {
  const value = getEnv(name);
  if (!value) throw new Error(`${name} not found in environment or .env file`);
  return value;
}
