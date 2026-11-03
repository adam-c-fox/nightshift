import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { nightlyAllowancePercent, parseUsageSummary, type UsageSummary } from "../budget.js";
import { envLookup } from "../env.js";
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
  loadAllProjects,
  loadProject,
  NIGHT_DIR_NAME,
  PROJECT_NAME,
  projectForLinearProject,
  type Project,
} from "../project.js";
import {
  addToQueue,
  loadQueue,
  moveInQueue,
  removeFromQueue,
  setQueueRepo,
  type QueueRepos,
} from "../queue.js";
import { ROOT, statePaths, writeTextAtomic, type StatePaths } from "../state.js";
import { loadAllowance } from "../tickets.js";
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
  buildEvening,
  type EveningView,
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
import type { QueueOp } from "./queue-edit.js";
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
    exampleDir: path.join(ROOT, "templates", "project"),
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
  evening(): Promise<Loaded<EveningView>>;
  editQueue(op: QueueOp): Promise<void>;
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

  function linearClient(lookup: Lookup, where: string): Loaded<LinearClient> {
    const apiKey = lookup("LINEAR_API_KEY");
    if (!apiKey) return fail(`LINEAR_API_KEY is not set (${where})`);
    return ok({ apiKey, fetch: deps.fetch });
  }

  function loadTodo(client: Loaded<LinearClient>): Promise<Loaded<TodoIssue[]>> {
    if (!client.ok) return Promise.resolve(client);
    return settle(
      cache.get(cacheKeys.todo(NIGHT_DIR_NAME), TTL_MS.todo, () =>
        fetchTodoIssues(client.value),
      ),
      SLOW_MS.linear,
      LINEAR_SLOW,
    );
  }

  function loadSnapshots(
    client: Loaded<LinearClient>,
    todo: Loaded<TodoIssue[]>,
    queue: Loaded<{ tickets: Ticket[] }>,
  ): Promise<Loaded<Record<string, IssueSnapshot | null>>> {
    if (!todo.ok) return Promise.resolve(fail(todo.error));
    if (!client.ok) return Promise.resolve(client);
    const inTodo = new Set(todo.value.map((issue) => issue.identifier));
    const ids = (queue.ok ? queue.value.tickets : [])
      .map((ticket) => ticket.id)
      .filter((id) => !inTodo.has(id));
    if (ids.length === 0) return Promise.resolve(ok({}));
    return settle(
      cache.get(cacheKeys.issues(NIGHT_DIR_NAME, ids), TTL_MS.todo, () =>
        fetchIssueSnapshots(client.value, ids),
      ),
      SLOW_MS.linear,
      LINEAR_SLOW,
    );
  }

  const queueFile = () => path.join(deps.root, "tonight.md");

  const queueRepos = (projects: Project[]): QueueRepos =>
    Object.fromEntries(
      projects.map((p) => [
        p.name,
        { names: Object.keys(p.repos), defaultRepo: p.defaultRepo },
      ]),
    );

  function loadQueueState(
    projects: Project[],
  ): Loaded<{ tickets: Ticket[]; allowance?: number }> {
    return attempt(() => {
      const tickets = loadQueue(queueFile(), queueRepos(projects));
      const allowance = loadAllowance(queueFile());
      return { tickets, ...(allowance !== undefined ? { allowance } : {}) };
    });
  }

  async function runUsage(): Promise<UsageSummary> {
    try {
      const { stdout } = await exec(
        path.join(deps.codeRoot, "node_modules/.bin/tsx"),
        ["src/usage.ts"],
        { cwd: deps.codeRoot, timeoutMs: USAGE_TIMEOUT_MS },
      );
      return parseUsageSummary(stdout);
    } catch (error) {
      throw error instanceof ExecError ? usageFailure(error) : error;
    }
  }

  function loadUsage(): Promise<Loaded<UsageSummary>> {
    return settle(
      cache.get(cacheKeys.usage(NIGHT_DIR_NAME), TTL_MS.usage, runUsage),
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
    issues: TodoIssue[],
    tickets: Ticket[],
    snapshots: Loaded<Record<string, IssueSnapshot | null>>,
  ): PrCandidate[] {
    const repoOf = new Map(tickets.map((t) => [t.id, t.repo]));
    const candidates: PrCandidate[] = issues.map((issue) => ({
      id: issue.identifier,
      title: issue.title,
      repo: repoOf.get(issue.identifier),
    }));
    const inTodo = new Set(issues.map((issue) => issue.identifier));
    for (const ticket of tickets) {
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

  function countOpenPrs(lists: Loaded<RepoPrLists>): Loaded<number> {
    if (!lists.ok) return lists;
    const open = Object.values(lists.value.byRepoPath).reduce(
      (count, list) => (list.ok ? count + list.value.prs.length : count),
      0,
    );
    return ok(open);
  }

  async function evening(): Promise<Loaded<EveningView>> {
    const rootLookup = envLookup([rootEnvFile()]);
    let projects: Project[];
    let prep;
    let rootAllowance: number;
    try {
      projects = loadAllProjects(deps.projectsDir);
      prep = readPrepStore(deps.state.prep);
      rootAllowance = nightlyAllowancePercent(rootLookup);
    } catch (error) {
      return fail(firstLine(error));
    }
    const contexts: ProjectContext[] = projects.map((project) => ({
      project,
      lookup: envLookup([project.envFile, rootEnvFile()]),
    }));
    const client = linearClient(
      envLookup([rootEnvFile(), ...projects.map((p) => p.envFile)]),
      ".env",
    );
    const queue = loadQueueState(projects);
    const [todo, usage, repoLists] = await Promise.all([
      loadTodo(client),
      loadUsage(),
      Promise.all(contexts.map(loadRepoPrLists)),
    ]);
    const snapshots = await loadSnapshots(client, todo, queue);
    const issues = todo.ok ? todo.value : [];
    const tickets = queue.ok ? queue.value.tickets : [];
    const lookups = contexts.map((context, i) => {
      const { name } = context.project;
      const candidates = prCandidates(
        issues.filter(
          (issue) => projectForLinearProject(projects, issue.projectName) === name,
        ),
        tickets.filter((ticket) => ticket.project === name),
        snapshots,
      );
      return { candidates, loaded: lookupPrs(context, repoLists[i], candidates) };
    });
    const firstFailure = lookups.map((l) => l.loaded).find((l) => !l.ok);
    const prs: Loaded<Record<string, PrLookup>> =
      firstFailure && !firstFailure.ok && lookups.every((l) => !l.loaded.ok)
        ? firstFailure
        : ok(
            Object.fromEntries(
              lookups.flatMap(({ candidates, loaded }) =>
                candidates.map((c) => [
                  c.id,
                  loaded.ok ? loaded.value[c.id] : "unknown",
                ]),
              ),
            ),
          );
    return ok(
      buildEvening({
        projects,
        todo,
        queue,
        rootAllowance,
        snapshots,
        prep,
        prs,
        openPrs: Object.fromEntries(
          contexts.map((c, i) => [c.project.name, countOpenPrs(repoLists[i])]),
        ),
        usage,
        now: deps.now(),
      }),
    );
  }

  function readQueueText(): string {
    try {
      return readFileSync(queueFile(), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  async function resolveAdd(
    projects: Project[],
    op: Extract<QueueOp, { op: "add" }>,
  ) {
    const project = projects.find((p) => p.name === op.project);
    if (!project) throw new Error(`unknown project "${op.project}"`);
    const client = linearClient(
      envLookup([rootEnvFile(), ...projects.map((p) => p.envFile)]),
      ".env",
    );
    const todo = await loadTodo(client);
    if (!todo.ok) throw new Error(todo.error);
    const issue = todo.value.find((i) => i.identifier === op.id);
    if (!issue) throw new Error(`${op.id} isn't in your Linear Todo list`);
    if (projectForLinearProject(projects, issue.projectName) !== project.name) {
      throw new Error(`${op.id} doesn't belong to ${project.name}`);
    }
    const recorded = readPrepStore(deps.state.prep)[op.id]?.repo;
    const repo =
      op.repo ??
      (recorded && Object.hasOwn(project.repos, recorded)
        ? recorded
        : project.defaultRepo);
    return { id: op.id, name: issue.title, project: project.name, repo };
  }

  async function editQueue(op: QueueOp): Promise<void> {
    const projects = loadAllProjects(deps.projectsDir);
    const repos = queueRepos(projects);
    const added = op.op === "add" ? await resolveAdd(projects, op) : undefined;
    const raw = readQueueText();
    const next = (() => {
      switch (op.op) {
        case "add":
          return addToQueue(raw, repos, added!);
        case "remove":
          return removeFromQueue(raw, repos, op.id);
        case "move":
          return moveInQueue(raw, repos, op.order);
        case "repo":
          return setQueueRepo(raw, repos, op.id, op.repo);
      }
    })();
    writeTextAtomic(queueFile(), next);
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
    const client = linearClient(lookup, `projects/${name}/.env or .env`);
    if (!client.ok) return Promise.resolve(client);
    return settle(
      cache.get(cacheKeys.teams(name), TTL_MS.teams, () =>
        fetchTeams(client.value),
      ),
      SLOW_MS.linear,
      LINEAR_SLOW,
    );
  }

  const projects = () => listProjects(deps.projectsDir);

  return {
    projects,
    evening,
    editQueue,
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
