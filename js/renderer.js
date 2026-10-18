/**
 * renderer.js
 * ==========================================================================
 * Canvas renderer: mirrored webcam background (AR look), HOCKEY-AR neon
 * table, paddles, puck with motion trail, tracking markers, particle
 * bursts, goal flashes and a small screen shake for hard hits.
 *
 * Visual identity (THEME, js/config.js):
 *   - thin neon borders in 4 quadrant colors (yellow/green/red/blue)
 *     with gaps at the goal mouths
 *   - paddles: green (P1) / red (P2), thick outer ring + filled core
 *   - puck: white with faint trail
 *   - slim bloom on strokes instead of heavy glow
 *
 * Works in "table pixel" space (CONFIG.TABLE_W/H) and scales by
 * canvas.width / world.W, so both orientations share the physics world:
 *   'lr' -> table 1280x720, goals on left/right walls
 *   'tb' -> table 720x1280, goals on top/bottom walls
 * ==========================================================================
 */

class Renderer {

  constructor(canvas, video) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.video = video;

    this.orientation = 'lr';
    this.W = CONFIG.TABLE_W;
    this.H = CONFIG.TABLE_H;
    this.scale = 1;

    this.showCamBg = CONFIG.DEFAULT_SHOW_CAM_BG;
    this.showMarkers = CONFIG.DEFAULT_SHOW_MARKERS;

    // puck trail as a preallocated ring buffer — zero per-frame allocations
    this.trailBuf = new Float32Array(CONFIG.PUCK_TRAIL_LENGTH * 2);
    this.trailHead = 0;
    this.trailCount = 0;

    this.particles = [];
    this.flashes = [];      // expanding rings (hard hits + goals)
    this.goalFlashes = [];  // {side, t} — scoring-side border pulse
    this.shake = 0;         // px, decays exponentially
    this.clock = 0;         // accumulates for pulsing warning animations

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /* ------------------------------------------------------------------ */
  /* Sizing / orientation                                               */
  /* ------------------------------------------------------------------ */

