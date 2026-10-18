/**
 * renderer.js
 * ==========================================================================
 * Canvas renderer: mirrored webcam background, neon arcade table,
 * paddles, puck with motion trail, tracking markers, particle bursts,
 * goal flash rings and a small screen shake for hard hits.
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

    this.trail = [];
    this.particles = [];
    this.flashes = [];   // expanding rings (hard hits + goals)
    this.shake = 0;      // px, decays exponentially

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
    this.trail.length = 0;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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

  shakeScreen(px) { this.shake = Math.min(14, this.shake + px); }

  resetTrail() { this.trail.length = 0; }

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

  render(dt, world, markers) {
    const ctx = this.ctx;
    const cw = this.canvas.width, chh = this.canvas.height;

    // decaying shake offset (canvas px)
    this.shake = this.shake > 0.05 ? this.shake * Math.exp(-7 * dt) : 0;
    const shx = (Math.random() - 0.5) * 2 * this.shake;
    const shy = (Math.random() - 0.5) * 2 * this.shake;

    // ---- background ---------------------------------------------------
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#06060f';
    ctx.fillRect(0, 0, cw, chh);

    if (this.showCamBg && this.video && this.video.videoWidth > 0) {
      const vw = this.video.videoWidth, vh = this.video.videoHeight;
      const k = Math.max(cw / vw, chh / vh);          // cover-fit
      const dw = vw * k, dh = vh * k;
      const ox = (cw - dw) / 2, oy = (chh - dh) / 2;
      ctx.save();
      ctx.globalAlpha = CONFIG.CAM_BG_OPACITY;
      ctx.translate(cw, 0); ctx.scale(-1, 1);         // horizontal mirror
      ctx.drawImage(this.video, ox, oy, dw, dh);
      ctx.restore();
      ctx.fillStyle = 'rgba(6, 6, 18, 0.5)';          // darken for contrast
      ctx.fillRect(0, 0, cw, chh);
    }

    // ---- world transform ----------------------------------------------
    ctx.setTransform(this.scale, 0, 0, this.scale, shx * this.scale, shy * this.scale);
    const W = this.W, H = this.H;

    this._drawTable(ctx, W, H);
    this._updateTrail(world, dt);
    this._drawTrail(ctx);
    this._drawPuckIfVisible(ctx, world.puck, W, H);
    for (const p of world.paddles) this._drawPaddle(ctx, p);
    if (this.showMarkers) this._drawMarkers(ctx, markers);

    this._updateAndDrawParticles(ctx, dt);
    this._drawFlashes(ctx, dt);
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

  _drawTable(ctx, W, H) {
    const tall = this.orientation === 'tb';
    const col1 = 'rgba(0,229,255,1)';    // P1 accent
    const col2 = 'rgba(255,43,214,1)';   // P2 accent

    // surface
    ctx.fillStyle = 'rgba(10, 12, 30, 0.72)';
    this._roundedRectPath(ctx, 0, 0, W, H, CONFIG.CORNER_RADIUS);
    ctx.fill();

    // boundary with a cyan->magenta neon gradient
    const grad = tall
      ? ctx.createLinearGradient(0, H, 0, 0)   // bottom=P1 -> top=P2
      : ctx.createLinearGradient(0, 0, W, 0);  // left=P1  -> right=P2
    grad.addColorStop(0, col1);
    grad.addColorStop(1, col2);
    ctx.save();
    ctx.strokeStyle = grad;
    ctx.lineWidth = 5;
    ctx.shadowColor = col1;
    ctx.shadowBlur = 22;
    this._roundedRectPath(ctx, 0, 0, W, H, CONFIG.CORNER_RADIUS);
    ctx.stroke();
    ctx.restore();

    // goal mouths
    this._drawGoals(ctx, W, H);

    // center line + face-off circle
    ctx.save();
    ctx.strokeStyle = 'rgba(232, 246, 255, 0.45)';
    ctx.lineWidth = 3;
    ctx.setLineDash([18, 14]);
    ctx.beginPath();
    if (!tall) { ctx.moveTo(W / 2, 12); ctx.lineTo(W / 2, H - 12); }
    else       { ctx.moveTo(12, H / 2); ctx.lineTo(W - 12, H / 2); }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 88, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(232, 246, 255, 0.6)';
    ctx.fill();
    ctx.restore();
  }

  _drawGoals(ctx, W, H) {
    const tall = this.orientation === 'tb';
    const half = CONFIG.GOAL_WIDTH / 2;
    // mouth span along the end wall; P1's own goal uses `colP1`
    const spanA = (tall ? W : H) / 2 - half;
    const spanB = (tall ? W : H) / 2 + half;
    const mouths = tall
      ? [ { line: 0, out: 1,  col: '#ff2bd6' },   // P2 goal (top wall) — lashes point into the table
          { line: H, out: -1, col: '#00e5ff' } ]  // P1 goal (bottom wall)
      : [ { line: 0, out: 1,  col: '#00e5ff' },   // P1 goal (left wall)
          { line: W, out: -1, col: '#ff2bd6' } ]; // P2 goal (right wall)

    for (const m of mouths) {
      ctx.save();

      // posts at the two mouth edges
      ctx.shadowColor = m.col;
      ctx.shadowBlur = 16;
      ctx.fillStyle = 'rgba(232, 246, 255, 0.85)';
      for (let i = 0; i < 2; i++) {
        const q = i === 0 ? spanA : spanB;
        const px = tall ? q : m.line;
        const py = tall ? m.line : q;
        ctx.beginPath();
        ctx.arc(px, py, 9, 0, Math.PI * 2);
        ctx.fill();
      }

      // net: short lashes pointing outward + a base line
      ctx.strokeStyle = m.col;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let q = spanA; q <= spanB + 0.01; q += 16) {
        if (tall) {
          ctx.moveTo(q, m.line);
          ctx.lineTo(q, m.line + m.out * 30);
        } else {
          ctx.moveTo(m.line, q);
          ctx.lineTo(m.line + m.out * 30, q);
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Puck / trail / paddles                                             */
  /* ------------------------------------------------------------------ */

  _updateTrail(world, dt) {
    const p = world.puck;
    if (world.frozen) {
      if (this.trail.length) this.trail.shift();
      return;
    }
    this.trail.push({ x: p.x, y: p.y });
    while (this.trail.length > CONFIG.PUCK_TRAIL_LENGTH) this.trail.shift();
  }

  _drawTrail(ctx) {
    const n = this.trail.length;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const pt = this.trail[i];
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, CONFIG.PUCK_RADIUS * (0.25 + 0.5 * t), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(160, 220, 255, ${0.05 + 0.16 * t})`;
      ctx.fill();
    }
  }

  _drawPuckIfVisible(ctx, p, W, H) {
    if (p.x < -p.r * 2 || p.x > W + p.r * 2 || p.y < -p.r * 2 || p.y > H + p.r * 2) return;
    ctx.save();
    ctx.shadowColor = '#9adcff';
    ctx.shadowBlur = 24;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(12, 16, 34, 0.95)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#9adcff';
    ctx.stroke();
    ctx.restore();
  }

  _drawPaddle(ctx, p) {
    const col = p.side === 0 ? '#00e5ff' : '#ff2bd6';
    ctx.save();
    ctx.shadowColor = col;
    ctx.shadowBlur = 26;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10, 12, 28, 0.92)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = col;
    ctx.stroke();
    // inner ring
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 0.5, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
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

    for (const m of markers) {
      // m.x is already mirrored video coords -> canvas px -> table coords
      const cxp = ox + m.x * dw;
      const cyp = oy + m.y * dh;
      const tx = cxp / this.scale;
      const ty = cyp / this.scale;

      const side = this.orientation === 'lr'
        ? (m.x < 0.5 ? 0 : 1)
        : (m.y > 0.5 ? 0 : 1);
      const col = side === 0 ? '#00e5ff' : '#ff2bd6';

      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(tx, ty, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tx, ty, 4, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Particles / flashes                                                */
  /* ------------------------------------------------------------------ */

  _updateAndDrawParticles(ctx, dt) {
    const parts = this.particles;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
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
      if (k >= 1) { fs.splice(i, 1); continue; }
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
