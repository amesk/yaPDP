/**
 * yaPDP — the .state container: machine-state serialisation, shared.
 *
 * One codebase serialises a machine state for every consumer:
 *
 *   - the browser (src/snapshots.js), which keeps states in IndexedDB;
 *   - the Node tools (tools/headless-*.js), which keep them as files.
 *
 * Before this module the format lived inside the browser store, so a Node
 * implementation could only have been a second copy of it — and two copies of
 * a format drift. Everything here is PLATFORM-FREE: no IndexedDB, no
 * CompressionStream, no fs, no DOM. Callers compress the bytes and decide
 * where they live; this module only says what the bytes ARE.
 *
 * ## The container
 *
 * A `.state` file is one zstd frame containing a small binary container:
 *
 *   [8 bytes]  magic "YAPDPSTA"
 *   [4 bytes]  manifest length, little-endian
 *   [manifest] UTF-8 JSON — version, layers, config, CPU, devices, layouts
 *   [memory]   raw bytes, little-endian words, exactly CPU.memory's size
 *
 * Memory is the bulk of a state and is stored as RAW BYTES. It used to be
 * `Array.from(Uint16Array)` inside JSON — millions of decimal digits for a
 * 4 MB machine, built as a JS array before compression even started. Raw
 * bytes are what the images already use, and they compress better because the
 * zero pages stay zeros instead of "0,0,0,0".
 *
 * The manifest stays JSON: it is small (registers, device registers, config,
 * image fingerprints), it is read and diffed by humans occasionally, and it
 * changes shape as devices are added — exactly what JSON is good at.
 *
 * ## Layers
 *
 * `base` names the parent state this one was taken from, or null for a state
 * that rests directly on the disk image. Nothing in this module walks the
 * chain yet: the field is written so that thin deltas can be added without a
 * format change (the same `.state` file, a different `base`).
 *
 * Public surface: window.__yapdpStateFormat (browser) and
 * module.exports { StateFormat } (Node tools and tests). Pure.
 */
"use strict";

