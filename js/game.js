/**
 * game.js
 * ==========================================================================
 * HOCKEY-AR clean-slate rebuild — main controller + RENDERER.
 *
 * Highlights
 *  - Fixed time-step simulation (FIXED_DT) fully decoupled from render
 *    frames: 60 Hz, 120 Hz, anything else — identical physics.
 *  - Renderer folded in for the rebuild (single file, no build deps).
 *  - Camera bedrock: canvas context is created with
 *      { alpha: false, desynchronized: false, preserveDrawingBuffer: true }
 *    to guarantee double-buffered compositing (no GPU front-buffer tearing,
 *    no light flicker). The webcam background is LATCHED: a frame is drawn
 *    into an offscreen buffer ONLY when the <video> reports a genuinely new
 *    frame (currentTime moved) or when tracking delivered a fresh packet;
 *    the latched buffer is then blitted at CONFIG.CAMERA_OPACITY for
 *    high-visibility hand feedback. If no camera frame ever arrives, the
 *    canvas holds a stable dark table background — never a blank/white
 *    flash. clearRect-equivalent clear runs in the same uninterrupted
 *    block immediately followed by the background fill.
 *  - ZERO DOM manipulation inside the per-frame loop: HUD score text is
 *    written only when the score changes, hints/warnings/countdown/splash
 *    are drawn on canvas from cached strings every frame.
 *  - Orientation-generic: 'lr' and 'tb' share every code path — physics,
 *    rendering, warnings and the solo AI all derive geometry from the
 *    orientation flag.
 *
 * States: start -> calibration -> playing -> goal -> ... -> gameover, with
 * user/auto pause in between. Modes: '2p' and 'solo' (AI drives P2).
 * ==========================================================================
 */

/* ------------------------------------------------------------------ */
/* Tuning / helpers                                                   */
/* ------------------------------------------------------------------ */

const READY_TIME = 3.0;      // s of READY countdown after hand(s) found

/* Solo AI: bias toward its own attack axis ("a") with puck-velocity lead
   on the cross axis ("c"). Geometry flips with orientation: for 'lr' the
   attack axis is x (P2 owns the right half), for 'tb' it is y (P2 owns
   the top half). */
const AI = {
  homeDepth: 0.82,           // normalized depth into own half at rest
  nearHalf: 0.55,            // attack edge of own half
  reach: 0.40,               // attack span
  lead: 0.12,                // s of puck cross-axis velocity lead
  lerpPerS: 7.0,             // target smoothing (per second)
};

const DWELL_TIME_MS = 1000;      // hand-cursor hold to confirm
const CURSOR_COOLDOWN_MS = 800;  // pause after activation
const ALARM_PULSE_MS = 520;      // pacing of the lost-hand warning buzz
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const DOM = (id) => document.getElementById(id);
const clampv = (v, a, b) => v < a ? a : (v > b ? b : v);

const els = {
  canvas: DOM('gameCanvas'), video: DOM('cameraFeed'),
  hud: DOM('hud'), p1Score: DOM('p1Score'), p2Score: DOM('p2Score'),
  pauseBtn: DOM('pauseBtn'),

  startScreen: DOM('startScreen'),
  menuPlay2p: DOM('menuPlay2p'), menuSolo: DOM('menuSolo'),
  camPreview: DOM('camPreview'), menuCursor: DOM('menuCursor'),

  pauseScreen: DOM('pauseScreen'), resumeBtn: DOM('resumeBtn'),
  quitBtn: DOM('quitBtn'),

  gameOverScreen: DOM('gameOverScreen'), winnerMessage: DOM('winnerMessage'),
  finalScoreLine: DOM('finalScoreLine'),
  playAgainBtn: DOM('playAgainBtn'), backToMenuBtn: DOM('backToMenuBtn'),
};

/* ------------------------------------------------------------------ */
/* Renderer (folded into game.js for the rebuild)                     */
/* ------------------------------------------------------------------ */

/* cached text for canvas HUD — zero string building inside the loop */
const CD_TEXT = ['3', '2', '1'];
const HINT_TEXT = ['P1 — SHOW YOUR HAND', 'P2 — SHOW YOUR HAND'];

class Renderer {

  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;

    // double-buffered, tear-free compositor contract
    this.ctx = canvas.getContext('2d', {
      alpha: false,                 // opaque canvas -> no per-frame alpha blend
      desynchronized: false,        // disable the "desynchronized" pipeline:
                                    // guarantee stable double-buffering and
                                    // prevent GPU front-buffer screen tearing
      preserveDrawingBuffer: true,  // buffer never blanked between composites
    });

    this.orientation = settings.orientation;
    this.W = CONFIG.TABLE_W;
    this.H = CONFIG.TABLE_H;
    this.scale = 1;

    this.showCamBg = settings.camBg;
    this.showMarkers = settings.markers;

    // ---- latched webcam background ----------------------------------
    // A frame is copied to this offscreen buffer ONLY when the video
    // element reports a genuinely new frame and tracking consumed a
    // fresh packet. The main canvas blits the buffer — never the live
    // <video> — so a delayed camera frame can never blank the canvas.
    this.camBuf = document.createElement('canvas');
    this.camCtx = this.camBuf.getContext('2d', { alpha: false });
    this.camLatchT = -1;          // latched video.currentTime
    this.camHasFrame = false;

    // ---- zero-alloc render state ------------------------------------
    this.trailBuf = new Float32Array(CONFIG.PUCK_TRAIL_LENGTH * 2);
    this.trailHead = 0;
    this.trailCount = 0;

    this.particles = [];
    for (let i = 0; i < CONFIG.PARTICLE_POOL; i++) {
      this.particles.push({
        alive: false, x: 0, y: 0, vx: 0, vy: 0,
        life: 0, maxLife: 1, size: 2, color: THEME.P_COLORS[0],
      });
    }
    this.partCursor = 0;

    this.flashes = [];
    for (let i = 0; i < CONFIG.FLASH_POOL; i++) {
      this.flashes.push({ alive: false, x: 0, y: 0, color: '#fff', r0: 6, r1: 40, t: 0, dur: 0.4 });
    }

    this.goalFlash = { active: false, side: 0, color: '#fff', t: 0 };
    this.shake = 0;
    this.clock = 0;

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /* ---- sizing / orientation ----------------------------------------- */

