// NeuralStreamEngine — EngineSource backed by the trained latent diffusion
// world model, served by racer/serve/serve_wm.py over one WebSocket per
// session. There is no engine underneath: the model generates the next frame
// (HUD baked into the pixels) conditioned on the player's held keys.
//
// Protocol (full spec: racer/serve/PROTOCOL.md):
//   -> { type: 'hello', keys: [...] }            once, after connect
//   <- { type: 'ready', fps, keyOrder, width, height, ... }
//   -> { type: 'act', k: [0,1,0,...] }           one multi-hot per 20 Hz tick
//   <- { type: 'frame', jpg: <base64>, i, gen_ms }
//   -> { type: 'reset' }  ->  fresh 'ready', frame index restarts at 0
//
// Same EngineSource surface as LocalSimEngine (init / stepFrame / getWorld /
// dispose) with two differences the page must handle (see ./README.md):
//   * init() is async (returns a Promise — it opens the socket + handshake);
//   * getWorld() returns null — the frame IS the state. Draw frames via
//     onFrame(cb) or getFrameBlobUrl() onto an <img>/<canvas> instead of
//     running the Three.js view.
//
// DOM-free: uses globalThis.WebSocket (browsers, node >= 22) and atob; blob
// URLs are only created where URL.createObjectURL exists (browser), raw JPEG
// bytes are always available on the frame record. Verified under node via
// neuralStream.test.mjs against the fake server.

import { actionKeysFor } from '../../../racer/src/spec/schema.js';

