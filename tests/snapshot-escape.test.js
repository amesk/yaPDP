#!/usr/bin/env node
/**
 * Snapshot Share dialog — HTML-escaping regression tests.
 *
 * showShareDialog() interpolates the snapshot's name into the modal markup
 * (innerHTML), both as a text node and as a quoted attribute value
 * (value="..."). That escaping was once a hand-copied no-op — every character
 * was replaced by itself — so a crafted snapshot name could close the
 * attribute and inject HTML. This test drives the real escapeHtml() helper
 * from src/snapshots.js in a VM sandbox and pins the five-character escape.
 *
 * Run with:  node tests/snapshot-escape.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "snapshots.js");

// Entity texts are assembled from an ampersand constant so this test's own
// source carries no bare entity token.
const AMP = String.fromCharCode(38);
function ent(name) { return AMP + name; }

function extractIIFE(src, startMarker) {
    const start = src.indexOf(startMarker);
    if (start === -1) throw new Error("marker not found: " + startMarker);
    const braceOpen = src.indexOf("{", start);
    let depth = 0;
    for (let i = braceOpen; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return src.slice(start, i + 2 + 2); // "})();"
        }
    }
    throw new Error("unbalanced braces for: " + startMarker);
}

function makeSandbox() {
    return {
        console,
        Uint8Array, Uint16Array, Uint32Array, ArrayBuffer, DataView,
        Map, Set, Promise,
        setTimeout, clearTimeout, setInterval: () => 0,
        CompressionStream, DecompressionStream,
        TextEncoder, TextDecoder,
        Response,
        StateFormat: undefined,
        StateFrame: undefined,
    };
}

function loadEscaper() {
    const src = fs.readFileSync(SOURCE_PATH, "utf8");
    const code = extractIIFE(src, "var SnapshotStore = (() => {");
    const sb = makeSandbox();
    vm.createContext(sb);
    vm.runInContext(code, sb);
    const store = sb.SnapshotStore;
    if (!store || typeof store.escapeHtml !== "function") {
        throw new Error("SnapshotStore.escapeHtml is not exposed");
    }
    return store.escapeHtml;
}

function run() {
    const escapeHtml = loadEscaper();

    // Each of the five markup-significant characters maps to its entity.
    assert.strictEqual(escapeHtml("a " + AMP + " b"), "a " + ent("amp;") + " b");
    assert.strictEqual(escapeHtml("a < b"), "a " + ent("lt;") + " b");
    assert.strictEqual(escapeHtml("a > b"), "a " + ent("gt;") + " b");
    assert.strictEqual(escapeHtml('"x"'), ent("quot;") + "x" + ent("quot;"));
    assert.strictEqual(escapeHtml("it's"), "it" + ent("#39;") + "s");

    // null / undefined become the empty string, not "null" / "undefined".
    assert.strictEqual(escapeHtml(null), "");
    assert.strictEqual(escapeHtml(undefined), "");

    // An existing entity is double-escaped, because & is escaped first.
    assert.strictEqual(escapeHtml(AMP + "amp;"), ent("amp;") + "amp;");

    // The attribute-breakout payload must survive as inert text only.
    const evil = '"><img src=x onerror=alert(1)>';
    const out = escapeHtml(evil);
    for (const ch of ['<', '>', '"']) {
        assert.strictEqual(out.indexOf(ch), -1,
            "escaped name must contain no raw '" + ch + "'");
    }
    assert.ok(out.indexOf(ent("lt;") + "img") !== -1, "tags are escaped, not dropped");

    console.log("All snapshot-escape tests passed.");
}

run();
