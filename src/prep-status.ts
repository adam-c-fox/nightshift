import { pathToFileURL } from "node:url";
import { extractFlag } from "./args.js";
import { getEnv, requireEnv, useProjectEnv } from "./env.js";
import { fetchTodoIssues, type TodoIssue } from "./linear.js";
import {
  prepState,
  readPrepStore,
  type PrepStateName,
  type PrepStore,
} from "./prep.js";
import { loadProject } from "./project.js";
import { statePaths } from "./state.js";

export interface PrepStatusLine {
  id: string;
  title: string;
  team: string;
  priority: string;
  estimate: number | null;
  url: string;
  prep: PrepStateName;
  preppedAt?: string;
  blockers?: string;
}

export function prepStatusLines(
  issues: TodoIssue[],
  store: PrepStore,
): PrepStatusLine[] {
  return issues.map((issue) => {
    const { state, preppedAt, blockers } = prepState(
      store[issue.identifier],
      issue,
    );
    return {
      id: issue.identifier,
      title: issue.title,
      team: issue.teamKey,
      priority: issue.priorityLabel,
      estimate: issue.estimate,
      url: issue.url,
      prep: state,
      ...(preppedAt !== undefined ? { preppedAt } : {}),
      ...(blockers !== undefined ? { blockers } : {}),
    };
  });
}

async function main(): Promise<void> {
  try {
    const { value: flagProject } = extractFlag(
      process.argv.slice(2),
      "--project",
    );
    const name = flagProject ?? getEnv("NIGHTSHIFT_PROJECT");
    if (!name) throw new Error("no project selected (use --project <name>)");
    const project = loadProject(name);
    useProjectEnv(project.envFile);
    const issues = await fetchTodoIssues(
      { apiKey: requireEnv("LINEAR_API_KEY") },
      project.linearTeams,
    );
    const store = readPrepStore(statePaths().prep);
    for (const line of prepStatusLines(issues, store)) {
      console.log(JSON.stringify(line));
    }
  } catch (e) {
    console.log(JSON.stringify({ error: (e as Error).message.split("\n")[0] }));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main();
