import { describe, expect, it } from "vitest";
import { parseReportBlock } from "../src/claude.js";

const block = `I finished the work.

---REPORT---
status: done
summary: Fixed the CSV export. Key decision: stream rows.
files_created:
  - tests/export.spec.ts
files_modified:
  - src/export.ts
tests:
  - name: "export button returns 200 with correct CSV"
    file: tests/export.spec.ts
    result: pass
  - name: second
    file: tests/other.spec.ts
    result: fail
verify:
  - "npx vitest run tests/export.spec.ts"
  - "npx tsc --noEmit -p tsconfig.base.json"
notes: Touched shared util.
---
`;

describe("parseReportBlock", () => {
  it("parses every field of the AGENTS.md contract", () => {
    expect(parseReportBlock(block)).toEqual({
      status: "done",
      summary: "Fixed the CSV export. Key decision: stream rows.",
      filesCreated: ["tests/export.spec.ts"],
      filesModified: ["src/export.ts"],
      tests: [
        { name: "export button returns 200 with correct CSV", file: "tests/export.spec.ts", result: "pass" },
        { name: "second", file: "tests/other.spec.ts", result: "fail" },
      ],
      verifyCommands: ["npx vitest run tests/export.spec.ts", "npx tsc --noEmit -p tsconfig.base.json"],
      notes: "Touched shared util.",
    });
  });

  it("only ends the block at a line that is exactly ---", () => {
    const parsed = parseReportBlock(block.replace("notes: Touched shared util.", "notes: a --- b\n  second line"));
    expect(parsed.notes).toBe("a --- b second line");
  });

  it("joins multi-line summaries and handles empty notes and lists", () => {
    const parsed = parseReportBlock([
      "---REPORT---",
      "status: partial",
      "summary: First sentence.",
      "  Second sentence.",
      "files_created: []",
      "files_modified:",
      "tests:",
      "verify:",
      'notes: ""',
      "---",
    ].join("\n"));
    expect(parsed.summary).toBe("First sentence. Second sentence.");
    expect(parsed.filesCreated).toEqual([]);
    expect(parsed.notes).toBe("");
  });

  it("uses the last report block and falls back on unknown status", () => {
    const parsed = parseReportBlock("---REPORT---\nstatus: done\n---\ntext\n---REPORT---\nstatus: weird\n---");
    expect(parsed.status).toBe("needs_review");
  });

  it("tolerates a missing end marker and code fences", () => {
    const parsed = parseReportBlock("```\n---REPORT---\nstatus: done\nsummary: ok\n---\n```");
    expect(parsed).toMatchObject({ status: "done", summary: "ok" });
  });

  it("throws when there is no block", () => {
    expect(() => parseReportBlock("nothing here")).toThrow(/No ---REPORT---/);
  });
});
