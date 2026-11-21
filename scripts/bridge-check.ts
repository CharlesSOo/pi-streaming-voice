// End-to-end check of the voice bridge from a remote account, without pi:
//   node scripts/bridge-check.ts [seconds=3] [--host IP] [--port N]
// Authenticates with this account's token, starts a take on the Mac's microphone, stops after `seconds`, and prints
// what came back (final transcripts included). --host/--port try another endpoint (e.g. the other account's, which
// must refuse this token).
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeConnector, BridgeTranscriber, loadBridgeConfig } from "../src/bridge-client.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : undefined;
};
const host = flag("--host");
const port = flag("--port");
const seconds = Number(args[0] ?? 3);
const config = loadBridgeConfig(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
if (host) config.host = host;
if (port) config.port = Number(port);

const counts: Record<string, number> = {};
const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
const connector = new BridgeConnector(() => config);
let t0 = 0;
let toListening: number | undefined;
try {
  // Warm up first, as the extension does at session start; then time the take itself.
  const h0 = performance.now();
  await connector.acquire().then((link) => {
    connector.dispose();
    link.close();
  });
  console.log(`handshake (new connection) ${Math.round(performance.now() - h0)} ms`);
  const warm = new BridgeConnector(() => config);
  warm.warm();
  while (!warm.isWarm) await new Promise((r) => setTimeout(r, 20));
  const t = new BridgeTranscriber(warm);
  t0 = performance.now();
  await t.start({
    onListening: () => {
      toListening ??= Math.round(performance.now() - t0);
      bump("listening");
    },
    onLevel: () => bump("level"),
    onInterim: () => bump("interim"),
    onFinal: (text) => {
      bump("final");
      console.log(`final: ${text}`);
    },
    onError: (message) => {
      console.log(`error: ${message}`);
      process.exitCode = 1;
    },
  });
  console.log(`warm link on ${config.host ?? "127.0.0.1"}:${config.port}, take started for ${seconds}s`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const finalized = await t.finish();
  console.log(`start -> listening ${toListening ?? "never"} ms; done finalized=${finalized} events=${JSON.stringify(counts)}`);
  warm.dispose();
} catch (error) {
  console.log(`refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
