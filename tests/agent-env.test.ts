import { describe, expect, it } from "vitest";
import { agentEnv, buildAgentSettings } from "../src/agent-env.js";

describe("agentEnv", () => {
  it("keeps the Claude OAuth token so the agent can log in", () => {
    expect(agentEnv({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "t" })).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
  });

  it("strips nightshift, cloud and generic secrets, keeps the basics", () => {
    const env = agentEnv({
      PATH: "/bin", HOME: "/h", TF_IN_AUTOMATION: "1",
      LINEAR_API_KEY: "x", AZURE_DEVOPS_EXT_PAT: "x", AZURE_DEVOPS_PAT: "x",
      GITHUB_TOKEN: "x", NPM_TOKEN: "x", SOME_SECRET: "x", OPENAI_API_KEY: "x",
      ARM_CLIENT_SECRET: "x", ARM_SUBSCRIPTION_ID: "sub", AZURE_CLIENT_ID: "x",
      ANTHROPIC_API_KEY: "x",
    });
    expect(env).toEqual({
      PATH: "/bin", HOME: "/h", TF_IN_AUTOMATION: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false", CHECKPOINT_DISABLE: "1",
    });
  });

  it("strips credential-shaped names and keeps harmless ones", () => {
    const env = agentEnv({
      AWS_SECRET_ACCESS_KEY: "x", TF_TOKEN_app_terraform_io: "x", GOOGLE_APPLICATION_CREDENTIALS: "x",
      DEPLOY_KEY: "x", npm_config__authToken: "x",
      SSH_AUTH_SOCK: "s", TMPDIR: "/t", PWD: "/p", NODE_OPTIONS: "--x", npm_config_cache: "/c",
    });
    expect(env).toEqual({
      SSH_AUTH_SOCK: "s", TMPDIR: "/t", PWD: "/p", NODE_OPTIONS: "--x", npm_config_cache: "/c",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false", CHECKPOINT_DISABLE: "1",
    });
  });
});

describe("buildAgentSettings", () => {
  const root = "/Users/adam/Developer/nightshift";

  it("enforces the sandbox with no unsandboxed escape", () => {
    const s = JSON.parse(buildAgentSettings("main", root));
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(s.sandbox.network.strictAllowlist).toBe(true);
  });

  it("blocks reading nightshift's .env from Bash and the Read tool", () => {
    const s = JSON.parse(buildAgentSettings("main", root));
    expect(s.sandbox.filesystem.denyRead).toContain(`${root}/.env`);
    expect(s.permissions.deny).toContain(`Read(/${root}/.env)`);
  });

  it("blocks reading nightshift's logs", () => {
    const s = JSON.parse(buildAgentSettings("main", root));
    expect(s.sandbox.filesystem.denyRead).toContain(`${root}/logs`);
    expect(s.permissions.deny).toEqual(expect.arrayContaining([`Read(/${root}/logs)`, `Read(/${root}/logs/**)`]));
  });

  it("denies web and connector tools that run outside the sandbox", () => {
    const s = JSON.parse(buildAgentSettings("main", root));
    expect(s.permissions.deny).toEqual(expect.arrayContaining([
      "WebFetch", "WebSearch", "mcp__claude_ai_Linear", "mcp__claude_ai_Notion",
    ]));
  });

  it("never lets the agent reach Azure DevOps", () => {
    for (const repo of ["main", "terraform"] as const) {
      const s = JSON.parse(buildAgentSettings(repo, root));
      expect(s.sandbox.network.allowedDomains).not.toContain("dev.azure.com");
      expect(s.sandbox.network.deniedDomains).toEqual(expect.arrayContaining(["dev.azure.com", "*.visualstudio.com"]));
    }
  });

  it("gives neither repo kind Azure credentials or Azure network access", () => {
    for (const repo of ["main", "terraform"] as const) {
      const s = JSON.parse(buildAgentSettings(repo, root));
      expect(s.sandbox.filesystem.denyRead).toContain("~/.azure");
      expect(s.sandbox.network.allowedDomains.join()).not.toMatch(/azure|microsoftonline|windows\.net/);
    }
  });

  it("lets terraform runs reach only the provider registry", () => {
    const tf = JSON.parse(buildAgentSettings("terraform", root));
    expect(tf.sandbox.network.allowedDomains).toEqual(["registry.terraform.io", "releases.hashicorp.com"]);
  });
});
