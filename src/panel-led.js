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

    /**
     * Pure: the tooltip for the run-state icon — the last stop the machine
     * reported. The toast that announced it is long gone by the time the
     * operator looks at a dead machine, so the reason has to live on here.
     * @param {?{reason:string, pc:number, psw:number, step:boolean}} info
     *        CPU.haltReason (see notifyCpuHalt() in src/pdp11.js)
     * @returns {string} "" when there is nothing to say
     */
    function haltTitle(info) {
        if (!info || typeof info !== "object" || info.step) return "";
        var octal = (typeof HaltNotice !== "undefined" && HaltNotice.octal)
            ? HaltNotice.octal
            : function (n) { return (n >>> 0).toString(8); };
        var what = (info.reason === "runaway-trap")
            ? "unrecoverable trap"
            : "HALT instruction";
        return "Last stop: " + what + " at " + octal(info.pc) +
            " (PSW " + octal(info.psw) + ")";
    }

    // Read the live machine state. Every access is guarded so the module is
    // safe even if the page is still initializing or a module is absent.
    function readState() {
        var powerOn = false;
        var runState = -1; // unknown -> treat as not running (pause icon)
        var haltReason = null;
        try {
            if (typeof panel !== 'undefined') powerOn = (panel.powerSwitch >= 0);
        } catch (err) { powerOn = false; }
        try {
            if (typeof CPU !== 'undefined') {
                runState = CPU.runState;
                haltReason = CPU.haltReason || null;
            }
        } catch (err) { runState = -1; haltReason = null; }
        return { powerOn: powerOn, runState: runState, haltReason: haltReason };
    }

    // Clicking the run-state icon repeats the stop notice: the toast is
    // transient, the halt is not, and the operator needs a way to ask again.
    // Installed once per button, guarded so polling cannot stack listeners.
    function installClick(btn) {
        if (!btn || typeof btn.addEventListener !== 'function') return;
        if (btn.__haltNoticeClick) return;
        btn.__haltNoticeClick = true;
        btn.addEventListener('click', function () {
            var info = readState().haltReason;
            var notice = (typeof HaltNotice !== 'undefined' && HaltNotice.haltNotice)
                ? HaltNotice.haltNotice(info) : null;
            if (notice && typeof Toasts !== 'undefined' && Toasts.show) {
                Toasts.show(notice);
            }
        });
    }

    // Re-read the machine state and apply the indicator classes to the Panel
    // nav button. Missing button / not-yet-loaded globals are no-ops.
    function update() {
        if (typeof document === 'undefined') return; // Node tests: no DOM
        var s = readState();
        var btn = document.querySelector('.nav-btn[data-page="panel"]');
        if (!btn) return;
        installClick(btn);
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
            // Why the machine stands still — kept on the icon because the
            // announcing toast expires while the halt does not.
            icon.title = haltTitle(s.haltReason);
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
        haltTitle: haltTitle,
        start: start,
        stop: stop,
        update: update
    };
})();

if (typeof window !== 'undefined') {
    window.PanelLed = PanelLed;
}
