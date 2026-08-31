/**
 * yaPDP — Shared clipboard paste helper.
 *
 * Every terminal paste path (the VT52 pages in pdp11-app.js and the user TTYs
 * in iopage.js) must turn Windows clipboard text into a stream of 7-bit bytes
 * for the emulated DL11, optionally folding CRLF/CR/LF into a single CR (the
 * historical "carriage return only" teletype convention). This module
 * centralises that logic so every paste handler stays a one-liner and the
 * normalization rules are defined once.
 *
 * The helper is DOM-free and takes an explicit runtime object, so it can be
 * unit-tested in Node (see tests/pasteutil.test.js), mirroring
 * src/contextmenu.js.
 *
 * Must be loaded before pdp11-app.js and iopage.js.
 */
"use strict";

var PasteUtil = (function () {
    // Convert clipboard text into an array of 7-bit ASCII bytes. When
    // `normalize` is true (the default), CRLF/CR/LF are folded to a single CR
    // first; the DL11 is 7-bit clean, so every byte is masked to 0x7F.
    function textToBytes(text, normalize) {
        if (normalize !== false) {
            text = String(text).replace(/\r\n/g, "\r").replace(/\n/g, "\r");
        }
        var bytes = [];
        for (var i = 0; i < text.length; i++) {
            bytes.push(text.charCodeAt(i) & 0x7F);
        }
        return bytes;
    }

    // Route bytes to a DL11 unit's receive queue (unit 0 -> dlReceiveQueue,
    // unit N -> dlReceiveQueueN). `win` is injectable for tests; the browser
    // global is used by default. A missing queue is a silent no-op.
    // In-page consumers use the internal bridge (__yapdpBridge) when present,
    // falling back to the legacy window surface for tests/older callers.
    function sendToUnit(unit, bytes, win) {
        win = win || (typeof window !== "undefined" ? window : null);
        if (!win || !bytes || !bytes.length) return;
        var bridge = win.__yapdpBridge;
        var q = bridge
            ? bridge.dlReceiveQueue
            : (unit === 0 ? win.dlReceiveQueue : win["dlReceiveQueue" + unit]);
        if (typeof q === "function") q(unit, bytes);
    }

    // Normalize clipboard text (CR/LF -> CR) and feed it into a unit's receive
    // queue.
    function pasteIntoUnit(unit, text, win) {
        sendToUnit(unit, textToBytes(text, true), win);
    }

    return {
        textToBytes: textToBytes,
        sendToUnit: sendToUnit,
        pasteIntoUnit: pasteIntoUnit
    };
})();

// Expose on window so pdp11-app.js and iopage.js can reference the singleton
// (the top-level `var` already makes it a global in classic scripts; this
// explicit assignment keeps it robust if the code is ever bundled).
if (typeof window !== "undefined") {
    window.PasteUtil = PasteUtil;
}
