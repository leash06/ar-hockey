/**
 * config.js
 * ==========================================================================
 * Global tuning constants for the game.
 * Everything that affects gameplay feel lives here so you can tune the
 * game without touching any game logic.
 *
 * Exposed as a single global `CONFIG` (plain script, no modules, so it is
 * available to every other file by simple load order in index.html).
 * ==========================================================================
 */

const CONFIG = {

  /* ======================================================================
   * GAME RULES
   * ====================================================================== */
  WIN_SCORE: 7,               // First player to reach this score wins

  SCORE_RESET_DELAY: 1200,    // ms pause after a goal before puck resets
  RESTART_SERVE_DELAY: 800,   // ms pause between puck reset and first serve

  /* ======================================================================
   * PHYSICS  (units: table-space pixels & seconds)
   * ------------------------------------------------------------------
   * The physics world is a virtual table of TABLE_W x TABLE_H px,
   * independent of the on-screen canvas size (renderer scales it).
   * Fixed timestep: physics always advances in FIXED_DT chunks per
   * animation frame, so behaviour is identical at 30 or 144 fps.
   * ====================================================================== */
  TABLE_W: 1280,              // virtual table width  (landscape)
  TABLE_H: 720,               // virtual table height (landscape)

  FIXED_DT: 1 / 120,          // fixed physics timestep (seconds)
  MAX_SUBSTEPS: 6,            // max physics steps per frame (prevents spiral of death)

  PUCK_RADIUS: 22,
  PUCK_FRICTION: 0.9992,      // per-timestep velocity multiplier (1 = no friction)
  PUCK_WALL_RESTITUTION: 0.86 // energy kept after a wall bounce (0..1)
  ,PUCK_MAX_SPEED: 2200,      // px/s hard cap — tracking glitches can't nuke the puck

  PUCK_STUCK_MIN_SPEED: 40,   // below this speed for STUCK_TIME -> nudge
  PUCK_STUCK_TIME: 1.6,       // seconds the puck may crawl/be pinned before nudging
  PUCK_NUDGE_SPEED: 260,      // speed applied by the anti-stuck nudge

  PADDLE_RADIUS: 36,
  PADDLE_MAX_SPEED: 2500,     // px/s cap on paddle movement (per frame clamp)
  PADDLE_MAX_HIT_BOOST: 900,  // extra velocity added to puck on hard hits

  CORNER_RADIUS: 44,          // rounded table corners for physics + visuals

  /* Serve / goal sizes */
  GOAL_WIDTH: 240,            // goal mouth width on each end wall
  PUCK_SERVE_SPEED_BASE: 480, // base serve speed toward receiving player

  /* ======================================================================
   * HAND TRACKING
   * ====================================================================== */
  TRACK_MAX_HANDS: 2,         // MediaPipe maxNumHands
  TRACK_MODEL_COMPLEXITY: 0,  // 0 = lite (faster), 1 = full (more accurate)
  TRACK_MIN_DETECTION_CONF: 0.6,
  TRACK_MIN_TRACKING_CONF: 0.5,

  // Control point: use palm center for stability (avg of wrist + MCP joints).
  USE_PALM_CENTER: true,
  FINGERTIP_LANDMARK: 8,      // index fingertip, used when USE_PALM_CENTER = false

  // Smoothing: the slider (0..1) maps onto a One Euro Filter
  // (velocity-adaptive low-latency filter), not a static lerp:
  //   0 = raw feel (high cutoff), 1 = very smooth/steady (low cutoff).
  DEFAULT_SMOOTHING: 0.5,     // settings range 0..1

  // ---- One Euro Filter tuning ------------------------------------------
  FILTER_MIN_CUTOFF_MIN: 0.6, // Hz cutoff at smoothing = 1 (max smoothing)
  FILTER_MIN_CUTOFF_MAX: 3.0, // Hz cutoff at smoothing = 0 (max responsiveness)
  FILTER_BETA: 4.0,           // speed coefficient: adaptive cutoff rise
  FILTER_DC_CUTOFF: 1.2,      // Hz for the velocity low-pass
  FILTER_JUMP_RESET_DIST: 0.30, // normalized jump distance that resets the filter

  // ---- Boundary / depth accuracy warnings ------------------------------
  // Margin tuned low so only serious frame-edge cutoffs trigger the
  // out-of-bounds alarm (hands near the edge are normal during play).
  HAND_OUT_OF_BOUNDS_MARGIN: 0.05, // normalized video-edge margin -> OOB warning
  // Lower bound raised less aggressively: hand size varies across cameras
  // and couch distances - a too-eager minimum caused constant false
  // "too far" alarms for perfectly visible hands.
  HAND_MIN_PALM_SIZE: 0.045,  // landmark bbox span below this = hand too far away
  HAND_MAX_PALM_SIZE: 0.55,   // landmark bbox span above this = hand too close
  OUT_OF_BOUNDS_ALARM_INTERVAL: 0.45, // s between alarm beeps (audio throttle)

  MISSING_HAND_TIMEOUT: 3000, // ms without hands -> auto-pause
  HINT_SHOW_DELAY: 450,       // ms without a hand -> show "Show your hand" hint

  /* ======================================================================
   * PERFORMANCE / THROTTLING
   * ====================================================================== */
  RENDER_MAX_DPR: 2,        // cap devicePixelRatio on the game canvas (retina cost)
  UI_UPDATE_MS: 100,        // DOM hint/warning refresh budget (~10 Hz)
  ALARM_PULSE_MS: 520,      // pacing of continuous lost/OOB alarm bursts

  /* ======================================================================
   * CAMERA / DISPLAY
   * ====================================================================== */
  CAMERA_WIDTH: 1280,         // requested camera stream width
  CAMERA_HEIGHT: 720,         // requested camera stream height
  CAMERA_FPS: 30,

  CAM_BG_OPACITY: 0.15,       // opacity of the mirrored camera feed behind table (AR effect stays readable)

  DEFAULT_ORIENTATION: 'lr',  // 'lr' = players left/right, 'tb' = players top/bottom
  DEFAULT_SHOW_CAM_BG: true,  // show camera feed behind the table
  DEFAULT_SHOW_MARKERS: true, // draw tracking marker on each detected hand
  DEFAULT_SHOW_DEBUG: false,  // FPS counter
  DEFAULT_SOUND: true,

  PUCK_TRAIL_LENGTH: 14,      // frames of motion trail for the puck (visual)
  GOAL_EFFECT_DURATION: 900,  // ms of goal glow particles
};

