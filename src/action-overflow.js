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
 * The menu cannot be a child of the strip (the strip has overflow-x: auto and
 * would clip a pop-up hanging below it), and it cannot live in the strip's
 * parent either: on a touch device that parent is the pinned layer .touch-pin
 * (src/touchzoom.js) whose z-index (20) makes it a stacking context, so a menu
 * inside it can never paint ABOVE the round floating controls (State, Quick
 * Boot, Pause, Reboot — fixed, z-index 1000) that sit in exactly the band under
 * the strip. That is what put the menu UNDER those buttons on a phone.
 * So the menu is attached to <body> as a FIXED overlay and placed in viewport
 * pixels from the "More…" button's own rect (see menuBox): hung below the
 * button, pushed clear of any floating control it would cover, and clamped into
 * the viewport. Being outside the page also leaves it at natural size while a
 * pinch-zoomed page carries a transform (src/touchzoom.js).
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

    // Gap between the menu and the "More…" button, and between the menu and the
    // viewport edges, in px.
    var MENU_MARGIN = 6;

    // The application's FIXED round controls (see css/pdp11.css): Pause, Reboot
    // and State all wear .console-reboot, the magic wand is .quick-boot-btn, and
    // the remaining round buttons sit in the corners. The menu is hung in their
    // band, so it has to be pushed below whichever of them it would cover.
    var FLOATING_SELECTOR = "#state-btn, #quick-boot-btn, .console-reboot, " +
        ".console-pause, .mute-btn, .screenshot-btn, .zoom-btn, .fullscreen-btn";

    var doc = null;
    var entries = [];
    var installed = false;
    var onDocClick = null;
    var onDocKey = null;
    var onResize = null;
    var onScroll = null;

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
        // <body>, NOT the strip's parent — see the module comment: inside the
        // pinned layer the menu would be trapped under the floating buttons,
        // and inside the page it would be scaled by a pinch.
        (doc.body || doc.documentElement).appendChild(menu);
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

    // Where a pop-up hung under `anchor` has to sit, in viewport pixels. Pure
    // geometry, exported for the Node tests: `anchor` and `viewport` carry the
    // getBoundingClientRect numbers, `size` is the menu's own box and `avoid` is
    // a list of rects the menu must not cover (the fixed round controls).
    function menuBox(anchor, size, viewport, avoid, margin) {
        var m = (typeof margin === "number" && isFinite(margin)) ? margin : MENU_MARGIN;
        var a = anchor || {};
        var s = size || {};
        var v = viewport || {};
        var w = Number(s.width) || 0;
        var h = Number(s.height) || 0;
        var vw = Number(v.width) || 0;
        var vh = Number(v.height) || 0;
        var aTop = Number(a.top);
        var aRight = Number(a.right);
        var aBottom = Number(a.bottom);
        if (!isFinite(aTop)) aTop = 0;
        if (!isFinite(aRight)) aRight = 0;
        if (!isFinite(aBottom)) aBottom = 0;

        // The right edge follows the anchor (the "More…" button ends the strip at
        // the screen's right margin), clamped so a menu wider than the viewport
        // never runs off the left side.
        var right = (vw > 0) ? Math.round(vw - aRight) : 0;
        if (right < m) right = m;
        if (vw > 0 && w > 0 && vw - right - w < m) {
            right = Math.max(m, Math.round(vw - w - m));
        }
        var left = (vw > 0) ? vw - right - w : 0;

        // Hung below the button — and below any fixed round control the menu
        // would otherwise be drawn under (State and the magic wand sit right
        // under the strip on a touch device).
        var top = Math.round(aBottom + m);
        var list = avoid || [];
        for (var i = 0; i < list.length && w > 0; i++) {
            var r = list[i];
            if (!r) continue;
            var rl = Number(r.left);
            var rr = Number(r.right);
            var rb = Number(r.bottom);
            if (!isFinite(rl) || !isFinite(rr) || !isFinite(rb)) continue;
            if (rr > left && rl < left + w && rb + m > top) top = Math.round(rb + m);
        }

        // No room below (a landscape phone, an on-screen keyboard): hang the
        // menu ABOVE the button rather than over it or off the screen.
        if (vh > 0 && h > 0 && top + h > vh - m && aTop - m - h >= m) {
            top = Math.round(aTop - m - h);
        }
        return { top: top, right: right };
    }

    // The live rects of the fixed round controls; hidden ones are skipped (a
    // page that offers no Reboot has display: none on it).
    function floatingRects() {
        var out = [];
        if (!doc || typeof doc.querySelectorAll !== "function") return out;
        var els = doc.querySelectorAll(FLOATING_SELECTOR);
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (!el || typeof el.getBoundingClientRect !== "function") continue;
            var r = el.getBoundingClientRect();
            if (!r || !(r.width > 0) || !(r.height > 0)) continue;
            out.push(r);
        }
        return out;
    }

    function placeMenu(entry) {
        var menu = entry.menu;
        var more = entry.more;
        var win = doc && doc.defaultView;
        if (!menu || !more || !win) return;
        if (typeof more.getBoundingClientRect !== "function") return;
        var box = menuBox(more.getBoundingClientRect(), {
            width: menu.offsetWidth || 0,
            height: menu.offsetHeight || 0
        }, {
            width: win.innerWidth || 0,
            height: win.innerHeight || 0
        }, floatingRects(), MENU_MARGIN);
        menu.style.top = box.top + "px";
        menu.style.right = box.right + "px";
    }

    // A FIXED menu does not follow a scroll (the page scrolls, the window does
    // not) or a rotation, so an open one is re-placed on both.
    function repositionOpen() {
        for (var i = 0; i < entries.length; i++) {
            if (isMenuOpen(entries[i])) placeMenu(entries[i]);
        }
    }

    function openMenu(entry) {
        if (!entry.collapsed || !entry.menu) return;
        entry.menu.classList.add(MENU_OPEN_CLASS);
        // Measured only once the menu is laid out (display: flex).
        placeMenu(entry);
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
            onResize = function () { sync(); repositionOpen(); };
            onScroll = repositionOpen;
            win.addEventListener("resize", onResize);
            win.addEventListener("orientationchange", onResize);
            // The menu is FIXED in viewport pixels while the PAGE scrolls, so it
            // is the capture phase that catches the scrolling ancestor.
            win.addEventListener("scroll", onScroll, true);
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
            var win = doc.defaultView;
            if (win && typeof win.removeEventListener === "function") {
                if (onResize) {
                    win.removeEventListener("resize", onResize);
                    win.removeEventListener("orientationchange", onResize);
                }
                if (onScroll) win.removeEventListener("scroll", onScroll, true);
            }
        }
        doc = null;
        onDocClick = null;
        onDocKey = null;
        onResize = null;
        onScroll = null;
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
        MENU_MARGIN: MENU_MARGIN,
        FLOATING_SELECTOR: FLOATING_SELECTOR,
        overflows: overflows,
        menuBox: menuBox,
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
