// Sets up the voice bridge (idempotent):
//   npm run bridge:install               Mac side and every host in ~/Library/Application Support/pi-streaming-voice-bridge/hosts.json
//   npm run bridge:install -- --mac-only Mac side only
// Mac: tokens (0600), the Deepgram key copied from DEEPGRAM_API_KEY into a 0600 file, launchd agents for the bridge
// (run through the disclaim launcher, for microphone permission) and one forward per `rex` or `ssh` host, (re)started; for `tailnet` hosts, the Mac's Tailscale address. Remote: the repo rsynced to ~/Code/pi-streaming-voice, npm install,
// pi install, ~/.pi/agent/pi-streaming-voice-bridge.json and .token (0600).
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { HOSTS_FILE, KEY_FILE, loadHosts, LOG_FILE, PRIVATE_DIR, REPO_DIR, DISCLAIM_BIN, TAILNET_FILE, TOKENS_FILE, writePrivate, type BridgeHost } from "../src/bridge-config.ts";
import { isToken, newToken } from "../src/bridge-protocol.ts";

export const BRIDGE_LABEL = "dev.pi-streaming-voice.bridge";
export const forwardLabel = (host: BridgeHost) => `dev.pi-streaming-voice.forward.${host.name}`;
export const AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
export const plistPath = (label: string) => join(AGENTS_DIR, `${label}.plist`);
export const REMOTE_DIR = "~/Code/pi-streaming-voice";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function plist(label: string, args: string[], log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${esc(REPO_DIR)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`;
}

/** The Mac's Tailscale IPv4. */
function tailnetIp(): string {
  const ip = execFileSync("/bin/sh", ["-c", "tailscale ip -4 || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4"], { encoding: "utf8" })
    .trim()
    .split("\n")[0]!;
  if (!/^100\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`tailscale ip -4 gave ${JSON.stringify(ip)}; is Tailscale up?`);
  return ip;
}

export function launchctl(args: string[]): void {
  spawnSync("launchctl", args, { stdio: "ignore" });
}

function reload(label: string, content: string): void {
  const path = plistPath(label);
  mkdirSync(AGENTS_DIR, { recursive: true });
  const domain = `gui/${userInfo().uid}`;
  launchctl(["bootout", `${domain}/${label}`]);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  // bootout returns before the old job is gone; bootstrap fails until it is.
  for (let attempt = 0; ; attempt += 1) {
    const r = spawnSync("launchctl", ["bootstrap", domain, path], { encoding: "utf8" });
    if (r.status === 0) return;
    if (attempt >= 20) throw new Error(`launchctl bootstrap ${label} failed: ${r.stderr.trim()}`);
    spawnSync("sleep", ["0.5"]);
  }
}

function buildDisclaim(): void {
  if (spawnSync("/bin/sh", ["-c", "command -v cc"]).status !== 0) {
    throw new Error("No C compiler (cc). Install the Xcode Command Line Tools: xcode-select --install");
  }
  const r = spawnSync("cc", ["-O2", "-o", DISCLAIM_BIN, join(REPO_DIR, "native", "disclaim.c")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Compiling native/disclaim.c failed:\n${r.stderr}`);
}

function which(cmd: string): string {
  return execFileSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim();
}

