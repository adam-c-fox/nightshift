import { describe, expect, it } from "vitest";
import type { IssueTracker } from "../src/issue-tracker.js";
import { TICKET_ID } from "../src/tickets.js";

export type FakeIssueState = "backlog" | "ready" | "started" | "review" | "done" | "canceled";

export interface FakeTrackerWorld {
  hasKey: boolean;
  issues: {
    identifier: string; title: string; description: string; state: FakeIssueState;
    assignedToMe: boolean; projectName: string | null; teamKey: string; priority: number; estimate: number | null;
    comments: { author: string; createdAt: string; body: string }[];
  }[];
  teams: { key: string; name: string }[];
  hasReviewState?: boolean;
}

export interface TrackerFixture {
  tracker: IssueTracker;
  moves(): { identifier: string; to: string }[];
}

const issue = (identifier: string, state: FakeIssueState, over: Partial<FakeTrackerWorld["issues"][number]> = {}): FakeTrackerWorld["issues"][number] => ({
  identifier, title: `Title ${identifier}`, description: `About ${identifier}`, state,
  assignedToMe: true, projectName: "Mobile app", teamKey: identifier.split("-")[0], priority: 2, estimate: 3, comments: [],
  ...over,
});

const world = (over: Partial<FakeTrackerWorld> = {}): FakeTrackerWorld => ({
  hasKey: true,
  issues: [],
  teams: [],
  ...over,
});

export function describeIssueTrackerContract(label: string, fixture: (world: FakeTrackerWorld) => TrackerFixture): void {
  describe(`${label} IssueTracker contract`, () => {
    it("getIssue returns null for an unknown id and sorts comments oldest first", async () => {
      const { tracker } = fixture(world({
        issues: [issue("ENG-1", "ready", { comments: [
          { author: "B", createdAt: "2026-01-03T00:00:00Z", body: "third" },
          { author: "A", createdAt: "2026-01-01T00:00:00Z", body: "first" },
          { author: "C", createdAt: "2026-01-02T00:00:00Z", body: "second" },
        ] })],
      }));
      expect(await tracker.getIssue("ENG-404")).toBeNull();
      const found = await tracker.getIssue("ENG-1");
      expect(found?.identifier).toBe("ENG-1");
      expect(found?.name).toBe("Title ENG-1");
      expect(found?.description).toBe("About ENG-1");
      expect(found?.comments.map(c => c.body)).toEqual(["first", "second", "third"]);
    });

    it("offers a start target for ready and backlog issues but not started ones", async () => {
      const { tracker } = fixture(world({
        issues: [issue("ENG-1", "ready"), issue("ENG-2", "backlog"), issue("ENG-3", "started")],
      }));
      expect((await tracker.getIssue("ENG-1"))?.startTarget).toBeDefined();
      expect((await tracker.getIssue("ENG-2"))?.startTarget).toBeDefined();
      expect((await tracker.getIssue("ENG-3"))?.startTarget).toBeUndefined();
    });

    it("offers a review target unless the issue is finished or the tracker has no review state", async () => {
      const issues = [issue("ENG-1", "done"), issue("ENG-2", "canceled"), issue("ENG-3", "started")];
      const withReview = fixture(world({ issues })).tracker;
      expect((await withReview.getIssue("ENG-1"))?.reviewTarget).toBeUndefined();
      expect((await withReview.getIssue("ENG-2"))?.reviewTarget).toBeUndefined();
      expect((await withReview.getIssue("ENG-3"))?.reviewTarget).toBeDefined();
      const withoutReview = fixture(world({ issues, hasReviewState: false })).tracker;
      expect((await withoutReview.getIssue("ENG-3"))?.reviewTarget).toBeUndefined();
    });

    it("moveIssue records exactly one move to the start target", async () => {
      const f = fixture(world({ issues: [issue("ENG-1", "ready")] }));
      const found = await f.tracker.getIssue("ENG-1");
      await f.tracker.moveIssue(found!, found!.startTarget!);
      expect(f.moves()).toEqual([{ identifier: "ENG-1", to: found!.startTarget!.id }]);
    });

    it("listTodo returns only my ready issues with their fields carried through", async () => {
      const { tracker } = fixture(world({
        issues: [
          issue("ENG-1", "ready", { projectName: "Mobile app", priority: 1, estimate: 5 }),
          issue("ENG-2", "ready", { assignedToMe: false }),
          issue("ENG-3", "backlog"),
          issue("WEB-4", "ready", { projectName: null, estimate: null, teamKey: "WEB" }),
        ],
      }));
      const todo = await tracker.listTodo();
      expect(todo.map(t => t.identifier)).toEqual(["ENG-1", "WEB-4"]);
      expect(todo[0]).toMatchObject({ teamKey: "ENG", projectName: "Mobile app", priority: 1, estimate: 5, state: "Todo" });
      expect(todo[1]).toMatchObject({ teamKey: "WEB", projectName: null, estimate: null });
    });

    it("getSnapshots returns null for unknown ids and {} for an empty list", async () => {
      const { tracker } = fixture(world({
        issues: [issue("ENG-1", "ready"), issue("ENG-2", "done", { assignedToMe: false })],
      }));
      const snapshots = await tracker.getSnapshots(["ENG-1", "ENG-2", "ENG-404"]);
      expect(snapshots["ENG-404"]).toBeNull();
      expect(snapshots["ENG-1"]).toMatchObject({ identifier: "ENG-1", ready: true, assignedToMe: true });
      expect(snapshots["ENG-2"]).toMatchObject({ identifier: "ENG-2", ready: false, assignedToMe: false });
      expect(await tracker.getSnapshots([])).toEqual({});
    });

    it("listTeams returns the teams sorted by key", async () => {
      const { tracker } = fixture(world({
        teams: [{ key: "WEB", name: "Web" }, { key: "ENG", name: "Engineering" }],
      }));
      expect(await tracker.listTeams()).toEqual([{ key: "ENG", name: "Engineering" }, { key: "WEB", name: "Web" }]);
    });

    it("rejects every call without a credential and still constructs", async () => {
      const { tracker } = fixture(world({ hasKey: false, issues: [issue("ENG-1", "ready")] }));
      const found = { identifier: "ENG-1", id: "x", name: "", description: "", comments: [], state: "Todo", url: "" };
      await expect(tracker.getIssue("ENG-1")).rejects.toThrow();
      await expect(tracker.moveIssue(found, { id: "s", name: "S" })).rejects.toThrow();
      await expect(tracker.listTodo()).rejects.toThrow();
      await expect(tracker.getSnapshots(["ENG-1"])).rejects.toThrow();
      await expect(tracker.listTeams()).rejects.toThrow();
    });

    it("lists identifiers that match the ticket id format and round-trip through getIssue", async () => {
      const { tracker } = fixture(world({ issues: [issue("ENG-1", "ready"), issue("MOB-22", "ready")] }));
      for (const todo of await tracker.listTodo()) {
        expect(todo.identifier).toMatch(TICKET_ID);
        expect((await tracker.getIssue(todo.identifier))?.identifier).toBe(todo.identifier);
      }
    });
  });
}
