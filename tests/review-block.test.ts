import { describe, expect, it } from "vitest";
import { parseConfirmBlock, parseFixesBlock, parseReviewBlock, parseVerifyBlock } from "../src/claude.js";

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
      { id: "R1", severity: "blocker", file: "src/export.ts", issue: "Rows are buffered in memory, so large exports run out of memory.", suggestion: "Stream rows to the response.", confidence: "proven" },
      { id: "R2", severity: "minor", file: "tests/export.spec.ts", issue: "The test never asserts the header row.", suggestion: "Assert the first line equals the header.", confidence: "proven" },
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
        { file: "services/x/src/poll.ts", risk: "Retry could double-send.", data: false },
        { file: "a.ts", risk: "Confirm the new default.", data: false },
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
      expect(parsed.risks).toEqual([{ file: "b.ts", risk: "Hmm.", data: false }]);
    });

    it("throws on a malformed risks list so the review counts as failed", () => {
      expect(() => parseReviewBlock(block("risks:\n  - just some words\n"))).toThrow(/risks/i);
      expect(() => parseReviewBlock(block("risks:\n  - file: a.ts\n"))).toThrow(/risks/i);
    });
  });
});

describe("parseReviewBlock extensions", () => {
  const wrap = (body: string) => `---REVIEW---\n${body}---\n`;

  it("still parses a block with no confidence, data or rulings", () => {
    const parsed = parseReviewBlock(wrap("findings:\n  - id: R1\n    severity: minor\n    file: a.ts\n    issue: Bad.\n    suggestion: Fix.\nrisks:\n  - file: b.ts\n    risk: Hmm.\n"));
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.risks).toHaveLength(1);
    expect(parsed.rulings).toEqual([]);
  });

  it("parses confidence and decision on findings, defaulting to proven", () => {
    const parsed = parseReviewBlock(wrap("findings:\n  - id: R1\n    severity: major\n    confidence: suspected\n    decision: D3\n    file: a.ts\n    issue: One.\n    suggestion: s\n  - id: R2\n    severity: major\n    confidence: bogus\n    file: a.ts\n    issue: Two.\n    suggestion: s\n  - id: R3\n    severity: major\n    file: a.ts\n    issue: Three.\n    suggestion: s\n"));
    expect(parsed.findings.map(f => f.confidence)).toEqual(["suspected", "proven", "proven"]);
    expect(parsed.findings.map(f => f.decision)).toEqual(["D3", undefined, undefined]);
  });

  it("parses data on risks, defaulting to no", () => {
    const parsed = parseReviewBlock(wrap("findings: []\nrisks:\n  - file: a.ts\n    risk: One.\n    data: yes\n  - file: b.ts\n    risk: Two.\n    data: no\n  - file: c.ts\n    risk: Three.\n"));
    expect(parsed.risks.map(r => r.data)).toEqual([true, false, false]);
  });

  it("parses rulings, treating an unknown ruling as unruled", () => {
    const parsed = parseReviewBlock(wrap("findings: []\nrulings:\n  - id: D1\n    ruling: accept\n    reason: Holds on every path.\n  - id: D2\n    ruling: finding\n    reason: Drops rows.\n  - id: D3\n    ruling: risk\n    reason: Unclear.\n  - id: D4\n    ruling: maybe\n    reason: Eh.\n"));
    expect(parsed.rulings).toEqual([
      { id: "D1", ruling: "accept", reason: "Holds on every path." },
      { id: "D2", ruling: "finding", reason: "Drops rows." },
      { id: "D3", ruling: "risk", reason: "Unclear." },
      { id: "D4", ruling: "unruled", reason: "Eh." },
    ]);
  });
});

describe("parseConfirmBlock", () => {
  const output = `Checked.

---CONFIRM---
- id: B1
  verdict: confirmed
  severity: blocker
  note: Line 12 reads only the first row.
- id: S1
  verdict: duplicate
  duplicate_of: B1
  note: Same line.
- id: B2
  verdict: unproven
  data: yes
  note: "Cannot tell: depends on the provider."
- id: U1
  verdict: rejected
  note: The helper differs.
- id: B3
  verdict: maybe
  note: unclear
---
`;

  it("parses verdict, duplicate_of, severity, data and note", () => {
    expect(parseConfirmBlock(output)).toEqual([
      { id: "B1", verdict: "confirmed", severity: "blocker", note: "Line 12 reads only the first row." },
      { id: "S1", verdict: "duplicate", duplicateOf: "B1", note: "Same line." },
      { id: "B2", verdict: "unproven", data: true, note: "Cannot tell: depends on the provider." },
      { id: "U1", verdict: "rejected", note: "The helper differs." },
      { id: "B3", verdict: "unproven", note: "unclear" },
    ]);
  });

  it("treats an unknown verdict as unproven", () => {
    expect(parseConfirmBlock(output).find(v => v.id === "B3")?.verdict).toBe("unproven");
  });

  it("throws when there is no block", () => {
    expect(() => parseConfirmBlock("---REVIEW---\nfindings: []\n---\n")).toThrow(/---CONFIRM---/);
  });

  it("uses the last block when the format is quoted earlier", () => {
    const quoted = "---CONFIRM---\n- id: X\n  verdict: rejected\n---\nlater\n---CONFIRM---\n- id: B1\n  verdict: confirmed\n  note: n\n---\n";
    expect(parseConfirmBlock(quoted).map(v => v.id)).toEqual(["B1"]);
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

describe("parseVerifyBlock", () => {
  const output = `Checked.

---VERIFY---
- id: R1
  status: resolved
  note: Rows now stream.
- id: R2
  status: unresolved
  note: "Header is still missing: see line 4."
- id: R3
  status: maybe
  note: unclear
---
`;

  it("parses each result and treats anything but resolved as unresolved", () => {
    expect(parseVerifyBlock(output)).toEqual([
      { id: "R1", status: "resolved", note: "Rows now stream." },
      { id: "R2", status: "unresolved", note: "Header is still missing: see line 4." },
      { id: "R3", status: "unresolved", note: "unclear" },
    ]);
  });

  it("throws when there is no block", () => {
    expect(() => parseVerifyBlock("---REVIEW---\nfindings: []\n---\n")).toThrow(/---VERIFY---/);
  });
});
