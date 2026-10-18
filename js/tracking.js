/**
 * tracking.js
 * ==========================================================================
 * Hand tracking manager built on MediaPipe Hands.
 *
 * Responsibilities
 *  - owns the <video> element + camera stream (camera_utils or fallback)
 *  - runs MediaPipe Hands on every frame
 *  - MIRRORS x coordinates so it feels like a mirror
 *  - assigns each hand to Player 1 / Player 2 by which half of the video
 *    it is in (left/right by default, top/bottom for 'tb' orientation)
 *  - smooths each hand through a One Euro Filter (velocity-adaptive,
 *    low-latency — kills jitter without adding lag on fast swings)
 *  - maps hand position into *normalized table coordinates* for the player's
 *    own half only (clamped — a hand can never cross the center line)
 *  - computes a velocity vector per player so fast swings hit harder
 *  - depth tracking: palm bounding-box size (spread of landmarks) drives
 *    "too far / too close" accuracy warnings
 *  - boundary warnings: hand too close to a video-frame edge
 *  - exposes per-player state flags: isOutOfBounds, isTooFarOrClose,
 *    palmSize, depthState
 *  - tracks "last seen" time per player so the game can (a) freeze a paddle,
 *    (b) show hints, (c) auto-pause after CONFIG.MISSING_HAND_TIMEOUT
 *
 * Normalized coordinates: x,y in [0..1] for both video and table spaces.
 * ==========================================================================
 */

/* ------------------------------------------------------------------ */
/* One Euro Filter (Casiez et al.) — adaptive cutoff, minimal lag      */
/* ------------------------------------------------------------------ */

class _Lowpass {
  constructor(alpha) { this.y = null; }

  /** @param {number} a smoothing alpha (0..1) */
  filter(x, a) {
    if (this.y === null) { this.y = x; return x; }
    this.y += a * (x - this.y);
    return this.y;
  }
}

class OneEuroFilter2D {
  /**
   * @param {object} params shared reference {minCutoff, beta, dCutoff}
   *        (must stay in sync with the smoothing slider -> pass the live
   *        TrackingManager params object, not a copy)
   */
  constructor(params) {
    this.p = params;
    this._resetState();
  }

  _resetState() {
    this.fx = new _Lowpass(); this.fy = new _Lowpass();
    this.fdx = new _Lowpass(); this.fdy = new _Lowpass();
    this.rawX = null; this.rawY = null; // last RAW input (for velocity calc)
  }

  /** snap the filter to a point (after teleport-like jumps / re-acquire) */
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
    if (!(dt > 0)) throw new Error('OneEuroFilter2D: dt must be > 0');

    // velocity estimate from consecutive RAW positions, then low-passed
    // (avoids the inflation you get when differentiating against the
    // already-lagging filtered position)
    if (this.rawX === null) { this.rawX = x; this.rawY = y; }
    const dx = (x - this.rawX) / dt, dy = (y - this.rawY) / dt;
    this.rawX = x; this.rawY = y;

    const aD = OneEuroFilter2D._alpha(this.p.dCutoff, dt);
    const edx = this.fdx.filter(dx, aD);
    const edy = this.fdy.filter(dy, aD);
    const speed = Math.hypot(edx, edy);

