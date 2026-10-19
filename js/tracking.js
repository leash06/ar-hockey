/**
 * tracking.js
 * ==========================================================================
 * HOCKEY-AR rebuild — hand tracking manager built on MediaPipe Hands.
 *
 * Responsibilities
 *  - owns the <video> element + camera stream (camera_utils or fallback;
 *    the fallback requests frameRate {ideal: 60, min: 30} to minimize
 *    motion blur on fast swings)
 *  - runs MediaPipe Hands on every camera packet
 *  - SINGLE-POINT ANCHOR: the hand is ONE coordinate — landmark 9 (base
 *    of the middle finger / palm center), fallback landmark 0 (wrist).
 *    No multi-joint averaging: fingertip jitter and loop overhead gone.
 *  - MIRRORS x coordinates so control feels like a mirror
 *  - assigns each hand to Player 1 / Player 2 by which half of the video
 *    it sits in (left/right default, top/bottom in 'tb' orientation)
 *  - smooths every hand through a One Euro Filter with a high beta
 *    (velocity-adaptive, zero-lag on fast strikes) and maps it into
 *    normalized TABLE coordinates, clamped to the player's own half
 *  - PURE 2D BOUNDS: hands are tracked as (x, y) only; anything outside
 *    [BOUNDS_MIN..BOUNDS_MAX] is flagged isOutOfBounds. All Z-depth
 *    ("hand too close / too far") heuristics were removed.
 *  - SHORT-FRAME DEAD RECKONING: 1–3 dropped packets (motion blur) coast
 *    the paddle along its last velocity vector instead of freezing.
 *  - lostFrames streak: a packet drop counter. If no tracking packet
 *    arrives for FILTER_DROP_RESET_FRAMES consecutive update() calls
 *    (stalled webcam / stalled inference), every filter is FULLY reset so
 *    stale filter state can't cause a teleport on re-entry.
 *  - exposes per-player state: raw / target / smooth, vel, isOutOfBounds,
 *    isLost, lastSeen — plus markers for the renderer and a hand-driven
 *    menu cursor for the start screen.
 *
 * Normalized coordinates: x, y in [0..1] for both video and table space.
 * ==========================================================================
 */

/* ------------------------------------------------------------------ */
/* One Euro Filter (Casiez et al.) — adaptive cutoff, minimal lag      */
/* ------------------------------------------------------------------ */

class _Lowpass {
  constructor() { this.y = null; }

  /** @param {number} a smoothing alpha (0..1) */
  filter(x, a) {
    if (this.y === null) { this.y = x; return x; }
    this.y += a * (x - this.y);
    return this.y;
  }
}

class OneEuroFilter2D {
  /**
   * @param {object} params LIVE shared reference {minCutoff, beta, dCutoff}
   *        (slider updates mutate this object in place — filters pick it
   *        up without rebuilding)
   */
  constructor(params) {
    this.p = params;
    this.x = 0; this.y = 0;
    this._resetState();
  }

  _resetState() {
    this.fx = new _Lowpass(); this.fy = new _Lowpass();
    this.fdx = new _Lowpass(); this.fdy = new _Lowpass();
    this.rawX = null; this.rawY = null;
  }

  /** snap the filter to a point (re-acquisition / teleport-like jumps) */
  reset(x, y) {
    this.x = x; this.y = y;
    this._resetState();
  }

