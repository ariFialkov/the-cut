// The Cut — main orchestrator: renderer, camera, game state machine.

import * as THREE from 'three';
import { generateHole, disposeHole } from './course.js';
import { BallFlight, BALL_R, clubLaunchSpeed, simulateToRest, solveBotShot } from './physics.js';
import { CLUBS, recommendClubIndex, fmtDist, yd } from './clubs.js';
import { SwingController, shotFromMetrics } from './swing.js';
import {
  PLAYER_LOOK,
  BOT_BANK,
  buildGolfer,
  disposeGolfer,
  setPose,
  scriptedSwing,
  celebrateUpdate,
  dejectedPose,
  idleUpdate,
} from './golfer.js';
import { MULTS, BETS, WHEEL, loadBalance, saveBalance, makeRig, botDistances, finalStandings } from './economy.js';
import { UI, sleep, ICO } from './ui.js';
import { sfx } from './sfx.js';
import { mulberry32, clamp, lerp, shuffle } from './rng.js';

// ------------------------------------------------------------------
//  Renderer / scene
// ------------------------------------------------------------------

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const SKY = new THREE.Color('#8ecdf2');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 170, 430);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 900);
const BASE_FOV = 55;

const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x3d7a4a, 1.05);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff3d8, 1.7);
sun.position.set(70, 110, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -60;
sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60;
sun.shadow.camera.bottom = -60;
sun.shadow.camera.far = 320;
scene.add(sun);
scene.add(sun.target);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------
//  Camera rig: modes set a desired pos/look, loop damps toward it
// ------------------------------------------------------------------

const cam = {
  pos: new THREE.Vector3(0, 8, 20),
  look: new THREE.Vector3(0, 0, 0),
  curLook: new THREE.Vector3(0, 0, 0),
  update: null, // fn(dt) that writes pos/look
  damp: 4.5,
  shake: 0,
  fovKick: 0,
};

function setCam(fn, { snap = false, damp = 4.5 } = {}) {
  cam.update = fn;
  cam.damp = damp;
  if (fn) fn(0);
  if (snap) {
    camera.position.copy(cam.pos);
    cam.curLook.copy(cam.look);
  }
}

function shakeCam(amp) {
  cam.shake = Math.max(cam.shake, amp);
}

function punchFov(amount) {
  cam.fovKick = amount;
}

// ------------------------------------------------------------------
//  Shared meshes
// ------------------------------------------------------------------

const ballMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
function makeBallMesh() {
  const m = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 12, 10), ballMat);
  m.castShadow = true;
  return m;
}

const shadowBlob = new THREE.Mesh(
  new THREE.CircleGeometry(0.4, 16),
  new THREE.MeshBasicMaterial({ color: 0x06240f, transparent: true, opacity: 0.32 })
);
shadowBlob.rotation.x = -Math.PI / 2;
shadowBlob.visible = false;
scene.add(shadowBlob);

// aim target ring + guide line
const aimRing = new THREE.Mesh(
  new THREE.RingGeometry(1.0, 1.45, 28),
  new THREE.MeshBasicMaterial({ color: 0x35e07c, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
);
aimRing.rotation.x = -Math.PI / 2;
aimRing.visible = false;
scene.add(aimRing);

const guideGeo = new THREE.BufferGeometry();
guideGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 40), 3));
const guideLine = new THREE.Line(
  guideGeo,
  new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 1.2, gapSize: 1.1, transparent: true, opacity: 0.55 })
);
guideLine.visible = false;
scene.add(guideLine);

// ball flight trail
const TRAIL_MAX = 400;
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * TRAIL_MAX), 3));
const trailLine = new THREE.Line(
  trailGeo,
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 })
);
trailLine.frustumCulled = false;
trailLine.visible = false;
scene.add(trailLine);
let trailCount = 0;

function trailReset() {
  trailCount = 0;
  trailGeo.setDrawRange(0, 0);
  trailLine.visible = false;
}

function trailPush(p) {
  if (trailCount >= TRAIL_MAX) return;
  trailGeo.attributes.position.setXYZ(trailCount++, p.x, p.y, p.z);
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.setDrawRange(0, trailCount);
  trailLine.visible = true;
}

// splash / puff rings
const fxRings = [];
function spawnRing(pos, color, maxScale = 4, dur = 0.6) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.55, 20),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.copy(pos);
  m.position.y += 0.06;
  scene.add(m);
  fxRings.push({ m, t: 0, dur, maxScale });
}

// confetti
let confetti = null;
function spawnConfetti(center) {
  const N = 160;
  const geo = new THREE.BoxGeometry(0.09, 0.02, 0.14);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), N);
  const items = [];
  const cc = new THREE.Color();
  const palette = ['#ffd24a', '#35e07c', '#ff5a4e', '#4aa8ff', '#ff9ff3'];
  for (let i = 0; i < N; i++) {
    items.push({
      p: new THREE.Vector3(
        center.x + (Math.random() - 0.5) * 6,
        center.y + 4 + Math.random() * 5,
        center.z + (Math.random() - 0.5) * 6
      ),
      v: new THREE.Vector3((Math.random() - 0.5) * 2, -1 - Math.random() * 1.5, (Math.random() - 0.5) * 2),
      r: new THREE.Euler(Math.random() * 3, Math.random() * 3, Math.random() * 3),
      w: new THREE.Vector3(Math.random() * 4, Math.random() * 4, Math.random() * 4),
    });
    mesh.setColorAt(i, cc.set(palette[i % palette.length]));
  }
  scene.add(mesh);
  confetti = { mesh, items, t: 0 };
}

// ------------------------------------------------------------------
//  Game state
// ------------------------------------------------------------------

const DBG = new URLSearchParams(location.search).has('debug');
const dlog = (...a) => DBG && console.log('[cut]', ...a);

const ui = new UI();
let balance = loadBalance();
ui.setBalance(balance);

const playerRig = buildGolfer(PLAYER_LOOK);
playerRig.group.visible = false;
scene.add(playerRig.group);
let botRigs = []; // rebuilt each game from the 4 drawn bank looks

function botLook(bi) {
  return game.botLooks[bi];
}

function allRigs() {
  return [playerRig, ...botRigs];
}

let hole = null; // current hole
let holePreview = null; // hole 1, generated at menu time
let gameSeed = 0;
let phase = 'menu'; // menu | aim | swing | flight | bots | board | done
let aimTheta = 0;
let aimHold = 0;
let clubIdx = 6;
let playerBall = makeBallMesh();
playerBall.visible = false;
scene.add(playerBall);
let botBalls = [];
let activeFlight = null;
let flightResolve = null;
let botShots = []; // in-flight bot balls: {flight, ball, bi}
let gateMarkers = [];
let wheelObj = null;
let timeScale = 1; // 2 while the fast-forward button is held
let swingTween = null;
let celebrating = null;
let dejected = null;
let clockT = 0;

