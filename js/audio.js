/**
 * audio.js
 * ==========================================================================
 * SoundManager — zero-file procedural sound effects with the Web Audio API.
 *
 * All sounds are synthesized on the fly (oscillators + noise + envelopes),
 * so the project needs no external audio assets and works fully offline
 * once the page is loaded.
 *
 * Autoplay policy handling: browsers block AudioContext until a user
 * gesture happens. `SoundManager.unlock()` must be called from inside a
 * real user event (e.g. the Start button click / any pointerdown) — it
 * creates the AudioContext if needed and resumes it. All play*() calls
 * before unlocking are silently ignored instead of throwing.
 * ==========================================================================
 */

class SoundManager {

  constructor() {
    this.ctx = null;          // AudioContext, created lazily on first gesture
    this.master = null;       // master gain node (global volume)
    this.enabled = true;      // settings toggle (sound effects on/off)
    this._noiseBuffer = null; // cached white-noise buffer for thuds/clanks
    this._alarmAt = -999;     // last alarm start time (audio-context clock)
  }

  /* ------------------------------------------------------------------
   * Lifecycle / autoplay unlock
   * ------------------------------------------------------------------ */

  /**
   * Create & resume the AudioContext. MUST be called from a user-gesture
   * event handler (click / touch) to satisfy autoplay policies.
   * Safe to call repeatedly.
   */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return; // no Web Audio support -> stay silent
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5; // global volume
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /** Sound on/off switch (used by the settings toggle). */
  setEnabled(on) {
    this.enabled = !!on;
  }

  get isUnlocked() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /* ------------------------------------------------------------------
   * Internal helpers
   * ------------------------------------------------------------------ */

