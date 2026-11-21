/** Mac-side voice bridge configuration: hosts and ports (in the repo), tokens and key (private, 0600). */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isToken } from "./bridge-protocol.ts";

/**
 * How a remote account reaches the bridge:
 * - `rex`: a Rex forward from `serverPort` on the server's loopback to `macPort` on the Mac's loopback.
 * - `ssh`: an `ssh -R` from the Mac, same ports as `rex`, kept up by launchd.
 * - `tailnet`: straight to `macPort` on the Mac's Tailscale address, for an account that may not use loopback TCP
 *   on its server. The bridge listens there for this host only, and accepts only its token.
 */
export type BridgeHost =
  | { name: string; ssh: string; macPort: number; via: "rex"; rexHost: string; serverPort: number }
  | { name: string; ssh: string; macPort: number; via: "ssh"; serverPort: number }
  | { name: string; ssh: string; macPort: number; via: "tailnet" };

export const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PRIVATE_DIR = join(homedir(), "Library", "Application Support", "pi-streaming-voice-bridge");
/** Your hosts (copy bridge-hosts.example.json from the repo). Kept out of the repo: it names your machines. */
export const HOSTS_FILE = join(PRIVATE_DIR, "hosts.json");
export const HOSTS_EXAMPLE = join(REPO_DIR, "bridge-hosts.example.json");
export const TOKENS_FILE = join(PRIVATE_DIR, "tokens.json");
export const KEY_FILE = join(PRIVATE_DIR, "deepgram.key");
/** The Mac's Tailscale IPv4, recorded by the installer for `tailnet` hosts. */
export const TAILNET_FILE = join(PRIVATE_DIR, "tailnet-ip");
/** The disclaim launcher, compiled at install from native/disclaim.c. */
export const DISCLAIM_BIN = join(PRIVATE_DIR, "disclaim");
export const LOG_FILE = join(homedir(), "Library", "Logs", "pi-streaming-voice-bridge.log");

const isPort = (p: unknown): p is number => typeof p === "number" && Number.isInteger(p) && p > 1023 && p < 65536;

export function loadHosts(file = HOSTS_FILE): BridgeHost[] {
  if (!existsSync(file)) {
    throw new Error(`No hosts file at ${file}. Copy ${HOSTS_EXAMPLE} there and edit it (see "Remote hosts" in the README).`);
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as { hosts?: unknown };
  if (!Array.isArray(raw.hosts)) throw new Error(`${file}: no "hosts" list`);
  const hosts = raw.hosts.map((h: Record<string, unknown>) => {
    if (!h || typeof h.name !== "string" || !/^[a-z0-9-]+$/.test(h.name)) throw new Error(`${file}: bad host name`);
    if (typeof h.ssh !== "string" || !isPort(h.macPort)) throw new Error(`${file}: host ${h.name} needs ssh and macPort`);
    if (h.via === "rex") {
      if (typeof h.rexHost !== "string" || !isPort(h.serverPort)) throw new Error(`${file}: host ${h.name} needs rexHost and serverPort`);
    } else if (h.via === "ssh") {
      if (!isPort(h.serverPort)) throw new Error(`${file}: host ${h.name} needs serverPort`);
    } else if (h.via !== "tailnet") {
      throw new Error(`${file}: host ${h.name}: "via" must be "rex", "ssh" or "tailnet"`);
    }
    return h as unknown as BridgeHost;
  });
  const dup = (key: "name" | "macPort") => new Set(hosts.map((h) => h[key])).size !== hosts.length;
  if (dup("name") || dup("macPort")) throw new Error(`${file}: host names and Mac ports must be unique`);
  return hosts;
}

/** Refuse a private file that others could read. */
export function assertPrivate(file: string): void {
  if ((statSync(file).mode & 0o077) !== 0) throw new Error(`${file} is readable by other users; run chmod 600 on it`);
}

export function loadTokens(file = TOKENS_FILE): Record<string, string> {
  assertPrivate(file);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [name, token] of Object.entries(raw)) if (typeof token === "string" && isToken(token)) out[name] = token;
  return out;
}

export function writePrivate(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The Deepgram key: the daemon's environment, else the private key file. */
export function loadKey(): string | undefined {
  const env = process.env.DEEPGRAM_API_KEY?.trim();
  if (env) return env;
  if (!existsSync(KEY_FILE)) return undefined;
  assertPrivate(KEY_FILE);
  return readFileSync(KEY_FILE, "utf8").trim() || undefined;
}

/** One timestamped line in the bridge log. Callers never pass tokens or transcripts. */
export function logLine(line: string, file = LOG_FILE): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // logging must never take the bridge down
  }
}
