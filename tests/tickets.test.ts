import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTickets, loadAllowance, parseAllowance, parseSections, ticketsHeader } from "../src/tickets.js";

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
    expect(parseSections(readFileSync(file, "utf-8"))).toEqual([]);
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
    expect(() => parseSections(`${ticket}allowance: 50\n`))
      .toThrow("tonight.md: allowance: must go above the first ticket");
  });

  it("still parses tickets under a header allowance", () => {
    const tickets = parseSections(`# Tonight\nallowance: 100\n\n${ticket}`);
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