const canBlob =
  typeof Blob !== 'undefined' &&
  typeof URL !== 'undefined' &&
  typeof URL.createObjectURL === 'function';

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class NeuralStreamEngine {
  // wsUrl: the serve_wm.py endpoint, e.g. ws://<pod-ip>:<mapped-port>
  // (deploy_serve.py prints it; typically wired via NEXT_PUBLIC_NEURAL_WS_URL).
  constructor(wsUrl) {
    if (!wsUrl) throw new Error('NeuralStreamEngine: wsUrl required');
    this.wsUrl = wsUrl;
    this.state = 'idle'; // idle | connecting | ready | reconnecting | error | disposed
    this.ws = null;
    this.serverInfo = null; // the last 'ready' message (fps, keyOrder, width, height, mode)
    this.keys = null; // client key names (from the spec), for the hello
    this.lastFrame = null; // { i, n, bytes, blobUrl, genMs, width, height }
    this.frameCount = 0; // frames received across reconnects (server i restarts)
    this.actsSent = 0;
    this.lastError = null;
    this._onFrame = null;
    this._reconnected = false; // one reconnect, then error state
    this._pendingReady = []; // resolvers waiting for the next 'ready'
  }

  // ---- EngineSource interface --------------------------------------------

  // Opens the socket and performs the hello/ready handshake. The action
  // vocabulary comes from the spec (actionKeysFor); the SERVER's keyOrder from
  // 'ready' is authoritative — acts are multi-hot in that order, spec keys the
  // model doesn't know are dropped server-side.
  async init(spec, seed) {
    if (this.state === 'disposed') throw new Error('NeuralStreamEngine: disposed');
    this.keys = actionKeysFor(spec);
    this.seed = seed >>> 0;
    return await this._connect(); // resolves with the server's 'ready' message
  }

  // Advance one 20 Hz action frame. keysOrNull: {W,S,A,D,Space,LShiftKey,F}
  // multi-hot object, or null (neural mode has no bot — null sends no keys
  // held). Non-blocking: sends the act and returns the latest status; frames
  // arrive asynchronously via onFrame / getFrameBlobUrl.
  stepFrame(keysOrNull) {
    if (this.state !== 'ready' || !this.ws || this.ws.readyState !== 1 /* OPEN */) {
      return this._status();
    }
    const order = this.serverInfo.keyOrder;
    const held = keysOrNull || {};
    const k = order.map((name) => (held[name] ? 1 : 0));
    this.ws.send(JSON.stringify({ type: 'act', k }));
    this.actsSent += 1;
    return this._status();
  }

  // No local world state — the frame IS the state.
  getWorld() {
    return null;
  }

  dispose() {
    this.state = 'disposed';
    if (this.lastFrame && this.lastFrame.blobUrl) URL.revokeObjectURL(this.lastFrame.blobUrl);
    this.lastFrame = null;
    if (this.ws) {
      try {
        this.ws.close(1000, 'dispose');
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
  }

  // ---- frame access -------------------------------------------------------

  // cb(frame) per received frame: { i, n, bytes: Uint8Array (JPEG), blobUrl
  // (browser only, else null), genMs, width, height }. blobUrl of the PREVIOUS
  // frame is revoked when the next arrives — draw or copy promptly.
  onFrame(cb) {
    this._onFrame = cb;
  }

  // Latest frame's blob URL (browser), for <img src> / drawImage. Null before
  // the first frame or under node.
  getFrameBlobUrl() {
    return this.lastFrame ? this.lastFrame.blobUrl : null;
  }

  // Re-prime the model (new episode from the same context). Resolves on the
  // server's fresh 'ready'; frame indices restart at 0.
  reset() {
    if (this.state !== 'ready' || !this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error(`NeuralStreamEngine: not ready (${this.state})`));
    }
    this.ws.send(JSON.stringify({ type: 'reset' }));
    return new Promise((resolve) => this._pendingReady.push(resolve));
  }

  // ---- internals ----------------------------------------------------------

  _status() {
    return {
      state: this.state,
      frame: this.lastFrame,
      frames: this.frameCount,
      actsSent: this.actsSent,
      inFlight: Math.max(0, this.actsSent - (this.frameCount - (this._framesAtReady || 0))),
      fps: this.serverInfo ? this.serverInfo.fps : null,
      error: this.lastError,
    };
  }

  _connect() {
    this.state = this.state === 'ready' ? 'reconnecting' : 'connecting';
    return new Promise((resolve, reject) => {
      let settled = false;
      const WS = globalThis.WebSocket;
      if (!WS) {
        this.state = 'error';
        reject(new Error('NeuralStreamEngine: no WebSocket implementation available'));
        return;
      }
      const ws = new WS(this.wsUrl);
      this.ws = ws;

      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === 'ready') {
          this.serverInfo = msg;
          this.state = 'ready';
          this.actsSent = 0; // per-session counters (reset / reconnect start a new session)
          this._framesAtReady = this.frameCount;
          const waiters = this._pendingReady.splice(0);
          waiters.forEach((fn) => fn(msg));
          if (!settled) {
            settled = true;
            resolve(msg);
          }
        } else if (msg.type === 'frame') {
          this._handleFrame(msg);
        } else if (msg.type === 'error') {
          this.lastError = `${msg.code}: ${msg.message}`;
          if (!settled) {
            settled = true;
            this.state = 'error';
            reject(new Error(`NeuralStreamEngine: server refused — ${this.lastError}`));
          }
        }
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'hello', keys: this.keys, seed: this.seed }));
      };

      ws.onerror = () => {
        // ws fires 'close' right after; handle there
      };

      ws.onclose = (ev) => {
        if (this.state === 'disposed') return;
        if (!settled) {
          settled = true;
          this.state = 'error';
          this.lastError = `connect failed (code ${ev.code})`;
          reject(new Error(`NeuralStreamEngine: ${this.lastError}`));
          return;
        }
        // Unexpected close after a working session: reconnect ONCE (fresh
        // session — the server re-primes from the same context), then give up.
        // Short delay so a transient blip has settled before the one attempt.
        if (!this._reconnected) {
          this._reconnected = true;
          this.state = 'reconnecting';
          setTimeout(() => {
            if (this.state === 'disposed') return;
            this._connect().catch(() => {
              this.state = 'error';
            });
          }, 1000);
        } else {
          this.state = 'error';
          this.lastError = this.lastError || `connection lost (code ${ev.code})`;
        }
      };
    });
  }

  _handleFrame(msg) {
    const bytes = b64ToBytes(msg.jpg);
    const prevUrl = this.lastFrame ? this.lastFrame.blobUrl : null;
    let blobUrl = null;
    if (canBlob) {
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    }
    this.frameCount += 1;
    this.lastFrame = {
      i: msg.i, // server frame index (restarts on reset/reconnect)
      n: this.frameCount, // monotonic engine-side count
      bytes,
      blobUrl,
      genMs: msg.gen_ms ?? null,
      width: this.serverInfo ? this.serverInfo.width : null,
      height: this.serverInfo ? this.serverInfo.height : null,
    };
    if (this._onFrame) this._onFrame(this.lastFrame);
    if (prevUrl) URL.revokeObjectURL(prevUrl);
  }
}
