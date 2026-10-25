#!/usr/bin/env node
/**
 * tools/preview-capture.js tests.
 *
 * The module owns the frame that gets embedded in a state as its preview, and
 * the two things that can go wrong with it are geometric, not visual: a clip
 * that leaves the viewport (puppeteer refuses it) and a shot that never got
 * resized (a ~400 KB base64 blob inside every state). Both are pure functions,
 * so they are tested here without a browser.
 *
 * The encode side is exercised through sharp with a synthetic image, so the
 * test needs no committed binary fixture and no display.
 *
 * Run with:  node tests/preview-capture.test.js
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const preview = require(path.join(ROOT, "tools", "preview-capture.js"));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A wide, compressible synthetic "machine" frame: flat panel with stripes.
async function syntheticFrame(width, height) {
    const px = Buffer.alloc(width * height * 3, 0x20);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (y % 40 < 12 && x % 80 < 40) {
                const i = (y * width + x) * 3;
                px[i] = 0xc8; px[i + 1] = 0xa8; px[i + 2] = 0x60;
            }
        }
    }
    return sharp(px, { raw: { width: width, height: height, channels: 3 } })
        .png().toBuffer();
}

async function run() {
    // ---- 1. clipRect pads the element and keeps integers -------------------
    const r1 = preview.clipRect({ x: 100, y: 50, width: 400, height: 300 }, 8,
        { width: 1920, height: 1080 });
    assert.deepStrictEqual(r1, { x: 92, y: 42, width: 416, height: 316 },
        "clip is the element plus the pad, as integers: " + JSON.stringify(r1));
    console.log("PASS 1: clipRect pads around the element");

    // ---- 2. clipRect clamps to the viewport --------------------------------
    const r2 = preview.clipRect({ x: 2, y: 2, width: 1916, height: 1076 }, 8,
        { width: 1920, height: 1080 });
    assert.ok(r2.x >= 0 && r2.y >= 0, "clip starts inside the viewport");
    assert.ok(r2.x + r2.width <= 1920, "clip ends inside the viewport: " + JSON.stringify(r2));
    assert.ok(r2.y + r2.height <= 1080, "clip ends inside the viewport: " + JSON.stringify(r2));
    console.log("PASS 2: clipRect clamps to the viewport");

    // ---- 3. clipRect refuses what it cannot clip ---------------------------
    assert.strictEqual(preview.clipRect(null, 8, null), null, "no box -> null");
    assert.strictEqual(preview.clipRect({ x: 0, y: 0, width: 0, height: 0 }), null,
        "zero-sized box -> null");
    assert.strictEqual(
        preview.clipRect({ x: 3000, y: 10, width: 100, height: 100 }, 8,
            { width: 1920, height: 1080 }), null,
        "a box entirely outside the viewport -> null");
    console.log("PASS 3: clipRect rejects unusable geometry");

    // ---- 4. encodePreview caps the width and never enlarges ---------------
    const wide = await syntheticFrame(1920, 1080);
    const encoded = await preview.encodePreview(wide, 1280);
    const meta = await sharp(encoded).metadata();
    assert.strictEqual(meta.width, 1280, "wide frame is capped at 1280");
    assert.strictEqual(meta.format, "png", "preview is a PNG");
    assert.ok(encoded.slice(0, 8).equals(PNG_MAGIC), "PNG magic bytes");

    const small = await syntheticFrame(200, 135);
    const kept = await preview.encodePreview(small, 1280);
    const keptMeta = await sharp(kept).metadata();
    assert.strictEqual(keptMeta.width, 200, "a small frame is not enlarged");
    console.log("PASS 4: encodePreview caps width, never enlarges");

    // ---- 5. the size policy leaves room for base64 -----------------------
    assert.ok(encoded.length <= preview.MAX_PREVIEW_BYTES,
        "a 1280px preview stays under the byte cap: " + encoded.length +
        " vs " + preview.MAX_PREVIEW_BYTES);
    assert.strictEqual(preview.MAX_PREVIEW_BYTES, 256 * 1024,
        "the cap is 256 KB: a real 1280px console shot measures 170-200 KB, " +
        "so this catches a full-page shot, not detail");
    console.log("PASS 5: encoded preview respects MAX_PREVIEW_BYTES");

    // ---- 6. toDataUri produces exactly what the generator accepts ---------
    const uri = preview.toDataUri(encoded);
    assert.ok(uri.startsWith(preview.DATA_URI_PREFIX),
        "data URI prefix: " + preview.DATA_URI_PREFIX);
    assert.ok(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(uri),
        "the strict data-URI shape tools/gen-state-manifest.js decodes");
    assert.ok(Buffer.from(uri.slice(preview.DATA_URI_PREFIX.length), "base64")
        .equals(encoded), "base64 round-trips to the same bytes");
    console.log("PASS 6: toDataUri matches the manifest generator's contract");

    // ---- 7. the default clip target is the ACTIVE page --------------------
    assert.strictEqual(preview.DEFAULT_SELECTOR, ".page.active",
        "a guest that switched to the display must be captured there, not on " +
        "an empty console");
    console.log("PASS 7: preview clips the active page by default");
}

run().then(function () {
    console.log("\npreview-capture tests passed");
}).catch(function (e) {
    console.error("\npreview-capture tests FAILED: " + (e && e.message ? e.message : e));
    if (e && e.stack) console.error(e.stack.split("\n").slice(1, 5).join("\n"));
    process.exit(1);
});
