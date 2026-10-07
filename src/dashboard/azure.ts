import {
  ORIGIN_URL_ARGS,
  azEnvFrom,
  orgUrl,
  parseAzOutput,
  policyListArgs,
  prListArgs,
  repoNameFromRemote,
  summarizePolicies,
  type AzPullRequest,
  type PolicyEvaluation,
  type PolicyVerdict,
} from "../pr.js";
import type { Exec } from "./exec.js";

const AZ_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 15_000;
const JSON_OUTPUT = ["--output", "json"];

export interface AzProject {
  org: string;
  project: string;
  env: NodeJS.ProcessEnv;
}

export function azProjectFrom(
  lookup: (name: string) => string | undefined,
): AzProject {
  const org = lookup("AZURE_DEVOPS_ORG");
  if (!org) throw new Error("AZURE_DEVOPS_ORG is not set");
  const project = lookup("AZURE_DEVOPS_PROJECT");
  if (!project) throw new Error("AZURE_DEVOPS_PROJECT is not set");
  return { org: orgUrl(org), project, env: azEnvFrom(lookup) };
}

async function azJson(
  exec: Exec,
  az: AzProject,
  args: string[],
): Promise<unknown> {
  const { stdout } = await exec("az", [...args, ...JSON_OUTPUT], {
    env: az.env,
    timeoutMs: AZ_TIMEOUT_MS,
  });
  return parseAzOutput(stdout);
}

export interface ActivePrList {
  repoName: string;
  prs: AzPullRequest[];
}

export async function listActivePrs(
  exec: Exec,
  az: AzProject,
  repoPath: string,
): Promise<ActivePrList> {
  const origin = await exec("git", ORIGIN_URL_ARGS, {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const repoName = repoNameFromRemote(origin.stdout);
  const prs = ((await azJson(
    exec,
    az,
    prListArgs(az.org, az.project, repoName),
  )) ?? []) as AzPullRequest[];
  return { repoName, prs };
}

export async function prCiVerdict(
  exec: Exec,
  az: AzProject,
  prId: number,
): Promise<PolicyVerdict> {
  const evaluations = ((await azJson(exec, az, policyListArgs(prId, az.org))) ??
    []) as PolicyEvaluation[];
  return summarizePolicies(evaluations);
}

export async function azLoginStatus(
  exec: Exec,
): Promise<{ ok: boolean; reason: string }> {
  try {
    const { stdout } = await exec("az", ["account", "show", ...JSON_OUTPUT], {
      timeoutMs: LOGIN_TIMEOUT_MS,
    });
    const account = parseAzOutput(stdout) as {
      user?: { name?: string };
    } | null;
    return {
      ok: true,
      reason: `logged in as ${account?.user?.name ?? "unknown user"}`,
    };
  } catch (e) {
    const code = (e as { code?: string | number }).code;
    if (code === "ENOENT") return { ok: false, reason: "az CLI not found" };
    return { ok: false, reason: "not logged in to az; run az login" };
  }
}
