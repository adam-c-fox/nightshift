import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildConfirmPrompt, buildFinderPrompt, buildVerifyPrompt, type AgentReport, type TicketBrief } from "../src/claude.js";
import type { ClassifiedCheck } from "../src/checks.js";
import type { ReviewCandidate } from "../src/types.js";

const brief: TicketBrief = { ticketId: "ENG-12", ticketName: "Poll", context: [], linearDesc: "", linearComments: [], linearUrl: "u", state: "Todo" };

const check = (command: string, status: ClassifiedCheck["status"], passed: boolean, outputTail = ""): ClassifiedCheck =>
  ({ name: command, command, status, passed, durationSec: 7, outputTail });

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

describe("buildVerifyPrompt", () => {
  const findings = [
    { id: "R1", severity: "blocker" as const, file: "src/a.ts", issue: "Buffers rows.", suggestion: "Stream." },
    { id: "R2", severity: "major" as const, file: "src/b.ts", issue: "No header.", suggestion: "Add it." },
  ];
  const resolutions = [
    { id: "R1", status: "fixed" as const, how: "Streamed rows." },
    { id: "R2", status: "not_fixed" as const, how: "Disagree." },
  ];
  const prompt = buildVerifyPrompt(brief, "origin/main", findings, resolutions);

  it("names the ticket and base ref and asks for the VERIFY block", () => {
    expect(prompt).toContain("ENG-12");
    expect(prompt).toContain("git diff origin/main");
    expect(prompt).toContain("---VERIFY---");
    expect(prompt).toMatch(/Do not modify any file/);
  });

  it("lists only claimed-fixed findings with the fixer's account", () => {
    expect(prompt).toContain("id: R1");
    expect(prompt).toContain("issue: Buffers rows.");
    expect(prompt).toContain("fixer says: Streamed rows.");
    expect(prompt).not.toContain("R2");
  });
});

describe("buildFinderPrompt", () => {
  const related = [{ ticketId: "ENG-10", branch: "feat/eng-10-x" }];
  const report = (over: Partial<AgentReport> = {}): AgentReport => ({
    status: "done", title: "t", summary: "s", filesCreated: [], filesModified: [], tests: [], verifyCommands: [], notes: "(1) skip empty rows", followups: [], decisions: [], ...over,
  });

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
  const prompt = buildConfirmPrompt(brief, "origin/main", candidates);

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
});
