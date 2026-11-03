import type { RepoConfig } from "./project.js";

const SECRET_NAME = /^(LINEAR_|AZURE_|ARM_)|^(AWS_|TF_TOKEN_)|(_TOKEN|_PAT|_SECRET|_PASSWORD|_API_KEY|_KEY|_CREDENTIALS?|_PASSWD|_authToken)$/i;

export const CLAUDE_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";

export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([name]) => name === CLAUDE_TOKEN || !SECRET_NAME.test(name));
  return { ...Object.fromEntries(kept), ENABLE_CLAUDEAI_MCP_SERVERS: "false", CHECKPOINT_DISABLE: "1" };
}

const DENY_READ = ["~/.ssh", "~/.aws", "~/.azure", "~/.config/gh", "~/.npmrc", "~/.netrc", "~/.git-credentials"];
const ADO_DOMAINS = ["dev.azure.com", "*.dev.azure.com", "*.visualstudio.com", "vssps.visualstudio.com"];

export function buildAgentSettings(
  { network, allowLocalBinding }: Pick<RepoConfig, "network" | "allowLocalBinding">, nightshiftRoot: string, { readLogs = false, secretFiles = [] }: { readLogs?: boolean; secretFiles?: string[] } = {},
): string {
  const deniedFiles = [`${nightshiftRoot}/.env`, ...secretFiles, ...(readLogs ? [] : [`${nightshiftRoot}/logs`])];
  const denyRead = [...deniedFiles, ...DENY_READ];
  return JSON.stringify({
    permissions: {
      deny: [
        ...deniedFiles.map(f => `Read(/${f})`),
        ...(readLogs ? [] : [`Read(/${nightshiftRoot}/logs/**)`]),
        "WebFetch", "WebSearch", "mcp__claude_ai_Linear", "mcp__claude_ai_Notion",
      ],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead },
      network: {
        strictAllowlist: true, allowedDomains: network, deniedDomains: ADO_DOMAINS,
        ...(allowLocalBinding ? { allowLocalBinding: true } : {}),
      },
    },
  });
}
