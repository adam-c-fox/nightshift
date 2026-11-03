import { afterEach, describe, expect, it } from "vitest";
import { createProjectSwitcher, nightOrder } from "../src/night.js";
import { CLAUDE_TOKEN } from "../src/agent-env.js";
import type { Project } from "../src/project.js";
import type { Ticket } from "../src/types.js";

const ticket = (id: string, project: string, extra: Partial<Ticket> = {}): Ticket => ({ id, name: id, context: [], repo: "app", project, ...extra });

describe("nightOrder", () => {
  it("puts unmatched sweep items first, in project order, tagged with their project", () => {
    const queue = [ticket("Q-1", "memosum")];
    const sweeps = [
      { project: "eoe", items: [ticket("PR-1", "")] },
      { project: "memosum", items: [ticket("PR-2", "")] },
    ];
    expect(nightOrder(queue, sweeps).map(t => [t.id, t.project])).toEqual([["PR-1", "eoe"], ["PR-2", "memosum"], ["Q-1", "memosum"]]);
  });

  it("absorbs a matching sweep item at its queue position", () => {
    const queue = [ticket("A-1", "eoe"), ticket("A-2", "eoe")];
    const comments = { title: "t" } as unknown as Ticket["prComments"];
    const sweeps = [{ project: "eoe", items: [ticket("A-2", "eoe", { context: ["thread"], prComments: comments })] }];
    const ordered = nightOrder(queue, sweeps);
    expect(ordered.map(t => t.id)).toEqual(["A-1", "A-2"]);
    expect(ordered[1]).toMatchObject({ context: ["thread"], prComments: comments });
  });

  it("does not absorb a sweep item of another project with the same id", () => {
    const sweeps = [{ project: "memosum", items: [ticket("A-1", "")] }];
    expect(nightOrder([ticket("A-1", "eoe")], sweeps).map(t => t.project)).toEqual(["memosum", "eoe"]);
  });
});

describe("createProjectSwitcher", () => {
  afterEach(() => { delete process.env[CLAUDE_TOKEN]; });

  const projects: Record<string, Project> = {
    eoe: { name: "eoe", envFile: "/eoe.env", instructions: "eoe rules", testDbScript: "/eoe-db" } as Project,
    memosum: { name: "memosum", envFile: "/memo.env", instructions: "memo rules", testDbScript: "/memo-db" } as Project,
  };

  function setup() {
    const events: string[] = [];
    let envFile = "";
    const prefixes: Record<string, string> = { "/eoe.env": "eoe-prefix", "/memo.env": "memo-prefix" };
    const switcher = createProjectSwitcher({
      load: name => projects[name],
      useEnv: file => { envFile = file; events.push(`env ${file}`); },
      getEnv: name => (name === "BRANCH_PREFIX" ? prefixes[envFile] : undefined),
      startDb: script => { events.push(`start ${script}`); return { url: "x", stop: () => events.push(`stop ${script}`) }; },
      loadPrState: name => ({ state: {}, file: `/state/${name}.json` }),
      genericInstructions: "generic",
    });
    return { switcher, events };
  }

  it("gives each project its own branch prefix, instructions and PR state", () => {
    const { switcher, events } = setup();
    const eoe = switcher.enter("eoe");
    expect(eoe.branchPrefix).toBe("eoe-prefix");
    const memo = switcher.enter("memosum");
    expect(memo.branchPrefix).toBe("memo-prefix");
    expect(events).toContain("env /memo.env");
    expect(memo.instructions).toContain("memo rules");
    expect(memo.instructions).not.toContain("eoe rules");
    expect(memo.prWrites).not.toBe(eoe.prWrites);
    expect(switcher.enter("eoe").prWrites).toBe(eoe.prWrites);
  });

  it("stops the previous test db before starting the next, and does not restart on re-entry", () => {
    const { switcher, events } = setup();
    switcher.enter("eoe");
    switcher.enter("memosum");
    switcher.enter("memosum");
    expect(events.filter(e => /^(start|stop)/.test(e))).toEqual(["start /eoe-db", "stop /eoe-db", "start /memo-db"]);
    switcher.stop();
    expect(events.at(-1)).toBe("stop /memo-db");
  });

  it("starts the db on a later entry after a sweep-only entry", () => {
    const { switcher, events } = setup();
    switcher.enter("eoe", { db: false });
    expect(events.some(e => e.startsWith("start"))).toBe(false);
    switcher.enter("eoe");
    expect(events).toContain("start /eoe-db");
  });
});
