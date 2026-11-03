import { pathToFileURL } from "node:url";
import { extractFlag } from "./args.js";
import { requireEnv } from "./env.js";
import { fetchTodoIssues, type TodoIssue } from "./linear.js";
import {
  prepState,
  readPrepStore,
  type PrepStateName,
  type PrepStore,
} from "./prep.js";
import { loadAllProjects, projectForLinearProject, type Project } from "./project.js";
import { statePaths } from "./state.js";

export interface PrepStatusLine {
  id: string;
  project: string;
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
  projects: Pick<Project, "name" | "linearProjects">[],
): PrepStatusLine[] {
  return issues.flatMap((issue) => {
    const project = projectForLinearProject(projects, issue.projectName);
    if (project === undefined) return [];
    const { state, preppedAt, blockers } = prepState(
      store[issue.identifier],
      issue,
    );
    return [{
      id: issue.identifier,
      project,
      title: issue.title,
      team: issue.teamKey,
      priority: issue.priorityLabel,
      estimate: issue.estimate,
      url: issue.url,
      prep: state,
      ...(preppedAt !== undefined ? { preppedAt } : {}),
      ...(blockers !== undefined ? { blockers } : {}),
    }];
  });
}

async function main(): Promise<void> {
  try {
    const { value: flagProject } = extractFlag(
      process.argv.slice(2),
      "--project",
    );
    const projects = loadAllProjects();
    if (flagProject !== undefined && !projects.some((p) => p.name === flagProject)) {
      throw new Error(`unknown project "${flagProject}"`);
    }
    const issues = await fetchTodoIssues({ apiKey: requireEnv("LINEAR_API_KEY") });
    const store = readPrepStore(statePaths().prep);
    const lines = prepStatusLines(issues, store, projects);
    for (const line of lines.filter((l) => flagProject === undefined || l.project === flagProject)) {
      console.log(JSON.stringify(line));
    }
  } catch (e) {
    console.log(JSON.stringify({ error: (e as Error).message.split("\n")[0] }));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main();
