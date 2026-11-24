import type { PrHostDescriptor } from "../../pr-host.js";
import { makeContext } from "./az.js";
import { ciFailures, ciVerdict, openPr, updatePr } from "./checks.js";
import { currentUser, listOpenPrs } from "./prs.js";
import { listThreads, replyToThread, resolveThread } from "./threads.js";

const SSH = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/;
const HTTPS = /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/(?:([^/]+)\/)?_git\/([^/]+)$/;
const LEGACY = /^https:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?(?:([^/]+)\/)?_git\/([^/]+)$/;

function parseRemote(remoteUrl: string): { org: string; project: string } | undefined {
  const url = remoteUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/^ssh:\/\/git@ssh\.dev\.azure\.com\/v3\//, "git@ssh.dev.azure.com:v3/");
  const match = [SSH, HTTPS, LEGACY].map(re => re.exec(url)).find(Boolean);
  return match ? { org: decodeURIComponent(match[1]), project: decodeURIComponent(match[2] ?? match[3]) } : undefined;
}

export const azureDevOps: PrHostDescriptor = {
  create: (lookup, exec) => {
    const ctx = makeContext(lookup, exec);
    return {
      currentUser: () => currentUser(ctx),
      listOpenPrs: repoPath => listOpenPrs(ctx, repoPath),
      openPr: (content, branch, targetBranch, worktreePath, opts) => openPr(ctx, content, branch, targetBranch, worktreePath, opts),
      updatePr: (existing, localBranch, worktreePath, opts) => updatePr(ctx, existing, localBranch, worktreePath, opts),
      ciVerdict: (repoPath, prId) => ciVerdict(ctx, repoPath, prId),
      ciFailures: (repoPath, checks) => ciFailures(ctx, repoPath, checks),
      listThreads: (repoName, prId) => listThreads(ctx, repoName, prId),
      replyToThread: (repoName, prId, threadId, parentCommentId, text) => replyToThread(ctx, repoName, prId, threadId, parentCommentId, text),
      resolveThread: (repoName, prId, threadId) => resolveThread(ctx, repoName, prId, threadId),
    };
  },
  matchesRemote: remoteUrl => parseRemote(remoteUrl) !== undefined,
  envFromRemote: (remoteUrl): Record<string, string> => {
    const parsed = parseRemote(remoteUrl);
    return parsed ? { AZURE_DEVOPS_ORG: parsed.org, AZURE_DEVOPS_PROJECT: parsed.project } : {};
  },
  envKeys: ["AZURE_DEVOPS_ORG", "AZURE_DEVOPS_PROJECT"],
  secretEnvKeys: ["AZURE_DEVOPS_EXT_PAT", "AZURE_DEVOPS_PAT"],
  agentDeniedDomains: ["dev.azure.com", "*.dev.azure.com", "*.visualstudio.com", "vssps.visualstudio.com"],
};
