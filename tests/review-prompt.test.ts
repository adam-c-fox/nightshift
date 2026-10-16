import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildConfirmPrompt, buildDedupePrompt, buildFinderPrompt, buildFixPrompt, buildFixReviewPrompt, type AgentReport, type TicketBrief } from "../src/claude.js";
import type { ClassifiedCheck } from "../src/checks.js";
import type { ReviewCandidate, ReviewFinding } from "../src/types.js";

const brief: TicketBrief = { ticketId: "ENG-12", ticketName: "Poll", context: [], linearDesc: "", linearComments: [], linearUrl: "u", state: "Todo" };

const check = (command: string, status: ClassifiedCheck["status"], passed: boolean, outputTail = ""): ClassifiedCheck =>
  ({ name: command, command, status, passed, durationSec: 7, outputTail });

const report = (over: Partial<AgentReport> = {}): AgentReport => ({
  status: "done", title: "t", summary: "s", filesCreated: [], filesModified: [], tests: [], verifyCommands: [], notes: "(1) skip empty rows", followups: [], decisions: [], ...over,
});

describe("finder prompt sections", () => {
  it("has no checks or related sections by default", () => {
    const prompt = buildFinderPrompt("spec", brief, undefined, "origin/main");
    expect(prompt).not.toMatch(/Check results|Related ticket/);
  });

  it("lists every check with its status and says the runner ran them", () => {
    const prompt = buildFinderPrompt("spec", brief, undefined, "origin/main", { checks: [
      check("npm run build", "passed", true),
      check("npm run lint", "regression", false, "LINT-BOOM"),
      check("npm run format", "pre-existing", false, "FORMAT-OLD"),
      check("npx vitest run", "new", true),
    ] });
    expect(prompt).toMatch(/runner already ran these/);
    expect(prompt).toMatch(/do not need to re-run/);
    expect(prompt).toContain("`npm run build`: passed (7s)");
    expect(prompt).toMatch(/`npm run lint`: REGRESSION/);
    expect(prompt).toMatch(/`npm run format`: pre-existing failure/);
    expect(prompt).toMatch(/`npx vitest run`: new check, passed/);
  });

  it("labels a check that did not run so the reviewer treats it as unproven", () => {
    const prompt = buildFinderPrompt("spec", brief, undefined, "origin/main", { checks: [check("npm test -w services/a", "not-run", false, "No workspaces found")] });
    expect(prompt).toContain("`npm test -w services/a`: DID NOT RUN (failed without starting; the tests it covers are unproven) (7s)");
  });

  it("tells the reviewer a check that did not run is not pre-existing", () => {
    const reviewMd = readFileSync(new URL("../prompts/review.md", import.meta.url), "utf-8");
    expect(reviewMd).toMatch(/is not pre-existing: it did not run/);
  });

  it("includes output only for the checks that did not pass", () => {
    const prompt = buildFinderPrompt("spec", brief, undefined, "origin/main", { checks: [
      check("npm run build", "passed", true, "BUILD-NOISE"),
      check("npm run lint", "regression", false, "LINT-BOOM"),
      check("npm run format", "pre-existing", false, "FORMAT-OLD"),
    ] });
    expect(prompt).toContain("LINT-BOOM");
    expect(prompt).toContain("FORMAT-OLD");
    expect(prompt).not.toContain("BUILD-NOISE");
  });

  it("adds a line per related ticket with the diff command", () => {
    const prompt = buildFinderPrompt("reuse", brief, undefined, "origin/main", { related: [{ ticketId: "ENG-10", branch: "feat/eng-10-x" }, { ticketId: "ENG-11", branch: "feat/eng-11-y" }] });
    expect(prompt).toContain("Related ticket ENG-10 was implemented earlier this session on branch feat/eng-10-x. Check that both sides of any shared contract agree: `git diff origin/main...feat/eng-10-x`.");
    expect(prompt).toContain("`git diff origin/main...feat/eng-11-y`");
  });
});

