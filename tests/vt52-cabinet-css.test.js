#!/usr/bin/env node
/**
 * VT52 cabinet CSS contract tests.
 *
 * Guards the CSS sizing of the DECscope cabinet (css/pdp11.css) against the
 * Windows 10 regression where the case became narrower than the CRT plus the
 * dark side panel, so the side panel overflowed the cabinet edge.
 *
 * Root cause (confirmed with diagnostics on Windows 10):
 *   • .vt52-terminal used width: fit-content, which clamped the case to the
 *     viewport, and .vt52-bezel relied on flexbox max-content to account for
 *     the 180px side panel (flex: 0 0 180px). Older WebView2 on Windows 10
 *     measures flexbox max-content WITHOUT flex-basis-length items, so the
 *     bezel collapsed to just the CRT width and the panel spilled past the
 *     case edge (panelRight > terminalRight).
 *
 * The fix no longer depends on that measurement: the side panel is taken out
 * of the flex flow (position: absolute, width: 180px) and its width is
 * reserved in the bezel's right padding (padding-right: calc(...)).
 *
 * These are deliberately simple string checks on the production CSS so a
 * future "simplification" back to the broken flex-basis approach is caught.
 *
 * Run with:  node tests/vt52-cabinet-css.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const CSS_PATH = path.join(__dirname, "..", "css", "pdp11.css");

// ------------------------------------------------------------------
// Extract a single top-level CSS rule body for a given selector.
// Uses brace balancing so nested at-rules (keyframes/media) cannot
// corrupt the extraction.
// ------------------------------------------------------------------
function extractRule(css, selector) {
    const marker = selector + " {";
    const start = css.indexOf(marker);
    if (start === -1) {
        throw new Error("rule not found: " + selector);
    }
    const braceOpen = start + marker.length - 1;
    let depth = 0;
    for (let i = braceOpen; i < css.length; i++) {
        const c = css[i];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return css.slice(start, i + 1);
        }
    }
    throw new Error("unbalanced braces for: " + selector);
}

function run() {
    const css = fs.readFileSync(CSS_PATH, "utf8");

    // --- .vt52-terminal must size to its full content -------------------
    {
        const rule = extractRule(css, ".vt52-terminal");
        assert.ok(/width\s*:\s*max-content\s*;/.test(rule),
            ".vt52-terminal must use width: max-content (found fit-content?):\n" + rule);
        assert.ok(!/width\s*:\s*fit-content\s*;/.test(rule),
            ".vt52-terminal must NOT clamp to the viewport with width: fit-content:\n" + rule);
    }

    // --- .vt52-bezel must reserve room for the side panel in padding -----
    {
        const rule = extractRule(css, ".vt52-bezel");
        assert.ok(/position\s*:\s*relative\s*;/.test(rule),
            ".vt52-bezel must be position: relative (anchor for the side panel):\n" + rule);
        assert.ok(/padding-right\s*:\s*calc\(16px\s*\+\s*14px\s*\+\s*180px\)\s*;/.test(rule),
            ".vt52-bezel must reserve the 180px panel + 14px gap in padding-right:\n" + rule);
        assert.ok(!/justify-content\s*:\s*center\s*;/.test(rule),
            ".vt52-bezel must NOT center the CRT (it would overlap the reserved panel slot):\n" + rule);
    }

    // --- .vt52-side-plastic must be absolutely anchored, not a flex item ---
    {
        const rule = extractRule(css, ".vt52-side-plastic");
        assert.ok(/position\s*:\s*absolute\s*;/.test(rule),
            ".vt52-side-plastic must be position: absolute (out of the flex flow):\n" + rule);
        assert.ok(/width\s*:\s*180px\s*;/.test(rule),
            ".vt52-side-plastic must keep a fixed width: 180px:\n" + rule);
        assert.ok(!/flex\s*:\s*0\s*0\s*180px\s*;/.test(rule),
            ".vt52-side-plastic must NOT size via flex: 0 0 180px (ignored by WebView2 max-content):\n" + rule);
    }

    console.log("vt52-cabinet-css: OK (cabinet keeps CRT + side panel inside the case)");
}

run();
