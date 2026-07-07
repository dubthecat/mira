#!/usr/bin/env node
// forge: the one-command pipeline from a prompt to a trainable MIRA dataset.
//
//   prompt -> GameSpec (src/spec/compile.js) -> recorded episodes
//   (src/record/headless.js) -> packed WebDataset (pack/pack_dataset.py)
//   [-> contract validation (pack/validate_mira.py)]
//
//   node src/forge.js "night race, chasing monsters, blaster" \
//       --episodes 24 --frames 2400 --seed0 1000 --out runs/night-race \
//       [--variety 0.3] [--set weapon.enabled=true --set 'entities.monsters=[{"type":"chaser","count":6}]'] \
//       [--concurrency 3] [--pack] [--validate] [--dry-run]
//
// --set assigns dot-paths into the spec overrides; values are JSON-parsed when
// possible (true, 0.7, [{"type":"chaser","count":6}]) and kept as strings
// otherwise (weapon.kind=spread). --dry-run prints the compiled spec, derived
// action keys and a one-line summary, writes nothing, and exits.
//
// Everything under <out>/ belongs to one spec: spec.json (the game), episodes/
// (raw recordings), dataset/ (packed train/ + test/), actions.yaml (the MIRA
// action config to install as configs/actions/<name>.yaml). No npm deps.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { actionKeysFor } from './spec/schema.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // racer/

// -- arg parsing (exported for test/forge_check.mjs) --------------------------

export const USAGE = `usage: node src/forge.js "<prompt>" [options]
  --episodes N      episodes to record (default 24)
  --frames N        frames per episode (default 2400; multiple of 80)
  --seed0 N         first episode seed, also the spec-compile seed (default 1000)
  --out DIR         run directory (default runs/<slug-of-prompt>)
  --variety X       0..1 spec randomization passed to compileSpec (default 0)
  --set K.PATH=V    override a spec field (repeatable; V is JSON or a bare string)
  --concurrency N   parallel recorder workers (default 3)
  --pack            pack episodes into <out>/dataset (train/ + test/)
  --validate        run pack/validate_mira.py on both packed splits
  --dry-run         print spec + action keys + summary, write nothing`;

export function slugify(text) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || 'game';
}

// JSON value when it parses, bare string otherwise (so `weapon.kind=spread`
// needs no quoting but `weapon.enabled=true` becomes a real boolean)
export function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function setPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  if (parts.some((p) => p === '')) throw new Error(`bad --set path '${dotPath}'`);
  let node = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof node[p] !== 'object' || node[p] === null || Array.isArray(node[p])) node[p] = {};
    node = node[p];
  }
  node[parts[parts.length - 1]] = value;
  return obj;
}

// repeated `--set a.b.c=<json|string>` flags -> nested spec-overrides object
export function buildOverrides(setArgs) {
  const overrides = {};
  for (const s of setArgs) {
    const eq = s.indexOf('=');
    if (eq <= 0) throw new Error(`--set expects key.path=value, got '${s}'`);
    setPath(overrides, s.slice(0, eq), parseValue(s.slice(eq + 1)));
  }
  return overrides;
}

// argv = process.argv.slice(2): one positional prompt + flags
export function parseForgeArgs(argv) {
  const a = {
    prompt: null,
    episodes: 24,
    frames: 2400,
    seed0: 1000,
    out: '',
    variety: 0,
    set: [],
    concurrency: 3,
    pack: false,
    validate: false,
    dryRun: false,
  };
  const ints = ['episodes', 'frames', 'seed0', 'concurrency'];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (a.prompt !== null) throw new Error(`unexpected extra positional '${arg}' (quote the prompt)`);
      a.prompt = arg;
      continue;
    }
    const k = arg.slice(2);
    if (k === 'pack' || k === 'validate') {
      a[k] = true;
    } else if (k === 'dry-run') {
      a.dryRun = true;
    } else if (k === 'set') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--set needs a key.path=value argument');
      a.set.push(v);
    } else if (ints.includes(k) || k === 'variety' || k === 'out') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      if (k === 'out') a.out = v;
      else {
        a[k] = ints.includes(k) ? parseInt(v, 10) : parseFloat(v);
        if (!Number.isFinite(a[k])) throw new Error(`--${k} needs a number, got '${v}'`);
      }
    } else {
      throw new Error(`unknown flag --${k}`);
    }
  }
  if (a.prompt === null || a.prompt.trim() === '') throw new Error('missing prompt (first positional argument)');
  if (!a.out) a.out = path.join('runs', slugify(a.prompt));
  return a;
}

