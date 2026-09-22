/**
 * yaPDP — "More…" overflow for the operator command strips.
 *
 * Every machine page carries a row of operator commands that the touch layout
 * docks as a strip along the top of the screen (see the pinned blocks in
 * src/touchzoom.js): the Model 33's operator controls (#teletype-controls), the
 * LP11 console keys (.lp11-console), the printer actions (.printer-actions) and
 * the front panel's action buttons (.panel-actions). On a phone several of those
 * rows are wider than the screen, and today each one simply scrolls sideways
 * (css/pdp11.css sets overflow-x: auto on the strip) — a command hidden past the
 * edge has no affordance at all.
 *
 * This module replaces that sideways scroll with a systematic overflow menu,
 * for EVERY strip, by the same rule: the strip is measured; if its commands do
 * not fit, the ones the markup marks with .action-secondary (the rare commands)
 * are MOVED into a "More…" menu, while the frequent ones keep their one-tap
 * place in the strip. When everything fits — a desktop, or a wide touch screen —
 * nothing moves and the menu stays hidden. A row that even the primary commands
 * cannot fit keeps the old sideways scroll as its fallback.
 *
 * The buttons are MOVED, never copied or cloned: their ids and the handlers the
 * app attached (initTtyControls() in src/pdp11-app.js, the inline onclick of the
 * printer/LP11/panel buttons) are position-independent, so a plain
 * insertBefore/appendChild keeps exactly one live control per command.
 *
 * The "More…" button and its menu are BUILT here (like the special-key bar in
 * src/mobile-keys.js and the quick-boot balloon), so a strip only has to mark
 * its rare commands in the markup — it does not carry any overflow plumbing.
 * The menu is a SIBLING of the strip: the strip has overflow-x: auto and would
 * clip a pop-up hanging below it. It is created inside the strip's own parent,
 * which on a touch device is the pinned layer (src/touchzoom.js), so a pinch
 * keeps the menu at the strip's own size and place.
 *
 * The module exists only on a coarse pointer (the same isCoarse() test as the
 * bridge, the special-key bar and the gesture layer), so a narrow desktop window
 * is left completely alone.
 *
 * Must be loaded after src/mobile-input.js and before src/pdp11-app.js.
 */
"use strict";

