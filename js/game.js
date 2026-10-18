/**
 * game.js
 * ==========================================================================
 * Main controller: state machine + rAF loop that wires together
 * TrackingManager (input), PhysicsWorld (simulation) and Renderer (output).
 *
 * Game states:
 *   start        -> MAIN MENU (slanted buttons driven by the hand cursor;
 *                   camera starts once bottom of the loop needs it — i.e.
 *                   on the first PLAY / SOLO launch request)
 *   calibration  -> wait until the required hand(s) are detected, then a
 *                   3-second READY countdown
 *   playing      -> normal play (world.update + events each frame)
 *   goal         -> short celebration + GOAL splash, then serve toward the
 *                   scored-on player
 *   paused       -> user pause OR auto-pause (hand(s) lost > timeout)
 *   gameover     -> win screen at CONFIG.WIN_SCORE
 *
 * Modes: '2p' (both hands required) and 'solo' (P1 hand vs a simple AI
 * that controls the P2 paddle — only P1's hand drives the game).
 * ==========================================================================
 */

/* ------------------------------------------------------------------ */
/* Tuning / helpers                                                   */
/* ------------------------------------------------------------------ */

const SPEED_MULT = { slow: 0.75, normal: 1.0, fast: 1.3 };
const READY_TIME = 3.0;              // s of READY countdown after hand(s) found

/* Solo AI: steers the P2 paddle toward the puck with a small lead and
   returns to a defensive home position when the puck is on P1's half.
   Speed is still capped by PADDLE_MAX_SPEED in the physics step. */
const AI = {
  homeX: 0.82,          // neutral x position (normalized)
  lerp: 0.10,           // target smoothing per frame
  lead: 0.12,           // s of puck vel lead on defense
};

/* Menu hand-cursor timing */
const DWELL_TIME_MS = 1000;    // hold to confirm
const CURSOR_COOLDOWN_MS = 800;// pause after activation
const LIGHT_CHECK_MS = 600;    // camera-lighting sampling interval
const LIGHT_DARK_THRESHOLD = 48;// avg luma (0-255) below this = too dark

const DOM = (id) => document.getElementById(id);

const els = {
  hud: DOM('gameHud'),
  p1Score: DOM('p1Score'), p2Score: DOM('p2Score'),
  pauseBtn: DOM('pauseBtn'), fpsDisplay: DOM('fpsDisplay'),
  hintP1: DOM('handHintP1'), hintP2: DOM('handHintP2'),

  warnP1: DOM('handWarningP1'), warnP2: DOM('handWarningP2'),
  warnP1Text: DOM('handWarningTextP1'), warnP2Text: DOM('handWarningTextP2'),

  goalSplash: DOM('goalSplash'),

  startScreen: DOM('startScreen'),
  menuPlay2p: DOM('menuPlay2p'), menuSolo: DOM('menuSolo'),
  menuHowTo: DOM('menuHowTo'), menuSettings: DOM('menuSettings'),
  menuBackBtn: DOM('menuBackBtn'),
  attractCanvas: DOM('attractCanvas'), camPreview: DOM('camPreview'),
  statusHandDot: DOM('statusHandDot'), statusHandText: DOM('statusHandText'),
  statusLightDot: DOM('statusLightDot'), statusLightText: DOM('statusLightText'),
  menuCursor: DOM('menuCursor'),

  howToScreen: DOM('howToScreen'), howToBackBtn: DOM('howToBackBtn'),

  calibScreen: DOM('calibrationScreen'),
  calibHalfP2: DOM('calibHalfP2'),
  calibP1: DOM('calibP1'), calibP2: DOM('calibP2'), calibPrompt: DOM('calibPrompt'),

  pauseScreen: DOM('pauseScreen'), resumeBtn: DOM('resumeBtn'),
  openSettingsBtn: DOM('openSettingsBtn'), quitBtn: DOM('quitBtn'),

  settingsModal: DOM('settingsModal'),
  orientationSelect: DOM('orientationSelect'), smoothingRange: DOM('smoothingRange'),
  smoothingValue: DOM('smoothingValue'), puckSpeedSelect: DOM('puckSpeedSelect'),
  cameraBgToggle: DOM('cameraBgToggle'), markersToggle: DOM('markersToggle'),
  debugToggle: DOM('debugToggle'), soundToggle: DOM('soundToggle'),
  settingsCloseBtn: DOM('settingsCloseBtn'),

  gameOverScreen: DOM('gameOverScreen'), winnerMessage: DOM('winnerMessage'),
  finalScoreLine: DOM('finalScoreLine'), playAgainBtn: DOM('playAgainBtn'),
  backToMenuBtn: DOM('backToMenuBtn'),
};