  setOrientation(o) {
    this.orientation = o === 'tb' ? 'tb' : 'lr';
    this.W = this.orientation === 'tb' ? CONFIG.TABLE_H : CONFIG.TABLE_W;
    this.H = this.orientation === 'tb' ? CONFIG.TABLE_W : CONFIG.TABLE_H;
    this.trailCount = 0;
    this.camHasFrame = false;    // re-latch on the new layout
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.RENDER_MAX_DPR);
    const vw = window.innerWidth, vh = window.innerHeight;
    const ar = this.W / this.H;

    let cw = vw, ch = vw / ar;
    if (ch > vh) { ch = vh; cw = vh * ar; }

    this.canvas.style.width = cw + 'px';
    this.canvas.style.height = ch + 'px';
    this.canvas.width = Math.max(1, Math.round(cw * dpr));
    this.canvas.height = Math.max(1, Math.round(ch * dpr));
    this.scale = this.canvas.width / this.W;
  }

  /* ---- effects API (game state changes only — never per-frame) ------ */

  spawnBurst(x, y, color, count, speed = 260) {
    const pool = this.particles, n = pool.length;
    for (let i = 0; i < count; i++) {
      const p = pool[this.partCursor];
      this.partCursor = (this.partCursor + 1) % n;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      p.alive = true;
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * s; p.vy = Math.sin(a) * s;
      p.life = 0.45 + Math.random() * 0.45;
      p.maxLife = p.life;
      p.size = 2 + Math.random() * 3.5;
      p.color = color;
    }
  }

  addFlash(x, y, color, r0, r1, dur) {
    for (const f of this.flashes) {
      if (!f.alive) {
        f.alive = true; f.x = x; f.y = y; f.color = color;
        f.r0 = r0; f.r1 = r1; f.t = 0; f.dur = dur;
        return;
      }
    }
  }

  /** scoring-side border pulse in the scorer's color (single slot) */
  flashGoal(goalSide, color) {
    this.goalFlash.active = true;
    this.goalFlash.side = goalSide;
    this.goalFlash.color = color;
    this.goalFlash.t = 0;
  }

  shakeScreen(px) { this.shake = Math.min(14, this.shake + px); }
  resetTrail() { this.trailCount = 0; }

  static _hexA(hex, a) {
    const h = hex.replace('#', '');
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }

  /* ---- camera latch ------------------------------------------------- */

  /**
   * Copy the live video frame to the offscreen buffer when — and only
   * when — a genuinely new frame exists (video.currentTime moved) and a
   * fresh tracking packet has been processed since the last latch.
   */
  latchCamera(packetId) {
    const vid = this.video;
    if (!vid || vid.readyState < 2 || !vid.videoWidth) return;
    if (vid.currentTime === this.camLatchT) return;
    if (packetId === this.camLatchPacket) return;    // no fresh packet yet
    this.camLatchPacket = packetId;
    this.camLatchT = vid.currentTime;

    const bw = vid.videoWidth, bh = vid.videoHeight;
    if (this.camBuf.width !== bw || this.camBuf.height !== bh) {
      this.camBuf.width = bw;
      this.camBuf.height = bh;
    }
    this.camCtx.drawImage(vid, 0, 0, bw, bh);
    this.camHasFrame = true;
  }

  /* ---- render -------------------------------------------------------- */

  render(dt, world, markers, players, ui) {
    const ctx = this.ctx;
    const cw = this.canvas.width, chh = this.canvas.height;
    this.clock += dt;

    // decaying shake offset (canvas px)
    this.shake = this.shake > 0.05 ? this.shake * Math.exp(-7 * dt) : 0;
    const shx = (Math.random() - 0.5) * 2 * this.shake;
    const shy = (Math.random() - 0.5) * 2 * this.shake;

    /* ---- Synchronized clear + draw pipeline ---------------------------
       The clear and the background fill run back-to-back in this single
       uninterrupted block, so a composited frame can never be blank. */
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, chh);                       // opaque clear

    if (this.showCamBg) {
      this.latchCamera(ui.camPacketId);
      if (this.camHasFrame) {
        // latched blit — stable even when the camera stalls
        const bw = this.camBuf.width, bh = this.camBuf.height;
        const k = Math.max(cw / bw, chh / bh);         // cover-fit
        const dw = bw * k, dh = bh * k;
        const ox = (cw - dw) / 2, oy = (chh - dh) / 2;
        ctx.save();
        ctx.globalAlpha = CONFIG.CAMERA_OPACITY;       // high-visibility AR bed
        ctx.translate(cw, 0); ctx.scale(-1, 1);        // mirror
        ctx.drawImage(this.camBuf, ox, oy, dw, dh);
        ctx.restore();
      } else {
        // stable fallback (no stale blank/white flash)
        ctx.fillStyle = '#07101c';
        ctx.fillRect(0, 0, cw, chh);
      }
    }

    // ---- world transform ----------------------------------------------
    ctx.setTransform(this.scale, 0, 0, this.scale, shx * this.scale, shy * this.scale);
    const W = this.W, H = this.H;

    this._drawTable(ctx, W, H);
    this._drawGoalFlash(ctx, W, H, dt);
    this._drawWarnings(ctx, W, H, players, ui);
    this._drawTrail(world);
    this._drawTrailPath(ctx);
    this._drawPuck(ctx, world);
    this._drawPaddle(ctx, world.pad0, 0);
    this._drawPaddle(ctx, world.pad1, 1);
    if (this.showMarkers) this._drawMarkers(ctx, markers);
    if (ui.state === 'calibration') this._drawCalibration(ctx, W, H, ui);
    if (ui.splashActive) this._drawSplash(ctx, W, H, ui);
    if (settings.debug) this._drawFps(ctx);

    this._drawParticles(ctx, dt);
    this._drawFlashes(ctx, dt);
    this._drawHints(ctx, W, H, ui);
  }

  /* ---- table --------------------------------------------------------- */

  _roundedRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  _drawTable(ctx, W, H) {
    // surface: translucent so the 0.55 camera bed reads through
    ctx.fillStyle = 'rgba(4, 8, 14, 0.45)';
    this._roundedRectPath(ctx, 0, 0, W, H, CONFIG.CORNER_RADIUS);
    ctx.fill();

    // ---- 4-segment neon border with goal-mouth gaps --------------------
    const seg = THEME.BORDER_SEGMENTS;
    const cr = CONFIG.CORNER_RADIUS;
    const half = CONFIG.GOAL_WIDTH / 2;
    const lr = this.orientation === 'lr';
    const g0 = (lr ? this.H : this.W) / 2 - half;
    const g1 = (lr ? this.H : this.W) / 2 + half;
    const midX = W / 2, midY = H / 2;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let snum = 0; snum < 4; snum++) {
      ctx.beginPath();
      if (lr) {
        if (snum === 0) {          // TL: goal-edge -> top-mid
          ctx.moveTo(0, g0); ctx.lineTo(0, cr);
          ctx.arc(cr, cr, cr, Math.PI, 1.5 * Math.PI);
          ctx.lineTo(midX, 0);
        } else if (snum === 1) {   // TR: top-mid -> goal-edge
          ctx.moveTo(midX, 0); ctx.lineTo(W - cr, 0);
          ctx.arc(W - cr, cr, cr, 1.5 * Math.PI, 2 * Math.PI);
          ctx.lineTo(W, g0);
        } else if (snum === 2) {   // BL: goal-edge -> bottom-mid
          ctx.moveTo(0, g1); ctx.lineTo(0, H - cr);
          ctx.arc(cr, H - cr, cr, Math.PI, 0.5 * Math.PI, true);
          ctx.lineTo(midX, H);
        } else {                   // BR: bottom-mid -> goal-edge
          ctx.moveTo(midX, H); ctx.lineTo(W - cr, H);
          ctx.arc(W - cr, H - cr, cr, 0.5 * Math.PI, 0, true);
          ctx.lineTo(W, g1);
        }
      } else {
        if (snum === 0) {          // TL: left-mid -> goal-edge
          ctx.moveTo(0, midY); ctx.lineTo(0, cr);
          ctx.arc(cr, cr, cr, Math.PI, 1.5 * Math.PI);
          ctx.lineTo(g0, 0);
        } else if (snum === 1) {   // TR: goal-edge -> right-mid
          ctx.moveTo(g1, 0); ctx.lineTo(W - cr, 0);
          ctx.arc(W - cr, cr, cr, 1.5 * Math.PI, 2 * Math.PI);
          ctx.lineTo(W, midY);
        } else if (snum === 2) {   // BL: left-mid -> goal-edge
          ctx.moveTo(0, midY); ctx.lineTo(0, H - cr);
          ctx.arc(cr, H - cr, cr, Math.PI, 0.5 * Math.PI, true);
          ctx.lineTo(g0, H);
        } else {                   // BR: goal-edge -> right-mid
          ctx.moveTo(g1, H); ctx.lineTo(W - cr, H);
          ctx.arc(W - cr, H - cr, cr, 0.5 * Math.PI, 0, true);
          ctx.lineTo(W, midY);
        }
      }
      ctx.strokeStyle = seg[snum];
      ctx.shadowColor = seg[snum];
      ctx.shadowBlur = THEME.BLOOM_BLUR;
      ctx.lineWidth = THEME.BORDER_WIDTH;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // ---- goal lines + posts --------------------------------------------
    const tall = !lr;
    ctx.save();
    ctx.strokeStyle = 'rgba(244, 255, 249, 0.4)';
    ctx.lineWidth = 2;
    ctx.fillStyle = 'rgba(244, 255, 249, 0.85)';
    if (!tall) {
      const a = H / 2 - half, b = H / 2 + half;
      ctx.beginPath();
      ctx.moveTo(0, a); ctx.lineTo(0, b);
      ctx.moveTo(W, a); ctx.lineTo(W, b);
      ctx.stroke();
      const posts = [[0, a], [0, b], [W, a], [W, b]];
      for (const [px, py] of posts) {
        ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      const a = W / 2 - half, b = W / 2 + half;
      ctx.beginPath();
      ctx.moveTo(a, 0); ctx.lineTo(b, 0);
      ctx.moveTo(a, H); ctx.lineTo(b, H);
      ctx.stroke();
      const posts = [[a, 0], [b, 0], [a, H], [b, H]];
      for (const [px, py] of posts) {
        ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();

    // ---- center line + face-off circle ---------------------------------
    ctx.save();
    ctx.strokeStyle = `rgba(${THEME.CENTER_RGB}, 0.22)`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (lr) { ctx.moveTo(W / 2, 12); ctx.lineTo(W / 2, H - 12); }
    else    { ctx.moveTo(12, H / 2); ctx.lineTo(W - 12, H / 2); }
    ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 88, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 7, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${THEME.CENTER_RGB}, 0.6)`;
    ctx.fill();
    ctx.restore();
  }

  _drawGoalFlash(ctx, W, H, dt) {
    const f = this.goalFlash;
    if (!f.active) return;
    f.t += dt;
    const k = f.t / 0.9;
    if (k >= 1) { f.active = false; return; }

    const pulse = 0.5 + 0.5 * Math.sin(f.t * 18);
    const a = (1 - k) * (0.25 + 0.25 * pulse);
    const rgba = Renderer._hexA(f.color, a);
    const lr = this.orientation === 'lr';

    ctx.save();
    ctx.beginPath();
    if (lr) ctx.rect(f.side === 0 ? 0 : W / 2, 0, W / 2, H);
    else    ctx.rect(0, f.side === 0 ? H / 2 : 0, W, H / 2);
    ctx.fillStyle = rgba;
    ctx.fill();
    ctx.clip();
    this._roundedRectPath(ctx, 0, 0, W, H, CONFIG.CORNER_RADIUS);
    ctx.strokeStyle = rgba;
    ctx.lineWidth = 10;
    ctx.shadowColor = rgba;
    ctx.shadowBlur = 26;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Pure 2D bounds warnings: pulsing red edge overlay on the half whose
   * hand is lost / out of bounds (drawn — no DOM at all).
   */
  _drawWarnings(ctx, W, H, players, ui) {
    if (!ui.activePlay) return;
    const red = `rgba(${THEME.WARN_RED_RGB},`;
    const lr = this.orientation === 'lr';

    for (let side = 0; side < 2; side++) {
      const p = players[side];
      if (!p || !(p.isLost || p.isOutOfBounds)) continue;

      const pulse = 0.5 + 0.5 * Math.sin(this.clock * 9);
      const a = 0.22 + 0.22 * pulse;
      const depth = 150;

      let grad;
      if (lr) {
        const from = side === 0 ? [0, 0] : [W, 0];
        const to = side === 0 ? [depth, 0] : [W - depth, 0];
        grad = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
      } else {
        const from = side === 0 ? [0, H] : [0, 0];
        const to = side === 0 ? [0, H - depth] : [0, depth];
        grad = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
      }
      grad.addColorStop(0, red + a + ')');
      grad.addColorStop(1, red + 0 + ')');

      ctx.save();
      ctx.fillStyle = grad;
      if (lr) ctx.fillRect(side === 0 ? 0 : W - depth, 0, depth, H);
      else    ctx.fillRect(0, side === 0 ? H - depth : 0, W, depth);

      // glowing half-boundary stroke
      ctx.beginPath();
      if (lr) ctx.rect(side === 0 ? 0 : W / 2, 0, W / 2, H);
      else    ctx.rect(0, side === 0 ? H / 2 : 0, W, H / 2);
      ctx.clip();
      this._roundedRectPath(ctx, 0, 0, W, H, CONFIG.CORNER_RADIUS);
      ctx.strokeStyle = red + a + ')';
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ---- puck / trail / paddles ---------------------------------------- */

  _drawTrail(world) {
    const u = world.puck;
    if (world.frozen) {
      if (this.trailCount) this.trailCount--;
      return;
    }
    const cap = CONFIG.PUCK_TRAIL_LENGTH;
    this.trailHead = (this.trailHead + 1) % cap;
    const i2 = this.trailHead * 2;
    this.trailBuf[i2] = u[E_PUCK_X];
    this.trailBuf[i2 + 1] = u[E_PUCK_Y];
    if (this.trailCount < cap) this.trailCount++;
  }

  _drawTrailPath(ctx) {
    const n = this.trailCount;
    if (n < 2) return;
    const cap = CONFIG.PUCK_TRAIL_LENGTH;
    const groups = 3, seg = n / groups;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let g = 0; g < groups; g++) {
      const from = Math.floor(g * seg);
      const to = Math.min(n - 1, Math.floor((g + 1) * seg));
      if (to <= from) continue;
      ctx.beginPath();
      for (let k = from; k <= to; k++) {
        const idx = ((this.trailHead - k) % cap + cap) % cap;
        const x = this.trailBuf[idx * 2], y = this.trailBuf[idx * 2 + 1];
        if (k === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      const t = 1 - (from + seg * 0.5) / n;
      ctx.globalAlpha = 0.06 + 0.2 * t;
      ctx.strokeStyle = `rgba(${THEME.TRAIL_RGB}, 1)`;
      ctx.lineWidth = R_PUCK * (0.4 + 0.4 * t);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawPuck(ctx, world) {
    const u = world.puck;
    const x = u[E_PUCK_X], y = u[E_PUCK_Y], r = R_PUCK;
    if (x < -r * 2 || x > world.W + r * 2 || y < -r * 2 || y > world.H + r * 2) return;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10, 12, 16, 0.9)';
    ctx.shadowColor = THEME.PUCK;
    ctx.shadowBlur = 14;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = THEME.PUCK;
    ctx.stroke();
  }

  _drawPaddle(ctx, view, side) {
    const col = THEME.P_COLORS[side];
    ctx.beginPath();
    ctx.arc(view[0], view[1], R_PADDLE, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6, 10, 14, 0.88)';
    ctx.shadowColor = col;
    ctx.shadowBlur = 16;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 7;
    ctx.strokeStyle = col;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(view[0], view[1], R_PADDLE * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* ---- tracking markers over the camera bed --------------------------- */

  _drawMarkers(ctx, markers) {
    if (!markers || !markers.length || !this.camHasFrame) return;
    const cw = this.canvas.width, chh = this.canvas.height;
    const bw = this.camBuf.width, bh = this.camBuf.height;
    const k = Math.max(cw / bw, chh / bh);
    const dw = bw * k, dh = bh * k;
    const ox = (cw - dw) / 2, oy = (chh - dh) / 2;

    ctx.save();
    ctx.font = '900 30px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 10);

    for (const m of markers) {
      // m.x is mirrored video coords -> canvas px -> table coords
      const cxp = ox + m.x * dw;
      const cyp = oy + m.y * dh;
      const tx = cxp / this.scale;
      const ty = cyp / this.scale;
      const isOob = !!m.oob;
      const col = isOob ? '#ff3b44'
        : THEME.P_COLORS[this.orientation === 'lr' ? (m.x < 0.5 ? 0 : 1)
                                                   : (m.y > 0.5 ? 0 : 1)];
      const ringR = isOob ? 20 + 6 * pulse : 16;

      ctx.globalAlpha = isOob ? 1 : 0.85;
      ctx.strokeStyle = col;
      ctx.lineWidth = isOob ? 3.5 : 2.5;
      ctx.beginPath(); ctx.arc(tx, ty, ringR, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(tx, ty, 4, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();

      if (isOob) {
        ctx.fillStyle = col;
        ctx.fillText('!', tx, ty - ringR - 8);
        ctx.beginPath();
        ctx.arc(tx, ty, ringR + 14 * pulse, 0, Math.PI * 2);
        ctx.globalAlpha = (1 - pulse) * 0.6;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ---- runtime overlays (all canvas — zero DOM in the loop) ----------- */

  _drawCalibration(ctx, W, H, ui) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // prompt label (cached constant strings)
    ctx.font = '700 34px "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = 'rgba(244, 255, 249, 0.85)';
    ctx.fillText('SHOW YOUR HANDS', W / 2, H / 2 - 110);

    const halves = [
      this.orientation === 'lr' ? [0.25, 0.5] : [0.5, 0.75],
      this.orientation === 'lr' ? [0.75, 0.5] : [0.5, 0.25],
    ];
    for (let i = 0; i < 2; i++) {
      if (ui.calibSolo && i === 1) continue;
      const ok = i === 0 ? ui.calibP0 : ui.calibP1;
      const hx = halves[i][0] * W, hy = halves[i][1] * H;
      ctx.beginPath();
      ctx.arc(hx, hy, 34, 0, Math.PI * 2);
      ctx.lineWidth = 5;
      ctx.strokeStyle = ok ? THEME.P_COLORS[i] : 'rgba(150, 160, 170, 0.5)';
      ctx.stroke();
      ctx.font = '900 40px "Segoe UI", Arial, sans-serif';
      ctx.fillStyle = ok ? THEME.P_COLORS[i] : 'rgba(150, 160, 170, 0.6)';
      ctx.fillText(ok ? '✓' : '?', hx, hy);
    }

    // countdown digit (cached strings, index lookup — no alloc)
    const digit = CD_TEXT[Math.max(0, Math.min(2, Math.ceil(ui.readyTimer) - 1))];
    ctx.font = '900 130px Orbitron, "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = `rgba(${THEME.CENTER_RGB}, 0.9)`;
    ctx.fillText(digit, W / 2, H / 2 + 60);
    ctx.restore();
  }

  _drawSplash(ctx, W, H, ui) {
    const k = ui.splashT / ui.splashDur;
    const pop = 0.6 + 0.4 * Math.min(1, ui.splashT * 5);
    ctx.save();
    ctx.translate(W / 2, H / 2 - 40);
    ctx.scale(pop, pop);
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    ctx.font = '900 150px Orbitron, "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = ui.splashColor;
    ctx.shadowBlur = 40;
    ctx.fillStyle = ui.splashColor;
    ctx.fillText('GOAL!', 0, 0);
    ctx.restore();
  }

  _drawFps(ctx) {
    ctx.font = '700 15px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(160, 235, 255, 0.9)';
    ctx.fillText(ui.fpsText, 10, 8);
  }

  _drawHints(ctx, W, H, ui) {
    if (!ui.hints[0] && !ui.hints[1]) return;
    ctx.save();
    ctx.font = '900 30px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 2; i++) {
      if (!ui.hints[i]) continue;
      const bx = this.orientation === 'lr' ? W * (i === 0 ? 0.25 : 0.75) : W * 0.5;
      const by = this.orientation === 'lr' ? H * 0.5 : H * (i === 0 ? 0.75 : 0.25);
      const pulse = 0.65 + 0.35 * Math.sin(this.clock * 5);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = 'rgba(10, 14, 20, 0.85)';
      this._roundedRectPath(ctx, bx - 130, by - 34, 260, 68, 16);
      ctx.fill();
      ctx.strokeStyle = THEME.P_COLORS[i];
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = THEME.P_COLORS[i];
      ctx.fillText('SHOW YOUR HAND', bx, by);
    }
    ctx.restore();
  }

  /* ---- particles / flashes (pooled, zero alloc) ----------------------- */

  _drawParticles(ctx, dt) {
    const pool = this.particles;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      p.vy += 180 * dt;
      p.vx *= (1 - 2.2 * dt); p.vy *= (1 - 2.2 * dt);
      p.x += p.vx * dt; p.y += p.vy * dt;
      ctx.globalAlpha = p.life / p.maxLife;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  _drawFlashes(ctx, dt) {
    const pool = this.flashes;
    for (let i = 0; i < pool.length; i++) {
      const f = pool[i];
      if (!f.alive) continue;
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) { f.alive = false; continue; }
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r0 + (f.r1 - f.r0) * k, 0, Math.PI * 2);
      ctx.strokeStyle = f.color;
      ctx.globalAlpha = (1 - k) * 0.85;
      ctx.lineWidth = 6 * (1 - k) + 1;
      ctx.shadowColor = f.color;
      ctx.shadowBlur = 26;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Game object                                                        */
/* ------------------------------------------------------------------ */

const settings = {
  orientation: CONFIG.DEFAULT_ORIENTATION,
  smoothing: CONFIG.DEFAULT_SMOOTHING,
  puckSpeed: 'normal',
  camBg: CONFIG.DEFAULT_SHOW_CAM_BG,
  markers: CONFIG.DEFAULT_SHOW_MARKERS,
  sound: CONFIG.DEFAULT_SOUND,
  debug: false,
};

const world = new PhysicsWorld(settings.orientation);
const renderer = new Renderer(els.canvas, els.video);

const game = {
  state: 'start',
  mode: '2p',
  cameraRequested: false,
  cameraError: null,

  prevState: 'playing',
  scores: [0, 0],
  goalTimer: 0,
  lastScorer: -1,
  readyTimer: READY_TIME,
  handsGrace: 0,

  aiTarget: { x: 0.8, y: 0.5 },

  // menu hand-cursor controller
  cursorHover: null,
  dwell: 0,
  cursorCooldown: 0,
  prevPinch: false,
  menuButtons: [],
  buttonRects: new Map(),

  alarmTimer: 0,

  fpsFrames: 0, fpsTime: 0, fpsLabel: '--',
};

/* per-frame UI packets: reused, never reallocated */
const ui = {
  camPacketId: 0,
  state: 'start',
  mode: '2p',
  activePlay: false,
  calibSolo: false,
  calibP0: false, calibP1: false,
  readyTimer: READY_TIME,
  splashActive: false, splashT: 0, splashDur: 0.9,
  splashColor: THEME.P_COLORS[0],
  hints: [false, false],
  fpsText: 'FPS --',
};

/* preallocated AI/paddle target buffer (normalized) */
const targetsBuf = new Float32Array(4);

/* ------------------------------------------------------------------ */
/* UI helpers (DOM touched ONLY on state change)                       */
/* ------------------------------------------------------------------ */

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function setScoreUI() {
  // called only when the score actually changes
  els.p1Score.textContent = game.scores[0];
  els.p2Score.textContent = game.scores[1];
}

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
  world.setSpeedMult(CONFIG.SPEED_MULT[settings.puckSpeed] || 1);

  soundManager.setEnabled(settings.sound);
}

/* ------------------------------------------------------------------ */
/* Camera / flow                                                      */
/* ------------------------------------------------------------------ */

async function startCamera() {
  if (game.cameraRequested) return TrackingManager.isRunning();
  game.cameraRequested = true;
  try {
    await TrackingManager.start();
  } catch (err) {
    console.warn('[game] camera start failed:', err);
    game.cameraError = err && (err.message || String(err));
    return false;
  }
  return true;
}

function goToStart() {
  hide(els.hud); hide(els.gameOverScreen); hide(els.pauseScreen);
  game.state = 'start';
  showScreen(els.startScreen);
  cachedButtonsDirty = true;
  resetMenuCursor();
}

function showScreen(el) {
  el.classList.remove('hidden');
}

async function launchGame(mode) {
  soundManager.unlock();

  const cameraReady = await startCamera();
  if (!cameraReady && !TrackingManager.isRunning()) {
    // error surfaced by the console/status — stay in the menu
    return;
  }

  game.mode = mode;
  hide(els.startScreen);
  hide(els.gameOverScreen);
  hide(els.pauseScreen);
  enterCalibration();
}

function enterCalibration() {
  game.scores = [0, 0];
  setScoreUI();
  game.lastScorer = -1;
  renderer.resetTrail();
  world.placePuckCenter();
  ui.calibSolo = game.mode === 'solo';
  ui.calibP0 = ui.calibP1 = false;
  ui.readyTimer = READY_TIME;
  game.readyTimer = READY_TIME;
  game.handsGrace = 0;
  game.state = 'calibration';
  ui.state = 'calibration';
  showScreen(els.hud);
}

function startPlay() {
  hidePause();
  world.serve(Math.random() < 0.5 ? 0 : 1);
  renderer.resetTrail();
  game.state = 'playing';
  ui.state = 'playing';
}

/* ------------------------------------------------------------------ */
/* Goal / win                                                         */
/* ------------------------------------------------------------------ */

function handleGoal(ev) {
  soundManager.goal();
  game.scores[ev.scorer]++;
  setScoreUI();                       // DOM write: score changed — that's it
  game.lastScorer = ev.scorer;

  const col = THEME.P_COLORS[ev.scorer];
  const oppSide = ev.scorer === 0 ? 1 : 0;   // side that conceded
  const lr = renderer.orientation === 'lr';
  const gx = lr ? (oppSide === 0 ? 0 : world.W) : world.W / 2;
  const gy = lr ? world.H / 2 : (oppSide === 0 ? world.H : 0);
  renderer.spawnBurst(gx, gy, col, 60, 420);
  renderer.addFlash(gx, gy, col, 10, 260, 0.8);
  renderer.shakeScreen(9);
  renderer.flashGoal(oppSide, col);

  ui.splashActive = true;
  ui.splashT = 0;
  ui.splashColor = col;

  game.state = 'goal';                // world.frozen set inside physics
  ui.state = 'goal';
  game.goalTimer = CONFIG.SCORE_RESET_DELAY / 1000;
}

function gameOver() {
  game.state = 'gameover';
  ui.state = 'gameover';
  ui.splashActive = false;
  const w = game.scores[0] >= CONFIG.WIN_SCORE ? 0 : 1;
  els.winnerMessage.textContent = `PLAYER ${w + 1} WINS!`;
  els.finalScoreLine.textContent = `${game.scores[0]} — ${game.scores[1]}`;
  showScreen(els.gameOverScreen);
  soundManager.goal();
  for (let i = 0; i < 3; i++) {
    renderer.spawnBurst(world.W / 2 + (i - 1) * 120, world.H / 2, THEME.P_COLORS[w], 40, 500);
  }
}

/* ------------------------------------------------------------------ */
/* Solo AI — orientation-generic targeting                            */
/* ------------------------------------------------------------------ */

/**
 * Steer the AI toward the puck along its attack axis with a small
 * lead, or hold its home spot when the puck is on the human's half.
 * `dt` — fixed step. Writes the P2 slot of targetsBuf.
 */
function updateAITarget(dt) {
  const u = world.puck;
  const W = world.W, H = world.H;
  const horiz = world.orientation === 'lr';
  const px = u[E_PUCK_X] / W;
  const py = u[E_PUCK_Y] / H;

  let tx, ty;
  if (horiz) {
    // P2 owns the right half; attack axis = x
    if (px < 0.5) { tx = AI.homeDepth; ty = 0.5; }
    else {
      tx = clampv(AI.nearHalf + px * AI.reach, AI.nearHalf, AI.homeDepth + 0.13);
      ty = clampv(py + (u[E_PUCK_VY] / H) * AI.lead, 0.06, 0.94);
    }
  } else {
    // P2 owns the top half; attack axis = y (depth measured from top)
    if (py > 0.5) { tx = 0.5; ty = 1 - AI.homeDepth; }
    else {
      ty = clampv((1 - AI.nearHalf) - (1 - py) * AI.reach, 1 - AI.homeDepth - 0.13, 1 - AI.nearHalf);
      tx = clampv(px + (u[E_PUCK_VX] / W) * AI.lead, 0.06, 0.94);
    }
  }

  const ease = Math.min(1, dt * AI.lerpPerS);
  game.aiTarget.x += (tx - game.aiTarget.x) * ease;
  game.aiTarget.y += (ty - game.aiTarget.y) * ease;

  targetsBuf[2] = game.aiTarget.x;
  targetsBuf[3] = game.aiTarget.y;
}

/* ------------------------------------------------------------------ */
/* Per-step update (fixed dt — physics cadence, not render cadence)    */
/* ------------------------------------------------------------------ */

function requiredAbsenceMs() {
  return game.mode === 'solo'
    ? TrackingManager.absentMs(0)
    : TrackingManager.bothAbsentMs();
}

function buildPaddleTargets(dt) {
  const ps = TrackingManager.getPlayers();
  targetsBuf[0] = ps[0].smooth.x;
  targetsBuf[1] = ps[0].smooth.y;
  if (game.mode === 'solo') {
    updateAITarget(dt);
  } else {
    targetsBuf[2] = ps[1].smooth.x;
    targetsBuf[3] = ps[1].smooth.y;
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'paddleHit': {
      soundManager.hit(ev.strength);
      const col = THEME.P_COLORS[ev.player];
      renderer.spawnBurst(ev.x, ev.y, col, Math.round(6 + 18 * ev.strength), 140 + 260 * ev.strength);
      renderer.addFlash(ev.x, ev.y, col, 6, 40, 0.35);
      if (ev.strength > 0.55) renderer.shakeScreen(3 + 4 * ev.strength);
      break;
    }
    case 'wallHit': {
      const s2 = ev.strength * ev.strength;
      if (s2 > 0.004) {
        soundManager.wall(ev.strength * 0.9);
        renderer.spawnBurst(ev.x, ev.y, `rgba(${THEME.TRAIL_RGB},1)`, Math.round(3 + 10 * ev.strength), 110);
      }
      break;
    }
    case 'goal':
      handleGoal(ev);
      break;
    case 'nudge':
      soundManager.wall(0.25);
      break;
  }
}

function update(dt) {
  switch (game.state) {

    case 'start': {
      if (TrackingManager.isRunning()) TrackingManager.update();
      ui.camPacketId = TrackingManager.getPacketId();
      drawPreview();
      updateMenuCursor(dt * 1000);
      break;
    }

    case 'calibration': {
      TrackingManager.update();
      ui.camPacketId = TrackingManager.getPacketId();

      const p0 = TrackingManager.absentMs(0) === 0;
      const p1 = TrackingManager.absentMs(1) === 0;
      ui.calibP0 = p0;
      ui.calibP1 = p1;

      if (p0 && (game.mode === 'solo' || p1)) {
        game.handsGrace += dt;
        if (game.handsGrace >= 0.35) {
          game.readyTimer -= dt;
          if (game.readyTimer <= 0) {
            enterPlayFromCalibration();
          }
        }
      } else {
        game.handsGrace = 0;
        game.readyTimer = READY_TIME;
      }
      ui.readyTimer = game.readyTimer;
      break;
    }

    case 'playing':
    case 'goal': {
      TrackingManager.update();
      ui.camPacketId = TrackingManager.getPacketId();

      if (requiredAbsenceMs() >= CONFIG.MISSING_HAND_TIMEOUT) {
        pauseGame('lost');
        break;
      }

      buildPaddleTargets(dt);
      world.update(dt, targetsBuf);
      world.drainEvents(handleEvent);

      // goal splasher timing
      if (game.state === 'goal') {
        ui.splashT += dt;
        game.goalTimer -= dt;
        if (game.goalTimer <= 0.35) ui.splashActive = false;
        if (game.goalTimer <= 0) {
          if (game.scores[game.lastScorer] >= CONFIG.WIN_SCORE) {
            gameOver();
          } else {
            world.serve(game.lastScorer === 0 ? 1 : 0); // toward conceder
            renderer.resetTrail();
            game.state = 'playing';
            ui.state = 'playing';
          }
        }
      }
      break;
    }

    case 'paused':
      TrackingManager.update();
      break;

    case 'gameover':
      break;
  }

  // ---- shared per-step UI state (canvas-only, cheap) ------------------
  ui.state = game.state;
  ui.activePlay = game.state === 'playing' || game.state === 'goal';
  ui.hints[0] = ui.activePlay && TrackingManager.absentMs(0) > CONFIG.HINT_SHOW_DELAY;
  ui.hints[1] = ui.activePlay && game.mode === '2p' &&
                TrackingManager.absentMs(1) > CONFIG.HINT_SHOW_DELAY;

  // alarm pacing while a warning is active (audio only — no DOM)
  const anyWarn = ui.activePlay && (
    TrackingManager.getPlayers()[0].isLost ||
    TrackingManager.getPlayers()[1].isLost ||
    TrackingManager.getPlayers()[0].isOutOfBounds ||
    TrackingManager.getPlayers()[1].isOutOfBounds);
  game.alarmTimer -= dt * 1000;
  if (anyWarn && game.alarmTimer <= 0) {
    soundManager.alarmBuzz();
    game.alarmTimer = ALARM_PULSE_MS;
  }
}

/* calibration countdown finished -> drop into play */
function enterPlayFromCalibration() {
  hidePause();
  show(els.hud);
  world.serve(Math.random() < 0.5 ? 0 : 1);
  renderer.resetTrail();
  game.state = 'playing';
  ui.state = 'playing';
}

function hidePause() { hide(els.pauseScreen); }

/* ------------------------------------------------------------------ */
/* Menu camera preview (canvas-only, start state)                     */
/* ------------------------------------------------------------------ */

/** previewCtx shared across frames; sized only when needed */
const previewCtx = els.camPreview.getContext('2d');

function drawPreview() {
  const c = els.camPreview;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h || !renderer.camHasFrame) return;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }

  const ctx = previewCtx;
  const bw = renderer.camBuf.width, bh = renderer.camBuf.height;
  const k = Math.max(w / bw, h / bh);
  const dw = bw * k, dh = bh * k;
  const ox = (w - dw) / 2, oy = (h - dh) / 2;

  ctx.save();
  ctx.translate(w, 0); ctx.scale(-1, 1);
  ctx.globalAlpha = CONFIG.CAMERA_OPACITY;
  ctx.drawImage(renderer.camBuf, ox, oy, dw, dh);
  ctx.restore();
  ctx.fillStyle = 'rgba(0, 229, 255, 0.05)';
  ctx.fillRect(0, 0, w, h);

  // skeleton overlay (mirrored coords)
  const { pairs, count } = TrackingManager.getRawHands();
  for (let i = 0; i < count; i++) {
    const pts = pairs[i];
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.8)';
    ctx.lineWidth = 2;
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(ox + pts[a * 2] * dw, oy + pts[a * 2 + 1] * dh);
      ctx.lineTo(ox + pts[b * 2] * dw, oy + pts[b * 2 + 1] * dh);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(244, 255, 249, 0.9)';
    for (let j = 0; j < 21; j++) {
      ctx.beginPath();
      ctx.arc(ox + pts[j * 2] * dw, oy + pts[j * 2 + 1] * dh, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Hand-driven menu cursor (dom writes guarded by change detection)    */
/* ------------------------------------------------------------------ */

let cachedButtonsDirty = true;

function refreshMenuButtons() {
  game.menuButtons = [els.menuPlay2p, els.menuSolo];
  cachedButtonsDirty = false;
}

/** cache button rects — avoids per-frame layout reads (no reflow churn) */
function cacheButtonRects() {
  game.buttonRects.clear();
  for (const b of game.menuButtons) {
    game.buttonRects.set(b, b.getBoundingClientRect());
  }
}

function updateMenuCursor(dtMs) {
  const cursorEl = els.menuCursor;
  const menuVisible = game.state === 'start';
  if (!menuVisible) {
    if (!cursorEl.classList.contains('hidden')) cursorEl.classList.add('hidden');
    return;
  }

  if (cachedButtonsDirty) {
    refreshMenuButtons();
    cacheButtonRects();
  }

  const mc = TrackingManager.getMenuCursor ? TrackingManager.getMenuCursor() : null;
  if (!mc || !mc.seen) {
    if (game.cursorHover) {
      game.cursorHover.classList.remove('hot');    // state change only
      game.cursorHover = null;
    }
    game.dwell = 0;
    if (!cursorEl.classList.contains('hidden')) cursorEl.classList.add('hidden');
    return;
  }

  const vw = renderer.camHasFrame ? renderer.camBuf.width : 0;
  const vh = renderer.camHasFrame ? renderer.camBuf.height : 0;
  if (!vw || !vh) return;

  const innerW = window.innerWidth, innerH = window.innerHeight;
  const k = Math.max(innerW / vw, innerH / vh);
  const dw = vw * k, dh = vh * k;
  const px = (innerW - dw) / 2 + mc.x * dw;
  const py = (innerH - dh) / 2 + mc.y * dh;

  // DOM writes only when the cursor actually moved / visibility changed
  const lastX = game.lastCursorX || -9999, lastY = game.lastCursorY || -9999;
  if (Math.abs(px - lastX) + Math.abs(py - lastY) > 0.4) {
    game.lastCursorX = px; game.lastCursorY = py;
    cursorEl.style.transform =
      `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0)`;
  }
  if (cursorEl.classList.contains('hidden')) cursorEl.classList.remove('hidden');

  game.cursorCooldown = Math.max(0, game.cursorCooldown - dtMs);

  // hover test against cached rects (no layout reads per frame)
  let target = null;
  for (const b of game.menuButtons) {
    const r = game.buttonRects.get(b);
    if (!r) continue;
    if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
      target = b; break;
    }
  }

  if (target !== game.cursorHover) {
    if (game.cursorHover) game.cursorHover.classList.remove('hot');
    if (target) { target.classList.add('hot'); soundManager.hover?.(); }
    game.cursorHover = target;
    game.dwell = 0;
  }

  if (!target) { game.dwell = 0; return; }

  const risingPinch = mc.pinch && !game.prevPinch;
  game.prevPinch = mc.pinch;

  if (game.cursorCooldown <= 0) {
    game.dwell += dtMs;
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

/** dwell progress bar — DOM write guarded to whole-percent changes */
function setDwellBar(btn, frac) {
  const bar = btn.querySelector('.dwell i');
  if (!bar) return;
  const pct = Math.min(100, frac * 100) | 0;
  if (bar._pct !== pct) {
    bar._pct = pct;
    bar.style.width = pct + '%';
  }
}

function resetMenuCursor() {
  if (game.cursorHover) {
    game.cursorHover.classList.remove('hot');
    game.cursorHover = null;
  }
  game.dwell = 0;
  game.cursorCooldown = 0;
  game.prevPinch = false;
  game.lastCursorX = -9999;
  game.lastCursorY = -9999;
  cachedButtonsDirty = true;
}

/* ------------------------------------------------------------------ */
/* Pause / flow (all DOM writes here happen on state transitions)      */
/* ------------------------------------------------------------------ */

function pauseGame(reason) {
  if (game.state !== 'playing' && game.state !== 'goal') return;
  game.prevState = game.state;
  game.state = 'paused';
  ui.state = 'paused';
  ui.splashActive = false;
  ui.hints[0] = ui.hints[1] = false;
  els.pauseScreen.dataset.reason = reason;
  showScreen(els.pauseScreen);
}

function resumeGame() {
  if (game.state !== 'paused') return;
  hidePause();
  game.state = game.prevState || 'playing';
  ui.state = game.state;
}

/* ------------------------------------------------------------------ */
/* Main loop — fixed timestep decoupled from render                    */
/* ------------------------------------------------------------------ */

let lastT = 0;
let acc = 0;

function frame(t) {
  requestAnimationFrame(frame);

  if (!lastT) lastT = t;
  let dt = (t - lastT) / 1000;
  lastT = t;
  if (dt > 0.1) dt = 0.1;              // tab-switch clamp

  // simulation: consume fixed steps; render cadence is irrelevant
  acc += dt;
  let steps = 0;
  while (acc >= CONFIG.FIXED_DT && steps < CONFIG.MAX_FRAME_STEPS) {
    update(CONFIG.FIXED_DT);
    acc -= CONFIG.FIXED_DT;
    steps++;
  }
  if (acc > CONFIG.FIXED_DT) acc = 0;  // drop backlog, never spiral

  // render: once per animation frame
  renderer.render(dt, world, TrackingManager.getMarkers(),
                  TrackingManager.getPlayers(), ui);

  // debug FPS label (cached string, rewritten only at 0.5s cadence)
  if (settings.debug) {
    game.fpsFrames++; game.fpsTime += dt;
    if (game.fpsTime >= 0.5) {
      ui.fpsText = `FPS ${Math.round(game.fpsFrames / game.fpsTime)}`;
      game.fpsFrames = 0; game.fpsTime = 0;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Event wiring (outside the loop entirely)                            */
/* ------------------------------------------------------------------ */

function wireEvents() {
  document.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => soundManager.click()));

  els.menuPlay2p.addEventListener('click', () => launchGame('2p'));
  els.menuSolo.addEventListener('click', () => launchGame('solo'));

  els.pauseBtn.addEventListener('click', () => pauseGame('user'));
  els.resumeBtn.addEventListener('click', resumeGame);
  els.quitBtn.addEventListener('click', () => { goToStart(); resetForMenu(); });
  els.playAgainBtn.addEventListener('click', () => {
    hide(els.gameOverScreen);
    enterCalibration();
  });
  els.backToMenuBtn.addEventListener('click', () => { goToStart(); resetForMenu(); });

  // keyboard shortcuts
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Escape') {
      if (game.state === 'playing' || game.state === 'goal') pauseGame('user');
      else if (game.state === 'paused') resumeGame();
    } else if (e.key === 'F3') {
      e.preventDefault();
      settings.debug = !settings.debug;
    }
  });

  // auto-pause in the background
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game.state === 'playing' || game.state === 'goal') pauseGame('user');
    }
  });

  // unlock audio on the first gesture anywhere
  document.addEventListener('pointerdown', () => soundManager.unlock(), { once: true });

  // cached menu rects go stale on resize / orientation change
  window.addEventListener('resize', () => { cachedButtonsDirty = true; });
}

function resetForMenu() {
  game.cameraRequested = false;
  game.state = 'start';
  ui.state = 'start';
  game.scores = [0, 0];
  setScoreUI();
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

function boot() {
  TrackingManager.init(els.video, (err) => console.warn('[tracking]', err));
  applySettings();
  wireEvents();
  goToStart();
  requestAnimationFrame((t) => { lastT = t; requestAnimationFrame(frame); });
}

boot();
