import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfirmBlock, type TicketBrief } from "../src/claude.js";
import { batchGroups, citationHolds, confirmAll, groupCandidates, judgeBatch, readCited, sortVerdicts, ticketQuoted, ticketText, type ConfirmDeps, type Group } from "../src/confirm.js";
import type { CandidateVerdict, ConfirmStage, RecordedCandidate, ReviewCandidate } from "../src/types.js";

const candidate = (id: string, file = "src/a.ts"): ReviewCandidate =>
  ({ id, lens: "bugs", kind: "finding", severity: "major", confidence: "proven", file, issue: `Problem ${id}.`, suggestion: `Fix ${id}.`, data: false });

const alone = (candidates: ReviewCandidate[]): Group[] => groupCandidates(candidates, []);

describe("groupCandidates and batchGroups", () => {
  it("puts at most four groups in a batch, in the order their keepers' files first appear", () => {
    const candidates = [candidate("B1", "b.ts"), candidate("B2", "a.ts"), candidate("B3", "b.ts"), candidate("B4", "c.ts"), candidate("B5", "a.ts")];
    const batches = batchGroups(alone(candidates));
    expect(batches.map(b => [b.n, b.candidates.map(c => c.id)])).toEqual([[1, ["B1", "B3", "B2", "B5"]], [2, ["B4"]]]);
  });

  it("keeps a group's members in the keeper's batch, marked grouped_with the keeper, whatever their file", () => {
    const candidates = [candidate("B1", "a.ts"), candidate("B2", "b.ts"), candidate("B3", "c.ts"), candidate("B4", "d.ts"), candidate("B5", "e.ts"), candidate("B6", "z.ts")];
    const batches = batchGroups(groupCandidates(candidates, [{ keep: "B5", same: ["B6", "B1"] }]), 2);
    expect(batches.map(b => b.candidates.map(c => c.id))).toEqual([["B2", "B3"], ["B4", "B5", "B6", "B1"]]);
    expect(batches[1].groupedWith).toEqual({ B6: "B5", B1: "B5" });
    expect(batches[0].groupedWith).toEqual({});
  });

  it("splits a file across batches when it has more than four groups", () => {
    const candidates = ["B1", "B2", "B3", "B4", "B5", "B6"].map(id => candidate(id));
    expect(batchGroups(alone(candidates)).map(b => b.candidates.length)).toEqual([4, 2]);
  });

  it("makes each candidate its own group without dedupe groups", () => {
    const candidates = [candidate("B1"), candidate("B2")];
    expect(alone(candidates)).toEqual([{ keep: candidates[0], same: [] }, { keep: candidates[1], same: [] }]);
  });

  it("ignores unknown ids and an id already grouped", () => {
    const candidates = [candidate("B1"), candidate("B2"), candidate("B3"), candidate("B4")];
    const groups = groupCandidates(candidates, [
      { keep: "B1", same: ["B2", "B2", "X9", "B1"] },
      { keep: "B3", same: ["B2"] },
      { keep: "B2", same: ["B4"] },
      { keep: "X1", same: ["B4"] },
      { keep: "B3", same: ["B4", "B1"] },
    ]);
    expect(groups.map(g => [g.keep.id, g.same.map(c => c.id)])).toEqual([["B1", ["B2"]], ["B3", ["B4"]]]);
  });
});

