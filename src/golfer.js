// Articulated low-poly golfers. Joint hierarchy: pelvis -> spine (2) ->
// neck/head, an arms root at the chest with elbow + wrist detail, and
// legs with hip/knee/ankle. Tapered limb segments give a bit of muscle
// definition while staying stylized. Poses are driven by a single swing
// phase (-1 full backswing .. 0 address .. +1 follow-through).

import * as THREE from 'three';

export const PLAYER_LOOK = {
  name: 'You',
  skin: '#e8b48c',
  shirt: '#e8453c',
  pants: '#22262e',
  hat: '#ffffff',
  hatStyle: 'cap',
  hair: '#3a2a1a',
  build: 'm',
};

// Parody pros. Complexion/outfit loosely nod to the real golfer.
export const BOT_BANK = [
  { name: 'Lion Beach', skin: '#8a5a3b', shirt: '#d0021b', pants: '#17181c', hat: '#111111', hatStyle: 'cap', hair: '#141414', build: 'm' },
  { name: 'Cory McFlurry', skin: '#e8b48c', shirt: '#1f3a93', pants: '#e3e6ea', hat: '#12224e', hatStyle: 'cap', hair: '#4a3421', build: 'm' },
  { name: 'Bison DeChampagne', skin: '#e6ac7f', shirt: '#2e3f50', pants: '#23262c', hat: '#f2ede2', hatStyle: 'bucket', hair: '#4a341f', build: 'broad' },
  { name: 'Mickey Growler', skin: '#e8b48c', shirt: '#f26f1d', pants: '#f4f6f8', hat: '#f26f1d', hatStyle: 'flat', hair: '#5b4022', build: 'm' },
  { name: 'Grayson Night', skin: '#c98d5f', shirt: '#26262a', pants: '#3d3f45', hat: '#101012', hatStyle: 'cap', hair: '#17120d', build: 'm' },
  { name: 'Tom Freeze', skin: '#e8b48c', shirt: '#7c2230', pants: '#2a2f3a', hat: '#f4f6f8', hatStyle: 'cap', hair: '#6b4a2b', build: 'm' },
  { name: 'Bubbie Thompson', skin: '#e6ac7f', shirt: '#f3f5f7', pants: '#2c3e50', hat: '#ff7fb0', hatStyle: 'cap', hair: '#5b4022', build: 'm' },
  { name: 'Vegan Chadley', skin: '#e8b48c', shirt: '#3f5d75', pants: '#d9dde2', hat: '#1c2a3a', hatStyle: 'cap', hair: '#3b2c18', build: 'm' },
  { name: 'Kelly Norda', skin: '#f0c9a0', shirt: '#a9d3e6', pants: '#f4f6f8', hat: '#ffffff', hatStyle: 'visor', hair: '#e8c766', build: 'f' },
  { name: 'Tulip Chang', skin: '#f0c9a0', shirt: '#e7a5c0', pants: '#2f3640', hat: '#ffffff', hatStyle: 'visor', hair: '#221a12', build: 'f' },
];

function M(color) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

function cyl(rTop, rBot, h, color, seg = 7) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), M(color));
  m.castShadow = true;
  return m;
}

function box(w, h, d, color) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(color));
  m.castShadow = true;
  return m;
}

function sph(r, color, seg = 6) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, 5), M(color));
  m.castShadow = true;
  return m;
}

