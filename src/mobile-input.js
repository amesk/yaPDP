/**
 * yaPDP — Mobile on-screen keyboard bridge.
 *
 * Desktop input reaches the emulated terminals through physical keydown
 * events. Touch devices have no physical keyboard: typing must go through the
 * system's on-screen keyboard, which only appears for an editable element
 * (an <input> / <textarea>) — never for the <canvas> the CRT terminals render
 * into, nor for a plain page.
 *
 * This module centralises that bridge. It creates a visually invisible
 * <textarea> (1x1 px, opacity 0, pointer-events none — it never covers or
 * steals a tap), asks the browser for the on-screen keyboard by focusing it,
 * and translates the resulting input into the same 7-bit byte stream the
 * physical keydown handlers produce.
 *
 * Character input is read from the `input` event rather than `keydown`: on
 * Android (GBoard and others) a virtual key arrives as keydown with
 * keyCode 229 and key 'Unidentified' and carries no usable character — the
 * character is only visible in the `input` event's `data`. Special keys
 * (Enter, Backspace, Tab, Escape) still come through `keydown` with a proper
 * key name and are handled there.
 *
 * That keyboard also COMPOSES: the word being typed lives in the backing store
 * and is committed as a whole at compositionend. The composed characters are
 * sent as they arrive (see the composing section below), because holding them
 * back until the commit makes typing invisible on the tube and hands the machine
 * a whole line at once.
 *
 * That same IME route is why the OPERATOR keys cannot depend on the system
 * keyboard at all: with enterkeyhint="send" Enter becomes an IME action some
 * keyboards report with no keydown and no input at all, and Ctrl+letter is
 * unreachable — an on-screen keyboard never sets ctrlKey. The special-key bar
 * (src/mobile-keys.js) therefore sends those bytes itself, and this module
 * gives it the two pieces it needs:
 *   • the Ctrl LATCH — press CTRL, then one character on the system keyboard,
 *     and that character is sent as its control code (Ctrl+C = 0x03), which is
 *     exactly what a hardware Ctrl+key does;
 *   • the input TARGET registry — which terminal (console or user terminal,
 *     canvas or text mode, or the Model 33 teletype) the bar is typing into.
 *
 * The byte-translation helpers are DOM-free and take their inputs explicitly,
 * so they can be unit-tested in Node (see tests/mobile-input.test.js),
 * mirroring src/pasteutil.js.
 *
 * Must be loaded before mobile-keys.js and pdp11-app.js.
 */
"use strict";

