#!/usr/bin/env node
/**
 * tools/states-annotate.js tests.
 *
 * The tool rewrites ONLY the human metadata inside a state: label, description
 * (the manifest's stepsMessage slot) and the preview. Everything else — RAM,
 * CPU registers, devices, the disk overlay — must come out of the repack
 * byte-for-byte, because a state that loses a register while gaining a
 * description is a broken machine with a nice caption.
 *
 * The contract that matters operationally is idempotency: the tool sits at the
 * end of the export pipeline, so a re-export that wiped the metadata gets it
 * back, and a second run must not touch the file again.
 *
 * Run with:  node tests/state-annotations.test.js
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const STATES = path.join(ROOT, "states");
const annotate = require(path.join(ROOT, "tools", "states-annotate.js"));
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
const StateIO = require(path.join(ROOT, "tools", "state-io.js"));

function readManifest(file) {
    return StateFormat.unpack(StateIO.readBytes(file).container);
}

async function tinyPng(file) {
    const px = Buffer.alloc(40 * 20 * 3, 0x40);
    await sharp(px, { raw: { width: 40, height: 20, channels: 3 } })
        .png().toFile(file);
}

async function run() {
    // ---- 1. the table only names states that exist ------------------------
    const annotations = annotate.loadAnnotations();
    const names = Object.keys(annotations);
    assert.ok(names.length > 0, "tools/state-annotations.json lists states");
    const present = new Set(fs.readdirSync(STATES).filter((f) => /\.state\.zst$/.test(f)));
    names.forEach((n) => {
        assert.ok(present.has(n), n + " is listed but missing from states/ " +
            "(the annotator would warn about an orphan entry)");
    });
    names.forEach((n) => {
        const a = annotations[n];
        // A short name is legitimate ("Unix V5"); a name that IS the device key
        // is the bug this whole table exists to fix.
        assert.ok(a.label && a.label.length >= 4 &&
            a.label.toLowerCase() !== n.replace(/-ready\.state\.zst$/, "").toLowerCase(),
            n + ": a label is what the restore toast shows — give it a real one");
        assert.ok(a.description && a.description.length > 20,
            n + ": a one-line description is the point of this table");
    });
    console.log("PASS 1: annotation table: " + names.length + " states, all present");

    // ---- 2. planAnnotation is pure and maps fields correctly --------------
    const parsed = {
        manifest: { device: "rp1", label: "rp1", stepsMessage: null },
    };
    const empty = annotate.planAnnotation(parsed, {}, null);
    assert.deepStrictEqual(empty.changes, [], "nothing to do with an empty annotation");
    assert.strictEqual(empty.manifest.label, "rp1", "manifest untouched");

    const planned = annotate.planAnnotation(parsed, {
        label: "BSD 2.11", description: "says something",
    }, "data:image/png;base64,AAAA");
    const fields = planned.changes.map((c) => c[0]);
    assert.deepStrictEqual(fields, ["label", "description", "screenshot"],
        "all three fields planned: " + JSON.stringify(fields));
    assert.strictEqual(planned.manifest.label, "BSD 2.11");
    assert.strictEqual(planned.manifest.stepsMessage, "says something",
        "the description goes into the slot the generator and the toast read");
    assert.strictEqual(planned.manifest.screenshot, "data:image/png;base64,AAAA");
    assert.strictEqual(parsed.manifest.label, "rp1", "the input is not mutated");
    console.log("PASS 2: planAnnotation maps label/description/screenshot");

    // ---- 3. apply to a COPY: metadata changes, the machine does not -------
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-annotate-"));
    try {
        const srcFile = path.join(STATES, "rp1-ready.state.zst");
        assert.ok(fs.existsSync(srcFile), "a state to copy");
        const copy = path.join(tmp, "rp1-ready.state.zst");
        fs.copyFileSync(srcFile, copy);
        const shot = path.join(tmp, "shot.png");
        await tinyPng(shot);

        const before = readManifest(copy);
        const ann = {
            label: "BSD 2.11",
            description: "Berkeley Software Distribution 2.11, multiuser.",
            screenshot: shot,
        };

        const dry = await annotate.annotateFile("rp1-ready.state.zst", ann,
            { dir: tmp, write: false });
        assert.strictEqual(dry.status, "would-change", "dry run reports, writes nothing");
        assert.deepStrictEqual(readManifest(copy).manifest.label, before.manifest.label,
            "dry run really did not write");

        const written = await annotate.annotateFile("rp1-ready.state.zst", ann,
            { dir: tmp, write: true });
        assert.strictEqual(written.status, "written", "write applies: " + written.status);

        const after = readManifest(copy);
        assert.strictEqual(after.manifest.label, "BSD 2.11", "label applied");
        assert.strictEqual(after.manifest.stepsMessage, ann.description,
            "description applied");
        assert.ok(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(after.manifest.screenshot),
            "preview is a PNG data URI the manifest generator decodes");
        assert.strictEqual(after.manifest.device, before.manifest.device, "device kept");
        assert.deepStrictEqual(after.manifest.cpu, before.manifest.cpu, "CPU kept");
        assert.deepStrictEqual(after.manifest.devices, before.manifest.devices,
            "devices kept");
        assert.strictEqual(after.memoryWords.length, before.memoryWords.length,
            "RAM length kept");
        for (let i = 0; i < after.memoryWords.length; i += 4096) {
            assert.strictEqual(after.memoryWords[i], before.memoryWords[i],
                "RAM word " + i + " kept");
        }
        console.log("PASS 3: apply sets metadata and preserves the machine");

        // ---- 4. idempotent: a second write is a no-op --------------------
        const again = await annotate.annotateFile("rp1-ready.state.zst", ann,
            { dir: tmp, write: true });
        assert.strictEqual(again.status, "unchanged",
            "second run must not rewrite the file: " + again.status);
        console.log("PASS 4: annotateFile is idempotent");

        // ---- 5. a missing source image is reported, not swallowed -------
        const bad = await annotate.annotateFile("rp1-ready.state.zst",
            { screenshot: path.join(tmp, "nope.png") }, { dir: tmp, write: true });
        assert.strictEqual(bad.status, "bad-screenshot",
            "a missing preview source fails loudly: " + bad.status);
        assert.ok(bad.detail && bad.detail.length > 0, "with a reason: " + bad.detail);
        console.log("PASS 5: a missing preview source is reported");

        // ---- 6. a missing state is reported, not created ----------------
        const gone = await annotate.annotateFile("nope.state.zst", ann,
            { dir: tmp, write: true });
        assert.strictEqual(gone.status, "missing", "absent state: " + gone.status);
        console.log("PASS 6: an absent state is reported");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    // ---- 7. embedded blobs survive a repack ------------------------------
    const blobs = annotate.extraBlobsOf({
        blobCatalog: [
            { id: "memory", mediaType: "application/vnd.yapdp.ram" },
            { id: "disk-overlay", mediaType: "application/vnd.yapdp.disk-overlay" },
            { id: "rk1.dsk", mediaType: "application/octet-stream" },
        ],
        blobs: {
            memory: new Uint8Array([1]),
            "disk-overlay": new Uint8Array([2]),
            "rk1.dsk": new Uint8Array([3]),
        },
    });
    assert.deepStrictEqual(blobs.map((b) => b.id), ["rk1.dsk"],
        "RAM and overlay are re-created by the packer; embedded images pass through");
    console.log("PASS 7: extraBlobsOf keeps only the non-reserved blobs");
}

run().then(function () {
    console.log("\nstate-annotations tests passed");
}).catch(function (e) {
    console.error("\nstate-annotations tests FAILED: " +
        (e && e.message ? e.message : e));
    if (e && e.stack) console.error(e.stack.split("\n").slice(1, 5).join("\n"));
    process.exit(1);
});
