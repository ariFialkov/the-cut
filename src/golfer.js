// Low-poly procedural golfers with distinct outfits and a hand-tuned
// swing pose rig (no skeletal animation — just grouped transforms).

import * as THREE from 'three';

export const ROSTER = [
  { name: 'You', shirt: '#e8453c', pants: '#22262e', skin: '#e8b48c', hat: '#ffffff' },
  { name: 'Marco Reyes', shirt: '#2f7fe0', pants: '#e9e4d6', skin: '#c98d5f', hat: '#173a63' },
  { name: 'Yuki Tanaka', shirt: '#f2f2f0', pants: '#3b3f4a', skin: '#f0c9a0', hat: '#e8453c' },
  { name: 'Sofia Lindqvist', shirt: '#18b9a5', pants: '#f5efdf', skin: '#f5d7b8', hat: '#0e7364' },
  { name: 'DJ Booker', shirt: '#8d4fd3', pants: '#1f2229', skin: '#8a5a3b', hat: '#f2a03d' },
];

function box(w, h, d, color) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color })
  );
  m.castShadow = true;
  return m;
}

export function buildGolfer(look) {
  const g = new THREE.Group();

  // legs
  const legL = box(0.16, 0.55, 0.18, look.pants);
  const legR = legL.clone();
  legL.position.set(-0.12, 0.28, 0);
  legR.position.set(0.12, 0.28, 0);
  // shoes
  const shoeL = box(0.18, 0.1, 0.3, '#f8f8f6');
  const shoeR = shoeL.clone();
  shoeL.position.set(-0.12, 0.05, 0.04);
  shoeR.position.set(0.12, 0.05, 0.04);

  // torso
  const torso = new THREE.Group();
  torso.position.y = 0.56;
  const chest = box(0.46, 0.5, 0.28, look.shirt);
  chest.position.y = 0.25;
  torso.add(chest);

  // head + cap
  const head = new THREE.Group();
  head.position.y = 0.66;
  const face = box(0.26, 0.26, 0.26, look.skin);
  const capTop = box(0.3, 0.1, 0.3, look.hat);
  capTop.position.y = 0.17;
  const capBrim = box(0.28, 0.04, 0.16, look.hat);
  capBrim.position.set(0, 0.12, 0.2);
  head.add(face, capTop, capBrim);
  torso.add(head);

  // arms + club as one swinging unit, pivoting at the chest
  const arms = new THREE.Group();
  arms.position.set(0, 0.42, 0.06);
  const armL = box(0.09, 0.42, 0.09, look.shirt);
  armL.position.set(-0.28, -0.18, 0.05);
  armL.rotation.z = -0.25;
  const armR = box(0.09, 0.42, 0.09, look.shirt);
  armR.position.set(0.28, -0.18, 0.05);
  armR.rotation.z = 0.25;
  const hands = box(0.1, 0.1, 0.1, look.skin);
  hands.position.set(0, -0.42, 0.12);
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 0.85, 5),
    new THREE.MeshLambertMaterial({ color: 0xc9ccd1 })
  );
  shaft.position.set(0, -0.82, 0.12);
  const headC = box(0.06, 0.07, 0.16, '#3a3f47');
  headC.position.set(0, -1.24, 0.16);
  arms.add(armL, armR, hands, shaft, headC);
  torso.add(arms);

  g.add(legL, legR, shoeL, shoeR, torso);
  g.traverse((o) => (o.castShadow = true));

  const rig = {
    group: g,
    torso,
    arms,
    head,
    look,
    swingPhase: 0, // -1 full backswing .. 0 address .. 1 follow-through
    _bob: Math.random() * 10,
  };
  setPose(rig, 0);
  return rig;
}

// phase: 0 = address, negative = backswing amount (0..-1), positive = follow-through
export function setPose(rig, phase) {
  rig.swingPhase = phase;
  if (phase <= 0) {
    const b = -phase; // 0..1 backswing
    rig.arms.rotation.x = 0.5 - 0.2 * b;
    rig.arms.rotation.z = b * 2.35;
    rig.torso.rotation.y = -b * 0.75;
    rig.torso.rotation.x = 0.16;
  } else {
    const f = Math.min(phase, 1); // follow-through
    rig.arms.rotation.x = 0.5 - 0.35 * f;
    rig.arms.rotation.z = -f * 2.6;
    rig.torso.rotation.y = f * 1.0;
    rig.torso.rotation.x = 0.16 - 0.1 * f;
  }
}

export function idleUpdate(rig, t) {
  rig.group.position.y += 0; // base position is managed by caller
  const s = Math.sin(t * 1.7 + rig._bob) * 0.02;
  rig.torso.rotation.x = 0.16 + s;
}

export function celebrateUpdate(rig, t) {
  const hop = Math.abs(Math.sin(t * 6)) * 0.25;
  rig.group.position.y = rig.baseY + hop;
  rig.group.rotation.y += 0.06;
  rig.arms.rotation.z = Math.sin(t * 6) * 0.6 - 2.4;
  rig.arms.rotation.x = -2.2;
}

export function dejectedPose(rig) {
  rig.head.rotation.x = 0.55;
  rig.torso.rotation.x = 0.35;
  rig.arms.rotation.x = 0.7;
  rig.arms.rotation.z = 0;
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
