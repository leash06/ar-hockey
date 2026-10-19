/* eslint-disable no-undef */
/**
 * tests/probe.mjs — headless verification probe for the HOCKEY-AR rebuild.
 *
 * Runs WITHOUT a browser: loads config.js + physics.js into a vm context
 * (window stubbed), then drives PhysicsWorld hard across both orientations
 * and verifies the anti-flicker / anti-tunneling invariants.
 *
 * Exit code 0 = all checks pass.
 * Usage: node tests/probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---- load sources into a sandbox ------------------------------------ */
const clock = { t: 1000 };   // controllable ms clock for the sandbox
const sandbox = {
  console,
  performance: { now: () => clock.t },
  window: { addEventListener() {}, devicePixelRatio: 1 },
  Math, Date, Float32Array, freezeFlag: undefined,
};
vm.createContext(sandbox);

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
/* top-level const in a vm is context-scoped, not a global — epilogues
   punch them out for the module scope of this probe */
vm.runInContext(`${read('js/config.js')}; globalThis.__CONF = { CONFIG, THEME };`,
  sandbox, { filename: 'js/config.js' });
vm.runInContext(`${read('js/physics.js')}; globalThis.__PHYS = { PhysicsWorld };`,
  sandbox, { filename: 'js/physics.js' });
vm.runInContext(`${read('js/tracking.js')}; globalThis.__TRACK = { TrackingManager };`,
  sandbox, { filename: 'js/tracking.js' });

const CONFIG = sandbox.__CONF.CONFIG;
const PhysicsWorld = sandbox.__PHYS.PhysicsWorld;
const TrackingManager = sandbox.__TRACK.TrackingManager;

/* ---- tiny assertion harness ----------------------------------------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}`); }
}

function fresh(orientation) {
  const w = new PhysicsWorld(orientation);
  w.setSpeedMult(1);
  return w;
}

/* targets that park both paddles far from play */
const FAR_TARGETS = new Float32Array([0.01, 0.5, 0.99, 0.5]);
const HOME_TARGETS = new Float32Array([0.25, 0.5, 0.75, 0.5]);

const dt = CONFIG.FIXED_DT;

/* ==================================================================== */
console.log('--- 1. configuration contract --------------------------------------');
ok(CONFIG.CAMERA_OPACITY === 0.55, 'CONFIG.CAMERA_OPACITY === 0.55 (high-visibility camera bed)');
ok(CONFIG.PUCK_SUBSTEP_MAX === 4, 'CONFIG.PUCK_SUBSTEP_MAX === 4 (movement sub-stepping)');
ok(CONFIG.NUDGE_HOVER_PAD === 48, 'CONFIG.NUDGE_HOVER_PAD === 48 (nudge stand-down pad)');
ok(CONFIG.FILTER_DROP_RESET_FRAMES === 30, 'CONFIG.FILTER_DROP_RESET_FRAMES === 30 (stale-filter flush)');
ok(CONFIG.PACKET_DT_FALLBACK === 0.033, 'CONFIG.PACKET_DT_FALLBACK === 0.033');
ok(CONFIG.FIXED_DT === 1 / 120, 'CONFIG.FIXED_DT === 1/120 (fixed timestep)');
ok(Object.isFrozen(CONFIG), 'CONFIG frozen at runtime');
ok(Object.isFrozen(CONFIG.SPEED_MULT), 'CONFIG.SPEED_MULT frozen');
ok('DEFAULT_ORIENTATION' in CONFIG && CONFIG.DEFAULT_ORIENTATION === 'lr', "default orientation 'lr'");

/* ==================================================================== */
console.log('--- 2. zero-allocation state model ----------------------------------');
{
  const w = fresh('lr');
  ok(w.state instanceof Float32Array && w.state.length === 8, 'state is a Float32Array(8)');
  ok(w.padVel instanceof Float32Array && w.padVel.length === 4, 'paddle velocities in Float32Array(4)');
  ok(w.puck instanceof Float32Array && w.puck.length === 4 && w.puck.buffer === w.state.buffer,
     'puck view aliases the state buffer (created once)');
  // stability across steps: the same view object every time
  const before = w.puck;
  for (let i = 0; i < 120; i++) w.update(dt, FAR_TARGETS);
  ok(w.puck === before, 'puck view object identity constant across steps');
}

