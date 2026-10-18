/**
 * physics.js
 * ==========================================================================
 * Fixed-timestep air hockey physics.
 *
 *  - Fixed timestep: CONFIG.FIXED_DT (1/120 s) driven by an accumulator,
 *    capped at CONFIG.MAX_SUBSTEPS per frame so a slow frame can't explode.
 *  - Puck vs paddles: continuous 1D sweep (segment vs circle) inside each
 *    substep so the puck can't tunnel through a paddle, plus overlap
 *    depenetration for paddles that move into a stationary puck.
 *    Impulse = reflect puck velocity relative to paddle, then ADD the
 *    paddle velocity => fast hand swings hit harder.
 *  - Walls: bounce with CONFIG.PUCK_WALL_RESTITUTION, friction applied over
 *    time (CONFIG.PUCK_FRICTION per fixed step), hard speed cap.
 *  - Goals: opening in each end wall with post collision; a goal fires when
 *    the puck FULLY crosses the goal line.
 *  - Rounded corners: quarter-circle arcs, puck slides around them.
 *  - Anti-stuck: if the puck is slow for CONFIG.PUCK_STUCK_TIME it gets
 *    nudged toward center (corners, bad bounces, paddle pinning).
 *  - Orientation-aware: 'lr' (goals left/right) or 'tb' (goals top/bottom).
 *
 * All coordinates are in "table pixels" (CONFIG.TABLE_W/H); tracking feeds
 * normalized [0..1] targets which are converted here.
 * ==========================================================================
 */

/* Module-level tuning not worth exposing in the settings UI */
const PHYS = {
  PUCK_PADDLE_RESTITUTION: 1.0,   // elasticity of paddle->puck reflection
  PUCK_PADDLE_FRICTION: 0.92,     // tangential damping on paddle hits
  PADDLE_PUSH_RATIO: 0.35,        // extra kick from paddle swing speed
  POST_RADIUS: 10,                // goal post collision radius
  POST_RESTITUTION: 0.7,
  IMPACT_TO_STRENGTH: 1 / 1400,   // normalize impact speed for sfx/particles
  WALL_TO_STRENGTH: 1 / 2000,
};

class PhysicsWorld {

  constructor(orientation) {
    // state fields first — setOrientation() resets the puck into them
    this.puck = { x: 640, y: 360, vx: 0, vy: 0, r: CONFIG.PUCK_RADIUS };
    this.paddles = [
      { side: 0, x: 0.20 * CONFIG.TABLE_W, y: 0.5 * CONFIG.TABLE_H, r: CONFIG.PADDLE_RADIUS, vx: 0, vy: 0 },
      { side: 1, x: 0.80 * CONFIG.TABLE_W, y: 0.5 * CONFIG.TABLE_H, r: CONFIG.PADDLE_RADIUS, vx: 0, vy: 0 },
    ];
    this.orientation = 'lr';
    this.setOrientation(orientation);
    this.speedMult = 1;      // set from settings (slow/normal/fast)
    this.frozen = false;     // puck frozen during goal celebration / serve delay
    this.acc = 0;            // fixed-timestep accumulator
    this.stuckTimer = 0;

    this.events = [];        // consumed by game each frame (takeEvents)
    this.placePuckCenter();
  }

  /* ------------------------------------------------------------------ */
  /* Setup / helpers                                                    */
  /* ------------------------------------------------------------------ */

  setOrientation(o) {
    this.orientation = o === 'tb' ? 'tb' : 'lr';
    this.tall = this.orientation === 'tb';
    this.W = this.tall ? CONFIG.TABLE_H : CONFIG.TABLE_W;
    this.H = this.tall ? CONFIG.TABLE_W : CONFIG.TABLE_H;
    this.placePuckCenter();
    for (const p of this.paddles) { this.clampPaddle(p); p.vx = p.vy = 0; }
  }

  setSpeedMult(m) { this.speedMult = m; }

  takeEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  emit(ev) { this.events.push(ev); }

  maxTableSpeed() { return CONFIG.PUCK_MAX_SPEED * this.speedMult; }

  placePuckCenter() {
    this.puck.x = this.W / 2;
    this.puck.y = this.H / 2;
    this.puck.vx = 0; this.puck.vy = 0;
    this.frozen = true;
    this.stuckTimer = 0;
  }

  /**
   * Serve the puck toward the receiving player k (0 = P1 side, 1 = P2 side).
   * Used after goals and at game start.
   */
  serve(k) {
    this.placePuckCenter();
    this.frozen = false;
    const speed = CONFIG.PUCK_SERVE_SPEED_BASE * this.speedMult;
    let dir;
    if (!this.tall) dir = { x: k === 0 ? -1 : 1, y: 0 };
    else            dir = { x: 0, y: k === 0 ? 1 : -1 };
    // small random angle so serves aren't 100% identical
    const a = (Math.random() - 0.5) * 0.5;
    const cos = Math.cos(a), sin = Math.sin(a);
    this.puck.vx = (dir.x * cos - dir.y * sin) * speed;
    this.puck.vy = (dir.x * sin + dir.y * cos) * speed;
  }

