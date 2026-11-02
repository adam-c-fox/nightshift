import { describe, expect, it } from "vitest";
import { parseReportBlock } from "../src/claude.js";

const block = `I finished the work.

---REPORT---
status: done
title: fix: stream csv export rows
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
followups:
  - file: src/legacy.ts
    note: "Swallows errors: add logging"
  - file: src/other.ts
    note: Dead branch.
decisions:
  - file: src/export.ts
    decision: "A row with no header is skipped: not an error"
  - file: src/other.ts
    decision: Empty files are marked read.
---
`;

describe("parseReportBlock", () => {
  it("parses every field of the AGENTS.md contract", () => {
    expect(parseReportBlock(block)).toEqual({
      status: "done",
      title: "fix: stream csv export rows",
      summary: "Fixed the CSV export. Key decision: stream rows.",
      filesCreated: ["tests/export.spec.ts"],
      filesModified: ["src/export.ts"],
      tests: [
        { name: "export button returns 200 with correct CSV", file: "tests/export.spec.ts", result: "pass" },
        { name: "second", file: "tests/other.spec.ts", result: "fail" },
      ],
      verifyCommands: ["npx vitest run tests/export.spec.ts", "npx tsc --noEmit -p tsconfig.base.json"],
      notes: "Touched shared util.",
      followups: [
        { file: "src/legacy.ts", note: "Swallows errors: add logging" },
        { file: "src/other.ts", note: "Dead branch." },
      ],
      decisions: [
        { file: "src/export.ts", decision: "A row with no header is skipped: not an error" },
        { file: "src/other.ts", decision: "Empty files are marked read." },
      ],
      threads: [],
    });
  });

  it("defaults followups to an empty list when absent or empty", () => {
    const withoutKey = block.replace(/followups:[\s\S]*?\n---/, "---");
    expect(parseReportBlock(withoutKey).followups).toEqual([]);
    expect(parseReportBlock(block.replace(/followups:[\s\S]*?\n---/, "followups: []\n---")).followups).toEqual([]);
  });

  it("gives an empty decisions list when missing or empty", () => {
    const withoutKey = block.replace(/decisions:[\s\S]*?\n---/, "---");
    expect(parseReportBlock(withoutKey).decisions).toEqual([]);
    expect(parseReportBlock(block.replace(/decisions:[\s\S]*?\n---/, "decisions: []\n---")).decisions).toEqual([]);
  });

  it("leaves the title empty when the report has none", () => {
    expect(parseReportBlock(block.replace("title: fix: stream csv export rows\n", "")).title).toBe("");
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

  it("tolerates code fences around the block", () => {
    const parsed = parseReportBlock("```\n---REPORT---\nstatus: done\nsummary: ok\n---\n```");
    expect(parsed).toMatchObject({ status: "done", summary: "ok" });
  });

  it("reads to end of output when the end marker is missing", () => {
    const parsed = parseReportBlock("---REPORT---\nstatus: partial\nsummary: cut off\nnotes: tail");
    expect(parsed).toMatchObject({ status: "partial", summary: "cut off", notes: "tail" });
  });

  it("throws when there is no block", () => {
    expect(() => parseReportBlock("nothing here")).toThrow(/No ---REPORT---/);
  });
  describe("threads", () => {
    const withThreads = (body: string) => `---REPORT---
status: done
title: t
summary: s
threads:
${body}
---
`;

    it("parses thread records with numeric ids", () => {
      const out = parseReportBlock(withThreads(`  - id: 12
    verdict: fixed
    severity: low
    reason: renamed the variable
    reply: "Renamed it to retryCount."
  - id: 13
    verdict: needs_person
    severity: high
    reason: design question
    reply: ""`));
      expect(out.threads).toEqual([
        { id: 12, verdict: "fixed", severity: "low", reason: "renamed the variable", reply: "Renamed it to retryCount." },
        { id: 13, verdict: "needs_person", severity: "high", reason: "design question", reply: "" },
      ]);
    });

    it("drops records with an invalid verdict or a non-positive id", () => {
      const out = parseReportBlock(withThreads(`  - id: 1
    verdict: maybe
    severity: low
    reason: r
    reply: x
  - id: 0
    verdict: fixed
    severity: low
    reason: r
    reply: x
  - id: abc
    verdict: fixed
    severity: low
    reason: r
    reply: x
  - id: 4
    verdict: no_change
    severity: low
    reason: r
    reply: ok`));
      expect(out.threads.map(t => t.id)).toEqual([4]);
    });

    it("defaults an unknown severity to medium and a missing reply to empty", () => {
      const out = parseReportBlock(withThreads(`  - id: 5
    verdict: fixed
    severity: urgent
    reason: r`));
      expect(out.threads).toEqual([{ id: 5, verdict: "fixed", severity: "medium", reason: "r", reply: "" }]);
    });

    it("gives an empty list when there is no threads field", () => {
      expect(parseReportBlock(block).threads).toEqual([]);
    });
  });
});
