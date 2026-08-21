/**
 * hum.js
 * PDP-11/70 power-supply hum + fan noise (ambient machine sound).
 *
 * A real 11/70 is never silent while powered on: the mains transformer and
 * the cooling fans produce a characteristic low-frequency hum. This module
 * synthesizes that ambient sound with Web Audio on a DEDICATED AudioContext,
 * so it can never cut off or clash with:
 *   - the console teletype / LP11 sounds (HTMLAudioElement-based, see the
 *     G60Audio manager in g60printer.js), or
 *   - the VT52 key clicks (which use their own shared context in pdp11-app.js).
 *
 * The hum follows the machine state (read live each tick):
 *   - powered off (panel.powerSwitch < 0)   -> silent
 *   - powered on, CPU running (STATE_RUN)   -> full hum
 *   - powered on, halted/waiting            -> slightly softer idle hum
 *
 * The CONFIG flag "hum" (added in config.js) enables/disables the effect.
 * Because browsers block AudioContext until the first user gesture, the
 * update loop retries ctx.resume() on every tick, so the hum starts as soon
 * as the user has interacted with the page once — the same recovery pattern
 * used by G60Audio.startWhirr() in g60printer.js.
 *
 * Must be loaded AFTER config.js, pdp11.js (defines `panel` and the CPU state
 * constants) and pdp11-panel.js. The pure helper Hum.humLevel() is
 * DOM/audio-free and unit-testable in Node (see tests/hum.test.js).
 */
"use strict";

var Hum = (function () {

    // CPU run states (mirror src/pdp11.js).
    var STATE_RUN = 0;
    var STATE_HALT = 3;
    var STATE_WAIT = 2;

    // Master gains (0..1). A real 11/70 in a machine room is noticeably
    // loud: the power-supply hum and the cooling fans carry over the room.
    // These levels still keep the hum below the teletype/printer and the
    // VT52 key clicks, which remain the primary audible feedback.
    var GAIN_RUN = 0.12;
    var GAIN_IDLE = 0.08;

    var ctx = null;     // dedicated AudioContext (lazy, browser only)
    var master = null;  // master gain node -> destination
    var timer = null;   // update-loop interval id
    var started = false;

    /**
     * Pure state -> gain helper (DOM/audio-free, unit-testable).
     * @param {boolean} powerOn - machine is powered on (panel.powerSwitch >= 0)
     * @param {number}  runState - CPU.runState (STATE_RUN / STATE_HALT / ...)
     * @param {boolean} enabled - the CONFIG "hum" flag
     * @returns {number} desired master gain in [0, 1]
     */
    function humLevel(powerOn, runState, enabled) {
        if (!enabled) return 0;
        if (!powerOn) return 0;
        return (runState === STATE_RUN) ? GAIN_RUN : GAIN_IDLE;
    }

    // Build the Web Audio graph once (browser only). On failure (no AudioContext,
    // or an exception during setup) it silently returns false and stays quiet.
    function ensureContext() {
        if (ctx) return true;
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return false;
        try {
            ctx = new Ctx();
            master = ctx.createGain();
            master.gain.value = 0;
            master.connect(ctx.destination);

            // 50 Hz mains transformer buzz.
            var osc50 = ctx.createOscillator();
            osc50.type = 'sine';
            osc50.frequency.value = 50;
            var g50 = ctx.createGain();
            g50.gain.value = 0.5;
            osc50.connect(g50);
            g50.connect(master);
            osc50.start();

            // 100 Hz ripple — second harmonic of the rectified mains.
            var osc100 = ctx.createOscillator();
            osc100.type = 'sine';
            osc100.frequency.value = 100;
            var g100 = ctx.createGain();
            g100.gain.value = 0.25;
            osc100.connect(g100);
            g100.connect(master);
            osc100.start();

            // Fan noise: white noise through a low-pass filter. Louder than
            // the transformer tones, since the blowers dominate the room.
            var len = ctx.sampleRate; // 1 second buffer
            var buf = ctx.createBuffer(1, len, ctx.sampleRate);
            var data = buf.getChannelData(0);
            for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
            var noise = ctx.createBufferSource();
            noise.buffer = buf;
            noise.loop = true;
            var lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 500;
            var gn = ctx.createGain();
            gn.gain.value = 0.18;
            noise.connect(lp);
            lp.connect(gn);
            gn.connect(master);
            noise.start();

            return true;
        } catch (err) {
            ctx = null;
            master = null;
            return false;
        }
    }

    // Read the live machine state. Every access is guarded so the module is
    // safe even if the page is still initializing or a module is absent.
    function readState() {
        var enabled = false;
        var powerOn = false;
        var runState = STATE_RUN;
        try {
            // The global "mute" flag silences every sound source, so the hum
            // is enabled only when both the "hum" flag and "mute" are off.
            if (typeof Config !== 'undefined') {
                enabled = !!Config.get().hum && !Config.get().mute;
            }
        } catch (err) { enabled = false; }
        try {
            if (typeof panel !== 'undefined') powerOn = (panel.powerSwitch >= 0);
        } catch (err) { powerOn = false; }
        try {
            if (typeof CPU !== 'undefined') runState = CPU.runState;
        } catch (err) { runState = STATE_RUN; }
        return { enabled: enabled, powerOn: powerOn, runState: runState };
    }

    // Apply the desired level with a short ramp to avoid clicks, and retry
    // resume() while the context is suspended (autoplay lock).
    function applyLevel(level) {
        if (!master || !ctx) return;
        try {
            master.gain.setTargetAtTime(level, ctx.currentTime, 0.05);
            if (level > 0 && ctx.state === 'suspended') ctx.resume();
        } catch (err) { /* ignore audio errors */ }
    }

    // Re-read the machine state and adjust the hum. Called on a timer so the
    // hum follows state changes that originate inside the CPU core too.
    function update() {
        if (typeof window === 'undefined') return; // Node tests: no audio
        var s = readState();
        var level = humLevel(s.powerOn, s.runState, s.enabled);
        if (level > 0) {
            if (!ensureContext()) return;
            applyLevel(level);
        } else if (master) {
            applyLevel(0);
        }
    }

    function start() {
        if (started) return;
        started = true;
        if (typeof window !== 'undefined' && typeof setInterval === 'function') {
            timer = setInterval(update, 500);
        }
        update();
    }

    function stop() {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
        started = false;
        applyLevel(0);
    }

    return {
        GAIN_RUN: GAIN_RUN,
        GAIN_IDLE: GAIN_IDLE,
        humLevel: humLevel,
        start: start,
        stop: stop,
        update: update
    };
})();

if (typeof window !== 'undefined') {
    window.Hum = Hum;
    // Start the update loop once the DOM is ready. Audio stays locked until
    // the first user gesture, at which point ctx.resume() succeeds and the
    // hum becomes audible (the machine powers on with powerSwitch = 0).
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', Hum.start);
    } else {
        Hum.start();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Hum;
}
