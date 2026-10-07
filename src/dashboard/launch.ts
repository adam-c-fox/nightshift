import { PROJECT_NAME } from "../project.js";
import { TICKET_ID } from "../tickets.js";
import { ExecError, type Exec } from "./exec.js";

export type LaunchRequest =
  | { kind: "prep"; id: string; project: string }
  | { kind: "tonight"; project: string };

export type LaunchResult =
  | {
      launched: true;
      workspaceId: string;
      paneId: string;
      agent: string;
      command: string;
    }
  | { launched: false; command: string; reason: string };

export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

const STATUS_TIMEOUT_MS = 5_000;
const CREATE_TIMEOUT_MS = 15_000;
const AGENT_START_TIMEOUT_MS = 75_000;
const AGENT_READY_TIMEOUT_MS = 60_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function assertShape(body: unknown): LaunchRequest {
  const { kind, id, project } = asRecord(body);
  if (kind !== "prep" && kind !== "tonight") {
    throw new Error("kind must be prep or tonight");
  }
  if (kind === "prep" && (typeof id !== "string" || !TICKET_ID.test(id))) {
    throw new Error("invalid ticket ID");
  }
  if (typeof project !== "string" || !PROJECT_NAME.test(project)) {
    throw new Error("unknown project");
  }
  return kind === "prep"
    ? { kind, id: id as string, project }
    : { kind, project };
}

export function parseLaunchRequest(
  body: unknown,
  projects: string[],
): LaunchRequest {
  const req = assertShape(body);
  if (!projects.includes(req.project)) throw new Error("unknown project");
  return req;
}

export function skillPrompt(req: LaunchRequest): string {
  return req.kind === "prep"
    ? `/prep ${req.id} ${req.project}`
    : `/tonight ${req.project}`;
}

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function fallbackCommand(req: LaunchRequest, root: string): string {
  return `cd ${shellQuote(root)} && claude ${shellQuote(skillPrompt(req))}`;
}

export function workspaceLabel(req: LaunchRequest): string {
  return req.kind === "prep" ? `prep ${req.id}` : `tonight ${req.project}`;
}

export function agentName(req: LaunchRequest, suffix: string): string {
  const subject = req.kind === "prep" ? req.id : req.project;
  const base = `${req.kind}-${subject}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
  const tail = `-${suffix.toLowerCase()}`;
  return `${base.slice(0, 32 - tail.length).replace(/-+$/, "")}${tail}`;
}

export function herdrRunning(statusJson: string): boolean {
  try {
    return asRecord(asRecord(JSON.parse(statusJson)).server).running === true;
  } catch {
    return false;
  }
}

export function workspaceCreateArgs(
  req: LaunchRequest,
  root: string,
): string[] {
  return [
    "workspace",
    "create",
    "--cwd",
    root,
    "--label",
    workspaceLabel(req),
    "--focus",
  ];
}

export function parseWorkspaceCreate(stdout: string): {
  workspaceId: string;
  paneId: string;
} {
  let result: Record<string, unknown>;
  try {
    result = asRecord(asRecord(JSON.parse(stdout)).result);
  } catch {
    throw new Error("herdr returned no workspace");
  }
  const workspaceId = asRecord(result.workspace).workspace_id;
  if (typeof workspaceId !== "string") {
    throw new Error("herdr returned no workspace id");
  }
  const paneId = asRecord(result.root_pane).pane_id;
  if (typeof paneId !== "string") {
    throw new Error("herdr returned no root pane id");
  }
  return { workspaceId, paneId };
}

export function agentStartArgs(
  name: string,
  paneId: string,
  prompt: string,
): string[] {
  return [
    "agent",
    "start",
    name,
    "--kind",
    "claude",
    "--pane",
    paneId,
    "--timeout",
    String(AGENT_READY_TIMEOUT_MS),
    "--",
    prompt,
  ];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function launch(
  req: LaunchRequest,
  deps: { exec: Exec; root: string; suffix: () => string },
): Promise<LaunchResult> {
  const valid = assertShape(req);
  const { exec, root } = deps;
  const command = fallbackCommand(valid, root);
  const fail = (reason: string): LaunchResult => ({
    launched: false,
    command,
    reason,
  });

  let statusJson: string;
  try {
    ({ stdout: statusJson } = await exec("herdr", ["status", "--json"], {
      timeoutMs: STATUS_TIMEOUT_MS,
    }));
  } catch (error) {
    if (error instanceof ExecError && error.code === "ENOENT") {
      return fail("herdr not found");
    }
    return fail(`herdr status failed: ${messageOf(error)}`);
  }
  if (!herdrRunning(statusJson)) return fail("herdr server isn't running");

  let workspace: { workspaceId: string; paneId: string };
  try {
    const created = await exec("herdr", workspaceCreateArgs(valid, root), {
      timeoutMs: CREATE_TIMEOUT_MS,
    });
    workspace = parseWorkspaceCreate(created.stdout);
  } catch (error) {
    return fail(`couldn't create a herdr workspace: ${messageOf(error)}`);
  }

  const agent = agentName(valid, deps.suffix());
  try {
    await exec(
      "herdr",
      agentStartArgs(agent, workspace.paneId, skillPrompt(valid)),
      { timeoutMs: AGENT_START_TIMEOUT_MS },
    );
  } catch (error) {
    return fail(
      `claude didn't start in herdr workspace ${workspace.workspaceId}: ${messageOf(error)}`,
    );
  }
  return { launched: true, ...workspace, agent, command };
}
