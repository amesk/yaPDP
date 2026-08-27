#!/usr/bin/env node
/**
 * LP11 printer-cabinet CSS/HTML contract tests.
 *
 * Guards the DEC LP11/LA180 cabinet styling (css/pdp11.css + css/g60printer.css)
 * and the printer-page markup (pdp11.html) that were added when the Printer page
 * was reworked in the style of the Teletype/VT52 pages:
 *   • top cover (hood) with a vent grille and a central paper slot;
 *   • operator console with READY + ONLINE LEDs and the ON LINE key;
 *   • the fanfold must keep rising above the cabinet (no overflow:hidden on the
 *     cabinet, paper/print head drawn above the hood via z-index);
 *   • the Google60 machine skin stays hidden.
 *
 * These are deliberately simple string checks on the production CSS/HTML so a
 * future "simplification" that breaks the DEC look is caught.
 *
 * Run with:  node tests/lp11-cabinet-css.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const PDP11_CSS = path.join(__dirname, "..", "css", "pdp11.css");
const G60_CSS = path.join(__dirname, "..", "css", "g60printer.css");
const PDP11_HTML = path.join(__dirname, "..", "pdp11.html");

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
    const pdp11Css = fs.readFileSync(PDP11_CSS, "utf8");
    const g60Css = fs.readFileSync(G60_CSS, "utf8");
    const html = fs.readFileSync(PDP11_HTML, "utf8");

    // --- Cabinet must let the fanfold keep rising above it -----------------
    {
        const rule = extractRule(pdp11Css, ".lp11-cabinet");
        assert.ok(!/overflow\s*:\s*hidden\s*;/.test(rule),
            ".lp11-cabinet must NOT clip the rising paper (no overflow:hidden):\n" + rule);
    }

    // --- Hood, vent grille and paper slot present ---------------------------
    for (const selector of [".lp11-hood", ".lp11-vents", ".lp11-paper-slot"]) {
        assert.ok(pdp11Css.includes(selector + " {"),
            "missing DEC cabinet detail: " + selector);
    }

    // --- Operator console: ONLINE LED + ON LINE key (with .off states) ------
    // The key has an engaged (pressed) look while ON LINE and a released look
    // when .off, so the lit ONLINE LED always matches the key state. The READY
    // LED also gets a .busy blink style (toggled by the LP11 ticker while a
    // line prints). The paper slot carries the DEC wordmark letters.
    for (const selector of [".lp11-key-online", ".lp11-key-online.off",
            ".lp11-led-online", ".lp11-led.off", ".lp11-led-ready.busy",
            ".lp11-dec-letter"]) {
        assert.ok(pdp11Css.includes(selector + " {"),
            "missing ON LINE / READY / wordmark control style: " + selector);
    }

    // --- The mechanics bay overrides must keep the machine skin hidden ------
    // (multi-line selector — checked via a substring block, not extractRule;
    //  lastIndexOf picks the LP11-cabinet override, not the earlier webkit block)
    {
        const skinIdx = g60Css.lastIndexOf("#lp11_printer div#lp11g60printer_left,");
        assert.ok(skinIdx !== -1, "no LP11 skin-override rule in g60printer.css");
        const skinBlock = g60Css.slice(skinIdx, skinIdx + 220);
        assert.ok(/display\s*:\s*none\s*;/.test(skinBlock),
            "Google60 LP11 skin must be hidden (display:none):\n" + skinBlock);
    }

    // --- Paper + print head must draw above the DEC hood (z-index 5) --------
    // (multi-line selector — checked via a substring block, not extractRule;
    //  lastIndexOf picks the z-index override, not the earlier paper-geometry rule)
    {
        const ziIdx = g60Css.lastIndexOf("#lp11_printer div#lp11g60paper,");
        assert.ok(ziIdx !== -1, "no LP11 paper-over-hood rule in g60printer.css");
        const ziBlock = g60Css.slice(ziIdx, ziIdx + 180);
        assert.ok(/z-index\s*:\s*5\s*;/.test(ziBlock),
            "LP11 paper/print head must be above the hood (z-index:5):\n" + ziBlock);
    }

    // --- Dark paper slot: a black rectangle the fanfold climbs out of --------
    // (lastIndexOf picks the ::before rule, not its mention in the comment)
    {
        const slotIdx = g60Css.lastIndexOf("#lp11_printer::before");
        assert.ok(slotIdx !== -1, "no #lp11_printer::before paper-slot rule");
        const slotBlock = g60Css.slice(slotIdx, slotIdx + 300);
        assert.ok(/background\s*:\s*#0a0a0a\s*;/.test(slotBlock),
            "paper slot must be a black rectangle:\n" + slotBlock);
        assert.ok(/z-index\s*:\s*4\s*;/.test(slotBlock),
            "paper slot must sit BEHIND the paper (z-index:4 < 5):\n" + slotBlock);
        assert.ok(/bottom\s*:\s*60px\s*;/.test(slotBlock) && /height\s*:\s*16px\s*;/.test(slotBlock),
            "paper slot must be a NARROW slot at the carriage (bottom:60px, height:16px):\n" + slotBlock);
    }

    // --- Carriage window: a 2px frame AROUND the paper, like the ASR glass ----
    // (lastIndexOf picks the ::after rule; the frame must be wider and slightly
    //  lower than the dark slot so the slot fits entirely inside it)
    {
        const frIdx = g60Css.lastIndexOf("#lp11_printer::after");
        assert.ok(frIdx !== -1, "no #lp11_printer::after carriage-window rule");
        const frBlock = g60Css.slice(frIdx, frIdx + 1000);
        assert.ok(/z-index\s*:\s*7\s*;/.test(frBlock),
            "carriage window must draw above the paper (z-index:7):\n" + frBlock);
        assert.ok(/border\s*:\s*2px\s*solid\s*rgba\(176,\s*168,\s*144,\s*0\.55\)\s*;/.test(frBlock),
            "carriage window must be a 2px frame around the paper:\n" + frBlock);
        assert.ok(/left\s*:\s*40px\s*;\s*right\s*:\s*40px\s*;/.test(frBlock) &&
                  /bottom\s*:\s*52px\s*;/.test(frBlock),
            "carriage window must be wider and slightly lower than the slot (left/right:40px, bottom:52px):\n" + frBlock);
    }

    // --- The mechanics bay must be sand (DEC palette), not a dark bay --------
    {
        const bayIdx = g60Css.lastIndexOf("#lp11_printer {");
        assert.ok(bayIdx !== -1, "no #lp11_printer rule in g60printer.css");
        const bayBlock = g60Css.slice(bayIdx, bayIdx + 300);
        assert.ok(/background\s*:\s*#c9ae84\s*;/.test(bayBlock),
            "mechanics bay must be sand (DEC palette):\n" + bayBlock);
    }

    // --- Cabinet + hood in the sand cast-plastic family (like the teletype) --
    // The cabinet and the top hood share the sand gradient with the same grain,
    // so the LP11 matches the rest of the DEC equipment. The hood is slightly
    // lighter at the top (the lit lid); both use the sand border #a68c66.
    {
        const cab = extractRule(pdp11Css, ".lp11-cabinet");
        assert.ok(/background\s*:\s*(?:radial-gradient\([^;]*?\),\s*)?url\("data:image\/svg\+xml,[\s\S]*?linear-gradient\(180deg,\s*#d6bd99\s*0%,\s*#c9ae84\s*22%,\s*#bfa67e\s*100%\)\s*;/.test(cab),
            "the LP11 cabinet must carry the grain over the sand gradient #d6bd99→#c9ae84→#bfa67e:\n" + cab);
        assert.ok(/border\s*:\s*1px\s+solid\s+#a68c66\s*;/.test(cab),
            "the LP11 cabinet border must use #a68c66:\n" + cab);

        const hood = extractRule(pdp11Css, ".lp11-hood");
        assert.ok(/background\s*:\s*url\("data:image\/svg\+xml,[\s\S]*?linear-gradient\(180deg,\s*#dcc9a5\s*0%,\s*#cdb287\s*70%,\s*#bfa67e\s*100%\)\s*;/.test(hood),
            "the LP11 hood must carry the grain over the sand gradient #dcc9a5→#cdb287→#bfa67e:\n" + hood);
        assert.ok(/border\s*:\s*1px\s+solid\s+#a68c66\s*;/.test(hood),
            "the LP11 hood border must use #a68c66:\n" + hood);
    }

    // --- Mechanics bay itself must not clip the paper (overflow: visible) ---
    {
        // The LAST #lp11_printer rule in g60printer.css is the LP11-cabinet
        // override (beige background); it must set overflow: visible.
        const lastIdx = g60Css.lastIndexOf("#lp11_printer {");
        assert.ok(lastIdx !== -1, "no #lp11_printer rule in g60printer.css");
        const tail = g60Css.slice(lastIdx);
        assert.ok(/overflow\s*:\s*visible\s*;/.test(tail),
            "LP11 mechanics bay must be overflow: visible (paper leaves the slot):\n" + tail.slice(0, 400));
    }

    // --- Printer-page markup: hood + paper slot + ON LINE LED/key -----------
    {
        // The page-printer cabinet block runs from '<div class="lp11-cabinet">'
        // to its closing '</div>' before '<p class="printer-actions">'.
        const start = html.indexOf('<div class="lp11-cabinet">');
        assert.ok(start !== -1, "no .lp11-cabinet in pdp11.html");
        const end = html.indexOf('<p class="printer-actions">', start);
        assert.ok(end !== -1 && end > start, "no printer-actions row after the cabinet");
        const block = html.slice(start, end);
        assert.ok(block.includes('class="lp11-hood"'),
            "lp11-cabinet must contain the top cover (.lp11-hood)");
        assert.ok(block.includes('class="lp11-paper-slot"'),
            "lp11-cabinet must contain the paper slot (.lp11-paper-slot)");
        assert.ok(block.includes('class="lp11-dec-letter"'),
            "paper slot must carry the DEC 'digital' wordmark (.lp11-dec-letter)");
        assert.ok(!/class="lp11-badge"/.test(block),
            "lp11-cabinet must NOT contain the old .lp11-badge (wordmark lives in the slot)");
        assert.ok(block.includes('id="lp11-online-led"'),
            "lp11-cabinet must contain the ONLINE LED (#lp11-online-led)");
        assert.ok(block.includes('id="lp11-online-key"'),
            "lp11-cabinet must contain the ON LINE key (#lp11-online-key)");
        assert.ok(block.includes("window.lp11OnLine"),
            "ON LINE key must call window.lp11OnLine()");
    }

    console.log("lp11-cabinet-css: all tests passed");
}

run();
