/**
 * game.js
 * ==========================================================================
 * Main controller: state machine + rAF loop that wires together
 * TrackingManager (input), PhysicsWorld (simulation) and Renderer (output).
 *
 * Game states:
 *   start        -> start screen (camera permission happens on Start)
 *   calibration  -> wait until both hands are detected, then 1.2s "Get Ready"
 *   playing      -> normal play (world.update + events each frame)
 *   goal         -> short celebration, then serve toward the scored-on player
 *   paused       -> user pause OR auto-pause (both hands lost > 3s)
 *   gameover     -> win screen at CONFIG.WIN_SCORE
 * ==========================================================================
 */

/* ------------------------------------------------------------------ */
/* Tuning / helpers                                                   */
/* ------------------------------------------------------------------ */

const SPEED_MULT = { slow: 0.75, normal: 1.0, fast: 1.3 };
const READY_TIME = 1.2;          // s of "Get Ready" after both hands found

const DOM = (id) => document.getElementById(id);

const els = {
  hud: DOM('gameHud'),
  p1Score: DOM('p1Score'), p2Score: DOM('p2Score'),
  p1Panel: DOM('p1ScorePanel'), p2Panel: DOM('p2ScorePanel'),
  pauseBtn: DOM('pauseBtn'), fpsDisplay: DOM('fpsDisplay'),
  hintP1: DOM('handHintP1'), hintP2: DOM('handHintP2'),

  startScreen: DOM('startScreen'), startBtn: DOM('startBtn'), cameraNotice: DOM('cameraNotice'),

  calibScreen: DOM('calibrationScreen'),
  calibP1: DOM('calibP1'), calibP2: DOM('calibP2'), calibPrompt: DOM('calibPrompt'),

  pauseScreen: DOM('pauseScreen'), resumeBtn: DOM('resumeBtn'), openSettingsBtn: DOM('openSettingsBtn'),

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

const game = {
  state: 'start',
  prevState: 'playing',   // where pause() came from
  scores: [0, 0],
  goalTimer: 0,           // s remaining in 'goal' state
  lastScorer: -1,
  readyTimer: 0,          // s remaining of "Get Ready"
  bothPresentGrace: 0,    // requires hands stable during calibration
  fpsFrames: 0, fpsTime: 0,
};

/* ------------------------------------------------------------------ */
/* UI helpers                                                         */
/* ------------------------------------------------------------------ */

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

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
  try {
    await TrackingManager.start();
  } catch (err) {
    console.warn('[game] camera start failed:', err);
    els.cameraNotice.innerHTML =
      '&#9888; Camera error: ' + escapeHtml(err.message || String(err)) +
      '<br>Allow camera access (HTTPS or localhost required) and try again.';
    return false;
  }
  return true;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ------------------------------------------------------------------ */
/* Goal / win handling                                                */
/* ------------------------------------------------------------------ */

function handleGoal(ev) {
  soundManager.goal();
  game.scores[ev.scorer]++;
  game.lastScorer = ev.scorer;
  setScoreUI();

  const col = ev.scorer === 0 ? '#00e5ff' : '#ff2bd6';
  const gc = renderer.goalCenterOf(ev.scorer);
  renderer.spawnBurst(gc.x, gc.y, col, 60, 420);
  renderer.addFlash(gc.x, gc.y, col, 10, 260, 0.8);
  renderer.shakeScreen(9);

  world.frozen = true;
  game.state = 'goal';         // key timers treated in seconds
  game.goalTimer = CONFIG.SCORE_RESET_DELAY / 1000;
}

function gameOver() {
  game.state = 'gameover';
  const w = game.scores[0] >= CONFIG.WIN_SCORE ? 0 : 1;
  els.winnerMessage.textContent = `PLAYER ${w + 1} WINS!`;
  els.winnerMessage.style.color = w === 0 ? '#00e5ff' : '#ff2bd6';
  els.winnerMessage.style.textShadow = w === 0
    ? '0 0 8px #00e5ff, 0 0 24px rgba(0,229,255,.55)'
    : '0 0 8px #ff2bd6, 0 0 24px rgba(255,43,214,.55)';
  els.finalScoreLine.textContent = `${game.scores[0]} — ${game.scores[1]}`;
  show(els.gameOverScreen);
  soundManager.goal();

  // celebratory burst from the center
  const W = renderer.W, H = renderer.H;
  for (let i = 0; i < 3; i++) {
    renderer.spawnBurst(W / 2 + (i - 1) * 120, H / 2, w === 0 ? '#00e5ff' : '#ff2bd6', 40, 500);
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
  show(els.calibScreen);
  hide(els.gameOverScreen);
  els.calibPrompt.textContent = 'Waiting for hands…';
  game.state = 'calibration';
  game.bothPresentGrace = 0;
  game.readyTimer = READY_TIME;
}

/* ------------------------------------------------------------------ */
/* Main loop                                                          */
/* ------------------------------------------------------------------ */

function paddleTargets() {
  const ps = TrackingManager.getPlayers();
  return [{ x: ps[0].smooth.x, y: ps[0].smooth.y }, { x: ps[1].smooth.x, y: ps[1].smooth.y }];
}

function handleEvents(events) {
  for (const ev of events) {
    switch (ev.type) {
      case 'paddleHit': {
        soundManager.hit(ev.strength);
        const col = ev.player === 0 ? '#00e5ff' : '#ff2bd6';
        renderer.spawnBurst(ev.x, ev.y, col, Math.round(6 + 18 * ev.strength), 140 + 260 * ev.strength);
        renderer.addFlash(ev.x, ev.y, col, 6, 40, 0.35);
        if (ev.strength > 0.55) renderer.shakeScreen(3 + 4 * ev.strength);
        break;
      }
      case 'wallHit':
        soundManager.wall(ev.strength * 0.9);
        renderer.spawnBurst(ev.x, ev.y, 'rgba(154,220,255,1)', Math.round(3 + 10 * ev.strength), 110);
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

function updateHints() {
  if (game.state !== 'playing' && game.state !== 'goal') { showHints(false, false); return; }
  showHints(
    TrackingManager.absentMs(0) > CONFIG.HINT_SHOW_DELAY,
    TrackingManager.absentMs(1) > CONFIG.HINT_SHOW_DELAY,
  );
}

function update(dt) {
  switch (game.state) {

    case 'start':
      break;

    case 'calibration':
      TrackingManager.update(dt);
      {
        const p0 = TrackingManager.absentMs(0) === 0;
        const p1 = TrackingManager.absentMs(1) === 0;
        els.calibP1.dataset.state = p0 ? 'found' : 'missing';
        els.calibP2.dataset.state = p1 ? 'found' : 'missing';

        if (p0 && p1) {
          game.bothPresentGrace += dt;
          if (game.bothPresentGrace >= 0.35) {
            game.readyTimer -= dt;
            els.calibPrompt.textContent = `Get Ready! ${Math.ceil(Math.max(0, game.readyTimer))}`;
            if (game.readyTimer <= 0) {
              hide(els.calibScreen);
              show(els.hud);
              world.serve(Math.random() < 0.5 ? 0 : 1);
              renderer.resetTrail();
              game.state = 'playing';
              updateHints();
            }
          } else {
            els.calibPrompt.textContent = 'Both hands detected — get ready…';
          }
        } else {
          game.bothPresentGrace = 0;
          game.readyTimer = READY_TIME;
          els.calibPrompt.textContent = (p0 || p1)
            ? 'One more hand… Both players, show your hand to the camera.'
            : 'Waiting for hands…';
        }
      }
      break;

    case 'playing': {
      TrackingManager.update(dt);

      // auto-pause if both hands have been missing for too long
      if (TrackingManager.bothAbsentMs() >= CONFIG.MISSING_HAND_TIMEOUT) {
        pauseGame('lost');
        break;
      }

      world.update(dt, paddleTargets());
      handleEvents(world.takeEvents());
      updateHints();
      break;
    }

    case 'goal': {
      TrackingManager.update(dt);
      world.update(dt, paddleTargets());   // paddles keep moving, puck frozen
      updateHints();

      game.goalTimer -= dt;
      if (game.goalTimer <= 0) {
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
}

let lastT = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  let dt = (t - lastT) / 1000;
  lastT = t;
  if (dt > 0.05) dt = 0.05; // clamp so tab-switch can't explode physics

  update(dt);
  renderer.render(dt, world, TrackingManager.getMarkers());

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
    showHints(false, false);
    show(els.pauseScreen);
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

  els.startBtn.addEventListener('click', async () => {
    soundManager.unlock();           // must happen inside the gesture
    if (!(await startCamera())) return;
    hide(els.startScreen);
    els.cameraNotice.innerHTML =
      'This game uses your webcam for hand tracking.<br>' +
      'Your browser will ask for camera permission &mdash; nothing is uploaded, ' +
      'all processing happens locally.'; // reset any previous error message
    enterCalibration();
  });

  els.pauseBtn.addEventListener('click', () => {
    if (game.state === 'playing' || game.state === 'goal') pauseGame('user');
  });

  els.resumeBtn.addEventListener('click', resumeGame);

  els.openSettingsBtn.addEventListener('click', () => show(els.settingsModal));
  els.settingsCloseBtn.addEventListener('click', () => hide(els.settingsModal));

  els.playAgainBtn.addEventListener('click', () => {
    hide(els.gameOverScreen);
    enterCalibration();
  });

  els.backToMenuBtn.addEventListener('click', () => {
    hide(els.gameOverScreen);
    hide(els.hud);
    hide(els.calibScreen);
    show(els.startScreen);
    game.state = 'start';
  });

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
  wireEvents();
  requestAnimationFrame((t) => { lastT = t; requestAnimationFrame(loop); });
}

boot();
