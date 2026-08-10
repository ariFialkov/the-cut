// Procedural par-3 generator. A seed fully determines terrain, hazards,
// wind and dressing. The tee sits at (0,*,0); the pin is down -Z.

import * as THREE from 'three';
import { mulberry32, fbm, clamp, lerp, smoothstep, pick } from './rng.js';

const W = 170; // terrain width (x)

const ARCHETYPES = ['carry', 'lake', 'canyon', 'cliff', 'dunes', 'island'];

const HOLE_NAMES = {
  island: ["Devil's Kettle", 'The Moat', 'Last Ferry'],
  carry: ['The Gulp', 'Widowmaker', 'Big Swallow'],
  lake: ['Mirror Bay', 'Heron Point', 'Glass Corner'],
  canyon: ['The Chute', 'Rattler Run', 'Boneyard'],
  cliff: ['Sky Altar', "Widow's Shelf", 'The Pulpit'],
  dunes: ['Sandy Chaos', 'The Blowout', 'Camel Backs'],
};

export function generateHole(seed, idx) {
  const rng = mulberry32((seed ^ Math.imul(idx + 1, 0x9e3779b9)) >>> 0);
  const ns = Math.floor(rng() * 1e9);

  // Final hole is always the dramatic island green.
  const archetype = idx === 4 ? 'island' : ARCHETYPES[Math.floor(rng() * 5)];

  let L = 100 + rng() * 95;
  if (archetype === 'island') L = 130 + rng() * 50;
  if (archetype === 'carry') L = 125 + rng() * 70;

  const bend = (rng() - 0.5) * 34;
  const greenR = 8 + rng() * 5;
  const gx = bend;
  const gz = -L;

  let greenH = (rng() - 0.5) * 6;
  if (archetype === 'cliff') greenH = 6 + rng() * 5;
  if (archetype === 'island') greenH = 1 + rng() * 2;
  if (archetype === 'canyon') greenH = -3 - rng() * 4;

  const roughAmp = archetype === 'dunes' ? 7.5 : archetype === 'canyon' ? 5 : 4.2;
  const fwHalf = archetype === 'canyon' ? 9 : 11 + rng() * 3;

  // ---- water region ----
  const hasWater = archetype === 'island' || archetype === 'carry' || archetype === 'lake';
  let waterFn = () => 0;
  let waterRepT = 0.5;
  if (archetype === 'island') {
    const inner = greenR + 4;
    const outer = inner + 16 + rng() * 12;
    waterFn = (x, z, t, dG) =>
      smoothstep(inner - 2, inner + 1.5, dG) *
      (1 - smoothstep(outer - 3, outer + 2, dG)) *
      smoothstep(0.18, 0.34, t);
    waterRepT = 0.85;
  } else if (archetype === 'carry') {
    const bandC = 0.34 + rng() * 0.14;
    const bandW = 0.2 + rng() * 0.1;
    waterFn = (x, z, t) =>
      smoothstep(bandC - bandW / 2 - 0.04, bandC - bandW / 2, t) *
      (1 - smoothstep(bandC + bandW / 2, bandC + bandW / 2 + 0.04, t));
    waterRepT = bandC;
  } else if (archetype === 'lake') {
    const side = rng() < 0.5 ? -1 : 1;
    const cx = gx + side * (greenR + 12 + rng() * 9);
    const cz = -L * (0.7 + rng() * 0.25);
    const r = 17 + rng() * 11;
    waterFn = (x, z) => 1 - smoothstep(r - 4, r + 2, Math.hypot(x - cx, z - cz));
    waterRepT = -cz / L;
  }

  const trendAt = (t) => lerp(0, greenH, smoothstep(0.15, 0.9, clamp(t, -0.3, 1.3)));
  const waterLevel = hasWater ? trendAt(waterRepT) - 1.7 : -999;

  const centerAt = (t) => bend * smoothstep(0, 1, clamp(t, 0, 1));

  // ---- bunkers ----
  const bunkers = [];
  const nB =
    archetype === 'dunes' ? 4 + Math.floor(rng() * 3) : 2 + Math.floor(rng() * 3);
  for (let i = 0; i < nB * 3 && bunkers.length < nB; i++) {
    const a = rng() * Math.PI * 2;
    const d = greenR + 2.5 + rng() * 5;
    const bx = gx + Math.cos(a) * d;
    const bz = gz + Math.sin(a) * d * 0.8;
    if (waterFn(bx, bz, -bz / L, Math.hypot(bx - gx, bz - gz)) > 0.3) continue;
    bunkers.push({ x: bx, z: bz, r: 2.6 + rng() * 2.3 });
  }
  if (archetype !== 'island' && rng() < 0.5) {
    // mid-hole fairway bunker to think about
    const t = 0.45 + rng() * 0.25;
    bunkers.push({
      x: centerAt(t) + (rng() < 0.5 ? -1 : 1) * (4 + rng() * 6),
      z: -L * t,
      r: 3.2 + rng() * 2.5,
    });
  }

  // ---- height & surface ----
  function heightAt(x, z) {
    const t = -z / L;
    const dG = Math.hypot(x - gx, z - gz);
    const dT = Math.hypot(x, z);
    const lat = Math.abs(x - centerAt(t));

    const trend = trendAt(t);
    let base =
      fbm(x * 0.021, z * 0.021, ns, 4) * roughAmp +
      fbm(x * 0.085, z * 0.085, ns + 7, 2) * 0.55;

    if (archetype === 'canyon') {
      base += smoothstep(fwHalf + 4, fwHalf + 26, lat) * (9 + fbm(x * 0.05, z * 0.05, ns + 31, 2) * 3);
    }

    const greenMask = 1 - smoothstep(greenR + 2, greenR + 9, dG);
    const teeMask = 1 - smoothstep(5, 13, dT);
    const fwMask =
      (1 - smoothstep(fwHalf - 3, fwHalf + 5, lat)) *
      smoothstep(-0.02, 0.08, t) *
      (1 - smoothstep(0.94, 1.06, t));
    const flatten = Math.max(greenMask, teeMask, fwMask * 0.8);

    let h = trend + base * (1 - 0.88 * flatten);
    h += greenMask * fbm(x * 0.06, z * 0.06, ns + 13, 2) * 0.35;

    const wm = waterFn(x, z, t, dG);
    if (wm > 0.02) h = lerp(h, waterLevel - 2.4, smoothstep(0.1, 0.7, wm));
    return h;
  }

  function surfaceAt(x, z) {
    const t = -z / L;
    const dG = Math.hypot(x - gx, z - gz);
    if (waterFn(x, z, t, dG) > 0.45) return 'water';
    for (const b of bunkers) {
      if (Math.hypot(x - b.x, z - b.z) < b.r) return 'sand';
    }
    if (dG < greenR) return 'green';
    if (dG < greenR + 2.4) return 'fringe';
    if (Math.hypot(x, z) < 7) return 'tee';
    const lat = Math.abs(x - centerAt(t));
    if (lat < fwHalf && t > 0.02 && t < 0.98) return 'fairway';
    return 'rough';
  }

  // ---- wind ----
  const windSpeed = rng() * (idx === 0 ? 4 : 8);
  const windAngle = rng() * Math.PI * 2;
  const wind = new THREE.Vector3(Math.sin(windAngle) * windSpeed, 0, Math.cos(windAngle) * windSpeed);

  const hole = {
    idx,
    seed,
    archetype,
    name: pick(rng, HOLE_NAMES[archetype]),
    length: L,
    greenR,
    greenCenter: new THREE.Vector3(gx, 0, gz),
    heightAt,
    surfaceAt,
    waterLevel,
    hasWater,
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
  hole.group = buildMeshes(hole, rng, ns);
  return hole;
}

// ------------------------------------------------------------------
//  Meshes
// ------------------------------------------------------------------

const COLORS = {
  green: new THREE.Color('#5fca6e'),
  fringe: new THREE.Color('#4eb75f'),
  tee: new THREE.Color('#57c065'),
  fairwayA: new THREE.Color('#45a856'),
  fairwayB: new THREE.Color('#3f9e50'),
  rough: new THREE.Color('#2f7f42'),
  sand: new THREE.Color('#ecdda7'),
  water: new THREE.Color('#2c7fc9'),
  cliff: new THREE.Color('#8a7a63'),
};

function buildMeshes(hole, rng, ns) {
  const group = new THREE.Group();
  const len = hole.zMax - hole.zMin;
  const cell = 2.0;
  const nx = Math.ceil(W / cell);
  const nz = Math.ceil(len / cell);

  const positions = [];
  const colors = [];
  const c = new THREE.Color();

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

  function faceColor(cx, cz, cy) {
    const surf = hole.surfaceAt(cx, cz);
    if (surf === 'water') {
      c.copy(COLORS.rough).multiplyScalar(0.55); // lakebed, hidden by water plane
    } else if (surf === 'fairway') {
      const stripe = Math.floor(-cz / 7) % 2 === 0;
      c.copy(stripe ? COLORS.fairwayA : COLORS.fairwayB);
    } else if (surf === 'rough' && cy > hole.pin.y + 7) {
      c.copy(COLORS.cliff); // exposed high ground reads as rock
    } else {
      c.copy(COLORS[surf] || COLORS.rough);
    }
    const v = 1 + fbm(cx * 0.3, cz * 0.3, ns + 77, 2) * 0.06;
    c.r = clamp(c.r * v, 0, 1);
    c.g = clamp(c.g * v, 0, 1);
    c.b = clamp(c.b * v, 0, 1);
    return c;
  }

  function pushTri(x1, y1, z1, x2, y2, z2, x3, y3, z3) {
    positions.push(x1, y1, z1, x2, y2, z2, x3, y3, z3);
    const col = faceColor((x1 + x2 + x3) / 3, (z1 + z2 + z3) / 3, (y1 + y2 + y3) / 3);
    for (let k = 0; k < 3; k++) colors.push(col.r, col.g, col.b);
  }

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
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
        pushTri(x0, h00, z0, x0, h01, z1, x1, h11, z1);
        pushTri(x0, h00, z0, x1, h11, z1, x1, h10, z0);
      } else {
        pushTri(x0, h00, z0, x0, h01, z1, x1, h10, z0);
        pushTri(x1, h10, z0, x0, h01, z1, x1, h11, z1);
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

  // water plane
  if (hole.hasWater) {
    const wgeo = new THREE.PlaneGeometry(W, len);
    wgeo.rotateX(-Math.PI / 2);
    const wmat = new THREE.MeshLambertMaterial({
      color: COLORS.water,
      transparent: true,
      opacity: 0.86,
    });
    const water = new THREE.Mesh(wgeo, wmat);
    water.position.set(0, hole.waterLevel, hole.zMin + len / 2);
    group.add(water);
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

  // ---- tee markers ----
  const markMat = new THREE.MeshLambertMaterial({ color: 0xe8453c });
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), markMat);
    m.position.set(s * 1.4, hole.heightAt(s * 1.4, 0) + 0.12, 0);
    group.add(m);
  }

  // ---- trees ----
  const treeSpots = [];
  for (let i = 0; i < 400 && treeSpots.length < 55; i++) {
    const x = (rng() - 0.5) * (W - 14);
    const z = hole.zMin + 8 + rng() * (len - 16);
    const surf = hole.surfaceAt(x, z);
    if (surf !== 'rough') continue;
    const dPin = Math.hypot(x - hole.pin.x, z - hole.pin.z);
    if (dPin < hole.greenR + 13) continue;
    if (Math.hypot(x, z) < 12) continue;
    treeSpots.push({ x, z, s: 0.7 + rng() * 0.9, hue: rng() });
  }
  if (treeSpots.length) {
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1.3, 5);
    const canopyGeo = new THREE.ConeGeometry(1.5, 3.4, 6);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2b });
    const canopyMat = new THREE.MeshLambertMaterial({ flatShading: true });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeSpots.length);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, treeSpots.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const cc = new THREE.Color();
    treeSpots.forEach((t, i) => {
      const y = hole.heightAt(t.x, t.z);
      m4.compose(new THREE.Vector3(t.x, y + 0.6 * t.s, t.z), q, new THREE.Vector3(t.s, t.s, t.s));
      trunks.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(t.x, y + (1.2 + 1.7) * t.s, t.z), q, new THREE.Vector3(t.s, t.s, t.s));
      canopies.setMatrixAt(i, m4);
      if (t.hue < 0.12) cc.set('#c97f35');
      else if (t.hue < 0.5) cc.set('#2c8a46');
      else cc.set('#1e6e38');
      canopies.setColorAt(i, cc);
    });
    canopies.castShadow = true;
    group.add(trunks, canopies);
  }

  // ---- rocks ----
  const nRocks = 5 + Math.floor(rng() * 6);
  const rockGeo = new THREE.DodecahedronGeometry(0.8, 0);
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x9a938a, flatShading: true });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, nRocks);
  const rm = new THREE.Matrix4();
  const rq = new THREE.Quaternion();
  for (let i = 0; i < nRocks; i++) {
    const x = (rng() - 0.5) * (W - 20);
    const z = hole.zMin + 10 + rng() * (len - 20);
    if (hole.surfaceAt(x, z) !== 'rough') {
      rm.makeScale(0, 0, 0);
      rocks.setMatrixAt(i, rm);
      continue;
    }
    const s = 0.4 + rng() * 1.1;
    rq.setFromEuler(new THREE.Euler(rng() * 3, rng() * 3, rng() * 3));
    rm.compose(new THREE.Vector3(x, hole.heightAt(x, z) + s * 0.3, z), rq, new THREE.Vector3(s, s * 0.7, s));
    rocks.setMatrixAt(i, rm);
  }
  group.add(rocks);

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
