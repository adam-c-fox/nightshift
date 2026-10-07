import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseUsageSummary, type UsageSummary } from "../budget.js";
import { envLookup, parseEnv } from "../env.js";
import {
  fetchIssueSnapshots,
  fetchTeams,
  fetchTodoIssues,
  type IssueSnapshot,
  type LinearClient,
  type LinearTeam,
  type TodoIssue,
} from "../linear.js";
import { readProjectRuns, type ProjectRun } from "../heartbeat.js";
import { readNightRecord } from "../night-record.js";
import { buildPrWebUrl, pickTicketPr, voteSummary } from "../pr.js";
import { readPrepStore } from "../prep.js";
import {
  listProjects,
  loadProject,
  PROJECT_NAME,
  type Project,
} from "../project.js";
import { ROOT, statePaths, type StatePaths } from "../state.js";
import { loadAllowance, loadTickets } from "../tickets.js";
import type { Ticket } from "../types.js";
import { ticketBranchName } from "../worktree.js";
import { readActions } from "./actions.js";
import {
  azLoginStatus,
  azProjectFrom,
  listActivePrs,
  prCiVerdict,
  type ActivePrList,
  type AzProject,
} from "./azure.js";
import {
  cacheKeys,
  createCache,
  firstLine,
  REFRESH_PREFIXES,
  settle,
  TTL_MS,
  type Loaded,
  type RefreshTarget,
  type TtlCache,
} from "./cache.js";
import {
  buildClockOff,
  type ClockOffView,
  type PrLookup,
  type TicketPr,
} from "./clock-off.js";
import { ExecError, execAsync, type Exec } from "./exec.js";
import {
  buildInbox,
  nightRows,
  prRefs,
  type InboxItem,
  type NightData,
  type NightRow,
  type PrLive,
  type PrRef,
} from "./inbox.js";
import {
  launch as launchInHerdr,
  type LaunchRequest,
  type LaunchResult,
} from "./launch.js";
import {
  fileChecks,
  overallLevel,
  projectChecks,
  type CheckLevel,
  type ConfigCheck,
} from "./project-checks.js";
import { listNightFiles } from "./reports.js";

export const SLOW_MS = { usage: 8_000, prs: 10_000, linear: 15_000 };

const USAGE_TIMEOUT_MS = 120_000;
const LINEAR_SLOW = "Linear is slow to answer; refresh in a moment";
const USAGE_SLOW = "usage still loading; refresh in a moment";
const PRS_SLOW = "Azure DevOps is slow to answer; refresh in a moment";

export interface DashboardDeps {
  root: string;
  codeRoot: string;
  projectsDir: string;
  reportsDir: string;
  logsDir: string;
  exampleDir: string;
  state: StatePaths;
  exec: Exec;
  fetch: typeof fetch;
  now: () => Date;
  cache: TtlCache;
  suffix: () => string;
}

export function defaultDeps(root: string): DashboardDeps {
  return {
    root,
    codeRoot: ROOT,
    projectsDir: path.join(root, "projects"),
    reportsDir: path.join(root, "reports"),
    logsDir: path.join(root, "logs"),
    exampleDir: path.join(root, "projects", "example"),
    state: statePaths(root),
    exec: execAsync,
    fetch: globalThis.fetch,
    now: () => new Date(),
    cache: createCache(),
    suffix: () => randomBytes(3).toString("hex"),
  };
}

export interface Sources {
  projects(): string[];
  defaultProject(): string | undefined;
  clockOff(project: string): Promise<Loaded<ClockOffView>>;
  morning(): Promise<{ items: InboxItem[]; rows: NightRow[] }>;
  runs(): ProjectRun[];
  projectSummaries(): { name: string; level: CheckLevel; reason: string }[];
  projectChecks(name: string): Promise<ConfigCheck[]>;
  linearTeams(name: string): Promise<Loaded<LinearTeam[]>>;
  launch(req: LaunchRequest): Promise<LaunchResult>;
  refresh(target: RefreshTarget): void;
}

type Lookup = (name: string) => string | undefined;

interface ProjectContext {
  project: Project;
  lookup: Lookup;
}

interface RepoPrLists {
  az: AzProject;
  byRepoPath: Record<string, Loaded<ActivePrList>>;
}

interface PrCandidate {
  id: string;
  title: string;
  repo?: string;
}

