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
 *  - maps hand position into *normalized table coordinates* for the player's
 *    own half only (clamped — a hand can never cross the center line)
 *  - computes a velocity vector per player so fast swings hit harder
 *  - tracks "last seen" time per player so the game can (a) freeze a paddle,
 *    (b) show hints, (c) auto-pause after CONFIG.MISSING_HAND_TIMEOUT
 *
 * Normalized table coordinates: x,y in [0..1] of the physics table.
 * Physics/renderer convert to pixels.
 * ==========================================================================
 */

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

  /* Markers for the renderer (raw mirrored, video-normalized coords) */
  const markers = [];

  const players = [makePlayer(0.25, 0.5), makePlayer(0.75, 0.5)];

  function makePlayer(tx, ty) {
    return {
      present: false,
      lastSeen: 0,         // perf.now when this hand was last detected
      raw: { x: tx, y: ty },    // latest raw mirrored video coords (for continuity)
      target: { x: tx, y: ty }, // clamped normalized table-coord target
      smooth: { x: tx, y: ty }, // smoothed position (what the paddle follows)
      vel: { x: 0, y: 0 },      // normalized table units / second
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

  /** control point: palm center (stable) or index fingertip */
  function controlPoint(lm) {
    if (!CONFIG.USE_PALM_CENTER) {
      const tip = lm[CONFIG.FINGERTIP_LANDMARK] || lm[8];
      return { x: tip.x, y: tip.y };
    }
    // average of wrist + the four finger-base (MCP) joints = palm center
    const ids = [0, 5, 9, 13, 17];
    let x = 0, y = 0;
    for (const i of ids) { x += lm[i].x; y += lm[i].y; }
    return { x: x / ids.length, y: y / ids.length };
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

    // Collect candidates {side, tx, ty, mirX, y}
    const candidates = [];
    for (const lm of landmarks) {
      if (!lm || lm.length < 18) continue;
      const pt = controlPoint(lm);
      const mirX = 1 - pt.x; // horizontal mirror: natural "mirror" control
      markers.push({ x: mirX, y: pt.y });
      candidates.push(Object.assign({ mirX, y: pt.y }, mapToTable(mirX, pt.y)));
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
        // velocity from the PREVIOUS raw position (table-space units/s)
        const vx = (best.tx - p.raw.x) / dt;
        const vy = (best.ty - p.raw.y) / dt;
        p.vel.x = p.vel.x * 0.6 + vx * 0.4;
        p.vel.y = p.vel.y * 0.6 + vy * 0.4;
        p.target.x = best.tx; p.target.y = best.ty;
        p.raw.x = best.mirX;  p.raw.y = best.y;
        p.present = true;
        p.lastSeen = now;
      } else {
        p.present = false; // paddle freezes at last smooth position game-side
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame update (called from the main rAF loop)                   */
  /* ------------------------------------------------------------------ */

  function update(dt) {
    const now = performance.now();

    // If MediaPipe stops delivering results entirely (webcam froze),
    // mark everyone absent.
    if (now - lastResultsTime > 600) {
      for (const p of players) p.present = false;
    }

    // Lerp factor — framerate-independent:
    // smoothing 0 -> r=0.60 (snappy), smoothing 1 -> r=0.10 (very smooth)
    const s = Math.max(0, Math.min(1, smoothing));
    const r = 0.60 - 0.50 * s;
    const alpha = 1 - Math.pow(r, dt * 60);

    for (const p of players) {
      if (p.present) {
        p.smooth.x += (p.target.x - p.smooth.x) * alpha;
        p.smooth.y += (p.target.y - p.smooth.y) * alpha;
      } else {
        // hand gone: decay velocity to 0 so it no longer pushes the puck,
        // keep paddle position frozen at last smooth value
        const k = Math.max(0, 1 - 6 * dt);
        p.vel.x *= k; p.vel.y *= k;
      }
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

    /** ms since player's hand was seen */
    absentMs(i) {
      return players[i].present ? 0 : (performance.now() - players[i].lastSeen);
    },
    /** ms since BOTH hands were seen (for auto-pause) */
    bothAbsentMs() {
      return Math.max(this.absentMs(0), this.absentMs(1));
    },

    setSmoothing(s) { smoothing = Math.max(0, Math.min(1, s)); },
    setOrientation(o) { orientation = o === 'tb' ? 'tb' : 'lr'; },
    getOrientation: () => orientation,
  };
})();
