import { describe, expect, it } from "vitest";
import { parseTickets } from "../src/tickets.js";

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
