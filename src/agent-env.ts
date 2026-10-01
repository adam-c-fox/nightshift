import type { RepoKind } from "./types.js";

const SECRET_NAME = /^(LINEAR_|AZURE_|ARM_)|(_TOKEN|_PAT|_SECRET|_PASSWORD|_API_KEY)$/i;

export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAME.test(name)));
}

const DENY_READ = ["~/.ssh", "~/.aws", "~/.azure", "~/.config/gh", "~/.npmrc", "~/.netrc", "~/.git-credentials"];
const ADO_DOMAINS = ["dev.azure.com", "*.dev.azure.com", "*.visualstudio.com", "vssps.visualstudio.com"];
const ALLOWED_DOMAINS: Record<RepoKind, string[]> = {
  main: ["registry.npmjs.org"],
  terraform: ["registry.terraform.io", "releases.hashicorp.com"],
};

export function buildAgentSettings(repo: RepoKind, nightshiftRoot: string): string {
  const secretFiles = [`${nightshiftRoot}/.env`, `${nightshiftRoot}/logs`];
  const denyRead = [...secretFiles, ...DENY_READ];
  return JSON.stringify({
    permissions: {
      deny: [...secretFiles.map(f => `Read(/${f})`), `Read(/${nightshiftRoot}/logs/**)`],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead },
      network: { strictAllowlist: true, allowedDomains: ALLOWED_DOMAINS[repo], deniedDomains: ADO_DOMAINS },
    },
  });
}
