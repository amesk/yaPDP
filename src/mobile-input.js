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
 * The byte-translation helpers are DOM-free and take their inputs explicitly,
 * so they can be unit-tested in Node (see tests/mobile-input.test.js),
 * mirroring src/pasteutil.js.
 *
 * Must be loaded before pdp11-app.js.
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
        // tablet uses this same bridge.
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

    // --- The invisible backing textarea -------------------------------
    // opts: { onBytes: function (bytes) {}, document: <Document> }
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

        // True between compositionstart and compositionend. Mid-composition
        // input events carry partial text, so they are held back and only the
        // final string is sent once.
        var composing = false;

        function send(bytes) {
            if (bytes && bytes.length) onBytes(bytes);
        }

        function onInput(e) {
            if (composing || (e && e.isComposing)) return;
            var type = (e && e.inputType) || "";
            // Only character insertions. Deletions (Backspace) arrive via
            // keydown; the textarea stays empty, so there is nothing to delete
            // and no delete input to misread.
            if (type && type.indexOf("insert") !== 0) {
                ta.value = "";
                return;
            }
            var data = (e && typeof e.data === "string") ? e.data : ta.value;
            var bytes = translateInputData(data);
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
            send(bytes);
        }

        function onCompositionStart() { composing = true; }
        function onCompositionEnd(e) {
            composing = false;
            var data = (e && typeof e.data === "string") ? e.data : ta.value;
            var bytes = translateInputData(data);
            ta.value = "";
            send(bytes);
        }

        ta.addEventListener("input", onInput);
        ta.addEventListener("keydown", onKeydown);
        ta.addEventListener("compositionstart", onCompositionStart);
        ta.addEventListener("compositionend", onCompositionEnd);
        doc.body.appendChild(ta);

        return {
            element: ta,
            focus: function () { try { ta.focus(); } catch (err) { /* ignore */ } },
            blur: function () { try { ta.blur(); } catch (err) { /* ignore */ } },
            destroy: function () {
                ta.removeEventListener("input", onInput);
                ta.removeEventListener("keydown", onKeydown);
                ta.removeEventListener("compositionstart", onCompositionStart);
                ta.removeEventListener("compositionend", onCompositionEnd);
                if (ta.parentNode) ta.parentNode.removeChild(ta);
            }
        };
    }

    return {
        isCoarse: isCoarse,
        translateKeydown: translateKeydown,
        translateInputData: translateInputData,
        create: create
    };
})();

// Expose on window so pdp11-app.js can reference the singleton (the top-level
// `var` already makes it a global in classic scripts; this explicit assignment
// keeps it robust if the code is ever bundled).
if (typeof window !== "undefined") {
    window.MobileInput = MobileInput;
}
