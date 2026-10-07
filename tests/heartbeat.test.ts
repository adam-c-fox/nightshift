import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  STALE_AFTER_MS,
  heartbeatFile,
  readProjectRuns,
  runView,
  startHeartbeat,
  type RunHeartbeat,
} from "../src/heartbeat.js";

const START = Date.parse("2026-10-07T06:00:00Z");

function setup() {
  let t = START;
  const writes: RunHeartbeat[] = [];
  const cancel = vi.fn();
  let tick: () => void = () => {};
  const every = vi.fn((fn: () => void, _ms: number) => {
    tick = fn;
    return cancel;
  });
  const hb = startHeartbeat(
    { pid: 42, base: "nightshift-2026-10-07", startedAt: new Date(t) },
    { write: (h) => writes.push(h), now: () => new Date(t), every },
  );
  return {
    hb,
    writes,
    cancel,
    every,
    advance: (ms: number) => (t += ms),
    tick: () => tick(),
  };
}

function heartbeat(overrides: Partial<RunHeartbeat> = {}): RunHeartbeat {
  return {
    pid: 42,
    base: "nightshift-2026-10-07",
    startedAtIso: new Date(START).toISOString(),
    ticketIndex: 1,
    total: 3,
    ticketId: "ENG-1",
    phase: "ticket",
    heartbeatAt: new Date(START).toISOString(),
    ...overrides,
  };
}

describe("startHeartbeat", () => {
  it("writes the starting state immediately and schedules the interval", () => {
    const { writes, every } = setup();
    expect(writes).toEqual([
      {
        pid: 42,
        base: "nightshift-2026-10-07",
        startedAtIso: "2026-10-07T06:00:00.000Z",
        ticketIndex: 0,
        total: 0,
        ticketId: null,
        phase: "starting",
        heartbeatAt: "2026-10-07T06:00:00.000Z",
      },
    ]);
    expect(every).toHaveBeenCalledWith(
      expect.any(Function),
      HEARTBEAT_INTERVAL_MS,
    );
    expect(HEARTBEAT_INTERVAL_MS).toBe(60_000);
  });

  it("records the ticket on a ticket phase change", () => {
    const { hb, writes, advance } = setup();
    advance(5000);
    hb.phase("ticket", { index: 2, total: 5, id: "ENG-9" });
    expect(writes.at(-1)).toMatchObject({
      ticketIndex: 2,
      total: 5,
      ticketId: "ENG-9",
      phase: "ticket",
      heartbeatAt: "2026-10-07T06:00:05.000Z",
    });
  });

  it("rewrites the same state with a fresh heartbeatAt on each interval", () => {
    const { hb, writes, advance, tick } = setup();
    advance(5000);
    hb.phase("ticket", { index: 2, total: 5, id: "ENG-9" });
    advance(60_000);
    tick();
    expect(writes.at(-1)).toMatchObject({
      ticketIndex: 2,
      total: 5,
      ticketId: "ENG-9",
      phase: "ticket",
      heartbeatAt: "2026-10-07T06:01:05.000Z",
    });
  });

  it("keeps the ticket counts but drops the ticket id for a later phase", () => {
    const { hb, writes } = setup();
    hb.phase("ticket", { index: 2, total: 5, id: "ENG-9" });
    hb.phase("postmortem");
    expect(writes.at(-1)).toMatchObject({
      ticketIndex: 2,
      total: 5,
      ticketId: null,
      phase: "postmortem",
    });
  });

  it("finish writes the finished state once and cancels the interval", () => {
    const { hb, writes, cancel, advance } = setup();
    advance(10_000);
    hb.finish();
    expect(writes.at(-1)).toMatchObject({
      phase: "finished",
      finishedAt: "2026-10-07T06:00:10.000Z",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    const count = writes.length;
    hb.finish();
    expect(writes).toHaveLength(count);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not write from the interval or phase changes after finish", () => {
    const { hb, writes, tick } = setup();
    hb.finish();
    const count = writes.length;
    tick();
    hb.phase("report");
    expect(writes).toHaveLength(count);
  });
});

describe("runView", () => {
  const now = new Date(START + 120_000);

  it("is idle without a heartbeat", () => {
    expect(runView(null, now)).toEqual({ state: "idle" });
  });

  it("is idle once finished", () => {
    const finished = heartbeat({
      phase: "finished",
      finishedAt: new Date(START + 1000).toISOString(),
    });
    expect(runView(finished, now)).toEqual({ state: "idle" });
  });

  it("is running for a heartbeat 2 minutes old", () => {
    const hb = heartbeat();
    expect(runView(hb, now)).toEqual({
      state: "running",
      heartbeat: hb,
      elapsedMs: 120_000,
      sinceHeartbeatMs: 120_000,
    });
  });

  it("stays running at exactly 3 minutes and goes stale just after", () => {
    const hb = heartbeat();
    expect(STALE_AFTER_MS).toBe(180_000);
    expect(runView(hb, new Date(START + STALE_AFTER_MS)).state).toBe("running");
    expect(runView(hb, new Date(START + STALE_AFTER_MS + 1)).state).toBe(
      "stale",
    );
  });

  it("measures elapsed time from the start, not the last heartbeat", () => {
    const hb = heartbeat({
      heartbeatAt: new Date(START + 600_000).toISOString(),
    });
    const view = runView(hb, new Date(START + 630_000));
    expect(view).toMatchObject({
      state: "running",
      elapsedMs: 630_000,
      sinceHeartbeatMs: 30_000,
    });
  });
});

describe("readProjectRuns", () => {
  it("lists running projects, skipping finished, invalid and missing run files", () => {
    const logs = mkdtempSync(path.join(tmpdir(), "nightshift-"));
    const write = (project: string, content: string) => {
      mkdirSync(path.join(logs, project), { recursive: true });
      writeFileSync(heartbeatFile(path.join(logs, project)), content);
    };
    write("acme", JSON.stringify(heartbeat()));
    write(
      "beta",
      JSON.stringify(
        heartbeat({
          phase: "finished",
          finishedAt: new Date(START).toISOString(),
        }),
      ),
    );
    write("gamma", "{not json");
    mkdirSync(path.join(logs, "delta"));
    writeFileSync(path.join(logs, "stray.log"), "x");

    const runs = readProjectRuns(logs, new Date(START + 120_000));

    expect(runs).toEqual([
      {
        project: "acme",
        view: {
          state: "running",
          heartbeat: heartbeat(),
          elapsedMs: 120_000,
          sinceHeartbeatMs: 120_000,
        },
      },
    ]);
  });

  it("sorts by project name", () => {
    const logs = mkdtempSync(path.join(tmpdir(), "nightshift-"));
    for (const project of ["zeta", "alpha"]) {
      mkdirSync(path.join(logs, project));
      writeFileSync(
        heartbeatFile(path.join(logs, project)),
        JSON.stringify(heartbeat()),
      );
    }
    expect(
      readProjectRuns(logs, new Date(START)).map((r) => r.project),
    ).toEqual(["alpha", "zeta"]);
  });

  it("returns nothing when the logs directory does not exist", () => {
    const logs = path.join(
      mkdtempSync(path.join(tmpdir(), "nightshift-")),
      "missing",
    );
    expect(readProjectRuns(logs, new Date(START))).toEqual([]);
  });

  it("builds the run file path inside the logs directory", () => {
    expect(heartbeatFile("/x/logs/acme")).toBe("/x/logs/acme/run.json");
  });
});
