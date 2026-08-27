/*
 * punchtape.js
 * Model 33 ASR paper-tape punch emulation (visual).
 *
 * Renders a vertical 8-channel paper tape next to the teletype: every byte
 * echoed to the operator console punches one row of holes. The fresh row
 * appears at the top, right under the punch head, and the already-punched
 * tape spills downwards. The tape is absolutely positioned and hangs from
 * the bottom of the cabinet down to the bottom of the window (its max-height
 * is set to the remaining viewport height), so it never resizes the page.
 * Once the tape is longer than that, its own scrollbar appears while the
 * fresh row stays visible at the top (the operator can scroll down to
 * inspect older tape).
 *
 * Encoding (8-track ASCII):
 *   - Tracks 1..7 (Д1..Д7) carry the 7-bit ASCII code, bit 1 = LSB.
 *   - Track 8 (Д8) is the parity track; left unpunched (0), matching the
 *     plain (no-parity) base state.
 *   - A continuous row of small feed (sprocket) holes runs between tracks
 *     3 and 4 and is always punched.
 *
 * The visual tape is deliberately driven from the actual ASCII codes rather
 * than any printed look-up table, so the punched pattern is always consistent
 * (e.g. '0' vs '8', DEL punches all seven tracks, SPACE punches its bit 6).
 *
 * Exposed as window.paperTape so it never collides with the existing
 * punch-buffer helpers in iopage.js (punchTapeAppend / punchBuffer).
 */
