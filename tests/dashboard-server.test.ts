import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCache } from "../src/dashboard/cache.js";
import { ExecError, type Exec } from "../src/dashboard/exec.js";
import {
  MAX_BODY_BYTES,
  createDashboardServer,
  type ServerContext,
} from "../src/dashboard/server.js";
import {
  createSources,
  defaultDeps,
  type Sources,
} from "../src/dashboard/sources.js";

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const REPORT_ID = "acme/nightshift-2026-10-01";
const TICK = {
  "ticket:DEMO-1": {
    at: "2026-10-02T09:00:00.000Z",
    updatedAt: "2026-10-02T09:00:00.000Z",
  },
};

let root: string;
let server: http.Server;
let port: number;
let ctx: ServerContext;
let sources: Sources;

const write = (file: string, content: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
};

function fakeSources(): Sources {
  return {
    projects: vi.fn(() => ["acme", "example"]),
    defaultProject: vi.fn(() => "acme"),
    clockOff: vi.fn(async () => ({
      ok: true as const,
      value: {
        project: "acme",
        allowance: { percent: 15, source: "project default" as const },
        usage: { ok: false as const, error: "usage unavailable" },
        rows: [
          {
            id: "DEMO-1",
            title: "first ticket",
            url: "https://linear.app/x/issue/DEMO-1",
            priority: "High",
            priorityRank: 2,
            estimate: 1,
            inTodo: true,
            prep: null,
            tonightPosition: 1,
            pr: null,
          },
        ],
        warnings: [],
      },
    })),
    morning: vi.fn(async () => ({ items: [], rows: [] })),
    runs: vi.fn(() => []),
    projectSummaries: vi.fn(() => [
      { name: "acme", level: "pass" as const, reason: "" },
    ]),
    projectChecks: vi.fn(async () => []),
    linearTeams: vi.fn(async () => ({
      ok: true as const,
      value: [{ key: "DEMO", name: "Growth" }],
    })),
    launch: vi.fn(async () => ({
      launched: true as const,
      workspaceId: "w1",
      paneId: "p1",
      agent: "prep-eng-1-ab12",
      command: "cmd",
    })),
    refresh: vi.fn(),
  };
}

function req(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        method,
        host: "127.0.0.1",
        port,
        path,
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(opts.body);
  });
}

const ns = { "x-nightshift": "1" };
const jsonHeaders = { ...ns, "content-type": "application/json" };

const putActions = (
  body: string,
  headers: Record<string, string> = jsonHeaders,
  report = REPORT_ID,
) =>
  req("PUT", `/api/actions?report=${encodeURIComponent(report)}`, {
    headers,
    body,
  });

function listen(context: ServerContext): Promise<void> {
  server = createDashboardServer(context);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nightshift-"));
  write(
    join(root, "reports/acme/nightshift-2026-10-01.html"),
    "<html>report body</html>",
  );
  write(join(root, "secret.html"), "<html>top secret</html>");
  write(join(root, "projects/acme/.env"), "LINEAR_API_KEY=supersecret\n");
  sources = fakeSources();
  ctx = {
    sources,
    reportsDir: join(root, "reports"),
    projectsDir: join(root, "projects"),
    exampleDir: join(root, "projects/example"),
    actionsFile: join(root, "state/actions.json"),
  };
  await listen(ctx);
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

describe("guard and headers", () => {
  it("serves /healthz with the hardening headers", async () => {
    const res = await req("GET", "/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("rejects a foreign Host with 403 as plain text", async () => {
    const res = await req("GET", "/healthz", { headers: { host: "evil.com" } });
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("applies the guard to the path without the query string", async () => {
    const res = await req("OPTIONS", "/api/actions?report=x", {
      headers: { origin: "null" },
    });
    expect(res.status).toBe(204);
  });
});

describe("failure after headers are sent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("destroys the connection without crashing or rejecting, and keeps serving", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(http.ServerResponse.prototype, "end").mockImplementationOnce(
      () => {
        throw new Error("write failed");
      },
    );

    await expect(req("GET", "/healthz")).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", onRejection);

    expect(rejections).toEqual([]);
    expect((await req("GET", "/healthz")).body).toBe("ok");
  });
});

