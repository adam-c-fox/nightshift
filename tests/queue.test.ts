import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToQueue, loadQueue, moveInQueue, parseQueue, removeFromQueue, setQueueRepo } from "../src/queue.js";
import { loadAllowance } from "../src/tickets.js";

const REPOS = {
  eoe: { names: ["app", "infra"], defaultRepo: "app" },
  memosum: { names: ["main"], defaultRepo: "main" },
};

const HEADER = "# Tonight\n\n<!--\n## GSAI-99 – commented out\n-->\nallowance: 30\n\n";
const SECTIONS = [
  "## GSAI-1 – export CSV\nproject: eoe\nrepo: infra\n- reuse the formatter\n- <!-- hidden -->keep going",
  "## GSAI-2 – memo cap\nproject: memosum\n- one bullet",
  "## GSAI-3 – button\nproject: eoe\nbase: GSAI-1\nrepo: infra\n- call the endpoint",
];
const RAW = HEADER + SECTIONS.join("\n\n") + "\n";

describe("parseQueue", () => {
  it("returns tickets in file order with project and repo set", () => {
    expect(parseQueue(RAW, REPOS)).toEqual([
      { id: "GSAI-1", name: "export CSV", project: "eoe", repo: "infra", context: ["reuse the formatter", "keep going"] },
      { id: "GSAI-2", name: "memo cap", project: "memosum", repo: "main", context: ["one bullet"] },
      { id: "GSAI-3", name: "button", project: "eoe", repo: "infra", base: "GSAI-1", context: ["call the endpoint"] },
    ]);
  });

  it("defaults the repo to the project's defaultRepo", () => {
    expect(parseQueue("## GSAI-1 – x\nproject: eoe\n", REPOS)[0].repo).toBe("app");
  });

  it("requires a project line", () => {
    expect(() => parseQueue("## GSAI-1 – x\n", REPOS)).toThrow(/Ticket GSAI-1: needs a project: line/);
  });

  it("rejects an unknown project", () => {
    expect(() => parseQueue("## GSAI-1 – x\nproject: nope\n", REPOS)).toThrow(/unknown project "nope"/);
  });

  it("rejects a repo the project doesn't have", () => {
    expect(() => parseQueue("## GSAI-1 – x\nproject: memosum\nrepo: app\n", REPOS)).toThrow(/unknown repo/);
  });

  it("rejects a base in another project even when the repo name matches", () => {
    const raw = "## GSAI-1 – a\nproject: eoe\nrepo: app\n\n## GSAI-2 – b\nproject: memosum\nrepo: main\nbase: GSAI-1\n";
    expect(() => parseQueue(raw, REPOS)).toThrow(/must be in the same repo/);
  });

  it("rejects a duplicate ID", () => {
    const raw = "## GSAI-1 – a\nproject: eoe\n\n## GSAI-1 – b\nproject: eoe\n";
    expect(() => parseQueue(raw, REPOS)).toThrow(/GSAI-1.*listed twice/);
  });
});

describe("loadQueue", () => {
  it("returns an empty queue for a missing file", () => {
    expect(loadQueue(join(tmpdir(), "no-such-tonight.md"), REPOS)).toEqual([]);
  });

  it("reads the file and leaves the allowance header to loadAllowance", () => {
    const file = join(mkdtempSync(join(tmpdir(), "queue-")), "tonight.md");
    writeFileSync(file, RAW);
    expect(loadQueue(file, REPOS)).toHaveLength(3);
    expect(loadAllowance(file)).toBe(30);
  });
});

describe("addToQueue", () => {
  const added = { id: "GSAI-4", name: "new  thing", project: "memosum", repo: "main" };

  it("appends a section and keeps everything else byte for byte", () => {
    const result = addToQueue(RAW, REPOS, added);
    expect(result).toBe(RAW + "\n## GSAI-4 – new thing\nproject: memosum\nrepo: main\n");
  });

  it("adds to an empty queue below the header", () => {
    const result = addToQueue("# Tonight\n", REPOS, added);
    expect(parseQueue(result, REPOS).map((t) => t.id)).toEqual(["GSAI-4"]);
    expect(result.startsWith("# Tonight\n")).toBe(true);
  });

  it("refuses an ID that is already queued", () => {
    expect(() => addToQueue(RAW, REPOS, { ...added, id: "GSAI-2" })).toThrow(/already in the queue/);
  });

  it("refuses a repo the project doesn't have", () => {
    expect(() => addToQueue(RAW, REPOS, { ...added, repo: "app" })).toThrow(/unknown repo/);
  });
});

describe("moveInQueue", () => {
  it("reorders sections, keeping the header and bullets byte for byte", () => {
    const result = moveInQueue(RAW, REPOS, ["GSAI-2", "GSAI-1", "GSAI-3"]);
    expect(result.startsWith(HEADER)).toBe(true);
    expect(result).toBe(HEADER + [SECTIONS[1], SECTIONS[0], SECTIONS[2]].join("\n\n") + "\n");
  });

  it("refuses an order that puts a base child above its parent", () => {
    expect(() => moveInQueue(RAW, REPOS, ["GSAI-3", "GSAI-1", "GSAI-2"])).toThrow(/listed earlier/);
  });

  it.each([[["GSAI-1", "GSAI-2"]], [["GSAI-1", "GSAI-1", "GSAI-2"]], [["GSAI-1", "GSAI-2", "GSAI-9"]]])(
    "refuses %j, which isn't exactly the queued IDs",
    (order) => {
      expect(() => moveInQueue(RAW, REPOS, order)).toThrow(/exactly the tickets in the queue/);
    },
  );
});

describe("setQueueRepo", () => {
  it("replaces the repo line", () => {
    const raw = "## GSAI-1 – a\nproject: eoe\nrepo: infra\n- keep\n";
    expect(setQueueRepo(raw, REPOS, "GSAI-1", "app")).toBe("## GSAI-1 – a\nproject: eoe\nrepo: app\n- keep\n");
  });

  it("refuses a change that breaks a base child's repo match", () => {
    expect(() => setQueueRepo(RAW, REPOS, "GSAI-3", "app")).toThrow(/must be in the same repo/);
  });

  it("inserts a repo line when the ticket had none", () => {
    const result = setQueueRepo(RAW, REPOS, "GSAI-2", "main");
    expect(result).toContain("## GSAI-2 – memo cap\nrepo: main\nproject: memosum\n- one bullet");
  });

  it("refuses an unknown repo", () => {
    expect(() => setQueueRepo(RAW, REPOS, "GSAI-2", "app")).toThrow(/unknown repo/);
    expect(() => setQueueRepo(RAW, REPOS, "GSAI-2", "Bad Repo")).toThrow(/unknown repo/);
  });
});

describe("removeFromQueue", () => {
  it("drops the section", () => {
    const result = removeFromQueue(RAW, REPOS, "GSAI-2");
    expect(result).toBe(HEADER + [SECTIONS[0], SECTIONS[2]].join("\n\n") + "\n");
  });

  it("refuses to remove the parent of a base child", () => {
    expect(() => removeFromQueue(RAW, REPOS, "GSAI-1")).toThrow(/listed earlier/);
  });

  it("refuses an ID that isn't queued", () => {
    expect(() => removeFromQueue(RAW, REPOS, "GSAI-9")).toThrow(/not in the queue/);
  });
});
