/**
 * config.js
 * ==========================================================================
 * HOCKEY-AR clean-slate rebuild — global tuning constants + theme.
 *
 * Everything that affects gameplay feel lives here so the game can be
 * tuned without touching logic. Frozen so nothing may mutate it at runtime.
 *
 * Plain script (no modules): load order in index.html makes CONFIG and
 * THEME available to every other file, and `window.CONFIG`/`window.THEME`
 * are assigned for later bundling.
 * ==========================================================================
 */

const CONFIG = Object.freeze({

  /* ======================================================================
   * GAME RULES
   * ====================================================================== */
  WIN_SCORE: 7,                 // first player to reach this score wins
  SCORE_RESET_DELAY: 1200,      // ms pause after a goal before puck resets

  /* ======================================================================
   * TIMESTEP / PHYSICS STRUCTURE
   * ------------------------------------------------------------------
   *  FIXED_DT          : fixed physics step — decoupled from render FPS
   *  MAX_FRAME_STEPS   : max fixed steps per rendered frame (spiral guard)
   *  PUCK_SUBSTEP_MAX  : movement sub-chunks inside one fixed step
   *                      (anti-tunneling: each chunk short enough that a
   *                      max-speed puck can never skip a wall or paddle)
   * ====================================================================== */
  FIXED_DT: 1 / 120,
  MAX_FRAME_STEPS: 6,
  PUCK_SUBSTEP_MAX: 4,

  /* ======================================================================
   * TABLE  (virtual px, orientation swaps W/H)
   * ====================================================================== */
  TABLE_W: 1280,
  TABLE_H: 720,
  CORNER_RADIUS: 44,
  GOAL_WIDTH: 240,

  /* ======================================================================
   * PUCK
   * ====================================================================== */
  PUCK_RADIUS: 22,
  PUCK_FRICTION: 0.9992,        // per fixed-step velocity multiplier
  PUCK_WALL_RESTITUTION: 0.86,  // energy kept after a wall bounce
  PUCK_MAX_SPEED: 2200,         // px/s hard cap

  /* ---- anti-stuck nudge / nudgeHold ------------------------------------
   *  PUCK_STUCK_MIN_SPEED : below this speed the puck counts as stuck
   *  PUCK_STUCK_TIME      : seconds below threshold before nudge is armed
   *  PUCK_NUDGE_SPEED     : speed applied by the nudge
   *  NUDGE_HOVER_PAD      : if a paddle hovers within this extra px of the
   *                         puck, nudgeHold stands down (uses "let me play
   *                         it" intent) and no auto-nudge fires
   * ====================================================================== */
  PUCK_STUCK_MIN_SPEED: 40,
  PUCK_STUCK_TIME: 1.6,
  PUCK_NUDGE_SPEED: 260,
  NUDGE_HOVER_PAD: 48,

  /* ======================================================================
   * PADDLES
   * ====================================================================== */
  PADDLE_RADIUS: 36,
  PADDLE_MARGIN: 42,            // inset from walls / center line (px)
  PADDLE_MAX_SPEED: 2500,       // px/s cap on paddle repositioning
  PADDLE_MAX_HIT_BOOST: 900,    // extra velocity fed to the puck on hard hits

  PUCK_SERVE_SPEED_BASE: 480,   // serve speed toward the receiving player

  /* ======================================================================
   * CAMERA / DISPLAY
   * ====================================================================== */
  CAMERA_OPACITY: 0.55,         // camera bg visibility (high-visibility AR)
  CAMERA_WIDTH: 1280,
  CAMERA_HEIGHT: 720,
  RENDER_MAX_DPR: 2,            // devicePixelRatio cap on the game canvas

  /* ======================================================================
   * HAND TRACKING (MediaPipe Hands)
   * ====================================================================== */
  TRACK_MAX_HANDS: 2,
  TRACK_MODEL_COMPLEXITY: 0,    // 0 = lite, 1 = full
  TRACK_MIN_DETECTION_CONF: 0.6,
  TRACK_MIN_TRACKING_CONF: 0.5,
  /* ---- single-point anchor --------------------------------------------
   *  The hand is ONE point: MediaPipe landmark 9 (middle-finger MCP /
   *  palm center) with landmark 0 (wrist) as fallback. No multi-joint
   *  averaging — kills fingertip jitter and per-frame loop overhead.
   * ====================================================================== */
  ANCHOR_LANDMARK: 9,
  ANCHOR_FALLBACK_LANDMARK: 0,

  /* ---- normalized 2D bounds -------------------------------------------
   *  Pure 2D tracking: x,y kept between these bounds; a hand outside is
   *  flagged out-of-bounds. No Z-depth warnings (palm-size heuristics
   *  were too camera-dependent — removed from the rebuild).
   * ====================================================================== */
  BOUNDS_MIN: 0.05,
  BOUNDS_MAX: 0.95,

  /* ---- packet-drop protection -----------------------------------------
   *  lostFrames streak: if no tracking packet arrives for
   *  FILTER_DROP_RESET_FRAMES consecutive frames, every One Euro filter
   *  is fully reset (prevents filter state from surviving a stall and
   *  producing a float/teleport on re-entry).
   * ====================================================================== */
  FILTER_DROP_RESET_FRAMES: 30,
  PACKET_DT_FALLBACK: 0.033,    // s — used when packet dt is unusable

  /* ---- One Euro Filter tuning -----------------------------------------
   *  BETA is deliberately high (well above the 0.05 floor): the adaptive
   *  cutoff rises sharply with speed, so the filter stops resisting
   *  acceleration — zero-lag high-velocity strikes, still smooth at rest.
   * ---------------------------------------------------------------------- */
  FILTER_MIN_CUTOFF_MIN: 0.6,   // Hz cutoff at smoothing = 1 (max smooth)
  FILTER_MIN_CUTOFF_MAX: 3.0,   // Hz cutoff at smoothing = 0 (raw feel)
  FILTER_BETA: 8.0,
  FILTER_DC_CUTOFF: 1.2,
  FILTER_JUMP_RESET_DIST: 0.30, // normalized jump that resets the filter
  DEFAULT_SMOOTHING: 0.5,       // settings range 0..1

  /* ---- sub-frame interpolation + dead reckoning ------------------------
   *  Webcam packets arrive at ~30 Hz while the engine ticks at 60/120 Hz.
   *  The paddle position is INTERPOLATED between the last two timestamped
   *  anchor packets every engine tick (alpha = 1 at packet arrival — zero
   *  added latency), with a controlled lookahead capped at
   *  INTERP_MAX_ALPHA (1.5) so late packets never overshoot wildly.
   *  Beyond the lookahead (motion-blur dropouts, 1–3 frames) the paddle
   *  coasts on its momentum vector; past DEAD_RECKON_MAX_MS it is marked
   *  lost.
   * ====================================================================== */
  INTERP_MAX_ALPHA: 1.5,        // max interpolation lookahead (alpha)
  DEAD_RECKON_MAX_MS: 100,      // ~3 frames @30 fps packet rate

  /* ---- flow / UI ------------------------------------------------------- */
  MISSING_HAND_TIMEOUT: 3000,   // ms without required hands -> auto-pause
  HINT_SHOW_DELAY: 450,         // ms absent -> draw "show your hand" hint
  UI_UPDATE_MS: 100,            // DOM sync budget (~10 Hz)

  /* ---- defaults -------------------------------------------------------- */
  DEFAULT_ORIENTATION: 'lr',    // 'lr' = left/right, 'tb' = top/bottom
  DEFAULT_SHOW_MARKERS: true,
  DEFAULT_SHOW_CAM_BG: true,
  DEFAULT_SOUND: true,

  /* ---- speed presets --------------------------------------------------- */
  SPEED_MULT: Object.freeze({ slow: 0.75, normal: 1.0, fast: 1.3 }),

  /* ---- renderer pools (zero per-frame allocation) ----------------------- */
  PUCK_TRAIL_LENGTH: 14,
  PARTICLE_POOL: 256,
  FLASH_POOL: 10,
});

/**
 * THEME — visual identity (all colors in one place, frozen).
 */
const THEME = Object.freeze({
  P_COLORS: ['#39ff88', '#ff3b44'],          // P1 green / P2 red
  PUCK: '#ffffff',
  BORDER_SEGMENTS: ['#ffcf3f', '#39ff88', '#ff3b44', '#2b6bff'], // TL TR BL BR
  BORDER_WIDTH: 8,
  BLOOM_BLUR: 6,
  TRAIL_RGB: '230, 245, 255',
  WARN_RED_RGB: '255, 59, 68',
  CENTER_RGB: '120, 140, 150',
  CYAN: '#00e5ff',
});

if (typeof window !== 'undefined') {
  window.CONFIG = CONFIG;
  window.THEME = THEME;
}
