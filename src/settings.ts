import type { Effort } from "./claude.js";
import { wholePercent } from "./budget.js";
import { ROOT_ENV_FILE, envLookup } from "./env.js";

export type CodexEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface RuntimeSettings {
  claudeEffort: Effort;
  reviewModel: string;
  dedupeModel: string;
  implementationModel?: string;
  usageProbeModel: string;
  codexModel: string;
  codexEffort: CodexEffort;
  codexAllowancePercent: number;
  timeZone: string;
}

export const DEFAULT_SETTINGS: RuntimeSettings = {
  claudeEffort: "high",
  reviewModel: "claude-opus-5-5",
  dedupeModel: "claude-sonnet-5-5",
  usageProbeModel: "claude-haiku-4-5-20251001",
  codexModel: "gpt-6.1-sol",
  codexEffort: "high",
  codexAllowancePercent: 20,
  timeZone: "America/Vancouver",
};

type Lookup = (name: string) => string | undefined;

const CLAUDE_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS: readonly CodexEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

function setting(lookup: Lookup, name: string): string | undefined {
  return lookup(name) || undefined;
}

function oneOf<T extends string>(lookup: Lookup, name: string, allowed: readonly T[], fallback: T): T {
  const raw = setting(lookup, name);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  }
  return raw as T;
}

function modelName(lookup: Lookup, name: string, example: string): string | undefined {
  const raw = setting(lookup, name);
  if (raw !== undefined && !MODEL_NAME.test(raw)) {
    throw new Error(`${name} must be a model name like "${example}", got "${raw}"`);
  }
  return raw;
}

function timeZone(lookup: Lookup, fallback: string): string {
  const raw = setting(lookup, "NIGHTSHIFT_TIME_ZONE");
  if (raw === undefined) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
  } catch {
    throw new Error(`NIGHTSHIFT_TIME_ZONE must be an IANA time zone like "${fallback}", got "${raw}"`);
  }
  return raw;
}

export function loadSettings(lookup: Lookup): RuntimeSettings {
  const d = DEFAULT_SETTINGS;
  const settings: RuntimeSettings = {
    claudeEffort: oneOf(lookup, "CLAUDE_EFFORT", CLAUDE_EFFORTS, d.claudeEffort),
    reviewModel: modelName(lookup, "REVIEW_MODEL", d.reviewModel) ?? d.reviewModel,
    dedupeModel: modelName(lookup, "DEDUPE_MODEL", d.dedupeModel) ?? d.dedupeModel,
    usageProbeModel: modelName(lookup, "USAGE_PROBE_MODEL", d.usageProbeModel) ?? d.usageProbeModel,
    codexModel: modelName(lookup, "CODEX_MODEL", d.codexModel) ?? d.codexModel,
    codexEffort: oneOf(lookup, "CODEX_EFFORT", CODEX_EFFORTS, d.codexEffort),
    codexAllowancePercent: wholePercent(lookup, "CODEX_ALLOWANCE_PERCENT", d.codexAllowancePercent),
    timeZone: timeZone(lookup, d.timeZone),
  };
  const implementationModel = modelName(lookup, "IMPLEMENTATION_MODEL", d.reviewModel);
  if (implementationModel !== undefined) settings.implementationModel = implementationModel;
  return settings;
}

let cached: RuntimeSettings | undefined;

export function runtimeSettings(): RuntimeSettings {
  cached ??= loadSettings(envLookup([ROOT_ENV_FILE]));
  return cached;
}