describe("pages and fragments", () => {
  it("renders the home page with the clock-off slot", async () => {
    const res = await req("GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain(
      'data-fragment="/fragments/clock-off?project=acme"',
    );
  });

  it("falls back to the default project for an unknown selection", async () => {
    const res = await req("GET", "/?project=../x");
    expect(res.status).toBe(200);
    expect(res.body).toContain(
      'data-fragment="/fragments/clock-off?project=acme"',
    );
    expect(res.body).not.toContain("../x");
  });

  it("honours a known project selection", async () => {
    const res = await req("GET", "/?project=example");
    expect(res.body).toContain(
      'data-fragment="/fragments/clock-off?project=example"',
    );
  });

  it("renders clock-off rows for a known project", async () => {
    const res = await req("GET", "/fragments/clock-off?project=acme");
    expect(res.status).toBe(200);
    expect(res.body).toContain("DEMO-1");
    expect(res.body).toContain("first ticket");
    expect(sources.clockOff).toHaveBeenCalledWith("acme");
  });

  it("404s a clock-off fragment for an unknown project", async () => {
    const res = await req("GET", "/fragments/clock-off?project=nope");
    expect(res.status).toBe(404);
    expect(res.body).toContain("error");
    expect(sources.clockOff).not.toHaveBeenCalled();
  });

  it("explains a clock-off load failure with a 200 fragment", async () => {
    vi.mocked(sources.clockOff).mockResolvedValue({
      ok: false,
      error: "project.json is broken",
    });
    const res = await req("GET", "/fragments/clock-off?project=acme");
    expect(res.status).toBe(200);
    expect(res.body).toContain("can't be loaded");
    expect(res.body).toContain("project.json is broken");
  });

  it("serves the runs, inbox and nights fragments", async () => {
    for (const path of [
      "/fragments/runs",
      "/fragments/inbox",
      "/fragments/nights",
    ]) {
      const res = await req("GET", path);
      expect(res.status, path).toBe(200);
    }
    expect(sources.morning).toHaveBeenCalledTimes(2);
  });

  it("lists projects", async () => {
    const res = await req("GET", "/projects");
    expect(res.status).toBe(200);
    expect(res.body).toContain("/projects/acme");
  });

  it("renders the new project form with the default project's teams", async () => {
    const res = await req("GET", "/projects/new");
    expect(res.status).toBe(200);
    expect(res.body).toContain('data-mode="create"');
    expect(sources.linearTeams).toHaveBeenCalledWith("acme");
  });

  it("renders the new project form when no project exists yet", async () => {
    vi.mocked(sources.defaultProject).mockReturnValue(undefined);
    const res = await req("GET", "/projects/new");
    expect(res.status).toBe(200);
    expect(res.body).toContain('data-mode="create"');
    expect(sources.linearTeams).not.toHaveBeenCalled();
  });

  it("renders a project page with its raw config", async () => {
    write(
      join(root, "projects/acme/project.json"),
      JSON.stringify({
        repos: { app: { path: "/x", toolchain: "node" } },
        testDb: "marker-test-db",
      }),
    );
    const res = await req("GET", "/projects/acme");
    expect(res.status).toBe(200);
    expect(res.body).toContain('data-mode="edit"');
    expect(res.body).toContain("marker-test-db");
  });

  it("shows a broken project.json instead of failing", async () => {
    write(join(root, "projects/acme/project.json"), "{nope");
    const res = await req("GET", "/projects/acme");
    expect(res.status).toBe(200);
    expect(res.body).toContain("can't be read");
  });

  it("404s an unknown project page", async () => {
    const res = await req("GET", "/projects/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("renders the project checks fragment", async () => {
    const res = await req("GET", "/fragments/project-checks?name=acme");
    expect(res.status).toBe(200);
    expect(sources.projectChecks).toHaveBeenCalledWith("acme");
  });

  it("404s project checks for an unknown project", async () => {
    const res = await req("GET", "/fragments/project-checks?name=nope");
    expect(res.status).toBe(404);
    expect(sources.projectChecks).not.toHaveBeenCalled();
  });

  it("serves HTML for unknown GET paths and JSON otherwise", async () => {
    const page = await req("GET", "/nope");
    expect(page.status).toBe(404);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    const api = await req("POST", "/nope", {
      headers: jsonHeaders,
      body: "{}",
    });
    expect(api.status).toBe(404);
    expect(JSON.parse(api.body)).toEqual({ error: "not found" });
  });
});

describe("reports", () => {
  it("serves a report file as HTML", async () => {
    const res = await req("GET", "/reports/acme/nightshift-2026-10-01.html");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toBe("<html>report body</html>");
  });

  it("404s an encoded traversal", async () => {
    const res = await req("GET", "/reports/%2e%2e/secret.html");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("top secret");
  });

  it("404s a missing report", async () => {
    const res = await req("GET", "/reports/acme/nightshift-2026-10-09.html");
    expect(res.status).toBe(404);
  });
});

describe("actions API", () => {
  it("stores ticks and reads them back", async () => {
    const put = await putActions(JSON.stringify(TICK));
    expect(put.status).toBe(200);
    expect(JSON.parse(put.body)).toEqual(TICK);

    const got = await req(
      "GET",
      `/api/actions?report=${encodeURIComponent(REPORT_ID)}`,
    );
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body)).toEqual(TICK);

    const stored = JSON.parse(readFileSync(ctx.actionsFile, "utf-8"));
    expect(stored[REPORT_ID]).toEqual(TICK);
  });

  it("returns an empty map for a report with no actions", async () => {
    const got = await req(
      "GET",
      `/api/actions?report=${encodeURIComponent(REPORT_ID)}`,
    );
    expect(JSON.parse(got.body)).toEqual({});
  });

  it("refuses a PUT without X-Nightshift and writes nothing", async () => {
    const res = await putActions(JSON.stringify(TICK), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(403);
    expect(existsSync(ctx.actionsFile)).toBe(false);
  });

  it("refuses a foreign origin", async () => {
    const res = await putActions(JSON.stringify(TICK), {
      ...jsonHeaders,
      origin: "https://evil.com",
    });
    expect(res.status).toBe(403);
    expect(existsSync(ctx.actionsFile)).toBe(false);
  });

  it("accepts a null origin with CORS headers and tick-wins merging", async () => {
    write(
      ctx.actionsFile,
      JSON.stringify({
        [REPORT_ID]: {
          "ticket:DEMO-1": {
            at: null,
            updatedAt: "2026-10-03T09:00:00.000Z",
          },
        },
      }),
    );
    const res = await putActions(JSON.stringify(TICK), {
      ...jsonHeaders,
      origin: "null",
    });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("null");
    const stored = JSON.parse(readFileSync(ctx.actionsFile, "utf-8"));
    expect(stored[REPORT_ID]["ticket:DEMO-1"].at).not.toBeNull();
  });

  it("answers the null-origin preflight", async () => {
    const res = await req("OPTIONS", "/api/actions", {
      headers: { origin: "null" },
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-headers"]).toContain(
      "X-Nightshift",
    );
    expect(res.headers["access-control-allow-origin"]).toBe("null");
  });

  it("rejects a bad report id on PUT and GET", async () => {
    const put = await putActions(JSON.stringify(TICK), jsonHeaders, "../x");
    expect(put.status).toBe(400);
    expect(JSON.parse(put.body).error).toMatch(/report id/);
    const got = await req("GET", "/api/actions?report=../x");
    expect(got.status).toBe(400);
  });

  it("rejects an invalid body with its reason", async () => {
    const res = await putActions(JSON.stringify({ "bad key": {} }));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/invalid action key/);
  });

  it("rejects a non-JSON body", async () => {
    const res = await putActions("nope");
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "body must be JSON" });
  });

  it("rejects a body over the cap with 413", async () => {
    const res = await putActions("x".repeat(70_000));
    expect(res.status).toBe(413);
    expect(MAX_BODY_BYTES).toBe(65_536);
    expect(existsSync(ctx.actionsFile)).toBe(false);
  });

  it("reports a corrupt store as an error and leaves it untouched", async () => {
    write(ctx.actionsFile, "{corrupt");
    const res = await putActions(JSON.stringify(TICK));
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).not.toContain("\n");
    expect(readFileSync(ctx.actionsFile, "utf-8")).toBe("{corrupt");
  });
});