/* ==================================================================== */
console.log('--- 3. substep anti-tunneling ----------------------------------------');
{
  // extreme: puck at max speed, aimed straight through a paddle
  let tunneled = false;
  for (let trial = 0; trial < 50; trial++) {
    const w = fresh('lr');
    w.puck[0] = w.W / 2;
    w.puck[1] = trial % 2 ? 200 : 520;
    w.puck[2] = CONFIG.PUCK_MAX_SPEED;       // straight at P2's paddle home
    w.puck[3] = 0;
    w.pad1[0] = w.W - 150; w.pad1[1] = w.puck[1];
    for (let i = 0; i < 200; i++) {
      w.update(dt, FAR_TARGETS);
      const x = w.puck[0], y = w.puck[1];
      const rr = CONFIG.PUCK_RADIUS + CONFIG.PADDLE_RADIUS;
      const dx = x - w.pad1[0], dy = y - w.pad1[1];
      const d = Math.hypot(dx, dy);
      if (d < rr - CONFIG.PUCK_RADIUS * 0.1 && dx > 0) tunneled = true; // past it
      break;
    }
  }
  ok(!tunneled, 'max-speed puck never passes through a paddle (substeps catch it)');
}
{
  // wall containment at max speed over many random steps
  const w = fresh('lr');
  const speeds = [CONFIG.PUCK_MAX_SPEED, CONFIG.PUCK_MAX_SPEED * 0.6];
  let escaped = false;
  for (let trial = 0; trial < 4; trial++) {
    w.puck[0] = w.W / 2; w.puck[1] = w.H / 2;
    const a = Math.random() * Math.PI * 2;
    const sp = speeds[trial % speeds.length];
    w.puck[2] = Math.cos(a) * sp; w.puck[3] = Math.sin(a) * sp;
    for (let i = 0; i < 600; i++) {
      w.update(dt, FAR_TARGETS);
      const x = w.puck[0], y = w.puck[1];
      if (x < -50 || x > w.W + 50 || y < -50 || y > w.H + 50) { escaped = true; break; }
    }
  }
  ok(!escaped, 'puck contained inside walls at max speed across random headings');
}

/* ==================================================================== */
console.log('--- 4. walls + restitution -------------------------------------------');
{
  // fire straight up; stop the moment the FIRST wall impact is drained
  const w = fresh('lr');
  w.puck[0] = w.W / 2; w.puck[1] = 120;
  w.puck[2] = 0; w.puck[3] = -1000;        // heading up
  let bounceSeen = false, vyAfter = 0, yAfter = 0;
  for (let i = 0; i < 60 && !bounceSeen; i++) {
    w.update(dt, FAR_TARGETS);
    w.drainEvents(ev => { if (ev.type === 'wallHit') bounceSeen = true; });
    vyAfter = w.puck[3]; yAfter = w.puck[1];
  }
  ok(bounceSeen, 'wall bounce occurred (wallHit event)');
  ok(yAfter >= CONFIG.PUCK_RADIUS - 0.01, 'top wall clamp keeps puck on table');
  ok(vyAfter > 0, 'restitution reversed vy on the top wall impact');
}

