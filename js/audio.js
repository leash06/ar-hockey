/**
 * audio.js
 * ==========================================================================
 * Web Audio sound manager (synthesized — no asset files, no build deps).
 *
 * API: unlock(), setEnabled(v), isEnabled(), click(), hit(s), wall(s),
 *      goal(), alarmBuzz()
 *
 * All routines are lazy: the AudioContext is created on the first call of
 * unlock() (wired to a user gesture), so autoplay policy is never violated.
 * Tone schedules reuse short oscillator envelopes; nothing is allocated
 * per playing frame.
 * ==========================================================================
 */

const soundManager = (() => {

  let ac = null;
  let master = null;
  let enabled = true;

  function ensure() {
    if (!ac) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      ac = new Ctor();
      master = ac.createGain();
      master.gain.value = 0.5;
      master.connect(ac.destination);
    }
    if (ac.state === 'suspended') { try { ac.resume(); } catch (e) { /* noop */ } }
    return true;
  }

  /** quick sweep tone: freq f0 -> f1 over dur seconds on the given wave */
  function tone(f0, f1, dur, type, vol, when = 0) {
    if (!enabled || !ensure()) return;
    const t0 = ac.currentTime + when;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain); gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noiseBurst(dur, vol) {
    if (!enabled || !ensure()) return;
    const len = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ac.createBufferSource();
    const gain = ac.createGain();
    gain.gain.value = vol;
    src.buffer = buf;
    src.connect(gain); gain.connect(master);
    src.start();
  }

  return {

    /** call once from any user gesture to satisfy autoplay policy */
    unlock() { try { ensure(); } catch (e) { /* noop */ } },

    setEnabled(v) { enabled = !!v; },
    isEnabled: () => enabled,

    click() { tone(760, 620, 0.06, 'square', 0.10); },

    /** menu-cursor hover blip */
    hover() { tone(980, 1100, 0.05, 'sine', 0.07); },

    /** paddle hit: low thwack scaled by impact strength (0..1) + snap */
    hit(s = 0.5) {
      const k = Math.max(0.15, Math.min(1, s));
      tone(150 + 240 * k, 85, 0.09, 'triangle', 0.28 + 0.3 * k);
      noiseBurst(0.05, 0.10 + 0.15 * k);
    },

    /** wall bounce: dull thud */
    wall(s = 0.4) {
      const k = Math.max(0.1, Math.min(1, s));
      tone(130, 75, 0.06, 'sine', 0.16 + 0.20 * k);
    },

    /** goal fanfare: small rising arpeggio + noise sparkle */
    goal() {
      tone(392, 392, 0.12, 'square', 0.16, 0.00);
      tone(523, 523, 0.12, 'square', 0.16, 0.12);
      tone(659, 659, 0.20, 'square', 0.18, 0.24);
      noiseBurst(0.25, 0.08);
    },

    /** lost-hand / out-of-bounds warning buzz */
    alarmBuzz() {
      tone(180, 180, 0.10, 'sawtooth', 0.12);
      tone(150, 150, 0.10, 'sawtooth', 0.10, 0.12);
    },
  };
})();

if (typeof window !== 'undefined') {
  window.soundManager = soundManager;
}
