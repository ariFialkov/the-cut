// Club bag. Carries are in meters of carry (flight only, before roll).

export const CLUBS = [
  { id: 'DR', name: 'Driver', carry: 238, loft: 11 },
  { id: '3W', name: '3 Wood', carry: 216, loft: 14 },
  { id: '5W', name: '5 Wood', carry: 203, loft: 17 },
  { id: '3I', name: '3 Iron', carry: 192, loft: 20 },
  { id: '4I', name: '4 Iron', carry: 183, loft: 23 },
  { id: '5I', name: '5 Iron', carry: 174, loft: 26 },
  { id: '6I', name: '6 Iron', carry: 164, loft: 29 },
  { id: '7I', name: '7 Iron', carry: 153, loft: 33 },
  { id: '8I', name: '8 Iron', carry: 141, loft: 37 },
  { id: '9I', name: '9 Iron', carry: 128, loft: 41 },
  { id: 'PW', name: 'Pitching Wedge', carry: 108, loft: 46 },
  { id: 'GW', name: 'Gap Wedge', carry: 90, loft: 51 },
  { id: 'SW', name: 'Sand Wedge', carry: 72, loft: 56 },
  { id: 'LW', name: 'Lob Wedge', carry: 52, loft: 60 },
  { id: 'PT', name: 'Putter', carry: 0, loft: 1 },
];

export const PUTTER_IDX = CLUBS.length - 1;

export function isWedge(club) {
  return club.loft >= 45 && club.id !== 'PT';
}

// Wedge shot styles: trade carry for trajectory around the greens.
// carryMul is where the ball LANDS relative to a stock swing — a bump
// lands shorter but runs out well past it.
export const STYLES = {
  chip: { key: 'chip', label: 'CHIP', loftMul: 1, v0Mul: 1, carryMul: 1 },
  flop: { key: 'flop', label: 'FLOP', loftMul: 1.45, v0Mul: 0.74, carryMul: 0.55 },
  bump: { key: 'bump', label: 'BUMP', loftMul: 0.5, v0Mul: 1.02, carryMul: 0.85 },
};
export const STYLE_ORDER = ['chip', 'flop', 'bump'];

// The "caddie" pick: effective distance folds in elevation change and the
// along-the-line wind component (computed by the caller). Never recommends
// the putter — that switch is made from the lie.
export function recommendClubIndex(effectiveDist) {
  let best = 0;
  let bestErr = Infinity;
  for (let i = 0; i < PUTTER_IDX; i++) {
    const err = Math.abs(CLUBS[i].carry - effectiveDist);
    if (err < bestErr) {
      bestErr = err;
      best = i;
    }
  }
  return best;
}

export const M_TO_YD = 1.09361;

export function yd(meters) {
  return Math.round(meters * M_TO_YD);
}

export function fmtDist(meters) {
  if (meters < 9.5) {
    const ft = meters * 3.28084;
    return `${ft.toFixed(1)} ft`;
  }
  return `${yd(meters)} yd`;
}
