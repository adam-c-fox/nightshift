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

  it("keeps TEST_DATABASE_URL so the checks and agents can reach the test database", () => {
    const url = "postgresql://nightshift_example:nightshift_example@127.0.0.1:55433/nightshift_example_test";
    expect(agentEnv({ TEST_DATABASE_URL: url })).toMatchObject({ TEST_DATABASE_URL: url });
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
    const s = JSON.parse(buildAgentSettings("node", root));
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(s.sandbox.network.strictAllowlist).toBe(true);
  });

  it("blocks reading nightshift's .env from Bash and the Read tool", () => {
    const s = JSON.parse(buildAgentSettings("node", root));
    expect(s.sandbox.filesystem.denyRead).toContain(`${root}/.env`);
    expect(s.permissions.deny).toContain(`Read(/${root}/.env)`);
  });

  it("blocks reading nightshift's logs", () => {
    const s = JSON.parse(buildAgentSettings("node", root));
    expect(s.sandbox.filesystem.denyRead).toContain(`${root}/logs`);
    expect(s.permissions.deny).toEqual(expect.arrayContaining([`Read(/${root}/logs)`, `Read(/${root}/logs/**)`]));
  });

  it("lets the postmortem read logs but still not .env", () => {
    const s = JSON.parse(buildAgentSettings("node", root, { readLogs: true }));
    expect(s.sandbox.filesystem.denyRead).not.toContain(`${root}/logs`);
    expect(s.permissions.deny).not.toContain(`Read(/${root}/logs/**)`);
    expect(s.sandbox.filesystem.denyRead).toContain(`${root}/.env`);
    expect(s.permissions.deny).toContain(`Read(/${root}/.env)`);
  });

  it("denies web and connector tools that run outside the sandbox", () => {
    const s = JSON.parse(buildAgentSettings("node", root));
    expect(s.permissions.deny).toEqual(expect.arrayContaining([
      "WebFetch", "WebSearch", "mcp__claude_ai_Linear", "mcp__claude_ai_Notion",
    ]));
  });

  it("never lets the agent reach Azure DevOps", () => {
    for (const toolchain of ["node", "terraform"] as const) {
      const s = JSON.parse(buildAgentSettings(toolchain, root));
      expect(s.sandbox.network.allowedDomains).not.toContain("dev.azure.com");
      expect(s.sandbox.network.deniedDomains).toEqual(expect.arrayContaining(["dev.azure.com", "*.visualstudio.com"]));
    }
  });

  it("gives neither toolchain Azure credentials or Azure network access", () => {
    for (const toolchain of ["node", "terraform"] as const) {
      const s = JSON.parse(buildAgentSettings(toolchain, root));
      expect(s.sandbox.filesystem.denyRead).toContain("~/.azure");
      expect(s.sandbox.network.allowedDomains.join()).not.toMatch(/azure|microsoftonline|windows\.net/);
    }
  });

  it("lets terraform runs reach only the provider registry", () => {
    const tf = JSON.parse(buildAgentSettings("terraform", root));
    expect(tf.sandbox.network.allowedDomains).toEqual(["registry.terraform.io", "releases.hashicorp.com"]);
  });

  it("lets node runs listen locally and reach the local test database", () => {
    const node = JSON.parse(buildAgentSettings("node", root));
    expect(node.sandbox.network.allowLocalBinding).toBe(true);
    expect(node.sandbox.network.allowedDomains).toEqual(expect.arrayContaining(["registry.npmjs.org", "localhost", "127.0.0.1"]));
  });

  it("does not open local binding for terraform runs", () => {
    const tf = JSON.parse(buildAgentSettings("terraform", root));
    expect(tf.sandbox.network.allowLocalBinding).toBeUndefined();
  });

  it("denies reading extra secret files", () => {
    const settings = JSON.parse(buildAgentSettings("node", "/ns", { secretFiles: ["/ns/projects/acme/.env"] }));
    expect(settings.permissions.deny).toContain("Read(//ns/projects/acme/.env)");
    expect(settings.sandbox.filesystem.denyRead).toContain("/ns/projects/acme/.env");
  });

  it("denies every project's env file when given the full list", () => {
    const secretFiles = ["/ns/projects/acme/.env", "/ns/projects/other/.env"];
    for (const readLogs of [false, true]) {
      const settings = JSON.parse(buildAgentSettings("node", "/ns", { readLogs, secretFiles }));
      expect(settings.permissions.deny).toContain("Read(//ns/projects/other/.env)");
      expect(settings.sandbox.filesystem.denyRead).toContain("/ns/projects/other/.env");
    }
  });
});
