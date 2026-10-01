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

let fileValues: Record<string, string> | undefined;

function loadFileValues(): Record<string, string> {
  if (fileValues) return fileValues;
  try {
    fileValues = parseEnv(readFileSync(ENV_FILE, "utf-8"));
  } catch {
    fileValues = {};
  }
  return fileValues;
}

export function getEnv(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  return loadFileValues()[name] || undefined;
}

export function requireEnv(name: string): string {
  const value = getEnv(name);
  if (!value) throw new Error(`${name} not found in environment or .env file`);
  return value;
}
