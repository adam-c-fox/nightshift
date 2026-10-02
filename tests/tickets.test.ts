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