var MobileInput = (function () {
    // --- Coarse-pointer detection -------------------------------------
    // True when the device is primarily touched (phones, tablets). A window
    // is injectable so the detection can be unit-tested without a DOM.
    function isCoarse(win) {
        win = win || (typeof window !== "undefined" ? window : null);
        if (!win) return false;
        try {
            if (win.matchMedia && win.matchMedia("(pointer: coarse)").matches) {
                return true;
            }
        } catch (err) { /* matchMedia unavailable — fall through */ }
        var touchPoints = win.navigator && win.navigator.maxTouchPoints;
        return typeof touchPoints === "number" && touchPoints > 0;
    }

    // --- keydown -> bytes ---------------------------------------------
    // Only the keys the on-screen keyboard reports with a stable name. The
    // resulting byte matches the physical keyboard handlers (Enter=CR,
    // Backspace=BS, Tab=HT, Escape=ESC) so both input paths are identical.
    // Returns null when the event carries no terminal byte (printable
    // characters are left to the `input` path).
    function translateKeydown(ev) {
        if (!ev) return null;
        var key = (typeof ev.key === "string") ? ev.key : "";
        var code = ev.keyCode || ev.which || 0;

        // Fixed-byte keys. Prefer the key name: mobile browsers may omit
        // keyCode on virtual key events.
        if (key === "Enter" || code === 13) return [13];
        if (key === "Backspace" || code === 8) return [8];
        if (key === "Tab" || code === 9) return [9];
        if (key === "Escape" || code === 27) return [27];

        // Ctrl+letter -> control code (Ctrl+A -> 0x01, ...). Rarely reachable
        // from an on-screen keyboard, but a hardware keyboard attached to a
        // tablet uses this same bridge. The on-screen route is the Ctrl latch
        // (setCtrlLatch), which needs no ctrlKey at all.
        if (ev.ctrlKey && !ev.altKey && !ev.metaKey && key.length === 1) {
            var c = key.toUpperCase().charCodeAt(0) - 64;
            if (c >= 1 && c <= 31) return [c];
        }
        return null;
    }

    // --- input data -> bytes ------------------------------------------
    // A line break (pasted, or produced by an IME's action key) becomes a
    // single CR — the teletype convention, and what the physical Enter
    // handler sends. Every other character is masked to 7 bits, exactly like
    // the paste path.
    function translateInputData(data) {
        if (!data) return [];
        data = String(data);
        var bytes = [];
        for (var i = 0; i < data.length; i++) {
            var ch = data.charCodeAt(i);
            if (ch === 13 || ch === 10) {
                // Fold CRLF into one CR.
                if (ch === 13 && i + 1 < data.length && data.charCodeAt(i + 1) === 10) i++;
                bytes.push(13);
                continue;
            }
            bytes.push(ch & 0x7F);
        }
        return bytes;
    }

    // --- Composing (IME) input ----------------------------------------
    // A virtual keyboard composes a word before committing it, so the text the
    // operator is typing is not in an `input` event's `data` — it is in the
    // backing store, and `input` fires with isComposing true. What has already
    // been delivered is remembered (composedSent), and the difference between it
    // and the composing text is the new keystroke. Two helpers, so the DOM-free
    // module can be tested without a composition.
    //
    // Only plain ASCII is delivered while composing: a CJK composition builds
    // its text out of a romanisation ("ni" -> 你), and those letters are not
    // what the operator means. The committed string is sent at compositionend.
    function isPlainAscii(text) {
        if (typeof text !== "string" || !text.length) return false;
        for (var i = 0; i < text.length; i++) {
            var c = text.charCodeAt(i);
            if (c < 0x20 || c > 0x7E) return false;
        }
        return true;
    }

    // The characters appended to a composition since the last delivery. A
    // rewrite (the IME replacing what it had composed) appends nothing.
    function composingDelta(previous, next) {
        previous = (typeof previous === "string") ? previous : "";
        next = (typeof next === "string") ? next : "";
        if (!next) return "";
        if (next.indexOf(previous) === 0) return next.slice(previous.length);
        return "";
    }

    // What the commit still owes the machine: the tail the composing path did
    // not deliver (the result of a romanised composition, for instance). A
    // rewrite yields nothing — the earlier text is already in the machine, and
    // sending a replacement would only duplicate it in the operator's line.
    function pendingComposition(text, sent) {
        text = (typeof text === "string") ? text : "";
        sent = (typeof sent === "string") ? sent : "";
        if (!sent) return text;
        return text.indexOf(sent) === 0 ? text.slice(sent.length) : "";
    }

    // --- The Ctrl latch -----------------------------------------------
    // A hardware terminal sends Ctrl+C as 0x03 because Ctrl clears the top
    // three bits of the key's ASCII value; the same arithmetic is what the
    // latch applies, so every key behaves as it does on a real keyboard
    // (Ctrl+[ = ESC, Ctrl+Space = NUL, Ctrl+S = X-OFF). Returns null when the
    // payload is not ONE printable ASCII character: an empty payload, a pasted
    // sentence or an IME result has no control code, and the latch stays on.
    function controlCode(data) {
        if (typeof data !== "string" || data.length !== 1) return null;
        var ch = data.charCodeAt(0);
        if (ch < 0x20 || ch > 0x7E) return null;
        return ch & 0x1F;
    }

    // One typing event through the latch. Returns the bytes to send and the
    // latch's state afterwards — the latch is consumed only by a character it
    // actually translated, so a stray key does not drop it silently.
    function applyCtrlLatch(data, latched) {
        if (latched) {
            var code = controlCode(data);
            if (code !== null) return { bytes: [code], latch: false };
        }
        return { bytes: translateInputData(data), latch: !!latched };
    }

    var ctrlLatched = false;
    var latchListeners = [];

    // Latch on/off. The bar (src/mobile-keys.js) lights its CTRL key, and the
    // bar must un-light it the moment a character consumes it.
    function setCtrlLatch(on) {
        on = !!on;
        if (on === ctrlLatched) return ctrlLatched;
        ctrlLatched = on;
        for (var i = 0; i < latchListeners.length; i++) {
            try { latchListeners[i](ctrlLatched); } catch (err) { /* ignore */ }
        }
        return ctrlLatched;
    }

    function isCtrlLatched() {
        return ctrlLatched;
    }

    function onLatchChange(fn) {
        if (typeof fn === "function") latchListeners.push(fn);
    }

    // --- Input targets ------------------------------------------------
    // Every terminal that accepts on-screen input registers here with the page
    // it lives on: the VT52 pages (canvas bridge and text-mode textarea share
    // one target) and the Model 33 teletype. The bar asks which terminal is on
    // screen, so the same strip of keys serves every one of them.
    var targets = [];
    var activeTarget = null;

    // opts: { id, pageId, unit, send(bytes), focus() }. Returns the target,
    // whose destroy() unregisters it.
    function registerTarget(opts) {
        opts = opts || {};
        var target = {
            id: opts.id || null,
            pageId: opts.pageId || null,
            unit: (typeof opts.unit === "number") ? opts.unit : null,
            send: (typeof opts.send === "function") ? opts.send : function () { },
            focus: (typeof opts.focus === "function") ? opts.focus : function () { }
        };
        target.destroy = function () {
            var i = targets.indexOf(target);
            if (i >= 0) targets.splice(i, 1);
            if (activeTarget === target) activeTarget = null;
        };
        targets.push(target);
        return target;
    }

    function setActive(target) {
        activeTarget = target || null;
    }

    function getActiveTarget() {
        return activeTarget;
    }

    // The target registered for a page — what the bar routes to while that page
    // is the visible one, so switching pages does not send the console's keys
    // to a user terminal.
    function findTarget(pageId) {
        if (!pageId) return null;
        for (var i = 0; i < targets.length; i++) {
            if (targets[i].pageId === pageId) return targets[i];
        }
        return null;
    }

    function sendToActive(bytes) {
        if (!activeTarget || !bytes || !bytes.length) return false;
        activeTarget.send(bytes);
        return true;
    }

    // Put the keyboard back on the terminal that is being typed into. The bar
    // calls this after every key: a browser that moved the focus to the button
    // would otherwise close the system keyboard and eat the next character.
    function focusActive() {
        if (!activeTarget) return;
        try { activeTarget.focus(); } catch (err) { /* ignore */ }
    }

    // --- The invisible backing textarea -------------------------------
    // opts: { onBytes: function (bytes) {}, document: <Document>,
    //         onActivate: function () {} }
    // Returns { element, focus(), blur(), destroy() }. A missing DOM yields a
    // harmless no-op object, so callers never need to guard.
    function create(opts) {
        opts = opts || {};
        var doc = opts.document || (typeof document !== "undefined" ? document : null);
        var onBytes = (typeof opts.onBytes === "function") ? opts.onBytes : function () { };
        var noop = {
            element: null,
            focus: function () { },
            blur: function () { },
            destroy: function () { }
        };
        if (!doc || !doc.createElement || !doc.body) return noop;

        var ta = doc.createElement("textarea");
        ta.className = "mobile-input";
        ta.setAttribute("autocomplete", "off");
        ta.setAttribute("autocorrect", "off");
        ta.setAttribute("autocapitalize", "none");
        ta.setAttribute("spellcheck", "false");
        ta.setAttribute("inputmode", "text");
        // The Enter key shows a "send"-style action on the on-screen keyboard.
        // Some keyboards deliver that action as an IME event with no keydown —
        // the special-key bar's own ↵ key is the reliable route (mobile-keys.js).
        ta.setAttribute("enterkeyhint", "send");
        ta.setAttribute("aria-hidden", "true");
        ta.tabIndex = -1;
        // Invisible yet focusable: 1x1 px, transparent, never interactive.
        // The 16px font stops iOS Safari from zooming the page on focus.
        ta.style.cssText = [
            "position:fixed", "top:0", "left:0",
            "width:1px", "height:1px", "padding:0", "margin:0",
            "border:0", "outline:none", "resize:none",
            "opacity:0", "pointer-events:none",
            "font-size:16px", "line-height:1",
            "caret-color:transparent", "z-index:-1"
        ].join(";");

        // True between compositionstart and compositionend, together with the
        // part of the composition already delivered (see sendComposing). An IME
        // composes the word in the backing store and commits it as a whole, so
        // the composed text is delivered keystroke by keystroke rather than held
        // back — holding it back is what made typing invisible.
        var composing = false;
        var composedSent = "";

        // Enter reaches us through three different paths depending on the
        // on-screen keyboard: keydown (key === "Enter"), and beforeinput/input
        // with inputType "insertLineBreak" or "insertParagraph". A single press
        // may fire more than one of them, so CR goes through sendEnter(), which
        // collapses such a burst into one carriage return.
        var ENTER_DEDUPE_MS = 60;
        var lastEnterAt = 0;

        function send(bytes) {
            if (bytes && bytes.length) onBytes(bytes);
        }

        function sendEnter() {
            var now = Date.now();
            if (now - lastEnterAt < ENTER_DEDUPE_MS) return;
            lastEnterAt = now;
            ta.value = "";
            send([13]);
        }

        // One typed character, through the Ctrl latch when it is on.
        function bytesFor(data) {
            var res = applyCtrlLatch(data, ctrlLatched);
            if (res.latch !== ctrlLatched) setCtrlLatch(res.latch);
            return res.bytes;
        }

        function isLineBreak(type) {
            return type === "insertLineBreak" || type === "insertParagraph";
        }

        // One input event from inside a composition: deliver the appended
        // characters one at a time, exactly like plain keystrokes. The backing
        // store is left alone — the IME still owns it until the commit.
        function sendComposing() {
            var delta = composingDelta(composedSent, ta.value);
            if (!delta || !isPlainAscii(delta)) return;
            composedSent += delta;
            send(bytesFor(delta));
        }

        // beforeinput fires ahead of the DOM change, so Enter handled here can
        // be cancelled before a newline ever lands in the backing store. Some
        // IMEs (notably Android at enterkeyhint="send") report the action only
        // this way, with no keydown at all.
        function onBeforeInput(e) {
            var type = (e && e.inputType) || "";
            if (!isLineBreak(type)) return;
            // The action key commits the composition and starts a new line in one
            // press: the CR belongs to the machine even though a composition was
            // open, and the composed text itself has already been delivered
            // character by character.
            if (typeof e.preventDefault === "function") e.preventDefault();
            sendEnter();
        }

        function onInput(e) {
            if (e && e.isComposing) { sendComposing(); return; }
            if (composing) return;
            var type = (e && e.inputType) || "";
            // Enter as a line break: send CR whether or not the event carries
            // text — some keyboards report this with an empty `data`.
            if (isLineBreak(type)) {
                sendEnter();
                return;
            }
            // Only character insertions. Deletions (Backspace) arrive via
            // keydown; the textarea stays empty, so there is nothing to delete
            // and no delete input to misread.
            if (type && type.indexOf("insert") !== 0) {
                ta.value = "";
                return;
            }
            // Prefer the event's own data, but never treat an empty string as
            // the payload: fall back to the (just changed) backing store.
            var data = (e && typeof e.data === "string" && e.data.length)
                ? e.data
                : ta.value;
            var bytes = bytesFor(data);
            // Keep the backing store empty: the next keystroke is then a clean
            // single-character insert and native undo/autocorrect never
            // accumulates state.
            ta.value = "";
            send(bytes);
        }

        function onKeydown(e) {
            if (composing) return;
            var bytes = translateKeydown(e);
            if (!bytes) return;
            if (typeof e.preventDefault === "function") e.preventDefault();
            // Enter may also arrive as an input insertLineBreak afterwards; the
            // dedupe in sendEnter() keeps that from sending a second CR.
            if (bytes.length === 1 && bytes[0] === 13) {
                sendEnter();
                return;
            }
            ta.value = "";
            send(bytes);
        }

        function onCompositionStart() {
            composing = true;
            composedSent = "";
        }

        function onCompositionEnd(e) {
            composing = false;
            var data = (e && typeof e.data === "string" && e.data.length)
                ? e.data
                : ta.value;
            // Only what the composing path has not delivered: its plain-ASCII
            // part went out keystroke by keystroke.
            var pending = pendingComposition(data, composedSent);
            composedSent = "";
            ta.value = "";
            send(bytesFor(pending));
        }

        // The keyboard is up on THIS terminal: the bar's keys must land here.
        function onFocus() {
            if (typeof opts.onActivate === "function") opts.onActivate();
        }

        ta.addEventListener("beforeinput", onBeforeInput);
        ta.addEventListener("input", onInput);
        ta.addEventListener("keydown", onKeydown);
        ta.addEventListener("compositionstart", onCompositionStart);
        ta.addEventListener("compositionend", onCompositionEnd);
        ta.addEventListener("focus", onFocus);
        doc.body.appendChild(ta);

        return {
            element: ta,
            focus: function () { try { ta.focus(); } catch (err) { /* ignore */ } },
            blur: function () { try { ta.blur(); } catch (err) { /* ignore */ } },
            destroy: function () {
                ta.removeEventListener("beforeinput", onBeforeInput);
                ta.removeEventListener("input", onInput);
                ta.removeEventListener("keydown", onKeydown);
                ta.removeEventListener("compositionstart", onCompositionStart);
                ta.removeEventListener("compositionend", onCompositionEnd);
                ta.removeEventListener("focus", onFocus);
                if (ta.parentNode) ta.parentNode.removeChild(ta);
            }
        };
    }

    return {
        isCoarse: isCoarse,
        translateKeydown: translateKeydown,
        translateInputData: translateInputData,
        controlCode: controlCode,
        applyCtrlLatch: applyCtrlLatch,
        isPlainAscii: isPlainAscii,
        composingDelta: composingDelta,
        pendingComposition: pendingComposition,
        setCtrlLatch: setCtrlLatch,
        isCtrlLatched: isCtrlLatched,
        onLatchChange: onLatchChange,
        registerTarget: registerTarget,
        setActive: setActive,
        getActiveTarget: getActiveTarget,
        findTarget: findTarget,
        sendToActive: sendToActive,
        focusActive: focusActive,
        create: create
    };
})();

// Expose on window so pdp11-app.js can reference the singleton (the top-level
// `var` already makes it a global in classic scripts; this explicit assignment
// keeps it robust if the code is ever bundled).
if (typeof window !== "undefined") {
    window.MobileInput = MobileInput;
}
