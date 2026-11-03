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
    evening: vi.fn(async () => ({
      ok: true as const,
      value: {
        allowance: { percent: 15, source: "nightly default" as const },
        usage: { ok: false as const, error: "usage unavailable" },
        queue: [
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
            project: "acme",
            repo: "app",
            repos: ["app"],
            position: 1,
          },
        ],
        sweep: [{ project: "acme", openPrs: { ok: true as const, value: 0 } }],
        tabs: [
          { project: "acme", rows: [] },
          { project: "example", rows: [] },
        ],
        warnings: [],
      },
    })),
    editQueue: vi.fn(async () => {}),
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
  it("renders the home page with the evening slot", async () => {
    const res = await req("GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain('data-fragment="/fragments/evening"');
  });

  it("passes a known tab to the evening slot and ignores an unknown one", async () => {
    const known = await req("GET", "/?tab=example");
    expect(known.body).toContain('data-fragment="/fragments/evening?tab=example"');
    const unknown = await req("GET", "/?tab=../x");
    expect(unknown.body).toContain('data-fragment="/fragments/evening"');
    expect(unknown.body).not.toContain("../x");
  });

  it("renders the queue and tabs in the evening fragment", async () => {
    const res = await req("GET", "/fragments/evening?tab=example");
    expect(res.status).toBe(200);
    expect(res.body).toContain("DEMO-1");
    expect(res.body).toContain("first ticket");
    expect(res.body).toContain('<a href="?tab=example" aria-current="page">');
    expect(sources.evening).toHaveBeenCalled();
  });

  it("explains an evening load failure with a 200 fragment", async () => {
    vi.mocked(sources.evening).mockResolvedValue({
      ok: false,
      error: "project.json is broken",
    });
    const res = await req("GET", "/fragments/evening");
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

  it("renders a project page with its checks slot", async () => {
    const res = await req("GET", "/projects/acme");
    expect(res.status).toBe(200);
    expect(res.body).toContain("/fragments/project-checks?name=acme");
    expect(res.body).not.toContain("<form");
  });

  it("no longer serves the project editor", async () => {
    expect((await req("GET", "/projects/new")).status).toBe(404);
    for (const path of ["/api/projects", "/api/projects/acme"]) {
      const res = await req("POST", path, { headers: jsonHeaders, body: "{}" });
      expect(res.status, path).toBe(404);
    }
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
    const res = await post("/api/launch", { kind: "tonight" });
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

describe("POST /api/queue", () => {
  const nodes = ["DEMO-1", "DEMO-2"].map((identifier) => ({
    id: `id-${identifier}`,
    identifier,
    title: `title ${identifier}`,
    url: `https://linear.app/x/issue/${identifier}`,
    priority: 2,
    priorityLabel: "High",
    estimate: 1,
    description: "d",
    team: { key: "DEMO" },
    project: { name: "Demo" },
    comments: { nodes: [] },
  }));
  const fetchStub = (async () =>
    new Response(
      JSON.stringify({ data: { viewer: { assignedIssues: { nodes } } } }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const queueFile = () => join(root, "tonight.md");
  const queue = () => readFileSync(queueFile(), "utf-8");
  const post = (body: unknown, headers: Record<string, string> = jsonHeaders) =>
    req("POST", "/api/queue", { headers, body: JSON.stringify(body) });

  beforeEach(async () => {
    vi.stubEnv("LINEAR_API_KEY", "");
    await new Promise((resolve) => server.close(resolve));
    const repo = join(root, "repos/app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    write(
      join(root, "projects/acme/project.json"),
      JSON.stringify({
        repos: { app: { path: repo, checks: [{ name: "t", command: "x" }] } },
        linearProjects: ["Demo"],
      }),
    );
    write(join(root, ".env"), "LINEAR_API_KEY=k\n");
    const deps = { ...defaultDeps(root), fetch: fetchStub, cache: createCache() };
    await listen({
      sources: createSources(deps),
      reportsDir: deps.reportsDir,
      actionsFile: deps.state.actions,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds, moves and removes a ticket on the root queue", async () => {
    expect((await post({ op: "add", id: "DEMO-1", project: "acme" })).status).toBe(200);
    expect((await post({ op: "add", id: "DEMO-2", project: "acme" })).status).toBe(200);
    expect(queue()).toBe(
      "## DEMO-1 – title DEMO-1\nproject: acme\nrepo: app\n\n## DEMO-2 – title DEMO-2\nproject: acme\nrepo: app\n",
    );
    expect((await post({ op: "move", order: ["DEMO-2", "DEMO-1"] })).status).toBe(200);
    expect(queue().indexOf("DEMO-2")).toBeLessThan(queue().indexOf("DEMO-1"));
    expect((await post({ op: "remove", id: "DEMO-2" })).status).toBe(200);
    expect(queue()).not.toContain("DEMO-2");
  });

  it("refuses a move that breaks base order and leaves the file unchanged", async () => {
    const original =
      "## DEMO-1 – one\nproject: acme\nrepo: app\n\n## DEMO-2 – two\nproject: acme\nrepo: app\nbase: DEMO-1\n";
    write(queueFile(), original);
    const res = await post({ op: "move", order: ["DEMO-2", "DEMO-1"] });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/base DEMO-1/);
    expect(queue()).toBe(original);
  });

  it("returns 400 for a malformed request", async () => {
    for (const body of [{ op: "nope" }, { op: "remove", id: "x" }, { op: "move", order: "a" }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("requires X-Nightshift like the other writes", async () => {
    const res = await post({ op: "remove", id: "DEMO-1" }, { "content-type": "application/json" });
    expect(res.status).toBe(403);
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
        repos: { app: { path: repo, checks: [{ name: "t", command: "x" }] } },
        linearTeams: ["DEMO"],
        linearProjects: ["Demo"],
      }),
    );
    write(
      join(root, "projects/acme/.env"),
      `LINEAR_API_KEY=${LINEAR}\nAZURE_DEVOPS_ORG=o\nAZURE_DEVOPS_PROJECT=P\nAZURE_DEVOPS_PAT=${PAT}\n`,
    );
    write(join(root, "tonight.md"), "## DEMO-1 – first\nproject: acme\n");
    write(
      join(root, "projects/example/project.json"),
      JSON.stringify({
        repos: { app: { path: repo, checks: [{ name: "t", command: "x" }] } },
        linearProjects: ["Example"],
      }),
    );
    const deps = {
      ...defaultDeps(root),
      exec: execStub,
      fetch: fetchStub,
      cache: createCache(),
    };
    await listen({
      sources: createSources(deps),
      reportsDir: deps.reportsDir,
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
      "/?tab=acme",
      "/fragments/runs",
      "/fragments/evening?tab=acme",
      "/fragments/inbox",
      "/fragments/nights",
      "/projects",
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