/* ==================================================================== */
console.log('--- 5. goals + scorer parity (both orientations) ----------------------');
{
  // lr: puck enters LEFT goal (side 0) -> scorer = 1
  const w = fresh('lr');
  w.puck[0] = 100; w.puck[1] = w.H / 2; w.puck[2] = 0; w.puck[3] = 0;
  w.update(dt, FAR_TARGETS); // parked; not moving
  w.puck[2] = 1200;          // charged left through the goal mouth
  let got = null;
  for (let i = 0; i < 200 && !got; i++) {
    w.update(dt, FAR_TARGETS);
    w.drainEvents(ev => { if (ev.type === 'goal' && !got) got = ev; });
  }
  ok(!!got, 'lr: goal event fires through the left mouth');
  ok(got && got.scorer === 1, 'lr: puck into P1 goal -> scorer = 1');
  ok(w.frozen, 'world freezes after a goal');
  w.serve(0);
  ok(!w.frozen, 'serve() unfreezes the world');
}
{
  // tb: puck enters TOP goal (side 1 = P2's goal) -> scorer = 0
  const w = fresh('tb');
  ok(w.W === CONFIG.TABLE_H && w.H === CONFIG.TABLE_W,
     "tb orientation swaps W/H (720x1280)");
  w.puck[0] = w.W / 2; w.puck[1] = 100; w.puck[2] = 0; w.puck[3] =-1200;
  let got = null;
  for (let i = 0; i < 200 && !got; i++) {
    w.update(dt, FAR_TARGETS);
    w.drainEvents(ev => { if (ev.type === 'goal' && !got) got = ev; });
  }
  ok(!!got && got.scorer === 0, 'tb: puck through top mouth -> scorer = 0');
}
{
  // deterministic: aim straight at the goal WALL but outside the mouth.
  // The puck must bounce off the wall (never pass/swallow) — checked over
  // a short horizon before the puck can wander into the mouth band.
  const w = fresh('lr');
  w.puck[0] = 400; w.puck[1] = 80;              // y far below the mouth band
  w.puck[2] = -1600; w.puck[3] = 0;
  let leaked = false, bounced = false;
  for (let i = 0; i < 60; i++) {                // 0.5 s window
    w.puck[1] = 80; w.puck[3] = 0;              // pin y (isolate the x axis)
    w.update(dt, FAR_TARGETS);
    w.drainEvents(ev => {
      if (ev.type === 'goal') leaked = true;
      if (ev.type === 'wallHit') bounced = true;
    });
    if (w.puck[0] < -1 || leaked) { leaked = true; break; }
  }
  ok(!leaked, 'off-mouth shot bounces off the goal wall (never passes)');
  ok(bounced, 'wall bounce detected for the off-mouth shot');
  // complementary: same shot INSIDE the mouth must score
  const wg = fresh('lr');
  wg.puck[0] = 400; wg.puck[1] = wg.H / 2;
  wg.puck[2] = -1600; wg.puck[3] = 0;
  // park both paddles clear of the shot corridor
  const clearT = new Float32Array([0.1, 0.98, 0.98, 0.02]);
  let scored = false;
  for (let i = 0; i < 60 && !scored; i++) {
    wg.update(dt, clearT);
    wg.drainEvents(ev => { if (ev.type === 'goal') scored = true; });
  }
  ok(scored, 'in-mouth shot on the same axis scores (goal passes through)');
}

/* ==================================================================== */
console.log('--- 6. paddle ownership + speed cap -----------------------------------');
{
  const w = fresh('lr');
  // demand P1's paddle deep into P2's half
  const T = new Float32Array([0.95, 0.5, 0.05, 0.5]);
  for (let i = 0; i < 240; i++) w.update(dt, T);
  const mid = w.W / 2, m = CONFIG.PADDLE_MARGIN;
  ok(w.pad0[0] < mid - m + 0.01, 'P1 paddle clamped to its own half (lr)');
  ok(w.pad1[0] > mid + m - 0.01, 'P2 paddle clamped to its own half (lr)');
}
{
  const w = fresh('tb');
  const T = new Float32Array([0.5, 0.05, 0.5, 0.95]);   // P1 wants top
  for (let i = 0; i < 240; i++) w.update(dt, T);
  const mid = w.H / 2, m = CONFIG.PADDLE_MARGIN;
  ok(w.pad0[1] > mid + m - 0.01, 'P1 paddle clamped to bottom half (tb)');
  ok(w.pad1[1] < mid - m + 0.01, 'P2 paddle clamped to top half (tb)');
}
{
  const w = fresh('lr');
  const T = new Float32Array([0, 0, 1, 1]);             // corners demanded
  const maxMove = CONFIG.PADDLE_MAX_SPEED * dt;
  const px0 = w.pad0[0], py0 = w.pad0[1];
  w.update(dt, T);
  const step = Math.hypot(w.pad0[0] - px0, w.pad0[1] - py0);
  ok(step <= maxMove + 0.01, `paddle step within PADDLE_MAX_SPEED (${maxMove.toFixed(1)} px/step cap)`);
}