    // adaptive cutoff: fast motion -> high cutoff -> minimal lag
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
/* TrackingManager                                                    */
/* ------------------------------------------------------------------ */

const TrackingManager = (() => {

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */

  let videoEl = null;
  let hands = null;            // MediaPipe Hands instance
  let cameraUtil = null;       // @mediapipe/camera_utils wrapper (optional)
  let stream = null;           // raw MediaStream when using the fallback path
  let fallbackRafId = 0;
  let sending = false;         // prevents overlapping MedaPipe inference calls
  let running = false;
  let onError = null;          // callback(error: Error)

  let smoothing = CONFIG.DEFAULT_SMOOTHING; // 0 (raw) .. 1 (very smooth)
  let orientation = CONFIG.DEFAULT_ORIENTATION; // 'lr' | 'tb'
  let lastResultsTime = 0;     // perf.now of last MediaPipe callback

  /* Live One Euro params — shared by every filter (slider updates apply
     instantly to all filters without rebuilding them). */
  const filterParams = { minCutoff: 1.8, beta: CONFIG.FILTER_BETA, dCutoff: CONFIG.FILTER_DC_CUTOFF };

  /* Markers for the renderer: raw mirrored hand points + warning flags */
  const markers = [];

  /* Menu hand-cursor state: first detected hand drives the pointer that
     walks the main menu. Kept in mirrored normalized video coords. */
  const menuCursor = {
    seen: false,        // was a hand detected in the last frame
    x: 0.5, y: 0.5,     // smoothed cursor position (mirrored, normalized)
    rawX: 0.5, rawY: 0.5,
    pinch: false,       // index fingertip closed onto the thumb
    palmSize: 0,        // bbox spread of the driving hand (depth proxy)
  };
  /* Raw mirrored hands for skeleton drawing (per-hand Float32Array of 21
     x,y pairs, preallocated — filled on each MediaPipe result). */
  const handPool = [new Float32Array(42), new Float32Array(42)];
  let handPoolCount = 0;

  const players = [makePlayer(0.25, 0.5), makePlayer(0.75, 0.5)];

  function makePlayer(tx, ty) {
    const filter = new OneEuroFilter2D(filterParams);
    filter.reset(tx, ty);
    return {
      present: false,
      lastSeen: 0,                  // perf.now when this hand was last detected
      raw: { x: tx, y: ty },        // latest raw mirrored video coords (for continuity)
      target: { x: tx, y: ty },     // clamped normalized table-coord target
      smooth: { x: tx, y: ty },     // filtered position (what the paddle follows)
      vel: { x: 0, y: 0 },          // normalized table units / second
      isOutOfBounds: false,         // hand near/at a video-frame edge
      isTooFarOrClose: false,       // hand outside the ideal depth range
      isLost: false,                // no landmarks detected in this player's region
      palmSize: 0,                  // landmark bbox spread (depth proxy)
      depthState: null,             // 'far' | 'close' | null
      filter,
      oobHyst: false,               // sticky helpers (hysteresis)
      depthHyst: null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  function tableSize(orientation) {
    const tall = orientation === 'tb';
    return {
      W: tall ? CONFIG.TABLE_H : CONFIG.TABLE_W,
      H: tall ? CONFIG.TABLE_W : CONFIG.TABLE_H,
      tall,
    };
  }

  /**
   * Control point + palm size.
   * - point: palm center (stable) or index fingertip
   * - size : max dimension of the landmark bounding box, normalized —
   *          a robust proxy for hand distance from the camera
   */
  function controlPoint(lm) {
    let sx0 = 1, sx1 = 0, sy0 = 1, sy1 = 0;
    for (const p of lm) {
      if (p.x < sx0) sx0 = p.x; if (p.x > sx1) sx1 = p.x;
      if (p.y < sy0) sy0 = p.y; if (p.y > sy1) sy1 = p.y;
    }
    const size = Math.max(sx1 - sx0, sy1 - sy0);

    let x, y;
    if (!CONFIG.USE_PALM_CENTER) {
      const tip = lm[CONFIG.FINGERTIP_LANDMARK] || lm[8];
      x = tip.x; y = tip.y;
    } else {
      // average of wrist + the four finger-base (MCP) joints = palm center
      const ids = [0, 5, 9, 13, 17];
      let ax = 0, ay = 0;
      for (const i of ids) { ax += lm[i].x; ay += lm[i].y; }
      x = ax / ids.length; y = ay / ids.length;
    }
    return { x, y, size };
  }

  /**
   * Map a mirrored, normalized video point to normalized TABLE coords,
   * restricted (clamped) to the player's own half.
   * @returns {{side:number, tx:number, ty:number}}
   */
  function mapToTable(mirX, y) {
    const { W, H, tall } = tableSize(orientation);
    const mX = (CONFIG.PADDLE_RADIUS + 6) / W;
    const mY = (CONFIG.PADDLE_RADIUS + 6) / H;
    const cl = (v, a, b) => v < a ? a : (v > b ? b : v);

    if (!tall) {
      // Players left/right. Video x: [0..0.5] = P1 (left half of table).
      const side = mirX < 0.5 ? 0 : 1;
      const tx = side === 0
        ? cl(mirX, mX, 0.5 - mX)
        : cl(mirX, 0.5 + mX, 1 - mX);
      const ty = cl(y, mY, 1 - mY);
      return { side, tx, ty };
    }

    // Players top/bottom. Video y: bottom half [0.5..1] = P1 (bottom of table).
    const side = y > 0.5 ? 0 : 1;
    const tx = cl(mirX, mX, 1 - mX);
    const ty = side === 0
      ? cl(y, 0.5 + mY, 1 - mY)
      : cl(y, mY, 0.5 - mY);
    return { side, tx, ty };
  }

  /* ---- accuracy helpers (public, hysteresis-free versions) ---------- */

  /** true if a mirrored video point is at/near a frame edge */
  function checkOutOfBounds(mirX, y) {
    const m = CONFIG.HAND_OUT_OF_BOUNDS_MARGIN;
    return mirX < m || mirX > 1 - m || y < m || y > 1 - m;
  }

  /** 'far' | 'close' | null — depth verdict from the palm bbox size */
  function checkDepth(palmSize) {
    if (palmSize < CONFIG.HAND_MIN_PALM_SIZE) return 'far';
    if (palmSize > CONFIG.HAND_MAX_PALM_SIZE) return 'close';
    return null;
  }

  /* ---- sticky (hysteresis) warnings to prevent flicker -------------- */

  function updateOobFlag(p, mirX, y) {
    const m = CONFIG.HAND_OUT_OF_BOUNDS_MARGIN;
    const clearMargin = Math.max(0.02, m - 0.04);
    if (p.oobHyst) {
      // release only once the hand is comfortably back inside
      p.oobHyst = !(mirX > clearMargin && mirX < 1 - clearMargin &&
                    y > clearMargin && y < 1 - clearMargin);
    } else {
      p.oobHyst = checkOutOfBounds(mirX, y);
    }
    p.isOutOfBounds = p.oobHyst;
  }

  function updateDepthFlag(p, palmSize) {
    const trigLo = CONFIG.HAND_MIN_PALM_SIZE;
    const trigHi = CONFIG.HAND_MAX_PALM_SIZE;
    // ~20% buffers so flags don't flicker at the threshold
    const clearLo = trigLo * 1.2, clearHi = trigHi * 0.8;

    if (p.depthHyst === 'far') {
      if (palmSize >= clearLo) p.depthHyst = null;
    } else if (p.depthHyst === 'close') {
      if (palmSize <= clearHi) p.depthHyst = null;
    } else {
      p.depthHyst = checkDepth(palmSize);
    }
    p.depthState = p.depthHyst;
    p.palmSize = palmSize;
    p.isTooFarOrClose = !!p.depthHyst;
  }

  /**
   * The player's hand completely disappeared (no landmarks for this side):
   * freeze the paddle at the last valid *safety* position, zero the velocity
   * instantly, and flag it lost + out of bounds.
   * Idempotent - repeats stay cheap while the hand stays gone.
   */
  function markLost(p) {
    const wasPresent = p.present;
    p.present = false;
    p.vel.x = 0; p.vel.y = 0;        // instant zero - no ghost momentum
    p.isLost = true;
    p.isOutOfBounds = true;          // gone off-screen is the extreme edge case
    if (wasPresent) {
      // pull the last sampled point inward from the frame edge so the frozen
      // paddle rests at a safe, reachable position instead of hovering at
      // (or beyond) the boundary
      const m = Math.max(CONFIG.HAND_OUT_OF_BOUNDS_MARGIN, 0.04);
      const sx = Math.min(Math.max(p.raw.x, m), 1 - m);
      const sy = Math.min(Math.max(p.raw.y, m), 1 - m);
      const t = mapToTable(sx, sy);
      p.target.x = t.tx; p.target.y = t.ty;
      p.smooth.x = t.tx; p.smooth.y = t.ty;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Menu cursor + raw skeleton helpers                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Update the menu hand-cursor from the first detected hand:
   * - cursor = index fingertip (lm[8]) in mirrored coords, lightly lerped
   * - pinch  = thumb tip (lm[4]) pulled close to the index tip, measured
   *            relative to palm size (scale-invariant), with hysteresis
   */
  function updateMenuCursor(landmarks) {
    if (!landmarks.length) {
      menuCursor.seen = false;
      menuCursor.pinch = false;   // rising-edge consumers rely on this reset
      return;
    }
    const lm = landmarks[0];
    if (!lm || lm.length < 18) { menuCursor.seen = false; menuCursor.pinch = false; return; }

    const tip = lm[8];
    const rawX = 1 - tip.x;       // mirror like every other coordinate
    const rawY = tip.y;

    // light smoothing — preciser motion is wanted here than for the paddle
    if (!menuCursor.seen) { menuCursor.rawX = rawX; menuCursor.rawY = rawY; }
    menuCursor.x += (rawX - menuCursor.x) * 0.45;
    menuCursor.y += (rawY - menuCursor.y) * 0.45;
    menuCursor.rawX = rawX; menuCursor.rawY = rawY;

    // palm size (bbox spread) of the driving hand
    let sx0 = 1, sx1 = 0, sy0 = 1, sy1 = 0;
    for (const p of lm) {
      if (p.x < sx0) sx0 = p.x; if (p.x > sx1) sx1 = p.x;
      if (p.y < sy0) sy0 = p.y; if (p.y > sy1) sy1 = p.y;
    }
    menuCursor.palmSize = Math.max(sx1 - sx0, sy1 - sy0);

    // pinch: index-thumb gap normalized by the hand's own size
    const thumb = lm[4];
    const d = Math.hypot(thumb.x - tip.x, thumb.y - tip.y) /
              Math.max(0.02, menuCursor.palmSize);
    if (menuCursor.pinch) {
      if (d > 0.62) menuCursor.pinch = false;   // release threshold (buffered)
    } else if (d < 0.45) {
      menuCursor.pinch = true;                  // engage threshold
    }

    menuCursor.seen = true;
  }

  /** Fill the preallocated raw-hand pool with mirrored copies for drawing. */
  function fillRawHands(landmarks) {
    handPoolCount = Math.min(landmarks.length, 2);
    for (let h = 0; h < handPoolCount; h++) {
      const lm = landmarks[h];
      if (!lm || lm.length < 21) { handPoolCount--; continue; }
      const dst = handPool[h];
      for (let i = 0; i < 21; i++) {
        dst[i * 2] = 1 - lm[i].x;               // mirror x
        dst[i * 2 + 1] = lm[i].y;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* MediaPipe results handling                                         */
  /* ------------------------------------------------------------------ */

  function onResults(results) {
    const now = performance.now();
    let dt = (now - lastResultsTime) / 1000;
    lastResultsTime = now;
    if (!(dt > 0.005)) dt = 0.033;
    dt = Math.min(dt, 0.2);

    const landmarks = results.multiHandLandmarks || [];
    markers.length = 0;

    // menu cursor + skeleton source (uses the raw, un-mirrored landmarks)
    updateMenuCursor(landmarks);
    fillRawHands(landmarks);

    // Collect candidates {side, tx, ty, mirX, y, size}
    const candidates = [];
    for (const lm of landmarks) {
      if (!lm || lm.length < 18) continue;
      const pt = controlPoint(lm);
      const mirX = 1 - pt.x; // horizontal mirror: natural "mirror" control
      const oob = checkOutOfBounds(mirX, pt.y);
      const depth = checkDepth(pt.size);
      markers.push({ x: mirX, y: pt.y, oob, depth, depthState: depth });
      candidates.push(Object.assign(
        { mirX, y: pt.y, size: pt.size },
        mapToTable(mirX, pt.y),
      ));
    }

    // Pick candidate for each player side (continuity: nearest to last raw pos)
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

        // teleport-like jump or fresh re-acquisition -> snap the filter
        const jump = Math.hypot(best.mirX - p.raw.x, best.y - p.raw.y);
        if (wasAbsent || jump > CONFIG.FILTER_JUMP_RESET_DIST) {
          p.filter.reset(best.mirX, best.y);
          p.vel.x = 0; p.vel.y = 0;
        }        // One Euro filtered point, then mapped into the player's own half
        const f = p.filter.update(best.mirX, best.y, dt);
        const mapped = mapToTable(f.x, f.y);

        // velocity in table units/s (mirX velocity matches table x direction;
        // magnitude clamped so glitch spikes can't feed huge impulses)
        const vx = Math.max(-8, Math.min(8, f.vx));
        const vy = Math.max(-8, Math.min(8, f.vy));
        p.vel.x = p.vel.x * 0.5 + vx * 0.5;
        p.vel.y = p.vel.y * 0.5 + vy * 0.5;

        p.target.x = mapped.tx; p.target.y = mapped.ty;
        p.smooth.x = mapped.tx; p.smooth.y = mapped.ty;
        p.raw.x = best.mirX; p.raw.y = best.y;

        updateOobFlag(p, best.mirX, best.y);
        updateDepthFlag(p, best.size);
        p.isLost = false;       // real landmarks again -> no longer lost
        p.present = true;
        p.lastSeen = now;
      } else {
        markLost(p);            // hand gone: freeze at safety edge, flag lost
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame update (called from the main rAF loop)                   */
  /* ------------------------------------------------------------------ */

  function update(dt) {
    const now = performance.now();

    // If MediaPipe stops delivering results entirely (webcam stalled),
    // treat every player as lost.
    if (now - lastResultsTime > 600) {
      for (const p of players) markLost(p);
    }

    // lost hands: velocity stays hard-zero every frame (not a decay timer),
    // so no ghost paddle motion can ever transfer into the puck
    for (const p of players) {
      if (!p.present) { p.vel.x = 0; p.vel.y = 0; }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Camera + MediaPipe lifecycle                                       */
  /* ------------------------------------------------------------------ */

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
          if (!sending) {
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

  /* Fallback: raw getUserMedia + rAF loop feeding hands.send() */
  async function startFallbackCamera() {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: CONFIG.CAMERA_WIDTH },
        height: { ideal: CONFIG.CAMERA_HEIGHT },
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
    for (const p of players) p.present = false;
    menuCursor.seen = false;
    menuCursor.pinch = false;
    handPoolCount = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                         */
  /* ------------------------------------------------------------------ */

  return {
    init(video, errCb) { videoEl = video; onError = errCb; },
    start, stop,
    update,

    getPlayers: () => players,
    getMarkers: () => markers,
    getVideo: () => videoEl,
    isRunning: () => running,

    /** menu hand-cursor state {seen, x, y, pinch, palmSize} */
    getMenuCursor: () => menuCursor,
    /** raw mirrored hands for skeleton drawing: {pairs, count} */
    getRawHands: () => ({ pairs: handPool, count: handPoolCount }),

    checkOutOfBounds,
    checkDepth,

    /** ms since player's hand was seen */
    absentMs(i) {
      return players[i].present ? 0 : (performance.now() - players[i].lastSeen);
    },
    /** ms since BOTH hands were seen (for auto-pause) */
    bothAbsentMs() {
      return Math.max(this.absentMs(0), this.absentMs(1));
    },

    /** @param {number} s 0..1 — remaps the One Euro base cutoff live */
    setSmoothing(s) {
      smoothing = Math.max(0, Math.min(1, s));
      const lo = CONFIG.FILTER_MIN_CUTOFF_MIN;   // very smooth
      const hi = CONFIG.FILTER_MIN_CUTOFF_MAX;   // responsive
      filterParams.minCutoff = lo + (hi - lo) * (1 - smoothing);
      filterParams.beta = CONFIG.FILTER_BETA;
      filterParams.dCutoff = CONFIG.FILTER_DC_CUTOFF;
    },
    setOrientation(o) {
      orientation = o === 'tb' ? 'tb' : 'lr';
      // the mapping changed — snap all filters to their current raw/target
      for (const p of players) {
        p.filter.reset(p.present ? p.raw.x : p.target.x,
                       p.present ? p.raw.y : p.target.y);
      }
    },
    getOrientation: () => orientation,
  };
})();
