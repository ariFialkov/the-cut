// The Cut — main orchestrator: renderer, camera, game state machine.

import * as THREE from 'three';
import { generateHole, disposeHole } from './course.js';
import { BallFlight, BALL_R, clubLaunchSpeed, simulateToRest, solveBotShot } from './physics.js';
import { CLUBS, PUTTER_IDX, isWedge, STYLES, recommendClubIndex, fmtDist, yd } from './clubs.js';
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
import { UI, sleep, ICO, fmtTime } from './ui.js';
import { buildCart, disposeCart } from './cart.js';
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

// neon "YOU" beacon floating over the player's ball while driving
let youSign = null;
function buildYouSign() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 160;
  const ctx = c.getContext('2d');
  ctx.textAlign = 'center';
  ctx.shadowColor = '#35e07c';
  ctx.shadowBlur = 26;
  ctx.fillStyle = '#c8ffdd';
  ctx.font = '900 78px sans-serif';
  ctx.fillText('YOU', 128, 78);
  ctx.beginPath();
  ctx.moveTo(104, 104);
  ctx.lineTo(152, 104);
  ctx.lineTo(128, 144);
  ctx.closePath();
  ctx.fillStyle = '#35e07c';
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  // fog:false — the beacon must stay full-strength at any distance
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false })
  );
  sprite.scale.set(6, 3.75, 1);
  const group = new THREE.Group();
  group.add(sprite);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.4, 13, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x35e07c,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    })
  );
  beam.position.y = -7;
  group.add(beam);
  group.visible = false;
  scene.add(group);
  return { group, sprite };
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
let wedgeStyle = 'chip'; // chip | flop | bump, resets each shot
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
let playerCart = null; // {cart, arriveResolve} while driving
let raceState = null; // hole-3 time race state
const MODES = ['ctp', 'strokes', 'race', 'ctp', 'wheel'];
const GIMME_R = 1.1; // inside this = automatic tap-in
const HOLED_R = 0.55; // inside this = in the hole
// putts get a friendlier cup: inside ~3ft drops, inside ~6.5ft is a gimme
const PUTT_HOLED_R = 0.95;
const PUTT_GIMME_R = 2.0;
let celebrating = null;
let dejected = null;
let clockT = 0;