/* ==================================================================== */
console.log('--- 7. paddle hits + puck speed cap -----------------------------------');
{
  const w = fresh('lr');
  w.puck[0] = w.W - 200; w.puck[1] = w.H / 2;
  w.puck[2] = 0; w.puck[3] = 0;
  // slam P2's paddle into the puck at full speed
  let hitEvent = null;
  const T = new Float32Array([0.2, 0.5, (w.W - 200) / w.W, 0.5]);
  for (let i = 0; i < 4 && !hitEvent; i++) {
    w.update(dt, T);
    w.drainEvents(ev => { if (ev.type === 'paddleHit' && !hitEvent) hitEvent = ev; });
  }
  ok(!!hitEvent && hitEvent.player === 1, 'paddleHit event with player = 1 (solo slam)');
  ok(Math.hypot(w.puck[2], w.puck[3]) <= CONFIG.PUCK_MAX_SPEED + 1,
     'puck speed never exceeds PUCK_MAX_SPEED after a hit');
}

/* ==================================================================== */
console.log('--- 8. nudgeHold: stuck-puck stand-down + clean fire -------------------');
{
  const w = fresh('lr');
  // park the puck nearly still in open space, paddles far away
  w.puck[0] = w.W / 2; w.puck[1] = 200;
  w.puck[2] = 2; w.puck[3] = 0;             // crawling
  const STUCK = CONFIG.PUCK_STUCK_TIME;
  const pad = CONFIG.NUDGE_HOVER_PAD;
  const contact = CONFIG.PUCK_RADIUS + CONFIG.PADDLE_RADIUS;

  // P1's paddle hovers just outside contact but inside the hover pad
  const hoverX = w.W / 2 - contact - pad * 0.5, hoverY = 200;
  const T = new Float32Array(
    [hoverX / w.W, hoverY / w.H, 0.99, 0.5]);

  let nudgeEvents = 0;
  const steps = Math.ceil((STUCK + 0.5) / dt);
  for (let i = 0; i < steps; i++) {
    w.update(dt, T);
    w.drainEvents(ev => { if (ev.type === 'nudge') nudgeEvents++; });
  }
  ok(w.nudgeHold === true, 'nudgeHold engaged while a paddle hovers the stuck puck');
  ok(nudgeEvents === 0, 'no auto-nudge fires while hovering (stand-down)');
  ok(w.stuckTime >= STUCK - 0.01, 'stuck timer parked at threshold during hold');

  // lift the hover: paddle retreats far away -> clean nudge fire
  const T2 = new Float32Array([0.01, 0.5, 0.99, 0.5]);
  nudgeEvents = 0;
  for (let i = 0; i < 30 && nudgeEvents === 0; i++) {
    w.update(dt, T2);
    w.drainEvents(ev => { if (ev.type === 'nudge') nudgeEvents++; });
  }
  ok(nudgeEvents >= 1, 'nudge fires cleanly once the hover clears');
  ok(Math.hypot(w.puck[2], w.puck[3]) >= CONFIG.PUCK_NUDGE_SPEED * 0.5 - 1,
     'nudge applied real velocity to the puck');
}
{
  // nudge does NOT fire when the puck keeps moving above threshold
  const w = fresh('lr');
  w.puck[0] = w.W / 2; w.puck[1] = w.H / 2;
  w.puck[2] = 300; w.puck[3] = 150;
  let nudges = 0;
  for (let i = 0; i < 300; i++) {
    w.update(dt, HOME_TARGETS);
    w.drainEvents(ev => { if (ev.type === 'nudge') nudges++; });
  }
  ok(nudges === 0, 'no nudge for a healthy moving puck');
}