const ok = <T>(value: T): Loaded<T> => ({ ok: true, value });
const fail = (error: string): Loaded<never> => ({ ok: false, error });

function attempt<T>(load: () => T): Loaded<T> {
  try {
    return ok(load());
  } catch (error) {
    return fail(firstLine(error));
  }
}

function usageFailure(error: ExecError): Error {
  try {
    parseUsageSummary(error.stdout);
  } catch (printed) {
    if (!(printed instanceof SyntaxError) && printed instanceof Error) {
      if (printed.message !== "no usage output") return printed;
    }
  }
  return error;
}

export function createSources(deps: DashboardDeps): Sources {
  const { cache, exec } = deps;

  const rootEnvFile = () => path.join(deps.root, ".env");

  function openProject(name: string): ProjectContext {
    const project = loadProject(name, deps.projectsDir);
    return {
      project,
      lookup: envLookup([project.envFile, rootEnvFile()]),
    };
  }

  function linearClient(name: string, lookup: Lookup): Loaded<LinearClient> {
    const apiKey = lookup("LINEAR_API_KEY");
    if (!apiKey) {
      return fail(`LINEAR_API_KEY is not set (projects/${name}/.env or .env)`);
    }
    return ok({ apiKey, fetch: deps.fetch });
  }

  function loadTodo(
    { project }: ProjectContext,
    client: Loaded<LinearClient>,
  ): Promise<Loaded<TodoIssue[]>> {
    if (!client.ok) return Promise.resolve(client);
    return settle(
      cache.get(cacheKeys.todo(project.name), TTL_MS.todo, () =>
        fetchTodoIssues(client.value, project.linearTeams),
      ),
      SLOW_MS.linear,
      LINEAR_SLOW,
    );
  }

  function loadSnapshots(
    { project }: ProjectContext,
    client: Loaded<LinearClient>,
    todo: Loaded<TodoIssue[]>,
    tonight: Loaded<{ tickets: Ticket[] }>,
  ): Promise<Loaded<Record<string, IssueSnapshot | null>>> {
    if (!todo.ok) return Promise.resolve(fail(todo.error));
    if (!client.ok) return Promise.resolve(client);
    const inTodo = new Set(todo.value.map((issue) => issue.identifier));
    const ids = (tonight.ok ? tonight.value.tickets : [])
      .map((ticket) => ticket.id)
      .filter((id) => !inTodo.has(id));
    if (ids.length === 0) return Promise.resolve(ok({}));
    return settle(
      cache.get(cacheKeys.issues(project.name, ids), TTL_MS.todo, () =>
        fetchIssueSnapshots(client.value, ids),
      ),
      SLOW_MS.linear,
      LINEAR_SLOW,
    );
  }

  function loadTonight({
    project,
  }: ProjectContext): Loaded<{ tickets: Ticket[]; allowance?: number }> {
    return attempt(() => {
      const tickets = loadTickets(project.ticketsFile, {
        names: Object.keys(project.repos),
        defaultRepo: project.defaultRepo,
      });
      const allowance = loadAllowance(project.ticketsFile);
      return { tickets, ...(allowance !== undefined ? { allowance } : {}) };
    });
  }

  async function runUsage(name: string): Promise<UsageSummary> {
    try {
      const { stdout } = await exec(
        path.join(deps.codeRoot, "node_modules/.bin/tsx"),
        ["src/usage.ts", "--project", name],
        { cwd: deps.codeRoot, timeoutMs: USAGE_TIMEOUT_MS },
      );
      return parseUsageSummary(stdout);
    } catch (error) {
      throw error instanceof ExecError ? usageFailure(error) : error;
    }
  }

  function loadUsage(name: string): Promise<Loaded<UsageSummary>> {
    return settle(
      cache.get(cacheKeys.usage(name), TTL_MS.usage, () => runUsage(name)),
      SLOW_MS.usage,
      USAGE_SLOW,
    );
  }

  function loadPrList(
    az: AzProject,
    repoPath: string,
  ): Promise<Loaded<ActivePrList>> {
    return settle(
      cache.get(cacheKeys.prs(repoPath), TTL_MS.prs, () =>
        listActivePrs(exec, az, repoPath),
      ),
      SLOW_MS.prs,
      PRS_SLOW,
    );
  }

  async function loadRepoPrLists({
    project,
    lookup,
  }: ProjectContext): Promise<Loaded<RepoPrLists>> {
    const azLoaded = attempt(() => azProjectFrom(lookup));
    if (!azLoaded.ok) return azLoaded;
    const az = azLoaded.value;
    const paths = Object.values(project.repos).map((repo) => repo.path);
    const lists = await Promise.all(paths.map((p) => loadPrList(az, p)));
    const firstFailure = lists.find((list) => !list.ok);
    if (firstFailure && !firstFailure.ok && lists.every((list) => !list.ok)) {
      return fail(firstFailure.error);
    }
    return ok({
      az,
      byRepoPath: Object.fromEntries(paths.map((p, i) => [p, lists[i]])),
    });
  }

  function prCandidates(
    todo: Loaded<TodoIssue[]>,
    tonight: Loaded<{ tickets: Ticket[] }>,
    snapshots: Loaded<Record<string, IssueSnapshot | null>>,
  ): PrCandidate[] {
    const tonightTickets = tonight.ok ? tonight.value.tickets : [];
    const repoOf = new Map(tonightTickets.map((t) => [t.id, t.repo]));
    const todoIssues = todo.ok ? todo.value : [];
    const candidates: PrCandidate[] = todoIssues.map((issue) => ({
      id: issue.identifier,
      title: issue.title,
      repo: repoOf.get(issue.identifier),
    }));
    const inTodo = new Set(todoIssues.map((issue) => issue.identifier));
    for (const ticket of tonightTickets) {
      if (inTodo.has(ticket.id)) continue;
      const snapshot = snapshots.ok ? snapshots.value[ticket.id] : undefined;
      candidates.push({
        id: ticket.id,
        title: snapshot?.title ?? ticket.name,
        repo: ticket.repo,
      });
    }
    return candidates;
  }

  function lookupPrs(
    { project, lookup }: ProjectContext,
    lists: Loaded<RepoPrLists>,
    candidates: PrCandidate[],
  ): Loaded<Record<string, PrLookup>> {
    if (!lists.ok) return lists;
    const { az, byRepoPath } = lists.value;
    const prefix = lookup("BRANCH_PREFIX");
    const lookups: Record<string, PrLookup> = {};
    for (const { id, title, repo } of candidates) {
      const branch = ticketBranchName(prefix, id, title);
      const repoNames = repo ? [repo] : Object.keys(project.repos);
      let found: TicketPr | null = null;
      let listFailed = false;
      for (const repoName of repoNames) {
        const list = byRepoPath[project.repos[repoName]?.path ?? ""];
        if (!list?.ok) {
          listFailed = true;
          continue;
        }
        const match = pickTicketPr(list.value.prs, branch);
        if (match && !found) {
          found = {
            prId: match.prId,
            url: buildPrWebUrl(
              az.org,
              az.project,
              list.value.repoName,
              match.prId,
            ),
            autoComplete: match.autoComplete,
          };
        }
      }
      lookups[id] = found ?? (listFailed ? "unknown" : null);
    }
    return ok(lookups);
  }

  async function clockOff(name: string): Promise<Loaded<ClockOffView>> {
    let context: ProjectContext;
    let prep;
    try {
      context = openProject(name);
      prep = readPrepStore(deps.state.prep);
    } catch (error) {
      return fail(firstLine(error));
    }
    const { project, lookup } = context;
    const client = linearClient(project.name, lookup);
    const tonight = loadTonight(context);
    const [todo, usage, repoLists] = await Promise.all([
      loadTodo(context, client),
      loadUsage(project.name),
      loadRepoPrLists(context),
    ]);
    const snapshots = await loadSnapshots(context, client, todo, tonight);
    const prs = lookupPrs(
      context,
      repoLists,
      prCandidates(todo, tonight, snapshots),
    );
    return ok(
      buildClockOff({
        project,
        todo,
        tonight,
        snapshots,
        prep,
        prs,
        usage,
        now: deps.now(),
      }),
    );
  }

  function readNights(): NightData[] {
    return listNightFiles(deps.reportsDir).map((file) => {
      if (file.jsonFile === null) return { file, record: null };
      try {
        return { file, record: readNightRecord(file.jsonFile) };
      } catch (error) {
        return { file, record: null, error: firstLine(error) };
      }
    });
  }

  async function livePr(
    ref: PrRef,
    contexts: Map<string, Loaded<ProjectContext>>,
  ): Promise<PrLive> {
    const unknown = (reason: string): PrLive => ({ state: "unknown", reason });
    if (!contexts.has(ref.project)) {
      contexts.set(
        ref.project,
        attempt(() => openProject(ref.project)),
      );
    }
    const context = contexts.get(ref.project)!;
    if (!context.ok) return unknown(context.error);
    const repoPath = context.value.project.repos[ref.repo]?.path;
    if (!repoPath) return unknown(`repo ${ref.repo} is not configured`);
    const azLoaded = attempt(() => azProjectFrom(context.value.lookup));
    if (!azLoaded.ok) return unknown(azLoaded.error);
    const az = azLoaded.value;
    const list = await loadPrList(az, repoPath);
    if (!list.ok) return unknown(list.error);
    const found = list.value.prs.find((p) => p.pullRequestId === ref.prId);
    if (!found) return { state: "closed" };
    const ci = await settle(
      cache.get(cacheKeys.ci(az.org, ref.prId), TTL_MS.prs, () =>
        prCiVerdict(exec, az, ref.prId),
      ),
      SLOW_MS.prs,
      PRS_SLOW,
    );
    return {
      state: "active",
      autoComplete: Boolean(found.autoCompleteSetBy),
      isDraft: Boolean(found.isDraft),
      votes: voteSummary(found.reviewers),
      ci: ci.ok ? ci.value : "unknown",
      ...(found.title !== undefined ? { title: found.title } : {}),
    };
  }

  async function morning(): Promise<{ items: InboxItem[]; rows: NightRow[] }> {
    const nights = readNights();
    const actions = readActions(deps.state.actions);
    const contexts = new Map<string, Loaded<ProjectContext>>();
    const refs = prRefs(nights);
    const lives = await Promise.all(refs.map((ref) => livePr(ref, contexts)));
    const liveByUrl = new Map(refs.map((ref, i) => [ref.url, lives[i]]));
    const items = buildInbox(
      nights,
      actions,
      (url) =>
        liveByUrl.get(url) ?? { state: "unknown", reason: "PR not checked" },
    );
    return { items, rows: nightRows(nights, items) };
  }

  function summarise(name: string) {
    const checks = fileChecks(name, {
      projectsDir: deps.projectsDir,
      exampleDir: deps.exampleDir,
      rootDir: deps.root,
    });
    const level = overallLevel(checks);
    const worst = checks.find((check) => check.level === level) ?? checks[0];
    return { name, level, reason: worst.reason };
  }

  function linearTeams(name: string): Promise<Loaded<LinearTeam[]>> {
    if (!PROJECT_NAME.test(name)) {
      return Promise.resolve(fail(`invalid project name "${name}"`));
    }
    const lookup = envLookup([
      path.join(deps.projectsDir, name, ".env"),
      rootEnvFile(),
    ]);
    const client = linearClient(name, lookup);
    if (!client.ok) return Promise.resolve(client);
    return settle(
      cache.get(cacheKeys.teams(name), TTL_MS.teams, () =>
        fetchTeams(client.value),
      ),
      SLOW_MS.linear,
      LINEAR_SLOW,
    );
  }

  function configuredDefaultProject(): string | undefined {
    try {
      return parseEnv(readFileSync(rootEnvFile(), "utf-8")).NIGHTSHIFT_PROJECT;
    } catch {
      return undefined;
    }
  }

  const projects = () => listProjects(deps.projectsDir);

  return {
    projects,
    defaultProject() {
      const listed = projects();
      const configured = configuredDefaultProject();
      if (configured && listed.includes(configured)) return configured;
      return listed.find((name) => name !== "example");
    },
    clockOff,
    morning,
    runs: () => readProjectRuns(deps.logsDir, deps.now()),
    projectSummaries: () => projects().map(summarise),
    projectChecks: (name) =>
      projectChecks(name, {
        projectsDir: deps.projectsDir,
        exampleDir: deps.exampleDir,
        rootDir: deps.root,
        teams: () => linearTeams(name),
        azLogin: () =>
          cache.get(cacheKeys.azLogin(), TTL_MS.azLogin, () =>
            azLoginStatus(exec),
          ),
      }),
    linearTeams,
    launch: (req) =>
      launchInHerdr(req, {
        exec,
        root: deps.codeRoot,
        suffix: deps.suffix,
      }),
    refresh(target) {
      for (const prefix of REFRESH_PREFIXES[target]) cache.clear(prefix);
    },
  };
}
