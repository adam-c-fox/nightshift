import { execFileSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dirname, "..", "scripts", "test-db.sh");
const START_TIMEOUT_MS = 2 * 60 * 1000;
const STOP_TIMEOUT_MS = 30 * 1000;

export type ScriptExec = (command: string, args: string[], timeoutMs: number) => string;

export interface TestDb {
  url: string;
  stop(): void;
}

const execScript: ScriptExec = (command, args, timeout) =>
  execFileSync(command, args, { encoding: "utf-8", timeout, stdio: ["ignore", "pipe", "pipe"] });

export function startTestDb(log: (msg: string) => void, exec: ScriptExec = execScript, env: NodeJS.ProcessEnv = process.env, script = SCRIPT): TestDb | undefined {
  let url: string;
  try {
    url = exec(script, ["up"], START_TIMEOUT_MS).trim();
  } catch (e) {
    log(`Test database not started: ${(e as Error).message.split("\n")[0]}; continuing without TEST_DATABASE_URL`);
    return undefined;
  }
  if (!url) {
    log("Test database not started: script printed no URL; continuing without TEST_DATABASE_URL");
    return undefined;
  }
  env.TEST_DATABASE_URL = url;
  log(`Test database up: ${url}`);
  return {
    url,
    stop: () => {
      try {
        exec(script, ["down"], STOP_TIMEOUT_MS);
        log("Test database stopped");
      } catch (e) {
        log(`Could not stop test database: ${(e as Error).message.split("\n")[0]}`);
      }
    },
  };
}
