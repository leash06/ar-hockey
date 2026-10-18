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

  // Smoothing: exponential lerp factor derived from smoothing setting.
  // Raw factor = 1 - SMOOTHING_STRENGTH, then squared so 0.5 feels responsive
  // (higher smoothing strength => lower lerp factor => steadier, twitchier-free).
  DEFAULT_SMOOTHING: 0.5,     // settings range 0..1 (0 = raw, 1 = very smooth)

  MISSING_HAND_TIMEOUT: 3000, // ms without hands -> auto-pause game
  HINT_SHOW_DELAY: 450,       // ms without a hand -> show "Show your hand" hint

  /* ======================================================================
   * CAMERA / DISPLAY
   * ====================================================================== */
  CAMERA_WIDTH: 1280,         // requested camera stream width
  CAMERA_HEIGHT: 720,         // requested camera stream height
  CAMERA_FPS: 30,

  CAM_BG_OPACITY: 0.35,       // opacity of the mirrored camera feed behind table

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