const SETTINGS_KEY = 'neonAirHockeySettings.v1';
const DEFAULT_SETTINGS = {
  orientation: CONFIG.DEFAULT_ORIENTATION,
  smoothing: CONFIG.DEFAULT_SMOOTHING,
  puckSpeed: 'normal',
  camBg: CONFIG.DEFAULT_SHOW_CAM_BG,
  markers: CONFIG.DEFAULT_SHOW_MARKERS,
  debug: CONFIG.DEFAULT_SHOW_DEBUG,
  sound: CONFIG.DEFAULT_SOUND,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (e) { /* private mode etc. */ }
  return Object.assign({}, DEFAULT_SETTINGS);
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* noop */ }
}

/* ------------------------------------------------------------------ */
/* Game object                                                        */
/* ------------------------------------------------------------------ */

const settings = loadSettings();

const world = new PhysicsWorld(settings.orientation);
const renderer = new Renderer(DOM('gameCanvas'), DOM('cameraFeed'));

const attractCtx = els.attractCanvas.getContext('2d');
const previewCtx = els.camPreview.getContext('2d');

const game = {
  state: 'start',
  menuPage: 'main',        // 'main' | 'howto'
  mode: '2p',              // '2p' | 'solo'
  cameraRequested: false,  // start() launched once
  cameraError: null,

  prevState: 'playing',    // where pause() came from
  scores: [0, 0],
  goalTimer: 0,            // s remaining in 'goal' state
  lastScorer: -1,
  readyTimer: 0,           // s remaining of READY countdown
  handsReadyGrace: 0,      // requires hands stable during calibration

  aiTarget: { x: AI.homeX, y: 0.5 },  // solo paddle steering target

  // menu cursor controller
  cursorHover: null,       // hovered .hx-btn or null
  dwell: 0,                // ms accumulated on the current hover
  cursorCooldown: 0,       // ms remaining before next activation
  menuButtons: [],         // cached button list

  // menu fx
  lightLevel: 'unknown',   // 'ok' | 'dark' | 'unknown'
  lightTimer: 0,           // ms until next lighting sample
  lightCanvas: null, lightCtx: null,

  // attract-mode sim (normalized unit space)
  attract: { x: 0.5, y: 0.3, vx: 0.46, vy: 0.38, t: 0 },

  fpsFrames: 0, fpsTime: 0,
  warnings: {              // fed to the renderer for boundary/depth flashes
    p1: { oob: false, depth: false, lost: false, depthState: null },
    p2: { oob: false, depth: false, lost: false, depthState: null },
  },
  uiTimer: 0,              // ms accumulator for throttled DOM updates
  alarmTimer: 0,           // ms pacing for the continuous alarm
  anyAlarm: false,
};

/* ------------------------------------------------------------------ */
/* UI helpers                                                         */
/* ------------------------------------------------------------------ */

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

/** show + replay the 200ms entrance animation */
function showScreen(el) {
  el.classList.remove('hidden', 'anim-in');
  void el.offsetWidth;                   // force reflow to restart animation
  el.classList.add('anim-in');
}

function setScoreUI() {
  els.p1Score.textContent = game.scores[0];
  els.p2Score.textContent = game.scores[1];
}

function showHints(p1, p2) {
  els.hintP1.classList.toggle('hidden', !p1);
  els.hintP2.classList.toggle('hidden', !p2);
}

function clickSfx() { soundManager.click(); }

/* ------------------------------------------------------------------ */
/* Settings plumbing                                                  */
/* ------------------------------------------------------------------ */

function applySettings() {
  TrackingManager.setSmoothing(settings.smoothing);
  TrackingManager.setOrientation(settings.orientation);

  renderer.setOrientation(settings.orientation);
  renderer.showCamBg = settings.camBg;
  renderer.showMarkers = settings.markers;

  world.setOrientation(settings.orientation);
  world.setSpeedMult(SPEED_MULT[settings.puckSpeed] || 1);

  soundManager.setEnabled(settings.sound);
  els.fpsDisplay.classList.toggle('hidden', !settings.debug);
  saveSettings();
}

function syncSettingsUI() {
  els.orientationSelect.value = settings.orientation;
  els.smoothingRange.value = settings.smoothing;
  els.smoothingValue.textContent = (+settings.smoothing).toFixed(2);
  els.puckSpeedSelect.value = settings.puckSpeed;
  els.cameraBgToggle.checked = settings.camBg;
  els.markersToggle.checked = settings.markers;
  els.debugToggle.checked = settings.debug;
  els.soundToggle.checked = settings.sound;
}

