import PromptHero from '../components/PromptHero.js';
import PipelineDiagram from '../components/PipelineDiagram.js';
import LoopDiagram from '../components/LoopDiagram.js';
import { StatTiles, FramesChart } from '../components/EngineStats.js';

export default function Landing() {
  return (
    <main>
      <div className="container">
        <section className="hero">
          <div className="hero-kicker">MIRA · neural game engine</div>
          <h1>Type a game. Play it.</h1>
          <p className="hero-sub">
            Prompts compile into playable games — today on the deterministic engine
            that generates our training data, soon rendered frame-by-frame by a
            diffusion world model.
          </p>
          <PromptHero />
          <p className="hero-hint">
            Press <code>Enter</code> to build · empty prompt gives you the classic circuit
          </p>
        </section>

        <section className="section">
          <h2>How it works</h2>
          <p className="section-copy">
            A prompt compiles deterministically into a <strong>GameSpec</strong> — biome,
            monsters, weapons, handling, HUD. That spec drives a procedural Three.js game
            which plays itself and records <span className="mono">(frames, actions, state)</span> at
            20 fps; a RAE codec built on DINOv3 features defines the latent space where a
            diffusion transformer learns to render the game from player actions.
          </p>
          <PipelineDiagram />
          <p className="footnote">
            Inspired by MIRA (Kyutai / General Intuition&apos;s Rocket League world model) and
            GameNGen-style frame-by-frame diffusion.
          </p>
        </section>

        <section className="section">
          <h2>The interactive loop</h2>
          <p className="section-copy">
            At play time the loop is closed: seven keys in, one frame out, twenty times a
            second. The same loop drives the browser sim today and the model server tomorrow.
          </p>
          <LoopDiagram />
          <p className="caption">
            The model learns UI, physics, and rendering as one function — there is no
            engine underneath the trained game.
          </p>
        </section>

        <section className="section">
          <h2>Battle-tested engine</h2>
          <p className="section-copy">
            The sim is not a demo — it is the dataset factory. Deterministic fixed-timestep
            physics, per-spec action vocabularies, and a HUD bound to live engine variables
            make every recorded frame reproducible from <span className="mono">(seed, spec, actions)</span>.
          </p>
          <StatTiles />
          <FramesChart />
        </section>
      </div>

      <footer className="footer">
        <div className="container">
          MIRA — prompt → game. The local sim runs in your browser; the world model is in
          its training loop.
        </div>
      </footer>
    </main>
  );
}
