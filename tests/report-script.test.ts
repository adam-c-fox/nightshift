import { describe, expect, it, vi } from "vitest";
import { ACTIONED_SCRIPT } from "../src/report.js";

const REPORT_QUERY = "report=acme%2Fnightshift-2026-10-01";
const HTTP_HREF =
  "http://127.0.0.1:4100/reports/acme/nightshift-2026-10-01.html";
const FILE_HREF =
  "file:///Users/a/nightshift/reports/acme/nightshift-2026-10-01.html";

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

function run(
  href: string,
  stored: Record<string, string>,
  serverMap: object = {},
  fetchImpl?: (url: string, init?: FetchInit) => Promise<unknown>,
) {
  const url = new URL(href);
  const boxes = ["ticket:ENG-1", "postmortem:P1"].map((key) => ({
    dataset: { key },
    checked: false,
    listeners: [] as (() => void)[],
    addEventListener(_: string, fn: () => void) {
      this.listeners.push(fn);
    },
    closest: () => ({ classList: { toggle() {} } }),
  }));
  const calls: { url: string; init?: FetchInit }[] = [];
  const fetch = vi.fn(async (u: string, init?: FetchInit) => {
    calls.push({ url: u, init });
    if (fetchImpl) return fetchImpl(u, init);
    return { json: async () => serverMap };
  });
  const store = new Map(
    Object.entries({
      [`nightshift:actioned:${url.pathname}`]: JSON.stringify(stored),
    }),
  );
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  };
  const document = {
    querySelectorAll: () => boxes,
    getElementById: () => null,
    addEventListener() {},
  };
  new Function(
    "document",
    "location",
    "localStorage",
    "fetch",
    "HTMLDetailsElement",
    ACTIONED_SCRIPT,
  )(
    document,
    { pathname: url.pathname, protocol: url.protocol, hash: "" },
    localStorage,
    fetch,
    class {},
  );
  return {
    boxes,
    calls,
    store,
    storeKey: `nightshift:actioned:${url.pathname}`,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("ACTIONED_SCRIPT", () => {
  it("over http reads the server map", async () => {
    const { boxes, calls } = run(
      HTTP_HREF,
      {},
      {
        "ticket:ENG-1": { at: "2026-10-02T00:00:00Z", updatedAt: "x" },
        "postmortem:P1": { at: null, updatedAt: "y" },
      },
    );
    await settle();
    expect(calls[0].url).toBe(`/api/actions?${REPORT_QUERY}`);
    expect(calls[0].init?.method).toBeUndefined();
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
  });

  it("over http a change PUTs one key", async () => {
    const { boxes, calls, store, storeKey } = run(HTTP_HREF, {});
    await settle();
    boxes[1].checked = true;
    boxes[1].listeners[0]();
    const last = calls[calls.length - 1];
    expect(last.url).toBe(`/api/actions?${REPORT_QUERY}`);
    expect(last.init?.method).toBe("PUT");
    expect(last.init?.headers?.["X-Nightshift"]).toBe("1");
    const body = JSON.parse(last.init?.body ?? "{}");
    expect(Object.keys(body)).toEqual(["postmortem:P1"]);
    expect(body["postmortem:P1"].at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(body["postmortem:P1"].updatedAt).toBe(body["postmortem:P1"].at);
    expect(store.get(storeKey)).toBe("{}");
  });

  it("over http unticking PUTs a null at", async () => {
    const { boxes, calls } = run(
      HTTP_HREF,
      {},
      { "ticket:ENG-1": { at: "2026-10-02T00:00:00Z", updatedAt: "x" } },
    );
    await settle();
    boxes[0].checked = false;
    boxes[0].listeners[0]();
    const body = JSON.parse(calls[calls.length - 1].init?.body ?? "{}");
    expect(body["ticket:ENG-1"].at).toBeNull();
    expect(body["ticket:ENG-1"].updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("over file:// uses localStorage and pushes ticks", async () => {
    const { boxes, calls } = run(FILE_HREF, {
      "ticket:ENG-1": "2026-10-02T00:00:00.000Z",
    });
    await settle();
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `http://127.0.0.1:4100/api/actions?${REPORT_QUERY}`,
    );
    expect(calls[0].init?.method).toBe("PUT");
    expect(calls[0].init?.headers?.["X-Nightshift"]).toBe("1");
    expect(JSON.parse(calls[0].init?.body ?? "{}")).toEqual({
      "ticket:ENG-1": {
        at: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
      },
    });
  });

  it("file:// with nothing ticked sends nothing", async () => {
    const { calls } = run(FILE_HREF, {});
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("file:// change writes localStorage", async () => {
    const { boxes, calls, store, storeKey } = run(FILE_HREF, {});
    await settle();
    boxes[1].checked = true;
    boxes[1].listeners[0]();
    expect(Object.keys(JSON.parse(store.get(storeKey) ?? "{}"))).toEqual([
      "postmortem:P1",
    ]);
    expect(calls).toHaveLength(0);
  });

  it("file:// untick removes the key from localStorage", async () => {
    const { boxes, store, storeKey } = run(FILE_HREF, {
      "ticket:ENG-1": "2026-10-02T00:00:00.000Z",
    });
    await settle();
    boxes[0].checked = false;
    boxes[0].listeners[0]();
    expect(JSON.parse(store.get(storeKey) ?? "{}")).toEqual({});
  });

  it("legacy report id", async () => {
    const { calls } = run("file:///x/reports/nightshift-2026-09-01.html", {
      "ticket:ENG-1": "2026-10-02T00:00:00.000Z",
    });
    await settle();
    expect(calls[0].url).toBe(
      "http://127.0.0.1:4100/api/actions?report=nightshift-2026-09-01",
    );
  });

  it("last /reports/ segment wins", async () => {
    const { calls } = run(
      "file:///home/reports/x/reports/acme/nightshift-2026-10-01.html",
      {
        "ticket:ENG-1": "2026-10-02T00:00:00.000Z",
      },
    );
    await settle();
    expect(calls[0].url).toBe(
      `http://127.0.0.1:4100/api/actions?${REPORT_QUERY}`,
    );
  });

  it("fetch rejection is swallowed", async () => {
    const rejecting = () => Promise.reject(new Error("offline"));
    const fileRun = run(
      FILE_HREF,
      { "ticket:ENG-1": "2026-10-02T00:00:00.000Z" },
      {},
      rejecting,
    );
    const httpRun = run(HTTP_HREF, {}, {}, rejecting);
    await settle();
    expect(fileRun.boxes[0].checked).toBe(true);
    expect(httpRun.boxes[0].checked).toBe(false);
    httpRun.boxes[0].checked = true;
    expect(() => httpRun.boxes[0].listeners[0]()).not.toThrow();
    await settle();
  });

  it("a synchronous fetch throw is swallowed", async () => {
    const throwing = () => {
      throw new Error("blocked");
    };
    expect(() =>
      run(
        FILE_HREF,
        { "ticket:ENG-1": "2026-10-02T00:00:00.000Z" },
        {},
        throwing,
      ),
    ).not.toThrow();
    await settle();
  });
});
