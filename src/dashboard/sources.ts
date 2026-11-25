import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { nightlyAllowancePercent, parseUsageSummary, type UsageSummary } from "../budget.js";
import { envLookup } from "../env.js";
import {
  createIssueTracker,
  ISSUE_TRACKER_KINDS,
  ISSUE_TRACKERS,
  type IssueSnapshot,
  type IssueTracker,
  type IssueTrackerKind,
  type TodoIssue,
  type TrackerTeam,
} from "../issue-tracker.js";
import { readProjectRuns, type ProjectRun } from "../heartbeat.js";
import { readNightRecord } from "../night-record.js";
import { pickTicketPr } from "../pr.js";
import { createPrHost, type OpenPrList, type PrHost } from "../pr-host.js";
import { readPrepStore } from "../prep.js";
import {
  listProjects,
  loadAllProjects,
  loadProject,
  NIGHT_DIR_NAME,
  PROJECT_NAME,
  projectForTrackerProject,
  readRawProjectConfig,
  sharedTrackerKind,
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
import { loadSettings } from "../settings.js";
import { ROOT, statePaths, writeTextAtomic, type StatePaths } from "../state.js";
import { loadAllowance } from "../tickets.js";
import type { Ticket } from "../types.js";
import { ticketBranchName } from "../worktree.js";
import { readActions } from "./actions.js";
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
import { ExecError, execAsync, type Exec } from "../exec.js";
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
const PRS_SLOW = "The PR host is slow to answer; refresh in a moment";

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
  trackerTeams(name: string): Promise<Loaded<TrackerTeam[]>>;
  launch(req: LaunchRequest): Promise<LaunchResult>;
  refresh(target: RefreshTarget): void;
}

type Lookup = (name: string) => string | undefined;

interface ProjectContext {
  project: Project;
  lookup: Lookup;
}

interface RepoPrLists {
  host: PrHost;
  byRepoPath: Record<string, Loaded<OpenPrList>>;
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

  const readOrEmpty = (file: string) => {
    try {
      return readFileSync(file, "utf-8");
    } catch {
      return "";
    }
  };

  const envFingerprint = (projectEnvFile: string) =>
    createHash("sha1")
      .update([projectEnvFile, rootEnvFile()].map(readOrEmpty).join("\n"))
      .digest("hex")
      .slice(0, 8);

  function openProject(name: string): ProjectContext {
    const project = loadProject(name, deps.projectsDir);
    return {
      project,
      lookup: envLookup([project.envFile, rootEnvFile()]),
    };
  }

  function trackerFor(
    kind: IssueTrackerKind,
    lookup: Lookup,
    where: string,
  ): Loaded<IssueTracker> {
    const missing = ISSUE_TRACKERS[kind].envKeys.find((key) => !lookup(key));
    if (missing) return fail(`${missing} is not set (${where})`);
    return ok(createIssueTracker(kind, lookup, deps.fetch));
  }

  function machineTracker(projects: Project[]): Loaded<IssueTracker | undefined> {
    try {
      const kind = sharedTrackerKind(projects);
      if (!kind) return ok(undefined);
      return trackerFor(
        kind,
        envLookup([rootEnvFile(), ...projects.map((p) => p.envFile)]),
        ".env",
      );
    } catch (error) {
      return fail(firstLine(error));
    }
  }

  function loadTodo(
    tracker: Loaded<IssueTracker | undefined>,
  ): Promise<Loaded<TodoIssue[]>> {
    if (!tracker.ok) return Promise.resolve(tracker);
    const { value } = tracker;
    if (!value) return Promise.resolve(ok([]));
    return settle(
      cache.get(cacheKeys.todo(NIGHT_DIR_NAME), TTL_MS.todo, () =>
        value.listTodo(),
      ),
      SLOW_MS.linear,
      LINEAR_SLOW,
    );
  }

  function loadSnapshots(
    tracker: Loaded<IssueTracker | undefined>,
    todo: Loaded<TodoIssue[]>,
    queue: Loaded<{ tickets: Ticket[] }>,
  ): Promise<Loaded<Record<string, IssueSnapshot | null>>> {
    if (!todo.ok) return Promise.resolve(fail(todo.error));
    if (!tracker.ok) return Promise.resolve(tracker);
    const { value: trackerValue } = tracker;
    if (!trackerValue) return Promise.resolve(ok({}));
    const inTodo = new Set(todo.value.map((issue) => issue.identifier));
    const ids = (queue.ok ? queue.value.tickets : [])
      .map((ticket) => ticket.id)
      .filter((id) => !inTodo.has(id));
    if (ids.length === 0) return Promise.resolve(ok({}));
    return settle(
      cache.get(cacheKeys.issues(NIGHT_DIR_NAME, ids), TTL_MS.todo, () =>
        trackerValue.getSnapshots(ids),
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
    host: PrHost,
    repoPath: string,
  ): Promise<Loaded<OpenPrList>> {
    return settle(
      cache.get(cacheKeys.prs(repoPath), TTL_MS.prs, () =>
        host.listOpenPrs(repoPath),
      ),
      SLOW_MS.prs,
      PRS_SLOW,
    );
  }

  async function loadRepoPrLists({
    project,
    lookup,
  }: ProjectContext): Promise<Loaded<RepoPrLists>> {
    const host = createPrHost(project.prHost, lookup, exec);
    const paths = Object.values(project.repos).map((repo) => repo.path);
    const lists = await Promise.all(paths.map((p) => loadPrList(host, p)));
    const firstFailure = lists.find((list) => !list.ok);
    if (firstFailure && !firstFailure.ok && lists.every((list) => !list.ok)) {
      return fail(firstFailure.error);
    }
    return ok({
      host,
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
    const { byRepoPath } = lists.value;
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
            url: match.url,
            autoComplete: match.autoComplete,
          };
        }
      }
      lookups[id] = found ?? (listFailed ? "unknown" : null);
    }
    return ok(lookups);
  }

