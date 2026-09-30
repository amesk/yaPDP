#!/usr/bin/env node
/**
 * Front-panel lamp CSS/JS contract tests.
 *
 * Guards the historic look of the PDP-11/70 indicator panel: the lamp fields are
 * monochrome — one lit red and one dark unlit lens — and the panel owns exactly
 * 64 lamps (22 address + 16 data + 26 status), the count a real 11/70 shows.
 *
 * Pinned here:
 *   • css/pdp11.css defines --ledColor (lit) and --ledOffColor (unlit lens), and
 *     every lamp rule reads them through var() — the panel has ONE source of
 *     colour, not a literal per rule;
 *   • the lit colour is the requested red band (#ff2600..#ff3a00): a full red
 *     channel, a small green channel and no blue, so no yellow/orange core and
 *     no purple may creep back into the lamp;
 *   • the unlit colour is a near-black red (the lens is always visible — a real
 *     panel shows every lens, lit or not);
 *   • the volume of a lamp comes from the shading (an inset dome: a lit
 *     top-left edge, a shaded bottom-right one, plus a halo while lit) and not
 *     from a second hue, so the panel stays monochrome;
 *   • initPanel() reports an EMPTY "lights shown" mask, because the DOM starts
 *     unlit: an all-ones mask makes the first updateLights() skip every lamp that
 *     is already supposed to be lit, and with the class as the only way to light
 *     a lamp those lamps stay dark (the DATA PATHS regression);
 *   • pdp11.html carries the 64 lamps and gives none of them an inline colour;
 *   • src/pdp11.js lights a lamp by toggling the .lit class on the element
 *     (setLamp()), and never hides a lamp with visibility any more.
 *
 * These are deliberately simple string checks on the production CSS/HTML/JS so a
 * future "simplification" that repaints the panel is caught.
 *
 * Run with:  node tests/panel-lamp-css.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const PDP11_CSS = path.join(__dirname, "..", "css", "pdp11.css");
const PDP11_HTML = path.join(__dirname, "..", "pdp11.html");
const PDP11_JS = path.join(__dirname, "..", "src", "pdp11.js");

// The lamp groups a real 11/70 panel shows (see initPanel() in src/pdp11.js).
const LAMPS = { a: 22, d: 16, s: 26 };
const LAMP_TOTAL = LAMPS.a + LAMPS.d + LAMPS.s; // 64

// "#rrggbb" -> { r, g, b }.
function hex(h) {
    const n = parseInt(h.slice(1), 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

// Every colour stop of a CSS variable/property value, in source order.
function stops(value) {
    return (value.match(/#[0-9a-fA-F]{6}/g) || []).map(hex);
}

function run() {
    const css = fs.readFileSync(PDP11_CSS, "utf8");
    const html = fs.readFileSync(PDP11_HTML, "utf8");
    const js = fs.readFileSync(PDP11_JS, "utf8");

    // --- The two lamp colours are variables, not literals in the rules -----
    const lit = /--ledColor:\s*([^;]+);/.exec(css);
    const off = /--ledOffColor:\s*([^;]+);/.exec(css);
    assert.ok(lit, "css/pdp11.css must define --ledColor");
    assert.ok(off, "css/pdp11.css must define --ledOffColor");

    // --- Lit: the red band #ff2600..#ff3a00 (no yellow core, no purple) ----
    {
        const band = stops(lit[1]);
        assert.ok(band.length >= 2,
            "--ledColor must fade between red stops:\n" + lit[1]);
        assert.ok(!/yellow/i.test(lit[1]),
            "the lit lamp must not carry a yellow core:\n" + lit[1]);
        for (const c of band) {
            assert.ok(c.g <= 0x3a,
                "every lit stop must stay in the red family (green <= 0x3a):\n" + lit[1]);
            assert.strictEqual(c.b, 0x00,
                "the lit lamp must carry no blue:\n" + lit[1]);
        }
        assert.strictEqual(band[0].r, 0xff,
            "the lit core must keep a full red channel:\n" + lit[1]);
        assert.ok(band[band.length - 1].r < band[0].r,
            "the lit colour must darken toward the rim — that ramp is the " +
            "lamp's volume, and without it a lamp reads as a flat disc:\n" + lit[1]);
    }

    // --- Unlit: a near-black lens with a faint red bias -------------------
    {
        const lens = stops(off[1]);
        assert.strictEqual(lens.length, 1,
            "--ledOffColor must be a single dark lens shade:\n" + off[1]);
        const c = lens[0];
        assert.ok(c.r > 0x00 && c.r <= 0x20,
            "the unlit lens must be near-black red (got " + off[1] + ")");
        assert.strictEqual(c.b, 0x00, "the unlit lens must carry no blue: " + off[1]);
        assert.ok(c.g <= 0x10,
            "the unlit lens must stay near-black, not grey (got " + off[1] + ")");
        assert.ok(c.g < c.r,
            "the unlit lens must keep its warm red bias (got " + off[1] + ")");
    }

    // --- Lamp rules read the variables (one source of colour) -------------
    {
        const base = /\.mainLed,\s*\.rotaryLed\s*\{([^}]*)\}/.exec(css);
        assert.ok(base, "css must style .mainLed / .rotaryLed together");
        assert.ok(/background:\s*var\(--ledOffColor\)/.test(base[1]),
            "an unlit lamp must be painted with var(--ledOffColor):\n" + base[1]);

        assert.ok(/box-shadow:[^;]*inset 1px 1px/.test(base[1]),
            "the lens must keep a lit top-left edge (dome shading):\n" + base[1]);
        assert.ok(/box-shadow:[^;]*inset -1px -1px/.test(base[1]),
            "the lens must keep a shaded bottom-right edge:\n" + base[1]);

        const on = /\.mainLed\.lit,\s*\.rotaryLed\.lit\s*\{([^}]*)\}/.exec(css);
        assert.ok(on, "css must style the lit state .mainLed.lit / .rotaryLed.lit");
        assert.ok(/background:\s*var\(--ledColor\)/.test(on[1]),
            "a lit lamp must be painted with var(--ledColor):\n" + on[1]);
        assert.ok(/box-shadow:[^;]*inset 1px 1px/.test(on[1]),
            "a lit lamp must keep the dome shading:\n" + on[1]);
        assert.ok(/0 0 \d+px rgba/.test(on[1]),
            "a lit lamp must keep its halo so it reads as emitting:\n" + on[1]);
    }

    // --- The panel carries all 64 lamps, none with an inline colour -------
    {
        const tags = html.match(/<(?:div|span)[^>]*class=["']?(?:mainLed|rotaryLed)["']?[^>]*>/g) || [];
        assert.strictEqual(tags.length, LAMP_TOTAL,
            "pdp11.html must carry the " + LAMP_TOTAL + " panel lamps, found " +
            tags.length);

        const seen = { a: 0, d: 0, s: 0 };
        for (const tag of tags) {
            const id = /id=["']?([asd])(\d+)["']?/.exec(tag);
            assert.ok(id, "every panel lamp must be addressable by id:\n" + tag);
            seen[id[1]] += 1;
            assert.ok(!/style=/.test(tag),
                "a panel lamp must not carry an inline style (the colour belongs in the CSS):\n" + tag);
        }
        for (const group of Object.keys(LAMPS)) {
            assert.strictEqual(seen[group], LAMPS[group],
                "the panel must carry " + LAMPS[group] + " '" + group +
                "' lamps, found " + seen[group]);
        }
    }

    // --- The lamp groups the runtime drives match the HTML ----------------
    for (const group of Object.keys(LAMPS)) {
        const call = new RegExp("initPanel\\(panel\\.\\w+Id,\\s*\"" + group +
            "\",\\s*" + LAMPS[group] + "\\)");
        assert.ok(call.test(js),
            "pdp11.js must wire the '" + group + "' lamps with initPanel(..., \"" +
            group + "\", " + LAMPS[group] + ")");
    }

    // --- A lamp is switched by the .lit class, never by visibility --------
    {
        assert.ok(/idArray\[id\]\s*=\s*elementId;/.test(js),
            "initPanel() must keep the lamp ELEMENT so the class can be toggled");
        assert.ok(/classList\.toggle\('lit',\s*lit\)/.test(js),
            "setLamp() must toggle the .lit class on the lamp");
        assert.ok(/setLamp\(idArray\[id\],/.test(js),
            "updateLights() must light its lamps through setLamp()");
        assert.ok(!/idArray\[id\]\.visibility/.test(js),
            "a panel lamp must no longer be hidden with visibility — the lens is always visible");
    }

    // --- The lights the DOM starts with: NONE ------------------------------
    // updateLights() writes only the lamps whose bit DIFFERS from the mask it
    // keeps, so the mask has to start empty — the CSS paints every lens dark.
    {
        const init = /function initPanel\([\s\S]*?\n\}/.exec(js);
        assert.ok(init, "pdp11.js must define initPanel()");
        assert.ok(/return 0;/.test(init[0]),
            "initPanel() must report an empty 'lights shown' mask: the lamps start " +
            "unlit in the DOM (.mainLed paints the unlit shade), and any other start " +
            "leaves every already-lit lamp dark after the first updateLights():\n" + init[0]);
    }

    console.log("panel-lamp-css: all tests passed");
}

run();
