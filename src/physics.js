// Ball flight simulation: drag + lift + curve (slice/hook) + wind, then
// bounce and roll against the procedural terrain.

import * as THREE from 'three';
import { clamp } from './rng.js';

export const BALL_R = 0.11; // oversized for readability

const G = 9.81;
const DRAG_K = 0.0026; // quadratic drag coefficient (1/m)
const SUBSTEP = 1 / 240;

function liftK(loftDeg) {
  // more loft -> more backspin -> more lift
  return 0.0009 + (loftDeg / 60) * 0.0013;
}

// Restitution / friction / rolling decel per surface. Grass grabs: the
// rough kills a ball almost immediately, fairway checks it up quickly,
// the green lets it run out a little.
const SURF = {
  green: { e: 0.3, f: 0.26, roll: 2.7 },
  fringe: { e: 0.27, f: 0.32, roll: 3.8 },
  tee: { e: 0.3, f: 0.32, roll: 4.2 },
  fairway: { e: 0.3, f: 0.32, roll: 4.2 },
  rough: { e: 0.14, f: 0.58, roll: 10.0 },
  sand: { e: 0.02, f: 0.9, roll: 15.0 },
  water: { e: 0, f: 1, roll: 0 },
};

export class BallFlight {
  /**
   * @param {object} o
   * @param {THREE.Vector3} o.pos start position (ball center)
   * @param {THREE.Vector3} o.dir horizontal unit aim direction
   * @param {number} o.v0 launch speed m/s
   * @param {number} o.loftDeg launch angle
   * @param {number} o.curveDeg signed slice(+)/hook(-) strength
   * @param {THREE.Vector3} o.wind horizontal wind vector m/s
   * @param {object} o.hole hole with heightAt/surfaceAt/waterLevel
   */
  constructor(o) {
    this.pos = o.pos.clone();
    const loft = (o.loftDeg * Math.PI) / 180;
    this.vel = new THREE.Vector3(
      o.dir.x * Math.cos(loft) * o.v0,
      Math.sin(loft) * o.v0,
      o.dir.z * Math.cos(loft) * o.v0
    );
    this.curve = clamp(o.curveDeg, -14, 14);
    this.wind = o.wind ? o.wind.clone() : new THREE.Vector3();
    this.hole = o.hole;
    this.liftK = liftK(o.loftDeg);
    this.rolling = false;
    this.done = false;
    this.age = 0;
    this.apex = this.pos.y;
    this.events = [];
    this._vr = new THREE.Vector3();
    this._acc = new THREE.Vector3();
  }

  // Advance by frame dt; returns array of events fired this frame:
  // {type:'bounce'|'splash'|'rest', pos, speed}
  // Integration is quantized to fixed substeps via an accumulator, so a
  // flight is bit-identical no matter how dt is sliced — which lets the
  // game pre-simulate a shot's outcome the moment it is struck.
  step(dt) {
    const out = [];
    if (this.done) return out;
    this._tacc = (this._tacc || 0) + dt;
    while (this._tacc >= SUBSTEP - 1e-9 && !this.done) {
      this._sub(SUBSTEP, out);
      this._tacc -= SUBSTEP;
      this.age += SUBSTEP;
    }
    if (this.age > 22 && !this.done) {
      this.done = true;
      out.push({ type: 'rest', pos: this.pos.clone(), speed: 0 });
    }
    return out;
  }

  _sub(h, out) {
    const hole = this.hole;
    const p = this.pos;
    const v = this.vel;

    if (!this.rolling) {
      // -- airborne integration --
      const vr = this._vr.copy(v).sub(this.wind);
      const s = vr.length();
      const acc = this._acc.set(0, -G, 0);
      if (s > 0.01) {
        // drag
        acc.addScaledVector(vr, -DRAG_K * s);
        // lift (reduces effective gravity while ball is fast)
        acc.y += this.liftK * s * s;
        // sidespin curve: horizontal, perpendicular to travel
        const hx = vr.x;
        const hz = vr.z;
        const hl = Math.hypot(hx, hz);
        if (hl > 0.01) {
          const px = hz / hl;
          const pz = -hx / hl;
          const side = this.curve * 0.008 * s;
          acc.x += px * side;
          acc.z += pz * side;
        }
      }
      v.addScaledVector(acc, h);
      p.addScaledVector(v, h);
      if (p.y > this.apex) this.apex = p.y;

      // descending through the water surface inside a water feature
      if (
        hole.hasWater &&
        v.y < 0 &&
        p.y <= hole.waterLevel + BALL_R &&
        hole.inWaterZone &&
        hole.inWaterZone(p.x, p.z)
      ) {
        p.y = hole.waterLevel;
        this.done = true;
        this.inWater = true;
        out.push({ type: 'splash', pos: p.clone(), speed: v.length() });
        return;
      }

      const ground = hole.heightAt(p.x, p.z);
      if (p.y <= ground + BALL_R) {
        const surf = hole.surfaceAt(p.x, p.z);
        if (surf === 'water') {
          p.y = Math.max(hole.waterLevel, ground + BALL_R);
          this.done = true;
          this.inWater = true;
          out.push({ type: 'splash', pos: p.clone(), speed: v.length() });
          return;
        }
        p.y = ground + BALL_R;
        const n = this._normalAt(p.x, p.z);
        const vn = v.dot(n);
        const spec = SURF[surf] || SURF.rough;
        if (vn < 0) {
          const impact = -vn;
          // reflect + damp
          v.addScaledVector(n, -(1 + spec.e) * vn);
          // tangential friction
          const tn = v.dot(n);
          const tx = v.x - n.x * tn;
          const ty = v.y - n.y * tn;
          const tz = v.z - n.z * tn;
          const keep = 1 - spec.f;
          v.set(n.x * tn + tx * keep, n.y * tn + ty * keep, n.z * tn + tz * keep);
          if (impact > 2.2 && spec.e > 0.05) {
            out.push({ type: 'bounce', pos: p.clone(), speed: impact, surf });
          }
          if (v.dot(n) < 1.1 || surf === 'sand') {
            this.rolling = true;
            v.y = 0;
          }
        } else {
          this.rolling = true;
        }
      }
    } else {
      // -- rolling on the surface --
      const surf = hole.surfaceAt(p.x, p.z);
      if (surf === 'water') {
        this.done = true;
        this.inWater = true;
        out.push({ type: 'splash', pos: p.clone(), speed: v.length() });
        return;
      }
      const spec = SURF[surf] || SURF.rough;
      const n = this._normalAt(p.x, p.z);
      // gravity along slope
      const gAlong = G * n.y;
      v.x += -n.x * gAlong * h;
      v.z += -n.z * gAlong * h;
      v.y = 0;
      const sp = Math.hypot(v.x, v.z);
      if (sp > 0.001) {
        const dec = Math.min(sp, spec.roll * h);
        v.x -= (v.x / sp) * dec;
        v.z -= (v.z / sp) * dec;
      }
      p.x += v.x * h;
      p.z += v.z * h;
      const ground = hole.heightAt(p.x, p.z);
      // fell off an edge while rolling -> back to the air
      if (ground + BALL_R < p.y - 0.25) {
        this.rolling = false;
        return;
      }
      p.y = ground + BALL_R;
      if (Math.hypot(v.x, v.z) < 0.55) {
        v.set(0, 0, 0);
        this.done = true;
        out.push({ type: 'rest', pos: p.clone(), speed: 0, surf });
      }
    }
  }

