import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentRunArgs, buildClaudeArgs } from "../src/claude.js";

describe("agent instructions", () => {
  const agentsMd = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf-8");

  it("never tells the agent to commit", () => {
    expect(agentsMd).not.toMatch(/commit what you have/i);
    expect(agentsMd).not.toMatch(/one commit per ticket/i);
  });

  it("leaves terraform plan to the PR pipeline", () => {
    expect(agentsMd).not.toMatch(/terraform plan/);
    expect(agentsMd).toMatch(/terraform init -backend=false/);
  });

  it("denies git commit to the agent", () => {
    const args = buildClaudeArgs("x");
    const disallowed = args[args.indexOf("--disallowedTools") + 1];
    expect(disallowed).toContain("Bash(git commit *)");
  });
});

describe("agentRunArgs", () => {
  it("adds settings, strict MCP config and user-only setting sources", () => {
    expect(agentRunArgs(["-p"], "{}")).toEqual(
      ["-p", "--settings", "{}", "--strict-mcp-config", "--setting-sources", "user"],
    );
  });

  it("leaves args untouched without settings", () => {
    expect(agentRunArgs(["-p"])).toEqual(["-p"]);
  });
});
