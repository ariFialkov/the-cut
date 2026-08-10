// DOM layer: menus, HUD, lobby, leaderboard, results. main.js drives it.

import { BETS } from './economy.js';
import { fmtDist, yd } from './clubs.js';

export function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

const $ = (id) => document.getElementById(id);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Inline SVG icons (fill: currentColor) — no emoji anywhere in the UI.
export const ICO = {
  flag: '<svg class="ico" viewBox="0 0 24 24"><path d="M6 2h2v20H6zM8 3.5l11 3.2L8 10z"/></svg>',
  wet: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 2s-6 7.4-6 12a6 6 0 0 0 12 0c0-4.6-6-12-6-12z"/></svg>',
  coin: '<span class="coin"></span>',
};

export class UI {
  constructor() {
    this.el = {
      menu: $('menu'),
      hud: $('hud'),
      howto: $('howto'),
      lobby: $('lobby'),
      lobbyList: $('lobby-list'),
      lobbyStatus: $('lobby-status'),
      board: $('board'),
      boardTitle: $('board-title'),
      boardList: $('board-list'),
      cutLine: $('cut-line'),
      banner: $('banner'),
      bannerBig: $('banner-big'),
      bannerSub: $('banner-sub'),
      results: $('results'),
      feedback: $('feedback'),
      shotResult: $('shot-result'),
      stepper: $('stepper'),
      swingHint: $('swing-hint'),
      aimLeft: $('aim-left'),
      aimRight: $('aim-right'),
      clubPrev: $('club-prev'),
      clubNext: $('club-next'),
      ffwd: $('ffwd'),
      btnPlay: $('btn-play'),
      toast: $('toast'),
      trail: $('trail'),
    };
    this.trailCtx = this.el.trail.getContext('2d');
    this._sizeTrail();
    addEventListener('resize', () => this._sizeTrail());

    $('btn-howto').addEventListener('click', () => this.el.howto.classList.remove('hidden'));
    $('btn-howto-close').addEventListener('click', () => this.el.howto.classList.add('hidden'));

    this.bet = BETS[1];
    this._buildBetRow();
    this._buildStepper();
  }

  _sizeTrail() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.el.trail.width = innerWidth * dpr;
    this.el.trail.height = innerHeight * dpr;
    this.trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- menu ----------
  _buildBetRow() {
    const row = $('bet-row');
    row.innerHTML = '';
    for (const b of BETS) {
      const chip = document.createElement('div');
      chip.className = 'bet-chip';
      chip.textContent = b;
      chip.dataset.bet = b;
      chip.addEventListener('click', () => {
        this.bet = b;
        this._refreshChips();
        this.onBetChange && this.onBetChange(b);
      });
      row.appendChild(chip);
    }
    this._refreshChips();
  }

  _refreshChips() {
    document.querySelectorAll('.bet-chip').forEach((c) => {
      const v = Number(c.dataset.bet);
      c.classList.toggle('sel', v === this.bet);
      c.classList.toggle('broke', v > this.balance);
    });
  }

  setBalance(b) {
    this.balance = b;
    $('menu-balance').textContent = Math.round(b);
    $('hud-balance').textContent = Math.round(b);
    if (this.bet > b) {
      const ok = BETS.filter((x) => x <= b);
      this.bet = ok.length ? ok[ok.length - 1] : BETS[0];
    }
    this._refreshChips();
    this.el.btnPlay.textContent = b < BETS[0] ? 'CLAIM 1000 FREE COINS' : 'TEE OFF';
  }

  setMenuHoleInfo(text) {
    $('menu-hole-info').textContent = text;
  }

  showMenu() {
    this.el.menu.classList.remove('hidden');
    this.el.hud.classList.add('hidden');
    this.el.results.classList.add('hidden');
    this.el.board.classList.add('hidden');
  }

