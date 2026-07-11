'use client';

// /play — client-only game page. The engine's renderer touches the DOM and
// WebGL, so the game component is loaded with ssr:false; useSearchParams
// requires the Suspense boundary.
//
// URL params: ?prompt=<text>  compile a GameSpec from the prompt
//             ?genre=<key>    play a pre-built game from the test battery
//                             (takes precedence over prompt)
//             ?seed=<n>       procedural seed (default 1)
//             ?bot=1          start with the bot driving

import { Suspense, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { BATTERY } from '../../../racer/src/spec/battery.js';
import { BLURBS } from '../../lib/genres.js';

const PlayGame = dynamic(() => import('../../components/PlayGame.js'), {
  ssr: false,
  loading: () => <div className="play-loading">booting engine…</div>,
});

// Neural play: /play?ws=<websocket-url> streams frames from the world model
// running on a GPU pod instead of simulating locally (see racer/serve/).
const NeuralPlay = dynamic(() => import('../../components/NeuralPlay.js'), {
  ssr: false,
  loading: () => <div className="play-loading">connecting to world model…</div>,
});

// One-time hint for pre-built genres: the genre's blurb fades in, holds, and
// fades out (all CSS animation); a single setTimeout then unmounts it.
function GenreToast({ genre }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGone(true), 5600); // just past the 5.4s animation
    return () => clearTimeout(t);
  }, []);
  const blurb = useMemo(() => {
    const entry = BATTERY.find((b) => b.key === genre);
    if (!entry) return '';
    return BLURBS[genre] || entry.prompt;
  }, [genre]);
  if (gone || !blurb) return null;
  return (
    <div className="genre-toast" role="status">
      <span className="genre-toast-key">{genre}</span>
      <span>{blurb}</span>
    </div>
  );
}

function PlayInner() {
  const params = useSearchParams();
  const prompt = params.get('prompt') || '';
  const genre = params.get('genre') || '';
  const seedParam = parseInt(params.get('seed') || '1', 10);
  const seed = (Number.isFinite(seedParam) ? seedParam : 1) >>> 0;
  const bot = params.get('bot') === '1';
  const ws = params.get('ws') || '';
  if (ws) {
    return <NeuralPlay wsUrl={ws} prompt={prompt} genre={genre} seed={seed} />;
  }
  return (
    <>
      <PlayGame prompt={prompt} genre={genre} initialSeed={seed} initialBot={bot} />
      {genre && <GenreToast genre={genre} />}
    </>
  );
}

export default function PlayPage() {
  return (
    <div className="play-root">
      <Suspense fallback={<div className="play-loading">booting engine…</div>}>
        <PlayInner />
      </Suspense>
    </div>
  );
}
