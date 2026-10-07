import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTickets, loadAllowance, loadTickets, parseAllowance, parseTickets, ticketsHeader } from "../src/tickets.js";

const REPOS_FIXTURE = { names: ["main", "terraform"], defaultRepo: "main" };

describe("parseTickets", () => {
  it("parses headings, repo and context bullets", () => {
    const tickets = parseTickets([
      "# Tonight",
      "## ENG-142 – CSV export fix",
      "repo: main",
      "- check the export button",
      "- see src/export.ts",
      "",
      "## INF-7 - Add bucket",
      "repo: terraform",
    ].join("\n"), REPOS_FIXTURE);

    expect(tickets).toEqual([
      { id: "ENG-142", name: "CSV export fix", repo: "main", context: ["check the export button", "see src/export.ts"] },
      { id: "INF-7", name: "Add bucket", repo: "terraform", context: [] },
    ]);
  });

  it("defaults repo to main and ignores HTML comments", () => {
    const tickets = parseTickets("<!--\n## ENG-1 – commented out\n-->\n## ENG-2 – Real", REPOS_FIXTURE);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ id: "ENG-2", repo: "main" });
  });

  it("accepts any repo the project defines", () => {
    const tickets = parseTickets("## ENG-1 – x\nrepo: web-app\n", { names: ["web-app"], defaultRepo: "web-app" });
    expect(tickets[0].repo).toBe("web-app");
  });

  it("defaults to the project's default repo", () => {
    expect(parseTickets("## ENG-1 – x\n", { names: ["api", "infra"], defaultRepo: "api" })[0].repo).toBe("api");
  });

  it("rejects a repo the project doesn't define and names the known ones", () => {
    expect(() => parseTickets("## ENG-1 – x\nrepo: mian\n", REPOS_FIXTURE))
      .toThrow('Ticket ENG-1: unknown repo "mian" (known: main, terraform)');
  });

  it("returns nothing for an empty file", () => {
    expect(parseTickets("# Tonight\n", REPOS_FIXTURE)).toEqual([]);
  });
});

describe("loadTickets", () => {
  it("returns nothing when the file does not exist", () => {
    expect(loadTickets(join(tmpdir(), "nightshift-missing", "tonight.md"), REPOS_FIXTURE)).toEqual([]);
  });

  it("propagates errors other than a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightshift-tickets-"));
    const asDir = join(dir, "tonight.md");
    mkdirSync(asDir);
    expect(() => loadTickets(asDir, REPOS_FIXTURE)).toThrow(/EISDIR/);
  });

  it("parses an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightshift-tickets-"));
    const file = join(dir, "tonight.md");
    writeFileSync(file, "## ENG-9 – Thing\n");
    expect(loadTickets(file, REPOS_FIXTURE)).toMatchObject([{ id: "ENG-9" }]);
  });
});

describe("ticketsHeader", () => {
  it("keeps everything before the first ticket, including commented-out ones", () => {
    const header = "# Tonight\n\n<!--\n## ENG-1 – commented out\n-->\n\n";
    expect(ticketsHeader(`${header}## ENG-2 – Real\n- context\n`)).toBe(header);
  });

  it("keeps the whole file when it has no tickets", () => {
    expect(ticketsHeader("# Tonight\n")).toBe("# Tonight\n");
  });
});

describe("archiveTickets", () => {
  it("copies the file to the archive and leaves only the header behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightshift-tickets-"));
    const file = join(dir, "tonight.md");
    const dest = join(dir, "reports", "2026-10-02-tonight.md");
    const raw = "# Tonight\n\n## ENG-9 – Thing\n- context\n";
    writeFileSync(file, raw);

    archiveTickets(dest, file);

    expect(readFileSync(dest, "utf-8")).toBe(raw);
    expect(readFileSync(file, "utf-8")).toBe("# Tonight\n\n");
    expect(loadTickets(file, REPOS_FIXTURE)).toEqual([]);
  });
});