  setOrientation(o) {
    this.orientation = o === 'tb' ? 'tb' : 'lr';
    this.W = this.orientation === 'tb' ? CONFIG.TABLE_H : CONFIG.TABLE_W;
    this.H = this.orientation === 'tb' ? CONFIG.TABLE_W : CONFIG.TABLE_H;
    this.trailCount = 0;
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

  /* ------------------------------------------------------------------ */
  /* Effects API (called by game.js)                                    */
  /* ------------------------------------------------------------------ */

  spawnBurst(x, y, color, count, speed = 260) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.particles.push({
        x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0.45 + Math.random() * 0.45,
        maxLife: 0.9,
        size: 2 + Math.random() * 3.5,
        color,
      });
    }
    if (this.particles.length > 320) {
      this.particles.splice(0, this.particles.length - 320);
    }
  }

  addFlash(x, y, color, r0, r1, dur) {
    this.flashes.push({ x, y, color, r0, r1, t: 0, dur });
  }

  /**
   * Scoring-side border flash: the half that conceded lights up in the
   * scorer's color for ~0.9 s.
   * @param {number} goalSide 0 = P1's goal wall, 1 = P2's goal wall
   * @param {string} color    hex color of the scorer
   */
  flashGoal(goalSide, color) {
    this.goalFlashes.push({ side: goalSide, color, t: 0 });
    if (this.goalFlashes.length > 4) this.goalFlashes.shift();
  }

  shakeScreen(px) { this.shake = Math.min(14, this.shake + px); }

  resetTrail() { this.trailCount = 0; }

  /* Center of the goal mouth the puck entered (player scores INTO the
     opponent's goal), given the scorer's index. */
  goalCenterOf(scorer) {
    const oppGoalSide = scorer === 0 ? 1 : 0; // 0 = P1's goal, 1 = P2's goal
    if (this.orientation === 'lr') {
      return oppGoalSide === 0
        ? { x: 0, y: this.H / 2 }
        : { x: this.W, y: this.H / 2 };
    }
    return oppGoalSide === 0
      ? { x: this.W / 2, y: this.H }
      : { x: this.W / 2, y: 0 };
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                             */
  /* ------------------------------------------------------------------ */

  render(dt, world, markers, warnings) {
    const ctx = this.ctx;
    const cw = this.canvas.width, chh = this.canvas.height;
    this.clock += dt;

    // decaying shake offset (canvas px)
    this.shake = this.shake > 0.05 ? this.shake * Math.exp(-7 * dt) : 0;
    const shx = (Math.random() - 0.5) * 2 * this.shake;
    const shy = (Math.random() - 0.5) * 2 * this.shake;

    // ---- background ---------------------------------------------------
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, chh);

    if (this.showCamBg && this.video && this.video.videoWidth > 0) {
      const vw = this.video.videoWidth, vh = this.video.videoHeight;
      const k = Math.max(cw / vw, chh / vh);          // cover-fit
      const dw = vw * k, dh = vh * k;
      const ox = (cw - dw) / 2, oy = (chh - dh) / 2;
      ctx.save();
      ctx.globalAlpha = CONFIG.CAM_BG_OPACITY;        // faint AR feed
      ctx.translate(cw, 0); ctx.scale(-1, 1);         // horizontal mirror
      ctx.drawImage(this.video, ox, oy, dw, dh);
      ctx.restore();
    }

    // ---- world transform ----------------------------------------------
    ctx.setTransform(this.scale, 0, 0, this.scale, shx * this.scale, shy * this.scale);
    const W = this.W, H = this.H;

    this._drawTable(ctx, W, H);
    this._updateTrail(world);
    this._drawTrail(ctx);
    this._drawPuckIfVisible(ctx, world.puck, W, H);
    for (const p of world.paddles) this._drawPaddle(ctx, p);
    this._drawBoundaryWarnings(ctx, W, H, warnings);
    if (this.showMarkers) this._drawMarkers(ctx, markers);
    this._drawGoalFlashes(ctx, W, H, dt);

    this._updateAndDrawParticles(ctx, dt);
    this._drawFlashes(ctx, dt);
  }

  /* ------------------------------------------------------------------ */
  /* Out-of-bounds / depth warning visuals                              */
  /* ------------------------------------------------------------------ */

  /**
   * Glowing red (out of bounds / lost) or orange (bad depth) alert overlays
   * on the offending player's half: pulsing edge gradient + half-boundary
   * flash + explicit text badge for LOST hands.
   * @param {object|null} warnings {p1:{oob,depth,lost}, p2:{...}}
   */
  _drawBoundaryWarnings(ctx, W, H, warnings) {
    const warn = warnings || { p1: null, p2: null };
    const red = `rgba(${THEME.WARN_RED_RGB},`;
    const amber = `rgba(${THEME.WARN_AMBER_RGB},`;

    const drawSide = (side, w) => {
      if (!w || !(w.oob || w.depth || w.lost)) return;
      const rgba = (w.oob || w.lost) ? red : amber;
      const pulse = 0.5 + 0.5 * Math.sin(this.clock * 9);
      const a = 0.26 + 0.26 * pulse;

      // edge glow gradient reaching inward from that player's goal end
      const depth = 150;
      let grad;
      if (this.orientation === 'lr') {
        const from = side === 0 ? [0, 0] : [W, 0];
        const to = side === 0 ? [depth, 0] : [W - depth, 0];
        grad = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
      } else {
        const from = side === 0 ? [0, H] : [0, 0];   // P1 = bottom edge in tb
        const to = side === 0 ? [0, H - depth] : [0, depth];
        grad = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
      }
      grad.addColorStop(0, rgba(a + ')'));
      grad.addColorStop(1, rgba(0 + ')'));

      ctx.save();
      ctx.fillStyle = grad;
      if (this.orientation === 'lr') {
        ctx.fillRect(side === 0 ? 0 : W - depth, 0, depth, H);
      } else {
        ctx.fillRect(0, side === 0 ? H - depth : 0, W, depth);
      }

      // glowing half-boundary flash: clip to this player's half, redraw
      // the full table contour in warning color
      ctx.beginPath();
      if (this.orientation === 'lr') {
        ctx.rect(side === 0 ? 0 : W / 2, 0, W / 2, H);
      } else {
        ctx.rect(0, side === 0 ? H / 2 : 0, W, H / 2);
      }
      ctx.clip();
      this._roundedRectPath(ctx, 0, 0, W, H, CONFIG.CORNER_RADIUS);
      ctx.strokeStyle = rgba(a + ')');
      ctx.lineWidth = 10;
      ctx.shadowColor = rgba(a + ')');
      ctx.shadowBlur = 30;
      ctx.stroke();
      ctx.restore();

      // explicit badge for LOST hands ("no marker to carry the warning")
      if (w.lost) {
        const bx = this.orientation === 'lr' ? W * (side === 0 ? 0.25 : 0.75) : W * 0.5;
        const by = this.orientation === 'lr' ? H * 0.5 : H * (side === 0 ? 0.72 : 0.28);
        const label = 'HAND LOST / OUT OF SCREEN';
        ctx.save();
        ctx.globalAlpha = 0.75 + 0.25 * pulse;
        ctx.font = '900 30px "Segoe UI", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width;

        // pill background
        const pw = tw + 56, ph = 64;
        this._roundedRectPath(ctx, bx - pw / 2, by - ph / 2, pw, ph, 18);
        ctx.globalAlpha *= 0.85;
        ctx.fillStyle = 'rgba(38, 6, 10, 0.88)';
        ctx.fill();
        ctx.strokeStyle = rgba(0.9 + ')');
        ctx.lineWidth = 3;
        ctx.shadowColor = rgba(0.6 + ')');
        ctx.shadowBlur = 20;
        ctx.stroke();

        ctx.fillStyle = 'rgba(255, 136, 144, 1)';
        ctx.fillText(label, bx, by);
        ctx.restore();
      }
    };

    drawSide(0, warn.p1);
    drawSide(1, warn.p2);
  }

  /* ------------------------------------------------------------------ */
  /* Table                                                              */
  /* ------------------------------------------------------------------ */

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

  /** interpolated warning-gradient builder for flashGoal/hex convenience */
  static _hexA(hex, a) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  _drawTable(ctx, W, H) {
    const tall = this.orientation === 'tb';

    // surface: mostly see-through black so the camera feed stays readable
    ctx.fillStyle = 'rgba(2, 4, 8, 0.68)';
    this._roundedRectPath(ctx, 0, 0, W, H, CONFIG.CORNER_RADIUS);
    ctx.fill();

    // ---- 4-segment neon border with goal-mouth gaps --------------------
    this._drawBorder(ctx, W, H);

    // ---- goal mouths: thin white goal line + posts ---------------------
    this._drawGoals(ctx, W, H);

    // ---- center line + face-off circle (dim, clean) ---------------------
    ctx.save();
    ctx.strokeStyle = `rgba(${THEME.CENTER_RGB}, 0.22)`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (!tall) { ctx.moveTo(W / 2, 12); ctx.lineTo(W / 2, H - 12); }
    else       { ctx.moveTo(12, H / 2); ctx.lineTo(W - 12, H / 2); }
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 88, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 7, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${THEME.CENTER_RGB}, 0.6)`;
    ctx.fill();
    ctx.restore();
  }

  /**
   * Four neon border segments: TL yellow, TR green, BL red, BR blue.
   * Corners are rounded arcs; the goal mouth is a gap: on the goal wall
   * each segment stops at (tall? x : y) center GOAL_WIDTH/2.
   */
  _drawBorder(ctx, W, H) {
    const seg = THEME.BORDER_SEGMENTS;
    const cr = CONFIG.CORNER_RADIUS;
    const half = CONFIG.GOAL_WIDTH / 2;

    let g0, g1;                    // gap start/end on the goal wall axis
    if (this.orientation === 'lr') { g0 = H / 2 - half; g1 = H / 2 + half; }
    else                           { g0 = W / 2 - half; g1 = W / 2 + half; }
    const midX = W / 2, midY = H / 2;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let s = 0; s < 4; s++) {
      const P = new Path2D();
      if (this.orientation === 'lr') {
        // goal gaps on left/right edges
        if (s === 0) {          // TL: goal-edge -> top-mid
          P.moveTo(0, g0);
          P.lineTo(0, cr);
          P.arc(cr, cr, cr, Math.PI, 1.5 * Math.PI);
          P.lineTo(midX, 0);
        } else if (s === 1) {   // TR: top-mid -> goal-edge
          P.moveTo(midX, 0);
          P.lineTo(W - cr, 0);
          P.arc(W - cr, cr, cr, 1.5 * Math.PI, 2 * Math.PI);
          P.lineTo(W, g0);
        } else if (s === 2) {   // BL: goal-edge -> bottom-mid
          P.moveTo(0, g1);
          P.lineTo(0, H - cr);
          P.arc(cr, H - cr, cr, Math.PI, 0.5 * Math.PI, true);
          P.lineTo(midX, H);
        } else {                // BR: bottom-mid -> goal-edge
          P.moveTo(midX, H);
          P.lineTo(W - cr, H);
          P.arc(W - cr, H - cr, cr, 0.5 * Math.PI, 0, true);
          P.lineTo(W, g1);
        }
      } else {
        // goal gaps on top/bottom edges
        if (s === 0) {          // TL: left-mid -> goal-edge
          P.moveTo(0, midY);
          P.lineTo(0, cr);
          P.arc(cr, cr, cr, Math.PI, 1.5 * Math.PI);
          P.lineTo(g0, 0);
        } else if (s === 1) {   // TR: goal-edge -> right-mid
          P.moveTo(g1, 0);
          P.lineTo(W - cr, 0);
          P.arc(W - cr, cr, cr, 1.5 * Math.PI, 2 * Math.PI);
          P.lineTo(W, midY);
        } else if (s === 2) {   // BL: left-mid -> goal-edge
          P.moveTo(0, midY);
          P.lineTo(0, H - cr);
          P.arc(cr, H - cr, cr, Math.PI, 0.5 * Math.PI, true);
          P.lineTo(g0, H);
        } else {                // BR: goal-edge -> right-mid
          P.moveTo(g1, H);
          P.lineTo(W - cr, H);
          P.arc(W - cr, H - cr, cr, 0.5 * Math.PI, 0, true);
          P.lineTo(W, midY);
        }
      }

      ctx.strokeStyle = seg[s];
      ctx.shadowColor = seg[s];
      ctx.shadowBlur = THEME.BLOOM_BLUR;
      ctx.lineWidth = THEME.BORDER_WIDTH;
      ctx.stroke(P);
    }
    ctx.shadowBlur = 0;
  }

  _drawGoals(ctx, W, H) {
    const tall = this.orientation === 'tb';
    const half = CONFIG.GOAL_WIDTH / 2;

    ctx.save();
    ctx.strokeStyle = 'rgba(244, 255, 249, 0.4)';
    ctx.lineWidth = 2;
    ctx.fillStyle = 'rgba(244, 255, 249, 0.85)';

    if (!tall) {
      const a = H / 2 - half, b = H / 2 + half;
      // goal lines
      ctx.beginPath();
      ctx.moveTo(0, a); ctx.lineTo(0, b);
      ctx.moveTo(W, a); ctx.lineTo(W, b);
      ctx.stroke();
      // posts
      const posts = [[0, a], [0, b], [W, a], [W, b]];
      for (const [px, py] of posts) {
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      const a = W / 2 - half, b = W / 2 + half;
      ctx.beginPath();
      ctx.moveTo(a, 0); ctx.lineTo(b, 0);
      ctx.moveTo(a, H); ctx.lineTo(b, H);
      ctx.stroke();
      const posts = [[a, 0], [b, 0], [a, H], [b, H]];
      for (const [px, py] of posts) {
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* Puck / trail / paddles                                             */
  /* ------------------------------------------------------------------ */

  /** ring-buffered trail: no shift(), no object churn */
  _updateTrail(world) {
    const p = world.puck;
    if (world.frozen) {                    // trail fades while frozen
      if (this.trailCount) this.trailCount--;
      return;
    }
    const cap = CONFIG.PUCK_TRAIL_LENGTH;
    this.trailHead = (this.trailHead + 1) % cap;
    const i2 = this.trailHead * 2;
    this.trailBuf[i2] = p.x;
    this.trailBuf[i2 + 1] = p.y;
    if (this.trailCount < cap) this.trailCount++;
  }

  /** drawn as 3 batched polylines (young -> old) instead of one arc per point */
  _drawTrail(ctx) {
    const n = this.trailCount;
    if (n < 2) return;
    const cap = CONFIG.PUCK_TRAIL_LENGTH;
    const groups = 3;
    const seg = n / groups;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let g = 0; g < groups; g++) {
      const from = Math.floor(g * seg);
      const to = Math.min(n - 1, Math.floor((g + 1) * seg));
      if (to <= from) continue;
      ctx.beginPath();
      for (let k = from; k <= to; k++) {
        // k = 0 is the newest sample
        const idx = ((this.trailHead - k) % cap + cap) % cap;
        const x = this.trailBuf[idx * 2], y = this.trailBuf[idx * 2 + 1];
        if (k === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      const t = 1 - (from + seg * 0.5) / n;        // newer => brighter
      ctx.globalAlpha = 0.06 + 0.2 * t;
      ctx.strokeStyle = `rgba(${THEME.TRAIL_RGB}, 1)`;
      ctx.lineWidth = CONFIG.PUCK_RADIUS * (0.4 + 0.4 * t);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawPuckIfVisible(ctx, p, W, H) {
    if (p.x < -p.r * 2 || p.x > W + p.r * 2 || p.y < -p.r * 2 || p.y > H + p.r * 2) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10, 12, 16, 0.9)';        // white puck over darker base
    ctx.shadowColor = THEME.PUCK;
    ctx.shadowBlur = 14;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = THEME.PUCK;
    ctx.stroke();
  }

  /** thick outer ring + solid inner core, player color via THEME */
  _drawPaddle(ctx, p) {
    const col = THEME.P_COLORS[p.side] || THEME.P_COLORS[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6, 10, 14, 0.88)';
    ctx.shadowColor = col;
    ctx.shadowBlur = 16;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 7;                              // thick colored ring
    ctx.strokeStyle = col;
    ctx.stroke();

    // filled inner core
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------------------ */
  /* Scoring-side flashes (border pulse in the scorer's color)          */
  /* ------------------------------------------------------------------ */

  _drawGoalFlashes(ctx, W, H, dt) {
    const fs = this.goalFlashes;
    for (let i = fs.length - 1; i >= 0; i--) {
      const f = fs[i];
      f.t += dt;
      const k = f.t / 0.9;
      if (k >= 1) {
        fs[i] = fs[fs.length - 1];
        fs.pop();
        continue;
      }
      const pulse = 0.5 + 0.5 * Math.sin(f.t * 18);
      const a = (1 - k) * (0.25 + 0.25 * pulse);
      const rgba = Renderer._hexA(f.color, a);

      ctx.save();
      // tint the conceded half
      ctx.beginPath();
      if (this.orientation === 'lr') {
        ctx.rect(f.side === 0 ? 0 : W / 2, 0, W / 2, H);
      } else {
        ctx.rect(0, f.side === 0 ? H / 2 : 0, W, H / 2);
      }
      ctx.fillStyle = rgba;
      ctx.fill();

      // bright border over that half
      ctx.clip();
      this._roundedRectPath(ctx, 0, 0, W, H, CONFIG.CORNER_RADIUS);
      ctx.strokeStyle = rgba;
      ctx.lineWidth = 10;
      ctx.shadowColor = rgba;
      ctx.shadowBlur = 26;
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tracking markers — raw hand position drawn over the camera feed    */
  /* ------------------------------------------------------------------ */

  _drawMarkers(ctx, markers) {
    if (!markers || !markers.length) return;
    const vid = this.video;
    if (!vid || !vid.videoWidth) return;

    const cw = this.canvas.width, chh = this.canvas.height;
    const vw = vid.videoWidth, vh = vid.videoHeight;
    const k = Math.max(cw / vw, chh / vh);
    const dw = vw * k, dh = vh * k;
    const ox = (cw - dw) / 2, oy = (chh - dh) / 2;

    // one save/restore for the whole marker batch; style set per marker
    ctx.save();
    ctx.font = '900 30px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 10);

    for (const m of markers) {
      // m.x is already mirrored video coords -> canvas px -> table coords
      const cxp = ox + m.x * dw;
      const cyp = oy + m.y * dh;
      const tx = cxp / this.scale;
      const ty = cyp / this.scale;

      const side = this.orientation === 'lr'
        ? (m.x < 0.5 ? 0 : 1)
        : (m.y > 0.5 ? 0 : 1);

      // accuracy colors: red = out of bounds, orange = bad depth, else player
      const isOob = !!m.oob, isDepth = !!m.depth;
      const degraded = isOob || isDepth;
      const col = isOob ? '#ff3b44' : isDepth ? '#ff9d3f' : THEME.P_COLORS[side];
      const ringR = degraded ? 20 + 6 * pulse : 16;

      ctx.globalAlpha = degraded ? 1 : 0.85;
      ctx.strokeStyle = col;
      ctx.lineWidth = degraded ? 3.5 : 2.5;
      ctx.beginPath();
      ctx.arc(tx, ty, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tx, ty, 4, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();

      // degraded-accuracy badge: pulsing "!" above the marker
      if (degraded) {
        ctx.shadowColor = col;
        ctx.shadowBlur = 14;
        ctx.fillStyle = col;
        ctx.fillText('!', tx, ty - ringR - 8);
        // radar ping ring
        ctx.beginPath();
        ctx.arc(tx, ty, ringR + 14 * pulse, 0, Math.PI * 2);
        ctx.globalAlpha = (1 - pulse) * 0.6;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* Particles / flashes                                                */
  /* ------------------------------------------------------------------ */

  _updateAndDrawParticles(ctx, dt) {
    const parts = this.particles;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) {
        // swap-pop instead of splice -> no O(n) cleanup
        parts[i] = parts[parts.length - 1];
        parts.pop();
        continue;
      }
      p.vy += 180 * dt;                       // light gravity
      p.vx *= (1 - 2.2 * dt); p.vy *= (1 - 2.2 * dt);
      p.x += p.vx * dt; p.y += p.vy * dt;
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  _drawFlashes(ctx, dt) {
    const fs = this.flashes;
    for (let i = fs.length - 1; i >= 0; i--) {
      const f = fs[i];
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) {
        fs[i] = fs[fs.length - 1];
        fs.pop();
        continue;
      }
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

if (typeof window !== 'undefined') {
  window.Renderer = Renderer;
}
