#!/usr/bin/env node
/**
 * yaPDP — platform-share policy tests (Machine State → Share).
 *
 * The Share dialog hands a machine state to the platform share sheet. The
 * policy that decides WHAT is handed over lives in two DOM-free helpers of
 * src/snapshots.js (shareCapabilities / sharePayloadFor). This test drives the
 * real SnapshotStore IIFE in a VM sandbox and pins the rule:
 *
 *   1. the .state.txt FILE (full text envelope) — text/plain is the one type
 *      every share sheet routes, so a tap tries it first;
 *   2. the .state.zst container — compact, and the only file channel left once
 *      the envelope is too big to build or to attach;
 *   3. the full envelope as share TEXT while it fits a text channel;
 *   4. otherwise nothing shareable — the caller copies the full envelope to the
 *      clipboard. Truncating the envelope (text.slice(0, 2048)) is the bug this
 *      policy exists to prevent, so it is asserted against in the source too.
 * A mode the platform actually REFUSED is skipped for the rest of the session:
 * canShare() answers for the type only, and Chrome says "yes" for a container
 * it then refuses (application/octet-stream on Android), so re-offering it
 * spends a click on a known dead end.
 *
 * Run with:  node tests/share-payload.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SOURCE_PATH = path.join(ROOT, "src", "snapshots.js");
const { StateEnvelope } = require(path.join(ROOT, "src", "state-envelope.js"));

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log("  ok  " + name);
    } else {
        failures++;
        console.error("  FAIL " + name + (detail ? " — " + detail : ""));
    }
}

// ------------------------------------------------------------------
// Load the real SnapshotStore IIFE into a minimal sandbox
// ------------------------------------------------------------------
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
        StateFrame: undefined
    };
}

function loadStore() {
    const src = fs.readFileSync(SOURCE_PATH, "utf8");
    const sb = makeSandbox();
    vm.createContext(sb);
    vm.runInContext(extractIIFE(src, "var SnapshotStore = (() => {"), sb);
    const store = sb.SnapshotStore;
    if (!store || typeof store.sharePayloadFor !== "function") {
        throw new Error("SnapshotStore.sharePayloadFor is not exposed");
    }
    if (typeof store.shareCapabilities !== "function" ||
        typeof store.envelopeLengthFor !== "function") {
        throw new Error("SnapshotStore share helpers are not exposed");
    }
    return store;
}

const store = loadStore();
// A MOBILE sheet is the only one that takes files: a desktop canShare() says
// "yes" and then refuses the payload, spending the click's activation.
const ALL_CAPS = { hasShare: true, canShareZst: true, canShareTxt: true, isMobile: true };
const TXT_ONLY_CAPS = { hasShare: true, canShareZst: false, canShareTxt: true, isMobile: true };
const TEXT_ONLY_CAPS = { hasShare: true, canShareZst: false, canShareTxt: false, isMobile: true };
const DESKTOP_CAPS = { hasShare: true, canShareZst: true, canShareTxt: true, isMobile: false };

// ------------------------------------------------------------------
// 1. envelopeLengthFor() predicts the real encoder's output length
// ------------------------------------------------------------------
(function testEnvelopeLength() {
    console.log("\n=== 1. envelopeLengthFor matches StateEnvelope.encode ===");
    [1, 2, 3, 57, 58, 1000, 40000].forEach(function (len) {
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = (i * 31) & 0xFF;
        const real = StateEnvelope.encode(bytes).length;
        const predicted = store.envelopeLengthFor(len);
        check("1: length " + len + " predicted " + predicted + " vs real " + real,
            predicted === real);
    });
    check("1z: zero bytes gives zero length", store.envelopeLengthFor(0) === 0);
    check("1n: negative/garbage gives zero length",
        store.envelopeLengthFor(-5) === 0 && store.envelopeLengthFor(null) === 0);
})();

// ------------------------------------------------------------------
// 2. The text file travels FIRST, because a rejected type costs the tap
// ------------------------------------------------------------------
(function testTextFileFirstPayload() {
    console.log("\n=== 2. .state.txt file comes first ===");
    const p = store.sharePayloadFor(1000, "Share Test", ALL_CAPS);
    check("2a: mode is txt", p.mode === "txt", p.mode);
    check("2b: filename carries the sanitized base name",
        p.filename === "share-test.state.txt", p.filename);
    check("2c: MIME is text/plain", p.mime === "text/plain", p.mime);
    check("2d: nothing to encode", p.tooLargeToEncode === false);

    // Chrome refuses application/octet-stream AFTER answering canShare() "yes",
    // and a refusal spends the click's activation, so the opaque container can
    // only be the FIRST channel once the envelope stops being an attachment.
    // The real case: a self-contained BSD 2.11 is ~27 MB of state and a ~37 MB
    // envelope (the exported bsd.state.txt). It has to leave as the text file —
    // Chrome refuses the container, so there is no second channel for it.
    const bsd = store.sharePayloadFor(27567750, "bsd", ALL_CAPS);
    check("2e: the self-contained BSD state travels as the text file",
        bsd.mode === "txt", bsd.mode);
    const ceiling = store.sharePayloadFor(store.SHARE_ENVELOPE_MAX_BYTES, "s", ALL_CAPS);
    check("2f: even at the envelope ceiling the text file comes first",
        ceiling.mode === "txt" && ceiling.tooLargeToEncode === false, ceiling.mode);
})();

// ------------------------------------------------------------------
// 3. Text FILE when the container's MIME type is refused
// ------------------------------------------------------------------
(function testTextFilePayload() {
    console.log("\n=== 3. .state.txt file ===");
    const p = store.sharePayloadFor(1000, "Share Test", TXT_ONLY_CAPS);
    check("3a: mode is txt", p.mode === "txt", p.mode);
    check("3b: filename is .state.txt", p.filename === "share-test.state.txt", p.filename);
    check("3c: MIME is text/plain", p.mime === "text/plain", p.mime);
})();

// ------------------------------------------------------------------
// 3b. The device kind never decides: the FILE is offered everywhere
// ------------------------------------------------------------------
(function testFileOfferedOnEveryDevice() {
    console.log("\n=== 3b. The file is offered on every device kind ===");
    const desktop = store.sharePayloadFor(1000, "s", DESKTOP_CAPS);
    check("3b1: a desktop sheet gets the same text file",
        desktop.mode === "txt" && desktop.filename === "s.state.txt", desktop.mode);
    const mobile = store.sharePayloadFor(1000, "s", ALL_CAPS);
    check("3b2: and so does a mobile sheet", mobile.mode === "txt", mobile.mode);
    check("3b3: the device kind is reported but does not decide",
        DESKTOP_CAPS.isMobile === false && desktop.mode === mobile.mode);
})();

// ------------------------------------------------------------------
// 4. Share TEXT — full envelope, only while it fits
// ------------------------------------------------------------------
(function testTextPayload() {
    console.log("\n=== 4. share text ===");
    const small = store.sharePayloadFor(1000, "s", TEXT_ONLY_CAPS);
    check("4a: a small state goes as text", small.mode === "text", small.mode);
    check("4b: text mode still names the .txt file",
        small.filename === "s.state.txt", small.filename);

    // 100 KiB bytes -> ~136 KB of base64: far beyond a text channel.
    const big = store.sharePayloadFor(100 * 1024, "s", TEXT_ONLY_CAPS);
    check("4c: a large envelope is not truncated into a share text",
        big.mode === "clipboard", big.mode);
    check("4d: it is still encodable, so the clipboard can take it",
        big.tooLargeToEncode === false);

    // Exactly at the limit boundary: the decision follows the predicted length.
    const limit = store.SHARE_TEXT_LIMIT;
    let bytes = 1;
    while (store.envelopeLengthFor(bytes) <= limit) bytes++;
    const atLimit = store.sharePayloadFor(bytes - 1, "s", TEXT_ONLY_CAPS);
    const overLimit = store.sharePayloadFor(bytes, "s", TEXT_ONLY_CAPS);
    check("4e: the last length inside the limit shares as text",
        atLimit.mode === "text", atLimit.mode + " at " + (bytes - 1));
    check("4f: one byte more falls back to the clipboard",
        overLimit.mode === "clipboard", overLimit.mode + " at " + bytes);
})();

// ------------------------------------------------------------------
// 5. Clipboard fallback and the unencodable case
// ------------------------------------------------------------------
(function testClipboardPayload() {
    console.log("\n=== 5. clipboard fallback ===");
    const noShare = store.sharePayloadFor(1000, "s", { hasShare: false });
    check("5a: no navigator.share means clipboard", noShare.mode === "clipboard", noShare.mode);
    check("5b: clipboard payload names the .txt file",
        noShare.filename === "s.state.txt", noShare.filename);

    const empty = store.sharePayloadFor(0, "s", ALL_CAPS);
    check("5c: an empty state shares nothing", empty.mode === "clipboard", empty.mode);

    const huge = store.sharePayloadFor(store.SHARE_ENVELOPE_MAX_BYTES + 1, "s", { hasShare: false });
    check("5d: an unencodable state reports tooLargeToEncode", huge.tooLargeToEncode === true);
    check("5e: and there is nothing left to share", huge.mode === "clipboard", huge.mode);

    // A self-contained state can still travel as a FILE — the byte size only
    // blocks the text paths, never the file path.
    const hugeFile = store.sharePayloadFor(store.SHARE_ENVELOPE_MAX_BYTES + 1, "s", ALL_CAPS);
    check("5f: a huge state still shares as a file",
        hugeFile.mode === "zst" && hugeFile.tooLargeToEncode === false, hugeFile.mode);

    const nullCaps = store.sharePayloadFor(1000, "s", null);
    check("5g: missing capabilities fall back to the clipboard",
        nullCaps.mode === "clipboard", nullCaps.mode);
})();

// ------------------------------------------------------------------
// 6. Capability probing never throws
// ------------------------------------------------------------------
(function testCapabilities() {
    console.log("\n=== 6. shareCapabilities ===");
    const zstProbe = { name: "a.state.zst", type: "application/octet-stream" };
    const txtProbe = { name: "a.state.txt", type: "text/plain" };

    check("6a: no navigator at all",
        JSON.stringify(store.shareCapabilities(null, zstProbe, txtProbe)) ===
        JSON.stringify({ hasShare: false, canShareZst: false, canShareTxt: false, isMobile: false }));

    check("6b: navigator.share but no canShare",
        store.shareCapabilities({ share: function () {} }, zstProbe, txtProbe)
            .canShareZst === false);

    const accepting = {
        share: function () {},
        canShare: function (data) { return !!(data && data.files && data.files.length); }
    };
    const ok = store.shareCapabilities(accepting, zstProbe, txtProbe, true);
    check("6c: accepting platform reports both",
        ok.hasShare && ok.canShareZst && ok.canShareTxt);
    check("6c2: and reports the device kind it was given", ok.isMobile === true);
    check("6c3: a desktop probe reports isMobile false",
        store.shareCapabilities(accepting, zstProbe, txtProbe, false).isMobile === false);

    const refusing = { share: function () {}, canShare: function () { return false; } };
    const no = store.shareCapabilities(refusing, zstProbe, txtProbe);
    check("6d: refusing platform reports neither", !no.canShareZst && !no.canShareTxt);

    const throwing = {
        share: function () {},
        canShare: function () { throw new Error("unsupported payload"); }
    };
    const boom = store.shareCapabilities(throwing, zstProbe, txtProbe);
    check("6e: a throwing canShare is a no, not a crash",
        boom.hasShare && !boom.canShareZst && !boom.canShareTxt);

    const missingProbe = store.shareCapabilities(accepting, null, null);
    check("6f: no probe file means no file support",
        !missingProbe.canShareZst && !missingProbe.canShareTxt);
})();

// ------------------------------------------------------------------
// 7. The dialog no longer truncates the envelope
// ------------------------------------------------------------------
(function testDialogSource() {
    console.log("\n=== 7. dialog source ===");
    const src = fs.readFileSync(SOURCE_PATH, "utf8");
    // Comments may describe the old truncation; only real code must be free
    // of it, so line comments are stripped before the check.
    const codeOnly = src.split("\n").filter(function (line) {
        return !/^\s*(\/\/|\*|\/\*)/.test(line);
    }).join("\n");
    check("7a: the 2 KB share-text truncation is gone",
        codeOnly.indexOf("slice(0, 2048)") === -1);
    check("7b: the dialog prepares the artifact before the click",
        src.indexOf("prepareShareArtifact(") !== -1);
    check("7c: the artifact is invalidated when a field changes",
        src.indexOf("invalidateShareArtifact(") !== -1);
    check("7d: the share item carries the negotiated label",
        src.indexOf("function shareItemLabel(") !== -1);
    check("7e: share() is called with files",
        /files:\s*\[artifact\.file\]/.test(src));
    check("7f: the dialog carries an inline status line",
        src.indexOf('id="share-status"') !== -1);
    check("7g: refusals go to that status line, not to a toast under the modal",
        src.indexOf("function announceShare(") !== -1);
})();

// ------------------------------------------------------------------
// 8. A mode the platform refused is skipped, never re-offered
// ------------------------------------------------------------------
(function testRefusedModes() {
    console.log("\n=== 8. refused modes ===");
    const txtRefused = store.sharePayloadFor(1000, "s", ALL_CAPS, { txt: true });
    check("8a: the text file refused -> the container",
        txtRefused.mode === "zst" && txtRefused.mime === "application/octet-stream",
        txtRefused.mode + " " + txtRefused.mime);

    const filesRefused = store.sharePayloadFor(1000, "s", ALL_CAPS,
        { txt: true, zst: true });
    check("8b: both files refused -> share text",
        filesRefused.mode === "text", filesRefused.mode);

    const allRefused = store.sharePayloadFor(1000, "s", ALL_CAPS,
        { zst: true, txt: true, text: true });
    check("8c: everything refused -> clipboard", allRefused.mode === "clipboard", allRefused.mode);

    // The file path is byte-size blind, so a huge state that lost its file
    // modes must not slide into a truncated text share.
    const big = store.sharePayloadFor(100 * 1024, "s", ALL_CAPS, { txt: true, zst: true });
    check("8d: a large state with the files refused goes to the clipboard",
        big.mode === "clipboard" && big.tooLargeToEncode === false, big.mode);

    const untouched = store.sharePayloadFor(1000, "s", ALL_CAPS, {});
    check("8e: an empty refusal set decides exactly as before",
        untouched.mode === "txt", untouched.mode);
    const unsupported = store.sharePayloadFor(1000, "s", TXT_ONLY_CAPS, { txt: true });
    check("8f: refusing a mode the platform never offered changes nothing",
        unsupported.mode === "text", unsupported.mode);

    // The dialog must feed its session memory into the policy and rebuild the
    // artifact for the next channel instead of hardcoding a text retry.
    const src = fs.readFileSync(SOURCE_PATH, "utf8");
    check("8g: the dialog records the refusal",
        /shareRefusedModes\[artifact\.mode\]\s*=\s*true/.test(src));
    check("8h: and re-asks the policy with that memory",
        /sharePayloadFor\([\s\S]{0,250}shareRefusedModes\)/.test(src));
})();

console.log("");
if (failures) {
    console.error(failures + " share-payload check(s) failed");
    process.exit(1);
}
console.log("All share-payload tests passed.");