function installMac(hosts: BridgeHost[]): { tokens: Record<string, string>; ip: string | undefined } {
  const rex = hosts.some((h) => h.via === "rex") ? which("rex") : "";
  mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(PRIVATE_DIR, 0o700);
  let tokens: Record<string, string> = {};
  if (existsSync(TOKENS_FILE)) tokens = JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as Record<string, string>;
  for (const host of hosts) if (typeof tokens[host.name] !== "string" || !isToken(tokens[host.name]!)) tokens[host.name] = newToken();
  writePrivate(TOKENS_FILE, `${JSON.stringify(tokens, null, 2)}\n`);

  const key = process.env.DEEPGRAM_API_KEY?.trim();
  if (key) writePrivate(KEY_FILE, `${key}\n`);
  else if (!existsSync(KEY_FILE)) throw new Error("DEEPGRAM_API_KEY is not set in this shell and no key file exists yet");
  else chmodSync(KEY_FILE, 0o600);

  const ip = hosts.some((h) => h.via === "tailnet") ? tailnetIp() : undefined;
  if (ip) writePrivate(TAILNET_FILE, `${ip}\n`);

  const logs = join(homedir(), "Library", "Logs");
  mkdirSync(logs, { recursive: true });
  // launchd runs the bridge through disclaim, so node is its own responsible process for the microphone
  // permission (macOS asks once for node) instead of launchd, which can never be granted it.
  buildDisclaim();
  // An earlier version ran the bridge inside a local Rex session; that one goes.
  if (spawnSync("/bin/sh", ["-c", "command -v rex"]).status === 0) spawnSync("rex", ["session", "kill", "voice-bridge"], { stdio: "ignore" });
  reload(BRIDGE_LABEL, plist(BRIDGE_LABEL, [DISCLAIM_BIN, process.execPath, join(REPO_DIR, "bridge.ts")], LOG_FILE));
  for (const host of hosts) {
    if (host.via === "ssh") {
      reload(
        forwardLabel(host),
        plist(
          forwardLabel(host),
          [
            "/usr/bin/ssh", "-N",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=3",
            "-o", "BatchMode=yes",
            "-R", `127.0.0.1:${host.serverPort}:127.0.0.1:${host.macPort}`,
            host.ssh,
          ],
          join(logs, `pi-streaming-voice-bridge-forward-${host.name}.log`),
        ),
      );
      continue;
    }
    if (host.via !== "rex") {
      // No forward for this one (any left from an earlier setup goes).
      launchctl(["bootout", `gui/${userInfo().uid}/${forwardLabel(host)}`]);
      rmSync(plistPath(forwardLabel(host)), { force: true });
      continue;
    }
    reload(
      forwardLabel(host),
      plist(
        forwardLabel(host),
        ["/bin/sh", join(REPO_DIR, "scripts", "bridge-forward.sh"), rex, host.rexHost, String(host.serverPort), String(host.macPort)],
        join(logs, `pi-streaming-voice-bridge-forward-${host.name}.log`),
      ),
    );
  }
  console.log(`Mac: bridge ${BRIDGE_LABEL} and ${hosts.filter((h) => h.via !== "tailnet").length} forward(s) loaded; tokens in ${TOKENS_FILE}`);
  return { tokens, ip };
}

function ssh(host: BridgeHost, script: string, input?: string): string {
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", host.ssh, "bash", "-lc", JSON.stringify(script)], {
    encoding: "utf8",
    input: input ?? "",
  });
  if (r.status !== 0) throw new Error(`${host.ssh}: ${script.split("\n")[0]} failed:\n${r.stderr}${r.stdout}`);
  return r.stdout;
}

function installRemote(host: BridgeHost, token: string, ip: string | undefined): void {
  const remote = host.via !== "tailnet" ? { port: host.serverPort } : { host: ip!, port: host.macPort };
  console.log(`${host.name} (${host.ssh}): syncing repo`);
  ssh(host, `mkdir -p ${REMOTE_DIR}`);
  const rsync = spawnSync(
    "rsync",
    ["-a", "--delete", "--exclude", "node_modules", "--exclude", ".git", "--exclude", "*.log", `${REPO_DIR}/`, `${host.ssh}:Code/pi-streaming-voice/`],
    { stdio: "inherit" },
  );
  if (rsync.status !== 0) throw new Error(`${host.ssh}: rsync failed`);
  console.log(`${host.name}: npm install`);
  ssh(host, `cd ${REMOTE_DIR} && npm install --no-audit --no-fund --omit=dev`);
  // pi install keeps one entry per source, so running it again is harmless.
  ssh(host, `pi install ${REMOTE_DIR}`);
  // The token goes over ssh's stdin, never on a command line.
  ssh(
    host,
    `umask 077 && mkdir -p ~/.pi/agent && cat > ~/.pi/agent/pi-streaming-voice-bridge.token && chmod 600 ~/.pi/agent/pi-streaming-voice-bridge.token`,
    `${token}\n`,
  );
  ssh(
    host,
    `umask 077 && cat > ~/.pi/agent/pi-streaming-voice-bridge.json`,
    `${JSON.stringify(remote)}\n`,
  );
  console.log(`${host.name}: installed, bridge at ${remote.host ?? "127.0.0.1"}:${remote.port}`);
}

function main(): void {
  if (process.platform !== "darwin") throw new Error("Run the bridge install on the Mac");
  const macOnly = process.argv.includes("--mac-only");
  const hosts = loadHosts(HOSTS_FILE);
  const { tokens, ip } = installMac(hosts);
  if (macOnly) return;
  for (const host of hosts) installRemote(host, tokens[host.name]!, ip);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
