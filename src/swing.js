// Swing gesture: drag DOWN to take the club back, then push UP through the
// ball in one motion. The forward stroke is graded on four axes:
//   straightness -> slice / hook curve
//   cleanliness  -> distance loss
//   pace         -> launch height (too fast = low bullet, too slow = balloon)
//   smoothness   -> random scatter around the aim point

import { clamp } from './rng.js';

export class SwingController {
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers; // {onStart, onProgress(backFrac, pts), onStrike(metrics, pts), onCancel}
    this.enabled = false;
    this.active = false;
    this.pts = [];
    this.phase = 'idle';
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', () => this._cancel());
  }

  setEnabled(v) {
    this.enabled = v;
    if (!v) this._reset();
  }

  _reset() {
    this.active = false;
    this.phase = 'idle';
    this.pts = [];
  }

  _down(e) {
    if (!this.enabled || this.active) return;
    this.active = true;
    this.phase = 'back';
    this.pts = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    this.turnIdx = 0;
    this.maxY = e.clientY;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {}
    this.h.onStart && this.h.onStart();
  }

  _move(e) {
    if (!this.active) return;
    const now = performance.now();
    const last = this.pts[this.pts.length - 1];
    if (now - last.t < 4) return;
    this.pts.push({ x: e.clientX, y: e.clientY, t: now });
    const start = this.pts[0];

    if (this.phase === 'back') {
      if (e.clientY > this.maxY) {
        this.maxY = e.clientY;
        this.turnIdx = this.pts.length - 1;
      }
      // reversal: moved back up ~14px from the deepest point
      if (this.maxY - e.clientY > 14 && this.maxY - start.y > 24) {
        this.phase = 'fwd';
      }
      const backFrac = clamp((this.maxY - start.y) / (window.innerHeight * 0.33), 0, 1.15);
      this.h.onProgress && this.h.onProgress(backFrac, this.pts, 'back');
    }

    if (this.phase === 'fwd') {
      const backFrac = clamp((this.maxY - start.y) / (window.innerHeight * 0.33), 0, 1.15);
      this.h.onProgress && this.h.onProgress(backFrac, this.pts, 'fwd');
      // strike as the stroke passes back through the ball (the start point)
      if (e.clientY <= start.y) {
        this._strike();
      }
    }
  }

  _up() {
    if (!this.active) return;
    if (this.phase === 'fwd' && this.maxY - this.pts[this.pts.length - 1].y > 30) {
      this._strike();
    } else {
      this._cancel();
    }
  }

  _cancel() {
    if (!this.active) return;
    this._reset();
    this.h.onCancel && this.h.onCancel();
  }

  _strike() {
    const metrics = this._analyze();
    const pts = this.pts;
    this._reset();
    if (!metrics) {
      this.h.onCancel && this.h.onCancel();
      return;
    }
    this.h.onStrike && this.h.onStrike(metrics, pts);
  }

  _analyze() {
    const pts = this.pts;
    const start = pts[0];
    const turn = pts[this.turnIdx];
    const fwd = pts.slice(this.turnIdx);
    if (fwd.length < 3) return null;
    const end = fwd[fwd.length - 1];

    const backLen = this.maxY - start.y;
    if (backLen < 24) return null;
    const backFrac = clamp(backLen / (window.innerHeight * 0.33), 0, 1.15);

    // ---- straightness: forward stroke direction vs straight up ----
    const dx = end.x - turn.x;
    const dy = turn.y - end.y; // positive = travelled up
    if (dy < 12) return null;
    const angleDeg = (Math.atan2(dx, dy) * 180) / Math.PI;

    // ---- per-segment speeds along the forward stroke ----
    const speeds = [];
    let revs = 0;
    let lastDx = 0;
    let devSum = 0;
    const lineLen = Math.hypot(dx, dy) || 1;
    for (let i = 1; i < fwd.length; i++) {
      const a = fwd[i - 1];
      const b = fwd[i];
      const dt = Math.max(1, b.t - a.t);
      speeds.push(Math.hypot(b.x - a.x, b.y - a.y) / dt);
      const sdx = b.x - a.x;
      if (Math.abs(sdx) > 5 && Math.abs(lastDx) > 5 && Math.sign(sdx) !== Math.sign(lastDx)) revs++;
      if (Math.abs(sdx) > 3) lastDx = sdx;
      // perpendicular deviation from the turn->end chord
      const px = b.x - turn.x;
      const py = b.y - turn.y;
      const cross = Math.abs(px * (end.y - turn.y) - py * (end.x - turn.x)) / lineLen;
      devSum += cross;
    }
    const avgDev = devSum / Math.max(1, fwd.length - 1);

    const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length; // px/ms
    const idealSpeed = (window.innerHeight * 0.32) / 300; // full stroke in ~300ms
    const paceRatio = avgSpeed / idealSpeed;

    let variance = 0;
    for (const s of speeds) variance += (s - avgSpeed) ** 2;
    const speedCV = Math.sqrt(variance / speeds.length) / Math.max(0.001, avgSpeed);

    // ---- normalize to 0..1 penalty scores ----
    const wobble = clamp((avgDev / (lineLen * 0.06)) * 0.55 + revs * 0.22, 0, 1);
    const scatter = clamp((speedCV - 0.35) / 0.75, 0, 1);

    return {
      backFrac,
      angleDeg: clamp(angleDeg, -45, 45),
      wobble,
      paceRatio: clamp(paceRatio, 0.25, 2.6),
      scatter,
      strokeMs: end.t - turn.t,
    };
  }
}

