import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../state.js";
import { DASHBOARD_ORIGIN } from "./address.js";

export const LAUNCH_AGENT_LABEL = "io.nightshift.dashboard";
export const TEMPLATE_FILE = join(ROOT, "ops", `${LAUNCH_AGENT_LABEL}.plist`);

const DEFAULT_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

export function launchPath(nodeDir: string): string {
  return [...new Set([nodeDir, ...DEFAULT_PATH_DIRS])].join(":");
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist(
  template: string,
  values: { repo: string; path: string },
): string {
  const unknown = template
    .replaceAll("__REPO__", "")
    .replaceAll("__PATH__", "");
  if (unknown.includes("__")) {
    throw new Error("Plist template has an unknown placeholder");
  }
  return template
    .replaceAll("__REPO__", () => xmlEscape(values.repo))
    .replaceAll("__PATH__", () => xmlEscape(values.path));
}

export function launchctlArgs(
  uid: number,
  plistFile: string,
): { bootout: string[]; bootstrap: string[]; kickstart: string[] } {
  const domain = `gui/${uid}`;
  const service = `${domain}/${LAUNCH_AGENT_LABEL}`;
  return {
    bootout: ["bootout", service],
    bootstrap: ["bootstrap", domain, plistFile],
    kickstart: ["kickstart", "-k", service],
  };
}

export interface InstallDeps {
  home: string;
  repo: string;
  nodeDir: string;
  uid: number;
  exec: (cmd: string, args: string[]) => void;
  log: (message: string) => void;
}

function bootoutIfLoaded(exec: InstallDeps["exec"], args: string[]): void {
  try {
    exec("launchctl", args);
  } catch {
    return;
  }
}

export function install(deps: InstallDeps): void {
  const { home, repo, nodeDir, uid, exec, log } = deps;
  const plist = renderPlist(readFileSync(TEMPLATE_FILE, "utf-8"), {
    repo,
    path: launchPath(nodeDir),
  });
  const plistFile = join(
    home,
    "Library",
    "LaunchAgents",
    `${LAUNCH_AGENT_LABEL}.plist`,
  );
  mkdirSync(join(repo, "logs"), { recursive: true });
  mkdirSync(dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, plist);
  exec("plutil", ["-lint", plistFile]);
  const args = launchctlArgs(uid, plistFile);
  bootoutIfLoaded(exec, args.bootout);
  exec("launchctl", args.bootstrap);
  exec("launchctl", args.kickstart);
  log(`Dashboard installed: ${DASHBOARD_ORIGIN} (logs: logs/dashboard.log)`);
}

function main(): void {
  install({
    home: homedir(),
    repo: ROOT,
    nodeDir: dirname(process.execPath),
    uid: process.getuid?.() ?? 0,
    exec: (cmd, args) => {
      execFileSync(cmd, args, { stdio: "pipe" });
    },
    log: (message) => console.log(message),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