// debug/test hook
window.__thecut = {
  forceFinish: 0, // test-only: fix the drawn finishing position (1..5)
  get phase() {
    return phase;
  },
  get balance() {
    return balance;
  },
  autoSwing(q = 1) {
    if (phase !== 'aim') return false;
    onStrike(
      {
        backFrac: 0.95 * q + 0.4 * (1 - q),
        angleDeg: (1 - q) * 14,
        wobble: (1 - q) * 0.6,
        paceRatio: 1 + (1 - q) * 0.5,
        scatter: (1 - q) * 0.5,
        strokeMs: 300,
      },
      []
    );
    return true;
  },
  startGame(bet) {
    if (phase === 'menu') startGame(bet || ui.bet);
  },
  // test-only: swap in a fresh random hole and view it from above
  galleryHole(idx = 0, low = false) {
    if (phase !== 'menu') return null;
    gameSeed = (Math.random() * 0xffffffff) >>> 0;
    if (holePreview) {
      scene.remove(holePreview.group);
      disposeHole(holePreview);
    }
    holePreview = generateHole(gameSeed, idx % 5);
    scene.add(holePreview.group);
    hole = holePreview;
    setCam(
      () => {
        if (low) {
          cam.pos.set(hole.tee.x, hole.tee.y + 3.2, hole.tee.z + 9);
          cam.look.set(hole.pin.x, hole.pin.y + 2, hole.pin.z);
        } else {
          cam.pos.set(hole.tee.x + 30, Math.max(hole.tee.y, hole.pin.y) + 60, 42);
          cam.look.set(hole.pin.x * 0.5, (hole.tee.y + hole.pin.y) / 2, hole.pin.z * 0.55);
        }
      },
      { snap: true, damp: 99 }
    );
    return { archetype: hole.archetype, name: hole.name };
  },
};

// ------------------------------------------------------------------
//  Input: aiming + clubs + swing
// ------------------------------------------------------------------

const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (phase === 'aim') {
    if (e.code === 'KeyQ') changeClub(-1);
    if (e.code === 'KeyE') changeClub(1);
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));

function bindHold(el, dir) {
  const on = (e) => {
    e.preventDefault();
    aimHold = dir;
    el.classList.add('held');
  };
  const off = () => {
    if (aimHold === dir) aimHold = 0;
    el.classList.remove('held');
  };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('pointerleave', off);
}
bindHold(ui.el.aimLeft, -1);
bindHold(ui.el.aimRight, 1);

ui.el.clubPrev.addEventListener('click', () => changeClub(-1));
ui.el.clubNext.addEventListener('click', () => changeClub(1));

// hold-to-fast-forward (2x) while shots play out
{
  const el = ui.el.ffwd;
  const on = (e) => {
    e.preventDefault();
    timeScale = 2;
    el.classList.add('held');
  };
  const off = () => {
    timeScale = 1;
    el.classList.remove('held');
  };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('pointerleave', off);
}

const swingCtl = new SwingController(canvas, {
  onStart() {
    sfx.unlock();
  },
  onProgress(backFrac, pts, ph) {
    if (phase !== 'aim') return;
    setPose(playerRig, -Math.min(backFrac, 1));
    ui.drawTrail(pts, ph);
  },
  onStrike(metrics, pts) {
    if (phase !== 'aim') return;
    ui.clearTrail();
    onStrike(metrics, pts);
  },
  onCancel() {
    ui.clearTrail();
    if (phase === 'aim') setPose(playerRig, 0);
  },
});

function changeClub(d) {
  clubIdx = clamp(clubIdx + d, 0, CLUBS.length - 1);
  refreshAimUI();
  sfx.click();
}

// ------------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);

function baseAimDir() {
  const d = new THREE.Vector3().subVectors(hole.pin, playerBall.position);
  d.y = 0;
  return d.normalize();
}

function aimDir() {
  return baseAimDir().applyAxisAngle(UP, -aimTheta);
}

function pinDistOf(pos) {
  return Math.hypot(pos.x - hole.pin.x, pos.z - hole.pin.z);
}

function effectiveDist() {
  const d = pinDistOf(playerBall.position);
  const elev = hole.pin.y - playerBall.position.y;
  const windAlong = hole.wind.dot(baseAimDir());
  return d + elev * 0.9 - windAlong * 2.2;
}

function placeGolfer(rig, ballPos, dir) {
  const left = new THREE.Vector3().crossVectors(UP, dir).normalize();
  const gx = ballPos.x + left.x * 0.62;
  const gz = ballPos.z + left.z * 0.62;
  rig.group.position.set(gx, hole.heightAt(gx, gz), gz);
  const face = new THREE.Vector3().crossVectors(dir, UP).normalize();
  rig.group.rotation.set(0, Math.atan2(face.x, face.z), 0);
  rig.baseY = rig.group.position.y;
}

function placeGolferAtBall(rig, dir) {
  placeGolfer(rig, playerBall.position, dir);
}

function clearGates() {
  gateMarkers.forEach((m) => {
    scene.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  });
  gateMarkers = [];
}

// Line every remaining golfer up across the tee box, each in their own
// gate flagged by tee markers in their color. The player takes the middle.
function buildGates() {
  clearGates();
  const n = game.aliveBots.length + 1;
  const mid = Math.floor(n / 2);
  const order = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (i === mid) order.push('P');
    else order.push(game.aliveBots[k++]);
  }
  const spacing = 1.9;
  game.gates = new Map();
  order.forEach((id, i) => {
    const x = (i - (n - 1) / 2) * spacing;
    game.gates.set(id, x);
    const look = id === 'P' ? PLAYER_LOOK : botLook(id);
    for (const s of [-0.55, 0.55]) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 6),
        new THREE.MeshLambertMaterial({ color: look.shirt })
      );
      m.position.set(x + s, hole.heightAt(x + s, 0.9) + 0.1, 0.9);
      scene.add(m);
      gateMarkers.push(m);
    }
  });
}

function botTeePos(bi) {
  const gx = game.gates.get(bi);
  return new THREE.Vector3(gx, hole.heightAt(gx, 0) + BALL_R, 0);
}

function golferToGate(bi) {
  const rig = botRigs[bi];
  const p = botTeePos(bi);
  const dir = new THREE.Vector3(hole.pin.x - p.x, 0, hole.pin.z - p.z).normalize();
  placeGolfer(rig, p, dir);
  setPose(rig, 0);
}

function refreshAimUI() {
  const club = CLUBS[clubIdx];
  ui.setClub(club);
  ui.setPinDist(pinDistOf(playerBall.position));
  // target ring at expected carry along aim
  const dir = aimDir();
  const carry = Math.min(club.carry, 260);
  const t = new THREE.Vector3().copy(playerBall.position).addScaledVector(dir, carry);
  t.y = hole.heightAt(t.x, t.z) + 0.08;
  aimRing.position.copy(t);
  aimRing.visible = true;
  const pts = guideGeo.attributes.position;
  for (let i = 0; i < 40; i++) {
    const f = i / 39;
    const gx = playerBall.position.x + dir.x * carry * f;
    const gz = playerBall.position.z + dir.z * carry * f;
    pts.setXYZ(i, gx, hole.heightAt(gx, gz) + 0.15, gz);
  }
  pts.needsUpdate = true;
  guideLine.computeLineDistances();
  guideLine.visible = true;
}

