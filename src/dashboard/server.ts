import { readFileSync } from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { readRawProjectConfig } from "../project.js";
import { ROOT } from "../state.js";
import {
  parseActionsBody,
  parseReportId,
  putActions,
  readActions,
} from "./actions.js";
import { DASHBOARD_HOST, DASHBOARD_PORT } from "./address.js";
import { firstLine, parseRefreshTarget } from "./cache.js";
import { parseLaunchRequest } from "./launch.js";
import {
  createProject,
  parseProjectInput,
  saveProjectConfig,
} from "./project-edit.js";
import { resolveReportFile } from "./reports.js";
import { checkRequest, preflightHeaders, type Verdict } from "./security.js";
import { createSources, defaultDeps, type Sources } from "./sources.js";
import {
  clockOffErrorHTML,
  clockOffHTML,
  homeHTML,
} from "./views/clock-off.js";
import { errorBox, page } from "./views/layout.js";
import { inboxHTML, nightsHTML, runBannerHTML } from "./views/morning.js";
import {
  newProjectHTML,
  projectChecksHTML,
  projectPageHTML,
  projectsListHTML,
} from "./views/projects.js";

export interface ServerContext {
  sources: Sources;
  reportsDir: string;
  projectsDir: string;
  exampleDir: string;
  actionsFile: string;
}

export const MAX_BODY_BYTES = 65_536;

interface Reply {
  status: number;
  type: string;
  body: string | Buffer;
  headers?: Record<string, string>;
}

interface Route {
  method: "GET" | "PUT" | "POST" | "OPTIONS";
  pattern: RegExp;
  handler: (call: Call) => Reply | Promise<Reply>;
}

interface Call {
  pathname: string;
  query: URLSearchParams;
  match: RegExpMatchArray;
  verdict: Extract<Verdict, { ok: true }>;
  readJson: () => Promise<unknown>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const HTML = "text/html; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";

const html = (body: string, status = 200): Reply => ({
  status,
  type: HTML,
  body,
});
const json = (data: unknown, status = 200): Reply => ({
  status,
  type: JSON_TYPE,
  body: JSON.stringify(data),
});
const text = (body: string, status = 200): Reply => ({
  status,
  type: TEXT,
  body,
});

const notFoundPage = (): Reply =>
  html(
    page({
      title: "Not found",
      nav: "tonight",
      body: `<h1>Not found</h1><p><a href="/">Back to tonight</a></p>`,
    }),
    404,
  );

function badRequest<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new HttpError(400, firstLine(error));
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () =>
      size > MAX_BODY_BYTES
        ? reject(new HttpError(413, "request body too large"))
        : resolve(Buffer.concat(chunks)),
    );
    req.on("error", reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw.toString("utf-8"));
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

