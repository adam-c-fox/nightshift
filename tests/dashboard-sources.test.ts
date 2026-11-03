import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCache } from "../src/dashboard/cache.js";
import { ExecError, type Exec } from "../src/dashboard/exec.js";
import {
  createSources,
  defaultDeps,
  SLOW_MS,
  type DashboardDeps,
  type Sources,
} from "../src/dashboard/sources.js";
import { openNightBudget } from "../src/budget.js";
import { buildPrWebUrl } from "../src/pr.js";
import { ROOT } from "../src/state.js";
import type { NightRecord } from "../src/types.js";

const PR_URL = "https://dev.azure.com/o/P/_git/app/pullrequest/7";
const PAT = "super-secret-pat";

let root: string;
let codeRoot: string;
let appRepo: string;
let webRepo: string;
let fetchCalls: {
  query: string;
  headers: Record<string, string>;
  variables: Record<string, any>;
}[];
let execCalls: { cmd: string; args: string[]; cwd?: string }[];
let prListFailsFor: Set<string>;
let allPrsFail: boolean;
let prListHasPr7: boolean;
let policyListFails: boolean;
let usageResult: "ok" | "error-stdout";
let sources: Sources;
let now: Date;

const write = (file: string, content: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
};

function nightRecord(): NightRecord {
  return {
    date: "2026-10-02",
    startedAt: "",
    endedAt: "",
    tickets: [
      {
        ticket: { id: "DEMO-9", name: "nine", context: [], repo: "app" },
        linear: null,
        status: "needs_review",
        summary: "needs a look",
        filesCreated: [],
        filesModified: [],
        tests: [],
        verifyCommands: [],
        notes: "",
        followups: [],
        worktreePath: "/w",
        branch: "ns/demo-9-x",
        durationSec: 1,
        prUrl: PR_URL,
        prId: 7,
      },
    ],
    budget: openNightBudget({ weeklyPercent: 3, resetInfo: "Oct 7" }, 15),
    gateHit: false,
    skipReason: "",
    noTasks: false,
    startedAtIso: "2026-10-02T06:00:00.000Z",
    endedAtIso: "2026-10-02T08:30:00.000Z",
    dryRun: false,
  };
}

const todoNode = (identifier: string, title: string) => ({
  id: `id-${identifier}`,
  identifier,
  title,
  url: `https://linear.app/x/issue/${identifier}`,
  priority: 2,
  priorityLabel: "High",
  estimate: 1,
  description: "d",
  team: { key: "DEMO" },
  project: { name: "Demo" },
  comments: { nodes: [] },
});

const fakeFetch = (async (_url: unknown, init: RequestInit) => {
  const { query, variables } = JSON.parse(String(init.body));
  fetchCalls.push({
    query,
    headers: init.headers as Record<string, string>,
    variables,
  });
  const reply = (data: unknown) =>
    new Response(JSON.stringify({ data }), { status: 200 });
  if (query.includes("TodoIssues")) {
    return reply({
      viewer: {
        assignedIssues: {
          nodes: [todoNode("DEMO-1", "first"), todoNode("DEMO-2", "second")],
        },
      },
    });
  }
  if (query.includes("teams")) {
    return reply({ teams: { nodes: [{ key: "DEMO", name: "Growth" }] } });
  }
  return reply({});
}) as unknown as typeof fetch;

const pr = (id: number, branch: string, extra: object = {}) => ({
  pullRequestId: id,
  sourceRefName: `refs/heads/${branch}`,
  targetRefName: "refs/heads/main",
  title: `PR ${id}`,
  reviewers: [],
  ...extra,
});

