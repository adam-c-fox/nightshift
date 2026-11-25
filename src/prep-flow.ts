import { readFileSync } from "node:fs";
import path from "node:path";
import type { Issue } from "./issue-tracker.js";
import type { PrepSections } from "./prep.js";
import type { Project } from "./project.js";

export interface Gap {
  id: string;
  title: string;
  question: string;
  recommended: string;
  alternative?: string;
}

export interface Survey {
  repo: string;
  gaps: Gap[];
  pointers: string[];
}

export type GapAnswer =
  | { gapId: string; choice: "recommended" | "alternative" | "your_call" }
  | { gapId: string; choice: "other"; text: string };

const MAX_GAPS = 12;
const MAX_POINTERS = 15;
const MAX_TEXT = 2000;
const MAX_TITLE = 80;

const text = { type: "string", maxLength: MAX_TEXT };
const textList = (maxItems?: number) => ({
  type: "array",
  items: text,
  ...(maxItems ? { maxItems } : {}),
});

export const SURVEY_SCHEMA = (repoNames: string[]) => ({
  type: "object",
  properties: {
    repo: { type: "string", enum: repoNames },
    gaps: {
      type: "array",
      maxItems: MAX_GAPS,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: MAX_TITLE },
          question: text,
          recommended: text,
          alternative: text,
        },
        required: ["title", "question", "recommended"],
        additionalProperties: false,
      },
    },
    pointers: textList(MAX_POINTERS),
  },
  required: ["repo", "gaps", "pointers"],
  additionalProperties: false,
});

export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    acceptanceCriteria: textList(),
    decisions: textList(),
    pointers: textList(),
  },
  required: ["acceptanceCriteria", "decisions", "pointers"],
  additionalProperties: false,
};

function fail(reason: string): never {
  throw new Error(`invalid model output: ${reason}`);
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, where: string, max = MAX_TEXT): string {
  if (typeof value !== "string") fail(`${where} must be a string`);
  if (value.length > max) fail(`${where} is over ${max} characters`);
  return value;
}

function asStrings(value: unknown, where: string, maxItems = Infinity): string[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  if (value.length > maxItems) fail(`${where} has more than ${maxItems} items`);
  return value.map((item, i) => asString(item, `${where}[${i}]`));
}

export function parseSurvey(value: unknown, repoNames: string[]): Survey {
  const raw = asObject(value, "survey");
  const repo = asString(raw.repo, "repo");
  if (!repoNames.includes(repo)) fail(`unknown repo "${repo}"`);
  if (!Array.isArray(raw.gaps)) fail("gaps must be an array");
  if (raw.gaps.length > MAX_GAPS) fail(`more than ${MAX_GAPS} gaps`);
  const gaps = raw.gaps.map((entry, i): Gap => {
    const g = asObject(entry, `gaps[${i}]`);
    const title = asString(g.title, `gaps[${i}].title`, MAX_TITLE);
    if (title === "") fail(`gaps[${i}].title is empty`);
    return {
      id: `g${i + 1}`,
      title,
      question: asString(g.question, `gaps[${i}].question`),
      recommended: asString(g.recommended, `gaps[${i}].recommended`),
      ...(g.alternative === undefined
        ? {}
        : { alternative: asString(g.alternative, `gaps[${i}].alternative`) }),
    };
  });
  return { repo, gaps, pointers: asStrings(raw.pointers, "pointers", MAX_POINTERS) };
}

export function parseDraft(value: unknown): PrepSections {
  const raw = asObject(value, "draft");
  return {
    acceptanceCriteria: asStrings(raw.acceptanceCriteria, "acceptanceCriteria"),
    decisions: asStrings(raw.decisions, "decisions"),
    pointers: asStrings(raw.pointers, "pointers"),
  };
}

export function readPrepSkillTexts(root: string): { gapsMd: string; draftMd: string } {
  const dir = path.join(root, ".claude", "skills", "prep");
  return {
    gapsMd: readFileSync(path.join(dir, "gaps.md"), "utf8"),
    draftMd: readFileSync(path.join(dir, "draft.md"), "utf8"),
  };
}

export function buildSurveyPrompt(issue: Issue, project: Project, gapsMd: string): string {
  const comments = issue.comments
    .map((c) => `- ${c.author} (${c.createdAt}):\n${c.body}`)
    .join("\n\n");
  const repos = Object.entries(project.repos)
    .map(([name, repo]) => `- ${name}: ${repo.path}\n  ${repo.description}`)
    .join("\n");
  return `Prep this ticket so a developer can finish it without guessing.

# Ticket
Title: ${issue.name}
URL: ${issue.url}

## Description
${issue.description}

## Comments (oldest first)
${comments || "(none)"}

# Repos
${repos}

Pick the repo the ticket belongs in. Ground the ticket in that repo's code: search for every file, function, type, table, route and config key the ticket names, and read the matching code. Locate every identifier the ticket names, or confirm it is missing. Note the test files that cover it and any existing helper the change should reuse; list them as pointers.

# Gaps to check
Check the ticket against every item below, using what you found in the code. Return only the gaps that apply.

${gapsMd}`;
}

function answerLine(answer: GapAnswer, gap: Gap): string {
  switch (answer.choice) {
    case "recommended":
      return `- ${gap.title}: ${gap.recommended}`;
    case "alternative":
      if (gap.alternative === undefined)
        throw new Error(`gap ${gap.id} has no alternative`);
      return `- ${gap.title}: ${gap.alternative}`;
    case "your_call":
      return `- Your call on ${gap.title}; state the choice in notes`;
    case "other":
      return `- ${gap.title}: ${answer.text}`;
  }
}

export function buildDraftPrompt(answers: GapAnswer[], survey: Survey, draftMd: string): string {
  const lines = answers.map((answer) => {
    const gap = survey.gaps.find((g) => g.id === answer.gapId);
    if (!gap) throw new Error(`answer for unknown gap ${answer.gapId}`);
    return answerLine(answer, gap);
  });
  return `The user answered the gaps:

${lines.join("\n")}

Return only the new sections, not the whole description. Each array item is one bullet.

${draftMd}`;
}

export function buildRevisePrompt(feedback: string, draft: string): string {
  return `The reviewer asked for changes to the draft.

Feedback:
${feedback}

Current draft:
${draft}

Return the revised sections, in the same shape as before.`;
}
