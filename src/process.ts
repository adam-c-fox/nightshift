import { spawn } from "node:child_process";

export interface WatchdogResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  abortReason?: string;
}

export function runWithWatchdog(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    input: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    checkIntervalMs: number;
    shouldAbort?: () => string | undefined;
    killGraceMs?: number;
  },
): Promise<WatchdogResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let abortReason: string | undefined;
    let error: Error | undefined;
    child.stdout.setEncoding("utf-8").on("data", d => { stdout += d; });
    child.stderr.setEncoding("utf-8").on("data", d => { stderr += d; });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input);

    const kill = (reason: string) => {
      if (abortReason) return;
      abortReason = reason;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), opts.killGraceMs ?? 10_000).unref();
    };
    const timeout = setTimeout(() => kill(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`), opts.timeoutMs);
    const check = setInterval(() => {
      const reason = opts.shouldAbort?.();
      if (reason) kill(reason);
    }, opts.checkIntervalMs);

    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      clearInterval(check);
      resolve({ stdout, stderr, status, signal, error, abortReason });
    };
    child.on("error", e => { error = e; finish(null, null); });
    child.on("close", finish);
  });
}
