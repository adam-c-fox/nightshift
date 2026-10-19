import { pathToFileURL } from "node:url";
import { extractFlag } from "./args.js";
import { DASHBOARD_ORIGIN } from "./dashboard/address.js";
import { useProjectEnv } from "./env.js";
import { fetchTicket } from "./linear.js";
import { descriptionHash, upsertPrepRecord, type PrepRecord } from "./prep.js";
import { loadProject } from "./project.js";
import { statePaths } from "./state.js";
import { TICKET_ID } from "./tickets.js";

export interface PrepMarkArgs {
  id: string;
  project: string;
  repo?: string;
  notReady?: string;
}

export const PREP_MARK_USAGE =
  'usage: prep-mark <ID> --project <name> [--repo <repo>] [--not-ready "<blockers>"]';

export function parsePrepMarkArgs(argv: string[]): PrepMarkArgs {
  const { value: project, rest: afterProject } = extractFlag(argv, "--project");
  const { value: repo, rest: afterRepo } = extractFlag(afterProject, "--repo");
  const { value: notReady, rest } = extractFlag(afterRepo, "--not-ready");
  const [id, ...extra] = rest;
  if (id === undefined || !TICKET_ID.test(id)) {
    throw new Error(`expected a ticket ID like ENG-123\n${PREP_MARK_USAGE}`);
  }
  if (extra.length > 0) {
    throw new Error(`unknown argument "${extra[0]}"\n${PREP_MARK_USAGE}`);
  }
  if (project === undefined) {
    throw new Error(`--project is required\n${PREP_MARK_USAGE}`);
  }
  if (notReady === "") throw new Error("--not-ready needs the blockers text");
  return {
    id,
    project,
    ...(repo !== undefined ? { repo } : {}),
    ...(notReady !== undefined ? { notReady } : {}),
  };
}

export function buildPrepRecord(
  args: PrepMarkArgs,
  description: string,
  now: Date,
): PrepRecord {
  return {
    project: args.project,
    ...(args.repo !== undefined ? { repo: args.repo } : {}),
    preppedAt: now.toISOString(),
    descHash: descriptionHash(description),
    outcome: args.notReady !== undefined ? "not_ready" : "ready",
    ...(args.notReady !== undefined ? { blockers: args.notReady } : {}),
  };
}

export async function refreshDashboard(
  fetchFn: typeof fetch = fetch,
  origin: string = DASHBOARD_ORIGIN,
): Promise<void> {
  try {
    await fetchFn(`${origin}/api/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nightshift": "1" },
      body: JSON.stringify({ what: "linear" }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    return;
  }
}

async function main(): Promise<void> {
  try {
    const args = parsePrepMarkArgs(process.argv.slice(2));
    const project = loadProject(args.project);
    if (args.repo !== undefined && !(args.repo in project.repos)) {
      throw new Error(
        `unknown repo "${args.repo}" (known: ${Object.keys(project.repos).join(", ")})`,
      );
    }
    useProjectEnv(project.envFile);
    const linear = await fetchTicket(args.id);
    if (!linear) throw new Error(`ticket ${args.id} not found in Linear`);
    const record = buildPrepRecord(args, linear.description, new Date());
    upsertPrepRecord(statePaths().prep, args.id, record);
    await refreshDashboard();
    console.log(
      JSON.stringify({
        id: args.id,
        outcome: record.outcome,
        descHash: record.descHash,
        preppedAt: record.preppedAt,
      }),
    );
  } catch (e) {
    console.log(JSON.stringify({ error: (e as Error).message.split("\n")[0] }));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main();