describe("ticket section", () => {
  it("leaves out the comments heading when the ticket has none", () => {
    expect(buildFinderPrompt("spec", brief, undefined, "origin/main")).not.toMatch(/Linear comments/);
  });

  it("lists every comment with its author and date, keeping multi-line bodies indented", () => {
    const prompt = buildFinderPrompt("spec", { ...brief, linearComments: [
      { author: "Adam", createdAt: "2026-10-01T09:00:00.000Z", body: "Skip empty files.\nMark them read." },
      { author: "Sam", createdAt: "2026-10-02T09:00:00.000Z", body: "Agreed." },
    ] }, undefined, "origin/main");
    expect(prompt).toContain("**Linear comments (oldest first):**\n  - Adam, 2026-10-01: Skip empty files.\n    Mark them read.\n  - Sam, 2026-10-02: Agreed.");
  });
});

describe("buildFixReviewPrompt", () => {
  const findings = [
    { id: "R1", severity: "blocker" as const, file: "src/a.ts", issue: "Buffers rows.", suggestion: "Stream." },
    { id: "R2", severity: "major" as const, file: "src/b.ts", issue: "No header.", suggestion: "Add it." },
  ];
  const resolutions = [
    { id: "R1", status: "fixed" as const, how: "Streamed rows." },
    { id: "R2", status: "not_fixed" as const, how: "Disagree." },
  ];
  const scope = { from: "tree-before", to: "tree-after", files: "M\tsrc/a.ts\nA\ttests/a.test.ts" };
  const added = [{ file: "src/a.ts", decision: "Rows stream in chunks of 100." }];
  const prompt = buildFixReviewPrompt(brief, "origin/main", scope, findings, resolutions, added);

  it("names the ticket, the base ref and the fixer's diff between the two trees, and asks for the FIXREVIEW block", () => {
    expect(prompt).toContain("ENG-12");
    expect(prompt).toContain("git diff origin/main");
    expect(prompt).toContain("git diff tree-before tree-after");
    expect(prompt).toContain("git show tree-before:<path>");
    expect(prompt).toContain("---FIXREVIEW---");
    expect(prompt).toMatch(/Do not modify any file/);
  });

  it("lists the fixer's files", () => {
    expect(prompt).toContain("M\tsrc/a.ts\nA\ttests/a.test.ts");
  });

  it("says the fixer changed no files when both trees are the same", () => {
    const same = buildFixReviewPrompt(brief, "origin/main", { from: "t1", to: "t1", files: "" }, findings, resolutions, []);
    expect(same).toMatch(/fixer changed no files/);
    expect(same).not.toContain("git diff t1 t1");
  });

  it("lists every issue with the fixer's status and account", () => {
    expect(prompt).toContain("id: R1");
    expect(prompt).toContain("issue: Buffers rows.");
    expect(prompt).toContain("fixer's status: fixed");
    expect(prompt).toContain("fixer says: Streamed rows.");
    expect(prompt).toContain("id: R2");
    expect(prompt).toContain("fixer's status: not_fixed");
    expect(prompt).toContain("fixer says: Disagree.");
    expect(prompt).toMatch(/claims.*R1/);
  });

  it("lists the decisions the fixer added", () => {
    expect(prompt).toContain("**Decisions the fixer added (claims, not facts):**");
    expect(prompt).toContain("- (src/a.ts): Rows stream in chunks of 100.");
    expect(buildFixReviewPrompt(brief, "origin/main", scope, findings, resolutions, [])).not.toContain("Decisions the fixer added");
  });

  it("lists the check results when given and has no checks section otherwise", () => {
    const withChecks = buildFixReviewPrompt(brief, "origin/main", scope, findings, resolutions, added, { checks: [
      check("npm run lint", "regression", false, "src/a.ts:1 unused variable"),
      check("npm test", "passed", true),
    ] });
    expect(withChecks).toContain("Check results");
    expect(withChecks).toContain("`npm run lint`");
    expect(withChecks).toContain("`npm test`");
    expect(withChecks).toContain("src/a.ts:1 unused variable");
    expect(prompt).not.toContain("Check results");
  });

  it("points the review at destination-folder.ts and the fixer's code-point decision", () => {
    const demo = buildFixReviewPrompt(
      brief, "origin/main",
      { from: "aaa111", to: "bbb222", files: "M\tservices/import-worker/src/filename.ts\nM\tservices/import-worker/src/destination-folder.ts\nM\tservices/import-worker/tests/filename.test.ts" },
      [
        { id: "R1", severity: "major", file: "services/import-worker/src/filename.ts", issue: "Filename stems are not capped.", suggestion: "Cap them." },
        { id: "R2", severity: "major", file: "services/import-worker/src/destination-folder.ts", issue: "`cleaned.slice(0, MAX_FOLDER_NAME_LENGTH)` cuts on UTF-16 code units and can split a surrogate pair.", suggestion: "Cut on code points." },
        { id: "R3", severity: "minor", file: "services/import-worker/tests/filename.test.ts", issue: "No test for long names.", suggestion: "Add one." },
      ],
      [{ id: "R1", status: "fixed", how: "Capped." }, { id: "R2", status: "fixed", how: "Cut on code points." }, { id: "R3", status: "fixed", how: "Added." }],
      [{ file: "services/import-worker/src/destination-folder.ts", decision: "The 100-character cap counts code points, so a surrogate pair is never split, for both filename stems and destination folder names." }],
    );
    expect(demo).toContain("git diff aaa111 bbb222");
    expect(demo).toContain("M\tservices/import-worker/src/destination-folder.ts");
    expect(demo).toContain("The 100-character cap counts code points, so a surrogate pair is never split, for both filename stems and destination folder names.");
  });
});

