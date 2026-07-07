// Headless dataset generator: drives the recorder page in headless Chrome
// (SwiftShader software WebGL — no GPU needed), pipes captured PNG frames
// through ffmpeg into 80-frame H.264 chunks, and writes the raw episode
// layout that racer/pack/pack_dataset.py converts into MIRA shards.
//
//   node src/record/headless.js --episodes 8 --frames 2400 --out ./episodes
//
// Output per episode (= one MIRA "match"):
//   <out>/<matchId>/chunk_00000.mp4 ...   80-frame yuv420p H.264 @ 20 fps
//   <out>/<matchId>/actions.jsonl        one {"keys":[...]} line per frame
//   <out>/<matchId>/physics.jsonl        one state object per frame
//   <out>/<matchId>/meta.json            seed, chunkFrames, events, track info

import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from './serve.js';

const FPS = 20;

function parseArgs(argv) {
  const a = {
    episodes: 4,
    frames: 2400,
    chunk: 80,
    seed0: 1,
    out: 'episodes',
    width: 512,
    height: 288,
    concurrency: Math.max(1, Math.min(4, os.cpus().length - 2)),
    batch: 20,
    chrome: '',
    spec: '', // path to a GameSpec json (from forge/compile); empty = classic racing
    antialias: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'no-antialias') {
      a.antialias = false;
      continue;
    }
    const v = argv[++i];
    if (!(k in a)) throw new Error(`unknown arg --${k}`);
    a[k] = typeof a[k] === 'number' ? parseInt(v, 10) : v;
  }
  if (a.frames % a.chunk !== 0) {
    a.frames = Math.max(a.chunk, Math.floor(a.frames / a.chunk) * a.chunk);
    console.warn(`frames rounded down to ${a.frames} (multiple of chunk=${a.chunk})`);
  }
  return a;
}

function findChrome(explicit) {
  const candidates = explicit
    ? [explicit]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/snap/bin/chromium'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'pipe' });
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error('no Chrome/Chromium found; pass --chrome /path/to/chrome');
}

