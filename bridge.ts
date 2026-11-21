// The Mac voice bridge daemon (run by launchd, see scripts/bridge-install.ts):
//   node bridge.ts
// One port per remote host in the hosts file (~/Library/Application Support/pi-streaming-voice-bridge/hosts.json), each accepting only that host's token: on 127.0.0.1 behind a Rex
// forward, or for a `tailnet` host on the Mac's Tailscale address only.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { loadHosts, loadKey, loadTokens, logLine, TAILNET_FILE } from "./src/bridge-config.ts";
import { startBridge, type BridgeEndpoint } from "./src/bridge-server.ts";
import { loadSettings, settingsPath } from "./src/settings.ts";
import { LocalTranscriber } from "./src/transcriber.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

async function main(): Promise<void> {
  const tokens = loadTokens();
  const tailnetIp = existsSync(TAILNET_FILE) ? readFileSync(TAILNET_FILE, "utf8").trim() : "";
  const endpoints: BridgeEndpoint[] = [];
  for (const host of loadHosts()) {
    const token = tokens[host.name];
    if (!token) {
      logLine(`no token for ${host.name}: not listening for it`);
    } else if (host.via === "tailnet") {
      if (isIP(tailnetIp) === 4 && tailnetIp.startsWith("100.")) endpoints.push({ name: host.name, port: host.macPort, token, host: tailnetIp });
      else logLine(`no Tailscale address recorded for ${host.name}: not listening for it`);
    } else {
      endpoints.push({ name: host.name, port: host.macPort, token });
    }
  }
  if (endpoints.length === 0) throw new Error("no hosts with tokens; run npm run bridge:install");
  const bridge = await startBridge({
    endpoints,
    createTranscriber: () => {
      const key = loadKey();
      if (!key) throw new Error("The Mac voice bridge has no Deepgram key: run npm run bridge:install on the Mac again");
      // Region as the Mac's pi uses it (its Auto pick is measured from the Mac).
      const settings = loadSettings(settingsPath(agentDir));
      return new LocalTranscriber(key, settings.region === "auto" ? settings.autoPick?.region : settings.region);
    },
    log: logLine,
  });
  logLine(`started: ${endpoints.map((e) => `${e.name} on ${e.host ?? "127.0.0.1"}:${e.port}`).join(", ")}`);
  const stop = () => {
    logLine("stopping");
    void bridge.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((error: unknown) => {
  logLine(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
