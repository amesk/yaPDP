/**
 * panel-led.js
 * PDP-11/70 Panel nav-button status indicators.
 *
 * The PANEL sidebar button carries two live indicators driven from the
 * machine state (polled on a timer, like Hum in hum.js, because the CPU run
 * state changes in many places — front-panel CONT/START/HALT, the HALT
 * instruction, WAIT, RESET):
 *   - the green power lamp (.nav-led) — lit steadily while the machine is
 *     powered on, off otherwise;
 *   - a run-state icon in the top-left corner (.nav-run-icon) — hidden
 *     while the machine is off, a pause glyph while the CPU is halted, a
 *     play glyph while it is running.
 *
 * The pure helpers ledState() / runIcon() are DOM-free and unit-testable in
 * Node (see tests/panel-led.test.js). The visuals are pure CSS
 * (css/pdp11.css).
 *
 * Must be loaded AFTER pdp11.js (defines `panel`, `CPU` and the STATE_*
 * constants). start() is called from pdp11-app.js during bootstrap.
 */
"use strict";

var PanelLed = (function () {

    // CPU run state (mirror src/pdp11.js).
    var STATE_RUN = 0;

    // How often the indicators are re-synced with the machine state (ms).
    // Short enough that a START/HALT feels immediate, cheap enough to run
    // forever.
    var TICK_MS = 250;

    var timer = null;   // polling interval id
    var started = false;

    /**
     * Pure: should the power lamp be lit? (powered on -> lit)
     * @param {boolean} powerOn - machine is powered on (panel.powerSwitch >= 0)
     * @returns {"on"|"off"} lamp mode
     */
    function ledState(powerOn) {
        return powerOn ? "on" : "off";
    }

    /**
     * Pure: which run-state icon to show? (hidden while powered off, play
     * while running, pause otherwise)
     * @param {boolean} powerOn - machine is powered on (panel.powerSwitch >= 0)
     * @param {number}  runState - CPU.runState (STATE_RUN / STATE_HALT / ...)
     * @returns {"off"|"halt"|"run"} icon mode
     */
    function runIcon(powerOn, runState) {
        if (!powerOn) return "off";
        return (runState === STATE_RUN) ? "run" : "halt";
    }

    // Read the live machine state. Every access is guarded so the module is
    // safe even if the page is still initializing or a module is absent.
    function readState() {
        var powerOn = false;
        var runState = -1; // unknown -> treat as not running (pause icon)
        try {
            if (typeof panel !== 'undefined') powerOn = (panel.powerSwitch >= 0);
        } catch (err) { powerOn = false; }
        try {
            if (typeof CPU !== 'undefined') runState = CPU.runState;
        } catch (err) { runState = -1; }
        return { powerOn: powerOn, runState: runState };
    }

    // Re-read the machine state and apply the indicator classes to the Panel
    // nav button. Missing button / not-yet-loaded globals are no-ops.
    function update() {
        if (typeof document === 'undefined') return; // Node tests: no DOM
        var s = readState();
        var btn = document.querySelector('.nav-btn[data-page="panel"]');
        if (!btn) return;
        // Power lamp: lit only while the machine is powered on.
        var led = btn.querySelector('.nav-led');
        if (led) led.classList.toggle('power-on', ledState(s.powerOn) === 'on');
        // Run-state icon: hidden while powered off, pause while halted, play
        // while the CPU runs.
        var icon = btn.querySelector('.nav-run-icon');
        if (icon) {
            var mode = runIcon(s.powerOn, s.runState);
            icon.classList.toggle('off', mode === 'off');
            icon.classList.toggle('run', mode === 'run');
        }
    }

    function start() {
        if (started) return;
        started = true;
        if (typeof window !== 'undefined' && typeof setInterval === 'function') {
            timer = setInterval(update, TICK_MS);
        }
        update();
    }

    function stop() {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
        started = false;
    }

    return {
        TICK_MS: TICK_MS,
        ledState: ledState,
        runIcon: runIcon,
        start: start,
        stop: stop,
        update: update
    };
})();

if (typeof window !== 'undefined') {
    window.PanelLed = PanelLed;
}
