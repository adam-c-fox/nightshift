import { describe, expect, it } from "vitest";
import { buildReviewPrompt, buildVerifyPrompt, type TicketBrief } from "../src/claude.js";
import type { ClassifiedCheck } from "../src/checks.js";

const brief: TicketBrief = { ticketId: "ENG-12", ticketName: "Poll", context: [], linearDesc: "", linearUrl: "u", state: "Todo" };

const check = (command: string, status: ClassifiedCheck["status"], passed: boolean, outputTail = ""): ClassifiedCheck =>
  ({ name: command, command, status, passed, durationSec: 7, outputTail });

describe("buildReviewPrompt", () => {
  it("has no checks or related sections by default", () => {
    const prompt = buildReviewPrompt(brief, undefined, "origin/main");
    expect(prompt).not.toMatch(/Check results|Related ticket/);
  });

  it("lists every check with its status and says the runner ran them", () => {
    const prompt = buildReviewPrompt(brief, undefined, "origin/main", { checks: [
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

  it("includes output only for the checks that did not pass", () => {
    const prompt = buildReviewPrompt(brief, undefined, "origin/main", { checks: [
      check("npm run build", "passed", true, "BUILD-NOISE"),
      check("npm run lint", "regression", false, "LINT-BOOM"),
      check("npm run format", "pre-existing", false, "FORMAT-OLD"),
    ] });
    expect(prompt).toContain("LINT-BOOM");
    expect(prompt).toContain("FORMAT-OLD");
    expect(prompt).not.toContain("BUILD-NOISE");
  });

  it("adds a line per related ticket with the diff command", () => {
    const prompt = buildReviewPrompt(brief, undefined, "origin/main", { related: [{ ticketId: "ENG-10", branch: "feat/eng-10-x" }, { ticketId: "ENG-11", branch: "feat/eng-11-y" }] });
    expect(prompt).toContain("Related ticket ENG-10 was implemented earlier this session on branch feat/eng-10-x. Check that both sides of any shared contract agree: `git diff origin/main...feat/eng-10-x`.");
    expect(prompt).toContain("`git diff origin/main...feat/eng-11-y`");
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