function hideAimUI() {
  aimRing.visible = false;
  guideLine.visible = false;
}

function aimCam(dt) {
  const dir = aimDir();
  const p = playerBall.position;
  cam.pos.set(p.x - dir.x * 7.5, p.y + 3.2, p.z - dir.z * 7.5);
  // keep the camera above terrain behind the tee
  const minY = hole.heightAt(cam.pos.x, cam.pos.z) + 1.6;
  if (cam.pos.y < minY) cam.pos.y = minY;
  cam.look.set(p.x + dir.x * 26, p.y + 1.5, p.z + dir.z * 26);
}

function windRelDeg() {
  const f = new THREE.Vector3();
  camera.getWorldDirection(f);
  const a = Math.atan2(f.x * hole.wind.z - f.z * hole.wind.x, f.x * hole.wind.x + f.z * hole.wind.z);
  return (a * 180) / Math.PI;
}

// ------------------------------------------------------------------
//  Menu
// ------------------------------------------------------------------

function newMap() {
  gameSeed = (Math.random() * 0xffffffff) >>> 0;
  if (hole && hole !== holePreview) {
    scene.remove(hole.group);
    disposeHole(hole);
    hole = null;
  }
  if (holePreview) {
    scene.remove(holePreview.group);
    disposeHole(holePreview);
  }
  holePreview = generateHole(gameSeed, 0);
  scene.add(holePreview.group);
  hole = holePreview;
  ui.setMenuHoleInfo(
    `Hole 1 · “${hole.name}” · ${yd(hole.length)} yd · wind ${Math.round(hole.windSpeed * 2.237)} mph`
  );
}

function menuState() {
  phase = 'menu';
  ui.showMenu();
  ui.setBalance(balance);
  ui.showFfwd(false);
  timeScale = 1;
  allRigs().forEach((r) => (r.group.visible = false));
  playerBall.visible = false;
  shadowBlob.visible = false;
  botBalls.forEach((b) => scene.remove(b));
  botBalls = [];
  botShots = [];
  clearGates();
  clearWheel();
  hideAimUI();
  trailReset();
  if (!holePreview) newMap();
  hole = holePreview;
  // show the player waiting on the tee box
  playerRig.group.visible = true;
  playerRig.group.position.set(0.8, hole.heightAt(0.8, 0.5), 0.5);
  playerRig.group.rotation.set(0, Math.PI, 0);
  setPose(playerRig, 0);
  playerRig.baseY = playerRig.group.position.y;
  // slow orbit around the tee box
  setCam(
    (dt) => {
      const a = clockT * 0.12;
      cam.pos.set(Math.sin(a) * 13, hole.tee.y + 5.5, Math.cos(a) * 13);
      const minY = hole.heightAt(cam.pos.x, cam.pos.z) + 2;
      if (cam.pos.y < minY) cam.pos.y = minY;
      cam.look.set(hole.pin.x * 0.3, hole.tee.y + 1, hole.pin.z * 0.25);
    },
    { snap: true, damp: 2 }
  );
}

ui.el.btnPlay.addEventListener('click', () => {
  if (phase !== 'menu') return;
  if (balance < BETS[0]) {
    balance = 1000;
    saveBalance(balance);
    ui.setBalance(balance);
    ui.toast('Stake refilled — 1000 coins');
    sfx.cash();
    return;
  }
  sfx.chipIn();
  startGame(ui.bet);
});

// ------------------------------------------------------------------
//  Game driver
// ------------------------------------------------------------------

let game = null;

async function startGame(bet) {
  if (balance < bet) {
    ui.toast('Not enough coins');
    return;
  }
  balance -= bet;
  saveBalance(balance);
  ui.setBalance(balance);

  const grng = mulberry32((gameSeed ^ 0xbe77) >>> 0);
  let rig = makeRig(grng);
  const ff = window.__thecut && window.__thecut.forceFinish;
  if (ff >= 1 && ff <= 5) {
    while (rig.playerFinish !== ff) rig = makeRig(grng);
  }
  const fsw = window.__thecut && window.__thecut.forceSemiWinner;
  if (fsw === 'P') rig.semiWinnerIsPlayer = rig.playerFinish === 2;
  else if (fsw === 'B') rig.semiWinnerIsPlayer = false;

  // draw this game's field from the bank and build their rigs
  const botLooks = shuffle(grng, BOT_BANK).slice(0, 4);
  botRigs.forEach((r) => {
    scene.remove(r.group);
    disposeGolfer(r);
  });
  botRigs = botLooks.map((look) => {
    const r = buildGolfer(look);
    r.group.visible = false;
    scene.add(r.group);
    return r;
  });

  game = {
    bet,
    rng: grng,
    rig,
    botLooks,
    aliveBots: [0, 1, 2, 3],
    playerAlive: true,
    holeIdx: 0,
    openerDone: false,
    dists: new Map(),
  };
  phase = 'lobby';
  await ui.runLobby([PLAYER_LOOK, ...game.botLooks], 0);
  ui.showHud();

  dlog('rig', JSON.stringify(game.rig));
  // holes 1-4: closest to the pin, furthest is cut
  for (let i = 0; i < 4; i++) {
    game.holeIdx = i;
    dlog('hole', i + 1, 'start');
    await loadHole(i);
    await flyover(i);
    // finals: the semifinal winner has earned the second slot. If that's
    // the player, the bot opens the head-to-head.
    if (i === 3 && game.rig.semiWinnerIsPlayer) {
      await finalsBotOpener();
    }
    await takeShot();
    await botsPhase();
    await boardPhase();
    dlog('hole', i + 1, 'done, playerAlive =', game.playerAlive);
    if (!game.playerAlive) break;
  }

  if (game.playerAlive) {
    game.holeIdx = 4;
    await championHole();
  }
  await showResults();
}

