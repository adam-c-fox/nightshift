import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  capFailures, ciLogArgs, ciTimelineArgs, failedTasks, fetchCiFailures, formatCiFailures, stripTimestamps, tailLines,
  type CiFailure, type CiSource, type TimelineRecord,
} from "../src/ci-logs.js";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8"));
const timeline = fixture<{ records: TimelineRecord[] }>("fixture-timeline.json");
const log = fixture<{ value: string[] }>("fixture-log.json");

describe("stripTimestamps", () => {
  it("removes the ISO prefix from each line", () => {
    expect(stripTimestamps(["2026-10-02T17:44:17.6851507Z [warn] a.ts", "no prefix", "2026-10-02T17:44:17.9246550Z "]))
      .toEqual(["[warn] a.ts", "no prefix", ""]);
  });
});

describe("tailLines", () => {
  it("keeps the last n lines", () => {
    expect(tailLines(["a", "b", "c", "d"], 2)).toEqual(["c", "d"]);
    expect(tailLines(["a"], 5)).toEqual(["a"]);
  });
});

describe("failedTasks", () => {
  it("picks failed Task records only, with log id and issue messages", () => {
    expect(failedTasks(timeline.records)).toEqual([{ name: "prettier --check", logId: 9, issues: ["Bash exited with code '1'."] }]);
  });

  it("drops warnings and keeps only error issues when types are present", () => {
    const records: TimelineRecord[] = [{
      type: "Task", name: "t", result: "failed", log: { id: 1 },
      issues: [{ type: "warning", message: "w" }, { type: "error", message: "e" }],
    }];
    expect(failedTasks(records)[0].issues).toEqual(["e"]);
  });

  it("tolerates a failed task with no log or issues", () => {
    expect(failedTasks([{ type: "Task", name: "t", result: "failed", log: null, issues: null }]))
      .toEqual([{ name: "t", logId: undefined, issues: [] }]);
  });
});

describe("az arguments", () => {
  it("builds the timeline and log invocations", () => {
    expect(ciTimelineArgs("https://dev.azure.com/o", "P", 5)).toEqual([
      "devops", "invoke", "--area", "build", "--resource", "timeline",
      "--route-parameters", "project=P", "buildId=5", "--org", "https://dev.azure.com/o",
    ]);
    expect(ciLogArgs("https://dev.azure.com/o", "P", 5, 9)).toEqual([
      "devops", "invoke", "--area", "build", "--resource", "logs",
      "--route-parameters", "project=P", "buildId=5", "logId=9", "--org", "https://dev.azure.com/o",
    ]);
  });
});

describe("fetchCiFailures", () => {
  const source = (overrides: Partial<CiSource> = {}): CiSource => ({
    timeline: async () => timeline.records,
    log: async () => log.value,
    ...overrides,
  });

  it("returns the failed task with issues and a timestamp-free tail", async () => {
    const [failure] = await fetchCiFailures([{ name: "lint-format", buildId: 101 }], source());
    expect(failure.check).toBe("lint-format");
    expect(failure.task).toBe("prettier --check");
    expect(failure.issues).toEqual(["Bash exited with code '1'."]);
    expect(failure.tail).toContain("[warn] services/export/src/export.ts");
    expect(failure.tail).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(failure.error).toBeUndefined();
  });

  it("limits each tail to 150 lines", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `2026-10-02T17:44:17.0000000Z line ${i}`);
    const [failure] = await fetchCiFailures([{ name: "c", buildId: 1 }], source({ log: async () => long }));
    const lines = failure.tail.split("\n");
    expect(lines).toHaveLength(150);
    expect(lines.at(-1)).toBe("line 399");
  });

  it("still names the check when the timeline cannot be fetched", async () => {
    const [failure] = await fetchCiFailures([{ name: "lint-format", buildId: 1 }], source({ timeline: async () => { throw new Error("boom"); } }));
    expect(failure).toMatchObject({ check: "lint-format", task: "", tail: "" });
    expect(failure.error).toMatch(/boom/);
  });

  it("keeps the task and its issues when only the log fetch fails", async () => {
    const [failure] = await fetchCiFailures([{ name: "lint-format", buildId: 1 }], source({ log: async () => { throw new Error("no log"); } }));
    expect(failure).toMatchObject({ check: "lint-format", task: "prettier --check", issues: ["Bash exited with code '1'."], tail: "" });
    expect(failure.error).toMatch(/no log/);
  });

  it("names the check when the build id is unknown", async () => {
    const [failure] = await fetchCiFailures([{ name: "mystery", buildId: undefined }], source());
    expect(failure.check).toBe("mystery");
    expect(failure.error).toBeTruthy();
  });

  it("names the check when no failed task is found", async () => {
    const [failure] = await fetchCiFailures([{ name: "c", buildId: 1 }], source({ timeline: async () => [] }));
    expect(failure.check).toBe("c");
    expect(failure.error).toMatch(/no failed task/i);
  });

  it("covers every failed check", async () => {
    const failures = await fetchCiFailures([{ name: "a", buildId: 1 }, { name: "b", buildId: 2 }], source());
    expect(failures.map(f => f.check)).toEqual(["a", "b"]);
  });
});

describe("capFailures", () => {
  const failure = (check: string, lines: string[]): CiFailure => ({ check, task: "t", issues: [], tail: lines.join("\n") });

  it("leaves small input alone", () => {
    const input = [failure("a", ["x", "y"])];
    expect(capFailures(input, 1000)).toEqual(input);
  });

  it("trims the oldest lines first so the total fits", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}`);
    const [capped] = capFailures([failure("a", lines)], 200);
    expect(capped.tail.length).toBeLessThanOrEqual(200);
    expect(capped.tail.endsWith("line-099")).toBe(true);
    expect(capped.tail).not.toContain("line-000");
  });

  it("shares the cap across failures", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    const capped = capFailures([failure("a", lines), failure("b", lines)], 400);
    expect(capped.reduce((n, f) => n + f.tail.length, 0)).toBeLessThanOrEqual(400);
    expect(capped.every(f => f.tail.length > 0)).toBe(true);
  });
});

describe("formatCiFailures", () => {
  it("lists check, task, issues and tail", () => {
    const text = formatCiFailures([{ check: "lint-format", task: "prettier --check", issues: ["Bash exited with code '1'."], tail: "[warn] a.ts" }]);
    expect(text).toContain("lint-format");
    expect(text).toContain("prettier --check");
    expect(text).toContain("Bash exited with code '1'.");
    expect(text).toContain("[warn] a.ts");
  });

  it("reports the error when logs were unavailable", () => {
    const text = formatCiFailures([{ check: "unit-tests", task: "", issues: [], tail: "", error: "timeout" }]);
    expect(text).toContain("unit-tests");
    expect(text).toContain("timeout");
  });
});
