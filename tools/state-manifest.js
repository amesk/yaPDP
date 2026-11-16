#!/usr/bin/env node
/**
 * state-manifest.js — extract or replace the manifest inside a .state.zst file.
 *
 * Usage:
 *   node tools/state-manifest.js extract <input.state.zst> [output.json]
 *   node tools/state-manifest.js replace <input.state.zst> <manifest.json> <output.state.zst>
 *   node tools/state-manifest.js edit <input.state.zst> [--out <file>] [--in-place]
 *        [--set <path> <value>]... [--replace <path> <old> <new>]...
 *
 * extract:
 *   Read a .state.zst, decompress it, unpack the container, write the manifest
 *   as a pretty-printed JSON file. The original state is not modified.
 *
 * replace:
 *   Read a .state.zst, decompress it, unpack the container, read the new
 *   manifest JSON, validate it, re-pack with the original memory words, and
 *   write a new .state.zst. The original state is not modified.
 *
 * edit:
 *   Change individual manifest fields WITHOUT re-packing the container: the
 *   manifest JSON is rewritten and the blob region is copied verbatim, so RAM,
 *   the disk overlay and every embedded image keep their exact bytes and their
 *   offsets. `replace` carries the extra blobs through now, but it still
 *   decodes and re-encodes RAM and the overlay and re-hashes every blob;
 *   `edit` touches neither, which is all a label or a step change needs.
 *
 *   --set <path> <value>       set a field. The value is JSON when it parses
 *                              (numbers, booleans, null, quoted strings), and a
 *                              plain string otherwise, so a command line needs
 *                              no extra quoting for ordinary text.
 *   --replace <path> <a> <b>   replace every occurrence of <a> with <b> inside
 *                              the string at <path> (help text, steps, labels).
 *   --out <file>               write elsewhere; the default is
 *                              <input>.edited.state.zst.
 *   --in-place                 replace the input atomically (temp + rename).
 *
 *   Paths are object keys and array indexes: `label`, `steps[0].send`,
 *   `vt52[1].state.hardcopy`.
 *
 * The FRAME around the container is whatever the writer had: zstd (the Node
 * tools and the repo's own states/), gzip (the browser — the page has no zstd
 * compressor, only CompressionStream), or no frame at all on a Node without
 * zstd. src/snapshots.js reads all three, so the frame is recognised here as
 * well and a state exported from the browser opens exactly like a locally made
 * one. `replace` frames its output too — zstd when this Node has an encoder,
 * gzip otherwise — so the file never grows back to its raw size.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
const StateIO = require("./state-io.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// The frame half belongs to src/state-frame.js (zstd from the tools, gzip from
// the browser's own export, none from a writer with no compressor) and the
// Node codecs to tools/state-io.js — shared with every other state tool.
function readState(file) {
    const parsed = StateFormat.unpack(StateIO.readBytes(file).container);
    if (!parsed) throw new Error("could not unpack the container");
    return parsed;
}

// pack() re-creates only the two RESERVED blobs; everything else (the disk
// images a SELF-CONTAINED state embeds) has to be handed back to it or it is
// gone. `replace` used to re-pack with the memory alone, which dropped the
// embedded disk while the manifest kept naming it in `embeddedImages` — the
// file then looked fine and refused to restore over a fingerprint mismatch
// ("the disk is not the disk loaded now"), because the page fell back to
// fetching the published image.
const RESERVED_BLOBS = ["memory", "disk-overlay"];

function extraBlobsOf(parsed) {
    const catalog = (parsed && parsed.blobCatalog) || [];
    const bytesById = (parsed && parsed.blobs) || {};
    const out = [];
    catalog.forEach(function (item) {
        if (!item || RESERVED_BLOBS.indexOf(item.id) !== -1) return;
        const bytes = bytesById[item.id];
        if (!bytes) return;
        out.push({ id: item.id, mediaType: item.mediaType, bytes: bytes });
    });
    return out;
}

// A manifest may only name an image the container really carries. An
// `embeddedImages` entry whose blob is absent is a state that cannot restore,
// so it is refused on the way OUT rather than written into somebody's file.
function missingEmbeddedBlobs(manifest, extras) {
    const refs = (manifest && manifest.embeddedImages) || null;
    if (!refs || typeof refs !== "object") return [];
    const have = Object.create(null);
    (extras || []).forEach(function (blob) {
        if (blob && blob.id) have[blob.id] = true;
    });
    return Object.keys(refs).filter(function (url) {
        return typeof refs[url] !== "string" || !have[refs[url]];
    });
}

// Returns the frame that was written, for the caller to report.
function writeState(manifest, memoryWords, outPath, extras) {
    return StateIO.writeBytes(outPath,
        StateFormat.pack(manifest, memoryWords, extras || []));
}

// ---------------------------------------------------------------------------
// Manifest paths and the byte-level rewrite used by `edit`
// ---------------------------------------------------------------------------
// "label", "steps[0].send", "vt52[1].state.hardcopy".
function parsePath(spec) {
    const tokens = [];
    const re = /([^.[\]]+)|\[(\d+)\]/g;
    let match;
    while ((match = re.exec(spec)) !== null) {
        tokens.push(match[1] !== undefined ? match[1] : Number(match[2]));
    }
    if (!tokens.length) throw new Error("empty manifest path");
    return tokens;
}

// "steps[9].send" — the path as the user wrote it, for error messages.
function pathLabel(tokens, count) {
    let out = "";
    for (let i = 0; i < count; i++) {
        const token = tokens[i];
        if (typeof token === "number") {
            out += "[" + token + "]";
        } else {
            out += (out ? "." : "") + token;
        }
    }
    return out || "(root)";
}

function parentOf(root, tokens) {
    let node = root;
    for (let i = 0; i < tokens.length - 1; i++) {
        if (node == null || typeof node !== "object") {
            throw new Error("no object at '" + pathLabel(tokens, i + 1) + "'");
        }
        node = node[tokens[i]];
    }
    if (node == null || typeof node !== "object") {
        throw new Error("no parent object at '" + pathLabel(tokens, tokens.length - 1) + "'");
    }
    return node;
}

function getAt(root, tokens) {
    let node = root;
    for (let i = 0; i < tokens.length; i++) {
        const key = tokens[i];
        if (node == null || typeof node !== "object" || !(key in node)) {
            throw new Error("no field at '" + pathLabel(tokens, i + 1) + "'");
        }
        node = node[key];
    }
    return node;
}

function setAt(root, tokens, value) {
    const parent = parentOf(root, tokens);
    const last = tokens[tokens.length - 1];
    if (Array.isArray(parent) &&
        (typeof last !== "number" || last < 0 || last >= parent.length)) {
        throw new Error("array index out of range: " + last);
    }
    parent[last] = value;
}

// JSON when it parses (numbers, booleans, null, quoted strings, objects), a
// plain string otherwise, so `--set steps[0].send "cat /etc/motd"` works.
function parseValue(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return text;
    }
}

// Magic + manifest length + manifest, then the ORIGINAL payload bytes. Every
// blob offset in the manifest is relative to that payload region, so copying it
// verbatim keeps RAM, the overlay and embedded images byte-identical.
function rebuildContainer(container, manifest) {
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const payload = container.subarray(12 + container.readUInt32LE(8));
    const out = Buffer.alloc(12 + manifestBytes.length + payload.length);
    container.copy(out, 0, 0, 8);
    out.writeUInt32LE(manifestBytes.length, 8);
    manifestBytes.copy(out, 12);
    payload.copy(out, 12 + manifestBytes.length);
    return out;
}

// The payload must survive the edit exactly: memory, the disk overlay and every
// blob are compared before anything is written. A manifest that changes them is
// a bug in the edit, not a state worth saving.
function verifyPayloadUnchanged(original, edited) {
    const memoryBefore = original.memoryWords || [];
    const memoryAfter = edited.memoryWords || [];
    if (memoryBefore.length !== memoryAfter.length) {
        throw new Error("memory size changed — refusing to write");
    }
    for (let i = 0; i < memoryBefore.length; i++) {
        if (memoryBefore[i] !== memoryAfter[i]) {
            throw new Error("memory changed — refusing to write");
        }
    }
    Object.keys(original.blobs || {}).forEach(function (id) {
        const before = Buffer.from(original.blobs[id]);
        const after = Buffer.from(edited.blobs[id] || []);
        if (!before.equals(after)) {
            throw new Error("blob changed: " + id + " — refusing to write");
        }
    });
    if (JSON.stringify(edited.manifest.overlay) !== JSON.stringify(original.manifest.overlay)) {
        throw new Error("disk overlay changed — refusing to write");
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function cmdExtract(inputPath, outputPath) {
    const parsed = readState(inputPath);
    const json = JSON.stringify(parsed.manifest, null, 2) + "\n";
    const out = outputPath || (path.basename(inputPath, ".state.zst") + ".manifest.json");
    fs.writeFileSync(out, json, "utf8");
    console.log("manifest extracted: " + path.relative(ROOT, out));
    console.log("  schemaVersion: " + (parsed.manifest.schemaVersion || "?"));
    console.log("  label: " + (parsed.manifest.label || "(none)"));
    console.log("  device: " + (parsed.manifest.device || "(none)"));
    console.log("  memoryWords: " + (parsed.memoryWords ? parsed.memoryWords.length + " words" : "none"));
    // Report an already-damaged file: the manifest names an embedded image the
    // container does not carry, so a restore will refuse it over its digest.
    const dangling = missingEmbeddedBlobs(parsed.manifest, extraBlobsOf(parsed));
    if (dangling.length) {
        console.warn("  warning: embedded image(s) missing from the container: " +
            dangling.join(", ") + " — this state cannot be restored");
    }
}

function cmdReplace(inputPath, manifestPath, outputPath) {
    const parsed = readState(inputPath);
    const manifestJson = fs.readFileSync(manifestPath, "utf8");
    let newManifest;
    try {
        newManifest = JSON.parse(manifestJson);
    } catch (e) {
        throw new Error("invalid manifest JSON: " + e.message);
    }
    if (!newManifest || typeof newManifest !== "object") {
        throw new Error("manifest must be a JSON object");
    }
    // schemaVersion is semver (a string) since 1.0.0; a legacy state may still
    // carry the bare number 1, so both shapes are accepted here.
    var sv = newManifest.schemaVersion;
    if (!sv || (typeof sv !== "number" && typeof sv !== "string")) {
        throw new Error("manifest must have a schemaVersion " +
            "(a semver string; the legacy numeric form is accepted)");
    }
    // Preserve the original memoryWords (they are not in the manifest) and the
    // embedded disk images (they are not in the manifest either — only the blob
    // ids are, on both sides of the reference).
    const extras = extraBlobsOf(parsed);
    const dangling = missingEmbeddedBlobs(newManifest, extras);
    if (dangling.length) {
        throw new Error("manifest references embedded image(s) this container " +
            "does not carry: " + dangling.join(", ") + " — nothing was written");
    }
    const frame = writeState(newManifest, parsed.memoryWords, outputPath, extras);
    console.log("manifest replaced: " + path.relative(ROOT, outputPath) +
        " (" + frame + ")");
    console.log("  schemaVersion: " + newManifest.schemaVersion);
    console.log("  label: " + (newManifest.label || "(none)"));
    console.log("  device: " + (newManifest.device || "(none)"));
    console.log("  steps: " + (newManifest.steps ? newManifest.steps.length + " step(s)" : "none"));
    console.log("  stepsMessage: " + (newManifest.stepsMessage ? JSON.stringify(newManifest.stepsMessage) : "none"));
    console.log("  embedded blobs: " +
        (extras.length ? extras.map((b) => b.id + " (" + b.bytes.length + " bytes)").join(", ") : "none"));
}

function defaultEditOut(inputPath) {
    return /\.state\.zst$/i.test(inputPath)
        ? inputPath.replace(/\.state\.zst$/i, ".edited.state.zst")
        : inputPath + ".edited.state.zst";
}

function cmdEdit(argv) {
    const ops = [];
    let inputPath = null;
    let outPath = null;
    let inPlace = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--set") {
            ops.push({ kind: "set", path: argv[++i], value: argv[++i] });
        } else if (arg === "--replace") {
            ops.push({ kind: "replace", path: argv[++i], from: argv[++i], to: argv[++i] });
        } else if (arg === "--out") {
            outPath = argv[++i];
        } else if (arg === "--in-place") {
            inPlace = true;
        } else if (arg.startsWith("--")) {
            throw new Error("unknown option: " + arg);
        } else if (!inputPath) {
            inputPath = arg;
        } else {
            throw new Error("unexpected argument: " + arg);
        }
    }
    if (!inputPath) usage();
    if (!ops.length) throw new Error("nothing to change: pass --set or --replace");
    if (outPath && inPlace) throw new Error("--out and --in-place are mutually exclusive");

    const container = Buffer.from(StateIO.readBytes(inputPath).container);
    if (!StateFormat.isContainer(container)) throw new Error("not a .state container");
    const original = StateFormat.unpack(container);
    if (!original) {
        throw new Error("the input does not unpack (blob digests do not match); " +
            "repair its digests before editing");
    }
    const manifest = JSON.parse(container.subarray(12, 12 + container.readUInt32LE(8))
        .toString("utf8"));
    const changes = [];

    for (const op of ops) {
        const tokens = parsePath(op.path);
        if (op.kind === "set") {
            let previous;
            try {
                previous = getAt(manifest, tokens);
            } catch (e) {
                previous = undefined;
            }
            setAt(manifest, tokens, parseValue(op.value));
            changes.push(op.path + ": " + JSON.stringify(previous) + " -> " +
                JSON.stringify(getAt(manifest, tokens)));
        } else {
            const current = getAt(manifest, tokens);
            if (typeof current !== "string") {
                throw new Error("'" + op.path + "' is not a string");
            }
            if (current.indexOf(op.from) === -1) {
                throw new Error("'" + op.path + "' does not contain " +
                    JSON.stringify(op.from));
            }
            setAt(manifest, tokens, current.split(op.from).join(op.to));
            changes.push(op.path + ": replaced " + JSON.stringify(op.from) + " -> " +
                JSON.stringify(op.to));
        }
    }

    const rebuilt = rebuildContainer(container, manifest);
    const edited = StateFormat.unpack(rebuilt);
    if (!edited) throw new Error("the edited container does not unpack");
    verifyPayloadUnchanged(original, edited);

    const target = inPlace ? inputPath : (outPath || defaultEditOut(inputPath));
    if (inPlace) {
        const tmp = inputPath + ".tmp";
        const frame = StateIO.writeBytes(tmp, rebuilt);
        fs.renameSync(tmp, inputPath);
        console.log("edited in place: " + path.relative(ROOT, inputPath) + " (" + frame + ")");
    } else {
        const frame = StateIO.writeBytes(target, rebuilt);
        console.log("edited: " + path.relative(ROOT, target) + " (" + frame + ")");
    }
    changes.forEach((line) => console.log("  " + line));
    console.log("validated: RAM, disk overlay and every blob are byte-identical");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function usage() {
    console.error("Usage:");
    console.error("  node tools/state-manifest.js extract <input.state.zst> [output.json]");
    console.error("  node tools/state-manifest.js replace <input.state.zst> <manifest.json> <output.state.zst>");
    console.error("  node tools/state-manifest.js edit <input.state.zst> [--out <file>] [--in-place]");
    console.error("       [--set <path> <value>]... [--replace <path> <old> <new>]...");
    console.error("  paths: label | steps[0].send | vt52[1].state.hardcopy");
    process.exit(2);
}

(function main() {
    const raw = process.argv.slice(2);
    const args = raw.filter((a) => !a.startsWith("--"));
    const cmd = args[0];
    if (cmd === "extract" && args.length >= 2) {
        cmdExtract(args[1], args[2]);
    } else if (cmd === "replace" && args.length >= 4) {
        cmdReplace(args[1], args[2], args[3]);
    } else if (cmd === "edit" && raw.length >= 2) {
        cmdEdit(raw.slice(1));
    } else {
        usage();
    }
})();