describe("base", () => {
  const section = (id: string, ...lines: string[]) => [`## ${id} – Name ${id}`, ...lines, ""].join("\n");

  it("parses base case-insensitively and leaves it unset otherwise", () => {
    const [a, b] = parseTickets(section("ENG-1", "repo: main") + section("ENG-2", "BASE: ENG-1", "- ctx"), REPOS_FIXTURE);
    expect(a.base).toBeUndefined();
    expect(b).toMatchObject({ id: "ENG-2", base: "ENG-1", context: ["ctx"] });
  });

  it("allows chains where each ticket names its direct parent", () => {
    const tickets = parseTickets(section("ENG-1") + section("ENG-2", "base: ENG-1") + section("ENG-3", "base: ENG-2"), REPOS_FIXTURE);
    expect(tickets.map(t => t.base)).toEqual([undefined, "ENG-1", "ENG-2"]);
  });

  it("rejects a base listed later in the file", () => {
    expect(() => parseTickets(section("ENG-2", "base: ENG-1") + section("ENG-1"), REPOS_FIXTURE)).toThrow(/ENG-2.*ENG-1.*earlier/);
  });

  it("rejects a base that is not in the file", () => {
    expect(() => parseTickets(section("ENG-2", "base: ENG-9"), REPOS_FIXTURE)).toThrow(/ENG-2.*ENG-9.*earlier/);
  });

  it("rejects a base in another repo", () => {
    expect(() => parseTickets(section("ENG-1", "repo: terraform") + section("ENG-2", "base: ENG-1"), REPOS_FIXTURE)).toThrow(/ENG-2.*ENG-1.*same repo/);
  });

  it("rejects a ticket based on itself", () => {
    expect(() => parseTickets(section("ENG-1", "base: ENG-1"), REPOS_FIXTURE)).toThrow(/ENG-1.*itself/);
  });
});

describe("allowance", () => {
  const ticket = "## ENG-1 – Thing\nrepo: main\n- ctx\n";

  it("reads the header line and ignores its absence or a commented one", () => {
    expect(parseAllowance(`# Tonight\nallowance: 100\n\n${ticket}`)).toBe(100);
    expect(parseAllowance(`# Tonight\n\n${ticket}`)).toBeUndefined();
    expect(parseAllowance(`# Tonight\n<!--\nallowance: 100\n-->\n${ticket}`)).toBeUndefined();
  });

  it.each(["0", "101", "12.5", "abc"])("rejects %s", (value) => {
    expect(() => parseAllowance(`allowance: ${value}\n${ticket}`))
      .toThrow(`tonight.md: allowance must be a whole number from 1 to 100, got "${value}"`);
  });

  it("rejects a second header line", () => {
    expect(() => parseAllowance(`allowance: 50\nallowance: 60\n${ticket}`))
      .toThrow("tonight.md: allowance is set more than once");
  });

  it("rejects a line inside a ticket section", () => {
    expect(() => parseTickets(`${ticket}allowance: 50\n`, REPOS_FIXTURE))
      .toThrow("tonight.md: allowance: must go above the first ticket");
  });

  it("still parses tickets under a header allowance", () => {
    const tickets = parseTickets(`# Tonight\nallowance: 100\n\n${ticket}`, REPOS_FIXTURE);
    expect(tickets).toMatchObject([{ id: "ENG-1", repo: "main", context: ["ctx"] }]);
  });

  it("drops the line from the rewritten header but keeps it in the archive", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightshift-tickets-"));
    const file = join(dir, "tonight.md");
    const dest = join(dir, "reports", "tonight.md");
    const raw = `# Tonight\nallowance: 100\n\n${ticket}`;
    writeFileSync(file, raw);

    archiveTickets(dest, file);

    expect(readFileSync(file, "utf-8")).toBe("# Tonight\n\n");
    expect(readFileSync(dest, "utf-8")).toBe(raw);
  });

  it("keeps a commented allowance line in the rewritten header", () => {
    const raw = `# Tonight\n<!--\nallowance: 100\n-->\n${ticket}`;
    expect(ticketsHeader(raw)).toBe("# Tonight\n<!--\nallowance: 100\n-->\n");
  });

  it("returns undefined for a missing file", () => {
    expect(loadAllowance(join(tmpdir(), "nightshift-missing", "tonight.md"))).toBeUndefined();
  });
});