  static _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /**
   * @returns {{x:number, y:number, vx:number, vy:number}} filtered position
   *          and velocity estimate (normalized units / second)
   */
  update(x, y, dt) {
    if (!(dt > 0)) dt = CONFIG.PACKET_DT_FALLBACK;

    // velocity from consecutive RAW positions, then low-passed
    if (this.rawX === null) { this.rawX = x; this.rawY = y; }
    const dx = (x - this.rawX) / dt, dy = (y - this.rawY) / dt;
    this.rawX = x; this.rawY = y;

    const aD = OneEuroFilter2D._alpha(this.p.dCutoff, dt);
    const edx = this.fdx.filter(dx, aD);
    const edy = this.fdy.filter(dy, aD);
    const speed = Math.hypot(edx, edy);

    // fast motion -> adaptive cutoff rises -> minimal lag
    const cutoff = this.p.minCutoff + this.p.beta * speed;
    const a = OneEuroFilter2D._alpha(cutoff, dt);

    const nx = this.fx.filter(x, a);
    const ny = this.fy.filter(y, a);
    this.x = nx; this.y = ny;

    return { x: nx, y: ny, vx: edx, vy: edy };
  }

  get value() { return { x: this.x, y: this.y }; }
}

/* ------------------------------------------------------------------ */
/* TrackingManager                                                     */
/* ------------------------------------------------------------------ */

