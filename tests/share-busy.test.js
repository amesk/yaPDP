#!/usr/bin/env node
/**
 * Share busy-state contract.
 *
 * Preparing a share artifact is not instant: an IndexedDB read, the container,
 * its gzip and (for a text share) a base64 envelope of tens of megabytes.
 * tools/_probe-share-timing.js measured 5.4 s for a self-contained BSD 2.11
 * state and 0.1 s for an ordinary snapshot, so the indicator must appear late
 * enough not to flash and the work must not be started twice.
 *
 * Those are DOM behaviours (they cannot be driven without a page), so this test
 * pins the CONTRACT in the shipping sources — the same approach the refusal
 * tests in tests/share-payload.test.js use:
 *   1. the busy line reuses the project's spinner and shows only after a delay;
 *   2. the Share item carries aria-busy and a spinner while it prepares;
 *   3. one in-flight creation per field-value signature, shared by every action;
 *   4. no action bypasses it, and no button stays disabled after a failure;
 *   5. the screenshot menu reports its own capture the same way;
 *   6. the CSS behind those states exists, and respects reduced motion.
 *
 * Run with:  node tests/share-busy.test.js
 * Exit code 0 = all passed.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SNAPSHOTS = fs.readFileSync(path.join(ROOT, "src", "snapshots.js"), "utf8");
const SCREENSHOT = fs.readFileSync(path.join(ROOT, "src", "screenshot.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "css", "pdp11.css"), "utf8");

let failures = 0;
function check(name, ok, detail) {
    if (ok) {
        console.log("  ok  " + name);
        return;
    }
    failures++;
    console.error("  FAIL " + name + (detail ? "  (" + detail + ")" : ""));
}

function countOf(source, needle) {
    return source.split(needle).length - 1;
}

// ---- 1. the busy line ----------------------------------------------------
console.log("\n=== 1. the busy line ===");
check("1a: the dialog waits before showing work in progress",
    /var SHARE_BUSY_DELAY = \d+;/.test(SNAPSHOTS));
check("1b: and the delay is long enough not to flash on a normal snapshot",
    (function () {
        const m = /var SHARE_BUSY_DELAY = (\d+);/.exec(SNAPSHOTS);
        return m && Number(m[1]) >= 200 && Number(m[1]) <= 1000;
    })());
check("1c: the busy line is built from the shared spinner",
    /className = "yapdp-spin share-status-spin"/.test(SNAPSHOTS));
check("1d: it reuses the refusal slot, so a toast cannot hide under the modal",
    /function setShareBusy\(message\)[\s\S]{0,1200}share-status--busy/.test(SNAPSHOTS));
check("1e: and it is the single place that clears it",
    /function stopShareBusy\(\)[\s\S]{0,250}setShareBusy\(null\)/.test(SNAPSHOTS));

// ---- 2. the Share item ---------------------------------------------------
console.log("\n=== 2. the Share item ===");
check("2a: setShareItem knows a busy state",
    /function setShareItem\(mode, enabled, note, busy\)/.test(SNAPSHOTS));
check("2b: which puts a spinner in the item",
    /className = "yapdp-spin split-btn-item-spin"/.test(SNAPSHOTS));
check("2c: and says so to assistive tech",
    /item\.setAttribute\("aria-busy", "true"\)/.test(SNAPSHOTS));
check("2d: the attribute is removed once it is ready",
    /item\.removeAttribute\("aria-busy"\)/.test(SNAPSHOTS));

// ---- 3. one creation at a time ------------------------------------------
console.log("\n=== 3. one creation at a time ===");
check("3a: an in-flight run is keyed by the field values",
    /if \(shareRun && shareRun\.sig === sig\) return shareRun\.promise;/.test(SNAPSHOTS));
check("3b: and it is forgotten when it settles",
    countOf(SNAPSHOTS, "if (shareRun === entry) shareRun = null;") === 2,
    String(countOf(SNAPSHOTS, "if (shareRun === entry) shareRun = null;")));
check("3c: the busy state wraps the whole action, not just the creation",
    /function shareWork\(opts, work\)[\s\S]{0,700}startShareBusy\(\)[\s\S]{0,400}stopShareBusy\(\)/.test(SNAPSHOTS));
check("3d: createShareableState reports the expensive stages",
    SNAPSHOTS.indexOf('stage("pack");') !== -1 &&
    SNAPSHOTS.indexOf('stage("compress");') !== -1);
check("3e: the dialog names those stages",
    /"Packing the state/.test(SNAPSHOTS) && /"Compressing the state/.test(SNAPSHOTS));

// ---- 4. every action goes through it ------------------------------------
console.log("\n=== 4. every action goes through it ===");
// The definition and the one call inside runShareable: anywhere else would be
// an action that starts its own compression.
check("4a: doCreateShareable is called from one place only",
    countOf(SNAPSHOTS, "doCreateShareable(") === 2,
    String(countOf(SNAPSHOTS, "doCreateShareable(")));
check("4b: the clipboard action shares the in-flight build",
    /withShareableBytes\(opts, function \(bytes\) \{[\s\S]{0,1200}Text envelope copied/.test(SNAPSHOTS));
check("4c: so does the text-file action",
    /withShareableBytes\(opts, function \(bytes\) \{[\s\S]{0,1200}downloadBytes/.test(SNAPSHOTS));
check("4d: so does the Gist action",
    /withShareableBytes\(opts, function \(bytes\) \{[\s\S]{0,1200}showGistDialog/.test(SNAPSHOTS));
check("4e: the main button reports a failure instead of staying dead",
    /shareWork\(opts, function \(bytes\) \{[\s\S]{0,400}createBtn\.disabled = false[\s\S]{0,500}createBtn\.disabled = false/.test(SNAPSHOTS));
check("4f: a failed preparation is announced where the operator looks",
    /Could not prepare the state for sharing", "error"/.test(SNAPSHOTS));

// ---- 5. the screenshot menu ---------------------------------------------
console.log("\n=== 5. the screenshot menu ===");
check("5a: its Share item gets a busy state",
    /function setMenuItemBusy\(button, text\)/.test(SCREENSHOT));
check("5b: built from the same spinner",
    /className = "yapdp-spin screenshot-context-item-spin"/.test(SCREENSHOT));
check("5c: announced to assistive tech",
    /button\.setAttribute\("aria-busy", "true"\)/.test(SCREENSHOT));
check("5d: shown only after a delay",
    /sharePrepareTimer = setTimeout\(function \(\) \{[\s\S]{0,300}\}, \d+\);/.test(SCREENSHOT));
check("5e: and cleared when the menu closes",
    /function hideContextMenu\(\) \{\s*clearSharePrepareTimer\(\);/.test(SCREENSHOT));
check("5f: a capture that cannot be shared says why on the item",
    /Share\\u2026 \(unavailable\)/.test(SCREENSHOT) ||
    /\(unavailable\)/.test(SCREENSHOT));

// ---- 6. the CSS behind it ----------------------------------------------
console.log("\n=== 6. the CSS behind it ===");
check("6a: the split-menu item has a busy look that is not the disabled look",
    /\.split-btn-item\[aria-busy="true"\] \{[\s\S]{0,200}opacity: 1;/.test(CSS));
check("6b: the screenshot item too",
    /\.screenshot-context-item\[aria-busy="true"\] \{[\s\S]{0,200}opacity: 1;/.test(CSS));
check("6c: the busy line is a row with the spinner",
    /\.share-status--busy \{[\s\S]{0,160}display: flex;/.test(CSS));
check("6d: the three item spinners are sized down",
    (CSS.match(/-spin \{\s*width: 12px;/g) || []).length >= 3,
    String((CSS.match(/-spin \{\s*width: 12px;/g) || []).length));
check("6e: reduced motion already turns the shared spinner off",
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.yapdp-spin \{\s*animation: none;/.test(CSS));

console.log("");
if (failures) {
    console.error(failures + " share-busy check(s) failed");
    process.exit(1);
}
console.log("All share-busy tests passed.");
