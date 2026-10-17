import { describe, expect, it } from "vitest";
import { parseConfirmBlock, parseDedupeBlock, parseFixesBlock, parseFixReviewBlock, parseReviewBlock } from "../src/claude.js";

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

  it("unescapes quotes and backslashes in a double-quoted value", () => {
    const output = `---REVIEW---
findings:
  - id: R1
    severity: minor
    file: src/log.ts
    issue: "logs extension \\"jones\\" verbatim in C:\\\\tmp"
    suggestion: Fix.
---
`;
    expect(parseReviewBlock(output).findings[0].issue).toBe('logs extension "jones" verbatim in C:\\tmp');
  });

  it("leaves a single-quoted or unquoted value exactly as written", () => {
    const output = `---REVIEW---
findings:
  - id: R1
    severity: minor
    file: src/log.ts
    issue: 'logs extension \\"jones\\" in C:\\\\tmp'
    suggestion: Log \\"jones\\" in C:\\\\tmp
---
`;
    const [finding] = parseReviewBlock(output).findings;
    expect(finding.issue).toBe('logs extension \\"jones\\" in C:\\\\tmp');
    expect(finding.suggestion).toBe('Log \\"jones\\" in C:\\\\tmp');
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

  it("parses happens as yes or no", () => {
    const block = `---CONFIRM---
- id: U1
  verdict: rejected
  happens: yes
  note: a
- id: U2
  verdict: rejected
  happens: no
  note: b
- id: U3
  verdict: rejected
  note: c
---
`;
    const [u1, u2, u3] = parseConfirmBlock(block);
    expect(u1.happens).toBe(true);
    expect(u2.happens).toBe(false);
    expect("happens" in u3).toBe(false);
  });

  it("treats a happens value that is not a bare no or false as true", () => {
    const block = "---CONFIRM---\n- id: U1\n  verdict: rejected\n  happens: yes, but only on empty input\n  note: a\n- id: U2\n  verdict: rejected\n  happens: False\n  note: b\n---\n";
    expect(parseConfirmBlock(block).map(v => v.happens)).toEqual([true, false]);
  });

  it("treats an unknown verdict as unproven", () => {
    expect(parseConfirmBlock(output).find(v => v.id === "B3")?.verdict).toBe("unproven");
  });

  it("parses evidence, code, ticket and change", () => {
    const block = `---CONFIRM---
- id: U1
  verdict: rejected
  evidence: src/a.ts:12
  code: "if (!rows.length) return [];"
  note: Guarded.
- id: S1
  verdict: ticket_conflict
  data: yes
  ticket: "Log only the extension"
  change: Log a closed list of extensions.
  note: Logs arbitrary text.
---
`;
    expect(parseConfirmBlock(block)).toEqual([
      { id: "U1", verdict: "rejected", evidence: "src/a.ts:12", code: "if (!rows.length) return [];", note: "Guarded." },
      { id: "S1", verdict: "ticket_conflict", data: true, ticket: "Log only the extension", change: "Log a closed list of extensions.", note: "Logs arbitrary text." },
    ]);
  });

  it("parses a ticket_conflict verdict", () => {
    expect(parseConfirmBlock("---CONFIRM---\n- id: S1\n  verdict: ticket_conflict\n  note: n\n---\n")[0].verdict).toBe("ticket_conflict");
  });

  it("throws when there is no block", () => {
    expect(() => parseConfirmBlock("---REVIEW---\nfindings: []\n---\n")).toThrow(/---CONFIRM---/);
  });

  it("uses the last block when the format is quoted earlier", () => {
    const quoted = "---CONFIRM---\n- id: X\n  verdict: rejected\n---\nlater\n---CONFIRM---\n- id: B1\n  verdict: confirmed\n  note: n\n---\n";
    expect(parseConfirmBlock(quoted).map(v => v.id)).toEqual(["B1"]);
  });
});

