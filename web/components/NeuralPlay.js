'use client';

// Neural play: the game runs INSIDE the trained world model on a GPU pod.
// This component is a thin terminal — it sends the player's 7-key multi-hot
// at 20 Hz over WebSocket and displays the JPEG frames the model streams
// back (HUD already baked in by the model). Selected via /play?ws=<url>.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { NeuralStreamEngine } from '../lib/engine/neuralStream.js';
import { compileSpec } from '../../racer/src/spec/compile.js';
import { makeSpec } from '../../racer/src/spec/schema.js';

const KEYMAP = {
  KeyW: 'W', ArrowUp: 'W',
  KeyS: 'S', ArrowDown: 'S',
  KeyA: 'A', ArrowLeft: 'A',
  KeyD: 'D', ArrowRight: 'D',
  Space: 'Space',
  ShiftLeft: 'LShiftKey', ShiftRight: 'LShiftKey',
  KeyF: 'F',
};

export default function NeuralPlay({ wsUrl, prompt, genre, seed }) {
  const imgRef = useRef(null);
  const [status, setStatus] = useState('connecting');
  const [stats, setStats] = useState({ fps: 0, frames: 0 });

  useEffect(() => {
    let engine;
    let disposed = false;
    const held = { W: false, S: false, A: false, D: false, Space: false, LShiftKey: false, F: false };

    const down = (e) => {
      const k = KEYMAP[e.code];
      if (k) {
        held[k] = true;
        e.preventDefault();
      }
    };
    const up = (e) => {
      const k = KEYMAP[e.code];
      if (k) {
        held[k] = false;
        e.preventDefault();
      }
    };
    addEventListener('keydown', down);
    addEventListener('keyup', up);

    let actTimer = null;
    let frames = 0;
    let windowStart = performance.now();

    (async () => {
      try {
        const spec = prompt?.trim() ? compileSpec(prompt, { seed }) : makeSpec();
        engine = new NeuralStreamEngine(wsUrl);
        engine.onFrame((blobUrl) => {
          if (disposed || !imgRef.current) return;
          const prev = imgRef.current.src;
          imgRef.current.src = blobUrl;
          if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
          frames++;
          const now = performance.now();
          if (now - windowStart > 1000) {
            setStats({ fps: Math.round((frames * 1000) / (now - windowStart)), frames });
            windowStart = now;
            frames = 0;
          }
        });
        await engine.init(spec, seed);
        if (disposed) return;
        setStatus('live');
        actTimer = setInterval(() => {
          try {
            engine.stepFrame({ ...held });
          } catch {
            /* socket closed; error state below */
          }
        }, 50); // 20 Hz
      } catch (e) {
        if (!disposed) setStatus(`error: ${e?.message || e}`);
      }
    })();

    return () => {
      disposed = true;
      if (actTimer) clearInterval(actTimer);
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      engine?.dispose?.();
    };
  }, [wsUrl, prompt, genre, seed]);

  return (
    <div className="neural-root">
      <img ref={imgRef} alt="neural game stream" className="neural-frame" />
      <div className="chrome chrome-tl">
        <Link href="/" className="back-link">← PredictExpert</Link>
        <span className="chrome-spec">neural stream</span>
      </div>
      <div className="chrome chrome-tr">
        <span className={`engine-dot ${status === 'live' ? 'on' : ''}`} />
        <span>engine: world model{status === 'live' ? ` · ${stats.fps} fps` : ''}</span>
        {status !== 'live' && <span className="chrome-status">{status}</span>}
      </div>
      {status.startsWith('error') && (
        <div className="neural-error">
          <p>{status}</p>
          <p>
            The model server may be offline. <Link href="/play">Play on the local sim engine instead →</Link>
          </p>
        </div>
      )}
    </div>
  );
}
