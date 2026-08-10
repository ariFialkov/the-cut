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

## The betting model (read this before auditing the "AI")

This is a **simulated-multiplayer betting game**, not a skill contest. The four
opponents are bots, and the game is engineered so the *outcome* is
deterministic while the *show* is real:

- Before the lobby even fills, the player's finishing position (1st–5th) is
  drawn uniformly (20% each). With payout multipliers of **×3.0 / ×1.4 / ×0.4 /
  ×0 / ×0** by position, expected return is `0.2 × (3.0 + 1.4 + 0.4) = 0.96` —
  a **96% RTP**, independent of skill. Prizes scale linearly with the bet.
- Each bot is also assigned a finishing position, which fixes exactly who gets
  cut on every hole.
- The player's shot is fully physically simulated — your swing quality decides
  where your ball actually lands. The bots then hit *around* that result:
  on a hole the player is scripted to survive, the doomed bot always lands
  farther out; on the player's elimination hole, every remaining bot sneaks
  inside the player's ball (and a would-be ace "lips out" so the script can
  never be beaten).
- Positions 1–4 are decided across holes 1–4 (one cut per hole). Hole 5 is the
  **Champion's Hole** — a ceremonial victory shot for the winner, which is what
  makes the game a 5-step ladder with 5 players.

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
