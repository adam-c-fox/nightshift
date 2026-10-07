import { describe, expect, it } from "vitest";
import { ExecError, type Exec } from "../src/dashboard/exec.js";
import {
  AGENT_NAME,
  agentName,
  agentStartArgs,
  fallbackCommand,
  herdrRunning,
  launch,
  parseLaunchRequest,
  parseWorkspaceCreate,
  shellQuote,
  skillPrompt,
  workspaceCreateArgs,
  workspaceLabel,
  type LaunchRequest,
} from "../src/dashboard/launch.js";

const prep: LaunchRequest = { kind: "prep", id: "ENG-142", project: "acme" };
const tonight: LaunchRequest = { kind: "tonight", project: "acme" };

describe("parseLaunchRequest", () => {
  it("returns a valid prep request", () => {
    expect(
      parseLaunchRequest({ kind: "prep", id: "ENG-142", project: "acme" }, [
        "acme",
      ]),
    ).toEqual(prep);
  });

  it("returns a valid tonight request", () => {
    expect(
      parseLaunchRequest({ kind: "tonight", project: "acme" }, ["acme"]),
    ).toEqual(tonight);
  });

  it("drops fields that are not part of the request", () => {
    const parsed = parseLaunchRequest(
      { kind: "tonight", project: "acme", id: "ENG-1", extra: "x" },
      ["acme"],
    );
    expect(parsed).toEqual(tonight);
  });

  it.each([
    [{ kind: "prep", id: "eng-1", project: "acme" }, /ticket ID/],
    [{ kind: "prep", id: "ENG-1; rm -rf ~", project: "acme" }, /ticket ID/],
    [{ kind: "prep", project: "acme" }, /ticket ID/],
    [{ kind: "prep", id: 142, project: "acme" }, /ticket ID/],
    [{ kind: "tonight", project: "nope" }, /unknown project/],
    [{ kind: "tonight" }, /unknown project/],
    [{ kind: "tonight", project: ["acme"] }, /unknown project/],
    [{ kind: "shell" }, /kind/],
    [{ kind: "prep ", id: "ENG-1", project: "acme" }, /kind/],
    [null, /kind/],
    ["prep", /kind/],
    [[], /kind/],
  ])("rejects %j", (body, reason) => {
    expect(() => parseLaunchRequest(body, ["acme"])).toThrow(reason);
  });
});

describe("skillPrompt", () => {
  it("names the skill and its arguments", () => {
    expect(skillPrompt(prep)).toBe("/prep ENG-142 acme");
    expect(skillPrompt(tonight)).toBe("/tonight acme");
  });
});

describe("shellQuote and fallbackCommand", () => {
  it("single-quotes and escapes embedded quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("builds a cd and claude command", () => {
    expect(fallbackCommand(prep, "/Users/a/night shift")).toBe(
      "cd '/Users/a/night shift' && claude '/prep ENG-142 acme'",
    );
  });
});

describe("workspaceLabel", () => {
  it("labels both kinds", () => {
    expect(workspaceLabel(prep)).toBe("prep ENG-142");
    expect(workspaceLabel(tonight)).toBe("tonight acme");
  });
});

describe("agentName", () => {
  it("lowercases the ticket id and appends the suffix", () => {
    expect(agentName(prep, "k3x9a")).toBe("prep-eng-142-k3x9a");
  });

  it("stays a valid agent name for long and unusual project names", () => {
    const name = agentName(
      { kind: "tonight", project: "My.Proj_with-a-very-long-name-indeed" },
      "zz",
    );
    expect(name).toMatch(AGENT_NAME);
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name.endsWith("-zz")).toBe(true);
    expect(name).toBe(name.toLowerCase());
    expect(name).not.toContain(".");
  });

  it("replaces dots with hyphens", () => {
    expect(agentName({ kind: "tonight", project: "a.b" }, "zz")).toBe(
      "tonight-a-b-zz",
    );
  });
});

describe("herdr argv", () => {
  it("builds the workspace create args", () => {
    expect(workspaceCreateArgs(prep, "/repo")).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/repo",
      "--label",
      "prep ENG-142",
      "--focus",
    ]);
  });

  it("builds the agent start args", () => {
    expect(agentStartArgs("n", "w2:p1", "/prep ENG-142 acme")).toEqual([
      "agent",
      "start",
      "n",
      "--kind",
      "claude",
      "--pane",
      "w2:p1",
      "--timeout",
      "60000",
      "--",
      "/prep ENG-142 acme",
    ]);
  });
});

describe("herdrRunning", () => {
  it("reads server.running", () => {
    expect(herdrRunning('{"server":{"running":true}}')).toBe(true);
    expect(herdrRunning('{"server":{"running":false}}')).toBe(false);
    expect(herdrRunning("garbage")).toBe(false);
    expect(herdrRunning('{"server":{"running":"true"}}')).toBe(false);
    expect(herdrRunning("null")).toBe(false);
  });
});