  /** lazily build 1 s of white noise, reused by all noise-based sounds */
  _noise() {
    if (!this._noiseBuffer) {
      const sr = this.ctx.sampleRate;
      this._noiseBuffer = this.ctx.createBuffer(1, sr, sr);
      const d = this._noiseBuffer.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    return src;
  }

  /* ------------------------------------------------------------------
   * PUBLIC FX
   * ------------------------------------------------------------------ */

  /**
   * Paddle hits puck — short punchy pop.
   * Pitch + volume scale with hit strength so a hard swing sounds harder.
   * @param {number} strength 0..1 (impact velocity / max impact)
   */
  hit(strength = 0.5) {
    this._fx(() => {
      const t = this.ctx.currentTime;
      const s = Math.max(0.15, Math.min(1, strength));

      // Body: quick downward-pitched sine "pop"
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      const base = 420 + 260 * s;                    // harder hit -> higher pitch
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * 0.4, t + 0.09);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5 * s + 0.12, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);

      // Snappy attack layer: tiny noise burst
      const noise = this._noise();
      const nf = this.ctx.createBiquadFilter();
      nf.type = 'bandpass';
      nf.frequency.value = 1800 + 800 * s;
      nf.Q.value = 1.2;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(0.25 * s, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);

      osc.connect(g); noise.connect(nf).connect(ng).connect(this.master);
      osc.start(t); noise.start(t);
      osc.stop(t + 0.12); noise.stop(t + 0.06);
    });
  }

  /** Wall / boundary bounce — soft dull thud. */
  wall(strength = 0.6) {
    this._fx(() => {
      const t = this.ctx.currentTime;
      const s = Math.max(0.2, Math.min(1, strength));

      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(70, t + 0.12);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35 * s, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);

      // Dull skin: low-passed noise
      const noise = this._noise();
      const nf = this.ctx.createBiquadFilter();
      nf.type = 'lowpass';
      nf.frequency.value = 500;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(0.18 * s, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);

      osc.connect(g); noise.connect(nf).connect(ng).connect(this.master);
      osc.start(t); noise.start(t);
      osc.stop(t + 0.18); noise.stop(t + 0.08);
    });
  }

  /**
   * Goal scored — ascending celebratory arpeggio (4 notes + shimmer).
   */
  goal() {
    this._fx(() => {
      const t0 = this.ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6

      notes.forEach((freq, i) => {
        const t = t0 + i * 0.09;
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(freq, t);

        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);

        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(4200, t);
        f.frequency.exponentialRampToValueAtTime(1500, t + 0.25);

        osc.connect(f).connect(g).connect(this.master);
        osc.start(t); osc.stop(t + 0.3);
      });

      // Sparkle: high sine sweep on top of the arpeggio
      const sp = this.ctx.createOscillator();
      sp.type = 'sine';
      sp.frequency.setValueAtTime(1046.5, t0 + 0.36);
      sp.frequency.exponentialRampToValueAtTime(2093, t0 + 0.55);
      const sg = this.ctx.createGain();
      sg.gain.setValueAtTime(0.0001, t0 + 0.36);
      sg.gain.exponentialRampToValueAtTime(0.12, t0 + 0.38);
      sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
      sp.connect(sg).connect(this.master);
      sp.start(t0 + 0.36); sp.stop(t0 + 0.62);
    });
  }

  /** UI feedback — tiny click/tick for buttons. */
  click() {
    this._fx(() => {
      const t = this.ctx.currentTime;

      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(900, t);
      osc.frequency.exponentialRampToValueAtTime(600, t + 0.04);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.15, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);

      osc.connect(g).connect(this.master);
      osc.start(t); osc.stop(t + 0.06);
    });
  }

  /**
   * Menu hover whoosh — soft filtered noise sweep when the hand cursor
   * highlights a different button. Throttled (~120 ms) so rapid cursor
   * movement can't machine-gun the sound.
   */
  hover() {
    this._fx(() => {
      const now = this.ctx.currentTime;

      // throttle: skip if the previous whoosh is younger than 120 ms
      if (now - (this._hoverAt || -999) < 0.12) return;
      this._hoverAt = now;

      const t = this.ctx.currentTime;
      const noise = this._noise();

      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 1.4;
      f.frequency.setValueAtTime(500, t);
      f.frequency.exponentialRampToValueAtTime(2600, t + 0.1);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

      noise.connect(f).connect(g).connect(this.master);
      noise.start(t); noise.stop(t + 0.14);
    });
  }

  /**
   * Out-of-bounds / accuracy alarm — short, high-frequency pulsing beeps
   * ("tit-tit-tit") built from a rapid oscillator + gain pulse loop.
   * Throttled: safe to call every animation frame from the game loop; only
   * one burst per CONFIG.OUT_OF_BOUNDS_ALARM_INTERVAL seconds is scheduled.
   */
  outOfBoundsAlarm() {
    this._fx(() => {
      const now = this.ctx.currentTime;

      // throttle — skip if the previous burst is still within its window
      if (now - this._alarmAt < CONFIG.OUT_OF_BOUNDS_ALARM_INTERVAL) return;
      this._alarmAt = now;

      for (let i = 0; i < 3; i++) {
        const t = now + i * 0.085;  // tit-tit-tit rhythm

        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(2200 + i * 160, t); // rising, urgent

        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.11, t + 0.006);  // sharp attack
        g.gain.setValueAtTime(0.11, t + 0.028);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05); // quick decay

        osc.connect(g).connect(this.master);
        osc.start(t); osc.stop(t + 0.06);
      }
    });
  }

  /* ------------------------------------------------------------------
   * Private wrapper: no-op until unlocked / when sound is disabled,
   * and never lets a sound error break the game loop.
   * ------------------------------------------------------------------ */
  _fx(fn) {
    if (!this.enabled || !this.isUnlocked) return;
    try {
      fn();
    } catch (e) {
      /* audio failure must never crash gameplay */
      console.warn('[SoundManager] fx error:', e);
    }
  }
}

/* Single shared instance (game.js uses this directly). */
window.soundManager = new SoundManager();
