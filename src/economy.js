// The betting math. The player's finishing position is drawn BEFORE the
// race from a distribution whose expected payout equals RTP x bet, and the
// bots are then choreographed around the player's real shots so the
// predetermined result always lands. Skill shapes the show, not the outcome.

import { shuffle } from './rng.js';

export const RTP = 0.96;

// Payout multiplier by finishing position (1st..5th). The champion's base
// prize is then multiplied by the bonus wheel (below).
export const MULTS = [2.0, 1.4, 0.4, 0, 0];

// Champion's Hole bonus wheel: 12 equal sectors, drawn uniformly.
// E[wheel] = (7*1 + 2*1.25 + 1.5 + 2 + 5) / 12 = 18/12 = 1.5, so the
// expected champion payout is 2.0 * 1.5 = 3.0x and total RTP stays
// 0.2 * (2.0*1.5 + 1.4 + 0.4) = 0.96.
export const WHEEL = [1, 1.25, 1, 2, 1, 1.5, 1, 5, 1, 1.25, 1, 1];

export const BETS = [10, 25, 50, 100, 250];

const KEY = 'thecut-balance-v1';

export function loadBalance() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) {
      const v = Number(raw);
      if (Number.isFinite(v) && v >= 0) return v;
    }
  } catch {}
  return 1000;
}

export function saveBalance(b) {
  try {
    localStorage.setItem(KEY, String(Math.round(b * 100) / 100));
  } catch {}
}

// Draw the script for a game: the player's finish, each bot's finish, and
// the wheel sector that will come up if the player takes the title.
// botFinish[i] is the finishing position of bot i (0..3).
export function makeRig(rng) {
  const playerFinish = 1 + Math.floor(rng() * 5);
  const rest = [1, 2, 3, 4, 5].filter((p) => p !== playerFinish);
  // Finals hitting order follows the semifinal: whoever wins hole 3 hits
  // second in the head-to-head. The player may only win the semifinal when
  // they are scripted to LOSE the final — then the bot opens with a dead-
  // stiff shot the player provably cannot beat (the lip-out floor). When
  // the player is scripted to WIN the final, the bot must hit last so it
  // can react, which means the bot must take the semifinal.
  const semiWinnerIsPlayer = playerFinish === 2 ? rng() < 0.5 : false;
  return {
    playerFinish,
    botFinish: shuffle(rng, rest),
    semiWinnerIsPlayer,
    wheelIdx: Math.floor(rng() * WHEEL.length) % WHEEL.length,
  };
}

// Given the player's actual distance this round, produce each alive bot's
// scripted distance so the right golfer misses the cut.
// round: 0..3 (round r eliminates finishing position 5-r).
export function botDistances(rig, round, playerDist, aliveBotIdxs, rng) {
  const elimPos = 5 - round;
  const P = Math.max(playerDist, 0.6);
  const out = new Map();

  if (rig.playerFinish === elimPos) {
    // Player's story ends here: every remaining bot sneaks inside them.
    const fracs = aliveBotIdxs.map(() => 0.2 + rng() * 0.68).sort((a, b) => a - b);
    aliveBotIdxs.forEach((bi, k) => {
      out.set(bi, Math.max(0.3, fracs[k] * P * 0.93));
    });
    return out;
  }

  // Otherwise the scripted bot blows it; everyone else lands around the player.
  const outDist = P * (1.12 + rng() * 0.3) + 1.5 + rng() * 4;
  for (const bi of aliveBotIdxs) {
    if (rig.botFinish[bi] === elimPos) {
      out.set(bi, outDist);
    } else {
      let d = P * (0.5 + rng() * 0.58);
      d = Math.min(d, outDist - 1.2);
      d = Math.max(d, 0.3);
      out.set(bi, d);
    }
  }
  return out;
}

// Full final standings (positions 1..5) as participant ids:
// 'P' for the player, 0..3 for bots.
export function finalStandings(rig) {
  const arr = [{ id: 'P', pos: rig.playerFinish }];
  rig.botFinish.forEach((pos, i) => arr.push({ id: i, pos }));
  return arr.sort((a, b) => a.pos - b.pos);
}
