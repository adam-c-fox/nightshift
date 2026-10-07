import { extractFlag } from "./args.js";
import { snapshotUsage, usageSummary } from "./budget.js";
import { CLAUDE_TOKEN } from "./agent-env.js";
import { getEnv, useProjectEnv } from "./env.js";
import { loadProject } from "./project.js";

try {
  const { value: flagProject } = extractFlag(process.argv.slice(2), "--project");
  const name = flagProject ?? getEnv("NIGHTSHIFT_PROJECT");
  if (name) useProjectEnv(loadProject(name).envFile);
  const claudeToken = getEnv(CLAUDE_TOKEN);
  if (claudeToken) process.env[CLAUDE_TOKEN] = claudeToken;
  console.log(JSON.stringify(usageSummary(snapshotUsage())));
} catch (e) {
  console.log(JSON.stringify({ error: (e as Error).message.split("\n")[0] }));
  process.exit(1);
}