function decodeName(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function clearProjectCaches(sources: Sources): void {
  for (const target of ["linear", "teams", "prs"] as const) {
    sources.refresh(target);
  }
}

function routes(ctx: ServerContext): Route[] {
  const { sources } = ctx;
  const knownProject = (name: string | null): name is string =>
    name !== null && sources.projects().includes(name);

  return [
    { method: "GET", pattern: /^\/healthz$/, handler: () => text("ok") },
    {
      method: "GET",
      pattern: /^\/$/,
      handler: ({ query }) => {
        const projects = sources.projects();
        const requested = query.get("project");
        const selected =
          requested !== null && projects.includes(requested)
            ? requested
            : sources.defaultProject();
        return html(homeHTML({ projects, selected }));
      },
    },
    {
      method: "GET",
      pattern: /^\/fragments\/runs$/,
      handler: () => html(runBannerHTML(sources.runs())),
    },
    {
      method: "GET",
      pattern: /^\/fragments\/clock-off$/,
      handler: async ({ query }) => {
        const project = query.get("project");
        if (!knownProject(project)) {
          return html(errorBox("Unknown project"), 404);
        }
        const loaded = await sources.clockOff(project);
        return html(
          loaded.ok
            ? clockOffHTML(loaded.value)
            : clockOffErrorHTML(project, loaded.error),
        );
      },
    },
    {
      method: "GET",
      pattern: /^\/fragments\/inbox$/,
      handler: async () => html(inboxHTML((await sources.morning()).items)),
    },
    {
      method: "GET",
      pattern: /^\/fragments\/nights$/,
      handler: async () => html(nightsHTML((await sources.morning()).rows)),
    },
    {
      method: "GET",
      pattern: /^\/projects$/,
      handler: () => html(projectsListHTML(sources.projectSummaries())),
    },
    {
      method: "GET",
      pattern: /^\/projects\/new$/,
      handler: async () => {
        const base = sources.defaultProject();
        const teams = base
          ? await sources.linearTeams(base)
          : {
              ok: false as const,
              error: "no existing project to read Linear teams from",
            };
        return html(newProjectHTML(teams));
      },
    },
    {
      method: "GET",
      pattern: /^\/projects\/([^/]+)$/,
      handler: async ({ match }) => {
        const name = decodeName(match[1]);
        if (!knownProject(name)) return notFoundPage();
        let raw: unknown;
        let rawError: string | undefined;
        try {
          raw = readRawProjectConfig(name, ctx.projectsDir).raw;
        } catch (error) {
          rawError = firstLine(error);
        }
        const teams = await sources.linearTeams(name);
        return html(projectPageHTML(name, raw, rawError, teams));
      },
    },
    {
      method: "GET",
      pattern: /^\/fragments\/project-checks$/,
      handler: async ({ query }) => {
        const name = query.get("name");
        if (!knownProject(name)) {
          return html(errorBox("Unknown project"), 404);
        }
        return html(projectChecksHTML(await sources.projectChecks(name)));
      },
    },
    {
      method: "GET",
      pattern: /^\/reports\/.+$/,
      handler: ({ pathname }) => {
        const file = resolveReportFile(ctx.reportsDir, pathname);
        return file ? html(readFileSync(file, "utf-8")) : notFoundPage();
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/actions$/,
      handler: ({ query }) => {
        const report = badRequest(() => parseReportId(query.get("report")));
        return json(readActions(ctx.actionsFile)[report] ?? {});
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/actions$/,
      handler: async ({ query, readJson, verdict }) => {
        const report = badRequest(() => parseReportId(query.get("report")));
        const body = await readJson();
        const incoming = badRequest(() => parseActionsBody(body));
        const merged = putActions(
          ctx.actionsFile,
          report,
          incoming,
          verdict.nullOrigin ? "tickWins" : "latest",
        );
        return json(merged);
      },
    },
    {
      method: "OPTIONS",
      pattern: /^\/api\/actions$/,
      handler: () => ({
        status: 204,
        type: TEXT,
        body: "",
        headers: preflightHeaders(),
      }),
    },
    {
      method: "POST",
      pattern: /^\/api\/launch$/,
      handler: async ({ readJson }) => {
        const body = await readJson();
        const request = badRequest(() =>
          parseLaunchRequest(body, sources.projects()),
        );
        return json(await sources.launch(request));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/refresh$/,
      handler: async ({ readJson }) => {
        const body = await readJson();
        const target = badRequest(() => parseRefreshTarget(body));
        sources.refresh(target);
        return json({ ok: true });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/projects$/,
      handler: async ({ readJson }) => {
        const body = await readJson();
        const created = badRequest(() => {
          const input = parseProjectInput(body);
          const name = (body as { name?: unknown }).name;
          if (typeof name !== "string") throw new Error("name is required");
          const { envKeys } = createProject(
            name,
            input,
            ctx.projectsDir,
            ctx.exampleDir,
          );
          return { name, envKeys };
        });
        clearProjectCaches(sources);
        return json(
          {
            ok: true,
            dir: `projects/${created.name}`,
            envKeys: created.envKeys,
          },
          201,
        );
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/projects\/([^/]+)$/,
      handler: async ({ match, readJson }) => {
        const name = decodeName(match[1]);
        if (!knownProject(name)) return json({ error: "not found" }, 404);
        const body = await readJson();
        badRequest(() =>
          saveProjectConfig(name, parseProjectInput(body), ctx.projectsDir),
        );
        clearProjectCaches(sources);
        return json({ ok: true });
      },
    },
  ];
}

function splitUrl(rawUrl: string | undefined): {
  pathname: string;
  query: URLSearchParams;
} | null {
  if (!rawUrl || !rawUrl.startsWith("/")) return null;
  const queryStart = rawUrl.indexOf("?");
  const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const query = new URLSearchParams(
    queryStart === -1 ? "" : rawUrl.slice(queryStart + 1),
  );
  return { pathname, query };
}

function send(
  res: http.ServerResponse,
  reply: Reply,
  verdict: Verdict | null,
): void {
  const corsHeaders =
    verdict?.ok && verdict.nullOrigin
      ? { "Access-Control-Allow-Origin": "null" }
      : {};
  res.writeHead(reply.status, {
    "Content-Type": reply.type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...corsHeaders,
    ...reply.headers,
  });
  res.end(reply.body);
}

function failure(error: unknown, method: string, pathname: string): Reply {
  if (error instanceof HttpError)
    return json({ error: error.message }, error.status);
  console.error(`${method} ${pathname}: ${firstLine(error)}`);
  return json({ error: firstLine(error) }, 500);
}

export function createDashboardServer(ctx: ServerContext): http.Server {
  const table = routes(ctx);

  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const target = splitUrl(req.url);
    const guard = target
      ? checkRequest(
          { method, pathname: target.pathname, headers: req.headers },
          req.socket.localPort ?? 0,
        )
      : null;
    if (!target || guard === null) {
      req.resume();
      return send(res, text("bad request", 400), null);
    }
    if (!guard.ok) {
      req.resume();
      return send(res, text(guard.reason, guard.status), null);
    }

    const routed = method === "HEAD" ? "GET" : method;
    const route = table.find(
      (candidate) =>
        candidate.method === routed && candidate.pattern.test(target.pathname),
    );
    try {
      if (!route) {
        req.resume();
        const reply =
          routed === "GET" ? notFoundPage() : json({ error: "not found" }, 404);
        return send(res, reply, guard);
      }
      const match = target.pathname.match(route.pattern)!;
      const reply = await route.handler({
        pathname: target.pathname,
        query: target.query,
        match,
        verdict: guard,
        readJson: () => readJsonBody(req),
      });
      send(res, reply, guard);
    } catch (error) {
      send(res, failure(error, method, target.pathname), guard);
    }
  });
}

function main(): void {
  const root = process.env.NIGHTSHIFT_ROOT ?? ROOT;
  const port = Number(process.env.NIGHTSHIFT_DASHBOARD_PORT ?? DASHBOARD_PORT);
  const deps = defaultDeps(root);
  const server = createDashboardServer({
    sources: createSources(deps),
    reportsDir: deps.reportsDir,
    projectsDir: deps.projectsDir,
    exampleDir: deps.exampleDir,
    actionsFile: deps.state.actions,
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${port} is already in use. Is the dashboard already running?`,
      );
    } else {
      console.error(`Dashboard failed to start: ${firstLine(error)}`);
    }
    process.exit(1);
  });
  server.listen(port, DASHBOARD_HOST, () => {
    console.log(`Nightshift dashboard on http://${DASHBOARD_HOST}:${port}`);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