describe("parseDedupeBlock", () => {
  it("parses each group's keeper and the ids it absorbs", () => {
    const output = "Grouped.\n\n---DEDUPE---\n- keep: S2\n  same: B1, B5\n- keep: B3\n  same: B12\n---\n";
    expect(parseDedupeBlock(output)).toEqual([{ keep: "S2", same: ["B1", "B5"] }, { keep: "B3", same: ["B12"] }]);
  });

  it("accepts a bracketed list of ids", () => {
    expect(parseDedupeBlock("---DEDUPE---\n- keep: S2\n  same: [B1, B5]\n---\n")).toEqual([{ keep: "S2", same: ["B1", "B5"] }]);
    expect(parseDedupeBlock("---DEDUPE---\n- keep: S2\n  same: [B1]\n---\n")).toEqual([{ keep: "S2", same: ["B1"] }]);
  });

  it("is empty when the block lists no group", () => {
    expect(parseDedupeBlock("---DEDUPE---\n---\n")).toEqual([]);
  });

  it("throws when there is no block", () => {
    expect(() => parseDedupeBlock("---CONFIRM---\n---\n")).toThrow(/---DEDUPE---/);
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

describe("parseFixReviewBlock", () => {
  const output = `Checked.

---FIXREVIEW---
results:
  - id: R1
    status: resolved
    note: Rows now stream.
  - id: R2
    status: maybe
    note: "Header is still missing: see line 4."
findings:
  - id: R1
    severity: minor
    confidence: suspected
    file: src/a.ts
    issue: Helper change also reaches the second caller.
    suggestion: Add a test through the second caller.
risks:
  - file: src/b.ts
    risk: The export is wider than before.
    data: yes
---
`;

  it("parses results, findings and risks", () => {
    expect(parseFixReviewBlock(output)).toEqual({
      results: [
        { id: "R1", status: "resolved", note: "Rows now stream." },
        { id: "R2", status: "unresolved", note: "Header is still missing: see line 4." },
      ],
      findings: [{ id: "R1", severity: "minor", confidence: "suspected", file: "src/a.ts", issue: "Helper change also reaches the second caller.", suggestion: "Add a test through the second caller." }],
      risks: [{ file: "src/b.ts", risk: "The export is wider than before.", data: true }],
    });
  });

  it("treats any status other than resolved as unresolved", () => {
    const { results } = parseFixReviewBlock("---FIXREVIEW---\nresults:\n  - id: R1\n    status: done\n    note: n\nfindings: []\nrisks: []\n---\n");
    expect(results).toEqual([{ id: "R1", status: "unresolved", note: "n" }]);
  });

  it("reads findings: [] and risks: [] as empty", () => {
    const parsed = parseFixReviewBlock("---FIXREVIEW---\nresults:\n  - id: R1\n    status: resolved\n    note: ok\nfindings: []\nrisks: []\n---\n");
    expect(parsed.findings).toEqual([]);
    expect(parsed.risks).toEqual([]);
  });

  it("parses findings exactly as the REVIEW block does", () => {
    const lines = "findings:\n  - issue: No default.\n    file: src/a.ts\n  - id: R2\n    severity: blocker\n    issue: Broken.\n    suggestion: Fix.\n";
    const fromReview = parseReviewBlock(`---REVIEW---\n${lines}risks: []\n---\n`).findings;
    const fromFixReview = parseFixReviewBlock(`---FIXREVIEW---\nresults: []\n${lines}risks: []\n---\n`).findings;
    expect(fromFixReview).toEqual(fromReview);
    expect(fromFixReview[0]).toMatchObject({ severity: "major", confidence: "proven" });
  });

  it("throws naming ---FIXREVIEW--- when the block is missing", () => {
    expect(() => parseFixReviewBlock("---REVIEW---\nfindings: []\n---\n")).toThrow(/---FIXREVIEW---/);
  });
});
