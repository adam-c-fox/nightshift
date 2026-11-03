import { isValidPercent } from "./project.js";

export interface RunArgs {
  dryRun: boolean;
  allowancePercent?: number;
}

export const RUN_USAGE = "usage: run [--dry-run] [--allowance <1-100>]";

export function extractFlag(argv: string[], flag: string): { value: string | undefined; rest: string[] } {
  const i = argv.indexOf(flag);
  if (i === -1) return { value: undefined, rest: argv };
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return { value, rest: [...argv.slice(0, i), ...argv.slice(i + 2)] };
}

function parseAllowance(token: string): number {
  const percent = Number(token);
  if (!/^\d+$/.test(token) || !isValidPercent(percent)) {
    throw new Error(`--allowance must be a whole number from 1 to 100, got "${token}"`);
  }
  return percent;
}

export function parseRunArgs(argv: string[]): RunArgs {
  if (argv.includes("--project")) throw new Error("--project was removed: a night runs every project");
  const { value: allowance, rest } = extractFlag(argv, "--allowance");
  const unknown = rest.find((arg) => arg !== "--dry-run");
  if (unknown !== undefined) throw new Error(`unknown argument "${unknown}"\n${RUN_USAGE}`);
  return {
    dryRun: rest.includes("--dry-run"),
    ...(allowance !== undefined ? { allowancePercent: parseAllowance(allowance) } : {}),
  };
}