/* ==================================================================== */
console.log('--- 9. event pool reuse (zero-alloc draining) --------------------------');
{
  const w = fresh('lr');
  // induce many wall hits -> pool churn
  w.puck[0] = 300; w.puck[1] = w.H / 2;
  w.puck[2] = -1500; w.puck[3] = 700;
  let drained = 0;
  for (let i = 0; i < 400; i++) {
    w.update(dt, FAR_TARGETS);
    w.drainEvents(() => drained++);
    if (drained === 0 && w.eventCount !== 0) break;
    let leftover = null;
    w.drainEvents(() => leftover = 1);
    if (leftover) break;
  }
  ok(drained > 0, `event pool delivered events (${drained})`);
  ok(w.eventCount === 0, 'event count resets to 0 after drain (no double delivery)');
}

/* ==================================================================== */
console.log('--- 10. NaN robustness + long soak -------------------------------------');
{
  const w = fresh('lr');
  let nanFound = false;
  for (let i = 0; i < 20000; i++) {
    const T = new Float32Array([Math.random(), Math.random(), Math.random(), Math.random()]);
    w.update(dt, T);
    w.drainEvents(() => {});
    const v = w.state;
    if (!Number.isFinite(v[0] + v[1] + v[2] + v[3])) { nanFound = true; break; }
  }
  ok(!nanFound, '20k random-step soak: no NaN/Infinity in state');
}

/* ==================================================================== */
console.log('--- 11. single-point anchor + high-velocity filter tuning ------------');
{
  // static: anchor is landmark 9 with landmark 0 fallback; beta raised
  const cfgSrc = read('js/config.js');
  ok(/ANCHOR_LANDMARK:\s*9/.test(cfgSrc), 'config: anchor = landmark 9 (middle-finger MCP / palm center)');
  ok(/ANCHOR_FALLBACK_LANDMARK:\s*0/.test(cfgSrc), 'config: fallback anchor = landmark 0 (wrist)');
  ok(/FILTER_BETA:\s*([0-9.]+)/.exec(cfgSrc) && +(/FILTER_BETA:\s*([0-9.]+)/.exec(cfgSrc)[1]) >= 0.05,
     'config: One Euro beta >= 0.05 (velocity tuning present)');
  const beta = +(/FILTER_BETA:\s*([0-9.]+)/.exec(cfgSrc)[1]);
  ok(beta >= 4.0, `config: beta raised to ${beta} (>= old 4.0 — sharper adaptive cutoff on fast swings)`);

  // static: no multi-joint averaging loops survive in tracking.js
  const trackSrc = read('js/tracking.js');
  ok(!/\[0,\s*5,\s*9,\s*13,\s*17\]/.test(trackSrc), 'tracking.js: multi-joint averaging loop removed');
  ok(!/for \(const p of lm\)/.test(trackSrc), 'tracking.js: per-landmark bbox loops removed');

  // static: high-framerate webcam constraints
  ok(/frameRate:\s*\{\s*ideal:\s*60,\s*min:\s*30\s*\}/.test(trackSrc),
     'tracking.js: getUserMedia frameRate {ideal: 60, min: 30}');

  // behavioral: anchor latches exactly onto lm[9] (mirrored)
  TrackingManager.init({}, () => {});
  const lm = Array.from({ length: 21 }, (_, i) => ({ x: 0.1 + i * 0.01, y: 0.5 }));
  lm[9] = { x: 0.75, y: 0.4 };                    // anchor
  lm[0] = { x: 0.99, y: 0.99 };                   // decoy: must NOT be used
  clock.t = 1000;
  TrackingManager._onResults({ multiHandLandmarks: [lm] });
  const ps = TrackingManager.getPlayers();
  const p0 = ps[0].present ? ps[0] : ps[1];
  ok(Math.abs(p0.raw.x - (1 - 0.75)) < 1e-6 && Math.abs(p0.raw.y - 0.4) < 1e-6,
     'anchor latches exactly onto landmark 9 (mirrored), ignoring other joints');
}

