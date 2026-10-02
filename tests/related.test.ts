import { describe, expect, it } from "vitest";
import { relatedTickets, type ProcessedTicket } from "../src/related.js";

const processed = new Map<string, ProcessedTicket>([
  ["ENG-10", { branch: "feat/eng-10-x", repo: "main" }],
  ["ENG-11", { branch: "feat/eng-11-y", repo: "main" }],
  ["INF-3", { branch: "feat/inf-3-z", repo: "terraform" }],
]);

describe("relatedTickets", () => {
  it("finds processed tickets mentioned in context and the description", () => {
    expect(relatedTickets("ENG-12", "main", ["builds on ENG-10", "see also ENG-99"], processed))
      .toEqual([{ ticketId: "ENG-10", branch: "feat/eng-10-x" }]);
    expect(relatedTickets("ENG-12", "main", ["Depends on ENG-11, ENG-10."], processed).map(r => r.ticketId))
      .toEqual(["ENG-11", "ENG-10"]);
  });

  it("excludes its own id, duplicates and tickets from the other repo", () => {
    expect(relatedTickets("ENG-10", "main", ["ENG-10 ENG-11 ENG-11 INF-3"], processed).map(r => r.ticketId)).toEqual(["ENG-11"]);
  });

  it("returns nothing when no text mentions a ticket", () => {
    expect(relatedTickets("ENG-12", "main", ["no ids here", "ABC-x"], processed)).toEqual([]);
  });
});