/* Freeze so game code can't accidentally mutate the tuning table. */
Object.freeze(CONFIG);

/* Make it globally accessible (also when bundled later). */
if (typeof window !== 'undefined') {
  window.CONFIG = CONFIG;
}

/**
 * THEME — visual identity for the HOCKEY-AR redesign (all colors in one place).
 * Frozen for the same reason as CONFIG.
 */
const THEME = Object.freeze({
  P_COLORS: ['#39ff88', '#ff3b44'],          // P1 green (half 1), P2 red (half 2)
  PUCK: '#ffffff',                            // puck is white
  // Border quadrant colors {TL, TR, BL, BR} — yellow / green / red / blue.
  BORDER_SEGMENTS: ['#ffcf3f', '#39ff88', '#ff3b44', '#2b6bff'],
  BORDER_WIDTH: 8,                            // px stroke width of the neon border
  BLOOM_BLUR: 6,                              // soft bloom blur radius for thin strokes
  TRAIL_RGB: '230, 245, 255',                 // puck trail color (rgb triple, drawn at low alpha)
  WARN_RED_RGB: '255, 59, 68',                // out-of-bounds alarm (max stroke color)
  WARN_AMBER_RGB: '255, 157, 63',             // depth/lost warning color
  CENTER_RGB: '120, 140, 150',                // center line / circle markings (dim)
  CYAN: '#00e5ff',                            // accent for cursor dwell bars / hover
});

if (typeof window !== 'undefined') {
  window.THEME = THEME;
}
