/**
 * yaPDP — Mobile special-key bar.
 *
 * The system on-screen keyboard gives a phone the alphabet and very little
 * else. Two things a PDP-11 operator cannot do without are missing from it:
 *
 *   • Enter. With enterkeyhint="send" the key becomes an IME ACTION, and some
 *     keyboards (GBoard among them) report that action as a composition with no
 *     keydown and no input event at all — the bridge in src/mobile-input.js
 *     never sees it, and CR arrives only every other attempt;
 *   • Ctrl+letter. An on-screen keyboard never sets ctrlKey, so ^C (interrupt),
 *     ^D/^Z (end of input), ^S/^Q (X-ON/X-OFF) and ESC are unreachable — the
 *     codes a guest like RT-11 asks for constantly.
 *
 * This module draws a strip of real buttons for exactly those keys. Every button
 * sends the byte a physical key sends, so nothing about the emulator's input path
 * changes: the bytes go through the same terminal target the typed ones do
 * (MobileInput's registry, so the bar always types into the terminal on screen).
 *
 * CTRL is a LATCH, not a modifier-hold: tap it (it lights up), then type one
 * character on the system keyboard, and that character is sent as its control
 * code — Ctrl+C = 0x03, Ctrl+[ = ESC — which is the arithmetic a hardware
 * keyboard performs (see applyCtrlLatch in src/mobile-input.js).
 *
 * The bar exists only on touch devices (the same isCoarse() test as the bridge)
 * and is placed by css/pdp11.css as part of the bottom stack, so it never covers
 * the navigation bar or the floating controls.
 *
 * Must be loaded after src/mobile-input.js and before src/pdp11-app.js.
 */
"use strict";