describe("citationHolds", () => {
  const files: Record<string, string> = {
    "src/a.ts": ["line one", "  if (!input.length) return [];", "const value = compute(input);", "return value;", "// end of function", "export default 1;", "tail line here"].join("\n"),
  };
  const source = (file: string) => files[file];
  const code = "if (!input.length) return [];";

  it("holds when the quoted code is on the cited line", () => {
    expect(citationHolds("src/a.ts:2", code, source)).toBe("holds");
  });

  it("holds when the code is within two lines of the cited line or spans lines", () => {
    expect(citationHolds("src/a.ts:4", code, source)).toBe("holds");
    expect(citationHolds("src/a.ts:3-4", "const value = compute(input); return value;", source)).toBe("holds");
  });

  it("ignores whitespace and backslash-escaped quotes", () => {
    expect(citationHolds("`src/a.ts:3`", "const   value =\n compute(input);", source)).toBe("holds");
    const quoted = { "src/q.ts": 'throw new Error("bad input given");' };
    expect(citationHolds("src/q.ts:1", 'throw new Error(\\"bad input given\\");', f => quoted[f as keyof typeof quoted])).toBe("holds");
  });

  it("is missing without evidence or code", () => {
    expect(citationHolds(undefined, code, source)).toBe("missing");
    expect(citationHolds("src/a.ts:2", undefined, source)).toBe("missing");
    expect(citationHolds("  ", code, source)).toBe("missing");
    expect(citationHolds("src/a.ts:2", "   ", source)).toBe("missing");
  });

  it("is unreadable for a malformed reference, a missing file or a line past the end", () => {
    expect(citationHolds("src/a.ts", code, source)).toBe("unreadable");
    expect(citationHolds("src/none.ts:2", code, source)).toBe("unreadable");
    expect(citationHolds("src/a.ts:8", code, source)).toBe("unreadable");
    expect(citationHolds("src/a.ts:0", code, source)).toBe("unreadable");
    expect(citationHolds("src/a.ts:4-3", code, source)).toBe("unreadable");
  });

  it("reads a line reference with L-prefixed numbers", () => {
    expect(citationHolds("src/a.ts:L2", code, source)).toBe("holds");
    expect(citationHolds("src/a.ts:L3-L4", "const value = compute(input); return value;", source)).toBe("holds");
    expect(citationHolds("src/a.ts:L2-4", code, source)).toBe("holds");
  });

  it("is a mismatch when the code is not near the cited line", () => {
    expect(citationHolds("src/a.ts:7", code, source)).toBe("mismatch");
    expect(citationHolds("src/a.ts:2", "return somethingElse(input);", source)).toBe("mismatch");
  });

  it("does not accept a quote too short to identify a line", () => {
    expect(citationHolds("src/a.ts:2", "if (", source)).toBe("missing");
    expect(citationHolds("src/a.ts:2", "  } ;  ", source)).toBe("missing");
  });
});

describe("readCited", () => {
  const root = mkdtempSync(path.join(tmpdir(), "confirm-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\n");

  it("reads a file inside the worktree", () => {
    expect(readCited(root, "src/a.ts")).toBe("const a = 1;\n");
  });

  it("reads an absolute path inside the worktree", () => {
    expect(readCited(root, path.join(root, "src", "a.ts"))).toBe("const a = 1;\n");
  });

  it("reads a real-path citation when the worktree is given through a symlinked directory", () => {
    expect(readCited(root, path.join(realpathSync(root), "src", "a.ts"))).toBe("const a = 1;\n");
  });

  it("refuses a symlink inside the worktree that points outside it", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "confirm-outside-"));
    writeFileSync(path.join(outside, "secret.ts"), "const secret = 1;\n");
    symlinkSync(path.join(outside, "secret.ts"), path.join(root, "src", "link.ts"));
    expect(readCited(root, "src/link.ts")).toBeUndefined();
  });

  it("refuses a path that leaves the worktree, absolute or not", () => {
    expect(readCited(root, "../outside.ts")).toBeUndefined();
    expect(readCited(root, "src/../../outside.ts")).toBeUndefined();
    expect(readCited(root, path.join(path.dirname(root), "outside.ts"))).toBeUndefined();
    expect(readCited(root, "/etc/hosts")).toBeUndefined();
  });

  it("is undefined for a missing file", () => {
    expect(readCited(root, "src/none.ts")).toBeUndefined();
    expect(readCited(root, "src")).toBeUndefined();
  });
});

describe("ticketQuoted", () => {
  const text = ["Export must be **streamed** row by row.", "- Never load the `whole table` in memory", "1. Keep the CSV header"].join("\n");

  it("finds a quote in the description, a comment or the operator context, ignoring case and markdown", () => {
    expect(ticketQuoted("export must be streamed row by row", text)).toBe(true);
    expect(ticketQuoted('"Never load the whole table in memory"', text)).toBe(true);
    expect(ticketQuoted("Keep the CSV header", text)).toBe(true);
    expect(ticketQuoted("Don’t   Load \\\"X\\\" here", "Comment: don't load \"x\" here, ever")).toBe(true);
  });

  it("does not find a paraphrase or a quote too short to check", () => {
    expect(ticketQuoted("rows should be streamed to the export", text)).toBe(false);
    expect(ticketQuoted("streamed", text)).toBe(false);
    expect(ticketQuoted(undefined, text)).toBe(false);
  });
});

