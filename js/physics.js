/**
 * physics.js
 * ==========================================================================
 * HOCKEY-AR rebuild — zero-allocation, orientation-generic physics world.
 *
 * Design rules
 *  - ZERO per-frame allocation: every state vector (puck position/velocity,
 *    paddle positions/velocities, event pool, scratch arrays) lives in
 *    preallocated Float32Array buffers. `world.puck` / `world.pad0` /
 *    `world.pad1` are stable typed-array VIEWS created once.
 *  - SUB-STEPPING: each fixed step (FIXED_DT) splits puck movement into up
 *    to PUCK_SUBSTEP_MAX equal sub-chunks (chunk length scaled from actual
 *    travel), so a max-speed puck can never tunnel through a wall or a
 *    paddle. Collision tests run after every sub-chunk.
 *  - PLATFORM-AGNOSTIC: works in 'lr' (1280x720, goals left/right) and 'tb'
 *    (720x1280, goals top/bottom) purely from orientation flags — no
 *    duplicated code paths.
 *  - NUDGE_HOLD: the stuck-puck auto-nudge stands down cleanly whenever a
 *    paddle hovers within NUDGE_HOVER_PAD of the puck (player intent:
 *    "I've got it"); when the hover clears while the puck is still stuck,
 *    the nudge fires on the next step.
 *
 * Events are drained via drainEvents(fn): the pool is reused, so the game
 * must consume events strictly between steps (the rAF loop guarantees it).
 * ==========================================================================
 */

/* ---- state buffer offsets ---------------------------------------- */
const E_PUCK_X = 0, E_PUCK_Y = 1, E_PUCK_VX = 2, E_PUCK_VY = 3;
const E_PAD0_X = 4, E_PAD0_Y = 5, E_PAD1_X = 6, E_PAD1_Y = 7;   // stride 2

/* ---- module constants (computed once) ---------------------------- */
const R_PUCK = CONFIG.PUCK_RADIUS;
const R_PADDLE = CONFIG.PADDLE_RADIUS;
const R_CONTACT = R_PUCK + R_PADDLE;
const SPEED2_CAP = CONFIG.PUCK_MAX_SPEED * CONFIG.PUCK_MAX_SPEED;

class PhysicsWorld {

  constructor(orientation) {
    // ---- preallocated state ------------------------------------------
    this.state = new Float32Array(8);        // puck(4) + pad0(2) + pad1(2)
    this.padVel = new Float32Array(4);       // pad0 vx,vy | pad1 vx,vy
    this.homes = new Float32Array(4);        // normalized home positions
    this.clampOut = new Float32Array(2);     // half-clamp scratch

    // stable views — created once, never reallocated
    this.puck = this.state.subarray(0, 4);
    this.pad0 = this.state.subarray(4, 6);
    this.pad1 = this.state.subarray(6, 8);

    // ---- event pool (reused objects) ---------------------------------
    this.eventPool = [];
    for (let i = 0; i < 24; i++) {
      this.eventPool.push({
        type: '', x: 0, y: 0, player: -1, scorer: -1, strength: 0,
      });
    }
    this.eventCount = 0;

    // ---- scratch (wall flip bookkeeping) ------------------------------
    this._flip = 0; this._fx = 0; this._fy = 0;
    this._nearPaddle = 0;

    // ---- nudge / stuck state -----------------------------------------
    this.stuckTime = 0;
    this.nudgeHold = false;   // true while the stuck puck is being hovered

    this.frozen = false;
    this.speedMult = 1;
    this.margin = CONFIG.PADDLE_MARGIN;

    this.setOrientation(orientation || CONFIG.DEFAULT_ORIENTATION);
  }

  /* ------------------------------------------------------------------ */
  /* Orientation                                                        */
  /* ------------------------------------------------------------------ */