async function loadHole(i) {
  if (hole && hole !== holePreview) {
    scene.remove(hole.group);
    disposeHole(hole);
  }
  if (i === 0 && holePreview) {
    hole = holePreview;
  } else {
    if (holePreview && i > 0) {
      scene.remove(holePreview.group);
      disposeHole(holePreview);
      holePreview = null;
    }
    hole = generateHole(gameSeed, i);
    scene.add(hole.group);
  }
  // clean per-hole objects
  botBalls.forEach((b) => scene.remove(b));
  botBalls = [];
  botShots = [];
  clearWheel();
  trailReset();
  hideAimUI();
  game.dists = new Map();
  game.pendingOutcome = null;
  game.botVolley = null;
  game.openerDone = false;

  // golfers into their gates, player ball on their tee
  playerRig.group.visible = true;
  botRigs.forEach((r, bi) => {
    r.group.visible = game.aliveBots.includes(bi);
  });
  buildGates();
  const px = game.gates.get('P');
  playerBall.position.set(px, hole.heightAt(px, 0) + BALL_R, 0);
  playerBall.visible = true;
  placeGolferAtBall(playerRig, baseAimDir());
  for (const bi of game.aliveBots) golferToGate(bi);

  sun.target.position.set(hole.pin.x, 0, hole.pin.z / 2);

  aimTheta = 0;
  clubIdx = recommendClubIndex(effectiveDist());
  ui.setHole(i + 1, hole.name, hole.length);
  ui.setStep(i, game.playerAlive ? -1 : game.holeIdx);
}

async function flyover(i) {
  phase = 'flyover';
  ui.setControlsVisible(false);
  const start = performance.now();
  const dur = 2600;
  const from = new THREE.Vector3(hole.pin.x, hole.pin.y + 26, hole.pin.z - 34);
  const mid = new THREE.Vector3(hole.pin.x * 0.4, Math.max(hole.pin.y, hole.tee.y) + 30, hole.pin.z * 0.45);
  const to = new THREE.Vector3(0, hole.tee.y + 6, 13);
  setCam(
    () => {
      const t = clamp((performance.now() - start) / dur, 0, 1);
      const e = t * t * (3 - 2 * t);
      if (e < 0.5) {
        cam.pos.lerpVectors(from, mid, e * 2);
      } else {
        cam.pos.lerpVectors(mid, to, (e - 0.5) * 2);
      }
      cam.look.lerpVectors(hole.pin, new THREE.Vector3(0, hole.tee.y + 1, 0), e * 0.85);
    },
    { snap: true, damp: 99 }
  );
  const windMph = Math.round(hole.windSpeed * 2.237);
  await ui.showBanner(
    `HOLE ${i + 1}`,
    `“${hole.name}” · ${yd(hole.length)} yd · wind ${windMph} mph`,
    2400
  );
}

let shotDone = null; // resolver for the current player shot

function takeShot() {
  return new Promise((res) => {
    shotDone = res;
    beginAim();
  });
}

function beginAim() {
  phase = 'aim';
  ui.setControlsVisible(true);
  ui.setStep(game.holeIdx, -1);
  refreshAimUI();
  setPose(playerRig, 0);
  placeGolferAtBall(playerRig, aimDir());
  setCam(aimCam, { damp: 5 });
  swingCtl.setEnabled(true);
}

// player strike -> physics flight
function onStrike(metrics, _pts) {
  if (phase !== 'aim') return;
  phase = 'flight';
  swingCtl.setEnabled(false);
  ui.setControlsVisible(false);
  hideAimUI();

  const club = CLUBS[clubIdx];
  const shot = shotFromMetrics(metrics, club, clubLaunchSpeed(club), Math.random);

  // fx
  sfx.strike(shot.quality);
  shakeCam(0.12 + shot.quality * 0.35);
  punchFov(4 + shot.quality * 6);
  const gradeColor =
    shot.grade === 'PURE!' ? '#ffd24a' : shot.quality > 0.75 ? '#35e07c' : shot.quality > 0.5 ? '#fff' : '#ff8a7f';
  ui.showFeedback(shot.grade, gradeColor);

  // golfer follow-through
  swingTween = { t: 0, rig: playerRig };

  const dir = aimDir().applyAxisAngle(UP, (-shot.pushDeg * Math.PI) / 180);
  const flightParams = {
    pos: playerBall.position.clone(),
    dir,
    v0: shot.v0,
    loftDeg: shot.loftDeg,
    curveDeg: shot.curveDeg,
    wind: hole.wind,
    hole,
  };
  activeFlight = new BallFlight(flightParams);
  trailReset();
  ui.showFfwd(true);

  // Integration is deterministic, so we know the outcome the moment the
  // ball is struck — which lets the whole field tee off simultaneously.
  const predicted = simulateToRest(flightParams);
  game.pendingOutcome = officialize(predicted);
  dlog('predicted:', game.pendingOutcome.dist.toFixed(1) + 'm', game.pendingOutcome.wet ? 'WET' : '');
  if (game.holeIdx < 4 && game.aliveBots.length > 1) {
    scheduleBotVolley(game.pendingOutcome.dist);
  }

  // chase cam
  setCam(
    () => {
      const p = playerBall.position;
      const v = activeFlight ? activeFlight.vel : null;
      const d = new THREE.Vector3(v ? v.x : dir.x, 0, v ? v.z : dir.z);
      if (d.lengthSq() < 0.01) d.copy(dir);
      d.normalize();
      cam.pos.set(p.x - d.x * 11, p.y + 4.5, p.z - d.z * 11);
      const minY = hole.heightAt(cam.pos.x, cam.pos.z) + 1.2;
      if (cam.pos.y < minY) cam.pos.y = minY;
      cam.look.copy(p);
    },
    { damp: 3.2 }
  );

  new Promise((res) => (flightResolve = res)).then((result) => afterLanding(result));
}

function handleFlightEvents(events) {
  for (const e of events) {
    if (e.type === 'bounce') {
      shakeCam(0.08);
      sfx.bounce();
      spawnRing(e.pos, e.surf === 'sand' ? 0xd8c68f : 0xffffff, 2, 0.4);
    } else if (e.type === 'splash') {
      sfx.splash();
      shakeCam(0.15);
      spawnRing(e.pos, 0x9fd8ff, 5, 0.9);
    }
  }
}

// Turn a resting position into the player's official outcome, applying
// the water penalty and the lip-out / ace rules. Called at strike time on
// the predicted result so the bots can be scripted before the ball lands.
function officialize(result) {
  let dist = pinDistOf(result.pos);
  let wet = false;
  let ace = false;
  let lipOut = false;

  if (result.inWater) {
    wet = true;
    dist = dist + 27; // splash penalty
  } else {
    // lip-out insurance: if the script says the player goes out this hole,
    // nothing may beat them — an "ace" becomes a heartbreaker instead.
    const elimPos = 5 - game.holeIdx;
    const mustLose = game.holeIdx < 4 && game.rig.playerFinish === elimPos;
    if (dist < 0.55 && mustLose) {
      dist = 0.6 + Math.random() * 0.3;
      lipOut = true;
    } else if (dist < 0.55) {
      ace = true;
      dist = 0.05;
    }
  }
  return { dist, wet, ace, lipOut };
}