  /** clamp a paddle inside its own half + table bounds (never crosses center) */
  clampPaddle(p) {
    const r = p.r, half = !this.tall ? this.W / 2 : this.H / 2;
    const cl = (v, a, b) => v < a ? a : (v > b ? b : v);
    if (!this.tall) {
      p.x = p.side === 0 ? cl(p.x, r, half - r) : cl(p.x, half + r, this.W - r);
      p.y = cl(p.y, r, this.H - r);
    } else {
      p.x = cl(p.x, r, this.W - r);
      p.y = p.side === 0 ? cl(p.y, half + r, this.H - r) : cl(p.y, r, half - r);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Main update (called once per animation frame)                      */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} frameDt seconds since last frame (clamped by game loop)
   * @param {Array|null} targets [{x,y}] normalized [0..1] paddle targets
   */
  update(frameDt, targets) {
    if (targets) {
      for (let i = 0; i < 2; i++) {
        this.paddles[i].tx = targets[i].x;
        this.paddles[i].ty = targets[i].y;
      }
    }

    let steps = 0;
    this.acc += frameDt;
    while (this.acc >= CONFIG.FIXED_DT && steps < CONFIG.MAX_SUBSTEPS) {
      this._step(CONFIG.FIXED_DT);
      this.acc -= CONFIG.FIXED_DT;
      steps++;
    }
    // too far behind — drop the backlog rather than spiral
    if (this.acc > CONFIG.FIXED_DT * CONFIG.MAX_SUBSTEPS) this.acc = 0;
  }

  /* ------------------------------------------------------------------ */
  /* One fixed physics substep                                          */
  /* ------------------------------------------------------------------ */

  _step(dt) {
    const puck = this.puck;

    // 1) integrate paddles toward their targets (capped speed)
    for (const p of this.paddles) this._integratePaddle(p, dt);

    // 2) puck
    if (!this.frozen) {
      // continuous collision with paddles before moving
      this._sweepPuckVsPaddles(puck, dt);
      // move
      puck.x += puck.vx * dt;
      puck.y += puck.vy * dt;
      // walls, posts, corners
      this._collideWalls(puck, dt);
      this._collideCorners(puck);
      // just in case: depenetrate against paddles that moved INTO the puck
      for (const p of this.paddles) this._resolvePaddleOverlap(puck, p);
      // friction (per fixed step), speed cap
      const f = Math.pow(CONFIG.PUCK_FRICTION, dt / CONFIG.FIXED_DT);
      puck.vx *= f; puck.vy *= f;
      this._capPuckSpeed();
      // goal detection
      this._checkGoal(puck);
      // anti-stuck
      this._checkStuck(dt);
    }
  }

  /* -- paddle integration ------------------------------------------- */

  _integratePaddle(p, dt) {
    let tx = p.tx, ty = p.ty;
    if (tx === undefined) { tx = p.x; ty = p.y; }
    tx *= this.W; ty *= this.H; // normalized -> table px

    const dx = tx - p.x, dy = ty - p.y;
    const dist = Math.hypot(dx, dy);
    const maxMove = CONFIG.PADDLE_MAX_SPEED * dt;

    const oldX = p.x, oldY = p.y;
    if (dist > 1e-6) {
      const move = Math.min(dist, maxMove);
      p.x += dx / dist * move;
      p.y += dy / dist * move;
    }
    this.clampPaddle(p);

    // actual velocity = what really happened this step (drives puck hits)
    p.vx = (p.x - oldX) / dt;
    p.vy = (p.y - oldY) / dt;
  }

  /* -- continuous puck sweep vs paddles ------------------------------ */

  _sweepPuckVsPaddles(puck, dt) {
    for (const pd of this.paddles) {
      const R = puck.r + pd.r;
      const dx = puck.vx * dt, dy = puck.vy * dt;
      const fx = puck.x - pd.x, fy = puck.y - pd.y;

      // already overlapping -> resolve directly this step
      if (fx * fx + fy * fy < R * R) { this._resolvePaddleHit(puck, pd); continue; }

      // segment |(f + t*d)| = R
      const a = dx * dx + dy * dy;
      if (a < 1e-9) continue;
      const b = 2 * (fx * dx + fy * dy);
      const c = fx * fx + fy * fy - R * R;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t >= 0 && t <= 1) {
        // land exactly on the contact point, then resolve
        puck.x += dx * t;
        puck.y += dy * t;
        this._resolvePaddleHit(puck, pd);
        // push the puck along its remaining motion so it keeps sliding
        puck.x += dx * (1 - t);
        puck.y += dy * (1 - t);
      }
    }
  }

