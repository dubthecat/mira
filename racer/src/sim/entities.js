// Entity system: monsters, projectiles, pickups — all spec-driven, all
// deterministic. Monsters are spawned at seeded track-relative positions and
// step on the same fixed substep as the car, so (seed, spec) replays exactly.
//
// Design note for world-model data: every entity behavior is *reactive to the
// player in visible ways* (chasers turn toward you, turrets track and lead
// their shots, patrollers cross the road on fixed clocks) — the model can
// only learn dynamics it can see.

import { wrapAngle, clamp } from './rng.js';
import { MONSTER_TYPES, WEAPON_KINDS } from '../spec/schema.js';

const MONSTER_RESPAWN_FRAMES = 300; // 15 s
const PICKUP_COOLDOWN = 8; // seconds

export class EntitySystem {
  constructor(spec, track, seedRng) {
    this.spec = spec;
    this.track = track;
    this.rng = seedRng.fork('entities');
    this.monsters = [];
    this.projectiles = []; // {x,y,vx,vy,ttl,hostile,damage,hintIdx,alive}
    this.pickups = [];
    this._spawnMonsters();
    this._spawnPickups();
  }

  _spawnMonsters() {
    const t = this.track;
    let id = 0;
    for (const group of this.spec.entities.monsters) {
      const base = MONSTER_TYPES[group.type];
      for (let i = 0; i < group.count; i++) {
        const cfg = {
          ...base,
          speed: base.speed * (group.speedScale || 1),
          size: base.size * (group.scale || 1),
          color: group.color !== undefined ? group.color : base.color,
        };
        // distribute along the track, biased away from the start line
        const s = this.rng.range(0.08, 0.98) * t.length;
        const q = t.sampleAt(s);
        const nx = -Math.sin(q.theta);
        const ny = Math.cos(q.theta);
        let lat;
        if (group.type === 'patroller') {
          lat = 0; // lives on the road, crossing it
        } else if (group.type === 'turret') {
          lat = (this.rng.bool() ? 1 : -1) * (q.halfWidth + this.rng.range(4, 10));
        } else {
          lat = (this.rng.bool() ? 1 : -1) * (q.halfWidth + this.rng.range(6, 22));
        }
        const m = {
          id: id++,
          type: group.type,
          cfg,
          s,
          lairX: q.x + nx * lat,
          lairY: q.y + ny * lat,
          x: 0,
          y: 0,
          heading: this.rng.range(0, 2 * Math.PI),
          phase: this.rng.range(0, 2 * Math.PI),
          health: cfg.health,
          alive: true,
          respawnAt: -1,
          hitFlash: 0,
          fireCooldown: this.rng.range(0.5, 2.0), // desync turret volleys
          // patroller endpoints: across the road at its s
          px0: q.x + nx * (q.halfWidth - 1.5),
          py0: q.y + ny * (q.halfWidth - 1.5),
          px1: q.x - nx * (q.halfWidth - 1.5),
          py1: q.y - ny * (q.halfWidth - 1.5),
        };
        m.x = m.lairX;
        m.y = m.lairY;
        this.monsters.push(m);
      }
    }
  }

  _spawnPickups() {
    const t = this.track;
    for (const group of this.spec.entities.pickups) {
      for (let i = 0; i < group.count; i++) {
        const s = this.rng.range(0.05, 0.95) * t.length;
        const q = t.sampleAt(s);
        const lat = this.rng.range(-1, 1) * Math.max(0, q.halfWidth - 3);
        this.pickups.push({
          kind: group.kind,
          x: q.x - Math.sin(q.theta) * lat,
          y: q.y + Math.cos(q.theta) * lat,
          cooldown: 0,
        });
      }
    }
  }

  fireFromCar(car) {
    const w = WEAPON_KINDS[this.spec.weapon.kind];
    const n = w.pellets;
    for (let i = 0; i < n; i++) {
      const off = n === 1 ? 0 : w.spread * (i / (n - 1) - 0.5) * 2;
      const a = car.heading + off;
      this.projectiles.push({
        x: car.x + Math.cos(car.heading) * 2.4,
        y: car.y + Math.sin(car.heading) * 2.4,
        vx: Math.cos(a) * w.projSpeed + car.vx * 0.5,
        vy: Math.sin(a) * w.projSpeed + car.vy * 0.5,
        ttl: 2.0,
        hostile: false,
        damage: w.damage,
        hintIdx: car.hintIdx,
        alive: true,
      });
    }
  }

