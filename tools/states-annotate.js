#!/usr/bin/env node
/**
 * states-annotate.js — give a pre-built machine state its own voice.
 *
 * A state in states/ is offered to the visitor by name, with a one-line
 * description and a thumbnail. Those three things are NOT in states/ — they are
 * read out of the state's own manifest, both by the generator
 * (tools/gen-state-manifest.js -> states/manifest.json) and by the wizard's
 * restore toast, which shows them straight from the container. A state restored
 * from somebody else's ?state=<url> has no manifest.json entry at all, so the
 * only place a description can live and still arrive is inside the file.
 *
 * The states in the repo were captured through the Share dialog, which writes
 * `label` = the name the operator typed ("rp1") and no description, no
 * screenshot. The result was a Scenario card reading "RP1 (ready)" with nothing
 * else, and a toast with a lone lowercase "rp1" in it.
 *
 * This tool applies the human metadata listed in tools/state-annotations.json
 * (keyed by state FILE name — "rk1" is a device key three times over) to an
 * existing state, without touching the machine: memory words, CPU registers and
 * devices are carried through byte for byte by the same packer the browser and
 * the exporters use.
 *
 * Usage:
 *   node tools/states-annotate.js                 dry run: report what would change
 *   node tools/states-annotate.js --write         apply, atomically per file
 *   node tools/states-annotate.js --write rp1-ready.state.zst   one file only
 *
 * Idempotent: a second --write is a byte-for-byte no-op, so the tool can sit at
 * the end of the state-export pipeline (docs/CONTRIBUTING.md) and re-apply the
 * description after a re-export has wiped it.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STATES = path.join(ROOT, "states");
const ANNOTATIONS_FILE = path.join(__dirname, "state-annotations.json");

const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
const StateIO = require("./state-io.js");
const preview = require("./preview-capture.js");

const RESERVED_BLOBS = ["memory", "disk-overlay"];

// ---------------------------------------------------------------------------
// Annotation table
// ---------------------------------------------------------------------------

function loadAnnotations() {
    try {
        const raw = fs.readFileSync(ANNOTATIONS_FILE, "utf8");
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) {
        return {};
    }
}

// `file` is the state FILE name ("rp1-ready.state.zst"), not a device key.
function annotationFor(annotations, file) {
    const all = annotations || loadAnnotations();
    return all[file] || {};
}

// A source image on disk -> the exact data URI the manifest generator decodes
// (its regex accepts nothing else). Resized here, so what lands in the state is
// already the preview we would show — no second copy of a 1920x1080 shot.
// The size policy is the capture side's (tools/preview-capture.js): retry at
// half the width, then refuse rather than embed a full-page frame.
async function screenshotDataUri(sourcePath) {
    const abs = path.isAbsolute(sourcePath) ? sourcePath : path.join(ROOT, sourcePath);
    const raw = fs.readFileSync(abs);
    let png = await preview.encodePreview(raw);
    if (png.length > preview.MAX_PREVIEW_BYTES) {
        png = await preview.encodePreview(raw, preview.MAX_PREVIEW_WIDTH / 2);
    }
    if (png.length > preview.MAX_PREVIEW_BYTES) {
        throw new Error(abs + ": " + png.length + " bytes even at half width, " +
            "limit is " + preview.MAX_PREVIEW_BYTES);
    }
    return preview.toDataUri(png);
}

// ---------------------------------------------------------------------------
// Applying one annotation
// ---------------------------------------------------------------------------

// Blobs other than RAM/overlay (embedded images of a self-contained state) must
// survive the re-pack: pack() re-creates only the two reserved ones.
function extraBlobsOf(parsed) {
    const catalog = parsed.blobCatalog || [];
    const bytesById = parsed.blobs || {};
    const out = [];
    catalog.forEach(function (item) {
        if (!item || RESERVED_BLOBS.indexOf(item.id) !== -1) return;
        const bytes = bytesById[item.id];
        if (!bytes) return;
        out.push({ id: item.id, mediaType: item.mediaType, bytes: bytes });
    });
    return out;
}

function describeValue(value, limit) {
    if (value === null || value === undefined || value === "") return "(none)";
    const s = String(value);
    const cut = limit || 60;
    const shown = s.length > cut ? s.slice(0, cut - 1) + "\u2026" : s;
    return JSON.stringify(shown);
}

// parsed state + annotation -> { manifest, changes[] }. Pure: no I/O beyond the
// screenshot conversion, which the caller triggers by passing `shotUri`.
function planAnnotation(parsed, ann, shotUri) {
    const next = Object.assign({}, parsed.manifest);
    const changes = [];
    if (ann.label && next.label !== ann.label) {
        changes.push(["label", next.label, ann.label]);
        next.label = ann.label;
    }
    if (ann.description && next.stepsMessage !== ann.description) {
        changes.push(["description", next.stepsMessage, ann.description]);
        next.stepsMessage = ann.description;
    }
    if (shotUri && next.screenshot !== shotUri) {
        changes.push(["screenshot", next.screenshot ? "data URI" : null, "data URI"]);
        next.screenshot = shotUri;
    }
    return { manifest: next, changes: changes };
}

async function annotateFile(fileName, ann, opts) {
    const o = opts || {};
    const abs = path.join(o.dir || STATES, fileName);
    if (!fs.existsSync(abs)) {
        return { file: fileName, status: "missing" };
    }
    const read = StateIO.readBytes(abs);
    const parsed = StateFormat.unpack(read.container);
    if (!parsed) return { file: fileName, status: "unreadable" };

    let shotUri = null;
    if (ann.screenshot) {
        try {
            shotUri = await screenshotDataUri(ann.screenshot);
        } catch (e) {
            return { file: fileName, status: "bad-screenshot",
                     detail: e && e.message ? e.message : String(e) };
        }
    }

    const planned = planAnnotation(parsed, ann, shotUri);
    if (!planned.changes.length) {
        return { file: fileName, status: "unchanged", changes: [] };
    }
    if (!o.write) {
        return { file: fileName, status: "would-change", changes: planned.changes };
    }

    const tmp = abs + ".tmp";
    const container = StateFormat.pack(planned.manifest, parsed.memoryWords,
        extraBlobsOf(parsed));
    const frame = StateIO.writeBytes(tmp, container);
    fs.renameSync(tmp, abs);
    return { file: fileName, status: "written", frame: frame,
             changes: planned.changes };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function reportChange(file, name, from, to) {
    console.log("    " + name + ": " + describeValue(from, 48) +
        " -> " + describeValue(to, 48));
}

// States still without a voice, and the command that gives them one. Printed
// after every run so a re-export that wiped the metadata cannot go unnoticed.
function reportMute(dir) {
    const d = dir || STATES;
    const mute = [];
    fs.readdirSync(d).filter(function (f) {
        return /\.state\.zst$/.test(f) && !f.startsWith(".");
    }).sort().forEach(function (f) {
        let manifest = null;
        try {
            manifest = StateFormat.unpack(StateIO.readBytes(path.join(d, f)).container).manifest;
        } catch (e) { return; }
        if (!manifest) return;
        if (!manifest.label || manifest.label === manifest.device) mute.push(f);
    });
    if (!mute.length) {
        console.log("every state names itself (label != device)");
        return;
    }
    console.log("states without a name (re-export or annotate them): " + mute.join(", "));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
    const args = argv || process.argv.slice(2);
    const write = args.indexOf("--write") !== -1;
    const only = args.filter(function (a) { return !a.startsWith("--"); });
    const annotations = loadAnnotations();
    const names = only.length ? only : Object.keys(annotations).sort();

    if (!names.length) {
        console.log("tools/state-annotations.json lists no states — nothing to do");
        return 0;
    }
    console.log((write ? "annotating" : "dry run (pass --write to apply)") +
        ": " + names.length + " state(s)");

    let changed = 0;
    let failures = 0;
    for (const name of names) {
        const ann = annotationFor(annotations, name);
        if (!Object.keys(ann).length) {
            console.log("  " + name + ": not in tools/state-annotations.json — skipped");
            continue;
        }
        const res = await annotateFile(name, ann, { write: write });
        if (res.status === "written" || res.status === "would-change") {
            changed++;
            console.log("  " + name + ": " + res.status +
                (res.frame ? " (" + res.frame + ")" : ""));
            res.changes.forEach(function (c) { reportChange(name, c[0], c[1], c[2]); });
        } else if (res.status === "unchanged") {
            console.log("  " + name + ": unchanged");
        } else {
            failures++;
            console.log("  " + name + ": " + res.status +
                (res.detail ? " — " + res.detail : ""));
        }
    }

    // Orphans: a table entry whose file is gone is a lie about the collection.
    const present = new Set(fs.readdirSync(STATES).filter(function (f) {
        return /\.state\.zst$/.test(f);
    }));
    Object.keys(annotations).forEach(function (f) {
        if (!present.has(f)) {
            console.log("  WARN " + f + " is listed but not present in states/");
        }
    });

    console.log("");
    reportMute();
    console.log(changed + " to write, " + failures + " failed" +
        (write ? "" : " (dry run: nothing written)"));
    return failures ? 1 : 0;
}

if (require.main === module) {
    main().then(function (code) {
        process.exit(code || 0);
    }).catch(function (e) {
        console.error("states-annotate error: " + (e && e.stack ? e.stack : e));
        process.exit(1);
    });
}

module.exports = {
    loadAnnotations: loadAnnotations,
    annotationFor: annotationFor,
    screenshotDataUri: screenshotDataUri,
    planAnnotation: planAnnotation,
    annotateFile: annotateFile,
    extraBlobsOf: extraBlobsOf,
    ANNOTATIONS_FILE: ANNOTATIONS_FILE,
    STATES: STATES,
};
