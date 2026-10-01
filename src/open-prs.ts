import { pathToFileURL } from "node:url";
import { REPOS } from "./repos.js";
import { findOpenNightPr } from "./pr.js";
import type { RepoKind } from "./types.js";

export function parseOpenPrsArgs(args: string[]): { repo: RepoKind; id: string }[] {
  if (args.length === 0) throw new Error("usage: open-prs <repo>:<ID> ...");
  return args.map(arg => {
    const match = arg.match(/^(main|terraform):([A-Z]+-\d+)$/);
    if (!match) throw new Error(`bad argument "${arg}", expected main:<ID> or terraform:<ID>`);
    return { repo: match[1] as RepoKind, id: match[2] };
  });
}

function lookup(repo: RepoKind, id: string): object {
  try {
    const repoPath = REPOS[repo];
    if (!repoPath) return { id, error: `unknown repo ${repo}` };
    const pr = findOpenNightPr(id, repoPath);
    return { id, repo, pr: pr?.prId ?? null, branch: pr?.sourceBranch ?? null };
  } catch (e) {
    const firstLine = ((e as Error).message ?? String(e)).split("\n")[0];
    return { id, error: firstLine };
  }
}

function main() {
  let targets;
  try {
    targets = parseOpenPrsArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  for (const { repo, id } of targets) console.log(JSON.stringify(lookup(repo, id)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