var MobileKeys = (function () {
    // `bytes` are the exact bytes the physical handlers send (see
    // installVT52Keyboard / g60Keyboard in src/pdp11-app.js), so the emulator
    // cannot tell a bar key from a hardware one.
    var KEYS = [
        { id: "cr", label: "\u21B5", bytes: [13], title: "Return \u2014 CR (0x0D)" },
        { id: "esc", label: "ESC", bytes: [27], title: "Escape (0x1B)" },
        { id: "tab", label: "TAB", bytes: [9], title: "Tab \u2014 HT (0x09)" },
        { id: "bs", label: "BS", bytes: [8], title: "Backspace (0x08)" },
        { id: "rub", label: "RUB", bytes: [127], title: "Rubout \u2014 DEL (0x7F)" },
        {
            id: "ctrl", label: "CTRL", latch: true,
            title: "Control: the next character becomes a control code"
        },
        { id: "c", label: "^C", bytes: [3], title: "Control-C \u2014 interrupt (0x03)" },
        { id: "d", label: "^D", bytes: [4], title: "Control-D \u2014 end of input (0x04)" },
        { id: "z", label: "^Z", bytes: [26], title: "Control-Z \u2014 end of file (0x1A)" },
        { id: "s", label: "^S", bytes: [19], title: "Control-S \u2014 X-OFF (0x13)" },
        { id: "q", label: "^Q", bytes: [17], title: "Control-Q \u2014 X-ON (0x11)" }
    ];

    // The pages the bar belongs to. It exists for the terminals that have NO
    // keyboard of their own drawn on the glass — the VT52 and the VT100. The
    // Model 33 ASR carries a full set of keycaps (CTRL/SHIFT/REPT/BREAK/HERE IS
    // on the punch keyboard, the rest on the printed one), and the Panel, Printer
    // and Config pages have nothing to type into, so there the bar stays hidden.
    var TERMINAL_PAGES = ["vt52-console", "vt52", "vt52-2"];

    var bar = null;
    var doc = null;

    function showsOn(page) {
        return TERMINAL_PAGES.indexOf(String(page)) !== -1;
    }

    function currentPage(d) {
        var active = (d || doc).querySelector(".page.active");
        if (!active || !active.id) return "";
        return active.id.replace(/^page-/, "");
    }

    // The app announces every page change (yapdp:pagechange, see switchPage in
    // src/pdp11-panel.js); the bar only follows it, so no page coupling here.
    function setPage(page) {
        if (!bar) return;
        bar.classList.toggle("hidden", !showsOn(page));
    }

    // The terminal the bar types into: the one on screen, falling back to the
    // one whose keyboard was raised last. Page first, because switching from a
    // user terminal back to the console must move the bar with it.
    function resolveTarget(document) {
        if (typeof MobileInput === "undefined") return null;
        var d = document || doc || (typeof globalThis !== "undefined" ? globalThis.document : null);
        var page = (d && d.querySelector) ? d.querySelector(".page.active") : null;
        var byPage = (page && page.id) ? MobileInput.findTarget(page.id) : null;
        return byPage || MobileInput.getActiveTarget();
    }

    // One key press. A latch key toggles; every other key sends its byte to the
    // current terminal and then puts the keyboard back on it — a browser that
    // moved the focus to the button would close the system keyboard and eat the
    // next character.
    function press(spec) {
        if (!spec || typeof MobileInput === "undefined") return false;
        if (spec.latch) {
            MobileInput.setCtrlLatch(!MobileInput.isCtrlLatched());
            return true;
        }
        var target = resolveTarget(null);
        if (!target) return false;
        // An explicit control key answers the latch: ^C after CTRL is still ^C,
        // never a control code built out of one.
        MobileInput.setCtrlLatch(false);
        target.send(spec.bytes.slice());
        MobileInput.setActive(target);
        try { target.focus(); } catch (err) { /* ignore */ }
        return true;
    }

    function renderLatch(on) {
        if (!bar) return;
        var btn = bar.querySelector('[data-key="ctrl"]');
        if (!btn) return;
        btn.classList.toggle("active", !!on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
    }

    function buildKey(d, spec) {
        var b = d.createElement("button");
        b.type = "button";
        b.className = "mobile-key";
        b.setAttribute("data-key", spec.id);
        // The bar must never take the keyboard's focus itself.
        b.setAttribute("tabindex", "-1");
        b.title = spec.title;
        b.textContent = spec.label;
        // Tapping a key keeps the caret (and the system keyboard) where it was.
        var hold = function (ev) {
            if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        };
        b.addEventListener("pointerdown", hold);
        b.addEventListener("mousedown", hold);
        b.addEventListener("click", function () { press(spec); });
        return b;
    }

    // Build the bar. A desktop gets nothing at all — the physical keyboard is
    // already there, and the strip would only eat screen space.
    function install(opts) {
        opts = opts || {};
        var d = opts.document || (typeof document !== "undefined" ? document : null);
        if (!d || !d.body || !d.createElement) return null;
        if (bar) return bar;
        if (typeof MobileInput === "undefined" || !MobileInput.isCoarse()) return null;

        doc = d;
        bar = d.createElement("div");
        bar.id = "mobile-keys";
        bar.className = "mobile-keys";
        bar.setAttribute("role", "toolbar");
        bar.setAttribute("aria-label", "Terminal special keys");
        for (var i = 0; i < KEYS.length; i++) bar.appendChild(buildKey(d, KEYS[i]));

        // The stylesheet keys the bottom stack off this class: the navigation
        // bar and the floating controls are moved clear of the strip, and only
        // on a device that actually has one.
        d.body.classList.add("mobile-keys-on");
        d.body.appendChild(bar);

        MobileInput.onLatchChange(renderLatch);
        renderLatch(MobileInput.isCtrlLatched());
        // Hidden until the active page says it belongs there.
        setPage(currentPage(d));
        d.addEventListener("yapdp:pagechange", function (ev) {
            setPage(ev && ev.detail ? ev.detail.page : "");
        });
        return bar;
    }

    function destroy() {
        if (!bar) return;
        if (bar.parentNode) bar.parentNode.removeChild(bar);
        if (doc && doc.body) doc.body.classList.remove("mobile-keys-on");
        bar = null;
    }

    return {
        KEYS: KEYS,
        TERMINAL_PAGES: TERMINAL_PAGES,
        install: install,
        setPage: setPage,
        showsOn: showsOn,
        destroy: destroy,
        press: press,
        resolveTarget: resolveTarget,
        isInstalled: function () { return !!bar; }
    };
})();

// Same explicit export as MobileInput: pdp11-app.js calls MobileKeys.install().
if (typeof window !== "undefined") {
    window.MobileKeys = MobileKeys;
}
