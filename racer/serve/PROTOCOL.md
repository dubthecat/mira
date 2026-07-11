# NEURAL PLAY WebSocket protocol (serve_wm.py <-> NeuralStreamEngine)

One WebSocket connection = one game session. All messages are JSON text frames;
the frame image travels as base64 JPEG inside the JSON (simple > clever at
~12-25 KB/frame; a binary/H264 path can come later without breaking `hello`).
The **client is the clock**: it sends one `act` per 20 Hz tick, the server
generates and pushes frames. Protocol version: 1 (implicit; additive changes
only — unknown fields must be ignored by both sides).

## Handshake

The client's FIRST message must be a `hello` (within 15 s, or the server
closes 1002):

```json
{ "type": "hello", "keys": ["W","S","A","D","Space","LShiftKey","F"] }
```

- `keys` — the action key names the client can produce, i.e.
  `actionKeysFor(spec)` from `racer/src/spec/schema.js`. Informational: the
  server logs names outside its vocabulary and ignores them.
- extra fields (`seed`, `spec`, ...) are accepted and currently ignored — the
  server is primed from a fixed context clip chosen at launch.

Server reply:

```json
{
  "type": "ready",
  "fps": 20,                  // nominal rate the client should send acts at
  "keyOrder": ["W","S","A","D","Space","LShiftKey"],  // AUTHORITATIVE
  "width": 512, "height": 288,
  "mode": "model",            // or "fake" (procedural frames, no model)
  "actsPerStep": 2,           // acts consumed per generation step (= action_temporal_downsampling)
  "framesPerStep": 2,         // frames produced per generation step (= codec temporal_downsampling)
  "session": "a1b2c3"
}
```

`keyOrder` is the **model's** vocabulary in checkpoint column order (real mode:
`config.actions.valid_keys`; fake mode: the `--keys` arg). The client MUST
build its multi-hot in this order. Spec keys the model doesn't know (e.g. `F`
against a 6-key checkpoint) are simply never sent; vocab keys the client
doesn't use stay 0.

If the server is at `--max-sessions` capacity it sends (before reading any
hello) and closes with WS code 1013:

```json
{ "type": "error", "code": "busy", "message": "server full (2 sessions)" }
```

Other error codes: `bad_hello` (first message wasn't a valid hello; close
1002), `internal` (generation failed; close 1011).

## Steady state

Client, at 20 Hz (one message per action frame — the keys held during that
frame, multi-hot int array of `len(keyOrder)`):

```json
{ "type": "act", "k": [1,0,0,1,0,0] }
```

Server, per generated frame:

```json
{ "type": "frame", "jpg": "<base64 JPEG>", "i": 0, "gen_ms": 41.3 }
```

- `i` — server frame index, starts at 0, restarts on `reset` (and on a
  reconnect, which is a brand-new session).
- `gen_ms` — server-side generation time attributed to this frame (denoise +
  decode + JPEG, divided over the frames of the step). Diagnostic.

### Timing and backpressure

The model consumes `actsPerStep` (2) acts per latent step and emits
`framesPerStep` (2) frames, so throughput is one frame per act, delivered in
bursts of 2. In fake mode both are 1 (strict 1:1, used by the test clients).

If generation is slower than real time the server does NOT queue unboundedly:
pending acts are coalesced (oldest dropped beyond a bound of 8 x actsPerStep),
so the stream degrades to whatever frame rate the GPU manages with bounded
latency. The client interpolates nothing — it just displays frames as they
arrive. Real-time play therefore depends on the GPU (see README cost/latency
notes).

## Reset

```json
{ "type": "reset" }
```

Server re-primes the model from the launch context (same context clip — the
neural analogue of "same seed"), clears in-flight state and replies with a
fresh `ready`; the next frame is `i = 0`. Frames generated before the reset
landed may still arrive in between — clients should drop frames received after
sending `reset` until the new `ready`.

A repeated `hello` on a live session is answered with the current `ready`
(idempotent; useful as an application-level ping).

## Liveness

- WebSocket protocol pings every 20 s (handled by libraries automatically);
  unanswered for 20 s -> the connection is considered dead.
- Per-session idle timeout: no `act` for `--idle-timeout` s (default 120)
  -> server closes with code 4000, reason "idle timeout".
- Whole-server idle exit: `--idle-exit` N > 0 (pods use 900) -> after N s with
  zero sessions the server process exits 0; the pod bootstrap's EXIT trap then
  terminates the RunPod pod so idle GPU time is bounded.

## Client obligations (what NeuralStreamEngine implements)

1. Connect, send `hello`, wait for `ready`, adopt `keyOrder`.
2. Send one `act` per 20 Hz tick with the currently held keys.
3. Display `frame` messages as they arrive (base64 -> blob URL -> canvas/img).
4. On unexpected close: reconnect ONCE (fresh hello; the server re-primes),
   then surface an error state. `dispose()` closes with code 1000.