// -- spec presentation (exported for test/forge_check.mjs) --------------------

const KEY_COMMENTS = {
  W: 'throttle',
  S: 'brake / reverse',
  A: 'steer left',
  D: 'steer right',
  Space: 'handbrake',
  LShiftKey: 'boost / nitro',
  F: 'fire weapon',
};

// MIRA actions config (same shape as configs/actions/racing.yaml) for a spec
export function actionsYamlFor(spec) {
  const keys = actionKeysFor(spec);
  const prompt = String(spec.prompt || '').replace(/\s+/g, ' ').trim();
  const lines = [
    `# MIRA actions config for GameSpec '${spec.name}' — generated by racer/src/forge.js`,
    ...(prompt ? [`# prompt: ${prompt}`] : []),
    `# Install as configs/actions/${spec.name}.yaml and reference it from the dataset config.`,
    '# ORDER IS LOAD-BEARING: it defines the multi-hot columns and the checkpoint layout.',
    'target_fps: 20',
    'valid_keys:',
  ];
  for (const k of keys) {
    const comment = KEY_COMMENTS[k];
    lines.push(comment ? `  - ${k.padEnd(12)} # ${comment}` : `  - ${k}`);
  }
  return lines.join('\n') + '\n';
}

// one line of "what this game is", printed by --dry-run and before recording
export function summarizeSpec(spec) {
  const m = spec.entities.monsters;
  const monsters = m.length ? m.map((x) => `${x.count}x ${x.type}`).join(' + ') : 'no monsters';
  const weapon = spec.weapon.enabled ? `${spec.weapon.kind} weapon (F fires)` : 'no weapon';
  const g = spec.vehicle.gripScale;
  const grip = g < 0.85 ? 'drifty' : g > 1.15 ? 'on-rails' : 'standard';
  const t = spec.vehicle.topSpeedScale;
  const pace = t > 1.15 ? 'fast, ' : t < 0.85 ? 'slow, ' : '';
  return (
    `${spec.name}: ${spec.world.biome} biome, ${pace}${grip} handling, ${monsters}, ${weapon}, ` +
    `hud [${spec.hud.elements.join(' ')}], ${actionKeysFor(spec).length} action keys`
  );
}

// -- pipeline ------------------------------------------------------------------

async function loadCompileSpec() {
  // FORGE_COMPILE is a test hook: test/forge_check.mjs points it at a stub
  // module while src/spec/compile.js is being written in parallel.
  const url = process.env.FORGE_COMPILE
    ? pathToFileURL(path.resolve(process.env.FORGE_COMPILE)).href
    : new URL('./spec/compile.js', import.meta.url).href;
  let mod;
  try {
    mod = await import(url);
  } catch (err) {
    throw new Error(
      `cannot load the spec compiler (${url}): ${err.message}\n` +
        'src/spec/compile.js must export compileSpec(prompt, {seed, overrides, variety})',
    );
  }
  if (typeof mod.compileSpec !== 'function') {
    throw new Error(`spec compiler ${url} does not export compileSpec()`);
  }
  return mod.compileSpec;
}

