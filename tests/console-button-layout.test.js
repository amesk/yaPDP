#!/usr/bin/env node
/**
 * Floating operator buttons — layout contract tests.
 *
 * The round buttons split into two groups by ROLE:
 *   • top-LEFT  — Pause and Reboot, actions on the live machine;
 *   • top-RIGHT — State and the quick-boot magic wand, session-level actions
 *     that open a dialog (and both can restore a saved machine).
 *
 * Nothing in the DOM or in the wiring knows about this split — it lives in two
 * CSS rules — so a stray `left:` in a media query can silently stack STATE on
 * top of REBOOT again. These tests pin the geometry and the DOM order.
 *
 * Run with:  node tests/console-button-layout.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const CSS_PATH = path.join(ROOT, "css", "pdp11.css");
const HTML_PATH = path.join(ROOT, "pdp11.html");
const PANEL_PATH = path.join(ROOT, "src", "pdp11-panel.js");

// Return the body of the block that starts at the first "{ " at/after `from`.
function blockAt(css, from, what) {
    const open = css.indexOf("{", from);
    assert.notStrictEqual(open, -1, "no opening brace for: " + what);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") {
            depth--;
            if (depth === 0) return { start: open, body: css.slice(open, i + 1) };
        }
    }
    throw new Error("unbalanced braces for: " + what);
}

// First rule whose selector is exactly `selector` (top level, not @media).
function rule(css, selector) {
    const marker = selector + " {";
    const at = css.indexOf(marker);
    assert.notStrictEqual(at, -1, "rule not found: " + selector);
    return blockAt(css, at + marker.length - 1, selector).body;
}

function px(body, prop, selector) {
    const m = new RegExp("(?:^|[^-a-z])" + prop + "\\s*:\\s*(-?[0-9.]+)px").exec(body);
    assert.ok(m, selector + " must set " + prop + " in px");
    return parseFloat(m[1]);
}

function run() {
    const css = fs.readFileSync(CSS_PATH, "utf8");
    const html = fs.readFileSync(HTML_PATH, "utf8");
    const panel = fs.readFileSync(PANEL_PATH, "utf8");

    const wand = rule(css, ".quick-boot-btn");
    const pause = rule(css, ".console-pause");
    const reboot = rule(css, ".console-reboot");
    const state = rule(css, ".console-state");

    // --- 1. The STATE button docks with the wand, not with REBOOT ------------
    {
        assert.ok(/left\s*:\s*auto/.test(state),
            ".console-state must clear the left binding (left: auto)");
        const stateRight = px(state, "right", ".console-state");
        const wandRight = px(wand, "right", ".quick-boot-btn");
        const wandWidth = px(wand, "width", ".quick-boot-btn");
        assert.ok(stateRight >= wandRight + wandWidth,
            "STATE must sit clear of the wand (" + stateRight + " vs " +
            (wandRight + wandWidth) + ")");
        // ... and close enough to read as one group: no more than a small gap.
        assert.ok(stateRight - (wandRight + wandWidth) <= 16,
            "STATE must be adjacent to the wand, not stranded " +
            (stateRight - (wandRight + wandWidth)) + "px away");
    }

    // --- 2. Pause and Reboot stay on the left -------------------------------
    {
        const pauseLeft = px(pause, "left", ".console-pause");
        const rebootLeft = px(reboot, "left", ".console-reboot");
        assert.ok(pauseLeft < rebootLeft,
            "Pause must be the leftmost machine control (" + pauseLeft +
            " vs " + rebootLeft + ")");
        assert.strictEqual(/right\s*:/.test(pause), false,
            ".console-pause must not bind to the right edge");
    }

    // --- 3. The narrow-screen breakpoint repeats the split ------------------
    {
        const at = css.indexOf("@media (max-width: 768px)");
        assert.notStrictEqual(at, -1, "the 768px breakpoint must exist");
        const media = blockAt(css, at, "@media (max-width: 768px)").body;
        const narrowAt = media.indexOf(".console-state {");
        assert.notStrictEqual(narrowAt, -1,
            "the narrow breakpoint must reposition .console-state");
        const narrow = blockAt(media, narrowAt, "narrow .console-state").body;
        assert.ok(/left\s*:\s*auto/.test(narrow),
            "the narrow breakpoint must keep STATE off the left edge");
        const narrowRight = px(narrow, "right", "narrow .console-state");
        const narrowWand = blockAt(media,
            media.indexOf(".quick-boot-btn {"), "narrow .quick-boot-btn").body;
        assert.ok(narrowRight >= px(narrowWand, "right", "narrow .quick-boot-btn") +
            px(wand, "width", ".quick-boot-btn"),
            "the narrow breakpoint must keep STATE clear of the wand");
    }

    // --- 4. On a touch device the round buttons follow the control strip ----
    {
        // STATE has no own rule for this: it is a .console-reboot, and the
        // strip offset is applied to .console-reboot.
        const strip = /body\.touch-gestures\.touch-controls[^{]*\{[^}]*top\s*:\s*calc\(var\(--touch-strip-h\)/;
        assert.ok(strip.test(css),
            "the touch control strip must push the round buttons down");
        const stripRule = /body\.touch-gestures\.touch-controls\s+([^{]+)\{[^}]*top\s*:\s*calc\(var\(--touch-strip-h\)/.exec(css);
        assert.ok(stripRule, "touch strip rule not found");
        assert.ok(/\.console-reboot/.test(stripRule[1]),
            "STATE must inherit the touch strip offset through .console-reboot");
    }

    // --- 5. DOM order matches the visual order (no keyboard surprise) -------
    {
        assert.ok(/id="state-btn"[^>]*class="[^"]*console-state/.test(html) ||
            /class="[^"]*console-state[^"]*"[^>]*id="state-btn"/.test(html),
            "#state-btn must carry the .console-state class");
        const stateAt = html.indexOf('id="state-btn"');
        const wandAt = html.indexOf('id="quick-boot-btn"');
        assert.ok(stateAt !== -1 && wandAt !== -1, "both buttons must exist");
        assert.ok(stateAt < wandAt,
            "STATE must precede the wand in the DOM: tab order then runs " +
            "left to right on screen");
    }

    // --- 6. Both buttons share one visibility rule --------------------------
    {
        assert.ok(/var OPERATOR_PAGES = \['panel'[^\]]*\]/.test(panel),
            "the operator page list must stay in one place");
        const stateToggle = /stateBtn\.classList\.toggle\('hidden',\s*!onOperatorPage\)/.test(panel);
        const rebootToggle = /rebootBtn\.classList\.toggle\('hidden',\s*!onOperatorPage\)/.test(panel);
        assert.ok(stateToggle && rebootToggle,
            "STATE and REBOOT must be shown on exactly the same pages");
    }

    console.log("console-button-layout: all checks passed");
}

try {
    run();
} catch (err) {
    console.error("console-button-layout: FAILED");
    console.error("  " + (err && err.message ? err.message : err));
    process.exit(1);
}
