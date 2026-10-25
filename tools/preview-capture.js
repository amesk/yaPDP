#!/usr/bin/env node
/**
 * preview-capture.js — one place that turns "the machine as the visitor sees
 * it" into a PNG suitable for embedding in a machine state.
 *
 * Why a module. Two tools need this frame: the OS screenshot generator
 * (tools/screenshots-os.js) and the browser state exporter
 * (tools/export-state-browser.js). They had — or were about to have — their own
 * idea of when to shoot and how to crop, and the crop is the part that decides
 * whether the preview LIES: a frame taken before the teletype has finished
 * printing shows half a prompt, while the state it is paired with is already
 * parked at the full one.
 *
 * The frame is therefore taken only after the RENDER has caught up
 * (tools/console-wait.js, the render hook fed by the console's own pacing), and
 * from the ACTIVE page — the teletype paper, the VT52 CRT or the VT11 display,
 * whichever the guest put in front of the operator.
 *
 * Why so small. The picture is embedded in the state as a base64 data URI, and
 * base64 of a full 1920x1080 PNG is ~400 KB per state. The target is
 * MAX_PREVIEW_BYTES before base64; anything larger is a bug in the crop, not a
 * detail worth keeping, so the encoder retries once and then refuses.
 *
 * Usage:
 *   const preview = require("./preview-capture.js");
 *   const png = await preview.captureMachinePng(page, { stableMs: 2500 });
 *   const uri = preview.toDataUri(png);
 */
"use strict";

const sharp = require("sharp");
const consoleWait = require("./console-wait.js");

// 1280 px wide keeps a card thumbnail and the restore toast sharp on a 2x
// screen without carrying a full-screen screenshot in every state.
const MAX_PREVIEW_WIDTH = 1280;
const PREVIEW_PAD = 8;
// A 1280-px screenshot of a real console measures 170-200 KB on the states in
// this repo, so the cap is a guard against a FULL-PAGE shot (~400 KB and up),
// not a quality knob — do not tighten it without re-measuring, and do not raise
// it to accommodate a missing clip.
const MAX_PREVIEW_BYTES = 256 * 1024;
const DATA_URI_PREFIX = "data:image/png;base64,";

// The active page is the machine the operator is looking at: #page-teletype,
// #page-vt52 or #page-vt11. A guest that switches to the display (Lunar Lander)
// is captured on the display, not on an empty console.
const DEFAULT_SELECTOR = ".page.active";

// Freeze what CSS animates (LEDs, blinking attributes, the textarea caret) for
// the duration of the shot. The canvas cursor blink is a JS timer and is not
// covered here — it makes consecutive previews differ, which is acceptable for
// an artefact that is written once and never overwritten by the generator.
const SHOT_CSS =
    "body.shot-mode *, body.shot-mode *::before, body.shot-mode *::after {" +
    " animation-play-state: paused !important;" +
    " transition: none !important; }" +
    " body.shot-mode textarea { caret-color: transparent !important; }";

// --- pure geometry ---------------------------------------------------------

// Padded, integral, viewport-clamped clip rectangle. Pure so the policy can be
// tested without a browser: puppeteer rejects a clip that leaves the viewport,
// and a missing pad cuts the cabinet edges that make a shot recognisable.
function clipRect(box, pad, viewport) {
    const p = (typeof pad === "number" && pad >= 0) ? pad : PREVIEW_PAD;
    if (!box || !(box.width > 0) || !(box.height > 0)) return null;
    let x = Math.round(box.x - p);
    let y = Math.round(box.y - p);
    let width = Math.round(box.width + p * 2);
    let height = Math.round(box.height + p * 2);
    if (viewport && viewport.width > 0) {
        if (x < 0) { width += x; x = 0; }
        if (x + width > viewport.width) width = viewport.width - x;
    }
    if (viewport && viewport.height > 0) {
        if (y < 0) { height += y; y = 0; }
        if (y + height > viewport.height) height = viewport.height - y;
    }
    if (width <= 0 || height <= 0) return null;
    return { x: x, y: y, width: width, height: height };
}