function run(label, cmd, argv, extraEnv = {}) {
  console.log(`[forge] ${label}: ${cmd} ${argv.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.on('error', (err) => reject(new Error(`${label}: failed to start ${cmd}: ${err.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${cmd} exited ${signal ?? code})`));
    });
  });
}

// the packer/validator need ffprobe + FFmpeg shared libs; the repo-local
// static build under pack/.ffmpeg is preferred when present
function ffmpegEnv() {
  const env = {};
  const bin = path.join(ROOT, 'pack', '.ffmpeg', 'bin');
  const lib = path.join(ROOT, 'pack', '.ffmpeg', 'lib');
  if (fs.existsSync(bin)) env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  if (fs.existsSync(lib)) {
    env.LD_LIBRARY_PATH = `${lib}${process.env.LD_LIBRARY_PATH ? path.delimiter + process.env.LD_LIBRARY_PATH : ''}`;
  }
  return env;
}

function printNextSteps(out, spec, keys, packed) {
  const dataset = path.join(out, 'dataset');
  console.log('\n[forge] next steps — train on this dataset:');
  console.log(`  action config (REQUIRED; keys + order are load-bearing: ${keys.join(',')}):`);
  console.log(`      cp ${path.join(out, 'actions.yaml')} <mira-repo>/configs/actions/${spec.name}.yaml`);
  console.log(`      # then point the dataset config at it (configs/dataset/racing.yaml:`);
  console.log(`      #   "- /actions@actions: ${spec.name}"), or overwrite configs/actions/racing.yaml`);
  if (!packed) console.log(`  pack first (re-run with --pack) to produce ${dataset}/{train,test}`);
  console.log('  codec:');
  console.log('      python scripts/train_codec.py dataset=racing \\');
  console.log(`          dataset.train_index=${path.join(dataset, 'train')} dataset.test_index=${path.join(dataset, 'test')}`);
  console.log('  world model:');
  console.log('      python scripts/train_world_model.py dataset=racing \\');
  console.log('          model.architecture.config.codec_checkpoint=<codec-ckpt>.pth \\');
  console.log(`          dataset.train_index=${path.join(dataset, 'train')} dataset.test_index=${path.join(dataset, 'test')}`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseForgeArgs(argv);
  const compileSpec = await loadCompileSpec();
  const spec = compileSpec(args.prompt, {
    seed: args.seed0,
    overrides: buildOverrides(args.set),
    variety: args.variety,
  });
  const keys = actionKeysFor(spec);

  if (args.dryRun) {
    console.log('GameSpec (dry run — nothing written):');
    console.log(JSON.stringify(spec, null, 2));
    console.log(`\naction keys: ${keys.join(', ')}`);
    console.log(`summary: ${summarizeSpec(spec)}`);
    return;
  }

  const out = path.resolve(args.out);
  fs.mkdirSync(out, { recursive: true });
  const specPath = path.join(out, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'actions.yaml'), actionsYamlFor(spec));
  console.log(`[forge] ${summarizeSpec(spec)}`);
  console.log(`[forge] wrote ${specPath} and ${path.join(out, 'actions.yaml')}`);

  const episodes = path.join(out, 'episodes');
  await run('record', process.execPath, [
    'src/record/headless.js',
    '--episodes', String(args.episodes),
    '--frames', String(args.frames),
    '--seed0', String(args.seed0),
    '--out', episodes,
    '--concurrency', String(args.concurrency),
    '--spec', specPath,
  ]);

  const dataset = path.join(out, 'dataset');
  if (args.pack) {
    await run('pack', 'python3', [
      'pack/pack_dataset.py',
      '--episodes', episodes,
      '--out', dataset,
      '--test-every', '10',
    ], ffmpegEnv());
  }

  if (args.validate) {
    const venvPy = path.join(ROOT, 'pack', '.venv', 'bin', 'python');
    const py = fs.existsSync(venvPy) ? venvPy : 'python3';
    for (const split of ['train', 'test']) {
      const splitDir = path.join(dataset, split);
      if (!fs.existsSync(path.join(splitDir, 'index.json'))) {
        throw new Error(`--validate: ${splitDir}/index.json not found (pack first: re-run with --pack)`);
      }
      await run(`validate ${split}`, py, ['pack/validate_mira.py', splitDir, '--keys', keys.join(',')], ffmpegEnv());
    }
  }

  printNextSteps(out, spec, keys, args.pack);
}

// run as a CLI only; test/forge_check.mjs imports the functions above instead
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`\n[forge] FAILED: ${err.message}`);
    if (/^(missing prompt|unknown flag|unexpected extra|--)/.test(err.message)) console.error(`\n${USAGE}`);
    process.exit(1);
  });
}