  setOrientation(o) {
    this.orientation = o === 'tb' ? 'tb' : 'lr';
    const tall = this.orientation === 'tb';
    this.W = tall ? CONFIG.TABLE_H : CONFIG.TABLE_W;
    this.H = tall ? CONFIG.TABLE_W : CONFIG.TABLE_H;
    this.halfW = this.W / 2;
    this.halfH = this.H / 2;

    // side 0 = P1: lr -> left half, tb -> bottom half. P2 mirrored.
    if (tall) {
      this.homes[0] = 0.5;  this.homes[1] = 0.8;    // P1 bottom
      this.homes[2] = 0.5;  this.homes[3] = 0.2;    // P2 top
    } else {
      this.homes[0] = 0.22; this.homes[1] = 0.5;    // P1 left
      this.homes[2] = 0.78; this.homes[3] = 0.5;    // P2 right
    }

    this.frozen = false;
    this.stuckTime = 0;
    this.nudgeHold = false;
    this._placePaddlesHome();
    this.placePuckCenter();
  }

  setSpeedMult(v) { this.speedMult = v || 1; }

  /* ------------------------------------------------------------------ */
  /* Placement / serving                                                */
  /* ------------------------------------------------------------------ */

  _placePaddlesHome() {
    const s = this.state;
    s[E_PAD0_X] = this.homes[0] * this.W;
    s[E_PAD0_Y] = this.homes[1] * this.H;
    s[E_PAD1_X] = this.homes[2] * this.W;
    s[E_PAD1_Y] = this.homes[3] * this.H;
    this.padVel[0] = 0; this.padVel[1] = 0;
    this.padVel[2] = 0; this.padVel[3] = 0;
  }

  /** puck to center, zero velocity, clear stuck/nudge state */
  placePuckCenter() {
    const s = this.state;
    s[E_PUCK_X] = this.halfW;
    s[E_PUCK_Y] = this.halfH;
    s[E_PUCK_VX] = 0; s[E_PUCK_VY] = 0;
    this.stuckTime = 0;
    this.nudgeHold = false;
  }

  /** serve from center toward the player who conceded last */
  serve(receiving) {
    const ang = (Math.random() - 0.5) * 0.9;           // ±~26° cone
    const sp = CONFIG.PUCK_SERVE_SPEED_BASE * this.speedMult;
    const s = this.state;
    s[E_PUCK_X] = this.halfW;
    s[E_PUCK_Y] = this.halfH;
    if (this.orientation === 'lr') {
      // receiver 0 = left -> puck drifts left
      s[E_PUCK_VX] = (receiving === 0 ? -1 : 1) * sp * Math.cos(ang);
      s[E_PUCK_VY] = sp * Math.sin(ang);
    } else {
      // receiver 0 = bottom -> puck drifts down
      s[E_PUCK_VY] = (receiving === 0 ? 1 : -1) * sp * Math.cos(ang);
      s[E_PUCK_VX] = sp * Math.sin(ang);
    }
    this.frozen = false;
    this.stuckTime = 0;
    this.nudgeHold = false;
  }

  /* ------------------------------------------------------------------ */
  /* Half-ownership clamping (orientation-generic)                      */
  /* ------------------------------------------------------------------ */

  /** clamp a paddle position to its own half; result in this.clampOut */
  _clampToHalf(i, x, y) {
    const m = this.margin, W = this.W, H = this.H;
    let cx = Math.min(Math.max(x, m), W - m);
    let cy = Math.min(Math.max(y, m), H - m);
    if (this.orientation === 'lr') {
      if (i === 0) cx = Math.min(cx, this.halfW - m);
      else         cx = Math.max(cx, this.halfW + m);
    } else {
      if (i === 0) cy = Math.max(cy, this.halfH + m);
      else         cy = Math.min(cy, this.halfH - m);
    }
    this.clampOut[0] = cx;
    this.clampOut[1] = cy;
  }

  /* ------------------------------------------------------------------ */
  /* Events (reused pool — zero allocation)                             */
  /* ------------------------------------------------------------------ */

