import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityText, runStructuredStep } from "../src/claude.js";

vi.mock("../src/env.js", async importOriginal => ({ ...(await importOriginal<object>()), getEnv: (name: string) => process.env[name] }));

const init = { type: "system", subtype: "init", session_id: "sess-1", tools: ["Read", "Grep", "Glob"] };
const grep = { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "fooBar", path: "src" } }] } };
const read = (cwd: string) => ({ type: "assistant", message: { content: [{ type: "text", text: "hm" }, { type: "tool_use", name: "Read", input: { file_path: `${cwd}/src/foo.ts` } }] } });
const result = {
  type: "result", subtype: "success", session_id: "sess-1", structured_output: { n: 2 }, total_cost_usd: 0.41, num_turns: 9, duration_ms: 1234,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, modelUsage: { "claude-x": {} },
};

let dir: string;
let savedPath: string | undefined;
let savedToken: string | undefined;

function stub({ lines, status = 0, stderr = "" }: { lines: string[]; status?: number; stderr?: string }) {
  const out = path.join(dir, "out.txt");
  writeFileSync(out, lines.join("\n") + "\n");
  const bin = path.join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv.txt"\ncat >/dev/null\ncat "${out}"\nprintf '%s' ${JSON.stringify(stderr)} >&2\nexit ${status}\n`);
  chmodSync(bin, 0o755);
}

const argv = () => readFileSync(path.join(dir, "argv.txt"), "utf-8").split("\n");

const run = (extra: Partial<Parameters<typeof runStructuredStep>[0]> = {}) => {
  const activity: string[] = [];
  return runStructuredStep({
    root: "/nightshift", cwd: dir, addDirs: ["/other"], prompt: "go", systemPrompt: "sys", schema: { type: "object" },
    onActivity: t => activity.push(t), ...extra,
  }).then(r => ({ r, activity }));
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "step-"));
  savedPath = process.env.PATH;
  savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.PATH = `${dir}:${savedPath}`;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok";
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
});

describe("runStructuredStep", () => {
  it("returns the structured output, session id and usage, reporting activity as it streams", async () => {
    stub({ lines: [JSON.stringify(init), "not json", JSON.stringify(grep), JSON.stringify(read(dir)), JSON.stringify(result)] });
    const { r, activity } = await run();
    expect(r).toEqual({
      ok: true, output: { n: 2 }, sessionId: "sess-1",
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, costUsd: 0.41, turns: 9, durationMs: 1234, models: ["claude-x"] },
    });
    expect(activity).toEqual(['Grep "fooBar" in src', "Read src/foo.ts"]);
  });

  it("asks for streamed json with the schema, 40 turns and the prep tools", async () => {
    stub({ lines: [JSON.stringify(result)] });
    await run();
    const args = argv();
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(value("--json-schema")).toBe('{"type":"object"}');
    expect(value("--max-turns")).toBe("40");
    expect(value("--tools")).toBe("Read,Grep,Glob");
    expect(value("--add-dir")).toBe("/other");
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(value("--settings")).sandbox.network.allowedDomains).toEqual([]);
    expect(args).toContain("--session-id");
  });

  it("resumes the given session", async () => {
    stub({ lines: [JSON.stringify(result)] });
    await run({ resumeId: "sess-0" });
    const args = argv();
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-0");
    expect(args).not.toContain("--session-id");
  });

  it("fails on an error subtype", async () => {
    stub({ lines: [JSON.stringify({ ...result, subtype: "error_max_turns", structured_output: undefined })], stderr: "boom" });
    const { r } = await run();
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toMatch(/error_max_turns/);
  });

  it("fails when the result has no structured output", async () => {
    stub({ lines: [JSON.stringify({ ...result, structured_output: undefined })] });
    const { r } = await run();
    expect(r.ok === false && r.error).toMatch(/structured output/);
  });

  it("fails on a non-zero exit with the tail of stderr", async () => {
    stub({ lines: [], status: 3, stderr: "x".repeat(2500) + "END" });
    const { r } = await run();
    expect(r.ok).toBe(false);
    const error = r.ok === false ? r.error : "";
    expect(error).toMatch(/status 3/);
    expect(error.endsWith("END")).toBe(true);
    expect(error).not.toContain("x".repeat(2000) + "x");
  });

  it("fails without a token in the root .env", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const { r } = await run({});
    expect(r).toEqual({ ok: false, error: "CLAUDE_CODE_OAUTH_TOKEN isn't set in the root .env" });
  });

  it("denies reading project env files under the configured root", async () => {
    stub({ lines: [JSON.stringify(result)] });
    const root = mkdtempSync(path.join(tmpdir(), "root-"));
    mkdirSync(path.join(root, "projects", "acme"), { recursive: true });
    await run({ root });
    const args = argv();
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(settings.permissions.deny).toContain(`Read(/${root}/projects/acme/.env)`);
  });

  it("reads the token from the configured root's .env", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    stub({ lines: [JSON.stringify(result)] });
    const root = mkdtempSync(path.join(tmpdir(), "root-"));
    writeFileSync(path.join(root, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=from-root\n");
    const { r } = await run({ root });
    expect(r.ok).toBe(true);
  });

  it("reports the pid through onSpawn", async () => {
    stub({ lines: [JSON.stringify(result)] });
    let pid = 0;
    await run({ onSpawn: p => { pid = p; } });
    expect(pid).toBeGreaterThan(0);
  });
});

describe("activityText", () => {
  const cwd = "/repo";
  it("shows paths relative to cwd when under it", () => {
    expect(activityText({ name: "Read", input: { file_path: "/repo/src/foo.ts" } }, cwd)).toBe("Read src/foo.ts");
    expect(activityText({ name: "Read", input: { file_path: "/other/x.ts" } }, cwd)).toBe("Read /other/x.ts");
    expect(activityText({ name: "Grep", input: { pattern: "fooBar", path: "/repo/src" } }, cwd)).toBe('Grep "fooBar" in src');
    expect(activityText({ name: "Grep", input: { pattern: "fooBar" } }, cwd)).toBe('Grep "fooBar"');
    expect(activityText({ name: "Glob", input: { pattern: "**/*.test.ts" } }, cwd)).toBe("Glob **/*.test.ts");
  });
});