async function afterLanding(result) {
  const o = game.pendingOutcome || officialize(result);
  const { dist, wet, ace, lipOut } = o;
  if (lipOut) {
    ui.showFeedback('LIPPED OUT!', '#ff8a7f', 1600);
    sfx.groan();
  } else if (ace) {
    sfx.cheer();
    spawnConfetti(hole.pin);
  }
  game.dists.set('P', { dist, wet, ace });
  dlog('player shot:', dist.toFixed(1) + 'm', wet ? 'WET' : '', ace ? 'ACE' : '');

  const surf = wet ? 'water' : hole.surfaceAt(result.pos.x, result.pos.z);
  if (!wet && (surf === 'green' || surf === 'fringe')) sfx.onGreen();
  ui.showShotResult(
    ace ? 'ACE!!' : wet ? `${ICO.wet} splash — ${fmtDist(dist)} w/ penalty` : `${fmtDist(dist)} from the pin`
  );

  // linger on the landing spot
  const lp = result.pos.clone();
  setCam(
    () => {
      cam.pos.set(lp.x + 6, Math.max(lp.y, hole.heightAt(lp.x + 6, lp.z + 9)) + 4, lp.z + 9);
      cam.look.copy(lp);
    },
    { damp: 2.2 }
  );
  await sleep(1900);

  if (shotDone) {
    const r = shotDone;
    shotDone = null;
    r({ dist, wet, ace });
  }
}

// ------------------------------------------------------------------
//  Bots
// ------------------------------------------------------------------

function pickLanding(dist) {
  // a point `dist` from the pin, biased back toward the tee
  const a0 = Math.atan2(hole.tee.x - hole.pin.x, hole.tee.z - hole.pin.z);
  let best = null;
  for (let i = 0; i < 16; i++) {
    const a = a0 + (Math.random() - 0.5) * 2.4;
    const x = hole.pin.x + Math.sin(a) * dist;
    const z = hole.pin.z + Math.cos(a) * dist;
    if (Math.abs(x) > hole.halfW - 4 || z < hole.zMin + 4 || z > hole.zMax - 4) continue;
    const s = hole.surfaceAt(x, z);
    if (s !== 'water') return { x, z, water: false };
    if (!best) best = { x, z, water: true };
  }
  return best || { x: hole.pin.x, z: hole.pin.z + dist, water: false };
}

// Solve a real physics shot for a bot whose FINAL resting distance from
// the pin must respect the script's ordering constraints. Retries with an
// adjusted target if the bounce-and-roll lands on the wrong side of the
// player; as a last resort the official (scored) number is clamped — the
// visual gap is under a metre and imperceptible.
function solveBotConstrained(start, targetDist, c) {
  let t = Math.max(0.35, targetDist);
  let res = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const land = pickLanding(t);
    const s = solveBotShot({
      start,
      targetPoint: new THREE.Vector3(land.x, 0, land.z),
      hole,
      wind: hole.wind,
      loftDeg: 26 + Math.random() * 12,
      curveDeg: (Math.random() - 0.5) * 4,
    });
    const wet = s.sim.inWater;
    const dist = wet ? targetDist : pinDistOf(s.sim.pos);
    res = { start, dir: s.dir, v0: s.v0, loftDeg: s.loftDeg, curveDeg: s.curveDeg, official: { dist, wet } };
    const both = c.lessThan !== undefined && c.greaterThan !== undefined;
    if (c.lessThan !== undefined && dist >= c.lessThan) {
      t = both ? (c.greaterThan + c.lessThan) / 2 : Math.max(0.35, Math.min(t * 0.7, c.lessThan - 1.2));
      continue;
    }
    if (c.greaterThan !== undefined && dist <= c.greaterThan) {
      t = both ? (c.greaterThan + c.lessThan) / 2 : c.greaterThan + 2.5 + attempt * 2.5;
      continue;
    }
    break;
  }
  if (c.lessThan !== undefined && c.greaterThan !== undefined) {
    res.official.dist = clamp(
      res.official.dist,
      c.greaterThan + 0.05,
      Math.max(c.greaterThan + 0.1, c.lessThan - 0.05)
    );
  } else if (c.lessThan !== undefined) {
    res.official.dist = Math.min(res.official.dist, Math.max(0.15, c.lessThan - 0.05));
  } else if (c.greaterThan !== undefined) {
    res.official.dist = Math.max(res.official.dist, c.greaterThan + 0.05);
  }
  return res;
}

async function botSwingAndLaunch(bi, solved, delay) {
  const rig = botRigs[bi];
  const ball = makeBallMesh();
  ball.position.copy(solved.start);
  scene.add(ball);
  botBalls.push(ball);
  await sleep(delay * 1000);
  placeGolfer(rig, solved.start, solved.dir);
  const driver = scriptedSwing(rig, () => {
    sfx.strike(0.4 + Math.random() * 0.4);
    botShots.push({ flight: new BallFlight({ ...solved, pos: solved.start, wind: hole.wind, hole }), ball, bi });
  });
  await runTask((t) => driver(t));
}

// The whole field hits together: called at the player's strike, with the
// player's (pre-simulated) official distance already known. Swings are
// staggered across ~a second so it doesn't look robotic.
function scheduleBotVolley(playerDist) {
  const script = botDistances(game.rig, game.holeIdx, playerDist, game.aliveBots, game.rng);
  const elimPos = 5 - game.holeIdx;
  const playerOut = game.rig.playerFinish === elimPos;
  const outBot = game.aliveBots.find((bi) => game.rig.botFinish[bi] === elimPos);
  const jobs = [];

  if (playerOut) {
    for (const bi of game.aliveBots) {
      const solved = solveBotConstrained(botTeePos(bi), script.get(bi), { lessThan: playerDist - 0.3 });
      game.dists.set(bi, solved.official);
      jobs.push(botSwingAndLaunch(bi, solved, 0.15 + Math.random() * 0.85));
    }
  } else {
    let survivorMax = 0;
    // the semifinal decides finals honors: the drawn semifinal winner must
    // actually finish closer, so pin the surviving bot to the right side
    const semiFinal = game.holeIdx === 2 && game.rig.playerFinish <= 2;
    for (const bi of game.aliveBots) {
      if (bi === outBot) continue;
      let c = { lessThan: script.get(outBot) - 0.8 };
      if (semiFinal) {
        c = game.rig.semiWinnerIsPlayer
          ? { greaterThan: playerDist + 0.3, lessThan: script.get(outBot) - 0.8 }
          : { lessThan: Math.min(playerDist - 0.3, script.get(outBot) - 0.8) };
      }
      const solved = solveBotConstrained(botTeePos(bi), script.get(bi), c);
      game.dists.set(bi, solved.official);
      survivorMax = Math.max(survivorMax, solved.official.dist);
      jobs.push(botSwingAndLaunch(bi, solved, 0.15 + Math.random() * 0.85));
    }
    const floor = Math.max(playerDist, survivorMax);
    const solved = solveBotConstrained(botTeePos(outBot), Math.max(script.get(outBot), floor + 2), {
      greaterThan: floor + 0.3,
    });
    game.dists.set(outBot, solved.official);
    jobs.push(botSwingAndLaunch(outBot, solved, 0.15 + Math.random() * 0.85));
  }
  game.botVolley = Promise.all(jobs);
}

