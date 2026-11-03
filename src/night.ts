import { CLAUDE_TOKEN } from "./agent-env.js";
import { composeInstructions } from "./instructions.js";
import type { PrCommentState } from "./pr-comment-state.js";
import type { Project } from "./project.js";
import type { TestDb } from "./test-db.js";
import type { Ticket } from "./types.js";

export interface PrWrites { state: PrCommentState; file: string; blocked: { reason?: string } }

export interface ProjectContext {
  project: Project;
  branchPrefix?: string;
  instructions: string;
  prWrites: PrWrites;
}

export function nightOrder(queue: Ticket[], sweeps: { project: string; items: Ticket[] }[]): Ticket[] {
  const absorbed = new Set<Ticket>();
  const merged = queue.map(t => {
    const item = sweeps.find(s => s.project === t.project)?.items.find(i => i.id === t.id && i.repo === t.repo);
    if (!item) return t;
    absorbed.add(item);
    return { ...t, context: [...t.context, ...item.context], prComments: item.prComments };
  });
  const unmatched = sweeps.flatMap(s => s.items.filter(i => !absorbed.has(i)).map(i => ({ ...i, project: s.project })));
  return [...unmatched, ...merged];
}

export interface ProjectSwitcherDeps {
  load: (name: string) => Project;
  useEnv: (file: string) => void;
  getEnv: (name: string) => string | undefined;
  startDb: (script: string) => TestDb | undefined;
  loadPrState: (name: string) => { state: PrCommentState; file: string };
  genericInstructions: string;
}

export function createProjectSwitcher(deps: ProjectSwitcherDeps): { enter(name: string, options?: { db?: boolean }): ProjectContext; stop(): void } {
  const contexts = new Map<string, ProjectContext>();
  let current: ProjectContext | undefined;
  let db: TestDb | undefined;
  let dbStarted = false;
  let tokenSet = false;

  const stopDb = () => {
    db?.stop();
    db = undefined;
    dbStarted = false;
  };

  const contextFor = (name: string): ProjectContext => {
    let ctx = contexts.get(name);
    if (!ctx) {
      const project = deps.load(name);
      const { state, file } = deps.loadPrState(name);
      ctx = {
        project,
        instructions: composeInstructions(deps.genericInstructions, project.name, project.instructions),
        prWrites: { state, file, blocked: {} },
      };
      contexts.set(name, ctx);
    }
    return ctx;
  };

  return {
    enter(name, { db: wantDb = true } = {}) {
      if (current?.project.name !== name) {
        stopDb();
        const ctx = contextFor(name);
        deps.useEnv(ctx.project.envFile);
        const token = deps.getEnv(CLAUDE_TOKEN);
        if (token) {
          process.env[CLAUDE_TOKEN] = token;
          tokenSet = true;
        } else if (tokenSet) {
          delete process.env[CLAUDE_TOKEN];
          tokenSet = false;
        }
        ctx.branchPrefix = deps.getEnv("BRANCH_PREFIX");
        current = ctx;
      }
      const script = current!.project.testDbScript;
      if (wantDb && script && !dbStarted) {
        db = deps.startDb(script);
        dbStarted = true;
      }
      return current!;
    },
    stop: stopDb,
  };
}
