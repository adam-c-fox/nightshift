import { describe, expect, it } from "vitest";
import {
  allowedHosts,
  checkRequest,
  NULL_ORIGIN_PATH,
  preflightHeaders,
  type RequestInfo,
} from "../src/dashboard/security.js";

const PORT = 4100;

function req(
  method: string,
  pathname: string,
  headers: RequestInfo["headers"] = {},
): RequestInfo {
  return { method, pathname, headers: { host: "127.0.0.1:4100", ...headers } };
}

function rejection(
  method: string,
  pathname: string,
  headers: RequestInfo["headers"] = {},
) {
  return checkRequest(req(method, pathname, headers), PORT);
}

describe("allowedHosts", () => {
  it("lists loopback and localhost with the port", () => {
    expect(allowedHosts(4100)).toEqual(["127.0.0.1:4100", "localhost:4100"]);
  });
});

describe("checkRequest host", () => {
  it("accepts 127.0.0.1 and localhost", () => {
    expect(rejection("GET", "/")).toEqual({ ok: true, nullOrigin: false });
    expect(rejection("GET", "/", { host: "localhost:4100" })).toEqual({
      ok: true,
      nullOrigin: false,
    });
  });

  it("rejects other hosts", () => {
    expect(rejection("GET", "/", { host: "evil.com:4100" })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("rejects a missing host", () => {
    expect(
      checkRequest({ method: "GET", pathname: "/", headers: {} }, PORT),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects a host that only starts with an allowed one", () => {
    expect(
      rejection("GET", "/", { host: "127.0.0.1:4100.evil.com" }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      rejection("GET", "/", { host: "localhost:4100.evil.com" }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects the wrong port, a missing port and repeated host headers", () => {
    expect(rejection("GET", "/", { host: "127.0.0.1:4101" })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(rejection("GET", "/", { host: "127.0.0.1" })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      rejection("GET", "/", { host: ["127.0.0.1:4100", "evil.com"] }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("checks the host on POST and OPTIONS to the null-origin route too", () => {
    expect(
      rejection("PUT", NULL_ORIGIN_PATH, {
        host: "evil.com:4100",
        origin: "null",
        "x-nightshift": "1",
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      rejection("OPTIONS", NULL_ORIGIN_PATH, {
        host: "evil.com:4100",
        origin: "null",
      }),
    ).toMatchObject({ ok: false, status: 403 });
  });
});

describe("checkRequest X-Nightshift", () => {
  it("requires the header on POST", () => {
    const verdict = rejection("POST", "/api/refresh");
    expect(verdict).toMatchObject({ ok: false, status: 403 });
    expect(verdict.ok === false && verdict.reason).toMatch(/X-Nightshift/);
  });

  it("accepts POST with the header and no origin", () => {
    expect(rejection("POST", "/api/refresh", { "x-nightshift": "1" })).toEqual({
      ok: true,
      nullOrigin: false,
    });
  });

  it("requires the value to be exactly 1", () => {
    expect(
      rejection("POST", "/api/refresh", { "x-nightshift": "0" }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      rejection("POST", "/api/refresh", { "x-nightshift": ["1", "1"] }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("requires the header on PUT", () => {
    expect(rejection("PUT", "/api/actions")).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("does not require the header on GET, HEAD or OPTIONS", () => {
    expect(rejection("GET", "/")).toMatchObject({ ok: true });
    expect(rejection("HEAD", "/")).toMatchObject({ ok: true });
    expect(rejection("OPTIONS", "/api/launch")).toMatchObject({ ok: true });
  });
});

describe("checkRequest origin", () => {
  it("accepts the same origin on both hostnames", () => {
    expect(
      rejection("POST", "/api/refresh", {
        "x-nightshift": "1",
        origin: "http://localhost:4100",
      }),
    ).toEqual({ ok: true, nullOrigin: false });
    expect(
      rejection("POST", "/api/refresh", {
        "x-nightshift": "1",
        origin: "http://127.0.0.1:4100",
      }),
    ).toEqual({ ok: true, nullOrigin: false });
  });

  it("rejects a foreign origin", () => {
    const verdict = rejection("POST", "/api/refresh", {
      "x-nightshift": "1",
      origin: "https://evil.com",
    });
    expect(verdict).toMatchObject({ ok: false, status: 403 });
    expect(verdict.ok === false && verdict.reason).toMatch(/origin/i);
  });

  it("rejects origins that only start with an allowed one", () => {
    for (const origin of [
      "http://localhost:4100.evil.com",
      "http://127.0.0.1:4100.evil.com",
      "http://localhost:4100/",
      "https://localhost:4100",
      "http://localhost:4101",
      "http://localhost",
    ]) {
      expect(
        rejection("POST", "/api/refresh", { "x-nightshift": "1", origin }),
      ).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("checks the origin on GET as well", () => {
    expect(rejection("GET", "/", { origin: "https://evil.com" })).toMatchObject(
      { ok: false, status: 403 },
    );
    expect(rejection("GET", "/", { origin: "null" })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("rejects repeated origin headers", () => {
    expect(
      rejection("GET", "/", {
        origin: ["http://localhost:4100", "http://localhost:4100"],
      }),
    ).toMatchObject({ ok: false, status: 403 });
  });
});

describe("checkRequest null origin", () => {
  it("allows PUT /api/actions with the header", () => {
    expect(
      rejection("PUT", "/api/actions", {
        origin: "null",
        "x-nightshift": "1",
      }),
    ).toEqual({ ok: true, nullOrigin: true });
  });

  it("rejects PUT /api/actions without the header", () => {
    expect(rejection("PUT", "/api/actions", { origin: "null" })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("allows the OPTIONS preflight for /api/actions", () => {
    expect(rejection("OPTIONS", "/api/actions", { origin: "null" })).toEqual({
      ok: true,
      nullOrigin: true,
    });
  });

  it("rejects a null origin on every other route and method", () => {
    const headers = { origin: "null", "x-nightshift": "1" };
    expect(rejection("POST", "/api/launch", headers)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(rejection("OPTIONS", "/api/launch", headers)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(rejection("POST", "/api/actions", headers)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(rejection("GET", "/api/actions", headers)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(rejection("PUT", "/api/actions/extra", headers)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(rejection("PUT", "/api/actions/", headers)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(rejection("PUT", "/", headers)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("reports a same-origin PUT /api/actions as not null", () => {
    expect(
      rejection("PUT", "/api/actions", {
        origin: "http://127.0.0.1:4100",
        "x-nightshift": "1",
      }),
    ).toEqual({ ok: true, nullOrigin: false });
  });
});

describe("checkRequest method", () => {
  it("rejects methods outside GET, HEAD, POST, PUT and OPTIONS", () => {
    expect(rejection("DELETE", "/")).toMatchObject({ ok: false, status: 405 });
    expect(rejection("PATCH", "/")).toMatchObject({ ok: false, status: 405 });
  });
});

describe("preflightHeaders", () => {
  it("allows the null origin to PUT with the custom header", () => {
    expect(preflightHeaders()).toMatchObject({
      "Access-Control-Allow-Origin": "null",
      "Access-Control-Allow-Methods": "PUT",
      "Access-Control-Allow-Headers": "Content-Type, X-Nightshift",
      "Access-Control-Allow-Private-Network": "true",
    });
  });
});