// debug/test hook
window.__thecut = {
  forceFinish: 0, // test-only: fix the drawn finishing position (1..5)
  autopilot: false, // test-only: cart steers itself to the ball
  get phase() {
    return phase;
  },
  get balance() {
    return balance;
  },
  get cartWater() {
    return playerCart ? playerCart.cart.waterMix : 0;
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
    if (e.code === 'KeyS' && isWedge(CLUBS[clubIdx])) {
      const order = ['chip', 'flop', 'bump'];
      wedgeStyle = order[(order.indexOf(wedgeStyle) + 1) % order.length];
      sfx.click();
      refreshAimUI();
    }
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
    const amp = CLUBS[clubIdx].id === 'PT' ? 0.22 : 1; // putts are compact
    setPose(playerRig, -Math.min(backFrac, 1) * amp);
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
  const pinD = pinDistOf(playerBall.position);
  const style = isWedge(club) ? STYLES[wedgeStyle] : null;
  const carryEst = club.id === 'PT' ? pinD : club.carry * (style ? style.carryMul : 1);
  ui.setClub(club, carryEst, style && style.key !== 'chip' ? style.label : null);
  ui.setStyleRow(isWedge(club) ? wedgeStyle : null, (pick) => {
    wedgeStyle = pick;
    sfx.click();
    refreshAimUI();
  });
  ui.setPinDist(pinD);
  // target ring at expected carry along aim
  const dir = aimDir();
  const carry = Math.min(carryEst, 260);
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
  const urlSeed = new URLSearchParams(location.search).get('seed');
  gameSeed =
    window.__thecut && window.__thecut.forceSeed
      ? window.__thecut.forceSeed >>> 0
      : urlSeed
        ? urlSeed >>> 0
        : (Math.random() * 0xffffffff) >>> 0;
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
  raceState = null;
  clearRaceCarts();
  if (playerCart) {
    scene.remove(playerCart.cart.group);
    disposeCart(playerCart.cart);
    playerCart = null;
  }
  ui.setStrokeInfo(null);
  ui.setRaceTimer(null);
  ui.setStatusRows(null);
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
  // hole 1: closest to pin · hole 2: stroke play · hole 3: time race ·
  // hole 4: head-to-head closest to pin. Furthest/most/slowest is cut.
  for (let i = 0; i < 4; i++) {
    game.holeIdx = i;
    dlog('hole', i + 1, 'start');
    await loadHole(i);
    await flyover(i);
    if (game.mode === 'strokes') {
      await strokePlayLoop();
    } else if (game.mode === 'race') {
      await raceLoop();
    } else {
      // finals: the semifinal winner has earned the second slot. If that's
      // the player, the bot opens the head-to-head.
      if (i === 3 && game.rig.semiWinnerIsPlayer) {
        await finalsBotOpener();
      }
      await takeShot();
      await botsPhase();
    }
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
  game.mode = MODES[i];
  game.playerStrokes = 0;
  game.playerHoled = false;
  game.playerTeeCarry = 0;
  game.botPlay = null;
  raceState = null;
  clearRaceCarts();
  if (playerCart) {
    scene.remove(playerCart.cart.group);
    disposeCart(playerCart.cart);
    playerCart = null;
  }
  ui.setStrokeInfo(null);
  ui.setRaceTimer(null);
  ui.setStatusRows(null);

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
  ui.setHole(i + 1, hole.name, hole.length, hole.par);
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
  const modeTag =
    game && game.mode === 'strokes'
      ? 'STROKE PLAY — most strokes is cut · '
      : game && game.mode === 'race'
        ? 'TIME RACE — slowest to hole out is cut · '
        : '';
  await ui.showBanner(
    `HOLE ${i + 1}`,
    `${modeTag}“${hole.name}” · par ${hole.par} · ${yd(hole.length)} yd · wind ${windMph} mph`,
    game && (game.mode === 'strokes' || game.mode === 'race') ? 3000 : 2400
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
  aimTheta = 0;
  wedgeStyle = 'chip';
  // fresh caddie pick per lie — on the putting surface it's the putter
  const surf = hole.surfaceAt(playerBall.position.x, playerBall.position.z);
  const fullMode = game.mode === 'strokes' || game.mode === 'race';
  clubIdx =
    fullMode && (surf === 'green' || surf === 'fringe')
      ? PUTTER_IDX
      : recommendClubIndex(effectiveDist());
  refreshAimUI();
  setPose(playerRig, 0);
  placeGolferAtBall(playerRig, aimDir());
  setCam(aimCam, { damp: 5 });
  swingCtl.setEnabled(true);
}

// A putt is pure roll: backswing length is the throttle, calibrated so a
// full stroke runs ~1.35x the distance to the cup. The green's real slopes
// then break the ball on its way.
function puttFromMetrics(m, pinDist) {
  const maxRoll = Math.max(4, pinDist * 1.35);
  const p = clamp(0.12 + 0.92 * Math.min(m.backFrac, 1.1), 0.1, 1.2);
  let roll = maxRoll * p;
  roll *= 1 - 0.12 * m.wobble; // chunky stroke comes up short
  roll *= 1 + clamp(m.paceRatio - 1, -0.4, 0.6) * 0.1;
  const v0 = Math.sqrt(2 * 2.7 * roll);
  const pushDeg = clamp(m.angleDeg * 0.3, -5, 5) + (Math.random() * 2 - 1) * m.scatter * 2.2;
  const quality = 1 - clamp(0.5 * m.wobble + 0.3 * m.scatter + 0.2 * Math.abs(m.paceRatio - 1), 0, 1);
  const grade =
    quality > 0.85
      ? 'PURE ROLL'
      : m.wobble > 0.5
        ? 'Wobbled'
        : m.paceRatio > 1.35
          ? 'Charged!'
          : m.paceRatio < 0.65
            ? 'Babied'
            : 'Rolled';
  return { v0, loftDeg: 1, curveDeg: 0, pushDeg, power: p, quality, grade };
}

// player strike -> physics flight
function onStrike(metrics, _pts) {
  if (phase !== 'aim') return;
  phase = 'flight';
  swingCtl.setEnabled(false);
  ui.setControlsVisible(false);
  hideAimUI();

  const club = CLUBS[clubIdx];
  const putting = club.id === 'PT';
  let shot;
  if (putting) {
    shot = puttFromMetrics(metrics, pinDistOf(playerBall.position));
  } else {
    const style = isWedge(club) ? STYLES[wedgeStyle] : STYLES.chip;
    const effClub = { ...club, loft: clamp(club.loft * style.loftMul, 6, 72) };
    shot = shotFromMetrics(metrics, effClub, clubLaunchSpeed(club) * style.v0Mul, Math.random);
  }

  // fx
  if (putting) {
    sfx.bounce();
    shakeCam(0.05);
    punchFov(1.5);
  } else {
    sfx.strike(shot.quality);
    shakeCam(0.12 + shot.quality * 0.35);
    punchFov(4 + shot.quality * 6);
  }
  const gradeColor =
    shot.grade === 'PURE!' ? '#ffd24a' : shot.quality > 0.75 ? '#35e07c' : shot.quality > 0.5 ? '#fff' : '#ff8a7f';
  ui.showFeedback(shot.grade, gradeColor);

  // golfer follow-through
  swingTween = { t: 0, rig: playerRig, amp: putting ? 0.22 : 1 };

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
  ui.showFfwd(game.mode !== 'race'); // in the race, time IS the score

  // Integration is deterministic, so we know the outcome the moment the
  // ball is struck — which lets the whole field play simultaneously.
  const predicted = simulateToRest(flightParams);
  if (game.mode === 'ctp' || game.mode === 'wheel') {
    game.pendingOutcome = officialize(predicted);
    dlog('predicted:', game.pendingOutcome.dist.toFixed(1) + 'm', game.pendingOutcome.wet ? 'WET' : '');
    if (game.holeIdx === 0 && game.aliveBots.length > 1) {
      scheduleBotVolley(game.pendingOutcome.dist);
    }
  } else {
    game.pendingFull = predicted;
    game.lastShotPutt = putting;
    const gimme = putting ? PUTT_GIMME_R : GIMME_R;
    const predHoled = !predicted.inWater && pinDistOf(predicted.pos) < gimme;
    if (game.mode === 'strokes') {
      launchBotStrokesRound(predicted, predHoled);
    } else if (game.mode === 'race' && predHoled) {
      raceForceFinishFastBots();
    }
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

// Find a dry drop spot walking back from a splash toward the tee.
function dropPoint(entry) {
  const dir = new THREE.Vector3().subVectors(hole.tee, entry);
  dir.y = 0;
  const len = dir.length();
  dir.normalize();
  for (let d = 4; d < len; d += 2.5) {
    const x = entry.x + dir.x * d;
    const z = entry.z + dir.z * d;
    if (hole.surfaceAt(x, z) !== 'water' && !hole.inWaterZone(x, z)) {
      return new THREE.Vector3(x, hole.heightAt(x, z) + BALL_R, z);
    }
  }
  return hole.tee.clone().add(new THREE.Vector3(0, BALL_R, 0));
}

// sink the player ball into the cup with a short roll
async function sinkPlayerBall() {
  const from = playerBall.position.clone();
  const d = pinDistOf(from);
  if (d > 0.1) {
    await runTask((t) => {
      const k = Math.min(1, t / Math.min(1.0, 0.25 + d * 0.35));
      playerBall.position.lerpVectors(from, hole.pin, k);
      playerBall.position.y = hole.heightAt(playerBall.position.x, playerBall.position.z) + BALL_R;
      return k >= 1;
    });
  }
  playerBall.visible = false;
  spawnRing(hole.pin, 0xffffff, 1.5, 0.4);
  sfx.onGreen();
}

// Full-hole resolution (stroke play & race): counts strokes, handles the
// gimme, water penalty drops, and holing out.
async function afterLandingFull(result) {
  const dist = pinDistOf(result.pos);
  let holed = false;
  game.playerStrokes++;
  const putt = !!game.lastShotPutt;
  const holedR = putt ? PUTT_HOLED_R : HOLED_R;
  const gimmeR = putt ? PUTT_GIMME_R : GIMME_R;

  if (game.playerStrokes === 1) {
    game.playerTeeCarry = Math.hypot(result.pos.x - hole.tee.x, result.pos.z - hole.tee.z);
  }

  if (result.inWater) {
    game.playerStrokes++; // penalty
    ui.showFeedback('PENALTY +1', '#ff8a7f', 1500);
    const drop = dropPoint(result.pos);
    await sleep(900);
    playerBall.visible = true;
    playerBall.position.copy(drop);
    spawnRing(drop, 0xffffff, 1.5, 0.4);
    ui.showShotResult(`${ICO.wet} drop — hitting ${game.playerStrokes + 1}`, 1800);
  } else if (dist < holedR) {
    holed = true;
    ui.showFeedback(game.playerStrokes === 1 ? 'ACE!!' : 'IN THE HOLE!', '#ffd24a', 1700);
    sfx.cheer();
    await sinkPlayerBall();
  } else if (dist < gimmeR) {
    holed = true;
    game.playerStrokes++; // the tap-in
    ui.showFeedback('GIMME', '#35e07c', 1400);
    await sinkPlayerBall();
  } else {
    ui.showShotResult(`${fmtDist(dist)} out — hitting ${game.playerStrokes + 1}`, 1800);
  }

  if (!holed && game.playerStrokes >= 7) {
    // mercy pickup
    holed = true;
    game.playerStrokes = 8;
    ui.showFeedback('PICKED UP', '#ff8a7f', 1500);
  }

  if (holed) {
    game.playerHoled = true;
    if (game.mode === 'race' && raceState) {
      raceState.playerTime = raceState.t;
      dlog('player race time:', fmtTime(raceState.playerTime));
    }
  }
  ui.setStrokeInfo(
    game.mode === 'strokes' ? `STROKE ${Math.min(game.playerStrokes + 1, 8)}` : null
  );

  await sleep(holed ? 1200 : 800);
  if (shotDone) {
    const r = shotDone;
    shotDone = null;
    r({ holed, pos: result.pos });
  }
}

async function afterLanding(result) {
  if (game.mode === 'strokes' || game.mode === 'race') {
    return afterLandingFull(result);
  }
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
    for (const bi of game.aliveBots) {
      if (bi === outBot) continue;
      const solved = solveBotConstrained(botTeePos(bi), script.get(bi), {
        lessThan: script.get(outBot) - 0.8,
      });
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

// ------------------------------------------------------------------
//  Hole 2: stroke play (full hole, most strokes is cut)
// ------------------------------------------------------------------

const doomedStrokesBot = () => game.aliveBots.find((bi) => game.rig.botFinish[bi] === 4);

// a point `distFromPin` from the pin, biased toward refPos, avoiding water
function pickPointFrom(refPos, distFromPin) {
  const a0 = Math.atan2(refPos.x - hole.pin.x, refPos.z - hole.pin.z);
  let best = null;
  for (let i = 0; i < 14; i++) {
    const a = a0 + (Math.random() - 0.5) * 1.6;
    const x = hole.pin.x + Math.sin(a) * distFromPin;
    const z = hole.pin.z + Math.cos(a) * distFromPin;
    if (Math.abs(x) > hole.halfW - 4 || z < hole.zMin + 4 || z > hole.zMax - 4) continue;
    const p = new THREE.Vector3(x, 0, z);
    if (hole.surfaceAt(x, z) !== 'water' && !hole.inWaterZone(x, z)) return p;
    if (!best) best = p;
  }
  return best || new THREE.Vector3(hole.pin.x, 0, hole.pin.z + distFromPin);
}

function initBotPlay() {
  game.botPlay = new Map();
  for (const bi of game.aliveBots) {
    const ball = makeBallMesh();
    ball.position.copy(botTeePos(bi));
    scene.add(ball);
    botBalls.push(ball);
    game.botPlay.set(bi, { strokes: 0, holed: false, pos: botTeePos(bi), teeCarry: 0, ball });
  }
}

function updateStrokeStatus() {
  if (game.mode !== 'strokes' || !game.botPlay) return;
  const rows = [];
  for (const bi of game.aliveBots) {
    const st = game.botPlay.get(bi);
    rows.push({
      color: botLook(bi).shirt,
      done: st.holed,
      text: st.holed ? `IN · ${st.strokes}` : `S${st.strokes}`,
    });
  }
  ui.setStatusRows(rows);
}

async function botStrokeVisualHoleOut(bi, st) {
  const from = st.ball.position.clone();
  const d = pinDistOf(from);
  const dur = Math.min(2.0, 0.5 + d * 0.05);
  st.ball.visible = true;
  await runTask((t) => {
    const k = Math.min(1, t / dur);
    st.ball.position.lerpVectors(from, hole.pin, k);
    const h = hole.heightAt(st.ball.position.x, st.ball.position.z) + BALL_R;
    st.ball.position.y = h + Math.sin(Math.PI * k) * Math.min(3, d * 0.12);
    return k >= 1;
  });
  st.ball.visible = false;
  spawnRing(hole.pin, 0xffffff, 1.5, 0.4);
  sfx.onGreen();
  st.holed = true;
  // done for the day: stand off at the fringe instead of vanishing
  const rig = botRigs[bi];
  const away = new THREE.Vector3().subVectors(from, hole.pin).setY(0);
  if (away.lengthSq() < 0.01) away.set(Math.sin(bi * 2), 0, Math.cos(bi * 2));
  away.normalize();
  const spot = new THREE.Vector3(
    hole.pin.x + away.x * (hole.greenR + 2.5),
    0,
    hole.pin.z + away.z * (hole.greenR + 2.5)
  );
  placeGolfer(rig, spot, away.clone().negate());
  rig.group.visible = true;
  st.pos = hole.pin.clone();
  ui.toast(`${botLook(bi).name} in for ${st.strokes}`, 1700);
  updateStrokeStatus();
}

async function botFullStroke(bi, opt) {
  const st = game.botPlay.get(bi);
  if (!st || st.holed) return;
  await sleep(150 + Math.random() * 900);
  st.strokes++;
  const rem = pinDistOf(st.pos);
  const doomed = opt.doomedStall && bi === doomedStrokesBot();
  const holing = !doomed && (opt.forceHole || (rem < 30 && st.strokes >= 2));

  if (holing && rem < 30) {
    await botStrokeVisualHoleOut(bi, st);
    return;
  }

  let remNext;
  if (rem > 150) remNext = rem * (0.4 + Math.random() * 0.14);
  else if (rem > 30) remNext = 4 + Math.random() * 5;
  else remNext = doomed ? 6 + Math.random() * 8 : 3 + Math.random() * 3;
  if (holing) remNext = 0.3;
  if (st.strokes === 1 && opt.mustOutdrive != null) {
    // tie insurance: on the player's elimination hole every bot outdrives them
    remNext = Math.min(remNext, Math.max(6, hole.length - opt.mustOutdrive));
  }
  const target = pickPointFrom(st.pos, remNext);
  const start = st.pos.clone();
  start.y = hole.heightAt(start.x, start.z) + BALL_R;
  const s = solveBotShot({
    start,
    targetPoint: target,
    hole,
    wind: hole.wind,
    loftDeg: rem > 150 ? 14 : 30,
    curveDeg: (Math.random() - 0.5) * 4,
  });
  const rig = botRigs[bi];
  placeGolfer(rig, start, s.dir);
  rig.group.visible = true;
  const driver = scriptedSwing(rig, () => {
    sfx.strike(0.35 + Math.random() * 0.3);
    st.ball.visible = true;
    st.ball.position.copy(start);
    botShots.push({
      flight: new BallFlight({ pos: start, dir: s.dir, v0: s.v0, loftDeg: s.loftDeg, curveDeg: s.curveDeg, wind: hole.wind, hole }),
      ball: st.ball,
      bi,
    });
  });
  await runTask((t) => driver(t));
  // resting spot comes from the deterministic pre-simulation
  st.pos = s.sim.pos.clone();
  if (st.strokes === 1) {
    st.teeCarry = Math.hypot(st.pos.x - start.x, st.pos.z - start.z);
  }
  if (holing) {
    await waitBotFlightsDone();
    await botStrokeVisualHoleOut(bi, st);
  } else {
    updateStrokeStatus();
  }
}

// Launched at the player's strike: every unfinished bot plays its next
// stroke concurrently. Because the player's outcome is pre-simulated, the
// stroke that will hole out is known immediately — bots that must beat
// the player hole out on that same concurrent stroke.
function launchBotStrokesRound(predicted, predHoled) {
  const playerElim = game.rig.playerFinish === 4;
  const lastStroke = predHoled || game.playerStrokes >= 6;
  const mustOutdrive =
    playerElim && game.playerStrokes === 0
      ? Math.hypot(predicted.pos.x - hole.tee.x, predicted.pos.z - hole.tee.z) + 3
      : null;
  const jobs = [];
  for (const bi of game.aliveBots) {
    jobs.push(
      botFullStroke(bi, {
        forceHole: lastStroke,
        doomedStall: !playerElim,
        mustOutdrive,
      })
    );
  }
  game.botVolley = Promise.all(jobs);
}

async function finishBotStrokePlay() {
  const playerScore = game.playerHoled ? game.playerStrokes : 8;
  const playerElim = game.rig.playerFinish === 4;
  const d = doomedStrokesBot();
  if (playerElim || d == null) return;
  const st = game.botPlay.get(d);
  if (!st || st.holed) return;

  let maxOther = playerScore;
  for (const bi of game.aliveBots) {
    if (bi === d) continue;
    maxOther = Math.max(maxOther, game.botPlay.get(bi).strokes);
  }
  ui.showShotResult(`${botLook(d).name} is still out there…`, 2200);
  const bp = st.pos;
  setCam(
    () => {
      cam.pos.set(bp.x + 7, Math.max(hole.heightAt(bp.x + 7, bp.z + 9), bp.y) + 5, bp.z + 9);
      cam.look.set(bp.x, bp.y, bp.z);
    },
    { damp: 3 }
  );
  await sleep(1000);
  let guard = 0;
  while (st.strokes <= maxOther && guard++ < 6) {
    st.strokes++;
    if (st.strokes > maxOther) {
      await botStrokeVisualHoleOut(d, st);
    } else {
      // scrambling lay-up
      const from = st.ball.position.clone();
      const target = pickPointFrom(st.pos, Math.max(4, pinDistOf(st.pos) * 0.45));
      target.y = hole.heightAt(target.x, target.z) + BALL_R;
      st.ball.visible = true;
      await runTask((t) => {
        const k = Math.min(1, t / 1.2);
        st.ball.position.lerpVectors(from, target, k);
        st.ball.position.y = lerp(from.y, target.y, k) + Math.sin(Math.PI * k) * 6;
        return k >= 1;
      });
      st.pos = target.clone();
      sfx.bounce();
      updateStrokeStatus();
    }
  }
  await sleep(700);
}

async function strokePlayLoop() {
  initBotPlay();
  updateStrokeStatus();
  ui.setStrokeInfo('STROKE 1');
  while (!game.playerHoled) {
    const res = await takeShot();
    if (game.botVolley) {
      await game.botVolley;
      game.botVolley = null;
    }
    ui.showFfwd(false);
    timeScale = 1;
    if (res.holed) break;
  }
  await finishBotStrokePlay();
  ui.setStatusRows(null);
  ui.setStrokeInfo(null);
}

// ------------------------------------------------------------------
//  Hole 3: time race (full hole in a golf cart, slowest is cut)
// ------------------------------------------------------------------

let raceCarts = [];

function clearRaceCarts() {
  raceCarts.forEach((c) => {
    scene.remove(c.group);
    disposeCart(c);
  });
  raceCarts = [];
}

function makeRacePlan(bi, opt) {
  const L = hole.length;
  const start = botTeePos(bi);
  const p1 = pickPointFrom(start, L * (0.42 + Math.random() * 0.1));
  const p2 = pickPointFrom(p1, 4 + Math.random() * 4);
  p1.y = hole.heightAt(p1.x, p1.z) + BALL_R;
  p2.y = hole.heightAt(p2.x, p2.z) + BALL_R;
  const cartSpeed = opt.fast ? 11.5 + Math.random() * 1.5 : 8.5 + Math.random() * 2;
  const pause = opt.fast ? 1.1 : 2.0;

  const segs = [];
  let t = 0.6 + Math.random() * 1.6;
  const flight = (from, to, dur) => {
    segs.push({ type: 'flight', t0: t, t1: t + dur, from, to });
    t += dur;
  };
  const cartLeg = (from, to) => {
    const dur = Math.max(1, from.distanceTo(to) / cartSpeed);
    segs.push({ type: 'cart', t0: t, t1: t + dur, from, to });
    t += dur;
  };
  // carts park at the green edge; the last stretch is on foot
  const toEdge = new THREE.Vector3().subVectors(p2, hole.pin);
  toEdge.y = 0;
  const edgeLen = Math.max(0.01, toEdge.length());
  const pEdge = new THREE.Vector3(
    hole.pin.x + (toEdge.x / edgeLen) * (hole.greenR + 4),
    0,
    hole.pin.z + (toEdge.z / edgeLen) * (hole.greenR + 4)
  );
  pEdge.y = hole.heightAt(pEdge.x, pEdge.z);

  flight(start.clone(), p1, 2.4);
  t += pause;
  cartLeg(start.clone(), p1);
  t += pause;
  flight(p1.clone(), p2, 2.0);
  t += pause * 0.7;
  cartLeg(p1.clone(), pEdge);
  t += pause * 0.6;

  return {
    bi,
    segs,
    slow: opt.slow,
    delta: opt.delta,
    wanderFrom: t,
    p2,
    finishAt: opt.slow ? null : t + 1.6,
    finishTime: null,
    finished: false,
    riding: false,
    cart: null,
    ball: null,
  };
}

// seat a bot in its cart / stand it at its ball
function setBotRiding(plan, riding) {
  if (plan.riding === riding) return;
  plan.riding = riding;
  const rig = botRigs[plan.bi];
  if (riding) {
    scene.remove(rig.group);
    plan.cart.group.add(rig.group);
    rig.group.position.set(0.24, 0.06, -0.18);
    rig.group.rotation.set(0, 0, 0);
    seatedPose(rig);
  } else {
    plan.cart.group.remove(rig.group);
    scene.add(rig.group);
    rig.seated = false;
    rig.J.club.visible = true;
    setPose(rig, 0);
    const bp = plan.ball ? plan.ball.position : botTeePos(plan.bi);
    const dir = new THREE.Vector3(hole.pin.x - bp.x, 0, hole.pin.z - bp.z).normalize();
    placeGolfer(rig, bp, dir);
  }
  rig.group.visible = true;
}

function buildRacePlans() {
  const playerElim = game.rig.playerFinish === 3;
  const doomed = game.aliveBots.find((bi) => game.rig.botFinish[bi] === 3);
  raceState = { t: 0, running: false, playerTime: null, plans: new Map() };
  for (const bi of game.aliveBots) {
    const isDoomed = !playerElim && bi === doomed;
    // slow = scripted to finish behind the player
    const slow = isDoomed || (!playerElim && game.rig.semiWinnerIsPlayer && bi !== doomed);
    const delta = isDoomed ? 8 + game.rng() * 6 : 3 + game.rng() * 3;
    raceState.plans.set(bi, makeRacePlan(bi, { slow, delta, fast: playerElim }));
  }
}

// Safety valve: fired at the player's predicted-holing strike, so every
// bot scripted to beat the player is in the cup before their ball stops.
function raceForceFinishFastBots() {
  if (!raceState) return;
  for (const plan of raceState.plans.values()) {
    if (!plan.slow && !plan.finished) {
      plan.finishAt = Math.min(plan.finishAt ?? Infinity, raceState.t + 1.3);
    }
  }
}

function updateRaceStatus() {
  if (!raceState) return;
  const rows = [];
  for (const bi of game.aliveBots) {
    const plan = raceState.plans.get(bi);
    rows.push({
      color: botLook(bi).shirt,
      done: plan.finished,
      text: plan.finished ? `IN · ${fmtTime(plan.finishTime)}` : 'on course',
    });
  }
  ui.setStatusRows(rows);
}

// Smoothly morph a cart between wheels and pontoons, floating it on the
// water surface while it's in a water zone. Returns the y to use.
function cartFloatY(cart, x, z, inWater, dt) {
  const prev = cart.waterMix;
  const target = inWater ? 1 : 0;
  const mix = clamp(prev + Math.sign(target - prev) * dt * 2.6, 0, 1);
  if (mix !== prev) {
    cart.setWater(mix);
    // the big splash at the moment of transformation
    if ((prev < 0.5 && mix >= 0.5) || (prev > 0.5 && mix <= 0.5)) {
      spawnRing(cart.group.position, 0x9fd8ff, 4, 0.8);
      sfx.splash();
    }
  }
  // Y is NOT eased through the morph — the hull rides the surface from the
  // moment it's in water (the bank slopes make the hand-off continuous),
  // only the wheels/pontoons animate.
  const ground = hole.heightAt(x, z);
  if (!inWater) return ground;
  const bob = Math.sin(clockT * 2.3 + x * 0.1) * 0.06;
  return Math.max(ground, hole.waterLevel + 0.04 + bob);
}

function moveBotCart(plan, x, z, dt) {
  const g = plan.cart.group;
  const dx = x - g.position.x;
  const dz = z - g.position.z;
  const d = Math.hypot(dx, dz);
  if (d > 0.001) g.rotation.y = Math.atan2(dx, dz);
  const inWater = hole.inWaterZone(x, z);
  g.position.set(x, cartFloatY(plan.cart, x, z, inWater, dt), z);
  plan.cart.update(d);
}

function advanceRacePlan(bi, plan, dt) {
  if (plan.finished || !plan.ball) return;
  const t = raceState.t;
  if (plan.finishAt != null && t >= plan.finishAt) {
    plan.finished = true;
    plan.finishTime = plan.finishAt;
    setBotRiding(plan, false);
    plan.ball.visible = false;
    // walks off to the fringe after holing out
    const rig = botRigs[bi];
    const away = new THREE.Vector3().subVectors(plan.p2, hole.pin).setY(0).normalize();
    const spot = new THREE.Vector3(
      hole.pin.x + away.x * (hole.greenR + 2.5),
      0,
      hole.pin.z + away.z * (hole.greenR + 2.5)
    );
    placeGolfer(rig, spot, away.clone().negate());
    spawnRing(hole.pin, 0xffffff, 1.5, 0.4);
    sfx.onGreen();
    ui.toast(`${botLook(bi).name} in — ${fmtTime(plan.finishTime)}`, 1800);
    updateRaceStatus();
    return;
  }
  for (const s of plan.segs) {
    if (t >= s.t0 && t < s.t1) {
      const k = (t - s.t0) / (s.t1 - s.t0);
      if (s.type === 'flight') {
        setBotRiding(plan, false);
        plan.ball.visible = true;
        plan.ball.position.lerpVectors(s.from, s.to, k);
        plan.ball.position.y =
          lerp(s.from.y, s.to.y, k) +
          Math.sin(Math.PI * k) * Math.max(6, s.from.distanceTo(s.to) * 0.08);
      } else {
        setBotRiding(plan, true);
        moveBotCart(plan, lerp(s.from.x, s.to.x, k), lerp(s.from.z, s.to.z, k), dt);
      }
      return;
    }
  }
  // between segments (or waiting for the script): standing at the ball
  setBotRiding(plan, false);
}

function seatedPose(rig) {
  rig.seated = true;
  setPose(rig, 0);
  rig.J.spineL.rotation.x = 0.08;
  rig.J.hipL.rotation.x = -1.35;
  rig.J.hipR.rotation.x = -1.35;
  rig.J.kneeL.rotation.x = 1.45;
  rig.J.kneeR.rotation.x = 1.45;
  rig.J.armsRoot.rotation.x = -0.75;
  rig.J.armsRoot.rotation.z = 0;
  rig.J.club.visible = false;
}

async function cartDriveToBall() {
  phase = 'cart';
  ui.setControlsVisible(false);
  ui.showJoystick(true);
  ui.showShotResult('drive to your ball — joystick or W A S D', 2400);
  if (!playerCart) {
    playerCart = { cart: buildCart(PLAYER_LOOK.shirt), heading: 0, speed: 0, arrive: null };
    scene.add(playerCart.cart.group);
  }
  playerCart.speed = 0;
  const g = playerCart.cart.group;
  g.position.copy(playerRig.group.position);
  g.position.y = hole.heightAt(g.position.x, g.position.z);
  playerCart.heading = Math.atan2(
    playerBall.position.x - g.position.x,
    playerBall.position.z - g.position.z
  );
  g.rotation.y = playerCart.heading;
  // hop in
  scene.remove(playerRig.group);
  g.add(playerRig.group);
  playerRig.group.position.set(0.24, 0.06, -0.18);
  playerRig.group.rotation.set(0, 0, 0);
  seatedPose(playerRig);
  await new Promise((res) => (playerCart.arrive = res));
  ui.showJoystick(false);
  // hop out
  g.remove(playerRig.group);
  scene.add(playerRig.group);
  playerRig.seated = false;
  playerRig.J.club.visible = true;
  setPose(playerRig, 0);
  placeGolferAtBall(playerRig, baseAimDir());

  // arrived greenside? park it — from here on it's on foot
  if (pinDistOf(playerBall.position) < hole.greenR + 10) {
    raceState.playerParked = true;
    // nudge the cart off the putting surface
    const c = g.position;
    const dPin = Math.hypot(c.x - hole.pin.x, c.z - hole.pin.z);
    if (dPin < hole.greenR + 2) {
      const k = (hole.greenR + 3.5) / Math.max(0.01, dPin);
      c.x = hole.pin.x + (c.x - hole.pin.x) * k;
      c.z = hole.pin.z + (c.z - hole.pin.z) * k;
      c.y = hole.heightAt(c.x, c.z);
    }
    ui.toast('Cart parked — walking it in');
  }
}

async function raceLoop() {
  buildRacePlans();
  for (const bi of game.aliveBots) {
    const plan = raceState.plans.get(bi);
    plan.cart = buildCart(botLook(bi).shirt);
    const gx = game.gates.get(bi);
    plan.cart.group.position.set(gx + (gx >= 0 ? 5 : -5), 0, 3.5);
    plan.cart.group.position.y = hole.heightAt(plan.cart.group.position.x, plan.cart.group.position.z);
    scene.add(plan.cart.group);
    raceCarts.push(plan.cart);
    const ball = makeBallMesh();
    ball.position.copy(botTeePos(bi));
    scene.add(ball);
    botBalls.push(ball);
    plan.ball = ball;
  }
  await ui.showBanner('GO!', 'the clock is running — swing fast, drive faster', 1800);
  raceState.running = true;
  updateRaceStatus();

  while (!game.playerHoled) {
    const res = await takeShot();
    if (res.holed) break;
    if (raceState.playerParked) {
      // cart's parked greenside: just walk to the ball
      placeGolferAtBall(playerRig, baseAimDir());
      spawnRing(playerBall.position, 0xffffff, 1.2, 0.35);
      await sleep(450);
    } else {
      await cartDriveToBall();
    }
  }
  raceState.running = false;
  ui.setRaceTimer(raceState.playerTime);

  // resolve the scripted stragglers just behind the player's time
  for (const plan of raceState.plans.values()) {
    if (!plan.finished && plan.finishAt == null) {
      plan.finishAt = plan.slow
        ? Math.max(raceState.playerTime + plan.delta, raceState.t + 0.8 + plan.delta * 0.1)
        : raceState.t + 1.2;
    }
  }
  setCam(
    () => {
      const a = clockT * 0.25;
      cam.pos.set(hole.pin.x + Math.sin(a) * 18, hole.pin.y + 11, hole.pin.z + Math.cos(a) * 18);
      cam.look.copy(hole.pin);
    },
    { damp: 2 }
  );
  while ([...raceState.plans.values()].some((p) => !p.finished)) {
    await sleep(250);
  }
  await sleep(900);
  ui.setStatusRows(null);
  ui.setRaceTimer(null);
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
  let entries = [];
  let title;
  let labelOf;
  if (game.mode === 'strokes') {
    entries.push({ id: 'P', v: game.playerHoled ? game.playerStrokes : 8, tc: game.playerTeeCarry });
    for (const bi of game.aliveBots) {
      const st = game.botPlay.get(bi);
      entries.push({ id: bi, v: st.strokes, tc: st.teeCarry });
    }
    // fewest strokes wins; ties go to the longer tee shot
    entries.sort((a, b) => a.v - b.v || b.tc - a.tc);
    title = `HOLE ${game.holeIdx + 1} — FEWEST STROKES`;
    labelOf = (e) => `${e.v}${e.v >= 8 ? ' (pickup)' : ''}`;
  } else if (game.mode === 'race') {
    entries.push({ id: 'P', v: raceState.playerTime });
    for (const bi of game.aliveBots) entries.push({ id: bi, v: raceState.plans.get(bi).finishTime });
    entries.sort((a, b) => a.v - b.v);
    title = `HOLE ${game.holeIdx + 1} — FASTEST TO HOLE OUT`;
    labelOf = (e) => fmtTime(e.v);
  } else {
    const pd = game.dists.get('P');
    entries.push({ id: 'P', ...pd, v: pd.dist });
    for (const bi of game.aliveBots) {
      const d = game.dists.get(bi);
      entries.push({ id: bi, ...d, v: d.dist });
    }
    entries.sort((a, b) => a.v - b.v);
    title = `HOLE ${game.holeIdx + 1} — CLOSEST TO PIN`;
    labelOf = (e) => (e.ace ? 'ACE!' : `${e.wet ? ICO.wet + ' ' : ''}${fmtDist(e.dist)}`);
  }
  const cutEntry = entries[entries.length - 1];
  dlog('board:', entries.map((e) => `${e.id}:${Number(e.v).toFixed(1)}`).join(' '), '| cut:', cutEntry.id);

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
    label: labelOf(e),
    isPlayer: e.id === 'P',
    cut: e === cutEntry,
  }));
  await ui.showBoard(title, rows, true);
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

  // race clock + scripted bot racers
  if (raceState) {
    const anyUnfinished = [...raceState.plans.values()].some((p) => !p.finished);
    if (raceState.running || anyUnfinished) raceState.t += dt;
    if (raceState.running) {
      ui.setRaceTimer(raceState.playerTime ?? raceState.t);
    }
    for (const [bi, plan] of raceState.plans) advanceRacePlan(bi, plan, dt);
  }

  // player cart driving
  if (phase === 'cart' && playerCart && playerCart.arrive) {
    const g = playerCart.cart.group;
    // world yaw is counter-clockwise while screen-right is -X, so manual
    // steer input is negated (the autopilot below assigns its own value)
    let steer = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0) - ui.joy.x - aimHold;
    let throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) + ui.joy.y;
    if (window.__thecut.autopilot) {
      const want = Math.atan2(playerBall.position.x - g.position.x, playerBall.position.z - g.position.z);
      let diff = want - playerCart.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      steer = clamp(diff * 3, -1, 1);
      throttle = 1;
    }
    steer = clamp(steer, -1, 1);
    throttle = clamp(throttle, -1, 1);
    // throttle & brake: W / joystick-up drives, S / joystick-down brakes,
    // no input coasts down
    const inWater = hole.inWaterZone(g.position.x, g.position.z);
    const maxS = inWater ? 6 : 12;
    const target = Math.max(0, throttle) * maxS;
    const rate = throttle < 0 ? 18 : target > playerCart.speed ? 8 : 4;
    playerCart.speed = clamp(
      playerCart.speed + clamp(target - playerCart.speed, -rate * dt, rate * dt),
      0,
      maxS
    );
    // carts don't spin in place
    playerCart.heading += steer * 1.9 * dt * clamp(playerCart.speed / 4, 0.25, 1);
    const step = playerCart.speed * dt;
    g.position.x = clamp(g.position.x + Math.sin(playerCart.heading) * step, -hole.halfW + 1, hole.halfW - 1);
    g.position.z = clamp(g.position.z + Math.cos(playerCart.heading) * step, hole.zMin + 1, hole.zMax - 1);
    g.position.y = cartFloatY(playerCart.cart, g.position.x, g.position.z, inWater, dt);
    g.rotation.y = playerCart.heading;
    playerCart.cart.update(step);
    if (inWater && playerCart.speed > 1 && Math.random() < dt * 6) {
      spawnRing(g.position, 0x9fd8ff, 2, 0.5);
    }
    setCam(
      () => {
        cam.pos.set(
          g.position.x - Math.sin(playerCart.heading) * 8,
          g.position.y + 4,
          g.position.z - Math.cos(playerCart.heading) * 8
        );
        // never dip under the water surface, even where the bed is carved deep
        const minY = Math.max(hole.heightAt(cam.pos.x, cam.pos.z), hole.waterLevel) + 1.6;
        if (cam.pos.y < minY) cam.pos.y = minY;
        cam.look.set(g.position.x, g.position.y + 1.2, g.position.z);
      },
      { damp: 5 }
    );
    const dBall = Math.hypot(g.position.x - playerBall.position.x, g.position.z - playerBall.position.z);
    // telemetry + stuck failsafe: if the drive makes no progress (ball in
    // an unreachable pocket), the marshal shuttles the cart over
    playerCart.driveT = (playerCart.driveT || 0) + dt;
    if (dBall < (playerCart.best ?? Infinity) - 0.5) {
      playerCart.best = dBall;
      playerCart.stuckT = 0;
    } else if (playerCart.speed > 2.5) {
      // only "stuck" while actually driving — idling is the player's choice
      playerCart.stuckT = (playerCart.stuckT || 0) + dt;
    }
    if (playerCart.debugT === undefined || playerCart.driveT - playerCart.debugT > 3) {
      playerCart.debugT = playerCart.driveT;
      dlog(
        'cart:',
        `pos(${g.position.x.toFixed(0)},${g.position.z.toFixed(0)})`,
        `ball(${playerBall.position.x.toFixed(0)},${playerBall.position.z.toFixed(0)})`,
        'd=' + dBall.toFixed(1),
        'stuck=' + (playerCart.stuckT || 0).toFixed(1)
      );
    }
    const stuck = playerCart.stuckT > 8 || playerCart.driveT > 150;
    if (stuck && dBall >= 4.2) {
      ui.toast('Marshal shuttle — dropped at your ball');
      g.position.set(
        playerBall.position.x + 2,
        hole.heightAt(playerBall.position.x + 2, playerBall.position.z),
        playerBall.position.z
      );
    }
    if (dBall < 4.2 || stuck) {
      playerCart.driveT = 0;
      playerCart.stuckT = 0;
      playerCart.best = Infinity;
      playerCart.debugT = undefined;
      const r = playerCart.arrive;
      playerCart.arrive = null;
      r();
    }
  }

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

  // neon YOU beacon while driving
  if (phase === 'cart') {
    if (!youSign) youSign = buildYouSign();
    youSign.group.visible = true;
    const bp = playerBall.position;
    youSign.group.position.set(bp.x, bp.y + 6.5 + Math.sin(clockT * 2) * 0.4, bp.z);
    const dCam = camera.position.distanceTo(youSign.group.position);
    const s = clamp(dCam * 0.05, 0.8, 4.5);
    youSign.sprite.scale.set(6 * s, 3.75 * s, 1);
  } else if (youSign) {
    youSign.group.visible = false;
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
    setPose(swingTween.rig, (-1 + k * 2) * (swingTween.amp || 1));
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
    if (!r.group.visible || r.seated) return;
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
