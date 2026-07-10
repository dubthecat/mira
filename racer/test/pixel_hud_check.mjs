// Pixel-level HUD ↔ engine-variable verification: renders real gameplay in
// headless Chrome (the exact recorder pipeline) and, at checkpoints, samples
// the canvas pixels to confirm the HUD bars/segments encode the live world
// state. This is the ground truth the diffusion model will learn — if the
// pixels disagree with physics.jsonl, training data is teaching a lie.
//
// Run: node test/pixel_hud_check.mjs   (needs Chrome; ~60s)

import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { createServer } from '../src/record/serve.js';
import { compileSpec } from '../src/spec/compile.js';

const W = 512;
const H = 288;

function findChrome() {
  for (const c of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']) {
    try {
      execFileSync(c, ['--version'], { stdio: 'pipe' });
      return c;
    } catch {
      /* next */
    }
  }
  throw new Error('no chrome found');
}

// In-page sampler: draws the WebGL canvas into a 2D canvas and measures HUD
// regions by color signature, then reads the matching world state.
const SAMPLER = `(() => {
  const gl = document.querySelector('canvas');
  const c2 = document.createElement('canvas');
  c2.width = gl.width; c2.height = gl.height;
  const ctx = c2.getContext('2d');
  ctx.drawImage(gl, 0, 0);
  const img = ctx.getImageData(0, 0, c2.width, c2.height).data;
  const px = (x, y) => {
    const i = (y * c2.width + x) * 4;
    return [img[i], img[i + 1], img[i + 2]];
  };
  // classify a horizontal strip: fraction of pixels matching a predicate,
  // measured over the bar's row band
  const rowFrac = (y0, y1, x0, x1, pred) => {
    let hit = 0, total = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const [r, g, b] = px(x, y);
        total++;
        if (pred(r, g, b)) hit++;
      }
    }
    return hit / Math.max(1, total);
  };
  const isAmber = (r, g, b) => r > 150 && g > 90 && b < 90;          // speed fill
  const isCyan = (r, g, b) => b > 150 && g > 130 && r < 120;          // boost fill
  const isGreen = (r, g, b) => g > 130 && r < 110 && b < 130;         // health lit
  const isWhiteText = (r, g, b) => r > 200 && g > 200 && b > 200;
  const w = window.__world;
  return {
    // scan generous bands; bars live in known corners at 512x288
    speedFrac: rowFrac(258, 270, 6, 140, isAmber),
    boostFrac: rowFrac(272, 282, 6, 140, isCyan),
    healthFrac: rowFrac(8, 24, 24, 180, isGreen),
    textPresent: rowFrac(250, 284, 145, 260, isWhiteText),
    state: {
      u: Math.abs(w.car.u),
      boost: w.car.boost,
      health: w.health,
      healthMax: w.spec.rules.healthMax,
      ammo: w.ammo,
      score: w.score,
    },
  };
})()`;

async function main() {
  const spec = compileSpec('desert race with 6 chasing monsters and a blaster, minimap', { seed: 9 });
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  let failures = 0;
  const check = (name, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `  <-- ${detail}`}`);
    if (!cond) failures++;
  };
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => {
      console.error('page error:', e.message);
      failures++;
    });
    await page.goto(`http://127.0.0.1:${port}/recorder.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', { timeout: 30000 });
    await page.evaluate((cfg) => window.__init(cfg), { seed: 9, width: W, height: H, warmupFrames: 0, spec });

    // calibration ratios (bar geometry constants vary with hud layout, so we
    // verify PROPORTIONALITY: measured fill fraction tracks state fraction)
    const samples = [];
    for (let cp = 0; cp < 12; cp++) {
      await page.evaluate((n) => window.__stepBatch(n), 25);
      samples.push(await page.evaluate(SAMPLER));
    }

    // 1. boost bar tracks the boost meter (linear fit through origin-ish)
    const pairs = (getM, getS) => samples.map((s) => [getM(s), getS(s)]);
    const corr = (ps) => {
      const n = ps.length;
      const mx = ps.reduce((a, p) => a + p[0], 0) / n;
      const my = ps.reduce((a, p) => a + p[1], 0) / n;
      let num = 0;
      let dx = 0;
      let dy = 0;
      for (const [x, y] of ps) {
        num += (x - mx) * (y - my);
        dx += (x - mx) ** 2;
        dy += (y - my) ** 2;
      }
      return dx > 1e-9 && dy > 1e-9 ? num / Math.sqrt(dx * dy) : NaN;
    };

    const boostPairs = pairs((s) => s.boostFrac, (s) => s.state.boost / 100);
    const speedPairs = pairs((s) => s.speedFrac, (s) => Math.min(1, (s.state.u * 3.6) / 180));
    const healthPairs = pairs((s) => s.healthFrac, (s) => s.state.health / s.state.healthMax);

    const varied = (ps) => new Set(ps.map((p) => p[1].toFixed(2))).size >= 3;
    check('boost bar tracks meter', !varied(boostPairs) || corr(boostPairs) > 0.9, `corr=${corr(boostPairs)?.toFixed(3)} pairs=${JSON.stringify(boostPairs.map((p) => p.map((v) => +v.toFixed(2))))}`);
    check('speed bar tracks speed', !varied(speedPairs) || corr(speedPairs) > 0.9, `corr=${corr(speedPairs)?.toFixed(3)} pairs=${JSON.stringify(speedPairs.map((p) => p.map((v) => +v.toFixed(2))))}`);
    check('health segments track health', !varied(healthPairs) || corr(healthPairs) > 0.85, `corr=${corr(healthPairs)?.toFixed(3)} pairs=${JSON.stringify(healthPairs.map((p) => p.map((v) => +v.toFixed(2))))}`);
    check('at least one meter actually varied during play', varied(boostPairs) || varied(speedPairs) || varied(healthPairs), 'no variation — test exercised nothing');

    // 2. bars visible at all (nonzero fills whenever state nonzero)
    const anyBoost = samples.some((s) => s.state.boost > 20 && s.boostFrac > 0.02);
    check('boost fill visible', anyBoost, JSON.stringify(samples.map((s) => +s.boostFrac.toFixed(3))));
    const anySpeed = samples.some((s) => s.state.u > 8 && s.speedFrac > 0.02);
    check('speed fill visible', anySpeed, JSON.stringify(samples.map((s) => +s.speedFrac.toFixed(3))));

    // 3. speed digits render (white text present in the readout region)
    check('speed digits legible', samples.every((s) => s.state.u < 2 || s.textPresent > 0.005), JSON.stringify(samples.map((s) => +s.textPresent.toFixed(4))));

    // 4. HUD legibility across biomes: snow (worst case: white-on-white risk)
    for (const biome of ['snow', 'night']) {
      const bSpec = compileSpec(`${biome} race with monsters and a gun`, { seed: 4 });
      await page.evaluate((cfg) => window.__init(cfg), { seed: 4, width: W, height: H, warmupFrames: 40, spec: bSpec });
      await page.evaluate((n) => window.__stepBatch(n), 30);
      const s = await page.evaluate(SAMPLER);
      check(`${biome}: bars visible over scenery`, s.boostFrac > 0.02 || s.speedFrac > 0.02, JSON.stringify({ boost: s.boostFrac, speed: s.speedFrac }));
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures === 0 ? '\nALL PIXEL CHECKS PASS' : `\n${failures} PIXEL CHECKS FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