function waitBotFlightsDone() {
  return new Promise((res) => {
    const id = setInterval(() => {
      if (botShots.every((s) => s.flight.done)) {
        clearInterval(id);
        res();
      }
    }, 120);
  });
}

// Finals opener when the PLAYER won the semifinal and hits second: the
// bot strikes first — and sticks it dead, inside the lip-out floor, so
// the scripted result can never be beaten by the answering shot.
async function finalsBotOpener() {
  phase = 'bots';
  const bi = game.aliveBots[0];
  const rig = botRigs[bi];
  const start = botTeePos(bi);
  const target = 0.28 + game.rng() * 0.2; // always under the 0.6m lip-out floor
  const solved = solveBotConstrained(start, target, { lessThan: 0.52 });
  game.dists.set(bi, solved.official);
  dlog('finals opener:', botLook(bi).name, solved.official.dist.toFixed(2) + 'm');

  const ball = makeBallMesh();
  ball.position.copy(start);
  scene.add(ball);
  botBalls.push(ball);
  placeGolfer(rig, start, solved.dir);

  setCam(
    () => {
      cam.pos.set(start.x - solved.dir.x * 7.5, start.y + 3.2, start.z - solved.dir.z * 7.5);
      const minY = hole.heightAt(cam.pos.x, cam.pos.z) + 1.4;
      if (cam.pos.y < minY) cam.pos.y = minY;
      cam.look.set(start.x + solved.dir.x * 25, start.y + 1, start.z + solved.dir.z * 25);
    },
    { damp: 6 }
  );
  ui.showShotResult(`${botLook(bi).name} has honors — you answer last`, 2200);
  await sleep(1200);

  const driver = scriptedSwing(rig, () => {
    sfx.strike(0.9);
    shakeCam(0.12);
    botShots.push({ flight: new BallFlight({ ...solved, pos: start, wind: hole.wind, hole }), ball, bi });
    setCam(
      () => {
        const p = ball.position;
        const d = new THREE.Vector3(solved.dir.x, 0, solved.dir.z);
        cam.pos.set(p.x - d.x * 11, p.y + 4.5, p.z - d.z * 11);
        const minY = hole.heightAt(cam.pos.x, cam.pos.z) + 1.2;
        if (cam.pos.y < minY) cam.pos.y = minY;
        cam.look.copy(p);
      },
      { damp: 3.2 }
    );
  });
  await runTask((t) => driver(t));
  await waitBotFlightsDone();
  sfx.cheer();
  ui.showShotResult(`${botLook(bi).name} — ${fmtDist(solved.official.dist)}!! Beat that.`, 2600);
  await sleep(1800);
  game.openerDone = true;
}

// Head-to-head finale: the player has already hit; the last bot answers
// alone with the camera on them.
async function finalDuelBotShot() {
  const bi = game.aliveBots[0];
  const rig = botRigs[bi];
  const playerDist = game.dists.get('P').dist;
  const script = botDistances(game.rig, game.holeIdx, playerDist, game.aliveBots, game.rng);
  const playerOut = game.rig.playerFinish === 5 - game.holeIdx;
  const start = botTeePos(bi);
  const c = playerOut ? { lessThan: playerDist - 0.3 } : { greaterThan: playerDist + 0.3 };
  const solved = solveBotConstrained(start, script.get(bi), c);
  game.dists.set(bi, solved.official);

  const ball = makeBallMesh();
  ball.position.copy(start);
  scene.add(ball);
  botBalls.push(ball);
  placeGolfer(rig, start, solved.dir);

  setCam(
    () => {
      cam.pos.set(start.x - solved.dir.x * 7.5, start.y + 3.2, start.z - solved.dir.z * 7.5);
      const minY = hole.heightAt(cam.pos.x, cam.pos.z) + 1.4;
      if (cam.pos.y < minY) cam.pos.y = minY;
      cam.look.set(start.x + solved.dir.x * 25, start.y + 1, start.z + solved.dir.z * 25);
    },
    { damp: 6 }
  );
  ui.showShotResult(`${botLook(bi).name} needs to beat ${fmtDist(playerDist)}`, 2200);
  await sleep(1100);

  const driver = scriptedSwing(rig, () => {
    sfx.strike(0.8);
    shakeCam(0.1);
    const fl = new BallFlight({ ...solved, pos: start, wind: hole.wind, hole });
    botShots.push({ flight: fl, ball, bi });
    setCam(
      () => {
        const p = ball.position;
        const d = new THREE.Vector3(solved.dir.x, 0, solved.dir.z);
        cam.pos.set(p.x - d.x * 11, p.y + 4.5, p.z - d.z * 11);
        const minY = hole.heightAt(cam.pos.x, cam.pos.z) + 1.2;
        if (cam.pos.y < minY) cam.pos.y = minY;
        cam.look.copy(p);
      },
      { damp: 3.2 }
    );
  });
  await runTask((t) => driver(t));
  await waitBotFlightsDone();
  ui.showShotResult(
    `${botLook(bi).name} — ${solved.official.wet ? ICO.wet + ' ' : ''}${fmtDist(solved.official.dist)}`,
    1600
  );
  await sleep(1400);
}

async function botsPhase() {
  if (game.holeIdx >= 4 || !game.aliveBots.length) return;
  phase = 'bots';
  if (game.openerDone) {
    // finals bot already hit before the player; nothing left to play out
    ui.showFfwd(false);
    timeScale = 1;
    return;
  }
  if (game.aliveBots.length === 1) {
    await finalDuelBotShot();
  } else {
    await game.botVolley;
    await waitBotFlightsDone();
    await sleep(400);
  }
  ui.showFfwd(false);
  timeScale = 1;
}

// generic frame-driven task
const tasks = [];
function runTask(fn) {
  return new Promise((res) => tasks.push({ fn, t: 0, res }));
}

// ------------------------------------------------------------------
//  Leaderboard / cut
// ------------------------------------------------------------------

