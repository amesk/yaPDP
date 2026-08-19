#!/usr/bin/env node
/**
 * ImageError messageFor() modular tests.
 *
 * Loads the real production module (src/imgerror.js) in an isolated VM
 * context and exercises its DOM-free messageFor(url, reason) helper: the
 * mapping from a fetch/decode failure reason (network / truncated /
 * decompress) to the title and body shown in the modal overlay.
 *
 * Run with:  node tests/imgerror.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "imgerror.js");

// The module assigns window.reportImageLoadError, so a minimal window stub is
// enough to load it; the DOM overlay code is never exercised here.
function loadModule() {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = { console, window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.ImageError;
}

function run() {
    const ImageErr = loadModule();
    assert.ok(ImageErr, "module should expose ImageError");
    assert.strictEqual(typeof ImageErr.messageFor, "function",
        "messageFor should be exposed");

    // ---- 'truncated' (server dropped the connection mid-body) --------
    {
        const msg = ImageErr.messageFor("rl0.dsk", "truncated");
        assert.strictEqual(msg.title, "Image load interrupted");
        assert.strictEqual(msg.url, "rl0.dsk", "url should pass through");
        assert.ok(msg.body.indexOf("was not loaded") !== -1);
        assert.ok(/connection was dropped/i.test(msg.body),
            "truncated reason should explain the dropped connection");
    }

    // ---- 'decompress' (fzstd could not decode the received bytes) ----
    {
        const msg = ImageErr.messageFor("rp0.dsk", "decompress");
        assert.strictEqual(msg.title, "Image load interrupted");
        assert.strictEqual(msg.url, "rp0.dsk");
        assert.ok(/could not\s+be decompressed/i.test(msg.body),
            "decompress reason should mention the decompression failure");
    }

    // ---- 'network' / unknown reason (unreachable or missing file) ----
    {
        const msg = ImageErr.messageFor("tm0.tap", "network");
        assert.strictEqual(msg.title, "Image load interrupted");
        assert.ok(/could not be reached over the network/i.test(msg.body),
            "network reason should explain the unreachable image");

        const unknown = ImageErr.messageFor("x.dsk", "bogus");
        assert.strictEqual(unknown.title, "Image load interrupted");
        assert.ok(/could not be reached over the network/i.test(unknown.body),
            "unknown reason should fall back to the network message");
    }

    // ---- context-specific wording (local file:// and Tauri Minimal) --
    {
        // A page opened as a local file (file://) cannot fetch the media dir.
        const fileMsg = ImageErr.messageFor("rp1.dsk", "network", { fileProtocol: true });
        assert.ok(/local file \(file:\/\/\)/i.test(fileMsg.body),
            "file:// context should explain the local-file block");
        assert.ok(/blocked/i.test(fileMsg.body),
            "file:// context should mention that the browser blocked the request");
        assert.ok(/web server/i.test(fileMsg.body),
            "file:// context should suggest a local web server");

        // The Tauri Minimal build simply does not ship most images.
        const tauriMsg = ImageErr.messageFor("rp1.dsk", "network", { tauri: true });
        assert.ok(/Minimal desktop build/i.test(tauriMsg.body),
            "Tauri context should mention the Minimal build");
        assert.ok(/Drop zone/i.test(tauriMsg.body),
            "Tauri context should point at the Drop zone");
    }

    // ---- url coercion -------------------------------------------------
    {
        const empty = ImageErr.messageFor(undefined, "truncated");
        assert.strictEqual(empty.url, "", "missing url should coerce to empty string");
    }

    console.log("imgerror tests passed");
}

run();
