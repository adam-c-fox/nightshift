import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}
export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}
export type Exec = (
  cmd: string,
  args: string[],
  opts: ExecOptions,
) => Promise<ExecResult>;

export class ExecError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly code?: string | number,
  ) {
    super(message);
    this.name = "ExecError";
  }
}

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export const execAsync: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        encoding: "utf-8",
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr });
        const firstStderrLine = stderr.trim().split("\n")[0];
        const code = (error as NodeJS.ErrnoException).code;
        reject(
          new ExecError(firstStderrLine || error.message, stdout, stderr, code),
        );
      },
    );
  });