  async function resolveMe(
    { project }: ProjectContext,
    host: PrHost,
  ): Promise<Loaded<string>> {
    return settle(
      cache.get(cacheKeys.hostUser(project.name, envFingerprint(project.envFile)), TTL_MS.hostUser, () =>
        host.currentUser(),
      ),
      SLOW_MS.prs,
      PRS_SLOW,
    ).then((me) =>
      me.ok ? me : fail(`couldn't identify the PR host user: ${me.error}`),
    );
  }

  async function countOpenPrs(
    context: ProjectContext,
    lists: Loaded<RepoPrLists>,
  ): Promise<Loaded<number>> {
    if (!lists.ok) return lists;
    const me = await resolveMe(context, lists.value.host);
    if (!me.ok) return me;
    const mine = Object.values(lists.value.byRepoPath).reduce(
      (count, list) =>
        list.ok
          ? count +
            list.value.prs.filter((p) => p.author === me.value).length
          : count,
      0,
    );
    return ok(mine);
  }

  async function evening(): Promise<Loaded<EveningView>> {
    const rootLookup = envLookup([rootEnvFile()]);
    let projects: Project[];
    let prep;
    let rootAllowance: number;
    let codexAllowancePercent: number;
    try {
      projects = loadAllProjects(deps.projectsDir);
      prep = readPrepStore(deps.state.prep);
      rootAllowance = nightlyAllowancePercent(rootLookup);
      ({ codexAllowancePercent } = loadSettings(rootLookup));
    } catch (error) {
      return fail(firstLine(error));
    }
    const contexts: ProjectContext[] = projects.map((project) => ({
      project,
      lookup: envLookup([project.envFile, rootEnvFile()]),
    }));
    const tracker = machineTracker(projects);
    const queue = loadQueueState(projects);
    const [todo, usage, repoLists] = await Promise.all([
      loadTodo(tracker),
      loadUsage(),
      Promise.all(contexts.map(loadRepoPrLists)),
    ]);
    const snapshots = await loadSnapshots(tracker, todo, queue);
    const issues = todo.ok ? todo.value : [];
    const tickets = queue.ok ? queue.value.tickets : [];
    const lookups = contexts.map((context, i) => {
      const { name } = context.project;
      const candidates = prCandidates(
        issues.filter(
          (issue) => projectForTrackerProject(projects, issue.projectName) === name,
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
    const openPrs = Object.fromEntries(
      await Promise.all(
        contexts.map(async (c, i) => [
          c.project.name,
          await countOpenPrs(c, repoLists[i]),
        ]),
      ),
    );
    return ok(
      buildEvening({
        projects,
        todo,
        queue,
        rootAllowance,
        codexAllowancePercent,
        snapshots,
        prep,
        prs,
        openPrs,
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
    const todo = await loadTodo(machineTracker(projects));
    if (!todo.ok) throw new Error(todo.error);
    const issue = todo.value.find((i) => i.identifier === op.id);
    if (!issue) throw new Error(`${op.id} isn't in your Linear Todo list`);
    if (projectForTrackerProject(projects, issue.projectName) !== project.name) {
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
    const host = createPrHost(
      context.value.project.prHost,
      context.value.lookup,
      exec,
    );
    const list = await loadPrList(host, repoPath);
    if (!list.ok) return unknown(list.error);
    const found = list.value.prs.find((p) => p.prId === ref.prId);
    if (!found) return { state: "closed" };
    const ci = await settle(
      cache.get(cacheKeys.ci(repoPath, ref.prId), TTL_MS.prs, () =>
        host.ciVerdict(repoPath, ref.prId),
      ),
      SLOW_MS.prs,
      PRS_SLOW,
    );
    return {
      state: "active",
      autoComplete: found.autoComplete,
      isDraft: found.isDraft,
      votes: found.votes,
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

  function trackerTeams(name: string): Promise<Loaded<TrackerTeam[]>> {
    if (!PROJECT_NAME.test(name)) {
      return Promise.resolve(fail(`invalid project name "${name}"`));
    }
    let kind: IssueTrackerKind;
    try {
      const { raw } = readRawProjectConfig(name, deps.projectsDir);
      const configured = (raw as { issueTracker?: unknown } | null)?.issueTracker;
      if (!ISSUE_TRACKER_KINDS.includes(configured as IssueTrackerKind)) {
        return Promise.resolve(
          fail(`issueTracker must be one of: ${ISSUE_TRACKER_KINDS.join(", ")}`),
        );
      }
      kind = configured as IssueTrackerKind;
    } catch (error) {
      return Promise.resolve(fail(firstLine(error)));
    }
    const lookup = envLookup([
      path.join(deps.projectsDir, name, ".env"),
      rootEnvFile(),
    ]);
    const tracker = trackerFor(kind, lookup, `projects/${name}/.env or .env`);
    if (!tracker.ok) return Promise.resolve(tracker);
    return settle(
      cache.get(cacheKeys.teams(name), TTL_MS.teams, () =>
        tracker.value.listTeams(),
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
        teams: () => trackerTeams(name),
        hostLogin: (kind, lookup, repoPath) =>
          cache.get(
            cacheKeys.hostLogin(name, envFingerprint(path.join(deps.projectsDir, name, ".env"))),
            TTL_MS.hostLogin,
            async () => {
              const host = createPrHost(kind, lookup, exec);
              await host.listOpenPrs(repoPath);
              return host.currentUser();
            },
          ),
      }),
    trackerTeams,
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
