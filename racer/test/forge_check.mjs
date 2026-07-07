// Forge + packer spec-support checks — no episode recording needed.
// Run from racer/: node test/forge_check.mjs   (needs ffmpeg + python3 on PATH)
//
// Covers: forge arg parsing (--set dot-paths + JSON values), actions.yaml
// generation, --dry-run on two prompts via the real CLI, and the packer's
// GameSpec support (game_spec/action_keys/arena in index.json, mixed-spec
// rejection, action-vocabulary subset check) against tiny synthetic episodes
// (2 chunks x 4 frames of ffmpeg testsrc2).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  actionsYamlFor,
  buildOverrides,
  parseForgeArgs,
  parseValue,
  slugify,
  summarizeSpec,
} from '../src/forge.js';
import { actionKeysFor, BASE_KEYS, makeSpec } from '../src/spec/schema.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // racer/
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-check-'));

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

// src/spec/compile.js is being written in parallel. If it is not importable
// yet, the CLI dry-run tests inject a stub compiler (same documented signature:
// compileSpec(prompt, {seed, overrides, variety}) -> spec) via the FORGE_COMPILE
// test hook; drop this guard once compile.js has landed.
let compileEnv = {};
try {
  await import('../src/spec/compile.js');
  console.log('using real src/spec/compile.js');
} catch {
  const stub = path.join(TMP, 'compile_stub.mjs');
  const schemaUrl = pathToFileURL(path.join(ROOT, 'src', 'spec', 'schema.js')).href;
  fs.writeFileSync(
    stub,
    `// stand-in for src/spec/compile.js (not written yet): defaults + overrides, slug name
import { makeSpec, merge } from '${schemaUrl}';
export function compileSpec(prompt, { seed = 0, overrides = {}, variety = 0 } = {}) {
  const name = String(prompt).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'game';
  return makeSpec(merge({ name, prompt }, overrides));
}
`,
  );
  compileEnv = { FORGE_COMPILE: stub };
  console.log('src/spec/compile.js not found — dry-run tests use a stub compiler (FORGE_COMPILE)');
}

function forge(argv) {
  return spawnSync(process.execPath, ['src/forge.js', ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...compileEnv },
  });
}

// --- 1. arg parsing + --set overrides ----------------------------------------

ok('parseForgeArgs defaults + auto out slug', () => {
  const a = parseForgeArgs(['night race with monsters']);
  assert.equal(a.prompt, 'night race with monsters');
  assert.equal(a.episodes, 24);
  assert.equal(a.frames, 2400);
  assert.equal(a.seed0, 1000);
  assert.equal(a.concurrency, 3);
  assert.equal(a.out, path.join('runs', 'night-race-with-monsters'));
  assert.equal(a.pack, false);
  assert.equal(a.dryRun, false);
});

ok('parseForgeArgs flags', () => {
  const a = parseForgeArgs([
    'p', '--episodes', '8', '--frames', '160', '--seed0', '7', '--out', 'runs/x',
    '--variety', '0.3', '--concurrency', '2', '--pack', '--validate', '--dry-run',
    '--set', 'weapon.enabled=true',
  ]);
  assert.deepEqual(
    [a.episodes, a.frames, a.seed0, a.out, a.variety, a.concurrency, a.pack, a.validate, a.dryRun],
    [8, 160, 7, 'runs/x', 0.3, 2, true, true, true],
  );
  assert.deepEqual(a.set, ['weapon.enabled=true']);
  assert.throws(() => parseForgeArgs(['p', '--bogus', '1']), /unknown flag/);
  assert.throws(() => parseForgeArgs(['--episodes', '4']), /missing prompt/);
});

ok('buildOverrides: dot-paths + JSON values + bare strings', () => {
  const o = buildOverrides([
    'weapon.enabled=true',
    'weapon.kind=spread', // bare string (not valid JSON) stays a string
    'entities.monsters=[{"type":"chaser","count":6}]',
    'vehicle.gripScale=0.7',
    'world.biome=night',
    'hud.elements=["speed","health","score"]',
  ]);
  assert.equal(o.weapon.enabled, true);
  assert.equal(o.weapon.kind, 'spread');
  assert.deepEqual(o.entities.monsters, [{ type: 'chaser', count: 6 }]);
  assert.equal(o.vehicle.gripScale, 0.7);
  assert.equal(o.world.biome, 'night');
  assert.deepEqual(o.hud.elements, ['speed', 'health', 'score']);
  assert.throws(() => buildOverrides(['noequals']), /key\.path=value/);
  // the overrides must survive makeSpec's merge + validation
  const spec = makeSpec(o);
  assert.equal(spec.world.biome, 'night');
  assert.deepEqual(actionKeysFor(spec), [...BASE_KEYS, 'F']);
});

