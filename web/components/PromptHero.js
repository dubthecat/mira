'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// The hero: one prompt box, one button. Submit -> /play?prompt=<encoded>.
export default function PromptHero() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');

  function submit(e) {
    e.preventDefault();
    const p = prompt.trim();
    router.push(p ? `/play?prompt=${encodeURIComponent(p)}` : '/play');
  }

  return (
    <form className="prompt-form" onSubmit={submit}>
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
    </form>
  );
}