export function buildGolfer(look) {
  const build = look.build || 'm';
  const ss = build === 'broad' ? 1.16 : build === 'f' ? 0.86 : 1; // shoulder scale
  const g = new THREE.Group();
  const J = {};

  // ---------- legs ----------
  const mkLeg = (side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.11, 0.84, 0);
    const thigh = cyl(0.075, 0.058, 0.38, look.pants);
    thigh.position.y = -0.19;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.38;
    const shin = cyl(0.054, 0.04, 0.38, look.pants);
    shin.position.y = -0.19;
    knee.add(shin);
    const ankle = new THREE.Group();
    ankle.position.y = -0.4;
    const shoe = box(0.11, 0.07, 0.26, '#f4f4f2');
    shoe.position.set(0, -0.03, 0.05);
    ankle.add(shoe);
    knee.add(ankle);
    hip.add(knee);
    g.add(hip);
    return { hip, knee, ankle };
  };
  const legL = mkLeg(-1);
  const legR = mkLeg(1);
  J.hipL = legL.hip;
  J.kneeL = legL.knee;
  J.ankleL = legL.ankle;
  J.hipR = legR.hip;
  J.kneeR = legR.knee;
  J.ankleR = legR.ankle;

  // ---------- pelvis / spine ----------
  const pelvis = new THREE.Group();
  pelvis.position.y = 0.88;
  const hips = box(0.3, 0.16, 0.2, look.pants);
  pelvis.add(hips);
  const belt = box(0.31, 0.04, 0.21, '#1a1a1e');
  belt.position.y = 0.09;
  pelvis.add(belt);
  g.add(pelvis);
  J.pelvis = pelvis;

  const spineL = new THREE.Group();
  spineL.position.y = 0.11;
  const belly = cyl(0.17 * ss, 0.15, 0.22, look.shirt);
  belly.position.y = 0.1;
  belly.scale.z = 0.78;
  spineL.add(belly);
  pelvis.add(spineL);
  J.spineL = spineL;

  const spineU = new THREE.Group();
  spineU.position.y = 0.2;
  const chest = cyl(0.21 * ss, 0.165 * ss, 0.3, look.shirt);
  chest.position.y = 0.14;
  chest.scale.z = 0.74;
  spineU.add(chest);
  for (const s of [-1, 1]) {
    const cap = sph(0.075, look.shirt);
    cap.position.set(s * 0.22 * ss, 0.24, 0);
    spineU.add(cap);
  }
  spineL.add(spineU);
  J.spineU = spineU;

  // ---------- neck / head ----------
  const neck = new THREE.Group();
  neck.position.y = 0.3;
  const neckM = cyl(0.05, 0.056, 0.09, look.skin);
  neckM.position.y = 0.04;
  neck.add(neckM);
  spineU.add(neck);
  J.neck = neck;

  const head = new THREE.Group();
  head.position.y = 0.19;
  const face = box(0.2, 0.22, 0.21, look.skin);
  head.add(face);
  const nose = box(0.045, 0.05, 0.05, look.skin);
  nose.position.set(0, -0.01, 0.12);
  head.add(nose);
  if (look.hair) {
    const hair = box(0.21, 0.15, 0.07, look.hair);
    hair.position.set(0, 0.02, -0.09);
    head.add(hair);
  }
  const hy = 0.13; // hat base height
  if (look.hatStyle === 'cap') {
    const crown = box(0.23, 0.09, 0.23, look.hat);
    crown.position.y = hy;
    const brim = box(0.21, 0.028, 0.15, look.hat);
    brim.position.set(0, hy - 0.03, 0.17);
    head.add(crown, brim);
  } else if (look.hatStyle === 'flat') {
    const crown = box(0.24, 0.08, 0.24, look.hat);
    crown.position.y = hy;
    const brim = box(0.3, 0.024, 0.3, look.hat);
    brim.position.y = hy - 0.035;
    head.add(crown, brim);
  } else if (look.hatStyle === 'bucket') {
    const crown = cyl(0.12, 0.14, 0.1, look.hat);
    crown.position.y = hy;
    const brim = cyl(0.2, 0.21, 0.025, look.hat, 10);
    brim.position.y = hy - 0.05;
    head.add(crown, brim);
  } else if (look.hatStyle === 'visor') {
    const band = cyl(0.125, 0.125, 0.05, look.hat, 8);
    band.position.y = hy - 0.02;
    const brim = box(0.2, 0.022, 0.14, look.hat);
    brim.position.set(0, hy - 0.03, 0.16);
    head.add(band, brim);
    if (look.hair) {
      const bun = sph(0.06, look.hair);
      bun.position.set(0, 0.1, -0.12);
      head.add(bun);
    }
  }
  if (build === 'f' && look.hair) {
    // ponytail
    const tail = cyl(0.035, 0.018, 0.3, look.hair, 5);
    tail.position.set(0, -0.1, -0.16);
    tail.rotation.x = 0.35;
    head.add(tail);
  }
  neck.add(head);
  J.head = head;

  // ---------- arms + club (root pivots at the chest) ----------
  const armsRoot = new THREE.Group();
  armsRoot.position.set(0, 0.22, 0.06);
  spineU.add(armsRoot);
  J.armsRoot = armsRoot;

  const mkArm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.24 * ss, 0.02, 0);
    shoulder.rotation.z = -side * 0.42; // hands converge toward the grip
    const upper = cyl(0.062, 0.05, 0.28, look.shirt);
    upper.position.y = -0.14;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.28;
    const fore = cyl(0.05, 0.038, 0.26, look.skin);
    fore.position.y = -0.13;
    elbow.add(fore);
    const wrist = new THREE.Group();
    wrist.position.y = -0.26;
    const hand = sph(0.05, look.skin);
    wrist.add(hand);
    elbow.add(wrist);
    shoulder.add(elbow);
    armsRoot.add(shoulder);
    return { shoulder, elbow, wrist };
  };
  const armL = mkArm(-1);
  const armR = mkArm(1);
  J.shoulderL = armL.shoulder;
  J.elbowL = armL.elbow;
  J.shoulderR = armR.shoulder;
  J.elbowR = armR.elbow;

  // club hangs from the grip point where the hands meet
  const club = new THREE.Group();
  club.position.set(0, -0.5, 0.03);
  const shaft = cyl(0.012, 0.012, 0.9, '#c9ccd1', 5);
  shaft.position.y = -0.45;
  club.add(shaft);
  const headC = box(0.055, 0.06, 0.16, '#33383f');
  headC.position.set(0, -0.9, 0.05);
  club.add(headC);
  armsRoot.add(club);
  J.club = club;

  g.traverse((o) => (o.castShadow = true));

  const rig = {
    group: g,
    J,
    look,
    swingPhase: 0,
    baseY: 0,
    _bob: Math.random() * 10,
  };
  setPose(rig, 0);
  return rig;
}

