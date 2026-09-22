#!/usr/bin/env node
/**
 * Mobile adaptation CSS/HTML/JS contract tests.
 *
 * Guards the touch-device layout and the on-screen keyboard bridge:
 *   • pdp11.html loads src/mobile-input.js BEFORE src/pdp11-app.js (the app
 *     references window.MobileInput);
 *   • css/pdp11.css ships a @media (max-width: 768px) block that turns the
 *     sidebar into a bottom bar (flex-direction: row), wraps the config/storage
 *     tabs, and keeps the floating controls clear of the bar;
 *   • src/pdp11-app.js wires the bridge into both the VT52 canvas terminals and
 *     the Model 33 teletype.
 *
 * These are deliberately simple string checks on the production files, so a
 * future "simplification" that silently drops the mobile layer is caught.
 *
 * Run with:  node tests/mobile-css.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const PDP11_CSS = path.join(__dirname, "..", "css", "pdp11.css");
const PDP11_HTML = path.join(__dirname, "..", "pdp11.html");
const PDP11_APP = path.join(__dirname, "..", "src", "pdp11-app.js");
const MOBILE_INPUT = path.join(__dirname, "..", "src", "mobile-input.js");
const MOBILE_KEYS = path.join(__dirname, "..", "src", "mobile-keys.js");
const QUICKBOOT = path.join(__dirname, "..", "src", "quickboot.js");

// Extract the body of an at-rule by brace balancing, so nested rules cannot
// corrupt the extraction.
function extractAtRule(css, marker) {
    const start = css.indexOf(marker);
    if (start === -1) throw new Error("at-rule not found: " + marker);
    const braceOpen = start + marker.length - 1;
    let depth = 0;
    for (let i = braceOpen; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") {
            depth--;
            if (depth === 0) return css.slice(braceOpen + 1, i);
        }
    }
    throw new Error("unbalanced braces for: " + marker);
}

function run() {
    const css = fs.readFileSync(PDP11_CSS, "utf8");
    const html = fs.readFileSync(PDP11_HTML, "utf8");
    const app = fs.readFileSync(PDP11_APP, "utf8");

    // ---- Script load order ---------------------------------------------
    {
        // Match the <script> tags themselves: the file name also appears in
        // HTML comments (e.g. "Wired in src/pdp11-app.js"), which would
        // otherwise be found first.
        const mobileAt = html.indexOf("src='src/mobile-input.js'");
        const appAt = html.indexOf("src='src/pdp11-app.js'");
        assert.ok(mobileAt !== -1, "pdp11.html must load src/mobile-input.js");
        assert.ok(appAt !== -1, "pdp11.html must load src/pdp11-app.js");
        assert.ok(mobileAt < appAt,
            "mobile-input.js must load before pdp11-app.js");
    }

    // ---- The mobile media query exists ---------------------------------
    const media = extractAtRule(css, "@media (max-width: 768px) {");

    // Sidebar becomes a horizontal bottom bar.
    assert.ok(media.indexOf(".app-sidebar {") !== -1,
        "the mobile block must restyle .app-sidebar");
    const sidebar = extractAtRule(media, ".app-sidebar {");
    assert.ok(/flex-direction:\s*row/.test(sidebar),
        ".app-sidebar must lay out horizontally on mobile");
    assert.ok(/order:\s*2/.test(sidebar),
        ".app-sidebar must be pinned after the page (order: 2)");

    // The page takes the remaining space.
    assert.ok(media.indexOf(".page {") !== -1,
        "the mobile block must reorder .page");
    assert.ok(/order:\s*1/.test(extractAtRule(media, ".page {")),
        ".page must come before the bar (order: 1)");

    // Tabs wrap so every tab stays visible.
    assert.ok(media.indexOf(".config-tab-bar {") !== -1,
        "the mobile block must restyle .config-tab-bar");
    assert.ok(/flex-wrap:\s*wrap/.test(extractAtRule(media, ".config-tab-bar {")),
        ".config-tab-bar must wrap its tabs on mobile");

    // The bottom-anchored floating controls clear the bar.
    assert.ok(/\.config-tab\s*\{/.test(media),
        "the mobile block must restyle .config-tab");

    // The QuickBoot autoload warning is a whole sentence pinned to the middle
    // of the window: un-wrapped it is wider than a phone and both of its ends
    // fall off the screen. It has to wrap, may never be wider than the window,
    // and drops to a readable size on a narrow one. The class and the wording
    // are pinned to src/quickboot.js, because tests/e2e-mobile-input.js
    // measures a box built with exactly those two.
    {
        const quickboot = fs.readFileSync(QUICKBOOT, "utf8");
        assert.ok(quickboot.indexOf('balloon.className = "quickboot-balloon"') !== -1,
            "src/quickboot.js must build the warning with the .quickboot-balloon class");
        assert.ok(quickboot.indexOf("Autoloading in progress") !== -1,
            "src/quickboot.js must keep the autoload warning wording");
        assert.ok(/\.quickboot-balloon\s*\{[^}]*max-width:/.test(css),
            "the warning must never be wider than the window");
        assert.ok(/\.quickboot-balloon\s*\{[^}]*white-space:\s*normal/.test(css),
            "the warning must be allowed to wrap");
        assert.ok(/\.quickboot-balloon\s*\{[^}]*font-size:\s*15px/.test(media),
            "on a phone the warning must drop to a size that fits two lines");
    }

    // The startup loading gate (inline in pdp11.html) is a full-window overlay
    // that centres its lines: on a phone, narrower than the hint's own measure,
    // the text ran into both edges. The overlay therefore needs a gutter — and
    // has to stay exactly the window's size — while the hint must be capped by
    // the window rather than by its em measure alone.
    // (tests/e2e-mobile-input.js measures the resulting box on 390x844.)
    {
        const gate = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
        assert.ok(gate.length > 0,
            "pdp11.html must keep the loading gate's inline styles");
        const overlay = /(^|\n)\s*#yapdp-loading\s*\{([^}]*)\}/.exec(gate);
        assert.ok(overlay, "the gate overlay must have a rule of its own");
        assert.ok(/padding:\s*[1-9]/.test(overlay[2]),
            "the gate texts need a gutter from the window edges");
        assert.ok(/box-sizing:\s*border-box/.test(overlay[2]),
            "the overlay must not grow past the window by its own padding");
        const hint = /(^|\n)\s*#yapdp-loading\s+\.yapdp-loading-hint\s*\{([^}]*)\}/.exec(gate);
        assert.ok(hint, "the gate hint must have a rule of its own");
        assert.ok(/width:\s*100%/.test(hint[2]),
            "the gate hint must be capped by the window, not only by its em measure");
    }

    // ---- The app wires the bridge --------------------------------------
    assert.ok(app.indexOf("MobileInput.isCoarse()") !== -1,
        "pdp11-app.js must detect a coarse pointer before bridging");
    assert.ok(app.indexOf("MobileInput.create(") !== -1,
        "pdp11-app.js must create a MobileInput bridge");
    // The Model 33 keeps its own drawn keycaps: it must NOT bridge the system
    // keyboard any more — the drawn keys are what an operator presses, and a
    // phone's keyboard cannot latch SHIFT/CTRL in any case.
    assert.ok(app.indexOf("installMobileKeyboard") === -1,
        "the teletype must not bridge the system keyboard");

    // The canvas-mode bridge lives in ONE helper and is installed from BOTH
    // paths into canvas mode. The CONFIG "VT52 text mode" switch is applied
    // live, so a terminal that STARTED in text mode reaches the canvas without
    // ever running initVT52Page's canvas branch — it used to arrive with no
    // on-screen keyboard at all, and tapping the tube raised nothing.
    assert.ok(app.indexOf("function installCanvasMobileKeyboard(") !== -1,
        "pdp11-app.js must install the canvas keyboard bridge from one helper");
    const canvasBridgeRefs = app.split("installCanvasMobileKeyboard(").length - 1;
    assert.ok(canvasBridgeRefs >= 3,
        "the canvas keyboard bridge must be installed from both initVT52Page " +
        "and applyVT52TextMode (found " + canvasBridgeRefs + " references)");

    // ---- The phone frame (viewport meta) --------------------------------
    // Without it a phone lays the emulator out at the ~980px desktop width, so
    // the mobile block above never matches AND the page cannot be pinched — the
    // gesture is locked to the fit-to-width scale (measured in
    // tests/e2e-mobile-input.js, section 10).
    {
        const meta = /<meta\s+name=["']viewport["']\s+content=["']([^"']+)["']/i.exec(html);
        assert.ok(meta, "pdp11.html must declare a <meta name=\"viewport\">");
        assert.ok(/width=device-width/.test(meta[1]),
            "the viewport must follow the device width");
        assert.ok(!/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(meta[1]),
            "the viewport must not forbid pinch-zoom");
    }

    // ---- The special-key bar (src/mobile-keys.js) -----------------------
    // Enter is an IME action on a phone and Ctrl+letter is unreachable, so the
    // keys a PDP-11 operator needs most are real buttons on the strip.
    {
        const keys = fs.readFileSync(MOBILE_KEYS, "utf8");
        const inputAt = html.indexOf("src='src/mobile-input.js'");
        const keysAt = html.indexOf("src='src/mobile-keys.js'");
        assert.ok(keysAt !== -1, "pdp11.html must load src/mobile-keys.js");
        assert.ok(inputAt !== -1 && inputAt < keysAt,
            "mobile-keys.js must load after mobile-input.js (it uses the registry)");
        assert.ok(keysAt < html.indexOf("src='src/pdp11-app.js'"),
            "mobile-keys.js must load before pdp11-app.js (the app installs the bar)");

        // The bytes a phone cannot otherwise produce: CR, ESC, TAB, BS, RUBOUT
        // and the control codes the guests ask for.
        ["[13]", "[27]", "[9]", "[8]", "[127]", "[3]", "[4]", "[26]"].forEach(function (b) {
            assert.ok(keys.indexOf(b) !== -1, "the bar must offer the key byte " + b);
        });
        assert.ok(keys.indexOf("MobileInput.setCtrlLatch") !== -1,
            "CTRL must latch through MobileInput");
        assert.ok(keys.indexOf("MobileInput.findTarget") !== -1,
            "the bar must route its keys to the terminal on screen");
        assert.ok(keys.indexOf("MobileInput.isCoarse()") !== -1,
            "the bar must exist only on a touch device");

        // …and only on the terminals that have no keyboard of their own: the
        // VT52/VT100 pages. The bar follows the page changes the app announces.
        assert.ok(/TERMINAL_PAGES\s*=\s*\[[^\]]*"vt52-console"[^\]]*"vt52-2"[^\]]*\]/
            .test(keys), "mobile-keys.js must name the pages the bar belongs to");
        assert.ok(keys.indexOf("yapdp:pagechange") !== -1,
            "the bar must follow the page changes the app announces");
        assert.ok(keys.indexOf("classList.toggle(\"hidden\"") !== -1,
            "the bar must hide itself off its pages");
        // …and the class has to WIN the cascade: the docking rule is keyed on
        // body.mobile-keys-on, so a bare `.hidden` would lose to it and the bar
        // would stay on screen (that is exactly what happened once).
        assert.ok(/body\.mobile-keys-on\s+\.mobile-keys\.hidden\s*\{[^}]*display:\s*none/
            .test(css), "css/pdp11.css must really hide the bar through .hidden");

        // The bottom stack is laid out from MEASURED numbers (--app-h, the real
        // window height, and --bottom-stack-h, the real height of the navigation
        // bar plus this bar), because the flow column and a fixed element do not
        // always agree on where the bottom edge is. Hard-coded per-button offsets
        // are what put the round buttons on the navigation bar.
        assert.ok(/\.app-layout\s*\{[^}]*height:\s*var\(--app-h/.test(css),
            "the column must use the measured window height");
        assert.ok(/bottom:\s*calc\(var\(--bottom-stack-h\)/.test(css),
            "the floating buttons must be lifted by the measured stack height");
        assert.ok(/mobile-keys-off[^}]*\{[^}]*--bottom-stack-h/.test(css),
            "with the bar hidden the stack is the navigation bar alone");
        assert.ok(/publishMetrics/.test(keys),
            "the module must publish those measurements");

        // …and the stack rules must live OUTSIDE the narrow-screen media query.
        // The bar follows the POINTER, the layout follows the WIDTH: a phone in
        // landscape is 844px wide, so it keeps the bar but leaves the media
        // query, and the buttons fall back to their desktop offsets — right
        // inside the bar's band (measured on a 844x390 emulation).
        const wide = css.slice(0, css.indexOf("@media (max-width: 768px)"));
        assert.ok(wide.length > 0, "css/pdp11.css must keep a narrow-screen media query");
        assert.ok(/body\.mobile-keys-on\s+\.mute-btn[\s\S]*?bottom:\s*calc\(var\(--bottom-stack-h\)/
            .test(wide),
            "the floating buttons must be lifted at EVERY width, not only on a narrow screen");
        assert.ok(/body\.mobile-keys-on\s*\{[^}]*--bottom-stack-h/.test(wide),
            "the bar's own height must be the fallback stack at every width");

        // The measurement must not take the landscape navigation rail (a
        // full-height column whose top is 0) for a bottom bar: that would report
        // a stack as tall as the window and push the buttons off the screen.
        assert.ok(/top\s*<\s*viewport\s*\*/.test(keys),
            "mobile-keys.js must count only what sits in the bottom half");

        // The app builds it and registers a target per page, so ONE bar serves
        // every terminal — console, user terminal, text or canvas mode, teletype.
        assert.ok(app.indexOf("MobileKeys.install()") !== -1,
            "pdp11-app.js must install the special-key bar");
        assert.ok(app.indexOf("MobileInput.registerTarget(") !== -1,
            "pdp11-app.js must register the terminals as input targets");

        // CSS: the strip is off by default, docked through the body class, and
        // it moves the navigation bar and the floating controls out of its way.
        assert.ok(css.indexOf("body.mobile-keys-on .mobile-keys") !== -1,
            "css/pdp11.css must dock the bar through body.mobile-keys-on");
        assert.ok(/body\.mobile-keys-on\s+\.app-sidebar\s*\{[^}]*margin-bottom/.test(css),
            "the navigation bar must be lifted by the strip's height");
    }

    // ---- The modules exist ---------------------------------------------
    assert.ok(fs.existsSync(MOBILE_INPUT), "src/mobile-input.js must exist");
    assert.ok(fs.existsSync(MOBILE_KEYS), "src/mobile-keys.js must exist");

    console.log("mobile-css.test.js: all tests passed");
}

run();