describe("parseWorkspaceCreate", () => {
  it("reads the workspace and root pane ids", () => {
    const stdout =
      '{"result":{"workspace":{"workspace_id":"w3"},"tab":{},"root_pane":{"pane_id":"w3:p1"}}}';
    expect(parseWorkspaceCreate(stdout)).toEqual({
      workspaceId: "w3",
      paneId: "w3:p1",
    });
  });

  it("throws when the root pane is missing", () => {
    const stdout =
      '{"result":{"workspace":{"workspace_id":"w3"},"tab":{},"root_pane":{}}}';
    expect(() => parseWorkspaceCreate(stdout)).toThrow(/root pane/);
  });

  it("throws when the workspace is missing", () => {
    expect(() => parseWorkspaceCreate('{"result":{}}')).toThrow(/workspace/);
  });

  it("throws on output that is not JSON", () => {
    expect(() => parseWorkspaceCreate("nope")).toThrow(/workspace/);
  });
});

interface Call {
  cmd: string;
  args: string[];
  opts: Parameters<Exec>[2];
}

function fakeExec(responses: Array<string | Error>): {
  exec: Exec;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const next = responses[calls.length - 1];
    if (next === undefined) throw new Error("unexpected exec call");
    if (next instanceof Error) throw next;
    return { stdout: next, stderr: "" };
  };
  return { exec, calls };
}

const running = '{"server":{"running":true}}';
const created =
  '{"result":{"workspace":{"workspace_id":"w3"},"tab":{},"root_pane":{"pane_id":"w3:p1"}}}';

describe("launch", () => {
  const root = "/repo";
  const suffix = () => "k3x9a";

  it("creates a workspace and starts claude in it", async () => {
    const { exec, calls } = fakeExec([running, created, "{}"]);
    const result = await launch(prep, { exec, root, suffix });
    expect(result).toEqual({
      launched: true,
      workspaceId: "w3",
      paneId: "w3:p1",
      agent: "prep-eng-142-k3x9a",
      command: fallbackCommand(prep, root),
    });
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ["herdr", ["status", "--json"]],
      ["herdr", workspaceCreateArgs(prep, root)],
      [
        "herdr",
        agentStartArgs("prep-eng-142-k3x9a", "w3:p1", "/prep ENG-142 acme"),
      ],
    ]);
    expect(calls.map((c) => c.opts.timeoutMs)).toEqual([5000, 15000, 75000]);
    for (const call of calls) expect(call.opts).not.toHaveProperty("shell");
  });

  it("returns the command when herdr is not installed", async () => {
    const missing = new ExecError("spawn herdr ENOENT", "", "", "ENOENT");
    const { exec, calls } = fakeExec([missing]);
    expect(await launch(prep, { exec, root, suffix })).toEqual({
      launched: false,
      reason: "herdr not found",
      command: fallbackCommand(prep, root),
    });
    expect(calls).toHaveLength(1);
  });

  it("returns the command when the server is not running", async () => {
    const { exec, calls } = fakeExec(['{"server":{"running":false}}']);
    expect(await launch(tonight, { exec, root, suffix })).toEqual({
      launched: false,
      reason: "herdr server isn't running",
      command: fallbackCommand(tonight, root),
    });
    expect(calls).toHaveLength(1);
  });

  it("reports a status check that fails for another reason", async () => {
    const { exec } = fakeExec([new ExecError("boom", "", "boom", 1)]);
    const result = await launch(prep, { exec, root, suffix });
    expect(result).toMatchObject({
      launched: false,
      reason: expect.stringMatching(/herdr status failed: boom/),
      command: fallbackCommand(prep, root),
    });
  });

  it("returns the command when the workspace cannot be created", async () => {
    const { exec, calls } = fakeExec([
      running,
      new ExecError("no space", "", "no space", 1),
    ]);
    const result = await launch(prep, { exec, root, suffix });
    expect(result).toMatchObject({
      launched: false,
      reason: expect.stringMatching(/couldn't create a herdr workspace: /),
      command: fallbackCommand(prep, root),
    });
    expect(calls).toHaveLength(2);
  });

  it("returns the command when the create output has no root pane", async () => {
    const { exec } = fakeExec([running, '{"result":{"workspace":{}}}']);
    const result = await launch(prep, { exec, root, suffix });
    expect(result).toMatchObject({
      launched: false,
      reason: expect.stringMatching(/couldn't create a herdr workspace: /),
    });
  });

  it("names the workspace when claude fails to start", async () => {
    const { exec } = fakeExec([
      running,
      created,
      new ExecError("timed out", "", "timed out", 1),
    ]);
    const result = await launch(prep, { exec, root, suffix });
    expect(result).toMatchObject({
      launched: false,
      reason: expect.stringMatching(
        /claude didn't start in herdr workspace w3: timed out/,
      ),
      command: fallbackCommand(prep, root),
    });
  });

  it("refuses an invalid request before running anything", async () => {
    const { exec, calls } = fakeExec([]);
    const bad = { kind: "prep", id: "ENG-1; rm -rf ~", project: "acme" };
    await expect(
      launch(bad as LaunchRequest, { exec, root, suffix }),
    ).rejects.toThrow(/ticket ID/);
    await expect(
      launch({ kind: "tonight", project: "../x" }, { exec, root, suffix }),
    ).rejects.toThrow(/project/);
    await expect(
      launch({ kind: "shell" } as unknown as LaunchRequest, {
        exec,
        root,
        suffix,
      }),
    ).rejects.toThrow(/kind/);
    expect(calls).toHaveLength(0);
  });
});