  // One physics substep. Returns events; mutates world-owned car state via
  // the returned damage list (world applies health/invuln rules).
  step(car, frame, dt) {
    const events = [];
    let damageToCar = 0;

    for (const m of this.monsters) {
      if (!m.alive) {
        if (m.respawnAt >= 0 && frame >= m.respawnAt) {
          m.alive = true;
          m.health = m.cfg.health;
          m.x = m.lairX;
          m.y = m.lairY;
          m.respawnAt = -1;
        }
        continue;
      }
      if (m.hitFlash > 0) m.hitFlash--;

      const dxc = car.x - m.x;
      const dyc = car.y - m.y;
      const distCar = Math.hypot(dxc, dyc);

      if (m.type === 'chaser') {
        const aggro = distCar < m.cfg.aggroRadius;
        let targetX;
        let targetY;
        let speed;
        if (aggro) {
          targetX = car.x;
          targetY = car.y;
          speed = m.cfg.speed;
        } else {
          // amble around the lair on a deterministic clock
          const tPhase = frame * dt * 0.4 + m.phase;
          targetX = m.lairX + Math.cos(tPhase) * 8;
          targetY = m.lairY + Math.sin(tPhase * 0.8) * 8;
          speed = m.cfg.speed * 0.3;
        }
        const want = Math.atan2(targetY - m.y, targetX - m.x);
        m.heading = wrapAngle(m.heading + clamp(wrapAngle(want - m.heading), -3.2 * dt, 3.2 * dt));
        m.x += Math.cos(m.heading) * speed * dt;
        m.y += Math.sin(m.heading) * speed * dt;
      } else if (m.type === 'patroller') {
        // triangle-wave sweep between the two road edges
        const period = Math.hypot(m.px1 - m.px0, m.py1 - m.py0) / m.cfg.speed;
        const ph = ((frame * dt + m.phase) / (2 * period)) % 1;
        const tt = ph < 0.5 ? ph * 2 : 2 - ph * 2;
        const nxOld = m.x;
        const nyOld = m.y;
        m.x = m.px0 + (m.px1 - m.px0) * tt;
        m.y = m.py0 + (m.py1 - m.py0) * tt;
        m.heading = Math.atan2(m.y - nyOld, m.x - nxOld);
      } else if (m.type === 'turret') {
        m.heading = Math.atan2(dyc, dxc); // barrel tracks the car
        m.fireCooldown -= dt;
        if (distCar < m.cfg.aggroRadius && m.fireCooldown <= 0) {
          m.fireCooldown = m.cfg.fireEvery;
          // lead the target (deterministic, imperfect on purpose)
          const tLead = (distCar / m.cfg.projSpeed) * 0.7;
          const ax = car.x + car.vx * tLead - m.x;
          const ay = car.y + car.vy * tLead - m.y;
          const a = Math.atan2(ay, ax);
          this.projectiles.push({
            x: m.x + Math.cos(a) * (m.cfg.size + 0.5),
            y: m.y + Math.sin(a) * (m.cfg.size + 0.5),
            vx: Math.cos(a) * m.cfg.projSpeed,
            vy: Math.sin(a) * m.cfg.projSpeed,
            ttl: 4.0,
            hostile: true,
            damage: m.cfg.damage,
            hintIdx: -1,
            alive: true,
          });
          events.push({ name: 'TurretFired', data: { id: m.id } });
        }
      }

      // contact damage (car-side rules applied by world)
      if (distCar < m.cfg.size + 1.6 && m.type !== 'turret') {
        damageToCar += m.cfg.damage;
        // shove the monster back so contact doesn't re-trigger every substep
        const push = m.cfg.size + 3.5;
        m.x -= (dxc / Math.max(distCar, 0.1)) * push;
        m.y -= (dyc / Math.max(distCar, 0.1)) * push;
        events.push({ name: 'MonsterContact', data: { id: m.id, type: m.type } });
      }
    }

    // projectiles
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.ttl -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.ttl <= 0) {
        p.alive = false;
        continue;
      }
      if (p.hostile) {
        const d = Math.hypot(car.x - p.x, car.y - p.y);
        if (d < 1.8) {
          damageToCar += p.damage;
          p.alive = false;
          events.push({ name: 'CarShot', data: {} });
          continue;
        }
      } else {
        for (const m of this.monsters) {
          if (!m.alive) continue;
          if (Math.hypot(m.x - p.x, m.y - p.y) < m.cfg.size + 0.6) {
            p.alive = false;
            m.health -= p.damage;
            m.hitFlash = 6;
            if (m.health <= 0) {
              m.alive = false;
              m.respawnAt = frame + MONSTER_RESPAWN_FRAMES;
              events.push({ name: 'MonsterKilled', data: { id: m.id, type: m.type } });
            } else {
              events.push({ name: 'MonsterHit', data: { id: m.id } });
            }
            break;
          }
        }
      }
    }
    // compact dead projectiles occasionally (deterministic: by count)
    if (this.projectiles.length > 128) {
      this.projectiles = this.projectiles.filter((p) => p.alive);
    }

    // pickups tick (collection handled by world, which knows health/ammo)
    for (const pk of this.pickups) {
      if (pk.cooldown > 0) pk.cooldown = Math.max(0, pk.cooldown - dt);
    }

    return { events, damageToCar };
  }

  tryCollect(car, kind, roomFor) {
    let collected = 0;
    if (!roomFor) return collected;
    for (const pk of this.pickups) {
      if (pk.kind !== kind || pk.cooldown > 0) continue;
      if (Math.hypot(car.x - pk.x, car.y - pk.y) < 2.4) {
        pk.cooldown = PICKUP_COOLDOWN;
        collected++;
      }
    }
    return collected;
  }
}
