// Next config for the MIRA web surface.
//
// The play page imports the game engine directly from ../racer/src via
// relative paths (plain ESM, no build step of its own). Two things make that
// work with both `next dev` and `next build`:
//
//  1. outputFileTracingRoot points at the repo root so Next is comfortable
//     tracing files that live outside web/.
//  2. A webpack alias pins `three` to web/node_modules/three. The engine
//     files import bare 'three'; without the alias, node resolution would
//     find racer/node_modules/three for engine modules and web/node_modules/
//     three for web modules — two copies of the library in one bundle.
//
// Scripts are pinned to webpack (no --turbopack): Turbopack's handling of
// imports that escape the project root is not something we want to depend on.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // repo root — lets Next trace the engine sources under ../racer
  outputFileTracingRoot: path.join(__dirname, '..'),

  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      // one copy of three for both web/ and ../racer/src (see header comment)
      three: path.resolve(__dirname, 'node_modules/three'),
    };
    return config;
  },
};

export default nextConfig;