describe("buildFinderPrompt", () => {
  const related = [{ ticketId: "ENG-10", branch: "feat/eng-10-x" }];

  it("gives related tickets only to the reuse lens", () => {
    expect(buildFinderPrompt("reuse", brief, report(), "origin/main", { related })).toContain("Related ticket ENG-10");
    expect(buildFinderPrompt("bugs", brief, report(), "origin/main", { related })).not.toContain("Related ticket");
    expect(buildFinderPrompt("spec", brief, report(), "origin/main", { related })).not.toContain("Related ticket");
  });

  it("keeps the ticket, base ref and checks for every lens", () => {
    for (const lens of ["bugs", "spec", "reuse"] as const) {
      const prompt = buildFinderPrompt(lens, brief, report(), "origin/main", { checks: [check("npm run lint", "passed", true)] });
      expect(prompt).toContain("ENG-12");
      expect(prompt).toContain("git diff origin/main");
      expect(prompt).toContain("`npm run lint`: passed (7s)");
      expect(prompt).toContain("---REVIEW---");
    }
  });

  it("lists decisions as D1.. only for the bugs lens", () => {
    const decisions = [{ file: "src/a.ts", decision: "Empty rows are skipped." }, { file: "src/b.ts", decision: "Invalid files throw." }];
    const bugs = buildFinderPrompt("bugs", brief, report({ decisions }), "origin/main");
    expect(bugs).toContain("rule on each one");
    expect(bugs).toContain("D1 (src/a.ts): Empty rows are skipped.");
    expect(bugs).toContain("D2 (src/b.ts): Invalid files throw.");
    for (const lens of ["spec", "reuse"] as const) {
      expect(buildFinderPrompt(lens, brief, report({ decisions }), "origin/main")).not.toContain("D1");
    }
  });

  it("tells the bugs lens to take choices from the notes when the report has no decisions", () => {
    const prompt = buildFinderPrompt("bugs", brief, report(), "origin/main");
    expect(prompt).toMatch(/lists no decisions/);
    expect(prompt).toMatch(/Notes/);
    expect(prompt).toContain("`N1`, `N2`, …");
    expect(prompt).not.toContain("D1 (");
  });
});

