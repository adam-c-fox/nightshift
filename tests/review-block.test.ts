import { describe, expect, it } from "vitest";
import { parseFixesBlock, parseReviewBlock } from "../src/claude.js";

describe("parseReviewBlock", () => {
  it("parses every field of each finding", () => {
    const output = `Looked it over.

---REVIEW---
findings:
  - id: R1
    severity: blocker
    file: src/export.ts
    issue: Rows are buffered in memory, so large exports run out of memory.
    suggestion: Stream rows to the response.
  - id: R2
    severity: minor
    file: tests/export.spec.ts
    issue: "The test never asserts the header row."
    suggestion: 'Assert the first line equals the header.'
---
`;
    expect(parseReviewBlock(output).findings).toEqual([
      { id: "R1", severity: "blocker", file: "src/export.ts", issue: "Rows are buffered in memory, so large exports run out of memory.", suggestion: "Stream rows to the response." },
      { id: "R2", severity: "minor", file: "tests/export.spec.ts", issue: "The test never asserts the header row.", suggestion: "Assert the first line equals the header." },
    ]);
  });

  it("accepts an explicitly empty list", () => {
    expect(parseReviewBlock("---REVIEW---\nfindings: []\n---\n").findings).toEqual([]);
  });

  it("treats a missing findings key as empty only when the block exists", () => {
    expect(parseReviewBlock("---REVIEW---\n---\n").findings).toEqual([]);
  });

  it("throws when there is no block", () => {
    expect(() => parseReviewBlock("all good")).toThrow(/---REVIEW---/);
  });

  it("ranks an unknown severity as major rather than dropping the finding", () => {
    const [finding] = parseReviewBlock("---REVIEW---\nfindings:\n  - id: R1\n    severity: critical\n    file: a.ts\n    issue: Broken.\n    suggestion: Fix it.\n---\n").findings;
    expect(finding.severity).toBe("major");
  });

  it("numbers findings that lack an id and drops ones without an issue", () => {
    const output = "---REVIEW---\nfindings:\n  - severity: minor\n    file: a.ts\n    issue: One.\n    suggestion: s\n  - severity: minor\n    file: b.ts\n---\n";
    expect(parseReviewBlock(output).findings.map(f => f.id)).toEqual(["R1"]);
  });

  it("uses the last block when the agent quotes the format earlier", () => {
    const output = "---REVIEW---\nfindings:\n  - id: X\n---\nlater\n---REVIEW---\nfindings: []\n---\n";
    expect(parseReviewBlock(output).findings).toEqual([]);
  });

  describe("risks", () => {
    const block = (risks: string) => `---REVIEW---\nfindings: []\n${risks}---\n`;

    it("parses each risk", () => {
      const output = block("risks:\n  - file: services/x/src/poll.ts\n    risk: Retry could double-send.\n  - file: a.ts\n    risk: \"Confirm the new default.\"\n");
      expect(parseReviewBlock(output).risks).toEqual([
        { file: "services/x/src/poll.ts", risk: "Retry could double-send." },
        { file: "a.ts", risk: "Confirm the new default." },
      ]);
    });

    it("is empty when risks is absent or an empty list", () => {
      expect(parseReviewBlock(block("")).risks).toEqual([]);
      expect(parseReviewBlock(block("risks: []\n")).risks).toEqual([]);
    });

    it("keeps findings and risks apart", () => {
      const output = "---REVIEW---\nfindings:\n  - id: R1\n    severity: minor\n    file: a.ts\n    issue: Bad.\n    suggestion: Fix.\nrisks:\n  - file: b.ts\n    risk: Hmm.\n---\n";
      const parsed = parseReviewBlock(output);
      expect(parsed.findings.map(f => f.id)).toEqual(["R1"]);
      expect(parsed.risks).toEqual([{ file: "b.ts", risk: "Hmm." }]);
    });

    it("throws on a malformed risks list so the review counts as failed", () => {
      expect(() => parseReviewBlock(block("risks:\n  - just some words\n"))).toThrow(/risks/i);
      expect(() => parseReviewBlock(block("risks:\n  - file: a.ts\n"))).toThrow(/risks/i);
    });
  });
});

describe("parseFixesBlock", () => {
  const output = `---REPORT---
status: done
summary: Streams the export.
---
---FIXES---
- id: R1
  status: fixed
  how: Streamed rows to the response.
- id: R2
  status: not_fixed
  how: "Needs a product decision."
- id: R3
  status: maybe
  how: unclear
---
`;

  it("parses each resolution and defaults unknown statuses to not_fixed", () => {
    expect(parseFixesBlock(output)).toEqual([
      { id: "R1", status: "fixed", how: "Streamed rows to the response." },
      { id: "R2", status: "not_fixed", how: "Needs a product decision." },
      { id: "R3", status: "not_fixed", how: "unclear" },
    ]);
  });

  it("throws when there is no block", () => {
    expect(() => parseFixesBlock("---REPORT---\nstatus: done\n---\n")).toThrow(/---FIXES---/);
  });
});