async function boardPhase() {
  phase = 'board';
  const entries = [];
  const pd = game.dists.get('P');
  entries.push({ id: 'P', ...pd });
  for (const bi of game.aliveBots) entries.push({ id: bi, ...game.dists.get(bi) });
  entries.sort((a, b) => a.dist - b.dist);
  const cutEntry = entries[entries.length - 1];
  dlog('board:', entries.map((e) => `${e.id}:${e.dist.toFixed(1)}`).join(' '), '| cut:', cutEntry.id);

  // slow pan over the green while the board shows
  setCam(
    () => {
      const a = clockT * 0.25;
      cam.pos.set(hole.pin.x + Math.sin(a) * 16, hole.pin.y + 9, hole.pin.z + Math.cos(a) * 16);
      cam.look.copy(hole.pin);
    },
    { damp: 2 }
  );

  const rows = entries.map((e) => ({
    name: e.id === 'P' ? 'You' : botLook(e.id).name,
    color: e.id === 'P' ? PLAYER_LOOK.shirt : botLook(e.id).shirt,
    dist: e.dist,
    isPlayer: e.id === 'P',
    wet: e.wet,
    ace: e.ace,
    cut: e === cutEntry,
  }));
  await ui.showBoard(`HOLE ${game.holeIdx + 1} — CLOSEST TO PIN`, rows, true);
  await sleep(900);
  sfx.cut();

  if (cutEntry.id === 'P') {
    game.playerAlive = false;
    dejected = playerRig;
    dejectedPose(playerRig);
    await sleep(700);
    ui.hideBoard();
    ui.setStep(game.holeIdx, game.holeIdx);
    await ui.showBanner('CUT', 'the field played closer — you’re out', 2200);
  } else {
    game.aliveBots = game.aliveBots.filter((b) => b !== cutEntry.id);
    botRigs[cutEntry.id].group.visible = false;
    await sleep(1000);
    ui.hideBoard();
    const name = botLook(cutEntry.id).name;
    await ui.showBanner('SAFE', `${name} misses the cut`, 1900);
  }
}

// ------------------------------------------------------------------
//  The Wheel (Champion's Hole) + results
// ------------------------------------------------------------------

const WHEEL_COLORS = {
  1: ['#1e7a3c', '#27904a'],
  1.25: ['#2f7fe0'],
  1.5: ['#8d4fd3'],
  2: ['#f2a03d'],
  5: ['#ffd24a'],
};

function makeWheelLabel(text, color) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.font = '900 88px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 64);
  const tex = new THREE.CanvasTexture(c);
  return new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 2.2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  );
}

function clearWheel() {
  if (!wheelObj) return;
  scene.remove(wheelObj.group);
  wheelObj.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
  wheelObj = null;
}

// A giant prize wheel laid into the final green. Spins while you play the
// hole; wherever your ball rests, the wheel brakes so the pre-drawn
// sector ends up underneath it.
function buildWheel() {
  clearWheel();
  const R = hole.greenR - 1.2;
  const N = WHEEL.length;
  const seg = (Math.PI * 2) / N;
  const group = new THREE.Group();
  for (let k = 0; k < N; k++) {
    const geo = new THREE.CircleGeometry(R, 10, k * seg, seg);
    geo.rotateX(-Math.PI / 2);
    const v = WHEEL[k];
    const cols = WHEEL_COLORS[v];
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: cols[k % cols.length] }));
    group.add(mesh);
    const a = (k + 0.5) * seg;
    const holder = new THREE.Group();
    holder.rotation.y = a - Math.PI / 2;
    const label = makeWheelLabel('×' + v, v >= 2 ? '#221b06' : '#ffffff');
    label.rotation.x = -Math.PI / 2;
    label.position.set(0, 0.05, -R * 0.68);
    holder.add(label);
    group.add(holder);
  }
  const hub = new THREE.Mesh(
    new THREE.CircleGeometry(R * 0.15, 20).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x0c1512 })
  );
  hub.position.y = 0.04;
  group.add(hub);
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(R, R + 0.8, 48).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0xf5f5f5 })
  );
  rim.position.y = 0.02;
  group.add(rim);
  group.position.set(hole.greenCenter.x, hole.pin.y + 0.07, hole.greenCenter.z);
  scene.add(group);
  wheelObj = { group, R, seg, spinning: true, speed: 1.1 };
}

