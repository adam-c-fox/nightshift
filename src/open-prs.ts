import { pathToFileURL } from "node:url";
import { extractFlag } from "./args.js";
import { getEnv, useProjectEnv } from "./env.js";
import { listProjects, type Project, loadProject, REPO_NAME_PATTERN } from "./project.js";
import { fetchTicket } from "./linear.js";
import { findOpenTicketPr } from "./pr.js";
import { ticketBranchName } from "./worktree.js";

const TARGET = new RegExp(`^(${REPO_NAME_PATTERN}):([A-Z]+-\\d+)$`, "i");

export function parseOpenPrsArgs(args: string[]): { repo: string; id: string }[] {
  if (args.length === 0) throw new Error("usage: open-prs <repo>:<ID> ...");
  return args.map(arg => {
    const match = arg.match(TARGET);
    if (!match) throw new Error(`bad argument "${arg}", expected <repo>:<ID>`);
    return { repo: match[1].toLowerCase(), id: match[2] };
  });
}

async function lookup(project: Project, repo: string, id: string): Promise<object> {
  try {
    const repoPath = project.repos[repo]?.path;
    if (!repoPath) return { id, error: `unknown repo ${repo}` };
    const linear = await fetchTicket(id);
    if (!linear) return { id, error: `ticket ${id} not found in Linear` };
    const pr = findOpenTicketPr(ticketBranchName(getEnv("BRANCH_PREFIX"), id, linear.name), repoPath);
    return { id, repo, pr: pr?.prId ?? null, branch: pr?.sourceBranch ?? null, ...(pr?.autoComplete ? { autoComplete: true } : {}) };
  } catch (e) {
    const firstLine = ((e as Error).message ?? String(e)).split("\n")[0];
    return { id, error: firstLine };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let flagged;
  try {
    flagged = extractFlag(argv, "--project");
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const projectName = flagged.value ?? getEnv("NIGHTSHIFT_PROJECT");
  if (!projectName) {
    console.error(`no project selected (available: ${listProjects().join(", ")})`);
    process.exit(1);
  }
  let project;
  try {
    project = loadProject(projectName);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  useProjectEnv(project.envFile);
  let targets;
  try {
    targets = parseOpenPrsArgs(flagged.rest);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  for (const { repo, id } of targets) console.log(JSON.stringify(await lookup(project, repo, id)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