describe("launch and refresh", () => {
  const post = (path: string, body: unknown) =>
    req("POST", path, { headers: jsonHeaders, body: JSON.stringify(body) });

  it("rejects an invalid launch without calling sources", async () => {
    const res = await post("/api/launch", {
      kind: "prep",
      id: "eng-1",
      project: "acme",
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/ticket ID/);
    expect(sources.launch).not.toHaveBeenCalled();
  });

  it("launches a valid request", async () => {
    const res = await post("/api/launch", {
      kind: "prep",
      id: "ENG-1",
      project: "acme",
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      launched: true,
      agent: "prep-eng-1-ab12",
    });
    expect(sources.launch).toHaveBeenCalledWith({
      kind: "prep",
      id: "ENG-1",
      project: "acme",
    });
  });

  it("passes a herdr fallback through as a 200", async () => {
    const fallback = {
      launched: false as const,
      command: "run it",
      reason: "no herdr",
    };
    vi.mocked(sources.launch).mockResolvedValue(fallback);
    const res = await post("/api/launch", { kind: "tonight", project: "acme" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(fallback);
  });

  it("refreshes a cache", async () => {
    const res = await post("/api/refresh", { what: "usage" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(sources.refresh).toHaveBeenCalledWith("usage");
  });

  it("rejects an unknown refresh target", async () => {
    const res = await post("/api/refresh", { what: "everything" });
    expect(res.status).toBe(400);
    expect(sources.refresh).not.toHaveBeenCalled();
  });

  it("requires X-Nightshift on POST", async () => {
    const res = await req("POST", "/api/refresh", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ what: "usage" }),
    });
    expect(res.status).toBe(403);
    expect(sources.refresh).not.toHaveBeenCalled();
  });
});

describe("project API", () => {
  const post = (path: string, body: unknown) =>
    req("POST", path, { headers: jsonHeaders, body: JSON.stringify(body) });

  const repoInput = (path: string) => ({
    name: "app",
    path,
    toolchain: "node",
    description: "",
  });

  beforeEach(() => {
    mkdirSync(join(root, "repos/app/.git"), { recursive: true });
    write(
      join(root, "projects/example/project.json"),
      JSON.stringify({ repos: { app: { path: "/x", toolchain: "node" } } }),
    );
    write(join(root, "projects/example/tonight.md"), "# tonight\n");
    write(join(root, "projects/example/.env.example"), "LINEAR_API_KEY=\n");
    write(
      join(root, "projects/acme/project.json"),
      JSON.stringify({
        repos: { app: { path: join(root, "repos/app"), toolchain: "node" } },
      }),
    );
  });

  it("rejects invalid input on save with an error", async () => {
    const res = await post("/api/projects/acme", { repos: "nope" });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/repos/);
  });

  it("404s a save for an unknown project", async () => {
    const res = await post("/api/projects/nope", { repos: [] });
    expect(res.status).toBe(404);
  });

  it("saves a project and clears its cached Linear and PR data", async () => {
    write(join(root, "projects/acme/db.sh"), "#!/bin/sh\n");
    const res = await post("/api/projects/acme", {
      repos: [repoInput(join(root, "repos/app"))],
      testDb: "db.sh",
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    const saved = JSON.parse(
      readFileSync(join(root, "projects/acme/project.json"), "utf-8"),
    );
    expect(saved.testDb).toBe("db.sh");
    const cleared = vi.mocked(sources.refresh).mock.calls.map(([t]) => t);
    expect(cleared).toEqual(expect.arrayContaining(["linear", "teams", "prs"]));
  });

  it("creates a project and returns the env keys to fill", async () => {
    const res = await post("/api/projects", {
      name: "fresh",
      repos: [repoInput(join(root, "repos/app"))],
    });
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      dir: "projects/fresh",
      envKeys: expect.arrayContaining(["LINEAR_API_KEY"]),
    });
    expect(existsSync(join(root, "projects/fresh/project.json"))).toBe(true);
    expect(sources.refresh).toHaveBeenCalled();
  });

  it("refuses to create a project that already exists", async () => {
    const res = await post("/api/projects", {
      name: "acme",
      repos: [repoInput(join(root, "repos/app"))],
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/already exists/);
  });

  it("rejects a non-JSON body", async () => {
    const res = await req("POST", "/api/projects", {
      headers: jsonHeaders,
      body: "nope",
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "body must be JSON" });
  });
});

describe("no secrets in responses", () => {
  const PAT = "SENTINEL_PAT_123";
  const LINEAR = "SENTINEL_LIN_456";
  let seenKeys: string[];

  const linearReply = (query: string) => {
    if (query.includes("TodoIssues")) {
      return { viewer: { assignedIssues: { nodes: [] } } };
    }
    return { teams: { nodes: [{ key: "DEMO", name: "Growth" }] } };
  };

  const fetchStub = (async (_url: unknown, init: RequestInit) => {
    seenKeys.push(
      String((init.headers as Record<string, string>).Authorization),
    );
    const { query } = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ data: linearReply(query) }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const execStub: Exec = async (cmd, args) => {
    if (cmd === "git") {
      return { stdout: "https://dev.azure.com/o/P/_git/app\n", stderr: "" };
    }
    if (cmd === "az" && args[0] === "repos") {
      return { stdout: "[]", stderr: "" };
    }
    throw new ExecError(`${cmd} unavailable`, "", "", 1);
  };

  beforeEach(async () => {
    seenKeys = [];
    for (const key of [
      "LINEAR_API_KEY",
      "AZURE_DEVOPS_PAT",
      "AZURE_DEVOPS_EXT_PAT",
      "AZURE_DEVOPS_ORG",
      "AZURE_DEVOPS_PROJECT",
    ]) {
      vi.stubEnv(key, "");
    }
    await new Promise((resolve) => server.close(resolve));

    const repo = join(root, "repos/app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    write(
      join(root, "projects/acme/project.json"),
      JSON.stringify({
        repos: { app: { path: repo, toolchain: "node" } },
        linearTeams: ["DEMO"],
      }),
    );
    write(
      join(root, "projects/acme/.env"),
      `LINEAR_API_KEY=${LINEAR}\nAZURE_DEVOPS_ORG=o\nAZURE_DEVOPS_PROJECT=P\nAZURE_DEVOPS_PAT=${PAT}\n`,
    );
    write(join(root, "projects/acme/tonight.md"), "## DEMO-1 – first\n");
    write(join(root, "projects/example/project.json"), "{}");
    const deps = {
      ...defaultDeps(root),
      exec: execStub,
      fetch: fetchStub,
      cache: createCache(),
    };
    await listen({
      sources: createSources(deps),
      reportsDir: deps.reportsDir,
      projectsDir: deps.projectsDir,
      exampleDir: deps.exampleDir,
      actionsFile: deps.state.actions,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never sends env values in any GET response", async () => {
    const paths = [
      "/healthz",
      "/",
      "/?project=acme",
      "/fragments/runs",
      "/fragments/clock-off?project=acme",
      "/fragments/inbox",
      "/fragments/nights",
      "/projects",
      "/projects/new",
      "/projects/acme",
      "/fragments/project-checks?name=acme",
      "/reports/acme/nightshift-2026-10-01.html",
      `/api/actions?report=${encodeURIComponent(REPORT_ID)}`,
      "/nope",
    ];
    for (const path of paths) {
      const res = await req("GET", path);
      expect(res.body, path).not.toContain(PAT);
      expect(res.body, path).not.toContain(LINEAR);
      expect(JSON.stringify(res.headers), path).not.toContain(PAT);
      expect(JSON.stringify(res.headers), path).not.toContain(LINEAR);
    }
    expect(seenKeys).toContain(LINEAR);
  });
});
