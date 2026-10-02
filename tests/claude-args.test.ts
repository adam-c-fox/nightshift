import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentRunArgs, buildClaudeArgs, REVIEW_PROFILE } from "../src/claude.js";

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

  it("enforces the allow list for the review run and leaves out personal settings", () => {
    const args = agentRunArgs(["-p"], JSON.stringify({ sandbox: { enabled: true } }), REVIEW_PROFILE);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(settings.sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: false });
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
  });

  it("always appends the isolation flags, even for empty settings", () => {
    expect(agentRunArgs(["-p"], "")).toEqual(
      ["-p", "--settings", "", "--strict-mcp-config", "--setting-sources", "user"],
    );
  });
});

describe("review run args", () => {
  const args = buildClaudeArgs("x", REVIEW_PROFILE);
  const value = (flag: string) => args[args.indexOf(flag) + 1];

  it("grants no edit tools and denies them explicitly", () => {
    const allowed = value("--allowedTools").split(",");
    for (const tool of ["Edit", "Write", "NotebookEdit"]) {
      expect(allowed).not.toContain(tool);
      expect(value("--disallowedTools").split(",")).toContain(tool);
    }
  });

  it("allows the check scripts but not their write-mode variants", () => {
    const allowed = value("--allowedTools").split(",");
    expect(allowed).toEqual(expect.arrayContaining(["Bash(npm run lint)", "Bash(npm run format)", "Bash(npx tsc --noEmit*)"]));
    expect(allowed.some(t => /lint\*|format\*|tsc\*\)/.test(t))).toBe(false);
    expect(value("--disallowedTools").split(",")).toContain("Bash(npx vitest * -u*)");
  });

  it("allows the same build, typecheck and test commands CI runs", () => {
    expect(value("--allowedTools").split(",")).toEqual(expect.arrayContaining(
      ["Bash(npm run build)", "Bash(npm run typecheck)", "Bash(npm test)", "Bash(terraform validate*)", "Bash(terraform fmt -check*)"],
    ));
  });

  it("does not auto-accept edits", () => {
    expect(value("--permission-mode")).not.toBe("acceptEdits");
  });

  it("limits bash to read-only commands", () => {
    const allowed = value("--allowedTools").split(",");
    expect(allowed).toContain("Bash(git diff *)");
    expect(allowed).toContain("Bash(npx vitest run*)");
    for (const writer of ["Bash(git *)", "Bash(npm *)", "Bash(npx *)", "Bash(node *)", "Bash(terraform *)"]) {
      expect(allowed).not.toContain(writer);
    }
  });

  it("still denies commit and push", () => {
    expect(value("--disallowedTools")).toContain("Bash(git commit *)");
    expect(value("--disallowedTools")).toContain("Bash(git push *)");
  });

  it("keeps the implementer's edit access by default", () => {
    expect(buildClaudeArgs("x")[buildClaudeArgs("x").indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });
});

describe("review and fix prompts", () => {
  const read = (name: string) => readFileSync(new URL(`../prompts/${name}`, import.meta.url), "utf-8");

  it("defines the review output contract", () => {
    expect(read("review.md")).toContain("---REVIEW---");
  });

  it("defines the fix output contract and keeps the report block", () => {
    expect(read("fix.md")).toContain("---FIXES---");
    expect(read("fix.md")).toContain("---REPORT---");
  });

  it("forbids provenance mentions in both", () => {
    for (const name of ["review.md", "fix.md"]) {
      expect(read(name)).toMatch(/nightshift/i);
    }
  });
});