  // ---------- lobby ----------
  async runLobby(roster, ourIdx) {
    this.el.menu.classList.add('hidden');
    this.el.lobby.classList.remove('hidden');
    this.el.lobbyList.innerHTML = '';
    this.el.lobbyStatus.textContent = 'Searching…';
    const add = (p, you) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="dot" style="background:${p.shirt}"></span><span class="${you ? 'you' : ''}">${p.name}${you ? ' (you)' : ''}</span>`;
      this.el.lobbyList.appendChild(li);
    };
    add(roster[ourIdx], true);
    await sleep(500);
    for (let i = 0; i < roster.length; i++) {
      if (i === ourIdx) continue;
      add(roster[i], false);
      this.el.lobbyStatus.textContent = `${this.el.lobbyList.children.length} / 5 players`;
      await sleep(340 + Math.random() * 420);
    }
    this.el.lobbyStatus.textContent = 'Lobby full — good luck!';
    await sleep(900);
    this.el.lobby.classList.add('hidden');
  }

  // ---------- HUD ----------
  _buildStepper() {
    this.el.stepper.innerHTML = '';
    const labels = ['1', '2', '3', '4', ICO.flag];
    for (let i = 0; i < 5; i++) {
      const d = document.createElement('div');
      d.className = 'step';
      d.innerHTML = labels[i];
      this.el.stepper.appendChild(d);
    }
  }

  setStep(cur, playerDeadAt = -1) {
    [...this.el.stepper.children].forEach((d, i) => {
      d.className = 'step';
      if (playerDeadAt >= 0 && i >= playerDeadAt) d.classList.add('dead');
      else if (i < cur) d.classList.add('done');
      else if (i === cur) d.classList.add('cur');
    });
  }

  showHud() {
    this.el.hud.classList.remove('hidden');
    this.el.menu.classList.add('hidden');
  }

  setHole(num, name, lengthM, par = 3) {
    $('hud-hole-num').textContent = `HOLE ${num}`;
    $('hud-hole-name').textContent = `“${name}” · par ${par} · ${yd(lengthM)} yd`;
  }

  // "STROKE 2" line under the hole name (null hides)
  setStrokeInfo(text) {
    const el = $('hud-stroke');
    el.classList.toggle('hidden', !text);
    if (text) el.textContent = text;
  }

  // running race clock in seconds (null hides)
  setRaceTimer(sec) {
    const el = $('race-timer');
    el.classList.toggle('hidden', sec === null);
    if (sec !== null) el.textContent = fmtTime(sec);
  }

  // right-side status rows: [{color, text, done}] (null hides)
  setStatusRows(rows) {
    const el = $('race-status');
    el.classList.toggle('hidden', !rows);
    if (!rows) return;
    el.innerHTML = '';
    for (const r of rows) {
      const d = document.createElement('div');
      d.className = 'rs-row' + (r.done ? ' in' : '');
      d.innerHTML = `<span class="rs-dot" style="background:${r.color}"></span>${r.text}`;
      el.appendChild(d);
    }
  }

  setPinDist(m) {
    $('hud-pin').textContent = yd(m);
  }

  // relDeg: wind direction relative to camera forward, degrees.
  // The arrow glyph points up (away from camera) at 0.
  setWind(mph, relDeg) {
    $('hud-wind').textContent = Math.round(mph);
    $('wind-arrow').style.transform = `rotate(${relDeg}deg)`;
    $('pill-wind').style.opacity = mph < 1 ? 0.45 : 1;
  }

  setClub(club, effNote) {
    $('club-name').textContent = club.name.toUpperCase();
    $('club-carry').textContent = `${yd(club.carry)} yd${effNote ? ' · ' + effNote : ''}`;
  }

  showFfwd(v) {
    this.el.ffwd.classList.toggle('hidden', !v);
    if (!v) this.el.ffwd.classList.remove('held');
  }

  setControlsVisible(v) {
    const method = v ? 'remove' : 'add';
    this.el.aimLeft.classList[method]('hidden');
    this.el.aimRight.classList[method]('hidden');
    document.querySelector('.club-select').classList[method]('hidden');
    this.el.swingHint.classList[method]('hidden');
    document.querySelector('.hud-pills').classList[method]('hidden');
  }

  showFeedback(text, color = '#fff', ms = 1300) {
    const f = this.el.feedback;
    f.textContent = text;
    f.style.color = color;
    f.classList.remove('hidden');
    // retrigger animation
    f.style.animation = 'none';
    void f.offsetWidth;
    f.style.animation = '';
    clearTimeout(this._fbT);
    this._fbT = setTimeout(() => f.classList.add('hidden'), ms);
  }

  showShotResult(html, ms = 2400) {
    const s = this.el.shotResult;
    s.innerHTML = html;
    s.classList.remove('hidden');
    clearTimeout(this._srT);
    this._srT = setTimeout(() => s.classList.add('hidden'), ms);
  }

  async showBanner(big, sub = '', ms = 1600) {
    this.el.bannerBig.textContent = big;
    this.el.bannerSub.textContent = sub;
    this.el.banner.classList.remove('hidden');
    this.el.banner.style.animation = 'none';
    void this.el.banner.offsetWidth;
    this.el.banner.style.animation = '';
    await sleep(ms);
    this.el.banner.classList.add('hidden');
  }

  toast(text, ms = 1800) {
    this.el.toast.textContent = text;
    this.el.toast.classList.remove('hidden');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.el.toast.classList.add('hidden'), ms);
  }

  // ---------- swing trail ----------
  drawTrail(pts, phase) {
    const ctx = this.trailCtx;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!pts || pts.length < 2) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = phase === 'fwd' ? 'rgba(53,224,124,0.9)' : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    // ball marker at the start point
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  clearTrail() {
    this.trailCtx.clearRect(0, 0, innerWidth, innerHeight);
  }

  // ---------- leaderboard ----------
  // rows: [{name, color, label, isPlayer, cut}] pre-sorted; label is HTML
  async showBoard(title, rows, showCutLine) {
    this.el.boardTitle.textContent = title;
    this.el.board.classList.remove('hidden');
    this.el.cutLine.classList.add('hidden');
    const list = this.el.boardList;
    list.innerHTML = '';
    const items = rows.map((r, i) => {
      const li = document.createElement('li');
      if (r.isPlayer) li.classList.add('me');
      if (r.cut) li.classList.add('cutrow');
      li.innerHTML = `<span class="rank">${i + 1}</span><span class="dot" style="background:${r.color}"></span><span>${r.name}</span><span class="dist">${r.label}</span>`;
      list.appendChild(li);
      return li;
    });
    for (const li of items) {
      await sleep(230);
      li.classList.add('show');
    }
    if (showCutLine) {
      await sleep(450);
      this.el.cutLine.classList.remove('hidden');
    }
  }

  hideBoard() {
    this.el.board.classList.add('hidden');
  }

  // ---------- results ----------
  showResults({ pos, payout, bet, balance, standings, wheel, onAgain, onMenu }) {
    const r = this.el.results;
    r.classList.remove('hidden');
    const ordinal = ['1st', '2nd', '3rd', '4th', '5th'][pos - 1];
    $('results-title').textContent = pos === 1 ? 'CHAMPION' : pos <= 3 ? 'IN THE MONEY' : 'CUT';
    const posEl = $('results-pos');
    posEl.textContent = ordinal;
    posEl.className = 'results-pos ' + (pos === 1 ? 'win' : pos > 3 ? 'lose' : '');
    const wheelEl = $('results-wheel');
    wheelEl.classList.toggle('hidden', !wheel);
    if (wheel) wheelEl.textContent = `WHEEL BONUS ×${wheel}`;
    $('results-payout').innerHTML =
      payout > 0 ? `+${payout.toFixed(0)} ${ICO.coin} (bet ${bet})` : `bet ${bet} lost`;
    const ul = $('results-standings');
    ul.innerHTML = '';
    standings.forEach((s) => {
      const li = document.createElement('li');
      if (s.isPlayer) li.classList.add('me');
      li.innerHTML = `<span class="pos">${['1st', '2nd', '3rd', '4th', '5th'][s.pos - 1]}</span><span class="dot" style="background:${s.color};width:12px;height:12px;border-radius:50%;align-self:center;flex:none"></span><span>${s.name}</span><span class="prize">${s.prize > 0 ? '+' + s.prize.toFixed(0) : ''}</span>`;
      ul.appendChild(li);
    });
    $('results-balance').textContent = Math.round(balance);
    $('btn-again').onclick = () => {
      r.classList.add('hidden');
      onAgain();
    };
    $('btn-menu').onclick = () => {
      r.classList.add('hidden');
      onMenu();
    };
  }
}
