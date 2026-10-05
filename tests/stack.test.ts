import { describe, expect, it } from "vitest";
import type { ProcessedTicket } from "../src/related.js";
import { stackedContext, stackDecision } from "../src/stack.js";
import type { Ticket } from "../src/types.js";

const ticket = (over: Partial<Ticket> = {}): Ticket => ({ id: "ENG-2", name: "Child", context: [], repo: "main", ...over });

const processed = new Map<string, ProcessedTicket>([
  ["ENG-1", { branch: "feat/eng-1-a", repo: "main", pushed: { branch: "feat/eng-1-a", prId: 41 } }],
  ["ENG-3", { branch: "feat/eng-3-c", repo: "main" }],
]);

describe("stackDecision", () => {
  it("starts fresh without a base", () => {
    expect(stackDecision(ticket(), processed)).toEqual({ kind: "fresh" });
  });

  it("stacks on the branch the parent was pushed to", () => {
    expect(stackDecision(ticket({ base: "ENG-1" }), processed))
      .toEqual({ kind: "stacked", parent: { ticketId: "ENG-1", branch: "feat/eng-1-a", prId: 41 } });
  });

  it("skips when the parent was processed but not pushed", () => {
    expect(stackDecision(ticket({ base: "ENG-3" }), processed))
      .toEqual({ kind: "skip", reason: "Skipped – base ENG-3 was not pushed tonight." });
  });

  it("skips when the parent was never processed, so a chain skips transitively", () => {
    expect(stackDecision(ticket({ base: "ENG-9" }), processed))
      .toEqual({ kind: "skip", reason: "Skipped – base ENG-9 was not pushed tonight." });
  });
});

describe("stackedContext", () => {
  it("tells the agent the parent change is already in its base", () => {
    expect(stackedContext({ ticketId: "ENG-1", branch: "feat/eng-1-a", prId: 41 }))
      .toBe("This branch is stacked on ENG-1 (branch feat/eng-1-a, PR #41); that change is already in your base. Build on it; don't reimplement it.");
  });
});