  _push(type) {
    if (this.eventCount >= this.eventPool.length) return null;
    const ev = this.eventPool[this.eventCount++];
    ev.type = type; ev.x = 0; ev.y = 0;
    ev.player = -1; ev.scorer = -1; ev.strength = 0;
    return ev;
  }

  /** consume all pending events; `fn` is called once per event */
  drainEvents(fn) {
    const n = this.eventCount;
    for (let i = 0; i < n; i++) fn(this.eventPool[i]);
    this.eventCount = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Paddle motion                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Move paddles toward the normalized targets (Float32Array(4):
   * [p0x, p0y, p1x, p1y] from tracking/AI), capped at PADDLE_MAX_SPEED.
   * @private
   */
  _stepPaddles(dt, T) {
    const s = this.state, pv = this.padVel;
    const maxMove = CONFIG.PADDLE_MAX_SPEED * dt;

    for (let i = 0; i < 2; i++) {
      const ox = s[E_PAD0_X + i * 2], oy = s[E_PAD0_Y + i * 2];
      this._clampToHalf(i, T[i * 2] * this.W, T[i * 2 + 1] * this.H);
      let tx = this.clampOut[0], ty = this.clampOut[1];

      const dx = tx - ox, dy = ty - oy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > maxMove) {
        const k = maxMove / dist;
        tx = ox + dx * k;
        ty = oy + dy * k;
      }

      s[E_PAD0_X + i * 2] = tx;
      s[E_PAD0_Y + i * 2] = ty;
      pv[i * 2] = (tx - ox) / dt;
      pv[i * 2 + 1] = (ty - oy) / dt;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Puck integration: sub-chunks, walls, paddle collision, goals       */
  /* ------------------------------------------------------------------ */

  /** wall-flip bookkeeping for the wallHit event (contact point carrie) */
  _markFlip(x, y) {
    this._flip = 1;
    this._fx = x;
    this._fy = y;
  }

  /**
   * One movement sub-chunk. Returns true when a goal happened (remaining
   * sub-chunks are then skipped — the puck is frozen).
   * @private
   */
  _puckSubChunk(h) {
    const s = this.state;
    const r = R_PUCK, e = CONFIG.PUCK_WALL_RESTITUTION;
    const W = this.W, H = this.H;
    const tall = this.orientation === 'tb';
    const mouthMin = (tall ? this.halfW : this.halfH) - CONFIG.GOAL_WIDTH / 2;
    const mouthMax = (tall ? this.halfW : this.halfH) + CONFIG.GOAL_WIDTH / 2;

    let x = s[E_PUCK_X] + s[E_PUCK_VX] * h;
    let y = s[E_PUCK_Y] + s[E_PUCK_VY] * h;
    let vx = s[E_PUCK_VX], vy = s[E_PUCK_VY];

    if (tall) {
      /* ---- goal axis = y (top / bottom walls) -----------------------
         fully handled here: clamp+bounce outside the mouth, pass-through
         inside it ------------------------------------------------------ */
      const inMouth = x > mouthMin && x < mouthMax;
      if (y < r) {
        if (inMouth) { if (y < -r * 1.5) return this._goal(1); }
        else { y = r; if (vy < 0) { vy = -vy * e; this._markFlip(x, y); } }
      } else if (y > H - r) {
        if (inMouth) { if (y > H + r * 1.5) return this._goal(0); }
        else { y = H - r; if (vy > 0) { vy = -vy * e; this._markFlip(x, y); } }
      }
      // solid left/right walls
      if (x < r) { x = r; if (vx < 0) { vx = -vx * e; this._markFlip(x, y); } }
      else if (x > W - r) { x = W - r; if (vx > 0) { vx = -vx * e; this._markFlip(x, y); } }
    } else {
      /* ---- goal axis = x (left / right walls) ------------------------ */
      const inMouth = y > mouthMin && y < mouthMax;
      if (x < r) {
        if (inMouth) { if (x < -r * 1.5) return this._goal(0); }
        else { x = r; if (vx < 0) { vx = -vx * e; this._markFlip(x, y); } }
      } else if (x > W - r) {
        if (inMouth) { if (x > W + r * 1.5) return this._goal(1); }
        else { x = W - r; if (vx > 0) { vx = -vx * e; this._markFlip(x, y); } }
      }
      // solid top/bottom walls
      if (y < r) { y = r; if (vy < 0) { vy = -vy * e; this._markFlip(x, y); } }
      else if (y > H - r) { y = H - r; if (vy > 0) { vy = -vy * e; this._markFlip(x, y); } }
    }

    s[E_PUCK_X] = x; s[E_PUCK_Y] = y;
    s[E_PUCK_VX] = vx; s[E_PUCK_VY] = vy;

    this._paddleCollide(0);
    if (this.frozen) return true;
    this._paddleCollide(1);
    return this.frozen;
  }

  /** circle-circle vs paddle i: reflect relative normal velocity + boost */
  _paddleCollide(i) {
    const s = this.state, pv = this.padVel;
    const px = s[E_PAD0_X + i * 2], py = s[E_PAD0_Y + i * 2];
    const dx = s[E_PUCK_X] - px, dy = s[E_PUCK_Y] - py;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R_CONTACT * R_CONTACT || d2 === 0) return;

    const d = Math.sqrt(d2);
    const nx = dx / d, ny = dy / d;

    // relative approach speed along the contact normal
    const puckVn = s[E_PUCK_VX] * nx + s[E_PUCK_VY] * ny;
    const padVn = pv[i * 2] * nx + pv[i * 2 + 1] * ny;
    const rel = puckVn - padVn;               // < 0 while approaching

    if (rel < 0) {
      const strength = Math.min(1, -rel / 1600);
      // reflect off the paddle, keep tangential component, add hit boost
      const newVn = padVn - rel * 0.98 + CONFIG.PADDLE_MAX_HIT_BOOST * strength;
      const tanX = s[E_PUCK_VX] - puckVn * nx;
      const tanY = s[E_PUCK_VY] - puckVn * ny;
      let vx = tanX + nx * newVn;
      let vy = tanY + ny * newVn;

      const sp2 = vx * vx + vy * vy;
      if (sp2 > SPEED2_CAP) {
        const k = CONFIG.PUCK_MAX_SPEED / Math.sqrt(sp2);
        vx *= k; vy *= k;
      }
      s[E_PUCK_VX] = vx; s[E_PUCK_VY] = vy;

      const ev = this._push('paddleHit');
      if (ev) {
        ev.player = i;
        ev.x = s[E_PUCK_X]; ev.y = s[E_PUCK_Y];
        ev.strength = strength;
      }

      // a fresh hit un-sticks the puck
      this.stuckTime = 0;
    }

    // positional separation (always — prevents overlap oscillation)
    s[E_PUCK_X] = px + nx * (R_CONTACT + 0.5);
    s[E_PUCK_Y] = py + ny * (R_CONTACT + 0.5);
  }

  /** goal scored INTO side's goal; scorer = the other player */
  _goal(side) {
    this.frozen = true;
    const s = this.state;
    s[E_PUCK_VX] = 0; s[E_PUCK_VY] = 0;
    this.stuckTime = 0;
    this.nudgeHold = false;
    const ev = this._push('goal');
    if (ev) { ev.scorer = 1 - side; }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Stuck-puck auto-nudge with nudgeHold stand-down                    */
  /* ------------------------------------------------------------------ */

  /** is a paddle hovering within NUDGE_HOVER_PAD of the puck? */
  _hoverNear() {
    const s = this.state;
    const limit = R_CONTACT + CONFIG.NUDGE_HOVER_PAD;
    let best = Infinity, bestI = 0;
    for (let i = 0; i < 2; i++) {
      const dx = s[E_PUCK_X] - s[E_PAD0_X + i * 2];
      const dy = s[E_PUCK_Y] - s[E_PAD0_Y + i * 2];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) { best = d; bestI = i; }
    }
    this._nearPaddle = bestI;
    return best <= limit;
  }

  _updateStuck(dt) {
    const s = this.state;
    const v2 = s[E_PUCK_VX] * s[E_PUCK_VX] + s[E_PUCK_VY] * s[E_PUCK_VY];
    const th2 = CONFIG.PUCK_STUCK_MIN_SPEED * CONFIG.PUCK_STUCK_MIN_SPEED;

    if (v2 >= th2 * 4) {
      // comfortably moving: clean full reset of the stuck machinery
      this.stuckTime = 0;
      this.nudgeHold = false;
      return;
    }
    if (v2 < th2) this.stuckTime += dt;
    if (this.stuckTime < CONFIG.PUCK_STUCK_TIME) return;

    if (this._hoverNear()) {
      // paddle hovering the puck: stand down cleanly and HOLD (no nudge,
      // timers parked at the threshold until the hover clears)
      this.nudgeHold = true;
      this.stuckTime = CONFIG.PUCK_STUCK_TIME;
      return;
    }

    this.nudgeHold = false;

    // fire: push away from the nearer paddle (=> toward open table)
    const ang = this._nearPaddle === 0
      ? Math.atan2(s[E_PUCK_Y] - s[E_PAD0_Y], s[E_PUCK_X] - s[E_PAD0_X])
      : Math.atan2(s[E_PUCK_Y] - s[E_PAD1_Y], s[E_PUCK_X] - s[E_PAD1_X]);
    const a2 = ang + (Math.random() - 0.5) * 0.8;
    const sp = CONFIG.PUCK_NUDGE_SPEED * this.speedMult;
    s[E_PUCK_VX] = sp * Math.cos(a2);
    s[E_PUCK_VY] = sp * Math.sin(a2);
    this.stuckTime = 0;

    const ev = this._push('nudge');
    if (ev) { ev.x = s[E_PUCK_X]; ev.y = s[E_PUCK_Y]; }
  }

  /* ------------------------------------------------------------------ */
  /* Public step — call once per FIXED_DT with normalized targets       */
  /* ------------------------------------------------------------------ */

  update(dt, targets) {
    this._stepPaddles(dt, targets);

    if (this.frozen) return;

    const s = this.state;
    const speed = Math.sqrt(s[E_PUCK_VX] * s[E_PUCK_VX] + s[E_PUCK_VY] * s[E_PUCK_VY]);

    // anti-tunneling: split the step's travel into up to N sub-chunks
    const travel = speed * dt;
    const sub = Math.min(CONFIG.PUCK_SUBSTEP_MAX,
      Math.max(1, Math.ceil(travel / (R_PUCK * 0.9))));
    const h = dt / sub;

    this._flip = 0;
    for (let k = 0; k < sub; k++) {
      if (this._puckSubChunk(h)) return;   // goal (or frozen) ends the step
    }

    // wall-hit audio/fx event (at most one per fixed step)
    if (this._flip) {
      const sp = Math.hypot(s[E_PUCK_VX], s[E_PUCK_VY]);
      const ev = this._push('wallHit');
      if (ev) {
        ev.x = this._fx; ev.y = this._fy;
        ev.strength = Math.min(1, sp / CONFIG.PUCK_MAX_SPEED);
      }
      this._flip = 0;
    }

    // friction applies once per fixed step (tuning semantics independent
    // of the number of sub-chunks taken)
    s[E_PUCK_VX] *= CONFIG.PUCK_FRICTION;
    s[E_PUCK_VY] *= CONFIG.PUCK_FRICTION;

    this._updateStuck(dt);
  }
}

if (typeof window !== 'undefined') {
  window.PhysicsWorld = PhysicsWorld;
}
