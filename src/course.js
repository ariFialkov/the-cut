// Procedural par-3 generator. A seed fully determines terrain, hazards,
// wind and dressing. The tee sits at (0,*,0); the pin is down -Z.

import * as THREE from 'three';
import { mulberry32, fbm, noise2, clamp, lerp, smoothstep, pick } from './rng.js';

const W = 170; // terrain width (x)

const ARCHETYPES = ['carry', 'lake', 'canyon', 'cliff', 'dunes', 'creek'];

const HOLE_NAMES = {
  island: ["Devil's Kettle", 'The Moat', 'Last Ferry'],
  carry: ['The Gulp', 'Widowmaker', 'Big Swallow'],
  lake: ['Mirror Bay', 'Heron Point', 'Glass Corner'],
  canyon: ['The Chute', 'Rattler Run', 'Boneyard'],
  cliff: ['Sky Altar', "Widow's Shelf", 'The Pulpit'],
  dunes: ['Sandy Chaos', 'The Blowout', 'Camel Backs'],
  creek: ['Burbling Doom', 'Cold Crossing', 'The Trickle'],
};

export function generateHole(seed, idx) {
  const rng = mulberry32((seed ^ Math.imul(idx + 1, 0x9e3779b9)) >>> 0);
  const ns = Math.floor(rng() * 1e9);

  // Final hole is the wheel: a dramatic island with a giant flat green.
  const isWheel = idx === 4;
  const archetype = isWheel ? 'island' : ARCHETYPES[Math.floor(rng() * ARCHETYPES.length)];

  let L = 100 + rng() * 95;
  if (archetype === 'island') L = 130 + rng() * 50;
  if (archetype === 'carry') L = 125 + rng() * 70;

  // ---- routing: dogleg end-offset + mid-hole S bulge ----
  const bendB = isWheel ? (rng() - 0.5) * 10 : (rng() - 0.5) * 44;
  const bendA = isWheel ? 0 : (rng() - 0.5) * 28;
  const centerAt = (t) => {
    const ct = clamp(t, 0, 1);
    return bendB * smoothstep(0, 1, ct) + bendA * Math.sin(Math.PI * ct);
  };

  const greenR = isWheel ? 14.5 : 8 + rng() * 5;
  const gx = bendB;
  const gz = -L;

  // ---- elevation: tees can perch, greens can sink or climb ----
  let greenH = (rng() - 0.5) * 6;
  if (archetype === 'cliff') greenH = 6 + rng() * 5;
  if (archetype === 'island') greenH = 1 + rng() * 2;
  if (archetype === 'canyon') greenH = -3 - rng() * 4;

  let teeH = 0;
  const teeRoll = rng();
  if (archetype === 'canyon' || archetype === 'carry' || teeRoll < 0.4) teeH = 2 + rng() * 6;
  else if (teeRoll < 0.55) teeH = -(1 + rng() * 2);

  const roughAmp = archetype === 'dunes' ? 7.5 : archetype === 'canyon' ? 5 : 4.2;

  // ---- fairway: width breathes along the hole (pinches and bulges) ----
  const baseFw = archetype === 'canyon' ? 9 : 11 + rng() * 3;
  const fwHalfAt = (t) =>
    clamp(baseFw * (1 + 0.55 * noise2(t * 2.6 + 3.7, 0.5, ns + 91)), 5.5, baseFw * 1.7);

  // ---- green: a wobbly blob, not a circle (except the wheel) ----
  const gA1 = 0.1 + rng() * 0.13;
  const gP1 = rng() * Math.PI * 2;
  const gA2 = 0.06 + rng() * 0.1;
  const gP2 = rng() * Math.PI * 2;
  const shapeMul = isWheel
    ? () => 1
    : (ang) => 1 + gA1 * Math.sin(2 * ang + gP1) + gA2 * Math.sin(3 * ang + gP2);
  // normalized distance from green center: < greenR means "on the green"
  const greenDist = (x, z) => {
    const dx = x - gx;
    const dz = z - gz;
    const d = Math.hypot(dx, dz);
    if (d < 0.001) return 0;
    return d / shapeMul(Math.atan2(dx, dz));
  };

  const trendAt = (t) => lerp(teeH, greenH, smoothstep(0.15, 0.9, clamp(t, -0.3, 1.3)));

  // ---- water: archetype feature + occasional bonus ponds ----
  // Each feature carries its own bbox (for a tight water plane) and the
  // bank height where it lives, so the water surface sits just below its
  // own banks instead of at one globally-lowered level.
  const waterFeats = []; // {fn, bbox:{x0,x1,z0,z1}, bankT}
  if (archetype === 'island') {
    const inner = greenR + 4;
    const outer = inner + 16 + rng() * 12;
    waterFeats.push({
      fn: (x, z, t, dG) =>
        smoothstep(inner - 2, inner + 1.5, dG) *
        (1 - smoothstep(outer - 3, outer + 2, dG)) *
        smoothstep(0.18, 0.34, t),
      bbox: { x0: gx - outer - 8, x1: gx + outer + 8, z0: gz - outer - 8, z1: gz + outer + 8 },
      bankT: 0.8,
    });
  } else if (archetype === 'carry') {
    const bandC = 0.34 + rng() * 0.14;
    const bandW = 0.2 + rng() * 0.1;
    waterFeats.push({
      fn: (x, z, t) =>
        smoothstep(bandC - bandW / 2 - 0.04, bandC - bandW / 2, t) *
        (1 - smoothstep(bandC + bandW / 2, bandC + bandW / 2 + 0.04, t)),
      bbox: {
        x0: -W / 2,
        x1: W / 2,
        z0: -L * (bandC + bandW / 2) - 10,
        z1: -L * (bandC - bandW / 2) + 10,
      },
      bankT: bandC,
    });
  } else if (archetype === 'lake') {
    const side = rng() < 0.5 ? -1 : 1;
    const cx = gx + side * (greenR + 12 + rng() * 9);
    const cz = -L * (0.7 + rng() * 0.25);
    const r = 17 + rng() * 11;
    waterFeats.push({
      fn: (x, z) => 1 - smoothstep(r - 4, r + 2, Math.hypot(x - cx, z - cz)),
      bbox: { x0: cx - r - 6, x1: cx + r + 6, z0: cz - r - 6, z1: cz + r + 6 },
      bankT: -cz / L,
    });
  } else if (archetype === 'creek') {
    // a winding stream cutting across the hole
    const tC = 0.35 + rng() * 0.35;
    const wHalf = 2.6 + rng() * 2.2;
    const ph = rng() * 10;
    const creekZ = (x) => -L * tC + Math.sin(x * 0.045 + ph) * 9 + noise2(x * 0.02, ph, ns + 55) * 5;
    waterFeats.push({
      fn: (x, z) => 1 - smoothstep(wHalf - 1.2, wHalf + 3.5, Math.abs(z - creekZ(x))),
      bbox: { x0: -W / 2, x1: W / 2, z0: -L * tC - wHalf - 22, z1: -L * tC + wHalf + 22 },
      bankT: tC,
    });
  }
  if ((archetype === 'dunes' || archetype === 'cliff' || archetype === 'canyon') && rng() < 0.45) {
    // bonus pond tucked off the line
    const side = rng() < 0.5 ? -1 : 1;
    const t = 0.3 + rng() * 0.4;
    const cx = centerAt(t) + side * (baseFw + 10 + rng() * 10);
    const cz = -L * t;
    const r = 6 + rng() * 6;
    waterFeats.push({
      fn: (x, z) => 1 - smoothstep(r - 3, r + 2.5, Math.hypot(x - cx, z - cz)),
      bbox: { x0: cx - r - 6, x1: cx + r + 6, z0: cz - r - 6, z1: cz + r + 6 },
      bankT: t,
    });
  }
  const hasWater = waterFeats.length > 0;
  // water sits a step below the lowest bank among the features
  const waterLevel = hasWater
    ? Math.min(...waterFeats.map((w) => trendAt(w.bankT))) - 1.4
    : -999;
  const waterFn = hasWater
    ? (x, z, t, dG) => {
        let m = 0;
        for (const w of waterFeats) {
          const v = w.fn(x, z, t, dG);
          if (v > m) m = v;
        }
        if (m <= 0) return 0;
        // never flood the tee pad or (non-island) the putting surface
        m *= smoothstep(6, 11, Math.hypot(x, z));
        if (archetype !== 'island') m *= smoothstep(greenR + 0.5, greenR + 3, greenDist(x, z));
        return m;
      }
    : () => 0;

  // ---- bunkers ----
  const bunkers = [];
  const nB = archetype === 'dunes' ? 4 + Math.floor(rng() * 3) : 2 + Math.floor(rng() * 3);
  for (let i = 0; i < nB * 3 && bunkers.length < nB; i++) {
    const a = rng() * Math.PI * 2;
    const d = (greenR + 2.5 + rng() * 5) * shapeMul(a);
    const bx = gx + Math.sin(a) * d;
    const bz = gz + Math.cos(a) * d * 0.85;
    if (waterFn(bx, bz, -bz / L, Math.hypot(bx - gx, bz - gz)) > 0.3) continue;
    bunkers.push({ x: bx, z: bz, r: 2.6 + rng() * 2.3 });
  }
  if (archetype !== 'island' && rng() < 0.55) {
    // mid-hole fairway bunker to think about
    const t = 0.45 + rng() * 0.25;
    bunkers.push({
      x: centerAt(t) + (rng() < 0.5 ? -1 : 1) * (4 + rng() * 6),
      z: -L * t,
      r: 3.2 + rng() * 2.5,
    });
  }
  const sandDist = (x, z) => {
    let m = 1e9;
    for (const b of bunkers) {
      const d = Math.hypot(x - b.x, z - b.z) - b.r;
      if (d < m) m = d;
    }
    return m;
  };

  // ---- height & surface ----
  function heightAt(x, z) {
    const t = -z / L;
    const nd = greenDist(x, z);
    const dT = Math.hypot(x, z);
    const lat = Math.abs(x - centerAt(t));

    const trend = trendAt(t);
    let base =
      fbm(x * 0.021, z * 0.021, ns, 4) * roughAmp +
      fbm(x * 0.085, z * 0.085, ns + 7, 2) * 0.55;

    if (archetype === 'canyon') {
      base += smoothstep(baseFw + 4, baseFw + 26, lat) * (9 + fbm(x * 0.05, z * 0.05, ns + 31, 2) * 3);
    }

    const greenMask = 1 - smoothstep(greenR + 2, greenR + 9, nd);
    const teeMask = 1 - smoothstep(5, 13, dT);
    const fw = fwHalfAt(t);
    const fwMask =
      (1 - smoothstep(fw - 3, fw + 5, lat)) *
      smoothstep(-0.02, 0.08, t) *
      (1 - smoothstep(0.94, 1.06, t));
    const flatten = Math.max(greenMask, teeMask, fwMask * 0.8);

    let h = trend + base * (1 - 0.88 * flatten);
    if (!isWheel) h += greenMask * fbm(x * 0.06, z * 0.06, ns + 13, 2) * 0.35;

    // bunkers dish in a little
    const sd = sandDist(x, z);
    if (sd < 1.5) h -= (1 - smoothstep(-1.5, 1.5, sd)) * 0.55;

    const wm = waterFn(x, z, t, Math.hypot(x - gx, z - gz));
    if (wm > 0.02) h = Math.min(h, lerp(h, waterLevel - 1.8, smoothstep(0.08, 0.65, wm)));
    return h;
  }

  function surfaceAt(x, z) {
    const t = -z / L;
    if (waterFn(x, z, t, Math.hypot(x - gx, z - gz)) > 0.45) return 'water';
    if (sandDist(x, z) < 0) return 'sand';
    const nd = greenDist(x, z);
    if (nd < greenR) return 'green';
    if (nd < greenR + 2.4) return 'fringe';
    if (Math.hypot(x, z) < 7) return 'tee';
    const lat = Math.abs(x - centerAt(t));
    if (lat < fwHalfAt(t) && t > 0.02 && t < 0.98) return 'fairway';
    return 'rough';
  }

  // ---- wind ----
  const windSpeed = rng() * (idx === 0 ? 4 : 8);
  const windAngle = rng() * Math.PI * 2;
  const wind = new THREE.Vector3(Math.sin(windAngle) * windSpeed, 0, Math.cos(windAngle) * windSpeed);

  const hole = {
    idx,
    seed,
    isWheel,
    archetype,
    name: isWheel ? 'The Wheel' : pick(rng, HOLE_NAMES[archetype]),
    length: L,
    greenR,
    greenCenter: new THREE.Vector3(gx, 0, gz),
    heightAt,
    surfaceAt,
    waterLevel,
    hasWater,
    // true only where a water feature actually is — the water level can sit
    // higher than dry ground elsewhere on the hole, so physics must never
    // infer "underwater" from height alone
    inWaterZone: (x, z) =>
      hasWater && waterFn(x, z, -z / L, Math.hypot(x - gx, z - gz)) > 0.03,
    wind,
    windSpeed,
    bunkers,
    zMin: -L - 60,
    zMax: 42,
    halfW: W / 2,
  };
  hole.tee = new THREE.Vector3(0, heightAt(0, 0), 0);
  hole.pin = new THREE.Vector3(gx, heightAt(gx, gz), gz);
  hole.greenCenter.y = hole.pin.y;
  hole.group = buildMeshes(hole, rng, ns, {
    centerAt,
    fwHalfAt,
    greenDist,
    sandDist,
    waterFn,
    waterFeats,
    trendAt,
  });
  return hole;
}