ok('parseValue: JSON when parseable, string otherwise', () => {
  assert.equal(parseValue('true'), true);
  assert.equal(parseValue('42'), 42);
  assert.deepEqual(parseValue('[1,2]'), [1, 2]);
  assert.equal(parseValue('blaster'), 'blaster');
});

ok('slugify', () => {
  assert.equal(slugify('A Lava Rally, at Night!'), 'a-lava-rally-at-night');
  assert.equal(slugify('!!!'), 'game');
});

// --- 2. actions.yaml generation ----------------------------------------------

ok('actionsYamlFor: base 6-key vocabulary, racing.yaml shape', () => {
  const spec = makeSpec({ name: 'plain-race' });
  const yaml = actionsYamlFor(spec);
  assert.match(yaml, /^target_fps: 20$/m);
  assert.match(yaml, /^valid_keys:$/m);
  const keys = [...yaml.matchAll(/^ {2}- (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(keys, BASE_KEYS); // order is load-bearing
  assert.ok(!keys.includes('F'));
  assert.match(yaml, /plain-race/);
});

ok('actionsYamlFor: weapon adds F, order preserved', () => {
  const spec = makeSpec({ name: 'shooty', weapon: { enabled: true } });
  const keys = [...actionsYamlFor(spec).matchAll(/^ {2}- (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(keys, actionKeysFor(spec));
  assert.deepEqual(keys, [...BASE_KEYS, 'F']);
});

ok('summarizeSpec mentions biome, monsters, weapon', () => {
  const s = summarizeSpec(makeSpec({
    name: 'night-hunt', world: { biome: 'night' }, weapon: { enabled: true },
    entities: { monsters: [{ type: 'chaser', count: 6 }] },
  }));
  for (const want of ['night-hunt', 'night biome', '6x chaser', 'blaster weapon', '7 action keys']) {
    assert.ok(s.includes(want), `summary missing '${want}': ${s}`);
  }
});

// --- 3. forge --dry-run via the real CLI --------------------------------------

ok('dry-run prompt 1: prints spec + keys, writes nothing, exit 0', () => {
  const slug = 'a-quiet-meadow-time-trial';
  fs.rmSync(path.join(ROOT, 'runs', slug), { recursive: true, force: true });
  const r = forge(['a quiet meadow time trial', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"name"/);
  assert.match(r.stdout, /"biome"/);
  assert.match(r.stdout, /"weapon"/);
  assert.match(r.stdout, /action keys: W, S, A, D, Space, LShiftKey/);
  assert.match(r.stdout, /summary: /);
  assert.ok(!fs.existsSync(path.join(ROOT, 'runs', slug)), 'dry-run must write nothing');
});

ok('dry-run prompt 2: --set overrides land in the printed spec', () => {
  const r = forge([
    'lava combat rally', '--dry-run',
    '--set', 'weapon.enabled=true',
    '--set', 'entities.monsters=[{"type":"turret","count":4}]',
    '--set', 'world.biome=lava',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"enabled": true/);
  assert.match(r.stdout, /"type": "turret"/);
  assert.match(r.stdout, /"biome": "lava"/);
  assert.match(r.stdout, /action keys: W, S, A, D, Space, LShiftKey, F/);
});

ok('bad flag fails loudly with usage', () => {
  const r = forge(['prompt', '--frobnicate', '1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag --frobnicate/);
  assert.match(r.stderr, /usage:/);
});

// --- 4. packer GameSpec support -----------------------------------------------
// hand-built raw episodes: 2 chunks x 4 frames each, ffmpeg testsrc2, real
// meta.json with spec + actionKeys — same layout headless.js --spec will emit

const SPEC = makeSpec({ name: 'night-hunt', world: { biome: 'night' }, weapon: { enabled: true } });
const KEYS = actionKeysFor(SPEC); // W,S,A,D,Space,LShiftKey,F
const OTHER_SPEC = makeSpec({ name: 'desert-drift', world: { biome: 'desert' } });
const FPS = 20;
const CHUNK = 4;
const N_CHUNKS = 2;

function encodeChunk(file, seed) {
  const r = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=64x36:rate=${FPS}`,
    '-vf', `noise=alls=10:allf=t+u:all_seed=${seed}`,
    '-frames:v', String(CHUNK), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS),
    '-preset', 'veryfast', file,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffmpeg failed: ${r.stderr}`);
}

function writeEpisode(dir, matchId, { spec, actionKeys, badKeyAtLine = -1 }) {
  const ep = path.join(dir, matchId);
  fs.mkdirSync(ep, { recursive: true });
  const frames = CHUNK * N_CHUNKS;
  for (let c = 0; c < N_CHUNKS; c++) {
    encodeChunk(path.join(ep, `chunk_${String(c).padStart(5, '0')}.mp4`), 100 + c);
  }
  const vocab = actionKeys ?? BASE_KEYS; // lines must stay inside the episode's own vocabulary
  const lines = [];
  for (let i = 0; i < frames; i++) {
    const held = i === badKeyAtLine ? ['W', 'Q'] : [vocab[i % vocab.length], 'W'];
    lines.push(JSON.stringify({ keys: held }));
  }
  fs.writeFileSync(path.join(ep, 'actions.jsonl'), lines.join('\n') + '\n');
  const meta = {
    matchId, seed: 40, fps: FPS, frames, chunkFrames: Array(N_CHUNKS).fill(CHUNK), events: [],
    ...(spec ? { spec } : {}), ...(actionKeys ? { actionKeys } : {}),
  };
  fs.writeFileSync(path.join(ep, 'meta.json'), JSON.stringify(meta, null, 2));
}

function pack(episodesDir, outDir, extra = []) {
  return spawnSync('python3', [
    'pack/pack_dataset.py', '--episodes', episodesDir, '--out', outDir, '--test-every', '2', ...extra,
  ], { cwd: ROOT, encoding: 'utf8' });
}

ok('packer: game_spec/action_keys/arena land in both split indexes', () => {
  const eps = path.join(TMP, 'eps-good');
  const ds = path.join(TMP, 'ds-good');
  writeEpisode(eps, 'forge-test-s0000001', { spec: SPEC, actionKeys: KEYS });
  writeEpisode(eps, 'forge-test-s0000002', { spec: SPEC, actionKeys: KEYS });
  const r = pack(eps, ds);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const split of ['train', 'test']) {
    const idx = JSON.parse(fs.readFileSync(path.join(ds, split, 'index.json'), 'utf8'));
    assert.deepEqual(idx.game_spec, SPEC, `${split}: game_spec != spec`);
    assert.deepEqual(idx.action_keys, KEYS, `${split}: action_keys`);
    assert.equal(idx.entries.length, 1);
    for (const e of idx.entries) assert.equal(e.arena, SPEC.name, `${split}: arena`);
  }
});

ok('packer: mixed-spec pair is rejected', () => {
  const eps = path.join(TMP, 'eps-mixed');
  const ds = path.join(TMP, 'ds-mixed');
  writeEpisode(eps, 'forge-test-s0000001', { spec: SPEC, actionKeys: KEYS });
  writeEpisode(eps, 'forge-test-s0000002', { spec: OTHER_SPEC, actionKeys: actionKeysFor(OTHER_SPEC) });
  const r = pack(eps, ds);
  assert.notEqual(r.status, 0, 'mixed specs must fail');
  assert.match(r.stderr, /spec differs from/);
  assert.match(r.stderr, /forge-test-s000000/);
});

ok('packer: spec-less + spec-ed mix is rejected too', () => {
  const eps = path.join(TMP, 'eps-half');
  const ds = path.join(TMP, 'ds-half');
  writeEpisode(eps, 'forge-test-s0000001', { spec: SPEC, actionKeys: KEYS });
  writeEpisode(eps, 'forge-test-s0000002', {}); // legacy episode, no spec
  const r = pack(eps, ds);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /has no spec/);
});

ok('packer: actions.jsonl key outside actionKeys names episode + line', () => {
  const eps = path.join(TMP, 'eps-badkey');
  const ds = path.join(TMP, 'ds-badkey');
  writeEpisode(eps, 'forge-test-s0000001', { spec: SPEC, actionKeys: KEYS, badKeyAtLine: 5 });
  writeEpisode(eps, 'forge-test-s0000002', { spec: SPEC, actionKeys: KEYS });
  const r = pack(eps, ds);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /forge-test-s0000001/);
  assert.match(r.stderr, /line 5/);
  assert.match(r.stderr, /'Q'/);
});

ok('packer: spec-less episodes still pack as before (regression)', () => {
  const eps = path.join(TMP, 'eps-legacy');
  const ds = path.join(TMP, 'ds-legacy');
  writeEpisode(eps, 'forge-test-s0000001', {});
  writeEpisode(eps, 'forge-test-s0000002', {});
  const r = pack(eps, ds);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const idx = JSON.parse(fs.readFileSync(path.join(ds, 'train', 'index.json'), 'utf8'));
  assert.ok(!('game_spec' in idx) && !('action_keys' in idx), 'no spec fields for legacy packs');
  assert.equal(idx.entries[0].arena, 'seed40'); // pre-spec arena derivation
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(process.exitCode ? '\nFAILURES above' : `\nall ${passed} checks passed`);