// --- encoding --------------------------------------------------------------

// raw PNG -> preview PNG. `width` is the requested cap; sharp never enlarges.
function encodePreview(raw, width) {
    return sharp(raw)
        .resize({ width: width || MAX_PREVIEW_WIDTH, withoutEnlargement: true })
        .png({ compressionLevel: 9, palette: true })
        .toBuffer();
}

function toDataUri(buf) {
    return DATA_URI_PREFIX + Buffer.from(buf).toString("base64");
}

// --- capture ---------------------------------------------------------------

async function installShotStyle(page) {
    await page.evaluate((css) => {
        if (document.getElementById("yapdp-shot-style")) return;
        const st = document.createElement("style");
        st.id = "yapdp-shot-style";
        st.textContent = css;
        document.head.appendChild(st);
    }, SHOT_CSS);
}

// Capture the active page as a preview PNG (Buffer).
//
// opts:
//   selector  - element to clip to (default ".page.active")
//   pad       - padding around the element, px (default PREVIEW_PAD)
//   width     - cap in px (default MAX_PREVIEW_WIDTH)
//   drain     - false to skip the render drain (the caller already waited)
//   stableMs  - quiet period of the render drain (default 2500)
//   timeoutMs - render drain timeout (default 60000)
//   maxBytes  - size cap after encoding (default MAX_PREVIEW_BYTES)
async function captureMachinePng(page, opts) {
    const o = opts || {};
    const selector = o.selector || DEFAULT_SELECTOR;
    const maxBytes = o.maxBytes || MAX_PREVIEW_BYTES;

    if (o.drain !== false) {
        // The generation hook runs ahead of the paper; only the RENDER count
        // says the teletype has actually printed what the guest produced.
        const stable = await consoleWait.waitRenderStable(
            page, o.stableMs || 2500, o.timeoutMs || 60000);
        if (!stable) {
            // Not fatal: an idle guest prints nothing and reaches "stable" at
            // once, while a guest that is still printing must not be captured
            // mid-line. The caller decides whether the frame is usable.
            console.warn("  preview: render did not settle in time");
        }
    }

    await installShotStyle(page);
    await page.evaluate(() => document.body.classList.add("shot-mode"));
    try {
        const geo = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
                box: { x: r.x, y: r.y, width: r.width, height: r.height },
                viewport: { width: window.innerWidth, height: window.innerHeight },
            };
        }, selector);

        const clip = geo ? clipRect(geo.box, o.pad, geo.viewport) : null;
        if (!geo) {
            throw new Error("preview: no element matches " + selector +
                " — the guest may not have opened a page yet");
        }
        if (!clip) throw new Error("preview: empty clip for " + selector);

        const raw = await page.screenshot({ type: "png", clip: clip });
        let png = await encodePreview(raw, o.width);
        if (png.length > maxBytes) {
            // A viewport-sized shot slipped through; halve the width once.
            const retry = Math.max(320, Math.round((o.width || MAX_PREVIEW_WIDTH) * 0.5));
            const smaller = await encodePreview(raw, retry);
            if (smaller.length > maxBytes) {
                throw new Error("preview: " + smaller.length + " bytes after " +
                    retry + "px re-encode, limit is " + maxBytes +
                    " (check the clip — a full-page shot is not a preview)");
            }
            png = smaller;
        }
        return png;
    } finally {
        await page.evaluate(() => document.body.classList.remove("shot-mode"));
    }
}

module.exports = {
    captureMachinePng: captureMachinePng,
    encodePreview: encodePreview,
    clipRect: clipRect,
    toDataUri: toDataUri,
    MAX_PREVIEW_WIDTH: MAX_PREVIEW_WIDTH,
    MAX_PREVIEW_BYTES: MAX_PREVIEW_BYTES,
    PREVIEW_PAD: PREVIEW_PAD,
    DATA_URI_PREFIX: DATA_URI_PREFIX,
    DEFAULT_SELECTOR: DEFAULT_SELECTOR,
};