export function disposeGolfer(rig) {
  if (!rig) return;
  rig.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

// phase: 0 = address, negative = backswing amount (0..-1), positive = follow-through
export function setPose(rig, phase) {
  rig.swingPhase = phase;
  const J = rig.J;
  const b = Math.min(Math.max(-phase, 0), 1.2); // backswing amount
  const f = Math.min(Math.max(phase, 0), 1); // follow amount

  // spine: bent at address, rising through the finish
  J.spineL.rotation.x = 0.38 - f * 0.3;
  J.spineL.rotation.z = b * 0.06 - f * 0.1;

  // body coil
  J.pelvis.rotation.y = -b * 0.32 + f * 0.8;
  J.spineU.rotation.y = -b * 0.78 + f * 0.85;

  // eyes on the ball, then up to the target
  J.neck.rotation.y = (b * 0.78 + b * 0.32) * 0.72 - f * 0.5;
  J.neck.rotation.x = 0.12 - f * 0.25;

  // arms swing as a unit around the chest
  J.armsRoot.rotation.z = b * 2.2 - f * 2.5;
  J.armsRoot.rotation.x = 0.5 - b * 0.22 - f * 0.32;

  // elbows fold on their side of the swing, wrists cock the club
  J.elbowR.rotation.z = -b * 0.95;
  J.elbowL.rotation.z = f * 0.9;
  J.club.rotation.z = b * 1.0 - f * 0.55;
  J.club.rotation.x = 0.1 - f * 0.15;

  // legs: athletic flex; through impact the lead side posts up and the
  // trail heel releases
  J.hipL.rotation.x = -0.14;
  J.hipR.rotation.x = -0.14 + f * 0.28;
  J.kneeL.rotation.x = 0.26 - f * 0.2;
  J.kneeR.rotation.x = 0.26 + f * 0.55;
  J.ankleL.rotation.x = 0;
  J.ankleR.rotation.x = f * 0.85;
}

export function idleUpdate(rig, t) {
  const s = Math.sin(t * 1.7 + rig._bob) * 0.02;
  rig.J.spineL.rotation.x = 0.38 + s;
}

export function celebrateUpdate(rig, t) {
  const hop = Math.abs(Math.sin(t * 6)) * 0.25;
  rig.group.position.y = rig.baseY + hop;
  rig.group.rotation.y += 0.06;
  rig.J.spineL.rotation.x = 0.05;
  rig.J.armsRoot.rotation.x = -2.6 + Math.sin(t * 6) * 0.25;
  rig.J.armsRoot.rotation.z = 0;
  rig.J.elbowL.rotation.z = 0.3;
  rig.J.elbowR.rotation.z = -0.3;
  rig.J.neck.rotation.x = -0.25;
}

export function dejectedPose(rig) {
  setPose(rig, 0);
  rig.J.neck.rotation.x = 0.55;
  rig.J.spineL.rotation.x = 0.5;
  rig.J.armsRoot.rotation.x = 0.15;
  rig.J.armsRoot.rotation.z = 0;
  rig.J.club.rotation.z = 0;
}

// Scripted full swing for bots: returns a driver function you call each
// frame with elapsed seconds; fires onImpact once at the strike moment.
export function scriptedSwing(rig, onImpact) {
  const T_BACK = 0.55;
  const T_PAUSE = 0.12;
  const T_DOWN = 0.16;
  const T_FOLLOW = 0.5;
  let fired = false;
  return function (t) {
    if (t < T_BACK) {
      setPose(rig, -easeOut(t / T_BACK));
    } else if (t < T_BACK + T_PAUSE) {
      setPose(rig, -1);
    } else if (t < T_BACK + T_PAUSE + T_DOWN) {
      const k = (t - T_BACK - T_PAUSE) / T_DOWN;
      setPose(rig, -1 + k * 1.35);
      if (!fired && k > 0.72) {
        fired = true;
        onImpact && onImpact();
      }
    } else if (t < T_BACK + T_PAUSE + T_DOWN + T_FOLLOW) {
      const k = (t - T_BACK - T_PAUSE - T_DOWN) / T_FOLLOW;
      setPose(rig, 0.35 + easeOut(k) * 0.65);
    } else {
      return true; // done
    }
    return false;
  };
}

function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}
