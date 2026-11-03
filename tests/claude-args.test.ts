import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentRunArgs, buildClaudeArgs, confirmSystemPrompt, DEDUPE_PROFILE, dedupeSystemPrompt, finderSystemPrompt, fixReviewSystemPrompt, editProfile, POSTMORTEM_PROFILE, reviewProfile } from "../src/claude.js";

describe("agent instructions", () => {
  const agentsMd = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf-8");

  it("never tells the agent to commit", () => {
    expect(agentsMd).not.toMatch(/commit what you have/i);
    expect(agentsMd).not.toMatch(/one commit per ticket/i);
  });

  it("names no language, framework or package manager", () => {
    expect(agentsMd).not.toMatch(/terraform|vitest|typescript/i);
  });

  it("denies git commit to the agent", () => {
    const args = buildClaudeArgs("x");
    const disallowed = args[args.indexOf("--disallowedTools") + 1];
    expect(disallowed).toContain("Bash(git commit *)");
  });
});

describe("output format", () => {
  it("asks for JSON output in every profile", () => {
    for (const profile of [undefined, reviewProfile(), DEDUPE_PROFILE, POSTMORTEM_PROFILE]) {
      const args = buildClaudeArgs("x", profile);
      expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    }
  });
});

describe("effort", () => {
  it("pins high effort in every profile", () => {
    for (const profile of [undefined, reviewProfile(), POSTMORTEM_PROFILE]) {
      const args = buildClaudeArgs("x", profile);
      expect(args[args.indexOf("--effort") + 1]).toBe("high");
    }
  });

  it("lets a profile override the effort", () => {
    const args = buildClaudeArgs("x", { ...reviewProfile(), effort: "low" });
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
  });
});

describe("model", () => {
  it("pins the Opus model for review runs", () => {
    const args = buildClaudeArgs("x", reviewProfile());
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  });

  it("passes no --model for the implementer or the postmortem", () => {
    expect(buildClaudeArgs("x")).not.toContain("--model");
    expect(buildClaudeArgs("x", POSTMORTEM_PROFILE)).not.toContain("--model");
  });
});