const TrackingManager = (() => {

  /* ---------------------------- state ------------------------------ */

  let videoEl = null;
  let hands = null;            // MediaPipe Hands instance
  let cameraUtil = null;       // @mediapipe/camera_utils wrapper (optional)
  let stream = null;           // raw MediaStream when using the fallback
  let fallbackRafId = 0;
  let sending = false;         // prevents overlapping MediaPipe invocations
  let running = false;

  let smoothing = CONFIG.DEFAULT_SMOOTHING;
  let orientation = CONFIG.DEFAULT_ORIENTATION;   // 'lr' | 'tb'

  // packet-drop protection
  let packetId = 0;            // bumped on every MediaPipe callback
  let lastSeenPacketId = 0;
  let lostFrames = 0;          // consecutive updates with no fresh packet
  let lastResultsTime = 0;
  let onError = null;          // optional error callback

  /* LIVE One Euro params — shared by every filter. */
  const filterParams = {
    minCutoff: 1.8,
    beta: CONFIG.FILTER_BETA,
    dCutoff: CONFIG.FILTER_DC_CUTOFF,
  };

  /* Renderer markers: raw mirrored hand points + out-of-bounds flag.
     Reused array — cleared per packet, never reallocated per-run. */
  const markers = [];

  /* Hand-driven menu cursor (start screen), mirrored normalized coords. */
  const menuCursor = {
    seen: false,
    x: 0.5, y: 0.5,
    rawX: 0.5, rawY: 0.5,
    pinch: false,
    palmSize: 0,
  };

  /* Raw mirrored hands for skeleton overlays: preallocated 21 x/y pairs. */
  const handPool = [new Float32Array(42), new Float32Array(42)];
  let handPoolCount = 0;

  function makePlayer(hx, hy) {
    const filter = new OneEuroFilter2D(filterParams);
    filter.reset(hx, hy);
    return {
      home: { x: hx, y: hy },
      present: false,
      lastSeen: 0,
      raw: { x: hx, y: hy },    // latest raw mirrored video coords
      target: { x: hx, y: hy }, // clamped normalized table coords target
      smooth: { x: hx, y: hy }, // interpolated position (paddle follows)
      vel: { x: 0, y: 0 },      // normalized velocity (units / second)

      // dual-packet timestamped anchors (sub-frame interpolation):
      // previous + current One-Euro-filtered anchor, with perf.now stamps
      prevAnchor: { x: hx, y: hy, t: 0 },
      targetAnchor: { x: hx, y: hy, t: 0 },

      dropFrames: 0,            // consecutive packet-less updates
      isOutOfBounds: false,     // hand outside [BOUNDS_MIN..BOUNDS_MAX]
      isLost: false,            // no landmarks detected in this player's region
      filter,
      oobHyst: false,           // sticky OOB flag (hysteresis vs flicker)
    };
  }

  const players = [makePlayer(0.25, 0.5), makePlayer(0.75, 0.5)];

  /* --------------------------- helpers ----------------------------- */

  function tableSize(or) {
    const tall = or === 'tb';
    return {
      W: tall ? CONFIG.TABLE_H : CONFIG.TABLE_W,
      H: tall ? CONFIG.TABLE_W : CONFIG.TABLE_H,
      tall,
    };
  }

  /**
   * SINGLE-POINT ANCHOR: the hand IS one point — landmark 9 (base of the
   * middle finger / palm center), falling back to landmark 0 (wrist).
   * No multi-joint looping/averaging: fingertip jitter and per-frame
   * loop overhead are eliminated at the source.
   */
  function controlPoint(lm) {
    const p = lm[CONFIG.ANCHOR_LANDMARK] ||
              lm[CONFIG.ANCHOR_FALLBACK_LANDMARK] || lm[0];
    return p;
  }

  /**
   * Map a mirrored, normalized video point to normalized TABLE coords,
   * clamped to the player's own half.
   * @returns {{side:number, tx:number, ty:number}}
   */
  function mapToTable(mirX, y) {
    const { W, H, tall } = tableSize(orientation);
    const mX = (CONFIG.PADDLE_RADIUS + 6) / W;
    const mY = (CONFIG.PADDLE_RADIUS + 6) / H;
    const cl = (v, a, b) => v < a ? a : (v > b ? b : v);

    if (!tall) {
      // video x: [0..0.5] = P1 (left half of the table)
      const side = mirX < 0.5 ? 0 : 1;
      const tx = side === 0
        ? cl(mirX, mX, 0.5 - mX)
        : cl(mirX, 0.5 + mX, 1 - mX);
      return { side, tx, ty: cl(y, mY, 1 - mY) };
    }

    // video y: bottom half [0.5..1] = P1 (bottom of the table)
    const side = y > 0.5 ? 0 : 1;
    const tx = cl(mirX, mX, 1 - mX);
    const ty = side === 0
      ? cl(y, 0.5 + mY, 1 - mY)
      : cl(y, mY, 0.5 - mY);
    return { side, tx, ty };
  }

  /* ---- pure 2D bounds (no depth heuristics) ------------------------ */

  function checkOutOfBounds(mirX, y) {
    const lo = CONFIG.BOUNDS_MIN, hi = CONFIG.BOUNDS_MAX;
    return mirX < lo || mirX > hi || y < lo || y > hi;
  }

  /** sticky flag release so the warning doesn't flicker at the threshold */
  function updateOobFlag(p, mirX, y) {
    const lo = CONFIG.BOUNDS_MIN, hi = CONFIG.BOUNDS_MAX;
    const clearLo = lo + 0.02, clearHi = hi - 0.02;
    if (p.oobHyst) {
      p.oobHyst = !(mirX > clearLo && mirX < clearHi &&
                    y > clearLo && y < clearHi);
    } else {
      p.oobHyst = checkOutOfBounds(mirX, y);
    }
    p.isOutOfBounds = p.oobHyst;
  }

  /**
   * The player's hand disappeared completely: freeze the paddle at the
   * last valid safe position, zero velocity, flag lost + out of bounds.
   * Idempotent — stays cheap while the hand stays gone.
   */
  function markLost(p) {
    const wasPresent = p.present;
    p.present = false;
    p.vel.x = 0; p.vel.y = 0;
    p.isLost = true;
    p.isOutOfBounds = true;
    if (wasPresent) {
      // pull the sample inward from the frame edge so the frozen paddle
      // rests somewhere reachable instead of hugging the boundary
      const m = Math.max(CONFIG.BOUNDS_MIN + 0.01, 0.06);
      const sx = Math.min(Math.max(p.raw.x, m), 1 - m);
      const sy = Math.min(Math.max(p.raw.y, m), 1 - m);
      const t = mapToTable(sx, sy);
      p.target.x = t.tx; p.target.y = t.ty;
      p.smooth.x = t.tx; p.smooth.y = t.ty;
    }
  }

  /** full filter flush (stalled stream / drop streak exceeded) */
  function resetAllFilters() {
    for (const p of players) {
      p.present = false;
      p.isLost = true;
      p.isOutOfBounds = true;
      p.vel.x = 0; p.vel.y = 0;
      p.raw.x = p.home.x; p.raw.y = p.home.y;
      p.filter.reset(p.home.x, p.home.y);
      // flush interpolation anchors (stale timestamps must not glide)
      p.prevAnchor.x = p.home.x; p.prevAnchor.y = p.home.y; p.prevAnchor.t = 0;
      p.targetAnchor.x = p.home.x; p.targetAnchor.y = p.home.y; p.targetAnchor.t = 0;
    }
    menuCursor.seen = false;
    menuCursor.pinch = false;
    handPoolCount = 0;
  }

  /* ------------------ menu cursor / skeleton pool ------------------- */

  /**
   * Update the menu hand-cursor from the first detected hand:
   * - cursor = index fingertip in mirrored coords, lightly lerped
   * - pinch  = index-thumb gap normalized by the wrist->middle-MCP palm
   *            length (single vector — no multi-joint bbox loops)
   */
  function updateMenuCursor(landmarks) {
    if (!landmarks.length) {
      menuCursor.seen = false;
      menuCursor.pinch = false;
      return;
    }
    const lm = landmarks[0];
    if (!lm || lm.length < 18) { menuCursor.seen = false; menuCursor.pinch = false; return; }

    const tip = lm[8];
    const rawX = 1 - tip.x;                 // mirror x like every coordinate
    const rawY = tip.y;

    if (!menuCursor.seen) { menuCursor.rawX = rawX; menuCursor.rawY = rawY; }
    menuCursor.x += (rawX - menuCursor.x) * 0.45;
    menuCursor.y += (rawY - menuCursor.y) * 0.45;
    menuCursor.rawX = rawX; menuCursor.rawY = rawY;

    // palm length = wrist -> middle-finger MCP (one vector, zero loops)
    const palmLen = Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y);
    menuCursor.palmSize = palmLen;

    // pinch: gap normalized by palm length, with release buffering
    const thumb = lm[4];
    const d = Math.hypot(thumb.x - tip.x, thumb.y - tip.y) /
              Math.max(0.02, palmLen);
    if (menuCursor.pinch) {
      if (d > 0.55) menuCursor.pinch = false;
    } else if (d < 0.35) {
      menuCursor.pinch = true;
    }

    menuCursor.seen = true;
  }

  /** fill the preallocated mirrored hand pool for skeleton drawing */
  function fillRawHands(landmarks) {
    handPoolCount = Math.min(landmarks.length, 2);
    for (let h = 0; h < handPoolCount; h++) {
      const lm = landmarks[h];
      if (!lm || lm.length < 21) { handPoolCount--; continue; }
      const dst = handPool[h];
      for (let i = 0; i < 21; i++) {
        dst[i * 2] = 1 - lm[i].x;          // mirror x
        dst[i * 2 + 1] = lm[i].y;
      }
    }
  }

  /* ------------------- MediaPipe results handling ------------------- */

  function onResults(results) {
    packetId++;
    lastResultsTime = performance.now();

    let dt = (lastResultsTime - (onResults._t || lastResultsTime)) / 1000;
    onResults._t = lastResultsTime;
    if (!(dt > 0.005)) dt = CONFIG.PACKET_DT_FALLBACK;
    dt = Math.min(dt, 0.2);

    const landmarks = results.multiHandLandmarks || [];
    markers.length = 0;

    updateMenuCursor(landmarks);
    fillRawHands(landmarks);

    // candidates: {side, tx, ty, mirX, y}
    const candidates = [];
    for (const lm of landmarks) {
      if (!lm || lm.length < 18) continue;
      const pt = controlPoint(lm);
      const mirX = 1 - pt.x;
      const oob = checkOutOfBounds(mirX, pt.y);
      markers.push({ x: mirX, y: pt.y, oob });
      candidates.push(Object.assign({ mirX, y: pt.y }, mapToTable(mirX, pt.y)));
    }

    // assign candidate to each player side (nearest to last raw position)
    for (let side = 0; side < 2; side++) {
      let best = null, bestD = Infinity;
      for (const c of candidates) {
        if (c.side !== side) continue;
        const p = players[side];
        const d = (c.tx - p.target.x) ** 2 + (c.ty - p.target.y) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      const p = players[side];
      if (best) {
        const wasAbsent = !p.present;

        // teleport-like jump or fresh acquisition -> snap the filter
        const jump = Math.hypot(best.mirX - p.raw.x, best.y - p.raw.y);
        if (wasAbsent || jump > CONFIG.FILTER_JUMP_RESET_DIST) {
          p.filter.reset(best.mirX, best.y);
          p.vel.x = 0; p.vel.y = 0;
        }
        const f = p.filter.update(best.mirX, best.y, dt);
        const mapped = mapToTable(f.x, f.y);

        // clamp glitch spikes so they can't feed huge impulses
        p.vel.x = Math.max(-8, Math.min(8, f.vx));
        p.vel.y = Math.max(-8, Math.min(8, f.vy));

        p.target.x = mapped.tx; p.target.y = mapped.ty;
        p.smooth.x = mapped.tx; p.smooth.y = mapped.ty;
        p.raw.x = best.mirX; p.raw.y = best.y;

        // dual-packet anchor shift: current -> previous, filtered -> current
        // (timestamps power the sub-frame interpolation in update())
        const pa = p.prevAnchor, ta = p.targetAnchor;
        pa.x = ta.x; pa.y = ta.y; pa.t = ta.t;
        ta.x = f.x; ta.y = f.y; ta.t = lastResultsTime;
        p.dropFrames = 0;

        updateOobFlag(p, best.mirX, best.y);
        p.isLost = false;
        p.present = true;
        p.lastSeen = lastResultsTime;
      } else {
        markLost(p);
      }
    }
  }

  /* ------------------------ per-frame update ------------------------

     Called from the main (fixed-step) engine loop (60/120 Hz), while
     webcam packets arrive asynchronously at ~30 Hz. Two mechanisms:

     1. SUB-FRAME INTERPOLATION — every tick, each present paddle's
        position is interpolated between the last two timestamped anchor
        packets (alpha = 1 exactly at packet arrival → zero added
        latency), with the lookahead capped at INTERP_MAX_ALPHA (1.5) so
        a late packet never overshoots. This glides the paddle across
        every engine tick — no visual stepping, no micro-stutter.

     2. STALL FLUSH — if no packet arrives for FILTER_DROP_RESET_FRAMES
        consecutive updates, every One Euro filter is fully reset so no
        stale state can teleport the paddle on re-entry.

     Momentum coasting (previous packet's velocity vector) takes over
     past the lookahead cap, and past DEAD_RECKON_MAX_MS the hand is
     marked lost. ----------------------------------------------------- */

  /** shared scratch — zero allocation (pass a private `out` if reentrancy) */
  const _interpOut = { x: 0, y: 0, alpha: 0 };

  /**
   * Interpolated anchor for a player at engine time `nowMs`.
   * alpha = 1 + (now - tCur)/span: 1 exactly at packet arrival (zero
   * latency), extrapolating along the prev->curr segment up to
   * INTERP_MAX_ALPHA; past the cap, momentum-coast on p.vel until the
   * dead-reckon window closes. Writes into `out` (default shared scratch).
   */
  function getInterpolatedAnchor(p, nowMs, out) {
    const o = out || _interpOut;
    const cur = p.targetAnchor, prv = p.prevAnchor;
    const span = cur.t - prv.t;

    // single packet so far (or clock anomaly): hold the current anchor
    if (!(span > 0) || !(nowMs >= cur.t)) {
      o.x = cur.x; o.y = cur.y; o.alpha = 0;
      return o;
    }

    const alpha = 1 + (nowMs - cur.t) / span;
    if (alpha <= CONFIG.INTERP_MAX_ALPHA) {
      // controlled lookahead: glide along the last camera segment
      o.x = prv.x + (cur.x - prv.x) * alpha;
      o.y = prv.y + (cur.y - prv.y) * alpha;
    } else {
      // momentum coast past the lookahead (dead reckoning)
      const tSec = (nowMs - cur.t) / 1000;
      o.x = cur.x + p.vel.x * tSec;
      o.y = cur.y + p.vel.y * tSec;
    }
    o.alpha = alpha;
    return o;
  }

  function update() {
    const now = performance.now();

    if (packetId !== lastSeenPacketId) {
      // fresh packet arrived since the last update — stream is healthy
      lastSeenPacketId = packetId;
      lostFrames = 0;
      for (const p of players) p.dropFrames = 0;
    } else {
      lostFrames++;
    }

    const sinceMs = now - lastResultsTime;
    if (sinceMs <= CONFIG.DEAD_RECKON_MAX_MS) {
      // sub-frame interpolation every engine tick — the paddle glides
      // through the 30 Hz packet gaps at full 60/120 Hz refresh
      for (const p of players) {
        if (!p.present) continue;
        getInterpolatedAnchor(p, now, _interpOut);
        const mapped = mapToTable(_interpOut.x, _interpOut.y);
        p.target.x = mapped.tx; p.target.y = mapped.ty;
        p.smooth.x = mapped.tx; p.smooth.y = mapped.ty;
        p.raw.x = _interpOut.x; p.raw.y = _interpOut.y;
        p.isLost = false;
      }
    } else {
      // longer than the grace window: mark lost (freeze at safe spot)
      for (const p of players) { p.dropFrames++; markLost(p); }
    }

    if (lostFrames > CONFIG.FILTER_DROP_RESET_FRAMES) {
      // stream stalled: flush all filter state so no teleport/float on
      // re-entry, then wait for the next healthy packet
      resetAllFilters();
      lostFrames = 0;
      lastSeenPacketId = packetId;
    }

    // lost hands: hard-zero velocity every frame (no ghost momentum)
    for (const p of players) {
      if (!p.present) { p.vel.x = 0; p.vel.y = 0; }
    }
  }

  /* ---------------------- camera lifecycle -------------------------- */

  async function start() {
    if (running) return;
    if (typeof Hands === 'undefined') {
      throw new Error('MediaPipe Hands failed to load (no internet or CDN blocked).');
    }

    hands = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });
    hands.setOptions({
      maxNumHands: CONFIG.TRACK_MAX_HANDS,
      modelComplexity: CONFIG.TRACK_MODEL_COMPLEXITY,
      minDetectionConfidence: CONFIG.TRACK_MIN_DETECTION_CONF,
      minTrackingConfidence: CONFIG.TRACK_MIN_TRACKING_CONF,
      selfieMode: false, // we mirror coordinates ourselves
    });
    hands.onResults(onResults);

    if (typeof Camera !== 'undefined') {
      cameraUtil = new Camera(videoEl, {
        onFrame: async () => {
          if (!sending && videoEl.readyState >= 2) {
            sending = true;
            try { await hands.send({ image: videoEl }); }
            finally { sending = false; }
          }
        },
        width: CONFIG.CAMERA_WIDTH,
        height: CONFIG.CAMERA_HEIGHT,
        facingMode: 'user',
      });
      try {
        await cameraUtil.start();
      } catch (err) {
        cameraUtil = null;
        await startFallbackCamera();
      }
    } else {
      await startFallbackCamera();
    }

    running = true;
  }

  /* Fallback: raw getUserMedia + rAF loop feeding hands.send().
     Explicitly requests a high frame rate (ideal 60, min 30) to minimize
     motion blur on high-speed hand motions. */
  async function startFallbackCamera() {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: CONFIG.CAMERA_WIDTH },
        height: { ideal: CONFIG.CAMERA_HEIGHT },
        frameRate: { ideal: 60, min: 30 },
      },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();

    const loop = async () => {
      if (!stream || !hands) return;
      if (!sending && videoEl.readyState >= 2) {
        sending = true;
        try { await hands.send({ image: videoEl }); }
        finally { sending = false; }
      }
      fallbackRafId = requestAnimationFrame(loop);
    };
    fallbackRafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (fallbackRafId) { cancelAnimationFrame(fallbackRafId); fallbackRafId = 0; }
    if (cameraUtil) { try { cameraUtil.stop(); } catch (e) { /* noop */ } cameraUtil = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    resetAllFilters();
  }

  /* --------------------------- public API --------------------------- */

  return {
    init(video, errCb) { videoEl = video; onError = errCb; },

    start, stop, update,

    getPlayers: () => players,
    getMarkers: () => markers,
    getVideo: () => videoEl,
    isRunning: () => running,

    /** monotonically increasing id of the last processed tracking packet
     *  (consumers latch camera frames on fresh packets only) */
    getPacketId: () => packetId,

    /** sub-frame interpolated anchor for player i at engine time `nowMs`
     *  (default: performance.now()) — writes {x, y, alpha} into `out`
     *  (default: shared scratch, zero-alloc), mirrored video coords.
     *  alpha = 1 at packet arrival, lookahead capped at INTERP_MAX_ALPHA.
     *  update() already feeds this into players[i].smooth every tick, so
     *  physics glides at 60/120 Hz from 30 Hz packets with no extra calls. */
    getInterpolatedAnchor(i, nowMs, out) {
      return getInterpolatedAnchor(players[i],
        nowMs == null ? performance.now() : nowMs, out);
    },

    /** menu hand-cursor state {seen, x, y, pinch, palmSize} */
    getMenuCursor: () => menuCursor,
    /** raw mirrored hands for skeleton drawing: {pairs, count} */
    getRawHands: () => ({ pairs: handPool, count: handPoolCount }),

    checkOutOfBounds,

    /** test hook: feed a synthetic MediaPipe results packet (probes) */
    _onResults: onResults,

    /** ms since player i's hand was seen */
    absentMs(i) {
      return players[i].present ? 0 : (performance.now() - players[i].lastSeen);
    },
    /** ms since the required hands were seen (auto-pause source) */
    bothAbsentMs() {
      return Math.max(this.absentMs(0), this.absentMs(1));
    },

    /** @param {number} s 0..1 — remaps the One Euro base cutoff live */
    setSmoothing(s) {
      smoothing = Math.max(0, Math.min(1, s));
      const lo = CONFIG.FILTER_MIN_CUTOFF_MIN;
      const hi = CONFIG.FILTER_MIN_CUTOFF_MAX;
      filterParams.minCutoff = lo + (hi - lo) * (1 - smoothing);
      filterParams.beta = CONFIG.FILTER_BETA;
      filterParams.dCutoff = CONFIG.FILTER_DC_CUTOFF;
    },

    setOrientation(o) {
      orientation = o === 'tb' ? 'tb' : 'lr';
      const tall = orientation === 'tb';
      // mapping semantics changed — snap everyone to their new home half
      players[0].home.x = tall ? 0.5 : 0.25; players[0].home.y = tall ? 0.75 : 0.5;
      players[1].home.x = tall ? 0.5 : 0.75; players[1].home.y = tall ? 0.25 : 0.5;
      for (const p of players) {
        p.filter.reset(p.present ? p.raw.x : p.home.x,
                       p.present ? p.raw.y : p.home.y);
      }
    },
    getOrientation: () => orientation,
  };
})();

if (typeof window !== 'undefined') {
  window.TrackingManager = TrackingManager;
}
