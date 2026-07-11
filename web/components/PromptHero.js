'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
// battery keys only (no compilation) — "Surprise me" picks a random genre
import { BATTERY } from '../../racer/src/spec/battery.js';

// tiny example prompts: click to fill the box, Enter to build
const EXAMPLES = ['fifa soccer at night', 'doom arena, waves of 8', 'open world relic quest'];

// The hero: one prompt box, one button. Submit -> /play?prompt=<encoded>.
export default function PromptHero() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');

  function submit(e) {
    e.preventDefault();
    const p = prompt.trim();
    router.push(p ? `/play?prompt=${encodeURIComponent(p)}` : '/play');
  }

  // random pre-built genre from the battery (UI-only randomness, Math.random
  // is fine here — determinism matters inside the engine, not the lobby)
  function surprise() {
    const pick = BATTERY[Math.floor(Math.random() * BATTERY.length)];
    router.push(`/play?genre=${encodeURIComponent(pick.key)}`);
  }

  return (
    <form className="prompt-form" onSubmit={submit}>
      <div className="prompt-row">
        <input
          className="prompt-input"
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="a night neon drift race through monsters with a shotgun…"
          aria-label="Game prompt"
          autoFocus
        />
        <button className="btn-primary" type="submit">
          Build a game
        </button>
        <button className="btn-ghost" type="button" onClick={surprise} title="Play a random pre-built genre">
          Surprise me
        </button>
      </div>
      <div className="prompt-examples" aria-label="Example prompts">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="prompt-example" onClick={() => setPrompt(ex)}>
            {ex}
          </button>
        ))}
      </div>
    </form>
  );
}
