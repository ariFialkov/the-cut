# ⛳ The Cut

A 3D closest-to-the-pin betting game, playable as a PWA on mobile and desktop.

Five golfers tee it up on five procedurally generated par-3s. Each hole is a
closest-to-the-pin contest — the golfer furthest from the pin **misses the cut**
and is eliminated. Outlast the field and take the top prize.

## Running it

The game is a fully static site — no build step. Serve the repo root with any
static server and open it:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Everything (including Three.js, vendored in `lib/`) is served locally and
pre-cached by the service worker, so once loaded the game works fully offline
and can be installed to the home screen / desktop as a PWA.

> Requires a browser with import-map support (Chrome 89+, Safari 16.4+, Firefox 108+).

## How to play

| Action | Mobile | Desktop |
|---|---|---|
| Aim | hold the left / right edge of the screen | `A` / `D` |
| Change club | ‹ › buttons | `Q` / `E` (or buttons) |
| Swing | drag **down**, then push **up** through the ball in one motion | click-drag, same motion |

The caddie pre-selects a club from the pin distance, elevation change and wind —
you can always override it. The forward stroke is graded on four axes:

- **Straightness** — a stroke skewed right slices, skewed left hooks.
- **Cleanliness** — wobbles and zig-zags bleed carry distance.
- **Pace** — too fast hits a low screamer, too slow balloons the ball.
- **Smoothness** — jerky speed changes spray your aim inside a scatter cone.

Wind, elevated or sunken greens, island greens, forced carries, canyons and
bunker complexes are all generated per hole — most holes want a moment of
thought before you pull a club.

Each hole of a game is a different contest:

1. **Closest to the pin** — one swing, furthest from the pin is cut.
2. **Stroke play** — a full hole (usually a par 4): play until you hole out
   (1.1 m gimme, water costs a penalty drop). Most strokes is cut; ties go to
   the longest tee shot.
3. **Time race** — a full par 4 against the clock, and between shots you
   **drive a golf cart** to your ball (steer with the screen edges / A-D;
   water slows you down). Slowest to hole out is cut. No fast-forward here —
   time is the score.
4. **Head-to-head** — closest to the pin; the semifinal winner hits second.
5. **The Wheel** — the champion's bonus shot at the prize wheel.

## The betting model (read this before auditing the "AI")

This is a **simulated-multiplayer betting game**, not a skill contest. The four
opponents are bots, and the game is engineered so the *outcome* is
deterministic while the *show* is real:

- Before the lobby even fills, the player's finishing position (1st–5th) is
  drawn uniformly (20% each), along with the bonus-wheel sector used if they
  win. Payout multipliers by position are **×2.0×wheel / ×1.4 / ×0.4 / ×0 /
  ×0**, where the 12-sector wheel `[×1 ×7, ×1.25 ×2, ×1.5, ×2, ×5]` has
  `E[wheel] = 1.5`. Expected return is
  `0.2 × (2.0×1.5 + 1.4 + 0.4) = 0.96` — a **96% RTP**, independent of skill,
  with no leakage from the wheel. Prizes scale linearly with the bet.
- Each bot is also assigned a finishing position, which fixes exactly who gets
  cut on every hole. The four opponents are drawn per game from a bank of ten
  parody pros (articulated low-poly rigs with distinct outfits).
- Stroke play and the race stay deterministic the same way: each player
  stroke's outcome is pre-simulated at contact, so the holing stroke is known
  the moment it is struck. Bots that must beat the player hole out on that
  same concurrent stroke (in the race, they drop their putt during the
  player's ball flight); bots that must lose stall near the green and finish
  just behind — one stroke worse, or a few seconds slower. On the player's
  elimination holes every bot also outdrives their tee shot so the stroke-play
  tiebreak can never rescue them.
- The head-to-head final honors the semifinal: whoever wins hole 3 hits
  **second** in the final. The player may only be dealt the semifinal win when
  they are scripted to lose the final — the bot then opens with a sub-2-foot
  dart that the player's lip-out floor provably cannot beat. When the player is
  scripted to win the final, the bot takes the semifinal so it hits last and
  can react to the player's real shot.
- The player's shot is fully physically simulated — your swing quality decides
  where your ball actually lands. Because the integrator is deterministic, the
  outcome is pre-simulated at the instant of contact, so all five golfers tee
  off simultaneously from their own gates: bot shots are real physics flights
  whose launch speed is *solved* (bisection over pre-simulations) to bounce and
  roll to a resting spot on the scripted side of the player's ball. On the
  player's elimination hole every remaining bot sneaks inside them (a would-be
  ace "lips out" so the script can never be beaten); otherwise the doomed bot
  always finishes farthest. The head-to-head final is sequential for drama:
  player first, then the last bot answers.
- Positions 1–4 are decided across holes 1–4 (one cut per hole). Hole 5 is
  **The Wheel** — the champion tees off at a giant spinning prize wheel sunk
  into the green. Wherever the ball rests, the wheel brakes so the pre-drawn
  sector lands under it; a miss gets a free drop. Every sector pays at least
  ×1 of the champion prize.

Balance is stored locally (`localStorage`) and starts at 1000 coins — this is a
demo economy with a free refill when you bust.

## Code map

```
index.html            shell, DOM for all screens, import map
styles.css            all UI styling
sw.js                 offline cache (PWA)
manifest.webmanifest  PWA manifest
lib/three.module.js   vendored Three.js
src/
  main.js       orchestrator: renderer, camera rig, game state machine
  course.js     procedural hole generation (terrain, hazards, dressing)
  physics.js    ball flight (drag/lift/curve/wind), bounce & roll, club calibration
  swing.js      swing gesture capture + stroke analysis → shot parameters
  golfer.js     low-poly golfer construction + pose/animation rig
  economy.js    RTP draw, payout table, bot distance scripting
  ui.js         DOM manipulation for every screen
  sfx.js        WebAudio synth (no audio assets)
  rng.js        seeded RNG + value noise
tools/gen_icons.py    regenerates the PWA icons (stdlib only)
```

### Debug hooks

Append `?debug` for console logging of the rigged script and per-hole results.
`window.__thecut` exposes `phase`, `balance`, `autoSwing(quality)`,
`startGame(bet)` and `forceFinish` for automated testing.