// ------------------------------------------------------------------
//  Meshes
// ------------------------------------------------------------------

const C = {
  green: new THREE.Color('#63c96f'),
  fringe: new THREE.Color('#53b25f'),
  tee: new THREE.Color('#59c266'),
  fairwayA: new THREE.Color('#47aa55'),
  fairwayB: new THREE.Color('#3fa04d'),
  rough: new THREE.Color('#2f8143'),
  roughDry: new THREE.Color('#4f9147'),
  sand: new THREE.Color('#e8d9a5'),
  water: new THREE.Color('#2e83cd'),
  bed: new THREE.Color('#1d4a2c'),
  rock: new THREE.Color('#8d8177'),
};

function buildMeshes(hole, rng, ns, f) {
  const group = new THREE.Group();
  const len = hole.zMax - hole.zMin;
  const cell = 2.0;
  const nx = Math.ceil(W / cell);
  const nz = Math.ceil(len / cell);

  const positions = [];
  const colors = [];
  const c = new THREE.Color();
  const tmp = new THREE.Color();

  const vx = (i) => -W / 2 + (i * W) / nx;
  const vz = (j) => hole.zMin + (j * len) / nz;

  // cache the vertex grid heights
  const H = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      H[j * (nx + 1) + i] = hole.heightAt(vx(i), vz(j));
    }
  }
  const hAt = (i, j) => H[j * (nx + 1) + i];

  // smooth per-vertex slope (central differences over the cached grid) so
  // rock shading forms coherent patches instead of per-face flicker
  const cellX = W / nx;
  const cellZ = len / nz;
  const G = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(nx, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(nz, j + 1);
      const gx = (hAt(i1, j) - hAt(i0, j)) / ((i1 - i0) * cellX);
      const gz = (hAt(i, j1) - hAt(i, j0)) / ((j1 - j0) * cellZ);
      G[j * (nx + 1) + i] = Math.hypot(gx, gz);
    }
  }
  const slopeAt = (i, j) =>
    (G[j * (nx + 1) + i] +
      G[j * (nx + 1) + Math.min(nx, i + 1)] +
      G[Math.min(nz, j + 1) * (nx + 1) + i] +
      G[Math.min(nz, j + 1) * (nx + 1) + Math.min(nx, i + 1)]) /
    4;

  // Smoothly blended terrain color: no hard per-face category edges.
  function faceColor(cx, cz, slope) {
    const t = -cz / hole.length;
    const nd = f.greenDist(cx, cz);
    const lat = Math.abs(cx - f.centerAt(t));
    const fw = f.fwHalfAt(t);

    // base: rough with big soft mottling
    const mot = fbm(cx * 0.03, cz * 0.03, ns + 77, 3);
    c.copy(C.rough).lerp(C.roughDry, clamp(mot * 0.9 + 0.25, 0, 1) * 0.45);

    // fairway ribbon with soft mow stripes
    const wFw =
      (1 - smoothstep(fw - 2, fw + 3, lat)) *
      smoothstep(-0.02, 0.06, t) *
      (1 - smoothstep(0.95, 1.04, t));
    if (wFw > 0.001) {
      const stripe = smoothstep(0.2, 0.8, Math.abs(((-cz / 7) % 2) - 1));
      tmp.copy(C.fairwayA).lerp(C.fairwayB, stripe);
      c.lerp(tmp, wFw);
    }

    // fringe collar then green
    const wFr = 1 - smoothstep(hole.greenR + 1.2, hole.greenR + 4, nd);
    if (wFr > 0.001) c.lerp(C.fringe, wFr);
    const wG = 1 - smoothstep(hole.greenR - 2, hole.greenR + 0.8, nd);
    if (wG > 0.001) {
      const stripe = smoothstep(0.25, 0.75, Math.abs(((cx / 4.5) % 2) - 1));
      tmp.copy(C.green).lerp(C.fringe, stripe * 0.25);
      c.lerp(tmp, wG);
    }

    // tee pad
    const wT = 1 - smoothstep(5, 9, Math.hypot(cx, cz));
    if (wT > 0.001) c.lerp(C.tee, wT);

    // bunkers
    const sd = f.sandDist(cx, cz);
    const wS = 1 - smoothstep(-0.6, 1.2, sd);
    if (wS > 0.001) c.lerp(C.sand, wS);

    // steep faces read as exposed rock
    const wR = smoothstep(0.55, 1.15, slope);
    if (wR > 0.001) c.lerp(C.rock, wR * 0.85);

    // lakebed (hidden under the water plane, dark if visible at the edge)
    const wm = f.waterFn(cx, cz, t, Math.hypot(cx - hole.greenCenter.x, cz - hole.greenCenter.z));
    const wW = smoothstep(0.2, 0.6, wm);
    if (wW > 0.001) c.lerp(C.bed, wW);

    // gentle large-scale light variation, no per-face speckle
    const v = 1 + fbm(cx * 0.012, cz * 0.012, ns + 79, 2) * 0.05;
    c.r = clamp(c.r * v, 0, 1);
    c.g = clamp(c.g * v, 0, 1);
    c.b = clamp(c.b * v, 0, 1);
    return c;
  }

  function pushTri(x1, y1, z1, x2, y2, z2, x3, y3, z3, slope) {
    positions.push(x1, y1, z1, x2, y2, z2, x3, y3, z3);
    const col = faceColor((x1 + x2 + x3) / 3, (z1 + z2 + z3) / 3, slope);
    for (let k = 0; k < 3; k++) colors.push(col.r, col.g, col.b);
  }

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const slope = slopeAt(i, j);
      const x0 = vx(i);
      const x1 = vx(i + 1);
      const z0 = vz(j);
      const z1 = vz(j + 1);
      const h00 = hAt(i, j);
      const h10 = hAt(i + 1, j);
      const h01 = hAt(i, j + 1);
      const h11 = hAt(i + 1, j + 1);
      // alternate the diagonal for a nicer low-poly pattern
      if ((i + j) % 2 === 0) {
        pushTri(x0, h00, z0, x0, h01, z1, x1, h11, z1, slope);
        pushTri(x0, h00, z0, x1, h11, z1, x1, h10, z0, slope);
      } else {
        pushTri(x0, h00, z0, x0, h01, z1, x1, h10, z0, slope);
        pushTri(x1, h10, z0, x0, h01, z1, x1, h11, z1, slope);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const terrain = new THREE.Mesh(geo, mat);
  terrain.receiveShadow = true;
  group.add(terrain);

  // water planes: one tight patch per feature, at that hole's water level
  if (hole.hasWater) {
    const wmat = new THREE.MeshLambertMaterial({
      color: C.water,
      transparent: true,
      opacity: 0.86,
    });
    for (const wf of f.waterFeats) {
      const bw = wf.bbox.x1 - wf.bbox.x0;
      const bl = wf.bbox.z1 - wf.bbox.z0;
      const wgeo = new THREE.PlaneGeometry(bw, bl);
      wgeo.rotateX(-Math.PI / 2);
      const water = new THREE.Mesh(wgeo, wmat);
      water.position.set((wf.bbox.x0 + wf.bbox.x1) / 2, hole.waterLevel, (wf.bbox.z0 + wf.bbox.z1) / 2);
      group.add(water);
    }
  }

  // ---- flag ----
  const flagGroup = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 2.4, 6),
    new THREE.MeshLambertMaterial({ color: 0xf5f5f5 })
  );
  pole.position.y = 1.2;
  flagGroup.add(pole);
  const flagGeo = new THREE.BufferGeometry();
  flagGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 2.35, 0, 0.85, 2.15, 0, 0, 1.95, 0], 3)
  );
  flagGeo.computeVertexNormals();
  const flag = new THREE.Mesh(
    flagGeo,
    new THREE.MeshLambertMaterial({ color: 0xff4136, side: THREE.DoubleSide })
  );
  flagGroup.add(flag);
  const cup = new THREE.Mesh(
    new THREE.CircleGeometry(0.35, 16),
    new THREE.MeshBasicMaterial({ color: 0x11331a })
  );
  cup.rotateX(-Math.PI / 2);
  cup.position.y = 0.02;
  flagGroup.add(cup);
  flagGroup.position.copy(hole.pin);
  group.add(flagGroup);
  hole.flagMesh = flag;

  // ---- trees: pines and round-canopy broadleafs ----
  const pines = [];
  const rounds = [];
  for (let i = 0; i < 500 && pines.length + rounds.length < 60; i++) {
    const x = (rng() - 0.5) * (W - 14);
    const z = hole.zMin + 8 + rng() * (len - 16);
    if (hole.surfaceAt(x, z) !== 'rough') continue;
    if (Math.hypot(x - hole.pin.x, z - hole.pin.z) < hole.greenR + 13) continue;
    if (Math.hypot(x, z) < 12) continue;
    const spot = { x, z, s: 0.7 + rng() * 1.0, hue: rng() };
    (rng() < 0.55 ? pines : rounds).push(spot);
  }
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1.3, 5);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2b });
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const cc = new THREE.Color();
  const addTrees = (spots, canopyGeo, canopyY, colorOf) => {
    if (!spots.length) return;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    const canopies = new THREE.InstancedMesh(
      canopyGeo,
      new THREE.MeshLambertMaterial({ flatShading: true }),
      spots.length
    );
    spots.forEach((t, i) => {
      const y = hole.heightAt(t.x, t.z);
      m4.compose(new THREE.Vector3(t.x, y + 0.6 * t.s, t.z), q, new THREE.Vector3(t.s, t.s, t.s));
      trunks.setMatrixAt(i, m4);
      const rq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng() * Math.PI, 0));
      m4.compose(new THREE.Vector3(t.x, y + canopyY * t.s, t.z), rq, new THREE.Vector3(t.s, t.s, t.s));
      canopies.setMatrixAt(i, m4);
      canopies.setColorAt(i, colorOf(t, cc));
    });
    canopies.castShadow = true;
    group.add(trunks, canopies);
  };
  addTrees(pines, new THREE.ConeGeometry(1.5, 3.4, 6), 2.9, (t, col) =>
    col.set(t.hue < 0.5 ? '#1e6e38' : '#2c8a46')
  );
  addTrees(rounds, new THREE.IcosahedronGeometry(1.7, 0), 2.6, (t, col) =>
    col.set(t.hue < 0.14 ? '#c97f35' : t.hue < 0.3 ? '#7fae3e' : '#3a9b4e')
  );

  // ---- bushes hugging the fairway edges ----
  const bushSpots = [];
  for (let i = 0; i < 260 && bushSpots.length < 42; i++) {
    const t = 0.06 + rng() * 0.88;
    const side = rng() < 0.5 ? -1 : 1;
    const x = f.centerAt(t) + side * (f.fwHalfAt(t) + 2.5 + rng() * 9);
    const z = -hole.length * t + (rng() - 0.5) * 8;
    if (hole.surfaceAt(x, z) !== 'rough') continue;
    bushSpots.push({ x, z, s: 0.45 + rng() * 0.7 });
  }
  if (bushSpots.length) {
    const bushes = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshLambertMaterial({ flatShading: true }),
      bushSpots.length
    );
    bushSpots.forEach((b, i) => {
      const rq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng() * Math.PI, 0));
      m4.compose(
        new THREE.Vector3(b.x, hole.heightAt(b.x, b.z) + b.s * 0.45, b.z),
        rq,
        new THREE.Vector3(b.s, b.s * 0.62, b.s)
      );
      bushes.setMatrixAt(i, m4);
      bushes.setColorAt(i, cc.set(rng() < 0.25 ? '#5d9b3f' : '#2a7040'));
    });
    group.add(bushes);
  }

  // ---- boulders: a few big ones, several scattered stones ----
  const nRocks = 8 + Math.floor(rng() * 8);
  const rocks = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(0.8, 0),
    new THREE.MeshLambertMaterial({ flatShading: true }),
    nRocks
  );
  for (let i = 0; i < nRocks; i++) {
    const x = (rng() - 0.5) * (W - 20);
    const z = hole.zMin + 10 + rng() * (len - 20);
    if (hole.surfaceAt(x, z) !== 'rough') {
      m4.makeScale(0, 0, 0);
      rocks.setMatrixAt(i, m4);
      continue;
    }
    const big = rng() < 0.3;
    const s = big ? 1.6 + rng() * 1.8 : 0.4 + rng() * 1.0;
    const rq = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 3, rng() * 3, rng() * 3));
    m4.compose(new THREE.Vector3(x, hole.heightAt(x, z) + s * 0.3, z), rq, new THREE.Vector3(s, s * 0.75, s));
    rocks.setMatrixAt(i, m4);
    rocks.setColorAt(i, cc.set(rng() < 0.3 ? '#a49a8d' : rng() < 0.5 ? '#7e756c' : '#8d8177'));
  }
  group.add(rocks);

  // ---- lazy clouds ----
  const nClouds = 6 + Math.floor(rng() * 5);
  const clouds = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshBasicMaterial({ color: 0xf2f7fb }),
    nClouds * 3
  );
  for (let i = 0; i < nClouds; i++) {
    const cx = (rng() - 0.5) * 320;
    const cz = hole.zMin - 40 + rng() * (len + 60);
    const cy = 75 + rng() * 40;
    for (let k = 0; k < 3; k++) {
      const s = 5 + rng() * 5;
      m4.compose(
        new THREE.Vector3(cx + (rng() - 0.5) * 16, cy + (rng() - 0.5) * 3, cz + (rng() - 0.5) * 8),
        q,
        new THREE.Vector3(s, s * 0.45, s * 0.75)
      );
      clouds.setMatrixAt(i * 3 + k, m4);
    }
  }
  group.add(clouds);

  return group;
}

export function disposeHole(hole) {
  if (!hole || !hole.group) return;
  hole.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
}
