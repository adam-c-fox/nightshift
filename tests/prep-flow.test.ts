import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Issue } from "../src/issue-tracker.js";
import type { Project } from "../src/project.js";
import {
  DRAFT_SCHEMA,
  SURVEY_SCHEMA,
  buildDraftPrompt,
  buildRevisePrompt,
  buildSurveyPrompt,
  parseDraft,
  parseSurvey,
  readPrepSkillTexts,
  type Survey,
} from "../src/prep-flow.js";

const repos = ["api", "web"];
const gap = { title: "Which format", question: "CSV or JSON?", recommended: "CSV" };
const survey = (over: Record<string, unknown> = {}) => ({
  repo: "api",
  gaps: [gap],
  pointers: ["see src/export.ts"],
  ...over,
});

describe("parseSurvey", () => {
  it("accepts a valid survey and assigns ids g1, g2 ignoring model ids", () => {
    const out = parseSurvey(
      survey({ gaps: [{ ...gap, id: "zz" }, { ...gap, alternative: "JSON", id: "g1" }] }),
      repos,
    );
    expect(out.gaps.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(out.gaps[1].alternative).toBe("JSON");
    expect(out.repo).toBe("api");
  });

  const long = "x".repeat(2001);
  it.each([
    ["non-object", null],
    ["array", []],
    ["unknown repo", survey({ repo: "nope" })],
    ["non-string repo", survey({ repo: 3 })],
    ["gaps not an array", survey({ gaps: "x" })],
    ["too many gaps", survey({ gaps: Array.from({ length: 13 }, () => gap) })],
    ["gap not an object", survey({ gaps: ["x"] })],
    ["gap title wrong type", survey({ gaps: [{ ...gap, title: 1 }] })],
    ["gap title over 80", survey({ gaps: [{ ...gap, title: "t".repeat(81) }] })],
    ["empty gap title", survey({ gaps: [{ ...gap, title: "" }] })],
    ["question over 2000", survey({ gaps: [{ ...gap, question: long }] })],
    ["recommended missing", survey({ gaps: [{ title: "t", question: "q" }] })],
    ["alternative wrong type", survey({ gaps: [{ ...gap, alternative: 5 }] })],
    ["pointers not an array", survey({ pointers: "x" })],
    ["too many pointers", survey({ pointers: Array.from({ length: 16 }, () => "p") })],
    ["pointer wrong type", survey({ pointers: [1] })],
    ["pointer over 2000", survey({ pointers: [long] })],
  ])("rejects %s", (_name, value) => {
    expect(() => parseSurvey(value, repos)).toThrow();
  });
});

describe("parseDraft", () => {
  const draft = { acceptanceCriteria: ["a"], decisions: ["b"], pointers: ["c"] };

  it("accepts a valid draft", () => {
    expect(parseDraft(draft)).toEqual(draft);
  });

  it.each([
    ["non-object", "x"],
    ["missing key", { acceptanceCriteria: [], decisions: [] }],
    ["not an array", { ...draft, decisions: "b" }],
    ["non-string item", { ...draft, pointers: [1] }],
    ["item over 2000", { ...draft, acceptanceCriteria: ["x".repeat(2001)] }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseDraft(value)).toThrow();
  });
});

describe("schemas", () => {
  it("limits survey repo to the project's repos and caps gaps and pointers", () => {
    const schema = SURVEY_SCHEMA(repos) as any;
    expect(schema.properties.repo.enum).toEqual(repos);
    expect(schema.properties.gaps.maxItems).toBe(12);
    expect(schema.properties.pointers.maxItems).toBe(15);
    expect(schema.properties.gaps.items.required).toEqual(["title", "question", "recommended"]);
  });

  it("requires the three draft sections", () => {
    expect((DRAFT_SCHEMA as any).required).toEqual(["acceptanceCriteria", "decisions", "pointers"]);
  });
});

describe("prompts", () => {
  const issue = {
    name: "Export is slow",
    description: "Make export fast",
    url: "https://tracker/ENG-1",
    comments: [
      { author: "ann", createdAt: "2026-01-01", body: "FIRST-COMMENT" },
      { author: "bob", createdAt: "2026-01-02", body: "SECOND-COMMENT" },
    ],
  } as Issue;
  const project = {
    repos: {
      api: { path: "/code/api", description: "The API service" },
      web: { path: "/code/web", description: "The web app" },
    },
  } as unknown as Project;

  it("survey prompt carries the ticket, comments in order, repos, gaps.md and the grounding rule", () => {
    const p = buildSurveyPrompt(issue, project, "GAPS-MD-TEXT");
    expect(p).toContain("Export is slow");
    expect(p).toContain("Make export fast");
    expect(p).toContain("https://tracker/ENG-1");
    expect(p.indexOf("FIRST-COMMENT")).toBeGreaterThan(-1);
    expect(p.indexOf("FIRST-COMMENT")).toBeLessThan(p.indexOf("SECOND-COMMENT"));
    expect(p).toContain("api: /code/api");
    expect(p).toContain("The API service");
    expect(p).toContain("The web app");
    expect(p).toContain("GAPS-MD-TEXT");
    expect(p).toContain("Locate every");
    expect(p).toContain("confirm it is missing");
  });

  const s: Survey = {
    repo: "api",
    pointers: [],
    gaps: [
      { id: "g1", title: "Format", question: "q", recommended: "Use CSV", alternative: "Use JSON" },
      { id: "g2", title: "Limit", question: "q", recommended: "100" },
      { id: "g3", title: "Auth", question: "q", recommended: "yes" },
      { id: "g4", title: "Name", question: "q", recommended: "x" },
    ],
  };

  it("draft prompt phrases each answer the way the skill does and includes draft.md", () => {
    const p = buildDraftPrompt(
      [
        { gapId: "g1", choice: "alternative" },
        { gapId: "g2", choice: "recommended" },
        { gapId: "g3", choice: "your_call" },
        { gapId: "g4", choice: "other", text: "Call it export_v2" },
      ],
      s,
      "DRAFT-MD-TEXT",
    );
    expect(p).toContain("- Format: Use JSON");
    expect(p).toContain("- Limit: 100");
    expect(p).toContain("- Your call on Auth; state the choice in notes");
    expect(p).toContain("- Name: Call it export_v2");
    expect(p).toContain("DRAFT-MD-TEXT");
  });

  it("draft prompt rejects an answer for an unknown gap", () => {
    expect(() => buildDraftPrompt([{ gapId: "g9", choice: "recommended" }], s, "")).toThrow();
  });

  it("revise prompt carries the feedback and the current draft", () => {
    const p = buildRevisePrompt("Drop the second bullet", "CURRENT DRAFT");
    expect(p).toContain("Drop the second bullet");
    expect(p).toContain("CURRENT DRAFT");
  });
});

describe("readPrepSkillTexts", () => {
  it("reads gaps.md and draft.md under the root", () => {
    const root = mkdtempSync(join(tmpdir(), "prep-flow-"));
    const dir = join(root, ".claude", "skills", "prep");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "gaps.md"), "G");
    writeFileSync(join(dir, "draft.md"), "D");
    expect(readPrepSkillTexts(root)).toEqual({ gapsMd: "G", draftMd: "D" });
  });
});