describe("agentRunArgs", () => {
  it("adds settings, strict MCP config and user-only setting sources", () => {
    expect(agentRunArgs(["-p"], "{}")).toEqual(
      ["-p", "--settings", "{}", "--strict-mcp-config", "--setting-sources", "user"],
    );
  });

  it("enforces the allow list for the review run and leaves out personal settings", () => {
    const args = agentRunArgs(["-p"], JSON.stringify({ sandbox: { enabled: true } }), reviewProfile());
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

describe("edit profile", () => {
  const allowed = (tools: string[]) => editProfile({ tools }).allowedTools;

  it("allows each configured tool with and without arguments, on top of the generic entries", () => {
    expect(allowed(["make", "docker compose"])).toEqual(expect.arrayContaining(
      ["Bash(make *)", "Bash(make)", "Bash(docker compose *)", "Bash(docker compose)", "Bash(git *)", "Bash(grep *)", "Bash(cat *)"],
    ));
  });

  it("grants no tool the repo did not list", () => {
    expect(allowed([]).filter(t => !/^Bash\((git|grep|rg|find|ls|cat|head|tail|wc) /.test(t))).toEqual([]);
  });

  it("is edit-capable and still denies commit and push", () => {
    const profile = editProfile({ tools: [] });
    expect(profile.permissionMode).toBe("acceptEdits");
    expect(profile.disallowedTools).toEqual(expect.arrayContaining(["Bash(git commit *)", "Bash(git push *)"]));
  });
});

describe("review run args", () => {
  const checks = {
    checks: [
      { name: "lint", command: "make lint" },
      { name: "test a", command: "make test", in: ["a/*/x"] },
      { name: "test b", command: "make test", in: ["b/*/x"] },
    ],
  };
  const args = buildClaudeArgs("x", reviewProfile(checks));
  const value = (flag: string) => args[args.indexOf(flag) + 1];

  it("grants no edit tools and denies them explicitly", () => {
    const allowed = value("--allowedTools").split(",");
    for (const tool of ["Edit", "Write", "NotebookEdit"]) {
      expect(allowed).not.toContain(tool);
      expect(value("--disallowedTools").split(",")).toContain(tool);
    }
  });

  it("allows each distinct check command and nothing else that runs code", () => {
    const allowed = value("--allowedTools").split(",");
    expect(allowed).toEqual(expect.arrayContaining(["Bash(make lint*)", "Bash(make test*)"]));
    expect(allowed.filter(t => t === "Bash(make test*)")).toHaveLength(1);
    expect(allowed.filter(t => t.startsWith("Bash(make"))).toHaveLength(2);
  });

  it("allows each part of a compound check command separately", () => {
    const compound = { checks: [{ name: "tf", command: "terraform init -backend=false -input=false && terraform validate" }] };
    expect(reviewProfile(compound).allowedTools).toEqual(expect.arrayContaining(["Bash(terraform init -backend=false -input=false*)", "Bash(terraform validate*)"]));
  });

  it("allows no check commands without a repo", () => {
    expect(reviewProfile().allowedTools.filter(t => t.endsWith("*)") && !/ \*\)$/.test(t) && t !== "Bash(git status*)")).toEqual([]);
  });

  it("does not auto-accept edits", () => {
    expect(value("--permission-mode")).not.toBe("acceptEdits");
  });

  it("limits bash to read-only commands", () => {
    const allowed = value("--allowedTools").split(",");
    expect(allowed).toContain("Bash(git diff *)");
    for (const writer of ["Bash(git *)", "Bash(make *)"]) {
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

describe("dedupe run args", () => {
  const args = buildClaudeArgs("x", DEDUPE_PROFILE);
  const value = (flag: string) => args[args.indexOf(flag) + 1];

  it("runs dedupe on Sonnet at low effort with every tool disabled", () => {
    expect(value("--tools")).toBe("");
    expect(value("--model")).toBe("claude-sonnet-5-5");
    expect(value("--effort")).toBe("low");
    expect(args).not.toContain("--allowedTools");
  });

  it("still denies edits and publishing", () => {
    expect(value("--disallowedTools")).toContain("Edit");
    expect(value("--disallowedTools")).toContain("Bash(git push *)");
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
    for (const name of ["review-spec.md", "fix.md"]) {
      expect(read(name)).toMatch(/nightshift/i);
    }
  });
});

describe("review prompt layering", () => {
  const read = (name: string) => readFileSync(new URL(`../prompts/${name}`, import.meta.url), "utf-8");

  it("defines happens and keeps rejected for claims that don't happen in confirm.md", () => {
    const confirm = read("confirm.md");
    expect(confirm).toContain("happens: yes | no");
    expect(confirm).toContain("does not happen");
  });

  it("keeps the base review prompt free of per-lens focus and the precision bar", () => {
    const base = read("review.md");
    expect(base).toContain("---REVIEW---");
    expect(base).not.toMatch(/Do not pad|good and common outcome|If you cannot show how it breaks/);
  });

  it("has a prompt file per lens that sits on the base", () => {
    for (const lens of ["bugs", "spec", "reuse"]) {
      expect(read(`review-${lens}.md`)).toMatch(/on top of the review instructions above/);
    }
  });

  it("puts the precision bar and the CONFIRM contract in confirm.md, layered on the base", () => {
    const confirm = read("confirm.md");
    expect(confirm).toMatch(/on top of the review instructions above/);
    expect(confirm).toContain("---CONFIRM---");
    expect(confirm).toMatch(/show how it breaks/i);
  });

  it("drops the last-resort rule and requires a cited line for a rejection in confirm.md", () => {
    const confirm = read("confirm.md");
    expect(confirm).not.toMatch(/last resort/i);
    expect(confirm).toMatch(/A rejection without them/);
    expect(confirm).toMatch(/`evidence`/);
  });

  it("defines ticket_conflict with a quoted ticket line and a change in confirm.md", () => {
    const confirm = read("confirm.md");
    for (const text of ["ticket_conflict", "ticket:", "change:"]) expect(confirm).toContain(text);
  });

  it("builds the dedupe system prompt from dedupe.md alone", () => {
    expect(dedupeSystemPrompt()).toBe(read("dedupe.md"));
    expect(dedupeSystemPrompt()).toContain("---DEDUPE---");
  });

  it("builds the finder system prompt from the base plus the lens file", () => {
    for (const lens of ["bugs", "spec", "reuse"] as const) {
      expect(finderSystemPrompt(lens)).toBe([read("review.md"), read(`review-${lens}.md`)].join("\n\n---\n\n"));
    }
  });

  it("builds the confirm system prompt from the base plus confirm.md", () => {
    expect(confirmSystemPrompt()).toBe([read("review.md"), read("confirm.md")].join("\n\n---\n\n"));
  });

  it("keeps fix-review.md layered on the base", () => {
    expect(read("fix-review.md")).toMatch(/on top of the review instructions above/);
  });

  it("builds the fix review system prompt from the base plus fix-review.md", () => {
    expect(fixReviewSystemPrompt()).toBe([read("review.md"), read("fix-review.md")].join("\n\n---\n\n"));
  });

  it("states the bugs checks generically and never names a project", () => {
    const bugs = read("review-bugs.md");
    expect(bugs).not.toMatch(/\b[A-Z][A-Z0-9]*-\d+\b/);
    expect(bugs).not.toMatch(/projects\/[a-z0-9_-]+\//i);
    expect(bugs).toMatch(/Behaviour over time/);
  });

  it("tells every producer of risk text to word it as a plain statement about the code", () => {
    for (const name of ["confirm.md", "review-bugs.md"]) {
      expect(read(name)).toMatch(/never mention a review, a reviewer or how the change was produced/);
    }
  });

  it("states in review.md's contract that every issue and risk is a plain statement about the code", () => {
    expect(read("review.md")).toMatch(/Every `issue` and every `risk` is a plain statement about the code/);
    expect(read("review.md")).toMatch(/Never mention the fixer, the implementer, a fix, a review, a reviewer or how the change was produced in them/);
  });

  it("carries decisions over in the fix report", () => {
    expect(read("fix.md")).toMatch(/`followups` and `decisions`/);
  });
});

describe("postmortem run args", () => {
  const args = buildClaudeArgs("x", POSTMORTEM_PROFILE, ["/wt"]);
  const value = (flag: string) => args[args.indexOf(flag) + 1];

  it("is read-only with the allow list enforced", () => {
    const allowed = value("--allowedTools").split(",");
    expect(allowed).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Bash(git log *)", "Bash(git diff *)", "Bash(cat *)"]));
    expect(allowed.some(t => /make|Edit|Write/.test(t))).toBe(false);
    for (const tool of ["Edit", "Write", "NotebookEdit"]) expect(value("--disallowedTools").split(",")).toContain(tool);
    expect(POSTMORTEM_PROFILE.enforceAllowList).toBe(true);
  });

  it("adds the worktrees directory", () => {
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/wt");
  });

  it("adds no directories by default", () => {
    expect(buildClaudeArgs("x", POSTMORTEM_PROFILE)).not.toContain("--add-dir");
  });
});
