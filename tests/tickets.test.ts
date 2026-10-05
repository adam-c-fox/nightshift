import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTickets, loadTickets, parseTickets, ticketsHeader } from "../src/tickets.js";

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
    ].join("\n"));

    expect(tickets).toEqual([
      { id: "ENG-142", name: "CSV export fix", repo: "main", context: ["check the export button", "see src/export.ts"] },
      { id: "INF-7", name: "Add bucket", repo: "terraform", context: [] },
    ]);
  });

  it("defaults repo to main and ignores HTML comments", () => {
    const tickets = parseTickets("<!--\n## ENG-1 – commented out\n-->\n## ENG-2 – Real");
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ id: "ENG-2", repo: "main" });
  });

  it("returns nothing for an empty file", () => {
    expect(parseTickets("# Tonight\n")).toEqual([]);
  });
});

describe("loadTickets", () => {
  it("returns nothing when the file does not exist", () => {
    expect(loadTickets(join(tmpdir(), "nightshift-missing", "tonight.md"))).toEqual([]);
  });

  it("propagates errors other than a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightshift-tickets-"));
    const asDir = join(dir, "tonight.md");
    mkdirSync(asDir);
    expect(() => loadTickets(asDir)).toThrow(/EISDIR/);
  });

  it("parses an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightshift-tickets-"));
    const file = join(dir, "tonight.md");
    writeFileSync(file, "## ENG-9 – Thing\n");
    expect(loadTickets(file)).toMatchObject([{ id: "ENG-9" }]);
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
    expect(loadTickets(file)).toEqual([]);
  });
});

describe("base", () => {
  const section = (id: string, ...lines: string[]) => [`## ${id} – Name ${id}`, ...lines, ""].join("\n");

  it("parses base case-insensitively and leaves it unset otherwise", () => {
    const [a, b] = parseTickets(section("ENG-1", "repo: main") + section("ENG-2", "BASE: ENG-1", "- ctx"));
    expect(a.base).toBeUndefined();
    expect(b).toMatchObject({ id: "ENG-2", base: "ENG-1", context: ["ctx"] });
  });

  it("allows chains where each ticket names its direct parent", () => {
    const tickets = parseTickets(section("ENG-1") + section("ENG-2", "base: ENG-1") + section("ENG-3", "base: ENG-2"));
    expect(tickets.map(t => t.base)).toEqual([undefined, "ENG-1", "ENG-2"]);
  });

  it("rejects a base listed later in the file", () => {
    expect(() => parseTickets(section("ENG-2", "base: ENG-1") + section("ENG-1"))).toThrow(/ENG-2.*ENG-1.*earlier/);
  });

  it("rejects a base that is not in the file", () => {
    expect(() => parseTickets(section("ENG-2", "base: ENG-9"))).toThrow(/ENG-2.*ENG-9.*earlier/);
  });

  it("rejects a base in another repo", () => {
    expect(() => parseTickets(section("ENG-1", "repo: terraform") + section("ENG-2", "base: ENG-1"))).toThrow(/ENG-2.*ENG-1.*same repo/);
  });

  it("rejects a ticket based on itself", () => {
    expect(() => parseTickets(section("ENG-1", "base: ENG-1"))).toThrow(/ENG-1.*itself/);
  });
});