  /* -- impulse resolution -------------------------------------------- */

  _resolvePaddleHit(puck, pd) {
    let dx = puck.x - pd.x, dy = puck.y - pd.y;
    let d = Math.hypot(dx, dy);
    if (d < 1e-6) { dx = 1; dy = 0; d = 1; }
    const nx = dx / d, ny = dy / d;
    const R = puck.r + pd.r;

    // depenetrate: place puck exactly on the contact circle (tiny epsilon)
    puck.x = pd.x + nx * (R + 0.5);
    puck.y = pd.y + ny * (R + 0.5);

    // relative velocity puck vs paddle
    let rvx = puck.vx - pd.vx, rvy = puck.vy - pd.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return; // already moving apart

    // reflect relative velocity along n (+ tangential friction)
    const e = PHYS.PUCK_PADDLE_RESTITUTION;
    let nvn = -(1 + e) * vn;
    const tvx = rvx - nvn * nx, tvy = rvy - nvn * ny;
    rvx = rvx + nvn * nx - tvx * (1 - PHYS.PUCK_PADDLE_FRICTION);
    rvy = rvy + nvn * ny - tvy * (1 - PHYS.PUCK_PADDLE_FRICTION);

    puck.vx = pd.vx + rvx;
    puck.vy = pd.vy + rvy;

    // extra kick proportional to paddle swing INTO the puck
    const push = Math.max(0, pd.vx * nx + pd.vy * ny);
    const extra = Math.min(push * PHYS.PADDLE_PUSH_RATIO, CONFIG.PADDLE_MAX_HIT_BOOST);
    puck.vx += nx * extra;
    puck.vy += ny * extra;

    this._capPuckSpeed();
    this.stuckTimer = 0;

    const strength = Math.max(0.15, Math.min(1, (-vn) * PHYS.IMPACT_TO_STRENGTH));
    this.emit({
      type: 'paddleHit', player: pd.side,
      x: pd.x + nx * pd.r, y: pd.y + ny * pd.r, strength,
    });
  }