var StateFormat = (function () {
    "use strict";

    // Container format version — NOT the snapshot's own schemaVersion, which
    // describes the fields inside the manifest. This one describes how the
    // bytes are laid out, so a future container layout can be told apart.
    var CONTAINER_VERSION = 1;

    var MAGIC = [0x59, 0x41, 0x50, 0x44, 0x50, 0x53, 0x54, 0x41]; // "YAPDPSTA"
    var MAGIC_LEN = MAGIC.length;
    var HEADER_LEN = MAGIC_LEN + 4; // magic + manifest length

    function utf8Encode(str) {
        if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
        // Node < 11 and very old browsers: latin1 is enough for the manifest,
        // whose field names and values are ASCII except for a stored name.
        var out = new Uint8Array(str.length);
        for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
        return out;
    }

    function utf8Decode(bytes) {
        if (typeof TextDecoder !== "undefined") {
            return new TextDecoder("utf-8").decode(bytes);
        }
        var s = "";
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return s;
    }

    // --- CPU <-> plain object -------------------------------------------
    // Numbers, strings and booleans go as-is; the typed arrays the CPU keeps
    // (MMU page tables, the unibus map) become { t, d }. CPU.memory is NOT
    // handled here: it travels as raw bytes, see pack()/unpack().
    function captureCPU(cpu) {
        var out = {};
        Object.keys(cpu).forEach(function (k) {
            if (k === "memory") return; // stored separately, as raw bytes
            var v = cpu[k];
            if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
                out[k] = v;
            } else if (v instanceof Uint16Array) {
                out[k] = { t: "u16", d: Array.from(v) };
            } else if (v instanceof Uint32Array) {
                out[k] = { t: "u32", d: Array.from(v) };
            }
            // functions and other objects are runtime-only, not persisted
        });
        return out;
    }

    // Apply a captured CPU object onto a live CPU. `skipRunState` leaves the
    // run state to the caller, which has to restore memory first (a machine
    // that RUNs with its old memory traps instantly).
    function restoreCPU(cpu, saved, skipRunState) {
        Object.keys(saved || {}).forEach(function (k) {
            if (skipRunState && k === "runState") return;
            var v = saved[k];
            if (v && typeof v === "object" && v.t === "u16") {
                var a16 = new Uint16Array(v.d);
                if (cpu[k] instanceof Uint16Array && cpu[k].length === a16.length) {
                    cpu[k].set(a16);
                } else {
                    cpu[k] = a16;
                }
            } else if (v && typeof v === "object" && v.t === "u32") {
                var a32 = new Uint32Array(v.d);
                if (cpu[k] instanceof Uint32Array && cpu[k].length === a32.length) {
                    cpu[k].set(a32);
                } else {
                    cpu[k] = a32;
                }
            } else {
                cpu[k] = v;
            }
        });
    }

    // --- Memory <-> raw bytes --------------------------------------------
    // Words are little-endian on the wire (the PDP-11 is little-endian; the
    // images in media/ use the same order).
    function memoryToBytes(words) {
        var bytes = new Uint8Array(words.length * 2);
        for (var i = 0; i < words.length; i++) {
            bytes[i * 2] = words[i] & 0xff;
            bytes[i * 2 + 1] = (words[i] >>> 8) & 0xff;
        }
        return bytes;
    }

    function bytesToMemory(bytes) {
        // A fresh copy: the caller may hand us a view into a larger buffer.
        var view = new Uint8Array(bytes.length);
        view.set(bytes);
        return new Uint16Array(view.buffer, 0, view.byteLength >>> 1);
    }

    // --- Container pack / unpack -----------------------------------------
    /**
     * pack(manifest, memoryWords) -> Uint8Array (UNCOMPRESSED container bytes)
     *
     * The caller compresses the result (.state.zst). `manifest` carries
     * everything but memory; `memoryWords` is CPU.memory, or null for a state
     * with no memory section (a device-only layer).
     */
    function pack(manifest, memoryWords) {
        var memBytes = memoryWords ? memoryToBytes(memoryWords) : new Uint8Array(0);
        var manifestBytes = utf8Encode(JSON.stringify(manifest));
        var out = new Uint8Array(HEADER_LEN + manifestBytes.length + memBytes.length);
        out.set(MAGIC, 0);
        var len = manifestBytes.length;
        out[MAGIC_LEN] = len & 0xff;
        out[MAGIC_LEN + 1] = (len >>> 8) & 0xff;
        out[MAGIC_LEN + 2] = (len >>> 16) & 0xff;
        out[MAGIC_LEN + 3] = (len >>> 24) & 0xff;
        out.set(manifestBytes, HEADER_LEN);
        out.set(memBytes, HEADER_LEN + manifestBytes.length);
        return out;
    }

    /**
     * unpack(bytes) -> { manifest, memoryWords } or null when `bytes` is not a
     * container (an old snapshot, a plain image, a truncated file).
     *
     * Returning null rather than throwing is deliberate: callers must be able
     * to fall back (the browser still reads gzip/raw memories written before
     * this format existed).
     */
    function unpack(bytes) {
        if (!bytes || bytes.length < HEADER_LEN) return null;
        for (var i = 0; i < MAGIC_LEN; i++) {
            if (bytes[i] !== MAGIC[i]) return null;
        }
        var len = bytes[MAGIC_LEN] | (bytes[MAGIC_LEN + 1] << 8) |
                  (bytes[MAGIC_LEN + 2] << 16) | (bytes[MAGIC_LEN + 3] << 24);
        if (len < 0 || HEADER_LEN + len > bytes.length) return null;
        var manifest;
        try {
            manifest = JSON.parse(utf8Decode(bytes.subarray(HEADER_LEN, HEADER_LEN + len)));
        } catch (e) {
            return null;
        }
        var memStart = HEADER_LEN + len;
        var memBytes = bytes.subarray(memStart);
        return {
            manifest: manifest,
            memoryWords: memBytes.length ? bytesToMemory(memBytes) : null,
        };
    }

    // Is this a .state container? (cheap check, for the fallback paths)
    function isContainer(bytes) {
        if (!bytes || bytes.length < HEADER_LEN) return false;
        for (var i = 0; i < MAGIC_LEN; i++) {
            if (bytes[i] !== MAGIC[i]) return false;
        }
        return true;
    }

    return {
        CONTAINER_VERSION: CONTAINER_VERSION,
        MAGIC: MAGIC,
        HEADER_LEN: HEADER_LEN,
        captureCPU: captureCPU,
        restoreCPU: restoreCPU,
        memoryToBytes: memoryToBytes,
        bytesToMemory: bytesToMemory,
        pack: pack,
        unpack: unpack,
        isContainer: isContainer,
    };
})();

if (typeof window !== "undefined") window.__yapdpStateFormat = StateFormat;
if (typeof module !== "undefined" && module.exports) {
    module.exports = { StateFormat: StateFormat };
}