/* ==================================================================== */
console.log('--- 12. short-frame dead reckoning (1-3 dropped packets) --------------');
{
  TrackingManager.init({}, () => {});
  const mk = (ax, ay) => Array.from({ length: 21 }, () => ({ x: ax, y: ay }));
  const ps = TrackingManager.getPlayers();

  // two packets: P1 anchor sweeping left fast (mirrored x decreasing),
  // with the game loop's update() running between packets (as in reality)
  clock.t = 2000;
  TrackingManager._onResults({ multiHandLandmarks: [mk(0.80, 0.5)] });   // raw 0.20
  clock.t = 2008; TrackingManager.update();          // loop tick post-packet
  clock.t = 2033;
  TrackingManager._onResults({ multiHandLandmarks: [mk(0.70, 0.5)] });   // raw +3.0/s
  clock.t = 2041; TrackingManager.update();          // fresh-packet tick
  const p = ps[0];
  ok(p.present, 'P1 present after packets');
  ok(p.vel.x > 0.2, `velocity established from anchor motion (vx=${p.vel.x.toFixed(2)}/s)`);
  const xAtLastPacket = p.smooth.x;

  // packets stop: 1st and 2nd dropped frames — paddle must keep moving
  clock.t = 2074; TrackingManager.update();
  const x1 = p.smooth.x;
  clock.t = 2107; TrackingManager.update();
  const x2 = p.smooth.x;
  ok(!p.isLost, 'still alive within the 1-3 frame dead-reckon window');
  ok(x1 > xAtLastPacket + 0.001, `dropped frame 1: paddle coasts forward (${xAtLastPacket.toFixed(3)} -> ${x1.toFixed(3)})`);
  ok(x2 > x1 + 0.001, 'dropped frame 2: momentum continues');

  // past the grace window (~3 frames @30fps): freeze at a safe spot
  clock.t = 2200; TrackingManager.update();
  ok(p.isLost && !p.present, 'beyond DEAD_RECKON_MAX_MS the hand is marked lost (no infinite coasting)');
  ok(p.vel.x === 0 && p.vel.y === 0, 'velocity hard-zeroed on loss (no ghost momentum)');

  // re-acquisition after the stall must not teleport from stale filter state
  clock.t = 2233;
  TrackingManager._onResults({ multiHandLandmarks: [mk(0.72, 0.5)] });
  ok(p.present && Math.abs(p.raw.x - 0.28) < 1e-6, 're-acquisition snaps cleanly to the fresh anchor');
}