  /** overlap fallback: paddle moved into a stationary puck */
  _resolvePaddleOverlap(puck, pd) {
    const R = puck.r + pd.r;
    const dx = puck.x - pd.x, dy = puck.y - pd.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R) return;
    this._resolvePaddleHit(puck, pd);
  }

  /* -- walls & goal line --------------------------------------------- */

  _goalSpan() {
    const half = CONFIG.GOAL_WIDTH / 2;
    if (!this.tall) return { c: this.H / 2, a: this.H / 2 - half, b: this.H / 2 + half };
    return { c: this.W / 2, a: this.W / 2 - half, b: this.W / 2 + half };
  }

  _collideWalls(puck, dt) {
    const e = CONFIG.PUCK_WALL_RESTITUTION;
    const R = puck.r;
    const g = this._goalSpan();
    // is the puck horizontally/vertically inside a goal opening?
    const inGoalMouth = !this.tall
      ? (puck.y > g.a && puck.y < g.b)
      : (puck.x > g.a && puck.x < g.b);

    const bounce = (axis, wallAt, isMinSide) => {
      if (axis === 'x') {
        puck.x = wallAt + (isMinSide ? R : -R);
        puck.vx = Math.abs(puck.vx) * e * (isMinSide ? 1 : -1);
      } else {
        puck.y = wallAt + (isMinSide ? R : -R);
        puck.vy = Math.abs(puck.vy) * e * (isMinSide ? 1 : -1);
      }
      this.emit({
        type: 'wallHit',
        x: puck.x, y: puck.y,
        strength: Math.max(0.1, Math.min(1, Math.abs(isMinSide ? puck.vx : puck.vy) * e * PHYS.WALL_TO_STRENGTH)),
      });
    };

    if (!this.tall) {
      if (puck.x - R < 0 && !inGoalMouth) bounce('x', 0, true);
      if (puck.x + R > this.W && !inGoalMouth) bounce('x', this.W, false);
      if (puck.y - R < 0) bounce('y', 0, true);
      if (puck.y + R > this.H) bounce('y', this.H, false);
    } else {
      if (puck.x - R < 0) bounce('x', 0, true);
      if (puck.x + R > this.W) bounce('x', this.W, false);
      if (puck.y - R < 0 && !inGoalMouth) bounce('y', 0, true);
      if (puck.y + R > this.H && !inGoalMouth) bounce('y', this.H, false);
    }

    this._goalPosts(puck);
  }

  /** goal-post circles at the edges of each goal mouth */
  _goalPosts(puck) {
    const R = puck.r + PHYS.POST_RADIUS;
    const g = this._goalSpan();
    const posts = [];
    if (!this.tall) {
      const cy = g.c, mh = CONFIG.GOAL_WIDTH / 2;
      posts.push([0, cy - mh], [0, cy + mh], [this.W, cy - mh], [this.W, cy + mh]);
    } else {
      const cx = g.c, mh = CONFIG.GOAL_WIDTH / 2;
      posts.push([cx - mh, 0], [cx + mh, 0], [cx - mh, this.H], [cx + mh, this.H]);
    }

    for (const [px, py] of posts) {
      const dx = puck.x - px, dy = puck.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R || d2 < 1e-9) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dy / d;
      puck.x = px + nx * (R + 0.5);
      puck.y = py + ny * (R + 0.5);
      const vn = puck.vx * nx + puck.vy * ny;
      if (vn < 0) {
        puck.vx -= (1 + PHYS.POST_RESTITUTION) * vn * nx;
        puck.vy -= (1 + PHYS.POST_RESTITUTION) * vn * ny;
        this.emit({
          type: 'wallHit', x: puck.x, y: puck.y,
          strength: Math.max(0.15, Math.min(1, -vn * PHYS.WALL_TO_STRENGTH)),
        });
      }
    }
  }

  /* -- rounded corner arcs ------------------------------------------- */

  _collideCorners(puck) {
    const cr = CONFIG.CORNER_RADIUS, R = puck.r;
    const lim = cr - R;
    if (lim <= 0) return;
    const corners = [
      [cr, cr], [this.W - cr, cr], [cr, this.H - cr], [this.W - cr, this.H - cr],
    ];
    for (const [cx, cy] of corners) {
      const dx = puck.x - cx, dy = puck.y - cy;
      const d = Math.hypot(dx, dy);
      if (d >= lim || d < 1e-6) continue;
      const nx = dx / d, ny = dy / d;
      puck.x = cx + nx * lim;
      puck.y = cy + ny * lim;
      const vn = puck.vx * nx + puck.vy * ny;
      if (vn < 0) {
        const e = CONFIG.PUCK_WALL_RESTITUTION;
        puck.vx -= (1 + e) * vn * nx;
        puck.vy -= (1 + e) * vn * ny;
        this.emit({
          type: 'wallHit', x: puck.x, y: puck.y,
          strength: Math.max(0.1, Math.min(1, -vn * PHYS.WALL_TO_STRENGTH)),
        });
      }
    }
  }

  /* -- goal detection ------------------------------------------------- */

  _checkGoal(puck) {
    const g = this._goalSpan();
    let scorer = null; // who earns the point

    if (!this.tall) {
      const inMouthY = puck.y > g.a && puck.y < g.b;
      if (inMouthY && puck.x + puck.r < 0) scorer = 1;        // entered P1's goal
      if (inMouthY && puck.x - puck.r > this.W) scorer = 0;   // entered P2's goal
    } else {
      const inMouthX = puck.x > g.a && puck.x < g.b;
      if (inMouthX && puck.y - puck.r > this.H) scorer = 1;   // entered P1's goal (bottom)
      if (inMouthX && puck.y + puck.r < 0) scorer = 0;        // entered P2's goal (top)
    }

    if (scorer !== null) {
      this.frozen = true;
      this.emit({ type: 'goal', scorer, x: puck.x, y: puck.y });
    }
  }

  /* -- anti-stuck ------------------------------------------------------ */

  _checkStuck(dt) {
    const speed = Math.hypot(this.puck.vx, this.puck.vy);
    if (speed < CONFIG.PUCK_STUCK_MIN_SPEED) {
      this.stuckTimer += dt;
      if (this.stuckTimer > CONFIG.PUCK_STUCK_TIME) {
        this.stuckTimer = 0;
        // nudge back toward the center of the table with some randomness
        let ax = this.W / 2 - this.puck.x, ay = this.H / 2 - this.puck.y;
        let d = Math.hypot(ax, ay);
        if (d < 1) { ax = 0.7; ay = 0.7; d = 1; }
        ax /= d; ay /= d;
        const a = (Math.random() - 0.5) * 1.1;
        const cos = Math.cos(a), sin = Math.sin(a);
        const s = CONFIG.PUCK_NUDGE_SPEED * this.speedMult;
        this.puck.vx = (ax * cos - ay * sin) * s;
        this.puck.vy = (ax * sin + ay * cos) * s;
        this.emit({ type: 'nudge', x: this.puck.x, y: this.puck.y });
      }
    } else {
      this.stuckTimer = 0;
    }
  }

  /* -- speed cap -------------------------------------------------------- */

  _capPuckSpeed() {
    const max = this.maxTableSpeed();
    const s = Math.hypot(this.puck.vx, this.puck.vy);
    if (s > max && s > 0) {
      const k = max / s;
      this.puck.vx *= k; this.puck.vy *= k;
    }
  }
}

if (typeof window !== 'undefined') {
  window.PhysicsWorld = PhysicsWorld;
}
