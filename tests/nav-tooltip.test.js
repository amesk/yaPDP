#!/usr/bin/env node
/**
 * Sidebar navigation-button tooltip contract test.
 *
 * Guards that every button in the navigation sidebar (.app-sidebar .nav-btn)
 * carries a non-empty `title` tooltip, and that the Panel button explains
 * its status indicators (the power lamp and the run/halt glyph), so a future
 * "simplification" that drops a tooltip is caught.
 *
 * These are deliberately simple string checks on the production HTML, in the
 * same style as tests/nav-led-css.test.js.
 *
 * Run with:  node tests/nav-tooltip.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const PDP11_HTML = path.join(__dirname, "..", "pdp11.html");

// Every sidebar navigation page and its data-page attribute. These are the
// buttons an operator can switch between, so each must explain itself.
const PAGES = [
    "panel",
    "teletype",
    "vt52-console",
    "vt52",
    "vt52-2",
    "printer",
    "vt11",
    "storage",
    "config",
    "instructions"
];

// Extract the sidebar button block for a given data-page.
function navBlock(html, page) {
    const at = html.indexOf('data-page="' + page + '"');
    assert.ok(at !== -1, "missing sidebar button data-page=" + page);
    const close = html.indexOf("</div>", at);
    assert.ok(close !== -1 && close > at, "button block not closed for " + page);
    return html.slice(at, close);
}

function run() {
    const html = fs.readFileSync(PDP11_HTML, "utf8");

    // --- Every sidebar button carries a non-empty title tooltip -----------
    for (const page of PAGES) {
        const block = navBlock(html, page);
        const m = /title="([^"]*)"/.exec(block);
        assert.ok(m, "button " + page + " must carry a title tooltip:\n" + block);
        assert.ok(m[1].trim().length > 0,
            "button " + page + " must have a non-empty title tooltip:\n" + block);
    }

    // --- The Panel button tooltip explains its status indicators ----------
    // The green power lamp (top right) lights while powered on; the glyph
    // (top left) shows pause when halted, play while running. Broken into
    // several lines via the &#10; entity so the native tooltip wraps.
    {
        const panel = navBlock(html, "panel");
        const title = /title="([^"]*)"/.exec(panel)[1];
        assert.ok(/powered on/i.test(title),
            "Panel tooltip must explain the power lamp:\n" + title);
        assert.ok(/halt/i.test(title),
            "Panel tooltip must explain the halted state:\n" + title);
        assert.ok(/runn/i.test(title),
            "Panel tooltip must explain the running state:\n" + title);
        assert.ok(title.includes("&#10;"),
            "Panel tooltip must be split into several lines (&#10;):\n" + title);
    }

    // --- Activity-lamp buttons explain the green lamp ---------------------
    // The output-capable devices (console, user terminals, line printer)
    // carry a .nav-led that blinks while the PDP-11 writes output, so their
    // tooltips must say so.
    for (const page of ["teletype", "vt52-console", "vt52", "vt52-2", "printer"]) {
        const block = navBlock(html, page);
        const title = /title="([^"]*)"/.exec(block)[1];
        assert.ok(/lamp/i.test(title),
            "button " + page + " tooltip must mention the green lamp:\n" + title);
        assert.ok(/blink/i.test(title),
            "button " + page + " tooltip must explain the lamp blinks:\n" + title);
    }

    console.log("nav-tooltip: all tests passed");
}

run();