(function () {
    'use strict';

    /**
     * encodePunch(code) - Encode an 8-bit byte into 8 tape tracks.
     * Pure, DOM-free helper (unit-tested in Node).
     * @param {number} code - byte value (only low 7 bits are used)
     * @returns {number[]} 8 tracks [Д1..Д8], each 0 or 1.
     */
    function encodePunch(code) {
        var v = (code & 0x7F) | 0;
        var tracks = [];
        for (var b = 0; b < 7; b++) {
            tracks.push((v >> b) & 1);
        }
        tracks.push(0); // Д8 parity track, left unpunched
        return tracks;
    }

    var container = null; // #punchtape — the hanging tape (scroll viewport)
    var body = null;      // #punchtape__body — the tape content
    var cachedTop = -1;   // cached tape top offset for updateMaxHeight()
    var buffer = [];      // punched bytes on the current tape (for Save tape)
    // armedDepth = how many steps the punch head has been backed up by BSP
    // (0 = at the end, punching fresh rows). After BSP the next byte
    // overpunches the row that many rows back instead of adding a new row.
    var armedDepth = 0;

    /**
     * init() - Locate the #punchtape element, create the tape body and size
     * the tape window to hang from the punch down to the window edge. Safe to
     * call repeatedly; no-op when the element is absent (e.g. when the
     * operator console is a VT52 or the DOM is not ready).
     */
    function init() {
        if (typeof document === 'undefined') return;
        container = document.getElementById('punchtape');
        if (!container || body) return;
        body = document.createElement('div');
        body.id = 'punchtape__body';
        body.className = 'punchtape__body';
        container.appendChild(body);
        updateMaxHeight();
        if (typeof window !== 'undefined' && !container.__ptResizeBound) {
            container.__ptResizeBound = true;
            window.addEventListener('resize', function () {
                cachedTop = -1;
                updateMaxHeight();
            });
        }
    }

    /**
     * updateMaxHeight() - Size the hanging tape to reach the bottom of the
     * window: max-height = remaining viewport below the tape's top edge. The
     * tape is absolutely positioned (out of the document flow), so it never
     * resizes the teletype page; once its content exceeds this height its own
     * scrollbar appears. Recomputes only when the tape's top offset changes
     * (page shown, window resized), so per-character calls stay cheap.
     */
    function updateMaxHeight() {
        if (!container || typeof window === 'undefined') return;
        var top = container.getBoundingClientRect().top;
        if (Math.abs(top - cachedTop) < 1) return; // unchanged → skip reflow
        cachedTop = top;
        var maxH = window.innerHeight - top - 12; // 12px bottom margin
        if (maxH < 40) maxH = 40;
        // The tape hangs inside the CSS-scaled teletype rig (--tty-scale < 1,
        // set by installTeletypeScaling in pdp11-app.js): divide the LOCAL
        // max-height by the scale so the VISUAL tape still reaches the bottom
        // of the window.
        var scale = 1;
        var v = window.getComputedStyle(container).getPropertyValue('--tty-scale');
        var parsed = parseFloat(v);
        if (isFinite(parsed) && parsed > 0) scale = parsed;
        container.style.maxHeight = Math.floor(maxH / scale) + 'px';
    }

    function keepPunchVisible() {
        if (container) {
            // The fresh row is punched at the top (right under the punch head)
            // and the already-punched tape spills downwards, so the view always
            // rests at the top. Once the tape is longer than the window the
            // lower part runs out of view and the scrollbar appears; the
            // operator can scroll down to inspect the older tape.
            container.scrollTop = 0;
        }
    }

    function makeSpan(className) {
        var el = document.createElement('span');
        el.className = className;
        return el;
    }

    /**
     * renderRow(row, code) - Render one tape row (edge, tracks Д1..Д8 with
     * the feed holes) into an existing row element. Used for fresh rows and
     * for in-place overpunch re-rendering after BSP.
     */
    function renderRow(row, code) {
        row.innerHTML = '';
        var tracks = encodePunch(code);
        // Edge + tracks Д1..Д3 + feed holes + tracks Д4..Д8 + edge.
        row.appendChild(makeSpan('pt-cell'));
        for (var i = 0; i < 3; i++) {
            row.appendChild(makeSpan('pt-hole' + (tracks[i] ? ' on' : '')));
        }
        row.appendChild(makeSpan('pt-sprocket'));
        for (var j = 3; j < 8; j++) {
            row.appendChild(makeSpan('pt-hole' + (tracks[j] ? ' on' : '')));
        }
        row.appendChild(makeSpan('pt-cell'));
    }

    /**
     * punchChar(code) - Punch one byte: append a tape row with the correct
     * combination of holes and scroll the tape down. After BSP (backspace)
     * the punch head sits over an already-punched row, so the byte is
     * punched INTO that row in place instead — the holes OR together,
     * exactly like a real overpunch: RUB OUT (0x7F) turns the row into DEL
     * (all tracks punched), any other byte corrupts it the same way it
     * would on real hardware.
     * @param {number} code - byte value
     */
    function punchChar(code) {
        if (!body) init();
        if (!body) return;

        // Overpunch after BSP: the tape is pulled back, so the row under the
        // punch head (buffer[length - armedDepth]) is NOT part of the visible
        // tape — it sits inside the punch unit. Any punch overpunches that
        // row: the holes OR together, exactly like a real overpunch (RUB OUT
        // turns the row into DEL, all tracks punched; any other byte corrupts
        // it the same way real hardware would). The punch cycle advances the
        // tape one step, so the overpunched row reappears at the top of the
        // hanging tape and the next pulled-back row (if any) moves under the
        // head.
        if (armedDepth > 0) {
            var idx = buffer.length - armedDepth; // buffer index of the row under the head
            var merged = (buffer[idx] | (code & 0x7F)) & 0x7F;
            buffer[idx] = merged;
            var row = makeSpan('pt-row');
            renderRow(row, merged);
            if (body.firstChild) {
                body.insertBefore(row, body.firstChild);
            } else {
                body.appendChild(row);
            }
            armedDepth--;
            updateMaxHeight();
            keepPunchVisible();
            return;
        }

        buffer.push(code & 0x7F);
        var row = makeSpan('pt-row');
        renderRow(row, code);
        // Prepend: the fresh row appears right under the punch head, pushing
        // the already-punched tape downwards (the tape "grows" from the top).
        if (body.firstChild) {
            body.insertBefore(row, body.firstChild);
        } else {
            body.appendChild(row);
        }
        // Re-check the hanging height (cheap when the tape top is unchanged);
        // catches the case where the tape page was hidden at init time and is
        // only now becoming visible.
        updateMaxHeight();
        keepPunchVisible();
    }

    /**
     * clear() - Tear the tape off / rewind: drop all punched rows and bytes.
     * Returns true if there was actually something to tear off (punched rows on
     * the tape or bytes in the buffer), false if the tape was already empty.
     */
    function clear() {
        if (!body) init();
        var torn = false;
        if (body) {
            torn = body.childNodes.length > 0;
            body.innerHTML = '';
        }
        torn = torn || buffer.length > 0;
        buffer = [];
        armedDepth = 0;
        return torn;
    }

    /**
     * snapshot() - Capture the punched tape state (machine-state snapshot,
     * L2). Returns a plain object with the byte array; the DOM is not
     * touched. Absent UI (no #punchtape element) yields an empty tape.
     */
    function snapshot() {
        return { buffer: buffer.slice() };
    }

    /**
     * restore(bytes) - Re-render the hanging tape from a saved byte array
     * (machine-state snapshot, L2). Rebuilds the DOM rows and the buffer
     * without punching through the teletype path (no sound, no interrupts).
     * Returns the number of rows restored, or 0 if the tape UI is absent.
     */
    function restore(bytes) {
        if (!bytes || !bytes.length) { clear(); return 0; }
        if (!body) init();
        if (!body) return 0;
        body.innerHTML = '';
        buffer = [];
        armedDepth = 0;
        for (var i = 0; i < bytes.length; i++) {
            buffer.push(bytes[i] & 0x7F);
            var row = makeSpan('pt-row');
            renderRow(row, bytes[i]);
            if (body.firstChild) {
                body.insertBefore(row, body.firstChild);
            } else {
                body.appendChild(row);
            }
        }
        updateMaxHeight();
        keepPunchVisible();
        return buffer.length;
    }

    /**
     * backspace() - Punch-unit BSP: pull the tape back one step so the punch
     * head returns to the last-punched row. Punches nothing itself — the
     * newest row disappears into the punch unit (the hanging tail visibly
     * shortens) and the row one further back moves under the punch head.
     * The next punch (e.g. DELETE / RUB OUT) overpunches that row in place,
     * holes OR-ing together like a real overpunch. Each further BSP pulls
     * the tape one step further back, up to the oldest punched row.
     */
    function backspace() {
        if (!body) init();
        if (!body || !body.firstChild) return;
        if (armedDepth >= buffer.length) return; // already at the oldest row
        armedDepth++;
        // The top DOM row is the newest punch: it goes back into the punch
        // unit and out of sight. The row data stays in the buffer — the
        // punch cycle that overpunches it will bring it back to the top of
        // the hanging tape.
        body.removeChild(body.firstChild);
        updateMaxHeight();
    }

    /**
     * save() - Download the punched tape as a raw .ptap file (8-track bytes,
     * parity track omitted, matching the emulator's punch buffer format).
     */
    function save() {
        if (typeof document === 'undefined' || typeof Blob === 'undefined') return;
        var bytes = new Uint8Array(buffer);
        var blob = new Blob([bytes], { type: 'application/octet-stream' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'teletype-tape.ptap';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    // refreshHeight() - Re-measure the tape window after the teletype rig is
    // CSS-scaled (installTeletypeScaling in pdp11-app.js calls it once the
    // scale is applied, so the hanging tape still reaches the window bottom).
    function refreshHeight() {
        cachedTop = -1;
        updateMaxHeight();
    }

    window.paperTape = {
        encodePunch: encodePunch,
        init: init,
        punchChar: punchChar,
        backspace: backspace,
        clear: clear,
        save: save,
        snapshot: snapshot,
        restore: restore,
        refreshHeight: refreshHeight
    };
})();
