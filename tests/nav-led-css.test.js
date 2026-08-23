#!/usr/bin/env node
/**
 * Sidebar activity-lamp CSS/HTML contract tests.
 *
 * Guards the green blinking activity lamp that appears in the top-right
 * corner of a sidebar button while the PDP-11 writes output to that device
 * (console / user terminal / line printer):
 *   • every output-capable button (teletype, vt52-console, vt52, vt52-2,
 *     printer) carries a .nav-led element;
 *   • the .nav-led is absolutely positioned and hidden by default;
 *   • .nav-led.on blinks via the nav-led-blink keyframe (like the LP11
 *     READY LED);
 *   • src/navactivity.js is loaded before src/iopage.js, and iopage.js calls
 *     the NavActivity pulse helpers from the DL11/LP11 output paths.
 *
 * These are deliberately simple string checks on the production CSS/HTML/JS
 * so a future "simplification" that breaks the indicator is caught.
 *
 * Run with:  node tests/nav-led-css.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const PDP11_CSS = path.join(__dirname, "..", "css", "pdp11.css");
const PDP11_HTML = path.join(__dirname, "..", "pdp11.html");
const IOPAGE_JS = path.join(__dirname, "..", "src", "iopage.js");

// Output-capable sidebar pages and their data-page attributes.
const PAGES = ["teletype", "vt52-console", "vt52", "vt52-2", "printer"];

// Extract a single top-level CSS rule body for a given selector.
// Uses brace balancing so nested at-rules (keyframes/media) cannot
// corrupt the extraction.
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
    const css = fs.readFileSync(PDP11_CSS, "utf8");
    const html = fs.readFileSync(PDP11_HTML, "utf8");
    const iopage = fs.readFileSync(IOPAGE_JS, "utf8");

    // --- Every output-capable sidebar button has a .nav-led ---------------
    for (const page of PAGES) {
        const at = html.indexOf('data-page="' + page + '"');
        assert.ok(at !== -1, "missing sidebar button data-page=" + page);
        const close = html.indexOf("</div>", at);
        assert.ok(close !== -1 && close > at, "button block not closed for " + page);
        const block = html.slice(at, close);
        assert.ok(block.includes('class="nav-led"'),
            "button " + page + " must carry a .nav-led activity lamp");
    }

    // --- The nav button must anchor the absolutely-positioned lamp ---------
    {
        const navBtn = extractRule(css, ".app-sidebar .nav-btn");
        assert.ok(/position:\s*relative\s*;/.test(navBtn),
            ".nav-btn must be position:relative so the lamp anchors to it:\n" + navBtn);
    }

    // --- .nav-led: hidden by default, positioned in the top-right corner ---
    {
        const led = extractRule(css, ".app-sidebar .nav-btn .nav-led");
        assert.ok(/position:\s*absolute\s*;/.test(led),
            ".nav-led must be absolutely positioned:\n" + led);
        assert.ok(/opacity:\s*0\s*;/.test(led),
            ".nav-led must be invisible (opacity:0) while idle:\n" + led);
        assert.ok(/top:\s*\d/.test(led), ".nav-led must have a top offset:\n" + led);
        assert.ok(/right:\s*\d/.test(led), ".nav-led must have a right offset:\n" + led);
    }

    // --- .nav-led.on: lit green and blinking via a keyframe animation ------
    {
        const on = extractRule(css, ".app-sidebar .nav-btn .nav-led.on");
        assert.ok(/animation:\s*nav-led-blink/.test(on),
            ".nav-led.on must blink via the nav-led-blink animation:\n" + on);
        assert.ok(/opacity:\s*1\s*;/.test(on), ".nav-led.on must be fully visible:\n" + on);
    }

    assert.ok(css.includes("@keyframes nav-led-blink"),
        "css must define the @keyframes nav-led-blink");

    // --- Script order: navactivity.js loads before iopage.js ---------------
    {
        const navAt = html.indexOf("src='src/navactivity.js'");
        const ioAt = html.indexOf("src='src/iopage.js'");
        assert.ok(navAt !== -1, "pdp11.html must load src/navactivity.js");
        assert.ok(ioAt !== -1, "pdp11.html must load src/iopage.js");
        assert.ok(navAt < ioAt,
            "src/navactivity.js must be loaded before src/iopage.js");
    }

    // --- iopage.js routes output through the NavActivity helpers -----------
    {
        assert.ok(/NavActivity\.pulseConsole\(/.test(iopage),
            "iopage.js must call NavActivity.pulseConsole for console output");
        assert.ok(/NavActivity\.pulseTerminal\(/.test(iopage),
            "iopage.js must call NavActivity.pulseTerminal for user-terminal output");
        assert.ok(/NavActivity\.set\("printer",\s*busy\)/.test(iopage),
            "iopage.js must drive the Printer lamp from the LP11 busy ticker");
    }

    console.log("nav-led-css: all tests passed");
}

run();
