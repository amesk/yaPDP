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

    // ---- The app wires the bridge --------------------------------------
    assert.ok(app.indexOf("MobileInput.isCoarse()") !== -1,
        "pdp11-app.js must detect a coarse pointer before bridging");
    assert.ok(app.indexOf("MobileInput.create(") !== -1,
        "pdp11-app.js must create a MobileInput bridge");
    assert.ok(app.indexOf("installMobileKeyboard") !== -1,
        "the teletype must install a mobile keyboard bridge");
    assert.ok(app.indexOf("installMobileKeyboard") !==
        app.lastIndexOf("installMobileKeyboard"),
        "installMobileKeyboard must be both defined and called");

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

    // ---- The bridge module exists --------------------------------------
    assert.ok(fs.existsSync(MOBILE_INPUT), "src/mobile-input.js must exist");

    console.log("mobile-css.test.js: all tests passed");
}

run();
