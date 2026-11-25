import { readFileSync } from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { ROOT } from "../state.js";
import {
  parseActionsBody,
  parseReportId,
  putActions,
  readActions,
} from "./actions.js";
import { DASHBOARD_HOST, DASHBOARD_PORT } from "./address.js";
import { firstLine, parseRefreshTarget } from "./cache.js";
import { parseQueueOp } from "./queue-edit.js";
import { resolveReportFile } from "./reports.js";
import {
  parseAnswers,
  parseApproval,
  parseBlockers,
  parseFeedback,
  parseSessionRequest,
  SessionError,
} from "./sessions.js";
import { checkRequest, preflightHeaders, type Verdict } from "./security.js";
import { createSources, defaultDeps, type Sources } from "./sources.js";
import {
  eveningErrorHTML,
  eveningHTML,
  homeHTML,
} from "./views/clock-off.js";
import { errorBox, page } from "./views/layout.js";
import {
  openPrepsHTML,
  sessionFragmentHTML,
  sessionPageHTML,
} from "./views/session.js";
import { inboxHTML, nightsHTML, runBannerHTML } from "./views/morning.js";
import {
  projectChecksHTML,
  projectPageHTML,
  projectsListHTML,
} from "./views/projects.js";

export interface ServerContext {
  sources: Sources;
  reportsDir: string;
  actionsFile: string;
  codeRoot: string;
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

async function asHttpError<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SessionError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

const SESSION_ACTIONS = "answers|revise|approve|not-ready|retry|cancel";

function routes(ctx: ServerContext): Route[] {
  const { sources } = ctx;
  const { sessions } = sources;
  const knownProject = (name: string | null): name is string =>
    name !== null && sources.projects().includes(name);

  return [
    { method: "GET", pattern: /^\/healthz$/, handler: () => text("ok") },
    {
      method: "GET",
      pattern: /^\/$/,
      handler: ({ query }) => {
        const projects = sources.projects();
        const requested = query.get("tab");
        const tab =
          requested !== null && projects.includes(requested)
            ? requested
            : undefined;
        return html(homeHTML({ projects, tab }));
      },
    },
    {
      method: "GET",
      pattern: /^\/fragments\/runs$/,
      handler: () => html(runBannerHTML(sources.runs())),
    },
    {
      method: "GET",
      pattern: /^\/fragments\/evening$/,
      handler: async ({ query }) => {
        const loaded = await sources.evening();
        return html(
          loaded.ok
            ? eveningHTML(loaded.value, query.get("tab") ?? undefined)
            : eveningErrorHTML(loaded.error),
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
      pattern: /^\/projects\/([^/]+)$/,
      handler: ({ match }) => {
        const name = decodeName(match[1]);
        return knownProject(name) ? html(projectPageHTML(name)) : notFoundPage();
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
      pattern: /^\/api\/sessions$/,
      handler: async ({ readJson }) => {
        const body = await readJson();
        const request = badRequest(() => parseSessionRequest(body, sources.projects()));
        const { session, created } = await asHttpError(() => sessions.start(request));
        return json({ id: session.id, url: `/prep/${session.id}` }, created ? 201 : 200);
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/api/sessions/([A-Za-z0-9-]+)/(${SESSION_ACTIONS})$`),
      handler: async ({ match, readJson }) => {
        const [, sid, act] = match;
        const body = await readJson();
        return asHttpError(async () => {
          const session = sessions.get(sid);
          if (!session) throw new SessionError(404, "no such session");
          const ok = { ok: true };
          switch (act) {
            case "answers": {
              if (!session.survey) throw new SessionError(409, `session is ${session.state}`);
              const { survey } = session;
              sessions.answer(sid, badRequest(() => parseAnswers(body, survey)));
              return json(ok, 202);
            }
            case "revise":
              sessions.revise(sid, badRequest(() => parseFeedback(body)));
              return json(ok, 202);
            case "retry":
              sessions.retry(sid);
              return json(ok, 202);
            case "approve":
              await sessions.approve(sid, badRequest(() => parseApproval(body)));
              return json(ok);
            case "not-ready":
              sessions.notReady(sid, badRequest(() => parseBlockers(body)));
              return json(ok);
            default:
              sessions.cancel(sid);
              return json(ok);
          }
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/prep\/([A-Za-z0-9-]+)$/,
      handler: ({ match }) => {
        const session = sessions.get(match[1]);
        return session ? html(sessionPageHTML(session.id, session.ticketId)) : notFoundPage();
      },
    },
    {
      method: "GET",
      pattern: /^\/fragments\/session\/([A-Za-z0-9-]+)$/,
      handler: ({ match }) => {
        const session = sessions.get(match[1]);
        return session
          ? html(sessionFragmentHTML(session, ctx.codeRoot))
          : html(errorBox("No such session"), 404);
      },
    },
    {
      method: "GET",
      pattern: /^\/fragments\/sessions$/,
      handler: () => html(openPrepsHTML(sessions.listOpen())),
    },
    {
      method: "POST",
      pattern: /^\/api\/queue$/,
      handler: async ({ readJson }) => {
        const body = await readJson();
        const op = badRequest(() => parseQueueOp(body));
        try {
          await sources.editQueue(op);
        } catch (error) {
          throw new HttpError(400, firstLine(error));
        }
        return json({ ok: true });
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
      if (res.headersSent) {
        console.error(`${method} ${target.pathname}: ${firstLine(error)}`);
        res.destroy();
        return;
      }
      send(res, failure(error, method, target.pathname), guard);
    }
  });
}

function main(): void {
  const root = process.env.NIGHTSHIFT_ROOT ?? ROOT;
  const port = Number(process.env.NIGHTSHIFT_DASHBOARD_PORT ?? DASHBOARD_PORT);
  const deps = defaultDeps(root);
  const sources = createSources(deps);
  sources.sessions.recover();
  const server = createDashboardServer({
    sources,
    reportsDir: deps.reportsDir,
    actionsFile: deps.state.actions,
    codeRoot: deps.codeRoot,
  });
  server.requestTimeout = 30_000;
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
