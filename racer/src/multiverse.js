// Multiverse generator: one command → a balanced multi-genre dataset, one
// packed MIRA dataset per battery genre plus a manifest. This is the trainer
// feed for "one model, many games".
//
//   node src/multiverse.js --genres all --episodes 6 --frames 2400 \
//        --out runs/multiverse-v2 --fast [--validate]
//
// --fast records with JPEG capture + no antialiasing (~+55% throughput,
// visually near-identical at 512x288 under CRF-18 H.264) — the recommended
// preset for bulk training data.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileBattery } from './spec/battery.js';

const RACER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const a = {
    genres: 'all',
    episodes: 6,
    frames: 2400,
    seed0: 3000,
    concurrency: 3,
    out: 'runs/multiverse-v2',
    fast: false,
    validate: false,
    'test-every': 6,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'fast' || k === 'validate') {
      a[k] = true;
      continue;
    }
    const v = argv[++i];
    if (!(k in a)) throw new Error(`unknown arg --${k}`);
    a[k] = typeof a[k] === 'number' ? parseInt(v, 10) : v;
  }
  return a;
}

const args = parseArgs(process.argv);
const battery = compileBattery();
const picked =
  args.genres === 'all'
    ? battery
    : battery.filter((b) => args.genres.split(',').includes(b.key));
if (picked.length === 0) {
  console.error(`no genres matched '${args.genres}' (have: ${battery.map((b) => b.key).join(', ')})`);
  process.exit(2);
}

const outRoot = path.resolve(RACER, args.out);
mkdirSync(outRoot, { recursive: true });
const manifest = {
  createdBy: 'multiverse.js',
  episodesPerGenre: args.episodes,
  framesPerEpisode: args.frames,
  fast: args.fast,
  genres: {},
};

const fastFlags = args.fast ? '--jpeg --no-antialias' : '';
const t0 = Date.now();
for (const { key, spec } of picked) {
  const dir = path.join(outRoot, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  console.log(`\n=== ${key} (${spec.archetype}, ${spec.world.biome}, ${spec.weapon.enabled ? 7 : 6} keys) ===`);
  execSync(
    `node src/record/headless.js --episodes ${args.episodes} --frames ${args.frames} ` +
      `--seed0 ${args.seed0} --out ${dir}/episodes --concurrency ${args.concurrency} ` +
      `--spec ${dir}/spec.json ${fastFlags}`,
    { cwd: RACER, stdio: 'inherit' },
  );
  const ffmpegBin = path.join(RACER, 'pack/.ffmpeg/bin');
  const pathPrefix = existsSync(ffmpegBin) ? `PATH=${ffmpegBin}:$PATH ` : '';
  execSync(
    `${pathPrefix}python3 pack/pack_dataset.py --episodes ${dir}/episodes --out ${dir}/dataset ` +
      `--test-every ${args['test-every']}`,
    { cwd: RACER, stdio: 'inherit' },
  );
  if (args.validate) {
    const keys = (spec.weapon.enabled
      ? ['W', 'S', 'A', 'D', 'Space', 'LShiftKey', 'F']
      : ['W', 'S', 'A', 'D', 'Space', 'LShiftKey']
    ).join(',');
    const venv = path.join(RACER, 'pack/.venv/bin/python');
    const py = existsSync(venv) ? venv : 'python3';
    execSync(
      `LD_LIBRARY_PATH=${path.join(RACER, 'pack/.ffmpeg/lib')} ${py} pack/validate_mira.py ` +
        `${dir}/dataset/train --clip-len 40 --target-fps 20 --keys ${keys}`,
      { cwd: RACER, stdio: 'inherit' },
    );
  }
  manifest.genres[key] = {
    archetype: spec.archetype,
    biome: spec.world.biome,
    actionKeys: spec.weapon.enabled ? 7 : 6,
    frames: args.episodes * args.frames,
  };
  writeFileSync(path.join(outRoot, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
}
const mins = ((Date.now() - t0) / 60000).toFixed(1);
const totalFrames = picked.length * args.episodes * args.frames;
console.log(`\nMULTIVERSE DONE: ${picked.length} genres, ${totalFrames.toLocaleString()} frames in ${mins} min -> ${outRoot}`);
console.log(`upload: HF_TOKEN=... pack/.venv/bin/python pack/upload_multiverse.py ${outRoot} <user>/<repo>`);