// Translate raw stroke metrics into shot parameters + a feedback grade.
export function shotFromMetrics(m, club, launchSpeed, rng) {
  // power: backswing length is the throttle, pace off-ideal bleeds a little
  const paceErr = Math.abs(m.paceRatio - 1);
  let power = (0.62 + 0.43 * Math.min(m.backFrac, 1.0)) * (1 - 0.1 * clamp(paceErr - 0.15, 0, 1));
  // cleanliness: wobble costs distance
  power *= 1 - 0.26 * m.wobble;
  power = clamp(power, 0.3, 1.05);

  // straightness -> curve. gentle deadzone, then it bites.
  const a = m.angleDeg;
  const deadzone = 3.5;
  const eff = Math.abs(a) < deadzone ? 0 : (a - Math.sign(a) * deadzone) * 0.55;
  const curveDeg = clamp(eff, -14, 14);
  // a skewed path also pushes the start line slightly
  const pushDeg = clamp(a * 0.18, -6, 6);

  // pace -> launch height
  let loftMul = 1;
  if (m.paceRatio > 1.12) loftMul = 1 - clamp((m.paceRatio - 1.12) / 1.1, 0, 1) * 0.45;
  else if (m.paceRatio < 0.88) loftMul = 1 + clamp((0.88 - m.paceRatio) / 0.55, 0, 1) * 0.42;

  // smoothness -> random aim cone
  const scatterDeg = m.scatter * 6;
  const scatterOffset = (rng() * 2 - 1) * scatterDeg;

  const quality =
    1 -
    clamp(
      0.32 * m.wobble +
        0.25 * clamp(Math.abs(eff) / 14, 0, 1) +
        0.22 * clamp(paceErr / 0.8, 0, 1) +
        0.21 * m.scatter,
      0,
      1
    );

  let grade;
  if (quality > 0.9 && m.backFrac > 0.85) grade = 'PURE!';
  else if (quality > 0.78) grade = 'Flush';
  else if (curveDeg > 5) grade = 'Sliced!';
  else if (curveDeg < -5) grade = 'Hooked!';
  else if (loftMul < 0.75) grade = 'Thin — screamer';
  else if (loftMul > 1.25) grade = 'Ballooned';
  else if (m.wobble > 0.55) grade = 'Chunky';
  else if (m.scatter > 0.6) grade = 'Loose';
  else grade = 'Solid';

  return {
    v0: launchSpeed * power,
    loftDeg: clamp(club.loft * loftMul, 6, 72),
    curveDeg,
    pushDeg: pushDeg + scatterOffset,
    power,
    quality,
    grade,
  };
}
