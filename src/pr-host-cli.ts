import { pathToFileURL } from "node:url";
import { detectPrHost, PR_HOST_KINDS, PR_HOSTS, type PrHostKind } from "./pr-host.js";

export type RemoteDescription = { prHost: PrHostKind; env: Record<string, string> } | { error: string };

export function describeRemote(remoteUrl: string): RemoteDescription {
  const prHost = detectPrHost(remoteUrl);
  if (!prHost) return { error: `no supported PR host for ${remoteUrl} (supported: ${PR_HOST_KINDS.join(", ")})` };
  return { prHost, env: PR_HOSTS[prHost].envFromRemote(remoteUrl) };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("usage: npm run pr-host -- <origin-url>");
    process.exit(1);
  }
  const description = describeRemote(args[0]);
  if ("error" in description) {
    console.error(description.error);
    process.exit(1);
  }
  console.log(JSON.stringify(description));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
