/*
 * reader.js
 * Model 33 ASR paper-tape READER emulation (visual + functional).
 *
 * The reader sits below the punch in the ASR tape unit. A tape is loaded
 * through the "Load tape" operator button (a .ptap raw byte file, a
 * .ptap.zst zstd-compressed tape, or a .txt whose characters become 7-bit
 * ASCII codes). The full tape is rendered hanging from the reader slot down
 * to the bottom of the window — the same 8-track row layout as the punched
 * tape (encodePunch from punchtape.js), with the same ragged free end.
 *
 * Reading follows the real ASR-33 mechanics, governed by the four-position
 * reader switch (START / STOP / FREE / AUTO) and the CCU (LINE / OFF /
 * LOCAL):
 *   - START: the reader motor runs continuously and every byte on the tape
 *     is sent to the machine at the console speed (authentic ~10 chars/sec,
 *     or the fast development pace from CONFIG), regardless of whether the
 *     guest reads it.
 *   - AUTO: remote-controlled. One byte is sent when the mode is engaged
 *     (or when DC1 / X-ON, 0x11 resumes a paused reader); each further byte
 *     is sent only after the DL11 receiver has accepted the previous one
 *     ("input drained"), paced no faster than the reader motor. DC3 / X-OFF
 *     (0x13) pauses the reader until the next X-ON.
 *   - STOP / FREE: the reader is paused. In STOP and FREE the operator can
 *     pull the tape out with the "Remove tape" button (shown only while
 *     the reader is paused).
 *   - The CCU routes every read byte exactly like the keyboard: in LOCAL
 *     the byte only prints on the teletype paper (a tape-to-paper copy,
 *     nothing reaches the machine); in LINE it is sent to the machine and
 *     printed by the machine's echo — printing it locally as well would
 *     double every character on echoing guests. When the punch is engaged
 *     (ON or DC2) the byte is punched onto the output tape in both modes —
 *     in LOCAL via the print path, in LINE via the echo — so the reader
 *     doubles as a tape-to-tape duplicator, the classic ASR trick.
 *   - CCU OFF powers the whole unit down: the reader never feeds.
 *
 * As bytes are read the tape visibly moves up through the reader slot; once
 * the remaining tape is shorter than the window it shortens, its ragged end
 * rising towards the reader. When the last byte is read the tape has gone
 * into the machine: the reader is empty and a new tape can be loaded.
 *
 * Exposed as window.tapeReader, mirroring window.paperTape (punchtape.js).
 * The DL11 console input path (iopage.js) calls window.onConsoleInputDrained
 * when its typeahead empties; the reader listens for that signal in AUTO.
 */
