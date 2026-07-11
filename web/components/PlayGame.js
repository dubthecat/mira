'use client';

// The play surface: the racer engine running full-viewport in a canvas, with
// the engine's own HUD baked into the frame (exactly like the training data)
// and a thin DOM chrome on top.
//
// This is a port of racer/src/game/main.js into a React client component:
// the sim steps at exactly 20 Hz off a fixed-timestep accumulator (identical
// dynamics to the recorded datasets) while rendering runs at display rate.
// Keyboard is sampled at frame boundaries — one action per frame, the same
// convention the dataset records.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import * as THREE from 'three';
// engine sources live outside web/ — plain ESM, imported relatively
import { FPS } from '../../racer/src/sim/world.js';
import { createView } from '../../racer/src/render/scene.js';
import { createHud } from '../../racer/src/render/hud.js';
import { makeSpec } from '../../racer/src/spec/schema.js';
import { compileSpec } from '../../racer/src/spec/compile.js';
import { compileBattery } from '../../racer/src/spec/battery.js';
import { LocalSimEngine } from '../lib/engine/engineSource.js';

// keyboard -> action names (the dataset vocabulary)
const KEYMAP = {
  KeyW: 'W', ArrowUp: 'W',
  KeyS: 'S', ArrowDown: 'S',
  KeyA: 'A', ArrowLeft: 'A',
  KeyD: 'D', ArrowRight: 'D',
  Space: 'Space',
  ShiftLeft: 'LShiftKey', ShiftRight: 'LShiftKey',
  KeyF: 'F',
};

export default function PlayGame({ prompt, genre = '', initialSeed = 1, initialBot = false }) {
  const [seed, setSeed] = useState(initialSeed);
  const [botMode, setBotMode] = useState(initialBot);
  const [resetNonce, setResetNonce] = useState(0);
  const [specName, setSpecName] = useState('');
  const [error, setError] = useState(null);

  const hostRef = useRef(null);
  const botRef = useRef(initialBot);
  botRef.current = botMode; // the game loop reads this without re-mounting

  useEffect(() => {
    // ---- spec: pre-built genre > prompt > default racing spec
    let spec;
    try {
      if (genre) {
        const entry = compileBattery().find((b) => b.key === genre);
        if (!entry) throw new Error(`unknown genre '${genre}'`);
        spec = entry.spec;
      } else {
        spec = prompt.trim() ? compileSpec(prompt, { seed }) : makeSpec();
      }
    } catch (e) {
      setError(String(e?.message || e));
      return undefined;
    }
    setError(null);
    setSpecName(spec.name);

    // ---- ENGINE SWAP POINT --------------------------------------------------
    // The page drives an EngineSource, not the sim directly. Today that is
    // LocalSimEngine (the deterministic dataset engine, in-browser). When the
    // world model finishes training, this line becomes
    //   const engine = new NeuralStreamEngine();
    // and the Three.js view/HUD below are replaced by drawing the streamed
    // frames (HUD already baked in by the model). Same actions, same loop.
    // See lib/engine/neuralStream.js for the protocol stub.
    const engine = new LocalSimEngine();
    engine.init(spec, seed);
    // -------------------------------------------------------------------------

    const host = hostRef.current;
    const width = () => host.clientWidth || window.innerWidth;
    const height = () => host.clientHeight || window.innerHeight;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width(), height());
    host.appendChild(renderer.domElement);

    const view = createView(engine.getWorld(), { width: width(), height: height() });
    view.camera.aspect = width() / height();
    view.camera.updateProjectionMatrix();
    let hud = createHud(spec, { width: width(), height: height() });

    // reflect the seed in the URL so the run is shareable/reproducible
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(seed));
    window.history.replaceState(null, '', url);

    // ---- keyboard: multi-hot held-key set, sampled once per action frame
    const held = { W: false, S: false, A: false, D: false, Space: false, LShiftKey: false, F: false };
    const onKeyDown = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const k = KEYMAP[e.code];
      if (k) {
        held[k] = true;
        e.preventDefault();
      }
      if (e.code === 'KeyB') setBotMode((m) => !m);
      if (e.code === 'KeyN') setSeed((s) => (s + 1) >>> 0);
      if (e.code === 'KeyR') setResetNonce((n) => n + 1);
    };
    const onKeyUp = (e) => {
      const k = KEYMAP[e.code];
      if (k) {
        held[k] = false;
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const onResize = () => {
      renderer.setSize(width(), height());
      view.camera.aspect = width() / height();
      view.camera.updateProjectionMatrix();
      // HUD layout is resolution-dependent; rebuild on resize
      hud.dispose();
      hud = createHud(spec, { width: width(), height: height() });
    };
    window.addEventListener('resize', onResize);

    // ---- fixed-timestep loop: sim at exactly 20 Hz, render at display rate
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      acc += dt;
      while (acc >= 1 / FPS) {
        acc -= 1 / FPS;
        engine.stepFrame(botRef.current ? null : { ...held });
      }
      const world = engine.getWorld();
      view.update(world, dt);
      renderer.render(view.scene, view.camera);
      hud.render(renderer, world); // engine HUD baked over the 3D frame
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', onResize);
      hud.dispose();
      view.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      engine.dispose();
    };
  }, [prompt, genre, seed, resetNonce]);

  return (
    <>
      <div className="play-canvas-host" ref={hostRef} />

      <div className="play-chrome">
        <div className="chrome-panel">
          <Link href="/" className="back-link">← PredictExpert</Link>
          <span className="spec-name">{specName || '…'}</span>
          <span className="spec-seed">seed {seed}</span>
        </div>

        <div className="chrome-panel chrome-right">
          <span className="controls-hint">WASD/arrows · Space handbrake · Shift boost · F fire</span>
          <button
            type="button"
            className={botMode ? 'chrome-btn active' : 'chrome-btn'}
            onClick={(e) => {
              setBotMode((m) => !m);
              e.currentTarget.blur();
            }}
          >
            Bot drives
          </button>
          <button
            type="button"
            className="chrome-btn"
            onClick={(e) => {
              setSeed((s) => (s + 1) >>> 0);
              e.currentTarget.blur();
            }}
          >
            New track
          </button>
          <span className="engine-badge">
            <span className="engine-dot" aria-hidden="true" />
            engine:
            <select value="local-sim" onChange={() => {}} aria-label="Engine source">
              <option value="local-sim">local sim</option>
              {/* NeuralStreamEngine — enabled once the world model ships */}
              <option value="neural" disabled>
                neural (training)
              </option>
            </select>
          </span>
        </div>
      </div>

      {error && <div className="play-loading">spec error: {error}</div>}
    </>
  );
}
