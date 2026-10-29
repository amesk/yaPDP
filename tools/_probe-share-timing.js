#!/usr/bin/env node
/**
 * Probe — where does "Share" spend its time?
 *
 * Both share paths prepare their payload on the MAIN THREAD, before the
 * platform sheet opens: navigator.share() has to be called from inside the
 * click handler while the user activation is alive, so the dialog builds the
 * artifact while the menu is open (see prepareShareArtifact() and
 * showContextMenu() in src/). The operator therefore waits in front of a
 * greyed-out control and has no idea whether anything is happening.
 *
 * This probe times the state half of that preparation stage by stage, without
 * a browser and on a real exported state. Every stage mirrors the code that
 * ships:
 *
 *   read       fs read of the .state.txt envelope                     (context)
 *   decode     StateEnvelope.decode(text) -> container bytes          (import path)
 *   unpack     StateFormat.unpack(container)                          sync
 *   memory     fzstd.decompress(memory blob)                          sync
 *   pack       StateFormat.pack(manifest, words, resources)           sync
 *   gzip       CompressionStream("gzip"), mirror of gzipCompress()    async
 *   envelope   StateEnvelope.encode(bytes) — base64 + 76-col wrap     sync
 *   utf8       TextEncoder().encode(text)                             sync
 *   file       new File([body], name, { type })                       sync
 *
 * NOT measured here, because they only exist in the browser — so every total
 * below is a FLOOR, not the whole wait:
 *   - the IndexedDB read of the stored snapshot (dbGet in src/snapshots.js);
 *   - collectEmbeddedResources() fetching a mounted image that is not loaded;
 *   - html2canvas in the screenshot path (the whole page, synchronously).
 *
 * Node's CompressionStream is not Chromium's: the gzip line moves between
 * runtimes. Everything else is the same JS that runs in the page, so the
 * blocking numbers are the ones to trust.
 *
 * Usage:
 *   node tools/_probe-share-timing.js
 *   node tools/_probe-share-timing.js --envelope bsd.state.txt --repeat 3
 *   node tools/_probe-share-timing.js --small states/rk1-ready.state.zst
 *   node tools/_probe-share-timing.js --json
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
const { StateEnvelope } = require(path.join(ROOT, "src", "state-envelope.js"));
const { StateFrame } = require(path.join(ROOT, "src", "state-frame.js"));
const fzstd = require(path.join(ROOT, "assets", "vendor", "fzstd.js"));
const StateIO = require(path.join(ROOT, "tools", "state-io.js"));

// ---- options -------------------------------------------------------------

function parseArgs(argv) {
    const opts = {
        envelope: "bsd.state.txt",
        small: "states/rk1-ready.state.zst",
        repeat: 3,
        json: false
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--json") { opts.json = true; continue; }
        const value = argv[i + 1];
        if (arg === "--envelope" && value) { opts.envelope = value; i++; continue; }
        if (arg === "--small" && value) { opts.small = value; i++; continue; }
        if (arg === "--repeat" && value) { opts.repeat = Math.max(1, parseInt(value, 10) || 3); i++; continue; }
        if (arg === "--help" || arg === "-h") {
            console.log("usage: node tools/_probe-share-timing.js "
                + "[--envelope file] [--small file] [--repeat N] [--json]");
            process.exit(0);
        }
    }
    return opts;
}

// ---- plumbing ------------------------------------------------------------

const REQUIRED = ["TextEncoder", "TextDecoder", "CompressionStream",
    "DecompressionStream", "Response", "btoa", "atob"];
const missing = REQUIRED.filter(function (name) { return typeof global[name] === "undefined"; });
if (missing.length) {
    console.error("this Node lacks " + missing.join(", ") + " — the share path needs them; "
        + "run the probe on the Node the tools already target (>=18)");
    process.exit(2);
}

function bytes(n) {
    if (n == null) return "-";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
    return (n / (1024 * 1024)).toFixed(2) + " MiB";
}

function pad(text, width) {
    text = String(text);
    while (text.length < width) text = text + " ";
    return text;
}

function padLeft(text, width) {
    text = String(text);
    while (text.length < width) text = " " + text;
    return text;
}

function ms(value) {
    return value == null ? "-" : value.toFixed(1) + " ms";
}

function stats(samples) {
    const sorted = samples.slice().sort(function (a, b) { return a - b; });
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
    return { median: median, min: sorted[0], max: sorted[sorted.length - 1] };
}

// One measured stage per entry. `sync` is what the operator feels: a sync stage
// cannot repaint the spinner, an async one can. `onPath` marks the stages the
// SHARE itself runs — an import-only stage (unpack) is measured for context and
// must stay out of the share summary.
function makeRecorder() {
    const rows = [];
    return {
        rows: rows,
        sync: function (name, fn, repeat, note, onPath) {
            const samples = [];
            let out = null;
            for (let i = 0; i < repeat; i++) {
                const t0 = performance.now();
                out = fn();
                samples.push(performance.now() - t0);
            }
            rows.push(Object.assign({ name: name, blocking: true, note: note || "",
                onPath: onPath !== false },
                stats(samples), { size: sizeOf(out) }));
            return out;
        },
        async: async function (name, fn, repeat, note, onPath) {
            const samples = [];
            let out = null;
            for (let i = 0; i < repeat; i++) {
                const t0 = performance.now();
                out = await fn();
                samples.push(performance.now() - t0);
            }
            rows.push(Object.assign({ name: name, blocking: false, note: note || "",
                onPath: onPath !== false },
                stats(samples), { size: sizeOf(out) }));
            return out;
        },
        context: function (name, value, note) {
            rows.push({ name: name, blocking: null, median: null, min: null, max: null,
                size: sizeOf(value), note: note || "" });
        }
    };
}

function sizeOf(value) {
    if (value == null) return null;
    if (typeof value === "string") return value.length;
    if (value && typeof value.length === "number") return value.length;
    if (value && typeof value.byteLength === "number") return value.byteLength;
    return null;
}

// Mirror of gzipCompress() in src/snapshots.js — the browser's own compressor.
// Kept as a local copy on purpose: snapshots.js is not loadable outside a page
// (IndexedDB, DOM), and the two lines are the contract being measured.
async function gzipCompress(bytesIn) {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(bytesIn);
    writer.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

// Mirror of createShareableState() + buildShareArtifact(), stage by stage.
// `container` is the .state container exactly as the browser would hand it to
// buildShareArtifact(); `label` only names the table.
async function runPipeline(container, label, repeat, log) {
    const rec = makeRecorder();
    rec.context("envelope text", label, "source file");
    rec.context("container", container, "what the share builds from");

    // The share itself starts from the DECODED snapshot in IndexedDB, so unpack
    // is the import path, not a share stage: measured, kept out of the summary.
    const unpacked = rec.sync("unpack container", function () {
        return StateFormat.unpack(container);
    }, repeat, "StateFormat.unpack (restore path)", false);

    if (!unpacked) {
        throw new Error(label + ": the bytes are not a .state container");
    }
    rec.context("memory words", unpacked.memoryWords,
        (unpacked.memoryWords ? (unpacked.memoryWords.length * 2) / (1024 * 1024) : 0).toFixed(2) + " MiB");

    // The stored snapshot keeps memory COMPRESSED (compressBytes -> zstd when
    // fzstd is bundled), so the share path pays decompressMemoryToWords()
    // before it can pack anything. Measure it with the real RAM: compress once
    // with the native encoder, then time the JS decoder the browser uses.
    let memoryBlob = null;
    if (unpacked.blobCatalog) {
        for (let i = 0; i < unpacked.blobCatalog.length; i++) {
            if (unpacked.blobCatalog[i].id === "memory") {
                memoryBlob = unpacked.blobs.memory;
                break;
            }
        }
    }
    if (memoryBlob && memoryBlob.length) {
        const zstdMemory = StateIO.zstdEncode(Buffer.from(memoryBlob.buffer,
            memoryBlob.byteOffset, memoryBlob.byteLength));
        rec.sync("memory decompress", function () {
            return Uint8Array.from(fzstd.decompress(new Uint8Array(zstdMemory)));
        }, repeat, "fzstd.decompress, sync in the browser too");
    }

    // Resources travel through pack() again: the share path re-packs from the
    // decoded snapshot, it never re-uses the stored container.
    const extraBlobs = [];
    if (unpacked.blobCatalog) {
        for (let i = 0; i < unpacked.blobCatalog.length; i++) {
            const item = unpacked.blobCatalog[i];
            if (item.id === "memory" || item.id === "disk-overlay") continue;
            extraBlobs.push({ id: item.id, mediaType: item.mediaType, bytes: unpacked.blobs[item.id] });
        }
    }
    rec.context("resource blobs", extraBlobs, extraBlobs.length + " blob(s) re-packed");

    // collectEmbeddedResources() hands pack() a COPY of every mounted image
    // (`new Uint8Array(bytes)`), which for a self-contained BSD share is the
    // whole 150+ MiB of disks. Same copy, same cost, measured here.
    if (extraBlobs.length) {
        let total = 0;
        rec.sync("resource copy", function () {
            const copies = new Array(extraBlobs.length);
            total = 0;
            for (let i = 0; i < extraBlobs.length; i++) {
                copies[i] = new Uint8Array(extraBlobs[i].bytes);
                total += copies[i].length;
            }
            return total;
        }, repeat, "collectEmbeddedResources copies every image");
    }

    // pack() hashes EVERY blob it stores (blobHash -> ImageFingerprint.ofBytes,
    // a pure-JS SHA-256 so it works on file:// and in WebViews without
    // crypto.subtle). For a self-contained share that is the whole 150+ MiB of
    // disks hashed again, even though the snapshot already knew their
    // fingerprints when the images were mounted. Measured separately so the
    // pack number can be read as "hashing + copying".
    if (extraBlobs.length) {
        const { ImageFingerprint } = require(path.join(ROOT, "src", "imagefingerprint.js"));
        rec.sync("blob hash", function () {
            for (let i = 0; i < extraBlobs.length; i++) {
                ImageFingerprint.ofBytes(extraBlobs[i].bytes);
            }
            return null;
        }, repeat, "pure-JS SHA-256, inside pack()");
    }

    const packed = rec.sync("pack container", function () {
        return StateFormat.pack(unpacked.manifest, unpacked.memoryWords, extraBlobs);
    }, repeat, "StateFormat.pack, hashes every blob");

    // What the share actually does since the digests are reused: pack() is told
    // the SHA-256 imageFingerprints already recorded, so the disk images are not
    // hashed a second time.
    const knownDigests = StateFormat.knownBlobDigests(
        unpacked.manifest.imageFingerprints, unpacked.manifest.embeddedImages);
    if (Object.keys(knownDigests).length) {
        rec.sync("pack (known digests)", function () {
            return StateFormat.pack(unpacked.manifest, unpacked.memoryWords, extraBlobs,
                { digests: knownDigests });
        }, repeat, Object.keys(knownDigests).length + " digest(s) reused from the snapshot");
    }

    const gzipped = await rec.async("gzip", function () {
        return gzipCompress(packed);
    }, repeat, "CompressionStream, async");

    // The suspected worst stage: base64 of the whole container plus a 76-column
    // wrap, all in one tick (src/state-envelope.js).
    const envelopeText = rec.sync("envelope encode", function () {
        return StateEnvelope.encode(gzipped);
    }, repeat, "base64 + wrap, all in one tick");

    const utf8 = rec.sync("utf8 encode", function () {
        return new TextEncoder().encode(envelopeText);
    }, repeat, "TextEncoder over the envelope");

    if (typeof File === "function") {
        rec.sync("File()", function () {
            return new File([utf8], "state.state.txt", { type: "text/plain" });
        }, repeat, "new File for the share sheet");
    } else {
        rec.context("File()", null, "no File in this Node");
    }

    return { label: label, rows: rec.rows };
}

// ---- report --------------------------------------------------------------

function printTable(result) {
    const rows = result.rows;
    const header = pad("stage", 20) + pad("blocking", 10) + padLeft("median", 11)
        + padLeft("min", 11) + padLeft("max", 11) + "  " + pad("payload", 12) + "note";
    console.log("\n=== " + result.label + " ===");
    console.log(header);
    console.log("-".repeat(header.length));
    rows.forEach(function (row) {
        const blocking = row.blocking === null ? "-" : (row.blocking ? "yes" : "no");
        const note = row.onPath === false ? row.note + "  [import path, not in summary]" : row.note;
        console.log(
            pad(row.name, 20) +
            pad(blocking, 10) +
            padLeft(ms(row.median), 11) +
            padLeft(ms(row.min), 11) +
            padLeft(ms(row.max), 11) + "  " +
            pad(bytes(row.size), 12) +
            note);
    });
}

function printSummary(result, repeat) {
    const rows = result.rows.filter(function (r) { return r.onPath !== false; });
    const syncRows = rows.filter(function (r) { return r.blocking === true; });
    const asyncRows = rows.filter(function (r) { return r.blocking === false; });
    const sum = function (list) {
        return list.reduce(function (acc, r) { return acc + (r.median || 0); }, 0);
    };
    const syncTotal = sum(syncRows);
    const asyncTotal = sum(asyncRows);
    const measured = syncTotal + asyncTotal;
    const envelopeRow = rows.find(function (r) { return r.name === "envelope encode"; });
    const envelopeMs = envelopeRow ? envelopeRow.median : 0;
    const packRow = rows.find(function (r) { return r.name === "pack container"; });
    const digestRow = rows.find(function (r) { return r.name === "pack (known digests)"; });

    console.log("\n--- summary for " + result.label + " (median of " + repeat + ") ---");
    console.log("  blocking (sync) stages : " + ms(syncTotal)
        + (measured ? "  (" + Math.round((syncTotal / measured) * 100) + "% of the measured path)" : ""));
    console.log("  async stages           : " + ms(asyncTotal));
    console.log("  measured total         : " + ms(measured));
    console.log("  a CSS spinner can repaint during the async stages only,"
        + " so the operator sees it freeze for the sync total");
    if (packRow && digestRow) {
        const saved = packRow.median - digestRow.median;
        console.log("  reusing the recorded digests saves " + ms(saved)
            + " of the pack stage (" + Math.round((saved / packRow.median) * 100) + "%)");
    }
    if (envelopeMs > 0) {
        // What a chunked envelope encoder would cost per stall, if the base64
        // stage were split into N slices with a paint between them.
        [64, 16, 8].forEach(function (chunks) {
            console.log("  envelope split into " + padLeft(String(chunks), 2) + " chunks -> max stall "
                + ms(envelopeMs / chunks) + " per chunk");
        });
    }
}

// ---- main ----------------------------------------------------------------

(async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const results = [];

    const envelopePath = path.resolve(ROOT, opts.envelope);
    if (!fs.existsSync(envelopePath)) {
        console.error("missing " + opts.envelope
            + " — export a self-contained state first (Share -> Save as text file)");
        process.exit(2);
    }

    const t0 = performance.now();
    const text = fs.readFileSync(envelopePath, "utf8");
    const readMs = performance.now() - t0;

    if (!StateEnvelope.isEnvelope(text)) {
        console.error(opts.envelope + " is not a yaPDP text envelope");
        process.exit(2);
    }

    const pre = makeRecorder();
    pre.context("read file", text, "fs, " + ms(readMs));
    // The envelope carries the COMPRESSED state — exactly what
    // gzipCompress() returned in createShareableState() — so the container the
    // share path packs from has to be unwrapped out of its frame first.
    const framed = pre.sync("envelope decode", function () {
        return StateEnvelope.decode(text);
    }, opts.repeat, "import path, not part of Share");
    if (!framed) {
        console.error(opts.envelope + ": the envelope body does not decode");
        process.exit(2);
    }
    const frame = StateFrame.detect(framed) || "none";
    const container = pre.sync("frame unwrap", function () {
        return StateFrame.unwrap(framed, StateIO.codecs);
    }, opts.repeat, "frame: " + frame + ", import path");
    pre.context("frame", frame, "what gzipCompress() wrote");
    const head = {
        label: opts.envelope + " (self-contained share)",
        rows: pre.rows.concat([
            { name: "file read", blocking: null, median: readMs, min: readMs, max: readMs,
                size: text.length, note: "fs.readFileSync, outside the browser" }
        ])
    };
    results.push(head);

    results.push(await runPipeline(container, "-> share artifact: " + opts.envelope, opts.repeat));

    const smallPath = path.resolve(ROOT, opts.small);
    if (fs.existsSync(smallPath)) {
        const small = StateIO.readBytes(smallPath);
        results.push(await runPipeline(small.container,
            "-> share artifact: " + opts.small + " (" + small.frame + ")", opts.repeat));
    }

    if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
    }

    results.forEach(function (result) {
        printTable(result);
        printSummary(result, opts.repeat);
    });

    console.log("\nnote: browser-only stages are not in these numbers —"
        + " the IndexedDB read (dbGet), a fetch of a not-yet-loaded image in"
        + " collectEmbeddedResources(), and html2canvas for a screenshot.");
})();
