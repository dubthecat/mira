// Deterministic seeded PRNG (mulberry32). The sim must never touch Math.random
// or wall-clock time — every run of a given seed replays bit-identically.

export class Rng {
  constructor(seed) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 0x9e3779b9;
    this._spare = null; // cached Box-Muller value
  }

  // uniform float in [0, 1)
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a, b) {
    return a + (b - a) * this.next();
  }

  // integer in [a, b] inclusive
  int(a, b) {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  pick(arr) {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }

  bool(p = 0.5) {
    return this.next() < p;
  }

  // standard normal via Box-Muller
  gauss() {
    if (this._spare !== null) {
      const v = this._spare;
      this._spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    do {
      u = this.next();
    } while (u <= 1e-12);
    v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this._spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  // derive an independent child stream (e.g. track vs bot vs scenery)
  fork(tag) {
    let h = 2166136261 ^ this.s;
    for (let i = 0; i < tag.length; i++) {
      h = Math.imul(h ^ tag.charCodeAt(i), 16777619);
    }
    return new Rng(h >>> 0);
  }
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}