async function resolveWheel() {
  const c = wheelObj.group.position;
  const offWheel =
    game.pendingOutcome.wet ||
    Math.hypot(playerBall.position.x - c.x, playerBall.position.z - c.z) > wheelObj.R - 0.3;

  if (offWheel) {
    // missed the wheel — champion still gets a spin: free drop
    ui.toast('Missed the wheel — free drop, every champion spins');
    const ang = Math.random() * Math.PI * 2;
    const r = wheelObj.R * (0.35 + Math.random() * 0.5);
    const to = new THREE.Vector3(c.x + Math.cos(ang) * r, 0, c.z + Math.sin(ang) * r);
    to.y = hole.heightAt(to.x, to.z) + BALL_R;
    const from = playerBall.position.clone();
    playerBall.visible = true;
    await runTask((t) => {
      const k = Math.min(1, t / 0.8);
      playerBall.position.lerpVectors(from, to, k);
      playerBall.position.y = lerp(from.y, to.y, k) + Math.sin(Math.PI * k) * 6;
      return k >= 1;
    });
    spawnRing(to, 0xffffff, 2, 0.4);
    sfx.bounce();
  }

  // overhead camera on the wheel
  setCam(
    () => {
      cam.pos.set(c.x + 2, c.y + 30, c.z + 15);
      cam.look.copy(c);
    },
    { damp: 2.5 }
  );
  await sleep(700);

  // brake the wheel so the drawn sector stops under the ball
  const bp = playerBall.position;
  const phi = Math.atan2(bp.z - c.z, bp.x - c.x);
  const aK = (game.rig.wheelIdx + 0.5) * wheelObj.seg;
  const cur = wheelObj.group.rotation.y;
  let target = -phi - aK;
  target = cur + ((((target - cur) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) + Math.PI * 8;
  wheelObj.spinning = false;
  let lastTick = cur;
  await runTask((t) => {
    const k = Math.min(1, t / 5.2);
    const e = 1 - Math.pow(1 - k, 3);
    const ry = lerp(cur, target, e);
    if (ry - lastTick > wheelObj.seg) {
      lastTick = ry;
      sfx.click();
    }
    wheelObj.group.rotation.y = ry;
    return k >= 1;
  });

  const wv = WHEEL[game.rig.wheelIdx];
  game.wheelResult = wv;
  dlog('wheel:', wv);
  if (wv >= 1.5) {
    sfx.cheer();
    spawnConfetti(bp);
  } else {
    sfx.onGreen();
  }
  await ui.showBanner(
    `WHEEL ×${wv}`,
    wv >= 5 ? 'JACKPOT!' : wv > 1 ? 'bonus on the champion’s prize' : 'no bonus — still the champion',
    2800
  );
}

async function championHole() {
  await loadHole(4);
  ui.setStep(4, -1);
  buildWheel();
  await flyover(4);
  await ui.showBanner('BONUS — THE WHEEL', 'shoot the wheel · every sector multiplies your prize', 2400);
  await takeShot();
  ui.showFfwd(false);
  timeScale = 1;
  await resolveWheel();
  celebrating = playerRig;
  sfx.win();
  setCam(
    () => {
      const a = clockT * 0.5;
      const p = playerRig.group.position;
      cam.pos.set(p.x + Math.sin(a) * 6, p.y + 2.5, p.z + Math.cos(a) * 6);
      cam.look.set(p.x, p.y + 1, p.z);
    },
    { damp: 3 }
  );
  await sleep(2600);
}

async function showResults() {
  phase = 'done';
  celebrating = null;
  dejected = null;
  const pos = game.rig.playerFinish;
  const wheelMult = pos === 1 ? game.wheelResult || WHEEL[game.rig.wheelIdx] : 0;
  const payout = pos === 1 ? game.bet * MULTS[0] * wheelMult : game.bet * MULTS[pos - 1];
  if (payout > 0) {
    balance += payout;
    saveBalance(balance);
    sfx.cash();
  }
  ui.setBalance(balance);

  const standings = finalStandings(game.rig).map((s) => ({
    pos: s.pos,
    isPlayer: s.id === 'P',
    name: s.id === 'P' ? 'You' : botLook(s.id).name,
    color: s.id === 'P' ? PLAYER_LOOK.shirt : botLook(s.id).shirt,
    // a winning bot's shown prize uses the wheel's expected value (x1.5)
    prize: s.id === 'P' ? payout : game.bet * MULTS[s.pos - 1] * (s.pos === 1 ? 1.5 : 1),
  }));

  ui.showResults({
    pos,
    payout,
    bet: game.bet,
    balance,
    standings,
    wheel: pos === 1 ? wheelMult : null,
    onAgain: () => {
      newMap();
      menuState();
      if (balance >= ui.bet) startGame(ui.bet);
    },
    onMenu: () => {
      newMap();
      menuState();
    },
  });
}

// ------------------------------------------------------------------
//  Main loop
// ------------------------------------------------------------------

const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  clockT += dt;

  // aiming input
  if (phase === 'aim') {
    const dir = (keys.has('KeyA') ? -1 : 0) + (keys.has('KeyD') ? 1 : 0) + aimHold;
    if (dir !== 0) {
      aimTheta = clamp(aimTheta + dir * dt * 0.55, -0.62, 0.62);
      refreshAimUI();
      placeGolferAtBall(playerRig, aimDir());
    }
    ui.setWind(hole.windSpeed * 2.237, windRelDeg());
    aimRing.scale.setScalar(1 + Math.sin(clockT * 4) * 0.08);
  }

  // player physics flight
  if (activeFlight) {
    const events = activeFlight.step(dt * timeScale);
    playerBall.position.copy(activeFlight.pos);
    trailPush(activeFlight.pos);
    handleFlightEvents(events);
    if (activeFlight.done) {
      const f = activeFlight;
      activeFlight = null;
      if (flightResolve) {
        const r = flightResolve;
        flightResolve = null;
        r({ pos: f.pos.clone(), inWater: !!f.inWater });
      }
    }
  }

  // bot physics flights
  for (const s of botShots) {
    if (s.flight.done) continue;
    const ev = s.flight.step(dt * timeScale);
    s.ball.position.copy(s.flight.pos);
    for (const e of ev) {
      if (e.type === 'splash') {
        sfx.splash();
        spawnRing(e.pos, 0x9fd8ff, 4, 0.8);
        s.ball.visible = false;
      } else if (e.type === 'bounce' && e.speed > 4) {
        spawnRing(e.pos, 0xffffff, 1.4, 0.3);
      }
    }
  }

  // the wheel idles while it hasn't been resolved
  if (wheelObj && wheelObj.spinning) {
    wheelObj.group.rotation.y += wheelObj.speed * dt;
  }

  // ball ground shadow
  if (playerBall.visible) {
    const h = hole ? hole.heightAt(playerBall.position.x, playerBall.position.z) : 0;
    shadowBlob.visible = true;
    shadowBlob.position.set(playerBall.position.x, h + 0.03, playerBall.position.z);
    const alt = clamp(playerBall.position.y - h, 0, 40);
    shadowBlob.scale.setScalar(1 + alt * 0.05);
    shadowBlob.material.opacity = 0.34 / (1 + alt * 0.12);
  } else {
    shadowBlob.visible = false;
  }

  // swing follow-through tween
  if (swingTween) {
    swingTween.t += dt;
    const k = Math.min(1, swingTween.t / 0.16);
    setPose(swingTween.rig, -1 + k * 2);
    if (k >= 1) swingTween = null;
  }

  // frame tasks (bot swings, wheel spin-down, drop animations)
  for (let i = tasks.length - 1; i >= 0; i--) {
    const task = tasks[i];
    task.t += dt * timeScale;
    if (task.fn(task.t, dt)) {
      tasks.splice(i, 1);
      task.res();
    }
  }

  // fx rings
  for (let i = fxRings.length - 1; i >= 0; i--) {
    const r = fxRings[i];
    r.t += dt;
    const k = r.t / r.dur;
    if (k >= 1) {
      scene.remove(r.m);
      r.m.geometry.dispose();
      r.m.material.dispose();
      fxRings.splice(i, 1);
    } else {
      r.m.scale.setScalar(1 + k * r.maxScale);
      r.m.material.opacity = 0.9 * (1 - k);
    }
  }

  // confetti
  if (confetti) {
    confetti.t += dt;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    confetti.items.forEach((it, i) => {
      it.p.addScaledVector(it.v, dt);
      it.r.x += it.w.x * dt;
      it.r.y += it.w.y * dt;
      it.r.z += it.w.z * dt;
      q.setFromEuler(it.r);
      m4.compose(it.p, q, new THREE.Vector3(1, 1, 1));
      confetti.mesh.setMatrixAt(i, m4);
    });
    confetti.mesh.instanceMatrix.needsUpdate = true;
    if (confetti.t > 6) {
      scene.remove(confetti.mesh);
      confetti.mesh.geometry.dispose();
      confetti = null;
    }
  }

  // character idle/celebrate
  allRigs().forEach((r) => {
    if (!r.group.visible) return;
    if (celebrating === r) celebrateUpdate(r, clockT);
    else if (dejected !== r && phase !== 'aim' && !swingTween) idleUpdate(r, clockT);
  });

  // camera
  if (cam.update) cam.update(dt);
  const k = 1 - Math.exp(-dt * cam.damp);
  camera.position.lerp(cam.pos, cam.damp > 20 ? 1 : k);
  cam.curLook.lerp(cam.look, cam.damp > 20 ? 1 : k);
  if (cam.shake > 0.002) {
    camera.position.x += (Math.random() - 0.5) * cam.shake;
    camera.position.y += (Math.random() - 0.5) * cam.shake;
    camera.position.z += (Math.random() - 0.5) * cam.shake;
    cam.shake *= Math.exp(-dt * 7);
  }
  camera.lookAt(cam.curLook);
  if (cam.fovKick > 0.05) {
    cam.fovKick *= Math.exp(-dt * 6);
  }
  camera.fov = BASE_FOV + cam.fovKick;
  camera.updateProjectionMatrix();

  renderer.render(scene, camera);
}

// ------------------------------------------------------------------
//  Boot
// ------------------------------------------------------------------

newMap();
menuState();
frame();
