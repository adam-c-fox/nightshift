import type { Exec } from "../../exec.js";
import type { EnvLookup } from "../../pr-host.js";

const AZ_TIMEOUT_MS = 60_000;

export interface AzContext {
  lookup: EnvLookup;
  exec: Exec;
  env: NodeJS.ProcessEnv;
}

export function orgUrl(org: string): string {
  const trimmed = org.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://dev.azure.com/${trimmed}`;
}

export function azEnvFrom(lookup: EnvLookup): NodeJS.ProcessEnv {
  const pat = lookup("AZURE_DEVOPS_EXT_PAT") ?? lookup("AZURE_DEVOPS_PAT");
  return pat ? { ...process.env, AZURE_DEVOPS_EXT_PAT: pat } : process.env;
}

export function parseAzOutput(out: string): unknown {
  return out.trim() === "" ? null : JSON.parse(out);
}

export const makeContext = (lookup: EnvLookup, exec: Exec): AzContext => ({ lookup, exec, env: azEnvFrom(lookup) });

function required(ctx: AzContext, name: string): string {
  const value = ctx.lookup(name);
  if (!value) throw new Error(`${name} not found in environment or .env file`);
  return value;
}

export const azOrg = (ctx: AzContext): string => orgUrl(required(ctx, "AZURE_DEVOPS_ORG"));
export const azProject = (ctx: AzContext): string => required(ctx, "AZURE_DEVOPS_PROJECT");

const GIT_TIMEOUT_MS = 15_000;

export function repoNameFromRemote(remoteUrl: string): string {
  const last = remoteUrl.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

export async function repoNameAt(ctx: AzContext, repoPath: string): Promise<string> {
  const { stdout } = await ctx.exec("git", ["remote", "get-url", "origin"], { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS });
  return repoNameFromRemote(stdout);
}

export const prWebUrl = (ctx: AzContext, repoName: string, prId: number): string =>
  `${azOrg(ctx)}/${encodeURIComponent(azProject(ctx))}/_git/${encodeURIComponent(repoName)}/pullrequest/${prId}`;

export async function azJson(ctx: AzContext, args: string[], cwd?: string): Promise<unknown> {
  const { stdout } = await ctx.exec("az", [...args, "--output", "json"], { env: ctx.env, timeoutMs: AZ_TIMEOUT_MS, cwd });
  return parseAzOutput(stdout);
}
