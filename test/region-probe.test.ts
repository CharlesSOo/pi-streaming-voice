import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { pickRegion, timeConnect } from "../src/region-probe.ts";

test("the region with the lowest median connect time wins", () => {
  assert.deepEqual(pickRegion({ global: [300, 320, 310], eu: [200, 190, 210], au: [400, 400, 400], in: [140, 900, 130] }), { region: "in", ms: 140 });
  // One slow try (a cold DNS lookup) does not decide it; the median does.
  assert.deepEqual(pickRegion({ global: [900, 100, 110], in: [150, 150, 150] }), { region: "global", ms: 110 });
  assert.deepEqual(pickRegion({ eu: [100, 200] }), { region: "eu", ms: 150 });
});

test("a host that failed or timed out is skipped", () => {
  assert.deepEqual(pickRegion({ global: [300, 300, 300], eu: [200, 200, 200], au: [250, 250, 250], in: [undefined] }), { region: "eu", ms: 200 });
  assert.deepEqual(pickRegion({ global: [300, 300, 300], in: [10, 10, undefined] }), { region: "global", ms: 300 });
  assert.deepEqual(pickRegion({ global: [undefined], eu: [], au: [500, 500, 500] }), { region: "au", ms: 500 });
});

test("all hosts failed gives Global, with no time", () => {
  assert.deepEqual(pickRegion({ global: [undefined], eu: [undefined], au: [undefined], in: [undefined] }), { region: "global" });
  assert.deepEqual(pickRegion({}), { region: "global" });
});

test("aborting a probe that is still connecting leaves no socket or timer behind", async () => {
  // A local server that accepts the TCP connection and never answers the TLS handshake.
  const accepted: Socket[] = [];
  const server = createServer((socket) => accepted.push(socket));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const resources = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout" || r === "TCPSocketWrap").length;
  const before = resources();
  const abort = new AbortController();
  try {
    const started = performance.now();
    const probe = timeConnect("localhost", abort.signal, port);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(accepted.length, 1, "the probe is in flight");
    assert.ok(resources() > before);
    abort.abort();
    assert.equal(await probe, undefined);
    assert.ok(performance.now() - started < 1000, "ended by the abort, not by the 3 s timeout");
  } finally {
    abort.abort();
    for (const socket of accepted) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resources(), before);
  assert.equal(await timeConnect("localhost", abort.signal, port), undefined, "an aborted signal opens nothing");
});