describe("buildConfirmPrompt", () => {
  const candidates: ReviewCandidate[] = [
    { id: "B1", lens: "bugs", kind: "finding", severity: "major", confidence: "suspected", file: "src/a.ts", issue: "Reads only the first row.", suggestion: "Read all rows.", data: false },
    { id: "U2", lens: "reuse", kind: "risk", severity: "minor", confidence: "proven", file: "src/b.ts", issue: "Duplicates the download helper.", suggestion: "", data: true },
  ];
  const prompt = buildConfirmPrompt(brief, undefined, "origin/main", { n: 1, candidates, groupedWith: {} });

  it("lists each candidate with id, lens, kind, confidence, file and issue", () => {
    expect(prompt).toContain("id: B1");
    expect(prompt).toContain("lens: bugs");
    expect(prompt).toContain("kind: finding");
    expect(prompt).toContain("confidence: suspected");
    expect(prompt).toContain("file: src/a.ts");
    expect(prompt).toContain("issue: Reads only the first row.");
    expect(prompt).toContain("id: U2");
    expect(prompt).toContain("kind: risk");
  });

  it("names the ticket and base ref and asks for the CONFIRM block", () => {
    expect(prompt).toContain("ENG-12");
    expect(prompt).toContain("git diff origin/main");
    expect(prompt).toContain("---CONFIRM---");
    expect(prompt).toMatch(/Do not modify any file/);
  });

  it("marks a grouped member with grouped_with its keeper", () => {
    const grouped = buildConfirmPrompt(brief, undefined, "origin/main", { n: 1, candidates, groupedWith: { U2: "B1" } });
    expect(grouped).toContain("  grouped_with: B1");
    expect(prompt).not.toContain("grouped_with");
  });

  it("lists the implementer's decisions as D1.. under a heading that says they are not ticket text", () => {
    const decisions = [{ file: "src/a.ts", decision: "Empty rows are skipped." }, { file: "src/b.ts", decision: "Invalid files throw." }];
    const withDecisions = buildConfirmPrompt(brief, report({ decisions }), "origin/main", { n: 1, candidates, groupedWith: {} });
    expect(withDecisions).toMatch(/not ticket text/);
    expect(withDecisions).toContain("  - D1 (src/a.ts): Empty rows are skipped.");
    expect(withDecisions).toContain("  - D2 (src/b.ts): Invalid files throw.");
  });

  it("says when the implementer listed no decisions", () => {
    expect(buildConfirmPrompt(brief, report(), "origin/main", { n: 1, candidates, groupedWith: {} })).toContain("  Decisions: (none)");
    expect(prompt).toContain("  Decisions: (none)");
  });

  it("includes the check results", () => {
    const withChecks = buildConfirmPrompt(brief, undefined, "origin/main", { n: 1, candidates, groupedWith: {} }, { checks: [check("npm run lint", "regression", false, "LINT-BOOM")] });
    expect(withChecks).toMatch(/`npm run lint`: REGRESSION/);
    expect(withChecks).toContain("LINT-BOOM");
  });
});

describe("buildDedupePrompt", () => {
  const candidates: ReviewCandidate[] = [
    { id: "B1", lens: "bugs", kind: "finding", severity: "major", confidence: "suspected", file: "src/a.ts", issue: "Reads only the first row.", suggestion: "Read all rows.", data: false },
    { id: "S2", lens: "spec", kind: "risk", severity: "minor", confidence: "proven", file: "src/b.ts", issue: "Skips the header.", suggestion: "", data: true },
  ];
  const prompt = buildDedupePrompt(candidates);

  it("lists each candidate's id, file and issue without the ticket or the diff", () => {
    for (const text of ["id: B1", "id: S2", "file: src/a.ts", "file: src/b.ts", "issue: Reads only the first row.", "issue: Skips the header."]) expect(prompt).toContain(text);
    expect(prompt).not.toContain("git diff");
    expect(prompt).not.toContain("ENG-12");
  });

  it("asks for the DEDUPE block", () => {
    expect(prompt).toContain("---DEDUPE---");
  });
});

describe("buildFixPrompt", () => {
  const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({ id: "R1", severity: "major", file: "src/a.ts", issue: "Buffers rows.", suggestion: "Stream.", ...over });

  it("adds the evidence line to a finding that has one", () => {
    expect(buildFixPrompt(brief, [finding({ evidence: "src/a.ts:12" })])).toContain("  file: src/a.ts\n  evidence: src/a.ts:12\n  issue: Buffers rows.");
  });

  it("leaves out the evidence line when a finding has none", () => {
    expect(buildFixPrompt(brief, [finding()])).not.toContain("evidence:");
  });
});
