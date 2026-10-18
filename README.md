# Neon Air Hockey — Webcam Battle

A two-player air hockey game for one webcam: each player moves a hand in
front of the camera, and MediaPipe Hands tracks it as the paddle. First to
**7 points** wins.

No backend, no build step, no audio assets — plain HTML + CSS + JavaScript
running 100% locally in your browser. Nothing from the webcam is uploaded;
hand tracking happens entirely on your machine.

![Controls](https://img.shields.io/badge/input-webcam%20hand%20tracking-00e5ff)

---

## 1. Quick start

Because the page needs camera access, it must be served over `http://localhost`
or HTTPS (browsers block `getUserMedia` on `file://` URLs).

```bash
# From the project folder, pick either:

# Python 3 (usually preinstalled on macOS/Linux)
python -m http.server 8000
# → open http://localhost:8000

# or Node
npx serve .
# → open the URL it prints (http://localhost:3000 by default)
```

Then click **START GAME** and **allow camera access** when prompted.

- **Desktop Chrome** is the recommended browser (also works in Edge and Firefox).
- **Mobile Chrome / Safari** work if the page is served over **HTTPS**
  (e.g. via `npx serve` behind a tunnel, or any static host like GitHub
  Pages / Netlify). Plain `http://<lan-ip>` will not get camera permission
  on phones.
- If the CDN scripts load slowly the first time, wait a few seconds — the
  hand-tracking model files are downloaded once and then cached.

## 2. How to play

1. **Start** → the browser asks for camera permission.
2. **Calibration** → both players show a hand to the camera. Each chip
   ("Player 1 Hand" / "Player 2 Hand") lights up green when the hand is
   detected. ~1s "Get Ready!" and the match begins.
3. **Control** — the camera feed is split into two halves (mirrored, so it
   behaves like a real mirror):
   - **Left/Right orientation (default):** the hand in the *left half* of
     the video controls Player 1 (cyan, defends the left goal); the hand in
     the *right half* controls Player 2 (magenta, right goal).
   - **Top/Bottom orientation:** upper half of the video → Player 2 (top of
     the table), lower half → Player 1 (bottom, classic mobile layout).
   - A small colored ring shows what the camera sees for each hand; the
     paddle follows your palm smoothly, but never leaves its own half.
4. **Hit the puck** by swinging your hand into it — faster swings transfer
   more momentum (that's the fun part).
5. **Scoring** — push the puck fully past the opponent's goal line. A
   celebration plays, then the puck re-serves toward the player who was
   scored on.
6. **Win** — first player to **7** takes the match. Hit *Play again* for a
   rematch or *Main menu* to restart from the title screen.

**Fairness & safety nets**

- The puck is served toward the scored-on player, never the scorer.
- If a player's hand is lost for a moment, that paddle freezes in place
  (with a "Show your hand" hint) instead of teleporting away.
- If **both** hands are missing for 3+ seconds the game auto-pauses;
  press *Resume* once hands are back.
- Paddles are speed-capped, so tracking glitches can't launch the puck.

## 3. Getting good tracking (lighting / camera tips)

MediaPipe is quite robust, but you can dramatically improve stability:

- **Lighting:** bright, even, front-facing light. Avoid a bright window
  *behind* you (backlight makes hands silhouette). Avoid strong colored light.
- **Background:** a plain, contrasting background helps more than anything.
  A solid wall, or anything that isn't skin-tone, works best. Patterned
  carpets and cluttered shelves produce ghost hands.
- **Framing:** keep both hands well inside the camera view — hands at the
  edge of the frame are easily dropped. Sit/stand about **0.5–1.5 m** from
  the webcam and angle it so both players' hands fit in frame.
- **Posture:** face the camera with an open palm; don't hold the hand
  sideways edge-on for long.
- **Distance between players:** keep each hand clearly inside its own half
  of the frame, away from the center line (crossing the line is allowed but
  immediately re-assigns the hand to the other player).
- **Performance:** close other tabs/video calls. If tracking feels heavy,
  lower `TRACK_MODEL_COMPLEXITY` is already at 0 (lite) in `js/config.js`.

## 4. In-game settings

Open the panel via the **pause button (II)** → *Settings*:

| Option | What it does |
|---|---|
| Table orientation | **Left/Right** (landscape webcams) or **Top/Bottom** (mobile-style). Switching re-serves the puck. |
| Smoothing strength | 0 = raw/sticky-fast, 1 = very smooth/laggy. ~0.5 is a good default. |
| Puck speed | Slow / Normal / Fast — scales serve speed and max speed. |
| Camera background | Show/hide the mirrored webcam feed behind the table. |
| Tracking markers | Show/hide the position ring drawn on each detected hand. |
| Debug mode | Small FPS counter in the corner. |
| Sound effects | Toggle all procedural SFX. |

Settings are saved in `localStorage` and restored on the next visit.

## 5. Tuning `js/config.js`

Every gameplay constant lives in this one frozen object. Most useful knobs:

| Constant | Default | Effect |
|---|---|---|
| `WIN_SCORE` | 7 | Points needed to win. |
| `PUCK_FRICTION` | 0.9992 | Velocity kept per physics step (1/120 s). Lower = gluey table, higher = long rallies. |
| `PUCK_WALL_RESTITUTION` | 0.86 | Energy kept on wall bounces (1 = perfectly elastic). |
| `PUCK_MAX_SPEED` | 2200 | Hard cap, px/s in table space. Raise for chaos. |
| `PUCK_SERVE_SPEED_BASE` | 480 | Serve speed (× difficulty multiplier). |
| `PADDLE_MAX_SPEED` | 2500 | Paddle speed cap — tracking glitches shield. |
| `PADDLE_MAX_HIT_BOOST` | 900 | Extra kick on hard swings. |
| `FIXED_DT` | 1/120 | Physics timestep. Keep ≤ 1/60. |
| `GOAL_WIDTH` | 240 | Goal mouth width (larger = easier scoring). |
| `PUCK_RADIUS` / `PADDLE_RADIUS` | 22 / 36 | Sizes in table pixels (table is 1280×720 or 720×1280). |
| `PUCK_STUCK_TIME` / `PUCK_NUDGE_SPEED` | 1.6 s / 260 | Anti-stuck: how long a slow puck is tolerated before the nudge, and how hard it's nudged. |
| `DEFAULT_SMOOTHING` | 0.5 | Same as the settings slider. |
| `MISSING_HAND_TIMEOUT` | 3000 | ms of lost hands before auto-pause. |
| `CAM_BG_OPACITY` | 0.35 | Visibility of the camera feed behind the table. |
| `CAMERA_WIDTH/HEIGHT` | 1280×720 | Requested camera resolution. |

`SCORE_RESET_DELAY`, `TRACK_*`, `HINT_SHOW_DELAY`, `CORNER_RADIUS` and the
`*_TOGGLES_*` defaults are also tweakable — each is commented in the file.

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| "Camera error: NotAllowedError" | Permission denied. Click the padlock icon in the address bar → allow camera → reload. |
| Only one chip lights up in calibration | Both players must keep hands in frame; check lighting/contrast. You'll wait until both are seen. |
| Game keeps auto-pausing | Camera dropped out or both hands left the frame. Resume once hands are visible again. |
| Paddle feels laggy | Lower *Smoothing strength* in settings. |
| Paddle twitches | Raise smoothing slightly; improve lighting/background. |
| Hands swap players | One player's hand crossed the center line — the split assigns by position. Keep hands apart. |
| No sound | Sound starts after your first click (browser policy); check the Sound Effects toggle. |
| Black camera / device busy | Another app has the webcam; close it and reload. |

## 7. Project layout

```
index.html          layout, MediaPipe CDN, overlays
style.css           neon arcade theme
js/config.js        every tuning constant (start here)
js/audio.js         Web Audio synth SFX (no files)
js/tracking.js      MediaPipe Hands → paddle targets (/s velocity)
js/physics.js       fixed-timestep physics, collisions, goals, anti-stuck
js/renderer.js      camera feed, neon table, paddles, puck, effects, particles
js/game.js          state machine, HUD, scoring, settings
```

Runs entirely client-side; the only network use is the MediaPipe CDN
(model + WASM) which is cached by the browser after the first load.

*Have fun — and remember: the mallet is your hand.*
