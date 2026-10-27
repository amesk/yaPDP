#!/usr/bin/env node
/**
 * Preparing-toast layout contract.
 *
 * The "Preparing the machine" toast (#quick-boot-preparing) restores a shared
 * state and carries an optional state title, description, screenshot and the
 * OK button that hands the machine over. On a phone it used to be unusable:
 * the box was sized shrink-to-fit against the left half of the window (a
 * `left: 50%` + `width: auto` fixed box), so in portrait it was ~180px wide
 * and the button fell below the bottom edge; in landscape the height cap made
 * the inherited `flex-wrap: wrap` open a SECOND column, putting the button
 * beside the description.
 *
 * These checks pin the three rules that keep the toast readable on a phone:
 *   • a column toast never wraps (no second column, no side-by-side button);
 *   • the box is pinned to the window instead of shrinking to half of it;
 *   • the box is height-capped and scrolls, so the actions stay reachable.
 *
 * Run with:  node tests/preparing-toast-layout.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const PDP11_CSS = path.join(__dirname, "..", "css", "pdp11.css");

// Comments are stripped first: the rules below carry prose that mentions
// property names ("width: auto", "flex-wrap"), and a naive regex would find
// those words instead of the declarations.
function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Every `selector { ... }` block for an exact selector, in source order.
function blocksOf(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("(^|[\\s,])" + escaped + "\\s*\\{([^}]*)\\}", "g");
    const out = [];
    let m;
    while ((m = re.exec(css)) !== null) out.push(m[2]);
    return out;
}

function run() {
    const css = stripComments(fs.readFileSync(PDP11_CSS, "utf8"));

    // ---- The autoload toast keeps its row layout ------------------------
    {
        const base = blocksOf(css, ".quickboot-balloon");
        assert.ok(base.length > 0, "css/pdp11.css must define .quickboot-balloon");
        assert.ok(/max-width:/.test(base[0]),
            "the autoload toast must never be wider than the window");
        assert.ok(/flex-wrap:\s*wrap/.test(base[0]),
            "the autoload toast is a row and must still wrap");
    }

    // ---- The preparing toast: a pinned, non-wrapping column --------------
    {
        const own = blocksOf(css, "#quick-boot-preparing.quickboot-balloon");
        assert.ok(own.length > 0,
            "css/pdp11.css must style #quick-boot-preparing.quickboot-balloon");

        const base = own[0];
        assert.ok(/flex-direction:\s*column/.test(base),
            "the preparing toast stacks its parts vertically");
        assert.ok(/flex-wrap:\s*nowrap/.test(base),
            "a column toast must not wrap: wrap opens a second column and " +
            "the OK button lands beside the description");
        assert.ok(/width:\s*calc\(/.test(base),
            "the toast must be pinned to the window, not sized shrink-to-fit " +
            "against the left half of it");
        assert.ok(/max-height:\s*calc\(100vh\s*-/.test(base) &&
                  /max-height:\s*calc\(100dvh\s*-/.test(base),
            "the toast needs a viewport height cap (with a vh fallback)");
        assert.ok(/overflow-y:\s*auto/.test(base),
            "a capped toast must scroll, or its last part becomes unreachable");
    }

    // ---- Phone: the preview cannot eat the whole screen ------------------
    {
        const media = /@media\s*\(max-width:\s*768px\)/.exec(css);
        assert.ok(media, "css/pdp11.css must keep its phone media block");
        const phoneCss = css.slice(media.index);
        const shot = blocksOf(phoneCss, ".quickboot-balloon-screenshot");
        assert.ok(shot.length > 0,
            "the phone block must cap the state preview in the preparing toast");
        assert.ok(/max-height:\s*[\d.]+vh/.test(shot[0]),
            "the screenshot must be capped relative to the viewport height");
    }

    // ---- Landscape: the short screen keeps its own compaction ------------
    {
        const media = /@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*500px\)/.exec(css);
        assert.ok(media, "css/pdp11.css must keep the phone-landscape block");
        const landscapeCss = css.slice(media.index);
        const own = blocksOf(landscapeCss, "#quick-boot-preparing.quickboot-balloon");
        assert.ok(own.length > 0,
            "the preparing toast needs a compact landscape layout");
        assert.ok(/top:/.test(own[0]) && /max-height:/.test(own[0]),
            "the landscape toast must be anchored and height-capped");
    }

    console.log("preparing-toast-layout.test.js: all tests passed");
}

run();