const fakeExec: Exec = async (cmd, args, opts) => {
  execCalls.push({ cmd, args, cwd: opts.cwd });
  if (cmd === "git") {
    const name = opts.cwd === webRepo ? "web" : "app";
    return { stdout: `https://dev.azure.com/o/P/_git/${name}\n`, stderr: "" };
  }
  if (cmd === "az" && args[0] === "repos" && args[2] === "list") {
    const repository = args[args.indexOf("--repository") + 1];
    if (allPrsFail || prListFailsFor.has(repository)) {
      throw new ExecError("az exploded", "", "az exploded", 1);
    }
    const prs = [
      ...(prListHasPr7 ? [pr(7, "ns/demo-9-x", { createdBy: { uniqueName: "someone@else.com" } })] : []),
      pr(8, "ns/demo-1-first", { autoCompleteSetBy: {}, createdBy: { uniqueName: "Me@Acme.com" } }),
    ];
    return { stdout: JSON.stringify(prs), stderr: "" };
  }
  if (cmd === "az" && args[0] === "repos" && args[2] === "policy") {
    if (policyListFails) throw new ExecError("policy failed", "", "", 1);
    return { stdout: "[]", stderr: "" };
  }
  if (cmd === join(codeRoot, "node_modules/.bin/tsx")) {
    if (usageResult === "error-stdout") {
      throw new ExecError("exit 1", '{"error":"no usage available"}\n', "", 1);
    }
    return {
      stdout: '{"weeklyPercent":40,"resetInfo":"Oct 9"}\n',
      stderr: "",
    };
  }
  if (cmd === "az" && args[0] === "account" && args[1] === "show") {
    return { stdout: JSON.stringify({ user: { name: "me@acme.com" } }), stderr: "" };
  }
  throw new ExecError("spawn herdr ENOENT", "", "", "ENOENT");
};

const todoFetches = () =>
  fetchCalls.filter((c) => c.query.includes("TodoIssues")).length;
const prListCalls = () =>
  execCalls.filter(
    (c) => c.cmd === "az" && c.args[0] === "repos" && c.args[2] === "list",
  ).length;

function deps(over: Partial<DashboardDeps> = {}): DashboardDeps {
  return {
    ...defaultDeps(root),
    codeRoot,
    exec: fakeExec,
    fetch: fakeFetch,
    now: () => now,
    cache: createCache(),
    suffix: () => "ab12",
    ...over,
  };
}

function writeAcme() {
  write(
    join(root, "projects/acme/project.json"),
    JSON.stringify({
      repos: { app: { path: appRepo, checks: [{ name: "t", command: "x" }] } },
      linearTeams: ["DEMO"],
      linearProjects: ["Demo"],
    }),
  );
  write(
    join(root, "projects/acme/.env"),
    `LINEAR_API_KEY=k\nAZURE_DEVOPS_ORG=o\nAZURE_DEVOPS_PROJECT=P\nAZURE_DEVOPS_PAT=${PAT}\nBRANCH_PREFIX=ns\nAZURE_DEVOPS_USER=me@acme.com\n`,
  );
  write(join(root, "tonight.md"), "## DEMO-1 – first\nproject: acme\nrepo: app\n");
}