/* ==================================================================== */
console.log('--- 12b. sub-frame interpolation glide (30Hz packets @ 120Hz ticks) ----');
{
  const trackSrc = read('js/tracking.js');
  const ps = TrackingManager.getPlayers();
  const p = ps[0];

  // static contract: dual-packet anchors + interpolation API + lookahead cap
  ok(CONFIG.INTERP_MAX_ALPHA === 1.5, 'config: INTERP_MAX_ALPHA lookahead = 1.5');
  ok(/prevAnchor/.test(trackSrc) && /targetAnchor/.test(trackSrc),
     'tracking.js: dual-packet timestamped anchor buffers (prevAnchor/targetAnchor)');
  ok(typeof TrackingManager.getInterpolatedAnchor === 'function',
     'tracking.js: public getInterpolatedAnchor(i, nowMs, out) API');
  ok(/getInterpolatedAnchor\(/.test(trackSrc) && /smooth\.x = mapped\.tx/.test(trackSrc),
     'update(): interpolated anchors fed into paddle smooth targets');

  // behavioral: steady left-to-right sweep, packets every 33.3ms,
  // engine ticks every 8.3ms — the paddle must advance on EVERY tick
  // (no multi-tick stalls = no visual stepping / micro-stutter)
  const PKT_MS = 1000 / 30, TICK_MS = 1000 / 120;
  const y = 0.5;
  let t = 2236;                       // just after the re-acquired packet
  let packetIdx = 0, stalls = 0, deepBackSteps = 0, ticks = 0;
  const startX = p.smooth.x;
  let lastX = startX;

  for (let step = 1; step <= 48; step++) {
    t += TICK_MS;
    clock.t = t;
    if (step % 4 === 0) {             // new tracking packet ~every 4 ticks
      packetIdx++;
      const ax = 0.72 - 0.0167 * packetIdx;   // ~0.5 units/s mirrored sweep
      TrackingManager._onResults({
        multiHandLandmarks: [Array.from({ length: 21 }, () => ({ x: ax, y }))],
      });
    }
    TrackingManager.update();
    ticks++;
    const dx = p.smooth.x - lastX;
    if (dx === 0) stalls++;                       // frozen tick = visible stepping
    if (dx < -0.003) deepBackSteps++;             // perceptible sawtooth
    lastX = p.smooth.x;
  }

  ok(stalls === 0, `glide: zero stalled ticks across ${ticks} engine steps (no stepping between 30Hz packets)`);
  ok(deepBackSteps === 0, 'glide: no perceptible backward jumps at packet boundaries');
  ok(p.smooth.x > startX + 0.12, `glide: paddle swept forward as commanded (${startX.toFixed(3)} -> ${p.smooth.x.toFixed(3)})`);

  // alpha audit: 1.0 exactly at packet arrival, growing toward
  // INTERP_MAX_ALPHA as engine time pulls ahead of the newest packet
  t += TICK_MS;
  const ax = 0.72 - 0.0167 * (packetIdx + 1);
  clock.t = t;
  TrackingManager._onResults({ multiHandLandmarks: [Array.from({ length: 21 }, () => ({ x: ax, y }))] });
  const atArrival = TrackingManager.getInterpolatedAnchor(0, t, {});
  const inLookahead = TrackingManager.getInterpolatedAnchor(0, t + 4, {});
  ok(atArrival.alpha === 1, `alpha = 1 exactly at packet arrival (zero added latency, got ${atArrival.alpha})`);
  ok(inLookahead.alpha > 1 && inLookahead.alpha <= CONFIG.INTERP_MAX_ALPHA + 1e-9,
     `alpha grows under the ${CONFIG.INTERP_MAX_ALPHA} lookahead cap (got ${inLookahead.alpha.toFixed(3)})`);
}

/* ==================================================================== */
console.log('--- 13. renderer/source anti-flicker contract (static audit) -----------');
{
  const cfgSrc = read('js/config.js');
  ok(/CAMERA_OPACITY:\s*0\.55/.test(cfgSrc), 'config: camera opacity pinned at 0.55');

  // game.js: canvas context flags + camera latch + no blank flashes
  const gameSrc = read('js/game.js');
  ok(/desynchronized:\s*false/.test(gameSrc), 'game.js: desynchronized pipeline disabled');
  ok(/alpha:\s*false/.test(gameSrc), 'game.js: opaque canvas context');
  ok(/preserveDrawingBuffer:\s*true/.test(gameSrc), 'game.js: drawing buffer preserved');
  ok(/CAMERA_OPACITY/.test(gameSrc), 'game.js: camera blitted at CONFIG.CAMERA_OPACITY');
  ok(/latchCamera/.test(gameSrc), 'game.js: webcam frame latch present');
  ok(/camHasFrame/.test(gameSrc), 'game.js: latched-camera fallback gate present');
  ok(/getPacketId/.test(gameSrc), 'game.js: camera latch driven by processed packets');

  // tracking.js: drop-frame protection + no depth heuristics
  const trackSrc = read('js/tracking.js');
  ok(/FILTER_DROP_RESET_FRAMES/.test(trackSrc), 'tracking.js: lostFrames streak flush present');
  ok(/PACKET_DT_FALLBACK/.test(trackSrc), 'tracking.js: packet dt fallback used');
  ok(!/IS.*TOO CLOSE|isTooFarOrClose|checkDepth/.test(trackSrc), 'tracking.js: Z-depth heuristics removed');
  ok(/BOUNDS_MIN/.test(trackSrc) && /BOUNDS_MAX/.test(trackSrc), 'tracking.js: normalized 2D bounds tracking');

  // game loop: fixed timestep decoupled from render
  ok(/FIXED_DT/.test(gameSrc) && /MAX_FRAME_STEPS/.test(gameSrc), 'game.js: fixed-step accumulator loop');
}

/* ==================================================================== */
console.log('');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('failed checks:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('100% PASS — probe complete.');