/* ------------------------------------------------------------------ */
/* Camera start                                                       */
/* ------------------------------------------------------------------ */

async function startCamera() {
  if (game.cameraRequested) return TrackingManager.isRunning();
  game.cameraRequested = true;
  try {
    await TrackingManager.start();
  } catch (err) {
    console.warn('[game] camera start failed:', err);
    game.cameraError = err.message || String(err);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Menu flow                                                          */
/* ------------------------------------------------------------------ */

function goToMenu(page = 'main') {
  hide(els.hud);
  hide(els.calibScreen);
  hide(els.gameOverScreen);
  hide(els.pauseScreen);
  hide(els.settingsModal);
  els.winnerMessage.classList.remove('winner-p1', 'winner-p2');

  if (page === 'howto') {
    showScreen(els.howToScreen);
    hide(els.startScreen);
    game.menuPage = 'howto';
  } else {
    hide(els.howToScreen);
    showScreen(els.startScreen);
    game.menuPage = 'main';
  }
  resetMenuCursor();
  game.state = 'start';
}

/** launched from the menu: 2 players or solo vs AI */
async function launchGame(mode) {
  soundManager.unlock();

  const cameraReady = await startCamera();
  if (!cameraReady && !TrackingManager.isRunning()) {
    // error already surfaced through the menu status line
    if (game.state !== 'start') goToMenu('main');
    return;
  }

  game.mode = mode;
  hide(els.startScreen);
  hide(els.howToScreen);
  hide(els.gameOverScreen);
  hide(els.pauseScreen);
  enterCalibration();
}

function resetMenuCursor() {
  if (game.cursorHover) {
    game.cursorHover.classList.remove('hot');
    const bar = game.cursorHover.querySelector('.dwell i');
    if (bar) bar.style.width = '0%';
    game.cursorHover = null;
  }
  game.dwell = 0;
  game.cursorCooldown = 0;
  game.prevPinch = false;
  if (els.menuCursor) els.menuCursor.classList.add('hidden');
}

/* ------------------------------------------------------------------ */
/* Goal / win handling                                                */
/* ------------------------------------------------------------------ */

function handleGoal(ev) {
  soundManager.goal();
  game.scores[ev.scorer]++;
  game.lastScorer = ev.scorer;
  setScoreUI();

  const col = THEME.P_COLORS[ev.scorer];
  const gc = renderer.goalCenterOf(ev.scorer);
  renderer.spawnBurst(gc.x, gc.y, col, 60, 420);
  renderer.addFlash(gc.x, gc.y, col, 10, 260, 0.8);
  renderer.shakeScreen(9);

  // scoring flash across the half that conceded
  renderer.flashGoal(ev.scorer === 0 ? 1 : 0, col);

  // big GOAL splash in the scorer's color
  els.goalSplash.classList.remove('hidden', 'goal-splash--p1', 'goal-splash--p2');
  els.goalSplash.classList.add(ev.scorer === 0 ? 'goal-splash--p1' : 'goal-splash--p2');
  // restart the CSS pop animation
  const text = els.goalSplash.firstElementChild;
  if (text) { text.style.animation = 'none'; void text.offsetWidth; text.style.animation = ''; }

  world.frozen = true;
  game.state = 'goal';         // key timers treated in seconds
  game.goalTimer = CONFIG.SCORE_RESET_DELAY / 1000;
}

function gameOver() {
  game.state = 'gameover';
  const w = game.scores[0] >= CONFIG.WIN_SCORE ? 0 : 1;
  els.winnerMessage.textContent = `PLAYER ${w + 1} WINS!`;
  els.winnerMessage.classList.remove('winner-p1', 'winner-p2');
  els.winnerMessage.classList.add(w === 0 ? 'winner-p1' : 'winner-p2');
  els.finalScoreLine.textContent = `${game.scores[0]} — ${game.scores[1]}`;
  showScreen(els.gameOverScreen);
  soundManager.goal();

  // celebratory burst from the center
  const W = renderer.W, H = renderer.H;
  for (let i = 0; i < 3; i++) {
    renderer.spawnBurst(W / 2 + (i - 1) * 120, H / 2, THEME.P_COLORS[w], 40, 500);
  }
}

function resetForNewGame() {
  game.scores = [0, 0];
  setScoreUI();
  renderer.resetTrail();
  world.placePuckCenter();
  game.fpsFrames = 0; game.fpsTime = 0;
}

/** common transition into calibration (fresh game or play again) */
function enterCalibration() {
  resetForNewGame();
  // solo: P2 paddle is AI driven, so hide its calibration half
  els.calibHalfP2.classList.toggle('hidden', game.mode === 'solo');
  els.calibP1.dataset.state = 'missing';
  els.calibP2.dataset.state = 'missing';
  showScreen(els.calibScreen);
  els.calibPrompt.textContent = '3';
  game.state = 'calibration';
  game.handsReadyGrace = 0;
  game.readyTimer = READY_TIME;
}

/* ------------------------------------------------------------------ */
/* Solo AI                                                            */
/* ------------------------------------------------------------------ */

const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

/** steer the AI target toward the puck (defensive when puck is away) */
function applyAITarget(target) {
  const puck = world.puck;
  const nx = puck.x / world.W, ny = puck.y / world.H;
  const nvy = puck.vy / world.H;

  let tx, ty;
  if (nx < 0.5) {
    // puck on the player's half: hold the defensive home spot
    tx = AI.homeX;
    ty = 0.5;
  } else {
    // defend/tracking: edge toward the puck, lead by its vertical velocity
    tx = clamp(0.55 + nx * 0.45, 0.55, 0.95);
    ty = clamp(ny + nvy * AI.lead, 0.05, 0.95);
  }

  target.x += (tx - target.x) * AI.lerp;
  target.y += (ty - target.y) * AI.lerp;
}

/* ------------------------------------------------------------------ */
/* Main loop                                                          */
/* ------------------------------------------------------------------ */

// reused every frame — avoids per-frame object allocation in the hot loop
const _paddleTargets = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
function paddleTargets() {
  const ps = TrackingManager.getPlayers();
  _paddleTargets[0].x = ps[0].smooth.x; _paddleTargets[0].y = ps[0].smooth.y;
  if (game.mode === 'solo') {
    applyAITarget(game.aiTarget);
    _paddleTargets[1].x = game.aiTarget.x; _paddleTargets[1].y = game.aiTarget.y;
  } else {
    _paddleTargets[1].x = ps[1].smooth.x; _paddleTargets[1].y = ps[1].smooth.y;
  }
  return _paddleTargets;
}

/** who must have a hand on deck for play to continue */
function requiredAbsenceMs() {
  return game.mode === 'solo' ? TrackingManager.absentMs(0) : TrackingManager.bothAbsentMs();
}

function handleEvents(events) {
  for (const ev of events) {
    switch (ev.type) {
      case 'paddleHit': {
        soundManager.hit(ev.strength);
        const col = THEME.P_COLORS[ev.player];
        renderer.spawnBurst(ev.x, ev.y, col, Math.round(6 + 18 * ev.strength), 140 + 260 * ev.strength);
        renderer.addFlash(ev.x, ev.y, col, 6, 40, 0.35);
        if (ev.strength > 0.55) renderer.shakeScreen(3 + 4 * ev.strength);
        break;
      }
      case 'wallHit':
        soundManager.wall(ev.strength * 0.9);
        renderer.spawnBurst(ev.x, ev.y, `rgba(${THEME.TRAIL_RGB},1)`, Math.round(3 + 10 * ev.strength), 110);
        break;
      case 'goal':
        handleGoal(ev);
        break;
      case 'nudge':
        soundManager.wall(0.25);
        break;
    }
  }
}

/**
 * Accuracy warnings: reads lost / out-of-bounds / depth flags from tracking
 * every frame (cheap, feeds the renderer) but only touches the DOM and the
 * alarm every ~100ms / ~0.5s (UI_UPDATE_MS / ALARM_PULSE_MS) so DOM churn
 * and audio scheduling never cost frame time.
 */
function updateWarnings(domDue) {
  const active = game.state === 'playing' || game.state === 'goal';
  const players = TrackingManager.getPlayers();
  let anyAlarm = false;

  for (let i = 0; i < 2; i++) {
    // solo: only the human side is tracked
    const tracked = game.mode === '2p' || i === 0;
    const p = players[i];
    const w = i === 0 ? game.warnings.p1 : game.warnings.p2;

    // renderer flags — every frame (pure object writes, no DOM)
    w.lost = active && tracked && !!p.isLost;
    w.oob = active && tracked && !p.isLost && !!p.isOutOfBounds;
    w.depth = active && tracked && !!p.isTooFarOrClose;
    w.depthState = tracked ? p.depthState : null;

    const wEl = i === 0 ? els.warnP1 : els.warnP2;
    const textEl = i === 0 ? els.warnP1Text : els.warnP2Text;
    const text = !tracked ? null
      : w.lost ? 'HAND LOST / OUT OF SCREEN'
      : w.oob ? 'HAND OUT OF BOUNDS'
      : w.depth
        ? (p.depthState === 'far' ? 'TOO FAR FROM CAMERA' : 'MOVE BACK FROM CAMERA')
        : null;

    if (text) anyAlarm = true;

    // DOM only when throttled due AND the state actually changed
    if (domDue && wEl.dataset.warn !== (text || 'off')) {
      wEl.dataset.warn = text || 'off';
      if (text) { textEl.textContent = text; show(wEl); }
      else hide(wEl);
    }
  }

  game.anyAlarm = anyAlarm;
  // reset pacing so the next appearing warning beeps immediately
  if (!anyAlarm) game.alarmTimer = 0;
}

function updateHints(domDue) {
  if (!domDue) return;              // DOM work only ~10Hz
  const active = game.state === 'playing' || game.state === 'goal';
  const solo = game.mode === 'solo';
  showHints(
    active && TrackingManager.absentMs(0) > CONFIG.HINT_SHOW_DELAY,
    active && !solo && TrackingManager.absentMs(1) > CONFIG.HINT_SHOW_DELAY,
  );
}

/* ------------------------------------------------------------------ */
/* Main menu fx: attract sim, camera preview, status, cursor          */
/* ------------------------------------------------------------------ */

/** tiny ghost-hockey sim looping left<->right over the attract canvas */
function drawAttract(dt) {
  const c = els.attractCanvas;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }

  const S = game.attract;
  S.t += dt;
  S.x += S.vx * dt; S.y += S.vy * dt;
  if (S.x < 0.06 || S.x > 0.94) { S.vx *= -1; S.x = clamp(S.x, 0.06, 0.94); }
  if (S.y < 0.08 || S.y > 0.92) { S.vy *= -1; S.y = clamp(S.y, 0.08, 0.92); }

  const ctx = attractCtx;
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = 0.22;

  // ghost paddles that follow the puck loosely
  const p1x = 0.08 * w, p1y = (S.y + Math.sin(S.t * 1.1) * 0.1) * h;
  const p2x = 0.92 * w, p2y = (S.y + Math.cos(S.t * 1.3) * 0.1) * h;
  ctx.strokeStyle = THEME.P_COLORS[0];
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(p1x, p1y, 0.06 * h, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = THEME.P_COLORS[1];
  ctx.beginPath(); ctx.arc(p2x, p2y, 0.06 * h, 0, Math.PI * 2); ctx.stroke();

  // ghost puck + trail
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = THEME.PUCK;
  ctx.beginPath();
  ctx.arc(S.x * w, S.y * h, Math.max(5, 0.018 * h), 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 1;
}

/** mirrored camera preview + tint + hand skeleton overlay */
function drawPreview() {
  const c = els.camPreview;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }

  const ctx = previewCtx;
  ctx.clearRect(0, 0, w, h);
  const video = TrackingManager.getVideo();
  if (!video || !video.videoWidth) return;

  const vw = video.videoWidth, vh = video.videoHeight;
  const k = Math.max(w / vw, h / vh);            // cover-fit
  const dw = vw * k, dh = vh * k;
  const ox = (w - dw) / 2, oy = (h - dh) / 2;

  // mirrored, tinted feed
  ctx.save();
  ctx.translate(w, 0); ctx.scale(-1, 1);
  ctx.globalAlpha = 0.35;
  ctx.drawImage(video, ox, oy, dw, dh);
  ctx.restore();
  ctx.fillStyle = 'rgba(0, 229, 255, 0.06)';
  ctx.fillRect(0, 0, w, h);

  // skeleton overlay over mirrored coords
  const { pairs, count } = TrackingManager.getRawHands();
  for (let i = 0; i < count; i++) {
    const pts = pairs[i];
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.8)';
    ctx.lineWidth = 2;
    // bones: wrist->fingers chain
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(ox + pts[a * 2] * dw, oy + pts[a * 2 + 1] * dh);
      ctx.lineTo(ox + pts[b * 2] * dw, oy + pts[b * 2 + 1] * dh);
      ctx.stroke();
    }
    // tips
    ctx.fillStyle = 'rgba(244, 255, 249, 0.9)';
    for (let j = 0; j < 21; j++) {
      ctx.beginPath();
      ctx.arc(ox + pts[j * 2] * dw, oy + pts[j * 2 + 1] * dh, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* MediaPipe Hands topology: per-finger chains + thumb chain + palm base */
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],           // index
  [5, 9], [9, 10], [10, 11], [11, 12],      // middle
  [9, 13], [13, 14], [14, 15], [15, 16],    // ring
  [13, 17], [17, 18], [18, 19], [19, 20],   // pinky
  [0, 17],                                   // palm base
];

/** 24px luma probe: is the room too dark for reliable tracking? */
function updateLightStatus(dtMs) {
  game.lightTimer -= dtMs;
  if (game.lightTimer > 0) return;
  game.lightTimer = LIGHT_CHECK_MS;

  const video = TrackingManager.getVideo();
  if (!video || !video.videoWidth) { game.lightLevel = 'unknown'; return; }

  if (!game.lightCanvas) {
    game.lightCanvas = document.createElement('canvas');
    game.lightCanvas.width = 24; game.lightCanvas.height = 24;
    game.lightCtx = game.lightCanvas.getContext('2d', { willReadFrequently: true });
  }
  try {
    game.lightCtx.drawImage(video, 0, 0, 24, 24);
    const d = game.lightCtx.getImageData(0, 0, 24, 24).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      // quick Rec.601 luma
      sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    const avg = sum / (d.length / 4);
    game.lightLevel = avg >= LIGHT_DARK_THRESHOLD ? 'ok' : 'dark';
  } catch (e) {
    game.lightLevel = 'unknown';
  }
}

/** status line at the bottom of the menu (~10Hz, throttled) */
function updateMenuStatus() {
  if (game.menuPage !== 'main') return;

  let handText, handOk;
  if (game.cameraError) {
    handText = 'CAMERA ERROR'; handOk = false;
    els.statusLightText.textContent = 'CHECK PERMISSIONS';
    els.statusLightDot.className = 'dot dot--bad';
    apply();
    return;
  }

  const cursor = TrackingManager.getMenuCursor ? TrackingManager.getMenuCursor() : null;
  handOk = !!(cursor && cursor.seen);
  handText = handOk ? 'HAND DETECTED' : 'NO HAND';

  const light = game.lightLevel;
  const lightOk = light === 'ok';
  els.statusLightText.textContent =
    light === 'unknown' ? 'LIGHT: --' : (lightOk ? 'LIGHT: GOOD' : 'LIGHT: TOO DARK');
  els.statusLightDot.className = light === 'unknown' ? 'dot dot-spacer' : `dot dot-spacer dot--${lightOk ? 'ok' : 'bad'}`;

  apply();

  function apply() {
    els.statusHandText.textContent = handText;
    els.statusHandDot.className = `dot dot--${handOk ? 'ok' : 'bad'}`;
  }
}

/* ---- hand-driven menu cursor -------------------------------------- */

/** refresh the cached list of visible .hx-btn for cursor collision */
function refreshMenuButtons() {
  game.menuButtons = game.menuPage === 'main'
    ? [els.menuPlay2p, els.menuSolo, els.menuHowTo, els.menuSettings, els.menuBackBtn]
    : [els.howToBackBtn];
}

/**
 * Hand cursor: index fingertip (from TrackingManager) mapped to the
 * viewport through a cover-fit of the video frame; dwell 1s + progress
 * bar to confirm, pinch (index-thumb) to activate instantly. Mouse users
 * click buttons natively.
 */
function updateMenuCursor(dtMs) {
  const cursorEl = els.menuCursor;
  const menuVisible = game.state === 'start';

  if (!menuVisible) { cursorEl.classList.add('hidden'); return; }

  const mc = TrackingManager.getMenuCursor
    ? TrackingManager.getMenuCursor() : null;

  if (!mc || !mc.seen) {
    // no hand -> clear hover + dwell, hide the cursor DOM
    if (game.cursorHover) {
      game.cursorHover.classList.remove('hot');
      game.cursorHover = null;
    }
    game.dwell = 0;
    cursorEl.classList.add('hidden');
    return;
  }

  // map normalized (mirrored) video coords to viewport px via cover-fit
  const video = TrackingManager.getVideo();
  const vw = video ? video.videoWidth : 0, vh = video ? video.videoHeight : 0;
  if (!vw || !vh) { cursorEl.classList.add('hidden'); return; }

  const innerW = window.innerWidth, innerH = window.innerHeight;
  const k = Math.max(innerW / vw, innerH / vh);
  const dw = vw * k, dh = vh * k;
  const px = (innerW - dw) / 2 + mc.x * dw;
  const py = (innerH - dh) / 2 + mc.y * dh;

  cursorEl.classList.remove('hidden');
  cursorEl.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0)`;

  game.cursorCooldown = Math.max(0, game.cursorCooldown - dtMs);

  // hover test against cached buttons
  let target = null;
  for (const b of game.menuButtons) {
    if (b.classList.contains('hidden') || !b.offsetParent) continue;
    const r = b.getBoundingClientRect();
    if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) { target = b; break; }
  }

  if (target !== game.cursorHover) {
    if (game.cursorHover) game.cursorHover.classList.remove('hot');
    if (target) { target.classList.add('hot'); soundManager.hover(); }
    game.cursorHover = target;
    game.dwell = 0;
  }

  if (!target) { game.dwell = 0; return; }

  // pinch = instant activation on the rising edge; otherwise dwell confirm
  const risingPinch = mc.pinch && !game.prevPinch;
  game.prevPinch = mc.pinch;

  if (game.cursorCooldown <= 0) {
    game.dwell += dtMs;               // accumulate only when ready to act
    if (risingPinch || game.dwell >= DWELL_TIME_MS) {
      game.cursorCooldown = CURSOR_COOLDOWN_MS;
      game.dwell = 0;
      setDwellBar(target, 0);
      target.click();
    } else {
      setDwellBar(target, game.dwell / DWELL_TIME_MS);
    }
  }
}

/** gui dwell progress bar inside the slanted button */
function setDwellBar(btn, frac) {
  const bar = btn.querySelector('.dwell i');
  if (bar) bar.style.width = `${Math.min(100, frac * 100).toFixed(0)}%`;
}

/* ------------------------------------------------------------------ */
/* Core state update                                                  */
/* ------------------------------------------------------------------ */

function update(dt) {
  switch (game.state) {

    case 'start': {
      // menu fx run while the camera is available
      if (TrackingManager.isRunning()) {
        TrackingManager.update(dt);
        updateLightStatus(dt * 1000);
        drawPreview();
      }
      drawAttract(dt);
      updateMenuCursor(dt * 1000);
      break;
    }

    case 'calibration': {
      TrackingManager.update(dt);
      const solo = game.mode === 'solo';
      const p0 = TrackingManager.absentMs(0) === 0;
      const p1 = TrackingManager.absentMs(1) === 0;
      els.calibP1.dataset.state = p0 ? 'found' : 'missing';
      if (!solo) els.calibP2.dataset.state = p1 ? 'found' : 'missing';

      if (p0 && (solo || p1)) {
        game.handsReadyGrace += dt;
        if (game.handsReadyGrace >= 0.35) {
          game.readyTimer -= dt;
          els.calibPrompt.textContent = `${Math.ceil(Math.max(1, game.readyTimer))}`;
          if (game.readyTimer <= 0) {
            hide(els.calibScreen);
            show(els.hud);
            world.serve(Math.random() < 0.5 ? 0 : 1);
            renderer.resetTrail();
            game.state = 'playing';
          }
        } else {
          els.calibPrompt.textContent = '3';
        }
      } else {
        game.handsReadyGrace = 0;
        game.readyTimer = READY_TIME;
        els.calibPrompt.textContent = '3';
      }
      break;
    }

    case 'playing': {
      TrackingManager.update(dt);

      // auto-pause if too long without the required hand(s)
      if (requiredAbsenceMs() >= CONFIG.MISSING_HAND_TIMEOUT) {
        pauseGame('lost');
        break;
      }

      world.update(dt, paddleTargets());
      handleEvents(world.takeEvents());
      break;
    }

    case 'goal': {
      TrackingManager.update(dt);
      world.update(dt, paddleTargets());   // paddles keep moving, puck frozen

      // splash dies out just before the serve
      const showSplash = (game.goalTimer - dt) > 0.35;
      els.goalSplash.classList.toggle('hidden', !showSplash);

      game.goalTimer -= dt;
      if (game.goalTimer <= 0) {
        els.goalSplash.classList.add('hidden');
        if (game.scores[game.lastScorer] >= CONFIG.WIN_SCORE) {
          gameOver();
        } else {
          const receiving = game.lastScorer === 0 ? 1 : 0; // scored-on player
          world.serve(receiving);
          renderer.resetTrail();
          game.state = 'playing';
        }
      }
      break;
    }

    case 'paused':
      TrackingManager.update(dt);
      break;

    case 'gameover':
      break;
  }

  // ---- throttled UI + alarm pacing (runs every frame, cheap) --------
  game.uiTimer += dt * 1000;
  const domDue = game.uiTimer >= CONFIG.UI_UPDATE_MS;
  if (domDue) {
    game.uiTimer = 0;
    if (game.menuPage === 'main' && game.state === 'start') {
      updateMenuStatus();
      refreshMenuButtons();
    }
  }

  updateWarnings(domDue);
  updateHints(domDue);

  // continuous alarm while a hand is lost/off-screen or OOB:
  // game-side pacing (ALARM_PULSE_MS) layered on top of the audio
  // module's own burst throttle keeps the Web Audio graph lean
  game.alarmTimer -= dt * 1000;
  if (game.anyAlarm && game.alarmTimer <= 0) {
    soundManager.outOfBoundsAlarm();
    game.alarmTimer = CONFIG.ALARM_PULSE_MS;
  }
}

let lastT = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  let dt = (t - lastT) / 1000;
  lastT = t;
  if (dt > 0.05) dt = 0.05; // clamp so tab-switch can't explode physics

  update(dt);
  renderer.render(dt, world, TrackingManager.getMarkers(), game.warnings);

  // FPS counter (debug mode)
  if (settings.debug) {
    game.fpsFrames++; game.fpsTime += dt;
    if (game.fpsTime >= 0.5) {
      els.fpsDisplay.textContent = `FPS: ${Math.round(game.fpsFrames / game.fpsTime)}`;
      game.fpsFrames = 0; game.fpsTime = 0;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pause / flow                                                       */
/* ------------------------------------------------------------------ */

function pauseGame(reason /* 'user' | 'lost' */) {
  if (game.state === 'playing' || game.state === 'goal') {
    game.prevState = game.state;
    game.state = 'paused';
    els.goalSplash.classList.add('hidden');
    game.uiTimer = CONFIG.UI_UPDATE_MS; // force an immediate UI pass (hide hints/warnings)
    showHints(false, false);
    showScreen(els.pauseScreen);
    els.pauseScreen.dataset.reason = reason;
  }
}

function resumeGame() {
  if (game.state !== 'paused') return;
  hide(els.pauseScreen);
  game.state = game.prevState || 'playing';
  showHints(false, false);
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                       */
/* ------------------------------------------------------------------ */

function wireEvents() {
  // UI click feedback on every button
  document.querySelectorAll('button').forEach(b => b.addEventListener('click', clickSfx));

  // main menu launches
  els.menuPlay2p.addEventListener('click', () => launchGame('2p'));
  els.menuSolo.addEventListener('click', () => launchGame('solo'));
  els.menuHowTo.addEventListener('click', () => goToMenu('howto'));
  els.menuSettings.addEventListener('click', () => showScreen(els.settingsModal));
  els.menuBackBtn.addEventListener('click', () => soundManager.hover());

  // how-to back -> main menu
  els.howToBackBtn.addEventListener('click', () => goToMenu('main'));

  els.pauseBtn.addEventListener('click', () => {
    if (game.state === 'playing' || game.state === 'goal') pauseGame('user');
  });

  els.resumeBtn.addEventListener('click', resumeGame);
  els.quitBtn.addEventListener('click', () => { goToMenu('main'); });

  els.openSettingsBtn.addEventListener('click', () => showScreen(els.settingsModal));
  els.settingsCloseBtn.addEventListener('click', () => hide(els.settingsModal));

  els.playAgainBtn.addEventListener('click', () => {
    hide(els.gameOverScreen);
    enterCalibration();
  });

  els.backToMenuBtn.addEventListener('click', () => goToMenu('main'));

  // ---- settings inputs -------------------------------------------
  els.orientationSelect.addEventListener('change', () => {
    settings.orientation = els.orientationSelect.value;
    applySettings();               // resets puck to center (frozen)
    if (game.state === 'playing') {
      world.serve(Math.random() < 0.5 ? 0 : 1);  // keep play going
      renderer.resetTrail();
    }
  });

  els.smoothingRange.addEventListener('input', () => {
    settings.smoothing = +els.smoothingRange.value;
    els.smoothingValue.textContent = settings.smoothing.toFixed(2);
    applySettings();
  });

  els.puckSpeedSelect.addEventListener('change', () => {
    settings.puckSpeed = els.puckSpeedSelect.value;
    applySettings();
  });

  const toggle = (key, el) => el.addEventListener('change', () => {
    settings[key] = el.checked;
    applySettings();
  });
  toggle('camBg', els.cameraBgToggle);
  toggle('markers', els.markersToggle);
  toggle('debug', els.debugToggle);
  toggle('sound', els.soundToggle);

  // ---- misc --------------------------------------------------------
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game.state === 'playing' || game.state === 'goal') pauseGame('user');
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Escape') {
      if (game.state === 'playing' || game.state === 'goal') pauseGame('user');
      else if (game.state === 'start') goToMenu('main');  // howto/back shortcut
    }
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

function boot() {
  TrackingManager.init(DOM('cameraFeed'), (err) => {
    console.warn('[tracking]', err);
  });
  // unlock Web Audio on the very first user gesture (autoplay policy),
  // regardless of which button they press first
  document.addEventListener('pointerdown', () => soundManager.unlock(), { once: true });
  syncSettingsUI();
  applySettings();
  setScoreUI();
  refreshMenuButtons();
  wireEvents();
  showScreen(els.startScreen);       // animate the menu in on load
  requestAnimationFrame((t) => { lastT = t; requestAnimationFrame(loop); });
}

boot();