function encodeChunk(pngBuffers, outFile) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-g', String(FPS), '-movflags', '+faststart',
      outFile,
    ]);
    let err = '';
    ff.stderr.on('data', (d) => (err += d));
    ff.on('error', reject); // spawn failure (e.g. ffmpeg not on PATH)
    ff.stdin.on('error', () => {}); // EPIPE surfaces via the close code instead
    ff.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err}`)),
    );
    (async () => {
      for (const buf of pngBuffers) {
        if (ff.stdin.destroyed) return; // encoder died; close handler reports it
        if (!ff.stdin.write(buf)) {
          await new Promise((r) => {
            const done = () => {
              ff.stdin.off('drain', done);
              ff.stdin.off('close', done);
              r();
            };
            ff.stdin.once('drain', done);
            ff.stdin.once('close', done);
          });
        }
      }
      if (!ff.stdin.destroyed) ff.stdin.end();
    })().catch(reject);
  });
}

async function recordEpisode(page, args, seed, matchId, spec) {
  const dir = path.join(args.out, matchId);
  // episodes are deterministic per (seed, spec): re-runs replace, never dup
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  // deterministic per-seed warmup, so starting states vary across episodes
  const warmupFrames = (seed * 37) % 101;
  const info = await page.evaluate(
    (cfg) => window.__init(cfg),
    { seed, width: args.width, height: args.height, warmupFrames, antialias: args.antialias, spec },
  );

  const actionLines = [];
  const physicsLines = [];
  let pngs = [];
  let chunkIdx = 0;
  const chunkFrames = [];
  const encodeJobs = [];
  const encodeErrors = [];
  const t0 = Date.now();

  // encode rejections are captured at creation time (never left unhandled —
  // a bare rejection would take down the whole multi-episode run) and any
  // in-flight jobs are settled before an episode error propagates
  try {
    for (let f = 0; f < args.frames; f += args.batch) {
      const n = Math.min(args.batch, args.frames - f);
      const batch = await page.evaluate((k) => window.__stepBatch(k), n);
      for (let i = 0; i < n; i++) {
        pngs.push(Buffer.from(batch.frames[i].slice('data:image/png;base64,'.length), 'base64'));
        actionLines.push(JSON.stringify({ keys: batch.actions[i] }));
        physicsLines.push(JSON.stringify(batch.physics[i]));
        if (pngs.length === args.chunk) {
          const outFile = path.join(dir, `chunk_${String(chunkIdx).padStart(5, '0')}.mp4`);
          encodeJobs.push(encodeChunk(pngs, outFile).catch((e) => encodeErrors.push(e)));
          chunkFrames.push(args.chunk);
          pngs = [];
          chunkIdx++;
        }
      }
      if (encodeErrors.length) break; // stop capturing for a doomed episode
    }
  } finally {
    await Promise.all(encodeJobs);
  }
  if (encodeErrors.length) {
    throw new Error(`chunk encode failed: ${encodeErrors[0].message}`);
  }

  const meta = await page.evaluate(() => window.__episodeMeta());
  await fs.writeFile(path.join(dir, 'actions.jsonl'), actionLines.join('\n') + '\n');
  await fs.writeFile(path.join(dir, 'physics.jsonl'), physicsLines.join('\n') + '\n');
  await fs.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify(
      {
        matchId,
        seed,
        fps: FPS,
        frames: args.frames,
        chunkFrames,
        warmupFrames,
        resolution: [args.width, args.height],
        trackLength: info.trackLength,
        actionKeys: info.actionKeys,
        spec: spec || undefined,
        laps: meta.laps,
        score: meta.score,
        progressMeters: meta.progress,
        events: meta.events,
      },
      null,
      2,
    ),
  );
  const secs = (Date.now() - t0) / 1000;
  const genFps = (args.frames / secs).toFixed(1);
  console.log(
    `${matchId}: ${args.frames} frames in ${secs.toFixed(0)}s (${genFps} fps), ` +
      `${meta.laps} laps, ${meta.events.length} events, track ${info.trackLength}m`,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const chrome = findChrome(args.chrome);
  const spec = args.spec ? JSON.parse(await fs.readFile(args.spec, 'utf8')) : null;
  await fs.mkdir(args.out, { recursive: true });

  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(
    `recording ${args.episodes} episodes x ${args.frames} frames ` +
      `(${args.width}x${args.height} @ ${FPS}fps, chunks of ${args.chunk}) ` +
      `with concurrency ${args.concurrency}`,
  );

  const seeds = Array.from({ length: args.episodes }, (_, i) => args.seed0 + i);
  let nextIdx = 0;
  let failures = 0;

  async function worker(wid) {
    const launch = () =>
      puppeteer.launch({
        executablePath: chrome,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--enable-unsafe-swiftshader',
          '--use-angle=swiftshader',
          '--hide-scrollbars',
        ],
      });
    let browser = await launch();

    const freshPage = async () => {
      const page = await browser.newPage();
      await page.setViewport({ width: args.width, height: args.height, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => console.error(`[w${wid}] page error:`, e.message));
      await page.goto(`http://127.0.0.1:${port}/recorder.html`, { waitUntil: 'load' });
      await page.waitForFunction('window.__ready === true', { timeout: 30000 });
      return page;
    };

    try {
      let page = await freshPage();
      let consecutiveFailures = 0;

      while (true) {
        const idx = nextIdx++;
        if (idx >= seeds.length) break;
        const seed = seeds[idx];
        // deterministic id: same (seed, spec, out-dir) re-records in place
        const matchId = `racer-s${String(seed).padStart(7, '0')}`;
        try {
          await recordEpisode(page, args, seed, matchId, spec);
          consecutiveFailures = 0;
        } catch (e) {
          failures++;
          consecutiveFailures++;
          console.error(`[w${wid}] episode seed=${seed} FAILED: ${e.message}`);
          await fs.rm(path.join(args.out, matchId), { recursive: true, force: true });
          if (consecutiveFailures >= 3) {
            console.error(`[w${wid}] aborting after ${consecutiveFailures} consecutive failures`);
            break;
          }
          // a crashed page/browser poisons every following episode — recover
          try {
            if (!browser.connected) {
              browser = await launch();
              page = await freshPage();
            } else if (page.isClosed()) {
              page = await freshPage();
            } else {
              await page.evaluate(() => window.__ready === true);
            }
          } catch {
            try {
              await browser.close();
            } catch {
              /* already gone */
            }
            browser = await launch();
            page = await freshPage();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: args.concurrency }, (_, w) => worker(w)));
  server.close();
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`done: ${args.episodes - failures}/${args.episodes} episodes in ${mins} min -> ${args.out}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
