import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openNightBudget } from "../src/budget.js";
import {
  buildPostmortemPrompt, parsePostmortemBlock, postmortemMarkdown, postmortemSkipReason, postmortemSystemPrompt, sessionLogData,
} from "../src/postmortem.js";
import type { SessionResult, TicketResult } from "../src/types.js";

const ticket = (id: string, status: TicketResult["status"]): TicketResult => ({
  ticket: { id, name: "n", context: [], repo: "main" }, linear: null, status, summary: "", filesCreated: [], filesModified: [],
  tests: [], verifyCommands: [], notes: "", followups: [], worktreePath: "/w", branch: "b", durationSec: 1,
});

describe("postmortemSkipReason", () => {
  const worked = [ticket("ENG-1", "done")];
  const decide = (over: Partial<Parameters<typeof postmortemSkipReason>[0]> = {}) =>
    postmortemSkipReason({ dryRun: false, tickets: worked, gate: () => "open", ...over });

  it("runs after a normal night", () => expect(decide()).toBeUndefined());
  it("skips a dry run", () => expect(decide({ dryRun: true })).toBe("dry run"));
  it("skips when no ticket was worked", () => {
    expect(decide({ tickets: [] })).toBe("no tickets worked");
    expect(decide({ tickets: [ticket("A", "skipped"), ticket("B", "error")] })).toBe("no tickets worked");
  });
  it("counts a needs_review ticket as worked", () => expect(decide({ tickets: [ticket("A", "needs_review")] })).toBeUndefined());
  it("skips when the budget cap is reached", () => expect(decide({ gate: () => "hit" })).toBe("budget cap reached"));
  it("skips when usage cannot be read", () => expect(decide({ gate: () => "unreadable" })).toBe("could not read usage"));
  it("does not read usage when an earlier reason already applies", () => {
    let reads = 0;
    decide({ dryRun: true, gate: () => (reads++, "open") });
    decide({ tickets: [], gate: () => (reads++, "open") });
    expect(reads).toBe(0);
  });
});

describe("parsePostmortemBlock", () => {
  const block = [
    "Some analysis.", "---POSTMORTEM---", "suggestions:",
    "  - id: P1", "    target: AGENTS.md", "    tickets: ENG-142, ENG-150",
    "    problem: \"Tests skipped: see ENG-142-output.txt\"", "    cause: Step 3 never says to run it", "    change: Add a line to section 2",
    "  - id: P2", "    target: prompts/review.md", "    tickets: ENG-150",
    "    problem: p", "    cause: c", "    change: x", "---",
  ].join("\n");

  it("parses suggestions with their fields", () => {
    expect(parsePostmortemBlock(block)).toEqual([
      { id: "P1", target: "AGENTS.md", tickets: ["ENG-142", "ENG-150"], problem: "Tests skipped: see ENG-142-output.txt", cause: "Step 3 never says to run it", change: "Add a line to section 2" },
      { id: "P2", target: "prompts/review.md", tickets: ["ENG-150"], problem: "p", cause: "c", change: "x" },
    ]);
  });
  it("accepts an empty list", () => {
    expect(parsePostmortemBlock("---POSTMORTEM---\nsuggestions: []\n---")).toEqual([]);
    expect(parsePostmortemBlock("---POSTMORTEM---\nsuggestions:\n---")).toEqual([]);
  });
  it("numbers suggestions that lack an id", () => {
    const out = parsePostmortemBlock("---POSTMORTEM---\nsuggestions:\n  - target: AGENTS.md\n    problem: p\n    change: c\n---");
    expect(out[0].id).toBe("P1");
  });
  it("throws when the block is missing", () => expect(() => parsePostmortemBlock("nothing")).toThrow(/POSTMORTEM/));
  it("throws on a non-empty body with no suggestions", () => {
    expect(() => parsePostmortemBlock("---POSTMORTEM---\nsuggestions:\n  nonsense\n---")).toThrow(/Malformed/);
  });
});

describe("postmortem skill", () => {
  const skill = readFileSync(new URL("../.claude/skills/postmortem/SKILL.md", import.meta.url), "utf-8");

  it("is a manual-only skill", () => {
    expect(skill).toMatch(/^---\nname: postmortem\n/);
    expect(skill).toMatch(/^disable-model-invocation: true$/m);
  });
  it("strips the frontmatter for the runner's system prompt", () => {
    const prompt = postmortemSystemPrompt(skill);
    expect(prompt).not.toMatch(/^---/);
    expect(prompt).not.toContain("disable-model-invocation");
    expect(prompt).toContain("---POSTMORTEM---");
    expect(prompt.startsWith("\n")).toBe(false);
  });
  it("leaves text without frontmatter alone", () => expect(postmortemSystemPrompt("hello\n")).toBe("hello\n"));
});

describe("buildPostmortemPrompt", () => {
  it("points at the night's session file", () => {
    const prompt = buildPostmortemPrompt("2026-10-01");
    expect(prompt).toContain("2026-10-01");
    expect(prompt).toContain("logs/session-2026-10-01.json");
  });
});

describe("sessionLogData", () => {
  const session: SessionResult = {
    date: "2026-10-01", startedAt: "", endedAt: "", tickets: [ticket("ENG-1", "done"), ticket("ENG-2", "skipped")],
    budget: openNightBudget({ weeklyPercent: 3, resetInfo: "Oct 7" }, 15), gateHit: false, skipReason: "", noTasks: false,
  };

  it("lists only the log files that exist for each ticket", () => {
    const exists = (name: string) => ["ENG-1-output.txt", "ENG-1-review.txt", "ENG-1-diff.txt"].includes(name);
    const data = sessionLogData(session, exists) as { tickets: { ticket: { id: string }; logFiles: string[] }[] };
    expect(data.tickets[0].logFiles).toEqual(["logs/ENG-1-output.txt", "logs/ENG-1-review.txt", "logs/ENG-1-diff.txt"]);
    expect(data.tickets[1].logFiles).toEqual([]);
  });
  it("keeps the session data", () => {
    const data = sessionLogData(session, () => false) as { date: string; tickets: { status: string }[] };
    expect(data.date).toBe("2026-10-01");
    expect(data.tickets[0].status).toBe("done");
  });
});

describe("postmortemMarkdown", () => {
  const s = { id: "P1", target: "AGENTS.md", tickets: ["ENG-1", "ENG-2"], problem: "prob", cause: "cause", change: "chg" };

  it("lists each suggestion by id with its fields", () => {
    const md = postmortemMarkdown("2026-10-01", [s]);
    expect(md).toContain("# Nightshift postmortem – 2026-10-01");
    expect(md).toContain("## P1 – AGENTS.md");
    expect(md).toContain("Tickets: ENG-1, ENG-2");
    expect(md).toContain("Problem: prob");
    expect(md).toContain("Cause: cause");
    expect(md).toContain("Change: chg");
  });
  it("says so when there is nothing to suggest", () => expect(postmortemMarkdown("2026-10-01", [])).toContain("No suggestions."));
});
