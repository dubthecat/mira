// DOM-free integration test: NeuralStreamEngine (node's builtin WebSocket)
// against the fake serve_wm.py server. Run from anywhere:
//
//   node --test web/lib/engine/neuralStream.test.mjs
//
// Spawns `racer/pack/.venv/bin/python racer/serve/serve_wm.py --fake` on a
// random port (override the interpreter with SERVE_PY=...; the test is skipped
// if none is found). Asserts the handshake, that acts produce JPEG frames with
// contiguous indices, the reset flow, and a clean dispose.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { makeSpec } from '../../../racer/src/spec/schema.js';
import { NeuralStreamEngine } from './neuralStream.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const python = process.env.SERVE_PY || join(repoRoot, 'racer', 'pack', '.venv', 'bin', 'python');
const serveWm = join(repoRoot, 'racer', 'serve', 'serve_wm.py');
const port = 8600 + Math.floor(Math.random() * 1000);

function startServer(portN, extraArgs = []) {
  const proc = spawn(
    python,
    [serveWm, '--fake', '--host', '127.0.0.1', '--port', String(portN), ...extraArgs],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ready = new Promise((resolve, reject) => {
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (out.includes('listening ws://')) resolve();
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`server exited early (${code}): ${out}`)));
    setTimeout(() => reject(new Error(`server not ready in 15s: ${out}`)), 15000).unref();
  });
  return { proc, ready };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('NeuralStreamEngine streams frames from the fake server', { timeout: 60000 }, async (t) => {
  if (!existsSync(python)) {
    t.skip(`no python at ${python} (set SERVE_PY)`);
    return;
  }
  const { proc, ready } = startServer(port);
  try {
    await ready;

    const engine = new NeuralStreamEngine(`ws://127.0.0.1:${port}`);
    const spec = makeSpec({ weapon: { enabled: true } }); // 7-key vocab incl. F
    const readyMsg = await engine.init(spec, 7);

    assert.equal(engine.state, 'ready');
    assert.equal(readyMsg.fps, 20);
    assert.ok(Array.isArray(readyMsg.keyOrder) && readyMsg.keyOrder.length >= 6);
    assert.equal(readyMsg.width, 512);
    assert.equal(readyMsg.height, 288);
    assert.equal(engine.getWorld(), null);

    const frames = [];
    engine.onFrame((f) => frames.push(f));

    // drive 40 action frames at ~20 Hz, alternating keys
    const patterns = [{ W: true }, { W: true, A: true }, { W: true, D: true }, { Space: true }, null];
    for (let j = 0; j < 40; j++) {
      const st = engine.stepFrame(patterns[j % patterns.length]);
      assert.equal(st.state, 'ready');
      await sleep(50);
    }
    // allow stragglers to land
    for (let w = 0; w < 40 && frames.length < 40; w++) await sleep(50);

    assert.equal(frames.length, 40, `expected 40 frames, got ${frames.length}`);
    for (const f of frames) {
      assert.ok(f.bytes instanceof Uint8Array && f.bytes.length > 1000, `frame ${f.i}: too small`);
      assert.equal(f.bytes[0], 0xff);
      assert.equal(f.bytes[1], 0xd8); // JPEG SOI
      assert.equal(f.width, 512);
    }
    assert.deepEqual(
      frames.map((f) => f.i),
      Array.from({ length: 40 }, (_, i) => i),
      'server frame indices must be contiguous from 0',
    );
    assert.equal(engine.getFrameBlobUrl(), engine.lastFrame.blobUrl); // may be null under node

    // reset: fresh ready, server index restarts, engine count carries on
    await engine.reset();
    const before = engine.frameCount;
    engine.stepFrame({ W: true });
    for (let w = 0; w < 40 && engine.frameCount === before; w++) await sleep(50);
    assert.equal(engine.frameCount, before + 1);
    assert.equal(engine.lastFrame.i, 0, 'server index restarts after reset');
    assert.equal(engine.lastFrame.n, before + 1, 'engine count is monotonic across resets');

    engine.dispose();
    assert.equal(engine.state, 'disposed');
    await sleep(200); // server should log the close without erroring
  } finally {
    proc.kill('SIGTERM');
  }
});

test('NeuralStreamEngine reconnects once after a server-side close', { timeout: 60000 }, async (t) => {
  if (!existsSync(python)) {
    t.skip(`no python at ${python} (set SERVE_PY)`);
    return;
  }
  const port2 = port + 1;
  // idle-timeout 2s: the server closes idle sessions, forcing the reconnect path
  const { proc, ready } = startServer(port2, ['--idle-timeout', '2']);
  try {
    await ready;
    const engine = new NeuralStreamEngine(`ws://127.0.0.1:${port2}`);
    await engine.init(makeSpec(), 1);
    assert.equal(engine.state, 'ready');

    // go idle: the server closes us (code 4000) -> engine schedules ONE reconnect
    for (let w = 0; w < 100 && engine.state === 'ready'; w++) await sleep(100);
    assert.notEqual(engine.state, 'ready', 'server should have closed the idle session');
    for (let w = 0; w < 100 && engine.state === 'reconnecting'; w++) await sleep(100);
    assert.equal(engine.state, 'ready', 'engine should have reconnected once');

    // the reconnected session streams frames again
    const before = engine.frameCount;
    engine.stepFrame({ W: true });
    for (let w = 0; w < 40 && engine.frameCount === before; w++) await sleep(50);
    assert.equal(engine.frameCount, before + 1, 'frames flow after reconnect');

    engine.dispose();
  } finally {
    proc.kill('SIGTERM');
  }
});