var ActionOverflow = (function () {
    // The command rows this module watches, and the class each row's own buttons
    // wear (the "More…" button is given the same class so it matches its strip).
    // The panel row has no shared button class of its own beyond .panel-action-btn.
    var STRIPS = [
        { selector: "#teletype-controls", buttonClass: "tty-btn" },
        { selector: ".lp11-console", buttonClass: "lp11-key" },
        { selector: ".printer-actions", buttonClass: "" },
        { selector: ".panel-actions", buttonClass: "panel-action-btn" }
    ];

    // The markup hook: a command that may fold into "More…" when a strip does
    // not fit. The frequent commands simply do not carry it.
    var SECONDARY_CLASS = "action-secondary";
    var MORE_CLASS = "action-more";
    var MORE_HIDDEN_CLASS = "action-more-hidden";
    var MENU_CLASS = "action-more-menu";
    var MENU_OPEN_CLASS = "action-more-open";

    // A scrollWidth may exceed the clientWidth by a rounding pixel; only a real
    // command (tens of px wide) counts as overflow.
    var OVERFLOW_TOLERANCE = 1;

    var doc = null;
    var entries = [];
    var installed = false;
    var onDocClick = null;
    var onDocKey = null;

    // The pure rule the layout turns on. Exported for the Node tests.
    function overflows(scrollWidth, clientWidth, tolerance) {
        var s = Number(scrollWidth);
        var c = Number(clientWidth);
        if (!isFinite(s) || !isFinite(c) || c <= 0) return false;
        var t = (typeof tolerance === "number" && isFinite(tolerance))
            ? tolerance : OVERFLOW_TOLERANCE;
        return s > c + t;
    }

    function isTouch() {
        return typeof MobileInput !== "undefined" && MobileInput.isCoarse();
    }

    function secondariesIn(strip) {
        var out = [];
        for (var i = 0; i < strip.children.length; i++) {
            var el = strip.children[i];
            if (el.classList && el.classList.contains(SECONDARY_CLASS)) out.push(el);
        }
        return out;
    }

    function buildMore(entry) {
        var btn = doc.createElement("button");
        btn.type = "button";
        btn.className = MORE_CLASS + " " + MORE_HIDDEN_CLASS;
        if (entry.buttonClass) btn.classList.add(entry.buttonClass);
        btn.setAttribute("aria-haspopup", "true");
        btn.setAttribute("aria-expanded", "false");
        btn.title = "More commands";
        btn.textContent = "More \u25BE";
        entry.strip.appendChild(btn);
        return btn;
    }

    function buildMenu(entry) {
        var menu = doc.createElement("div");
        menu.className = MENU_CLASS;
        var strip = entry.strip;
        strip.parentNode.insertBefore(menu, strip.nextSibling);
        return menu;
    }

    function collapse(entry) {
        if (entry.collapsed) return;
        for (var i = 0; i < entry.secondary.length; i++) {
            var btn = entry.secondary[i];
            if (btn.parentNode !== entry.menu) entry.menu.appendChild(btn);
        }
        entry.more.classList.remove(MORE_HIDDEN_CLASS);
        entry.strip.classList.add("action-collapsed");
        entry.collapsed = true;
    }

    function expand(entry) {
        if (!entry.collapsed) return;
        closeMenu(entry);
        // Restore in REVERSE order, each before its recorded anchor: an anchor
        // is the element that originally followed the button, so the original
        // order comes back even when a strip interleaves primary and secondary
        // commands (the panel's Help Me! sits BEFORE Bootstrap now!).
        for (var i = entry.secondary.length - 1; i >= 0; i--) {
            var btn = entry.secondary[i];
            if (btn.parentNode !== entry.strip) {
                entry.strip.insertBefore(btn, entry.anchor[i] || null);
            }
        }
        entry.more.classList.add(MORE_HIDDEN_CLASS);
        entry.strip.classList.remove("action-collapsed");
        entry.collapsed = false;
    }

    function openMenu(entry) {
        if (!entry.collapsed || !entry.menu) return;
        entry.menu.classList.add(MENU_OPEN_CLASS);
        entry.more.setAttribute("aria-expanded", "true");
    }

    function closeMenu(entry) {
        if (!entry.menu) return;
        entry.menu.classList.remove(MENU_OPEN_CLASS);
        if (entry.more) entry.more.setAttribute("aria-expanded", "false");
    }

    function closeAll() {
        for (var i = 0; i < entries.length; i++) closeMenu(entries[i]);
    }

    function isMenuOpen(entry) {
        return !!(entry.menu && entry.menu.classList.contains(MENU_OPEN_CLASS));
    }

    function toggleMenu(entry) {
        if (isMenuOpen(entry)) closeMenu(entry);
        else openMenu(entry);
    }

    // One strip, one decision: EXPAND (put everything back and measure the row
    // at its full width), then COLLAPSE only if it really does not fit. The two
    // run in the same task, so the browser never paints the intermediate state —
    // there is no flicker, only a correct final layout.
    function syncStrip(entry) {
        if (!entry.strip || !entry.strip.ownerDocument) return;
        // A hidden page has no layout: clientWidth is 0 and the measurement is
        // meaningless. Leave the strip as it is and re-measure when its page is
        // shown (yapdp:pagechange).
        if (entry.strip.clientWidth <= 0) return;
        expand(entry);
        if (overflows(entry.strip.scrollWidth, entry.strip.clientWidth)) {
            collapse(entry);
        }
    }

    function sync() {
        for (var i = 0; i < entries.length; i++) syncStrip(entries[i]);
    }

    function initStrip(selector, buttonClass) {
        var strip = doc.querySelector(selector);
        if (!strip) return null;
        var entry = {
            strip: strip,
            buttonClass: buttonClass,
            secondary: secondariesIn(strip),
            more: null,
            menu: null,
            anchor: [],
            collapsed: false
        };
        entry.more = buildMore(entry);
        entry.menu = buildMenu(entry);
        // The anchor is captured AFTER "More…" is appended, so each secondary is
        // restored before the element it originally preceded — including a
        // trailing secondary, whose anchor is the More button itself.
        entry.anchor = entry.secondary.map(function (btn) {
            return btn.nextElementSibling;
        });
        entry.more.addEventListener("click", function (ev) {
            if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
            toggleMenu(entry);
        });
        entry.menu.addEventListener("click", function () { closeMenu(entry); });
        return entry;
    }

    // opts: { document: <Document> }. A desktop is left completely alone.
    function install(opts) {
        opts = opts || {};
        var d = opts.document || (typeof document !== "undefined" ? document : null);
        if (!d || !d.body || installed) return null;
        if (!isTouch()) return null;
        doc = d;
        for (var i = 0; i < STRIPS.length; i++) {
            var entry = initStrip(STRIPS[i].selector, STRIPS[i].buttonClass);
            if (entry) entries.push(entry);
        }
        if (!entries.length) return null;

        onDocClick = function (ev) {
            var t = ev && ev.target;
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                if (!isMenuOpen(entry)) continue;
                if ((entry.menu && entry.menu.contains(t)) ||
                    (entry.more && entry.more.contains(t))) continue;
                closeMenu(entry);
            }
        };
        onDocKey = function (ev) {
            if (ev && (ev.key === "Escape" || ev.keyCode === 27)) closeAll();
        };
        d.addEventListener("click", onDocClick);
        d.addEventListener("keydown", onDocKey);

        var win = d.defaultView;
        if (win && typeof win.addEventListener === "function") {
            win.addEventListener("resize", sync);
            win.addEventListener("orientationchange", sync);
        }
        // Strips live on different pages; a switch shows one and hides another,
        // so the measurement has to be retaken then (the app announces it).
        d.addEventListener("yapdp:pagechange", sync);

        sync();
        installed = true;
        return { entries: entries };
    }

    function destroy() {
        if (!installed) return;
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            expand(entry);
            if (entry.more && entry.more.parentNode) {
                entry.more.parentNode.removeChild(entry.more);
            }
            if (entry.menu && entry.menu.parentNode) {
                entry.menu.parentNode.removeChild(entry.menu);
            }
        }
        entries = [];
        if (doc) {
            if (onDocClick) doc.removeEventListener("click", onDocClick);
            if (onDocKey) doc.removeEventListener("keydown", onDocKey);
            doc.removeEventListener("yapdp:pagechange", sync);
        }
        doc = null;
        onDocClick = null;
        onDocKey = null;
        installed = false;
    }

    return {
        STRIPS: STRIPS,
        SECONDARY_CLASS: SECONDARY_CLASS,
        MORE_CLASS: MORE_CLASS,
        MORE_HIDDEN_CLASS: MORE_HIDDEN_CLASS,
        MENU_CLASS: MENU_CLASS,
        MENU_OPEN_CLASS: MENU_OPEN_CLASS,
        OVERFLOW_TOLERANCE: OVERFLOW_TOLERANCE,
        overflows: overflows,
        install: install,
        destroy: destroy,
        sync: sync,
        closeAll: closeAll,
        isInstalled: function () { return installed; },
        isCollapsed: function () {
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].collapsed) return true;
            }
            return false;
        }
    };
})();

// Same explicit export as MobileInput/MobileKeys/TouchZoom: pdp11-app.js
// installs it.
if (typeof window !== "undefined") {
    window.ActionOverflow = ActionOverflow;
}
