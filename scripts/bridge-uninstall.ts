// Reverses bridge:install:
//   npm run bridge:uninstall               Mac side, and each remote's bridge config and token
//   npm run bridge:uninstall -- --mac-only Mac side only
// Mac: stops and removes the launchd agents (and the forwards' Rex sessions), the tokens, key file and
// recorded Tailscale address (your hosts.json stays). Remote: removes
// ~/.pi/agent/pi-streaming-voice-bridge.{json,token}, so the extension there goes inert. The remote repo copy and
// its pi install stay (remove with `pi remove ~/Code/pi-streaming-voice` there if wanted).
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { userInfo } from "node:os";
import { DISCLAIM_BIN, HOSTS_FILE, KEY_FILE, loadHosts, TAILNET_FILE, TOKENS_FILE } from "../src/bridge-config.ts";
import { BRIDGE_LABEL, forwardLabel, launchctl, plistPath } from "./bridge-install.ts";

const hosts = loadHosts(HOSTS_FILE);
const domain = `gui/${userInfo().uid}`;
for (const label of [BRIDGE_LABEL, ...hosts.map(forwardLabel)]) {
  launchctl(["bootout", `${domain}/${label}`]);
  rmSync(plistPath(label), { force: true });
}
// The forwards' blocks are gone with them; their session on each host goes too.
for (const host of hosts) {
  if (host.via === "rex") spawnSync("rex", ["-S", host.rexHost, "session", "kill", "voice-bridge"], { stdio: "ignore" });
}
// hosts.json stays, for a later reinstall.
for (const file of [TOKENS_FILE, KEY_FILE, TAILNET_FILE, DISCLAIM_BIN]) rmSync(file, { force: true });
console.log("Mac: bridge and forwards stopped and removed, tokens and key file deleted");

if (!process.argv.includes("--mac-only")) {
  for (const host of hosts) {
    const r = spawnSync(
      "ssh",
      ["-o", "BatchMode=yes", host.ssh, "rm -f ~/.pi/agent/pi-streaming-voice-bridge.json ~/.pi/agent/pi-streaming-voice-bridge.token"],
      { encoding: "utf8" },
    );
    console.log(r.status === 0 ? `${host.name}: bridge config and token removed` : `${host.name}: could not reach ${host.ssh}: ${r.stderr.trim()}`);
  }
}