  _normalAt(x, z) {
    const e = 0.35;
    const hl = this.hole.heightAt(x - e, z);
    const hr = this.hole.heightAt(x + e, z);
    const hd = this.hole.heightAt(x, z - e);
    const hu = this.hole.heightAt(x, z + e);
    const n = new THREE.Vector3(hl - hr, 2 * e, hd - hu);
    return n.normalize();
  }
}

// Run a flight to rest synchronously (integration is deterministic, so a
// visual replay with identical params ends in exactly the same spot).
export function simulateToRest(opts) {
  const f = new BallFlight(opts);
  for (let i = 0; i < 3000 && !f.done; i++) f.step(1 / 60);
  return { pos: f.pos.clone(), inWater: !!f.inWater };
}

// Find the launch speed that makes a bot's ball — with full bounce and
// roll — come to rest (approximately) at targetPoint. Returns the launch
// params plus the exact simulated resting position.
export function solveBotShot({ start, targetPoint, hole, wind, loftDeg = 30, curveDeg = 0 }) {
  const dir = new THREE.Vector3(targetPoint.x - start.x, 0, targetPoint.z - start.z);
  const want = dir.length();
  dir.normalize();
  const along = (p) => (p.x - start.x) * dir.x + (p.z - start.z) * dir.z;

  let lo = 8;
  let hi = 100;
  let sim = null;
  for (let i = 0; i < 13; i++) {
    const mid = (lo + hi) / 2;
    sim = simulateToRest({ pos: start, dir, v0: mid, loftDeg, curveDeg, wind, hole });
    const d = sim.inWater ? along(sim.pos) : along(sim.pos);
    if (d < want) lo = mid;
    else hi = mid;
    if (Math.abs(d - want) < 0.35) {
      return { dir, v0: mid, loftDeg, curveDeg, sim };
    }
  }
  const v0 = (lo + hi) / 2;
  sim = simulateToRest({ pos: start, dir, v0, loftDeg, curveDeg, wind, hole });
  return { dir, v0, loftDeg, curveDeg, sim };
}

// ---- Club speed calibration ----
// Find the launch speed that carries each club its rated distance on flat
// ground with no wind, so gameplay distances always match the bag.

const flatHole = {
  heightAt: () => 0,
  surfaceAt: () => 'fairway',
  waterLevel: -999,
};

function carryFor(v0, loftDeg) {
  const f = new BallFlight({
    pos: new THREE.Vector3(0, BALL_R, 0),
    dir: new THREE.Vector3(0, 0, -1),
    v0,
    loftDeg,
    curveDeg: 0,
    wind: null,
    hole: flatHole,
  });
  let carry = 0;
  for (let i = 0; i < 6000 && !f.done; i++) {
    const ev = f.step(SUBSTEP * 4);
    for (const e of ev) {
      if (e.type === 'bounce' || e.type === 'rest') {
        carry = Math.abs(e.pos.z);
        return carry;
      }
    }
    if (f.rolling) return Math.abs(f.pos.z);
  }
  return Math.abs(f.pos.z);
}

const speedCache = new Map();

export function clubLaunchSpeed(club) {
  if (speedCache.has(club.id)) return speedCache.get(club.id);
  let lo = 15;
  let hi = 110;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (carryFor(mid, club.loft) < club.carry) lo = mid;
    else hi = mid;
  }
  const v = (lo + hi) / 2;
  speedCache.set(club.id, v);
  return v;
}
