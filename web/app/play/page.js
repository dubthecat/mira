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

import { Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';

const PlayGame = dynamic(() => import('../../components/PlayGame.js'), {
  ssr: false,
  loading: () => <div className="play-loading">booting engine…</div>,
});

function PlayInner() {
  const params = useSearchParams();
  const prompt = params.get('prompt') || '';
  const genre = params.get('genre') || '';
  const seedParam = parseInt(params.get('seed') || '1', 10);
  const seed = (Number.isFinite(seedParam) ? seedParam : 1) >>> 0;
  const bot = params.get('bot') === '1';
  return <PlayGame prompt={prompt} genre={genre} initialSeed={seed} initialBot={bot} />;
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
