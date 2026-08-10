// Low-poly golf cart. Faces +Z at identity; caller sets rotation.y to the
// heading and keeps the group on the terrain.

import * as THREE from 'three';

function M(color) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

function box(w, h, d, color) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(color));
  m.castShadow = true;
  return m;
}

export function buildCart(accent = '#e8453c') {
  const g = new THREE.Group();

  // chassis / floor
  const floor = box(1.1, 0.09, 1.9, '#f4f6f8');
  floor.position.y = 0.42;
  g.add(floor);

  // front hood
  const hood = box(1.05, 0.28, 0.5, '#f4f6f8');
  hood.position.set(0, 0.58, 0.72);
  g.add(hood);

  // dash + steering column
  const dash = box(0.95, 0.3, 0.1, accent);
  dash.position.set(0, 0.82, 0.5);
  g.add(dash);
  const wheelCol = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.05, 10), M('#2a2d33'));
  wheelCol.rotation.x = 1.15;
  wheelCol.position.set(0.24, 1.0, 0.42);
  g.add(wheelCol);

  // bench seat + backrest
  const seat = box(1.0, 0.12, 0.55, accent);
  seat.position.set(0, 0.72, -0.28);
  g.add(seat);
  const back = box(1.0, 0.42, 0.1, accent);
  back.position.set(0, 0.95, -0.58);
  g.add(back);
  // rear bag well
  const well = box(1.0, 0.3, 0.34, '#dfe3e8');
  well.position.set(0, 0.6, -0.78);
  g.add(well);

  // roof on posts
  const roof = box(1.15, 0.06, 1.6, '#f4f6f8');
  roof.position.set(0, 1.78, 0.05);
  g.add(roof);
  const postGeo = new THREE.CylinderGeometry(0.035, 0.035, 1.35, 6);
  const postMat = M('#c9ccd1');
  for (const [px, pz] of [
    [-0.52, 0.78],
    [0.52, 0.78],
    [-0.52, -0.62],
    [0.52, -0.62],
  ]) {
    const p = new THREE.Mesh(postGeo, postMat);
    p.position.set(px, 1.1, pz);
    p.castShadow = true;
    g.add(p);
  }

  // wheels
  const wheels = [];
  const wGeo = new THREE.CylinderGeometry(0.23, 0.23, 0.14, 10);
  const wMat = M('#26282c');
  const hubMat = M('#c9ccd1');
  for (const [wx, wz] of [
    [-0.56, 0.66],
    [0.56, 0.66],
    [-0.56, -0.62],
    [0.56, -0.62],
  ]) {
    const w = new THREE.Mesh(wGeo, wMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(wx, 0.23, wz);
    w.castShadow = true;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.15, 8), hubMat);
    w.add(hub);
    g.add(w);
    wheels.push(w);
  }

  // pontoons: stowed against the body, deploy in water
  const pontoons = [];
  const pGeo = new THREE.CapsuleGeometry(0.17, 1.55, 3, 8);
  pGeo.rotateX(Math.PI / 2);
  for (const side of [-1, 1]) {
    const p = new THREE.Mesh(pGeo, M('#f4f6f8'));
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 1.2), M(accent));
    stripe.position.y = 0.1;
    p.add(stripe);
    p.position.set(side * 0.62, 0.55, 0.02);
    p.scale.setScalar(0.01);
    p.visible = false;
    g.add(p);
    pontoons.push(p);
  }

  // golf bag with clubs in the rear well
  const bag = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.14, 0.55, 8), M(accent));
  bag.add(body);
  const pocket = new THREE.Mesh(new THREE.CylinderGeometry(0.175, 0.17, 0.16, 8), M('#1d2025'));
  pocket.position.y = -0.12;
  bag.add(pocket);
  for (let i = 0; i < 3; i++) {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.42, 5), M('#c9ccd1'));
    shaft.position.set((i - 1) * 0.07, 0.45, (i % 2) * 0.05 - 0.02);
    shaft.rotation.z = (i - 1) * 0.12;
    bag.add(shaft);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.09), M('#33383f'));
    head.position.set((i - 1) * 0.07 - (i - 1) * 0.025, 0.66, (i % 2) * 0.05 - 0.02);
    bag.add(head);
  }
  bag.position.set(0, 0.95, -0.8);
  bag.rotation.x = -0.22;
  g.add(bag);

  g.traverse((o) => (o.castShadow = true));

  return {
    group: g,
    wheels,
    pontoons,
    waterMix: 0,
    // spin wheels with travel (they freewheel slower as a boat)
    update(dist) {
      for (const w of wheels) w.rotation.x += (dist / 0.23) * (1 - this.waterMix * 0.8);
    },
    // 0 = cart, 1 = boat: wheels tuck up into the body, pontoons deploy
    setWater(f) {
      this.waterMix = f;
      for (const w of wheels) {
        w.position.y = 0.23 + f * 0.34;
        w.scale.setScalar(1 - f * 0.4);
      }
      for (const p of pontoons) {
        p.visible = f > 0.02;
        p.position.y = 0.55 - f * 0.45;
        const s = 0.01 + f * 0.99;
        p.scale.set(s, s, s);
      }
    },
  };
}

export function disposeCart(cart) {
  if (!cart) return;
  cart.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}
