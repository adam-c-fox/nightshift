import { describe, expect, it, vi } from "vitest";
import {
  cacheKeys,
  createCache,
  parseRefreshTarget,
  REFRESH_PREFIXES,
  settle,
  TTL_MS,
} from "../src/dashboard/cache.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createCache", () => {
  it("serves a fresh value without loading again", async () => {
    let now = 0;
    const cache = createCache(() => now);
    const load = vi.fn(async () => ({ n: 1 }));
    const a = await cache.get("k", 1000, load);
    const b = await cache.get("k", 1000, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it("reloads once the ttl has passed", async () => {
    let now = 0;
    const cache = createCache(() => now);
    const load = vi.fn(async () => "v");
    await cache.get("k", 1000, load);
    now = 1001;
    await cache.get("k", 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    const cache = createCache(() => 0);
    const d = deferred<string>();
    const load = vi.fn(() => d.promise);
    const first = cache.get("k", 1000, load);
    const second = cache.get("k", 1000, load);
    d.resolve("value");
    expect(await first).toBe("value");
    expect(await second).toBe("value");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    const cache = createCache(() => 0);
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    await expect(cache.get("k", 1000, load)).rejects.toThrow("boom");
    expect(await cache.get("k", 1000, load)).toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("clears by prefix and clears everything without one", async () => {
    const cache = createCache(() => 0);
    const load = vi.fn(async () => "v");
    await cache.get("linear:todo:a", 1000, load);
    await cache.get("prs:/r", 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
    cache.clear("linear:");
    await cache.get("linear:todo:a", 1000, load);
    await cache.get("prs:/r", 1000, load);
    expect(load).toHaveBeenCalledTimes(3);
    cache.clear();
    await cache.get("linear:todo:a", 1000, load);
    await cache.get("prs:/r", 1000, load);
    expect(load).toHaveBeenCalledTimes(5);
  });

  it("does not store a load that was cleared while in flight", async () => {
    const cache = createCache(() => 0);
    const d = deferred<string>();
    const load = vi.fn<() => Promise<string>>().mockReturnValueOnce(d.promise);
    load.mockResolvedValue("fresh");
    const stale = cache.get("k", 1000, load);
    cache.clear();
    d.resolve("stale");
    expect(await stale).toBe("stale");
    expect(await cache.get("k", 1000, load)).toBe("fresh");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("starts a new load after a clear instead of joining the old flight", async () => {
    const cache = createCache(() => 0);
    const d = deferred<string>();
    const load = vi.fn<() => Promise<string>>().mockReturnValueOnce(d.promise);
    load.mockResolvedValue("fresh");
    const stale = cache.get("k", 1000, load);
    cache.clear();
    expect(await cache.get("k", 1000, load)).toBe("fresh");
    d.resolve("stale");
    await stale;
    expect(await cache.get("k", 1000, load)).toBe("fresh");
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("settle", () => {
  it("wraps a resolved value", async () => {
    expect(await settle(Promise.resolve(1), 50, "slow")).toEqual({
      ok: true,
      value: 1,
    });
  });

  it("keeps the first line of a rejection message", async () => {
    expect(await settle(Promise.reject(new Error("a\nb")), 50, "slow")).toEqual(
      { ok: false, error: "a" },
    );
  });

  it("reports the timeout message when the promise never settles", async () => {
    vi.useFakeTimers();
    try {
      const result = settle(new Promise<number>(() => {}), 50, "slow");
      await vi.advanceTimersByTimeAsync(51);
      expect(await result).toEqual({ ok: false, error: "slow" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseRefreshTarget", () => {
  it("accepts each known target", () => {
    for (const what of Object.keys(REFRESH_PREFIXES)) {
      expect(parseRefreshTarget({ what })).toBe(what);
    }
  });

  it("rejects unknown targets and non-objects", () => {
    const message = "what must be one of linear, prs, usage, teams, all";
    expect(() => parseRefreshTarget({ what: "x" })).toThrow(message);
    expect(() => parseRefreshTarget(null)).toThrow(message);
    expect(() => parseRefreshTarget({})).toThrow(message);
    expect(() => parseRefreshTarget("prs")).toThrow(message);
  });
});

describe("cacheKeys and constants", () => {
  it("builds the documented keys", () => {
    expect(cacheKeys.todo("acme")).toBe("linear:todo:acme");
    expect(cacheKeys.issues("acme", ["ENG-1", "ENG-2"])).toBe(
      "linear:issues:acme:ENG-1,ENG-2",
    );
    expect(cacheKeys.teams("acme")).toBe("linear:teams:acme");
    expect(cacheKeys.prs("/r")).toBe("prs:/r");
    expect(cacheKeys.ci("org", 7)).toBe("ci:org:7");
    expect(cacheKeys.usage("acme")).toBe("usage:acme");
    expect(cacheKeys.azLogin()).toBe("az:login");
  });

  it("maps refresh targets to key prefixes", () => {
    expect(REFRESH_PREFIXES).toEqual({
      linear: ["linear:todo:", "linear:issues:"],
      prs: ["prs:", "ci:", "az:"],
      usage: ["usage:"],
      teams: ["linear:teams:"],
      all: [""],
    });
  });

  it("uses the documented ttls", () => {
    expect(TTL_MS).toEqual({
      todo: 300_000,
      prs: 300_000,
      usage: 600_000,
      teams: 3_600_000,
      azLogin: 300_000,
    });
  });
});