beforeEach(() => {
  vi.stubEnv("LINEAR_API_KEY", "");
  vi.stubEnv("AZURE_DEVOPS_ORG", "");
  vi.stubEnv("AZURE_DEVOPS_PROJECT", "");
  vi.stubEnv("AZURE_DEVOPS_PAT", "");
  vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "");
  vi.stubEnv("BRANCH_PREFIX", "");
  vi.stubEnv("NIGHTSHIFT_PROJECT", "");
  root = mkdtempSync(join(tmpdir(), "nightshift-"));
  codeRoot = join(root, "code");
  appRepo = join(root, "repos/app");
  webRepo = join(root, "repos/web");
  mkdirSync(join(appRepo, ".git"), { recursive: true });
  mkdirSync(join(webRepo, ".git"), { recursive: true });
  fetchCalls = [];
  execCalls = [];
  prListFailsFor = new Set();
  allPrsFail = false;
  prListHasPr7 = true;
  policyListFails = false;
  usageResult = "ok";
  now = new Date("2026-10-07T20:00:00Z");

  writeAcme();
  write(
    join(root, "projects/example/project.json"),
    JSON.stringify({ repos: { app: { path: appRepo, checks: [{ name: "t", command: "x" }] } }, linearProjects: ["Example"] }),
  );
  write(join(root, "projects/example/.env.example"), "LINEAR_API_KEY=\n");
  write(join(root, "reports/acme/nightshift-2026-10-02.html"), "<html></html>");
  write(
    join(root, "reports/acme/nightshift-2026-10-02.json"),
    JSON.stringify(nightRecord()),
  );
  write(
    join(root, "logs/acme/run.json"),
    JSON.stringify({
      pid: 1,
      base: "nightshift-2026-10-07",
      startedAtIso: "2026-10-07T19:00:00.000Z",
      ticketIndex: 1,
      total: 2,
      ticketId: "DEMO-1",
      phase: "ticket",
      heartbeatAt: "2026-10-07T19:59:30.000Z",
    }),
  );
  sources = createSources(deps());
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function eveningView() {
  const loaded = await sources.evening();
  if (!loaded.ok) throw new Error(`evening failed: ${loaded.error}`);
  return loaded.value;
}

describe("evening", () => {
  it("composes Linear, the root queue, PRs and usage across projects", async () => {
    const view = await eveningView();

    expect(view.queue[0]).toMatchObject({
      id: "DEMO-1",
      project: "acme",
      position: 1,
      repo: "app",
      pr: {
        prId: 8,
        autoComplete: true,
        url: buildPrWebUrl("o", "P", "app", 8),
      },
    });
    expect(view.tabs.map((t) => [t.project, t.rows.map((r) => r.id)])).toEqual([
      ["acme", ["DEMO-1", "DEMO-2"]],
      ["example", []],
    ]);
    expect(view.warnings.map((w) => w.code)).toContain("auto_complete");
    expect(view.sweep[0]).toEqual({ project: "acme", openPrs: { ok: true, value: 1 } });
    expect(view.allowance).toEqual({ percent: 15, source: "nightly default" });
    expect(view.usage).toMatchObject({
      ok: true,
      value: { weeklyPercent: 40, resetInfo: "Oct 9" },
    });

    const todoCall = fetchCalls.find((c) => c.query.includes("TodoIssues"))!;
    expect(todoCall.variables.filter.team).toBeUndefined();
    expect(todoCall.headers.Authorization).toBe("k");
  });

  it("falls back to the az account when AZURE_DEVOPS_USER is unset", async () => {
    write(
      join(root, "projects/acme/.env"),
      "LINEAR_API_KEY=k\nAZURE_DEVOPS_ORG=o\nAZURE_DEVOPS_PROJECT=P\nBRANCH_PREFIX=ns\n",
    );
    const view = await eveningView();
    expect(view.sweep[0].openPrs).toEqual({ ok: true, value: 1 });
    expect(execCalls.some((c) => c.args[0] === "account")).toBe(true);
  });

  it("fails the sweep PR count when the user cannot be identified", async () => {
    write(
      join(root, "projects/acme/.env"),
      "LINEAR_API_KEY=k\nAZURE_DEVOPS_ORG=o\nAZURE_DEVOPS_PROJECT=P\nBRANCH_PREFIX=ns\n",
    );
    const failing: Exec = (cmd, args, opts) =>
      cmd === "az" && args[0] === "account"
        ? Promise.reject(new ExecError("not logged in", "", "", 1))
        : fakeExec(cmd, args, opts);
    sources = createSources(deps({ exec: failing }));
    const view = await eveningView();
    expect(view.sweep[0].openPrs).toEqual({
      ok: false,
      error: "couldn't identify the az user: not logged in",
    });
  });

  it("never lets a credential reach the returned view", async () => {
    expect(JSON.stringify(await eveningView())).not.toContain(PAT);
  });

  it("runs usage once from the code root without a project", async () => {
    await eveningView();
    const usage = execCalls.filter((c) => c.cmd.endsWith("tsx"));
    expect(usage).toHaveLength(1);
    expect(usage[0].args).toEqual(["src/usage.ts"]);
    expect(usage[0].cwd).toBe(codeRoot);
  });

  it("takes the allowance from the root .env and the queue header", async () => {
    write(join(root, ".env"), "NIGHTLY_ALLOWANCE_PERCENT=30\n");
    expect((await eveningView()).allowance).toEqual({ percent: 30, source: "nightly default" });
    write(join(root, "tonight.md"), "allowance: 60\n\n## DEMO-1 – first\nproject: acme\n");
    expect((await eveningView()).allowance).toEqual({ percent: 60, source: "tonight.md" });
  });

  it("still renders queue rows when LINEAR_API_KEY is missing", async () => {
    write(
      join(root, "projects/acme/.env"),
      "AZURE_DEVOPS_ORG=o\nAZURE_DEVOPS_PROJECT=P\nBRANCH_PREFIX=ns\n",
    );
    const view = await eveningView();
    expect(view.linearError).toMatch(/LINEAR_API_KEY/);
    expect(view.queue.map((r) => r.id)).toEqual(["DEMO-1"]);
    expect(fetchCalls).toHaveLength(0);
  });

  it("reads the env files on every load so edits are picked up", async () => {
    await eveningView();
    sources.refresh("all");
    write(
      join(root, "projects/acme/.env"),
      "AZURE_DEVOPS_ORG=o\nAZURE_DEVOPS_PROJECT=P\n",
    );
    expect((await eveningView()).linearError).toMatch(/LINEAR_API_KEY/);
  });

  it("caches Linear and PR loads until they are refreshed", async () => {
    await eveningView();
    await eveningView();
    expect(todoFetches()).toBe(1);
    expect(prListCalls()).toBe(1);

    sources.refresh("linear");
    await eveningView();
    expect(todoFetches()).toBe(2);
    expect(prListCalls()).toBe(1);

    sources.refresh("all");
    await eveningView();
    expect(todoFetches()).toBe(3);
    expect(prListCalls()).toBe(2);
  });

  it("shares one load between concurrent calls on a cold cache", async () => {
    await Promise.all([sources.evening(), sources.evening()]);
    expect(todoFetches()).toBe(1);
    expect(prListCalls()).toBe(1);
  });

  it("fetches snapshots only for queued tickets missing from Todo", async () => {
    write(
      join(root, "tonight.md"),
      "## DEMO-1 – first\nproject: acme\n## DEMO-5 – five\nproject: acme\n",
    );
    const view = await eveningView();
    const snapshotCalls = fetchCalls.filter((c) =>
      c.query.includes("Snapshots"),
    );
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0].variables).toEqual({ i0: "DEMO-5" });
    expect(view.queue.map((r) => r.id)).toContain("DEMO-5");
  });

  it("fails when a project's config is invalid", async () => {
    write(join(root, "projects/acme/project.json"), "{}");
    expect(await sources.evening()).toMatchObject({ ok: false });
  });

  it("shows the queue parse error and keeps the Todo tabs", async () => {
    write(join(root, "tonight.md"), "## DEMO-1 – first\nproject: gone\n");
    const view = await eveningView();
    expect(view.queueError).toMatch(/unknown project "gone"/);
    expect(view.queue).toEqual([]);
    expect(view.tabs[0].rows.map((r) => r.id)).toEqual(["DEMO-1", "DEMO-2"]);
  });

  it("fails on a corrupt prep.json and leaves it untouched", async () => {
    const file = join(root, "state/prep.json");
    write(file, "{ not json");
    expect(await sources.evening()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/prep\.json is not valid JSON/),
    });
    expect(readFileSync(file, "utf-8")).toBe("{ not json");
  });

  it("marks a row unknown when only its repo's PR list failed", async () => {
    write(
      join(root, "projects/acme/project.json"),
      JSON.stringify({
        repos: {
          app: { path: appRepo, checks: [{ name: "t", command: "x" }] },
          web: { path: webRepo, checks: [{ name: "t", command: "x" }] },
        },
        defaultRepo: "app",
        linearProjects: ["Demo"],
      }),
    );
    write(
      join(root, "tonight.md"),
      "## DEMO-1 – first\nproject: acme\nrepo: app\n## DEMO-2 – second\nproject: acme\nrepo: web\n",
    );
    prListFailsFor.add("web");
    const view = await eveningView();
    const byId = Object.fromEntries(view.queue.map((r) => [r.id, r.pr]));
    expect(byId["DEMO-1"]).toMatchObject({ prId: 8 });
    expect(byId["DEMO-2"]).toBe("unknown");
    expect(view.prError).toBeUndefined();
  });

  it("fails the PR lookup with the first error when every list fails", async () => {
    allPrsFail = true;
    const view = await eveningView();
    expect(view.prError).toMatch(/az exploded/);
    expect(view.queue.every((r) => r.pr === "unknown")).toBe(true);
  });

  it("reports a missing Azure org as a PR error without failing the view", async () => {
    write(join(root, "projects/acme/.env"), "LINEAR_API_KEY=k\n");
    const view = await eveningView();
    expect(view.prError).toMatch(/AZURE_DEVOPS_ORG/);
    expect(view.queue.length).toBeGreaterThan(0);
  });

  it("shows the error the usage command printed on stdout", async () => {
    usageResult = "error-stdout";
    expect((await eveningView()).usage).toEqual({ ok: false, error: "no usage available" });
  });

  it("does not cache a failed usage load", async () => {
    usageResult = "error-stdout";
    await eveningView();
    usageResult = "ok";
    expect((await eveningView()).usage.ok).toBe(true);
  });

  it("times out a slow usage load but keeps it running in the cache", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slowExec: Exec = async (cmd, args, opts) => {
        if (cmd.endsWith("tsx")) await gate;
        return fakeExec(cmd, args, opts);
      };
      const slow = createSources(deps({ exec: slowExec }));
      const pending = slow.evening();
      await vi.advanceTimersByTimeAsync(SLOW_MS.usage + 1);
      expect(await pending).toMatchObject({
        ok: true,
        value: { usage: { ok: false, error: /still loading/ } },
      });
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(await slow.evening()).toMatchObject({ value: { usage: { ok: true } } });
      expect(execCalls.filter((c) => c.cmd.endsWith("tsx"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("editQueue", () => {
  const queue = () => readFileSync(join(root, "tonight.md"), "utf-8");

  it("adds a Todo ticket with its title and the project default repo", async () => {
    await sources.editQueue({ op: "add", id: "DEMO-2", project: "acme" });
    expect(queue()).toContain("## DEMO-2 – second\nproject: acme\nrepo: app");
  });

  it("uses the repo recorded by prep when the project has it", async () => {
    write(
      join(root, "state/prep.json"),
      JSON.stringify({ "DEMO-2": { project: "acme", preppedAt: "2026-10-01T00:00:00.000Z", descHash: "h", outcome: "ready", repo: "app" } }),
    );
    await sources.editQueue({ op: "add", id: "DEMO-2", project: "acme", repo: "app" });
    expect(queue()).toContain("DEMO-2");
  });

  it("creates the queue file when there is none", async () => {
    rmSync(join(root, "tonight.md"));
    await sources.editQueue({ op: "add", id: "DEMO-1", project: "acme" });
    expect(queue()).toBe("## DEMO-1 – first\nproject: acme\nrepo: app\n");
  });

  it("refuses a ticket that is not in Todo, a duplicate and a wrong project", async () => {
    await expect(
      sources.editQueue({ op: "add", id: "DEMO-9", project: "acme" }),
    ).rejects.toThrow(/isn't in your Linear Todo list/);
    await expect(
      sources.editQueue({ op: "add", id: "DEMO-1", project: "acme" }),
    ).rejects.toThrow(/already in the queue/);
    await expect(
      sources.editQueue({ op: "add", id: "DEMO-2", project: "example" }),
    ).rejects.toThrow(/doesn't belong to example/);
  });

  it("removes, moves and re-repos, writing nothing when the edit is invalid", async () => {
    await sources.editQueue({ op: "add", id: "DEMO-2", project: "acme" });
    await sources.editQueue({ op: "move", order: ["DEMO-2", "DEMO-1"] });
    expect(queue().indexOf("DEMO-2")).toBeLessThan(queue().indexOf("DEMO-1"));
    const before = queue();
    await expect(
      sources.editQueue({ op: "repo", id: "DEMO-1", repo: "web" }),
    ).rejects.toThrow(/unknown repo/);
    expect(queue()).toBe(before);
    await sources.editQueue({ op: "remove", id: "DEMO-2" });
    expect(queue()).not.toContain("DEMO-2");
  });
});

describe("morning", () => {
  it("lists a needs_review ticket with its live PR", async () => {
    const { items, rows } = await sources.morning();
    const item = items.find((i) => i.key === "ticket:DEMO-9");
    expect(item).toMatchObject({
      kind: "ticket",
      pr: { state: "active", ci: "none", autoComplete: false },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reportId: "acme/nightshift-2026-10-02",
      outstanding: 1,
    });
  });

  it("drops the item once the PR is no longer active", async () => {
    prListHasPr7 = false;
    const { items } = await sources.morning();
    expect(items.find((i) => i.key === "ticket:DEMO-9")).toBeUndefined();
  });

  it("keeps the item with an unknown PR when az fails", async () => {
    allPrsFail = true;
    const { items } = await sources.morning();
    expect(items.find((i) => i.key === "ticket:DEMO-9")).toMatchObject({
      pr: { state: "unknown", reason: expect.stringMatching(/az exploded/) },
    });
  });

  it("keeps the PR active with unknown CI when the policy lookup fails", async () => {
    policyListFails = true;
    const { items } = await sources.morning();
    expect(items.find((i) => i.key === "ticket:DEMO-9")).toMatchObject({
      pr: { state: "active", ci: "unknown" },
    });
  });

  it("keeps the item with an unknown PR when the project no longer loads", async () => {
    rmSync(join(root, "projects/acme"), { recursive: true });
    const { items } = await sources.morning();
    expect(items.find((i) => i.key === "ticket:DEMO-9")).toMatchObject({
      pr: { state: "unknown" },
    });
  });

  it("makes a night with an unreadable record a link-only row", async () => {
    write(join(root, "reports/acme/nightshift-2026-10-02.json"), "{ nope");
    const { rows } = await sources.morning();
    expect(rows[0]).toMatchObject({
      linkOnly: true,
      error: expect.stringMatching(/not valid JSON/),
    });
  });

  it("lists nights newest first", async () => {
    write(join(root, "reports/acme/nightshift-2026-10-05.html"), "<html>");
    const { rows } = await sources.morning();
    expect(rows.map((r) => r.date)).toEqual(["2026-10-05", "2026-10-02"]);
  });

  it("surfaces a corrupt actions store instead of hiding it", async () => {
    write(join(root, "state/actions.json"), "{ nope");
    await expect(sources.morning()).rejects.toThrow(
      /actions\.json is not valid JSON/,
    );
  });
});

describe("runs", () => {
  it("lists projects with a fresh heartbeat", () => {
    expect(sources.runs()).toMatchObject([
      { project: "acme", view: { state: "running" } },
    ]);
  });
});

describe("launch", () => {
  it("falls back to a command when herdr is missing", async () => {
    const result = await sources.launch({ kind: "tonight" });
    expect(result).toMatchObject({
      launched: false,
      reason: "herdr not found",
    });
    expect(result.command).toContain("claude '/tonight'");
    expect(result.command).toContain(codeRoot);
  });
});

describe("projects", () => {
  it("lists the projects and summarises each one", () => {
    expect(sources.projects()).toEqual(["acme", "example"]);
    expect(sources.projectSummaries().map((s) => s.name)).toEqual([
      "acme",
      "example",
    ]);
    for (const summary of sources.projectSummaries()) {
      expect(["pass", "warn", "fail"]).toContain(summary.level);
      expect(typeof summary.reason).toBe("string");
    }
  });
});

describe("linearTeams", () => {
  it("fetches the teams once and caches them", async () => {
    expect(await sources.linearTeams("acme")).toEqual({
      ok: true,
      value: [{ key: "DEMO", name: "Growth" }],
    });
    await sources.linearTeams("acme");
    expect(fetchCalls).toHaveLength(1);
    sources.refresh("teams");
    await sources.linearTeams("acme");
    expect(fetchCalls).toHaveLength(2);
  });

  it("fails without calling Linear when the key is missing", async () => {
    write(join(root, "projects/acme/.env"), "");
    expect(await sources.linearTeams("acme")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/LINEAR_API_KEY/),
    });
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects an invalid project name", async () => {
    expect(await sources.linearTeams("../etc")).toMatchObject({ ok: false });
  });
});

describe("projectChecks", () => {
  it("includes the Linear team and az login checks", async () => {
    const checks = await sources.projectChecks("acme");
    expect(checks.find((c) => c.name === "linearTeams")).toMatchObject({
      level: "pass",
    });
    expect(checks.find((c) => c.name === "az login")).toMatchObject({
      level: "pass",
    });
  });
});

describe("defaultDeps", () => {
  it("lays the data directories out under the root", () => {
    const d = defaultDeps("/data");
    expect(d).toMatchObject({
      root: "/data",
      projectsDir: "/data/projects",
      reportsDir: "/data/reports",
      logsDir: "/data/logs",
      exampleDir: join(ROOT, "templates/project"),
      state: {
        prep: "/data/state/prep.json",
        actions: "/data/state/actions.json",
      },
    });
    expect(d.suffix()).toMatch(/^[a-z0-9]+$/);
  });
});
