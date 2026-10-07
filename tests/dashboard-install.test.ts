import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LAUNCH_AGENT_LABEL,
  TEMPLATE_FILE,
  install,
  launchPath,
  launchctlArgs,
  renderPlist,
  xmlEscape,
  type InstallDeps,
} from "../src/dashboard/install.js";

const template = () => readFileSync(TEMPLATE_FILE, "utf-8");

describe("launchPath", () => {
  it("does not repeat a directory already in the defaults", () => {
    expect(launchPath("/opt/homebrew/bin")).toBe(
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });

  it("puts the node directory first", () => {
    const path = launchPath("/Users/a/.nvm/v22/bin");
    expect(path.startsWith("/Users/a/.nvm/v22/bin:")).toBe(true);
    expect(path.split(":").filter((d) => d === "/opt/homebrew/bin")).toEqual([
      "/opt/homebrew/bin",
    ]);
  });
});

describe("xmlEscape", () => {
  it("escapes ampersands and angle brackets", () => {
    expect(xmlEscape("a&b<c>")).toBe("a&amp;b&lt;c&gt;");
  });
});

describe("renderPlist", () => {
  const rendered = renderPlist(template(), {
    repo: "/Users/a/R&D/nightshift",
    path: "/opt/homebrew/bin",
  });

  it("fills the repo into the working directory and log paths", () => {
    expect(rendered).toContain("<string>/Users/a/R&amp;D/nightshift</string>");
    expect(rendered).toContain(
      "/Users/a/R&amp;D/nightshift/logs/dashboard.log",
    );
  });

  it("keeps the agent alive and sets PATH", () => {
    expect(rendered).toContain("<key>KeepAlive</key><true/>");
    expect(rendered).toContain("<string>/opt/homebrew/bin</string>");
  });

  it("leaves no placeholders", () => {
    expect(rendered).not.toContain("__");
  });

  it("escapes the PATH value", () => {
    const out = renderPlist(template(), { repo: "/r", path: "/a&b" });
    expect(out).toContain("<string>/a&amp;b</string>");
  });

  it("throws on an unknown placeholder", () => {
    expect(() => renderPlist("__NOPE__", { repo: "/r", path: "/p" })).toThrow(
      /placeholder/,
    );
  });
});

describe("launchctlArgs", () => {
  it("targets the gui domain of the user", () => {
    expect(launchctlArgs(501, "/p.plist")).toEqual({
      bootout: ["bootout", "gui/501/io.nightshift.dashboard"],
      bootstrap: ["bootstrap", "gui/501", "/p.plist"],
      kickstart: ["kickstart", "-k", "gui/501/io.nightshift.dashboard"],
    });
    expect(LAUNCH_AGENT_LABEL).toBe("io.nightshift.dashboard");
  });
});

describe("install", () => {
  function setup(failing: string[] = []) {
    const home = mkdtempSync(join(tmpdir(), "nightshift-"));
    const repo = mkdtempSync(join(tmpdir(), "nightshift-"));
    const calls: Array<[string, string[]]> = [];
    const messages: string[] = [];
    const deps: InstallDeps = {
      home,
      repo,
      nodeDir: "/opt/homebrew/bin",
      uid: 501,
      exec: (cmd, args) => {
        calls.push([cmd, args]);
        if (failing.includes(args[0])) throw new Error(`${args[0]} failed`);
      },
      log: (message) => messages.push(message),
    };
    const plistFile = join(
      home,
      "Library",
      "LaunchAgents",
      "io.nightshift.dashboard.plist",
    );
    return { deps, calls, messages, home, repo, plistFile };
  }

  it("writes the plist, lints it, then reloads the agent", () => {
    const { deps, calls, messages, repo, plistFile } = setup();
    install(deps);
    const written = readFileSync(plistFile, "utf-8");
    expect(written).toContain(`<string>${repo}/node_modules/.bin/tsx</string>`);
    expect(existsSync(join(repo, "logs"))).toBe(true);
    expect(calls).toEqual([
      ["plutil", ["-lint", plistFile]],
      ["launchctl", ["bootout", "gui/501/io.nightshift.dashboard"]],
      ["launchctl", ["bootstrap", "gui/501", plistFile]],
      ["launchctl", ["kickstart", "-k", "gui/501/io.nightshift.dashboard"]],
    ]);
    expect(messages).toEqual([
      "Dashboard installed: http://127.0.0.1:4100 (logs: logs/dashboard.log)",
    ]);
  });

  it("carries on when the agent was not loaded yet", () => {
    const { deps, calls } = setup(["bootout"]);
    install(deps);
    expect(calls.map(([, args]) => args[0])).toEqual([
      "-lint",
      "bootout",
      "bootstrap",
      "kickstart",
    ]);
  });

  it("stops before touching launchctl when the plist fails the lint", () => {
    const { deps, calls } = setup(["-lint"]);
    expect(() => install(deps)).toThrow(/-lint failed/);
    expect(calls.every(([cmd]) => cmd === "plutil")).toBe(true);
  });

  it("does not swallow a bootstrap failure", () => {
    const { deps, messages } = setup(["bootstrap"]);
    expect(() => install(deps)).toThrow(/bootstrap failed/);
    expect(messages).toEqual([]);
  });
});