(function () {
    'use strict';

    // ---- Pure helpers (unit-tested in Node) -----------------------------

    // Same speed map as pdp11-app.js (teletypeDelay): authentic 110 baud
    // (~10 chars/sec) vs the fast development pace (~33 chars/sec).
    var CHAR_DELAY_MS = { authentic: 100, fast: 30 };

    /**
     * readerDelay(speed) - Millisecond pacing between fed bytes.
     * @param {string} speed - Config.teletypeSpeed ('authentic' | 'fast').
     * @returns {number} delay in ms.
     */
    function readerDelay(speed) {
        return CHAR_DELAY_MS[speed] || 30;
    }

    /**
     * currentDelay() - The configured console speed, read live from Config.
     */
    function currentDelay() {
        var cfg = (typeof Config !== 'undefined' && typeof Config.get === 'function') ? Config.get() : null;
        return readerDelay(cfg ? cfg.teletypeSpeed : null);
    }

    /**
     * bytesFromFile(data, fileName) - Turn a loaded file into the byte array
     * that will be read from the tape.
     *   .ptap     raw 8-track bytes (the punch's Save tape format).
     *   .ptap.zst zstd-compressed raw bytes, decompressed via fzstd.
     *   .txt      plain text; each character becomes one 7-bit tape byte
     *             (CR/LF and \f page breaks are kept, matching the LP11
     *             "Save .txt" export).
     * Returns null for an empty (or undecodable) tape.
     * @param {ArrayBuffer} data - file contents.
     * @param {string} fileName - original file name (extension decides).
     * @returns {Uint8Array|null}
     */
    function bytesFromFile(data, fileName) {
        var lower = (fileName || '').toLowerCase();
        var bytes;
        if (lower.slice(-4) === '.zst') {
            if (typeof fzstd === 'undefined' || typeof fzstd.decompress !== 'function') return null;
            var raw = fzstd.decompress(new Uint8Array(data));
            bytes = (raw instanceof Uint8Array) ? raw : new Uint8Array(raw);
        } else if (lower.slice(-4) === '.txt') {
            var text = (typeof TextDecoder !== 'undefined')
                ? new TextDecoder('utf-8').decode(new Uint8Array(data))
                : String.fromCharCode.apply(null, new Uint8Array(data));
            bytes = new Uint8Array(text.length);
            for (var i = 0; i < text.length; i++) {
                bytes[i] = text.charCodeAt(i) & 0x7F;
            }
        } else {
            bytes = new Uint8Array(data);
        }
        return bytes.length ? bytes : null;
    }

    // ---- DOM state ------------------------------------------------------

    var container = null; // #readertape — the hanging tape (scroll viewport)
    var body = null;      // #readertape__body — the tape content
    var cachedTop = -1;   // cached tape top offset for updateMaxHeight()
    var tapeBytes = null; // Uint8Array of the loaded tape
    var pos = 0;          // index of the next byte to read
    var timer = null;     // START-mode feed timer
    var lastFeed = 0;     // timestamp of the last fed byte (AUTO pacing)
    var pendingAuto = false; // an AUTO feed is owed (pacing delay running)

    /**
     * init() - Locate the #readertape element, create the tape body and size
     * the tape window to hang from the reader down to the window edge. Safe
     * to call repeatedly; no-op when the element is absent.
     */
    function init() {
        if (typeof document === 'undefined') return;
        container = document.getElementById('readertape');
        if (!container || body) return;
        body = document.createElement('div');
        body.id = 'readertape__body';
        body.className = 'readertape__body';
        container.appendChild(body);
        updateMaxHeight();
        if (typeof window !== 'undefined' && !container.__rtResizeBound) {
            container.__rtResizeBound = true;
            window.addEventListener('resize', function () {
                cachedTop = -1;
                updateMaxHeight();
            });
        }
    }

    /**
     * updateMaxHeight() - Size the hanging tape to reach the bottom of the
     * window, exactly like the punched tape (see punchtape.js): max-height =
     * remaining viewport below the tape's top edge, divided by the CSS rig
     * scale so the VISUAL tape reaches the window bottom.
     */
    function updateMaxHeight() {
        if (!container || typeof window === 'undefined') return;
        var top = container.getBoundingClientRect().top;
        if (Math.abs(top - cachedTop) < 1) return;
        cachedTop = top;
        var maxH = window.innerHeight - top - 12;
        if (maxH < 40) maxH = 40;
        var scale = 1;
        var v = window.getComputedStyle(container).getPropertyValue('--tty-scale');
        var parsed = parseFloat(v);
        if (isFinite(parsed) && parsed > 0) scale = parsed;
        container.style.maxHeight = Math.floor(maxH / scale) + 'px';
    }

    function keepHeadVisible() {
        // The reader head is at the top of the tape: the view always rests
        // there so the operator sees the next row under the slot. Once the
        // tape is longer than the window the lower part runs out of view and
        // the scrollbar appears (the operator can scroll down to inspect).
        if (container) container.scrollTop = 0;
    }

    function makeSpan(className) {
        var el = document.createElement('span');
        el.className = className;
        return el;
    }

    /**
     * makeRow(code) - One 8-track tape row (same layout as punchtape.js:
     * edge + Д1..Д3 + feed holes + Д4..Д8 + edge).
     */
    function makeRow(code) {
        var tracks = (window.paperTape && typeof window.paperTape.encodePunch === 'function')
            ? window.paperTape.encodePunch(code)
            : encodePunchFallback(code);
        var row = makeSpan('pt-row');
        row.appendChild(makeSpan('pt-cell'));
        for (var i = 0; i < 3; i++) {
            row.appendChild(makeSpan('pt-hole' + (tracks[i] ? ' on' : '')));
        }
        row.appendChild(makeSpan('pt-sprocket'));
        for (var j = 3; j < 8; j++) {
            row.appendChild(makeSpan('pt-hole' + (tracks[j] ? ' on' : '')));
        }
        row.appendChild(makeSpan('pt-cell'));
        return row;
    }

    // Local fallback for encodePunch (kept in sync with punchtape.js): the
    // reader only ever runs in the browser where punchtape.js is loaded, so
    // this path is defensive.
    function encodePunchFallback(code) {
        var v = (code & 0x7F) | 0;
        var tracks = [];
        for (var b = 0; b < 7; b++) tracks.push((v >> b) & 1);
        tracks.push(0); // parity track, left unpunched
        return tracks;
    }

    /**
     * hasTape() - True while a tape is loaded and bytes remain to be read.
     */
    function hasTape() {
        return !!tapeBytes && pos < tapeBytes.length;
    }

    // ---- Feeding --------------------------------------------------------

    function canFeedNow() {
        return !!window.ttyReaderCanFeed && hasTape();
    }

    /**
     * feedByte() - Send the next tape byte to the console DL11 and advance
     * the tape: the top row disappears and the remaining tape moves up
     * through the reader slot. When the last byte is read the tape has gone
     * into the machine and the reader is empty.
     */
    function feedByte() {
        if (!hasTape()) { tapeConsumed(); return; }
        var b = tapeBytes[pos] & 0x7F;
        pos++;
        lastFeed = Date.now();
        // Audible tape-advance ratchet ("стрёкот"): every byte read from the
        // tape steps the reader's ratchet wheel one position. Synthesized in
        // pdp11-app.js (installTtyMechanicalSounds); absent in Node tests.
        if (typeof window !== 'undefined' &&
            typeof window.playReaderRatchet === 'function') {
            window.playReaderRatchet();
        }
        // CCU routing, exactly like the keyboard: LOCAL prints the tape on
        // paper only (tape -> paper copy, nothing reaches the machine);
        // LINE sends the byte to the machine, where the guest's echo prints
        // it — a local print here too would double every character on an
        // echoing guest (e.g. BASIC). The punch (when engaged) duplicates
        // the byte onto the output tape via the console print path in both
        // modes — the tape-to-tape copy programmers used to duplicate
        // tapes. OFF never reaches here: the CCU powers the reader down
        // (canFeedNow).
        if (window.ttyMode === 'local') {
            if (window.g60Console && typeof window.g60Console.writeChar === 'function') {
                window.g60Console.writeChar(b);
            }
        } else if (window.ttyMode === 'line') {
            // In-page feature: internal bridge first; legacy window surface
            // (?bridge=1-gated) as fallback for older callers.
            var bridge = window.__yapdpBridge;
            var q = bridge ? bridge.dlReceiveQueue : window.dlReceiveQueue;
            if (typeof q === 'function') q(0, [b]);
        }
        if (body && body.firstChild) {
            body.removeChild(body.firstChild);
            keepHeadVisible();
        }
        if (!hasTape()) tapeConsumed();
    }

    /**
     * tapeConsumed() - The whole tape has been read: stop the motor, drop
     * the (empty) tape and free the reader for a new load.
     */
    function tapeConsumed() {
        stopTimer();
        pendingAuto = false;
        tapeBytes = null;
        pos = 0;
        if (body) body.innerHTML = '';
    }

    function startTimer() {
        stopTimer();
        if (!hasTape()) return;
        // A self-re-scheduling timer so currentDelay() is re-read on every tick:
        // switching the CONFIG teletype speed to 'fast' mid-run (the reader is
        // already feeding) must take effect immediately, not only on the next
        // START. setInterval captured the delay once at launch and ignored the
        // live speed change.
        (function tick() {
            timer = setTimeout(function () {
                var mode = window.ttyReaderMode;
                var autoLocal = (mode === 'auto' && window.ttyMode === 'local');
                if ((mode === 'start' || autoLocal) && canFeedNow()) {
                    feedByte();
                } else if (!hasTape()) {
                    stopTimer();
                    return;
                }
                tick();
            }, currentDelay());
        })();
    }

    function stopTimer() {
        if (timer) { clearTimeout(timer); timer = null; }
    }

    /**
     * autoFeed() - AUTO-mode step: send one byte now unless the reader motor
     * needs to catch up (pacing), in which case the feed is scheduled. The
     * DL11 "input drained" signal drives the next byte (see onDrained).
     */
    function autoFeed() {
        pendingAuto = false;
        if (window.ttyReaderMode !== 'auto') return;
        if (!canFeedNow()) return;
        var wait = currentDelay() - (Date.now() - lastFeed);
        if (wait > 0) {
            pendingAuto = true;
            setTimeout(function () {
                pendingAuto = false;
                autoFeed();
            }, wait);
        } else {
            feedByte();
        }
    }

    /**
     * onDrained() - Called by iopage.js whenever the console DL11 typeahead
     * empties (the receiver accepted the previous byte). In AUTO this is the
     * signal that the machine is ready for the next tape byte.
     */
    function onDrained() {
        if (window.ttyReaderMode !== 'auto') return;
        if (window.ttyMode === 'local') return; // LOCAL: timer-paced (no DL11)
        if (pendingAuto) return; // a paced feed is already scheduled
        autoFeed();
    }

    /**
     * setMode(mode) - React to the reader switch: START runs the motor,
     * AUTO sends one byte and then follows the drained signal, STOP/FREE
     * pause the reader.
     */
    function setMode(mode) {
        if (mode === 'start') {
            pendingAuto = false;
            startTimer();
        } else if (mode === 'auto') {
            stopTimer();
            if (window.ttyMode === 'local') {
                startTimer(); // LOCAL: no DL11 handshake — printer-paced
            } else {
                autoFeed(); // one byte now, then one per drained signal
            }
        } else {
            stopTimer();
            pendingAuto = false;
        }
    }

    /**
     * onTtyMode() - The operator flipped the CCU (LINE/OFF/LOCAL) while a
     * tape was loaded. AUTO re-paces itself: in LOCAL it runs on the motor
     * timer (the printer is the "consumer"), in LINE it waits for the DL11
     * drained signal again. START/STOP/FREE need no change — feedByte()
     * routes every byte by the live CCU state.
     */
    function onTtyMode() {
        if (window.ttyReaderMode !== 'auto') return;
        stopTimer();
        pendingAuto = false;
        if (window.ttyMode === 'local') {
            startTimer();
        } else {
            autoFeed();
        }
    }

    // ---- Loading / removal ----------------------------------------------

    /**
     * loadBytes(bytes) - Insert a full tape: render every byte as a hanging
     * row (first byte under the reader head) and reset the read position.
     * Replaces any previously loaded tape.
     * @param {Uint8Array} bytes
     */
    function loadBytes(bytes) {
        if (!bytes || !bytes.length) return;
        stopTimer();
        pendingAuto = false;
        tapeBytes = bytes;
        pos = 0;
        if (!body) init();
        if (!body) return;
        body.innerHTML = '';
        for (var i = 0; i < tapeBytes.length; i++) {
            body.appendChild(makeRow(tapeBytes[i] & 0x7F));
        }
        updateMaxHeight();
        keepHeadVisible();
    }

    /**
     * removeTape() - STOP/FREE operator action: pull the tape out of the
     * reader. Returns true if a tape was actually loaded.
     */
    function removeTape() {
        stopTimer();
        pendingAuto = false;
        var had = !!tapeBytes;
        tapeBytes = null;
        pos = 0;
        if (body) body.innerHTML = '';
        return had;
    }

    // ---- Machine-state snapshot (L2, like the punched tape) -------------

    function snapshot() {
        if (!tapeBytes) return null;
        return {
            bytes: Array.prototype.slice.call(tapeBytes),
            pos: pos
        };
    }

    function restore(snap) {
        if (!snap || !snap.bytes || !snap.bytes.length) {
            removeTape();
            return;
        }
        loadBytes(new Uint8Array(snap.bytes));
        var read = Math.max(0, Math.min(snap.pos || 0, tapeBytes.length));
        pos = read;
        if (body) {
            for (var i = 0; i < read; i++) {
                if (body.firstChild) body.removeChild(body.firstChild);
            }
            keepHeadVisible();
        }
    }

    // refreshHeight() - Re-measure the tape window after the teletype rig is
    // CSS-scaled (installTeletypeScaling in pdp11-app.js calls it).
    function refreshHeight() {
        cachedTop = -1;
        updateMaxHeight();
    }

    window.tapeReader = {
        bytesFromFile: bytesFromFile,
        init: init,
        loadBytes: loadBytes,
        setMode: setMode,
        onTtyMode: onTtyMode,
        kick: autoFeed,
        removeTape: removeTape,
        hasTape: hasTape,
        snapshot: snapshot,
        restore: restore,
        refreshHeight: refreshHeight
    };
    // The DL11 console input path calls this when its typeahead drains.
    window.onConsoleInputDrained = onDrained;
})();
