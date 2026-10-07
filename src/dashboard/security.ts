export interface RequestInfo {
  method: string;
  pathname: string;
  headers: Record<string, string | string[] | undefined>;
}

export type Verdict =
  | { ok: true; nullOrigin: boolean }
  | { ok: false; status: number; reason: string };

export const NULL_ORIGIN_PATH = "/api/actions";

const ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "OPTIONS"];
const MUTATING_METHODS = ["POST", "PUT"];

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

function allowedOrigins(port: number): string[] {
  return allowedHosts(port).map((host) => `http://${host}`);
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function reject(status: number, reason: string): Verdict {
  return { ok: false, status, reason };
}

function allowsNullOrigin(req: RequestInfo): boolean {
  return (
    req.pathname === NULL_ORIGIN_PATH &&
    (req.method === "PUT" || req.method === "OPTIONS")
  );
}

export function checkRequest(req: RequestInfo, port: number): Verdict {
  const host = single(req.headers.host);
  if (host === undefined || !allowedHosts(port).includes(host)) {
    return reject(403, "Host not allowed");
  }
  if (!ALLOWED_METHODS.includes(req.method)) {
    return reject(405, "Method not allowed");
  }
  if (
    MUTATING_METHODS.includes(req.method) &&
    single(req.headers["x-nightshift"]) !== "1"
  ) {
    return reject(403, "Missing X-Nightshift header");
  }

  const rawOrigin = req.headers.origin;
  if (rawOrigin === undefined) return { ok: true, nullOrigin: false };

  const origin = single(rawOrigin);
  if (origin === "null" && allowsNullOrigin(req)) {
    return { ok: true, nullOrigin: true };
  }
  if (origin === undefined || !allowedOrigins(port).includes(origin)) {
    return reject(403, "Origin not allowed");
  }
  return { ok: true, nullOrigin: false };
}

export function preflightHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "null",
    "Access-Control-Allow-Methods": "PUT",
    "Access-Control-Allow-Headers": "Content-Type, X-Nightshift",
    "Access-Control-Allow-Private-Network": "true",
  };
}
