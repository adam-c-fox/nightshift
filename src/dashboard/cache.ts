export type Loaded<T> = { ok: true; value: T } | { ok: false; error: string };

export const TTL_MS = {
  todo: 300_000,
  prs: 300_000,
  usage: 600_000,
  teams: 3_600_000,
  azLogin: 300_000,
} as const;

export interface TtlCache {
  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  clear(prefix?: string): void;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export function createCache(now: () => number = Date.now): TtlCache {
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<unknown>>();

  return {
    get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
      const entry = entries.get(key);
      if (entry && now() < entry.expiresAt) {
        return Promise.resolve(entry.value as T);
      }
      const pending = inFlight.get(key);
      if (pending) return pending as Promise<T>;

      const promise: Promise<T> = new Promise<T>((resolve) =>
        resolve(load()),
      ).then(
        (value) => {
          if (inFlight.get(key) === promise) {
            inFlight.delete(key);
            entries.set(key, { value, expiresAt: now() + ttlMs });
          }
          return value;
        },
        (error) => {
          if (inFlight.get(key) === promise) inFlight.delete(key);
          throw error;
        },
      );
      inFlight.set(key, promise);
      return promise;
    },

    clear(prefix = "") {
      for (const map of [entries, inFlight]) {
        for (const key of [...map.keys()]) {
          if (key.startsWith(prefix)) map.delete(key);
        }
      }
    },
  };
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

export async function settle<T>(
  p: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Loaded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Loaded<T>>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: timeoutMessage }),
      timeoutMs,
    );
  });
  const settled = p.then(
    (value): Loaded<T> => ({ ok: true, value }),
    (error): Loaded<T> => ({ ok: false, error: firstLine(error) }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const cacheKeys = {
  todo: (project: string) => `linear:todo:${project}`,
  issues: (project: string, ids: string[]) =>
    `linear:issues:${project}:${ids.join(",")}`,
  teams: (project: string) => `linear:teams:${project}`,
  prs: (repoPath: string) => `prs:${repoPath}`,
  ci: (org: string, prId: number) => `ci:${org}:${prId}`,
  usage: (project: string) => `usage:${project}`,
  azLogin: () => "az:login",
};

export type RefreshTarget = "linear" | "prs" | "usage" | "teams" | "all";

export const REFRESH_PREFIXES: Record<RefreshTarget, string[]> = {
  linear: ["linear:todo:", "linear:issues:"],
  prs: ["prs:", "ci:", "az:"],
  usage: ["usage:"],
  teams: ["linear:teams:"],
  all: [""],
};

export function parseRefreshTarget(body: unknown): RefreshTarget {
  const what =
    typeof body === "object" && body !== null
      ? (body as { what?: unknown }).what
      : undefined;
  if (typeof what === "string" && Object.hasOwn(REFRESH_PREFIXES, what)) {
    return what as RefreshTarget;
  }
  throw new Error("what must be one of linear, prs, usage, teams, all");
}