describe("ticketText", () => {
  const brief: TicketBrief = {
    ticketId: "ENG-1", ticketName: "Never drop rows silently", context: ["Keep the CSV header"], linearDesc: "Export as CSV.",
    linearComments: [{ author: "a", createdAt: "2026-01-01", body: "Stream it row by row." }], linearUrl: "", state: "In Progress",
  };

  it("includes the title, the description, the comments and the operator context", () => {
    for (const line of ["Never drop rows silently", "Export as CSV.", "Stream it row by row.", "Keep the CSV header"]) expect(ticketQuoted(line, ticketText(brief))).toBe(true);
  });
});

describe("judgeBatch", () => {
  const source = () => "const a = 1;\nif (!input.length) return [];\nconst b = 2;\n";
  const batch = { n: 1, candidates: [candidate("B1")], groupedWith: {} };

  it("overturns a rejection whose happens admits the behaviour with a qualifier", () => {
    const verdicts = parseConfirmBlock(
      '---CONFIRM---\n- id: B1\n  verdict: rejected\n  happens: yes, but only on empty input\n  evidence: src/a.ts:2\n  code: "if (!input.length) return [];"\n  note: Guarded.\n---\n');
    const [judged] = judgeBatch(batch, verdicts, source, "");
    expect(judged.verdict).toMatchObject({ verdict: "unproven", citation: "holds", adjusted: { from: "rejected" } });
  });
});

describe("sortVerdicts", () => {
  it("numbers findings from the given start", () => {
    const confirmed = (id: string): RecordedCandidate => ({ ...candidate(id), verdict: { id, verdict: "confirmed", note: "" } });
    const { findings } = sortVerdicts([confirmed("B1"), confirmed("B2")], 3);
    expect(findings.map(f => `${f.id}:${f.from}`)).toEqual(["R3:B1", "R4:B2"]);
  });

  const conflict = (over: Partial<CandidateVerdict> = {}): RecordedCandidate =>
    ({ ...candidate("B1"), verdict: { id: "B1", verdict: "ticket_conflict", ticket: "Rows must never be dropped", quoted: true, note: "the reviewer reasoned about the verdict", ...over } });

  it("reports a conflict's consequence from the candidate's issue, never from the verdict note", () => {
    const { conflicts } = sortVerdicts([conflict({ change: "Return an error instead" })]);
    expect(conflicts).toMatchObject([{ from: "B1", consequence: "Problem B1.", change: "Return an error instead" }]);
  });

  it("leaves the change out of a conflict that has none", () => {
    const [direct] = sortVerdicts([conflict()]).conflicts;
    const [overturned] = sortVerdicts([conflict({ adjusted: { from: "rejected" } })]).conflicts;
    for (const c of [direct, overturned]) {
      expect(c).not.toHaveProperty("change");
      expect(c.consequence).toBe("Problem B1.");
    }
  });
});

describe("confirmAll stage names", () => {
  const harness = () => {
    const saved: string[] = [];
    const dedupeStages: (ConfirmStage | undefined)[] = [];
    const confirmStages: (ConfirmStage | undefined)[] = [];
    const deps: ConfirmDeps = {
      snapshot: () => "same",
      gateOpen: () => true,
      confirm: async (batch, stage) => {
        confirmStages.push(stage);
        return { success: true, rawOutput: "", verdicts: batch.candidates.map(c => ({ id: c.id, verdict: "unproven" as const, note: "" })) };
      },
      dedupe: async (_candidates, stage) => {
        dedupeStages.push(stage);
        return { success: true, rawOutput: "", groups: [] };
      },
      source: () => undefined,
      ticketText: "",
      saveOutput: stage => { saved.push(stage); },
      log: () => {},
    };
    return { deps, saved, dedupeStages, confirmStages };
  };
  const five = ["B1", "B2", "B3", "B4", "B5"].map(id => candidate(id));

  it("names the dedupe and batch logs after the prefix and passes the stage to confirm and dedupe", async () => {
    const { deps, saved, dedupeStages, confirmStages } = harness();
    await confirmAll(five, deps, "fix-review");
    expect(saved).toEqual(["fix-review-dedupe", "fix-review-confirm-1", "fix-review-confirm-2"]);
    expect(dedupeStages).toEqual(["fix-review-dedupe"]);
    expect(confirmStages).toEqual(["fix-review-confirm-1", "fix-review-confirm-2"]);
  });

  it("defaults to the review prefix", async () => {
    const { deps, saved, dedupeStages, confirmStages } = harness();
    await confirmAll(five, deps);
    expect(saved).toEqual(["review-dedupe", "review-confirm-1", "review-confirm-2"]);
    expect(dedupeStages).toEqual(["review-dedupe"]);
    expect(confirmStages).toEqual(["review-confirm-1", "review-confirm-2"]);
  });
});
