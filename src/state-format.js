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
 * ## Versioning
 *
 * Two different versions travel with a state, and they answer different
 * questions:
 *
 *   CONTAINER_VERSION (number)  how the BYTES are laid out — the magic, the
 *                               manifest length, what follows the manifest.
 *                               Changes only with the byte layout (a second
 *                               binary segment). 1 today.
 *   schemaVersion (semver)      the SHAPE of the manifest JSON. MAJOR means a
 *                               reader that does not understand it cannot read
 *                               the state; MINOR is additive fields an older
 *                               reader ignores; PATCH is cosmetic.
 *   yaPDPVersion (semver)       the application that wrote the state, for the
 *                               "this snapshot came from a newer yaPDP" warning.
 *
 * Legacy states carry a bare numeric schemaVersion (1); normalizeSchemaVersion
 * maps it onto the semver string so those states keep reading.
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
    //
    // Evolution rule: this number changes only when the byte LAYOUT after the
    // header changes — a second binary segment (a binary disk overlay, large
    // tapes) next to the raw memory, or the memory section replaced by a
    // descriptor-driven one. Adding fields to the manifest does NOT touch it
    // (that is schemaVersion's MINOR). When a second segment does arrive this
    // becomes 2 and the segments get an explicit descriptor; until then memory
    // is simply "everything after the manifest", and an offset/length pair in
    // the manifest would be redundant and could drift.
    var CONTAINER_VERSION = 1;

    // Snapshot manifest schema version — semver, and NOT the container layout
    // above. It describes the SHAPE of the manifest's JSON:
    //   MAJOR  a reader that does not understand it cannot read the state
    //          (readers branch on MAJOR — see schemaMajor below);
    //   MINOR  new fields an older reader simply ignores;
    //   PATCH  corrections with no structural change.
    // Legacy states wrote a bare number (1); normalizeSchemaVersion maps it to
    // this string, so a state saved before the field became semver still reads.
    var SCHEMA_VERSION = "1.0.0";

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

    // --- Versioning helpers ----------------------------------------------
    // A tiny MAJOR.MINOR.PATCH parser. Returns null for anything else, so a
    // caller can decide whether an unparsable version is a refusal or just a
    // field it cannot judge — both are real cases here (a state written by a
    // fork, a hand-edited manifest). Injected into stateCodecs-style callers
    // that live in the page or the Node tools.
    function parseSemver(v) {
        if (typeof v !== "string") return null;
        var m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
        if (!m) return null;
        return { major: +m[1], minor: +m[2], patch: +m[3] };
    }

    function compareSemver(a, b) {
        if (a.major !== b.major) return a.major < b.major ? -1 : 1;
        if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
        if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
        return 0;
    }

    // The manifest's schemaVersion as a semver string, whatever the writer
    // used. Legacy states wrote a number (1 -> "1.0.0", 2 -> "2.0.0"); a
    // state so old it has no field at all is treated as the current base
    // schema ("1.0.0"), because such a state's manifest IS the 1.x shape.
    function normalizeSchemaVersion(manifest) {
        var s = manifest ? manifest.schemaVersion : undefined;
        if (typeof s === "number" && isFinite(s)) return String(s) + ".0.0";
        if (typeof s === "string" && s.trim()) return s.trim();
        return SCHEMA_VERSION;
    }

    // The MAJOR of the manifest's schema — the number readers branch on. 1
    // means "the shape this module's readers understand"; anything else is a
    // schema a reader must refuse rather than half-apply.
    function schemaMajor(manifest) {
        var p = parseSemver(normalizeSchemaVersion(manifest));
        return p ? p.major : 0;
    }

    // Is a state written by CURRENT_VERSION usable here? A snapshot from a
    // NEWER app (MAJOR ahead, or same MAJOR and MINOR ahead) is not refused —
    // it may still restore — but it earns a warning the caller shows the
    // operator: "some features may not work". A PATCH difference never warns
    // (fixes with no structure change). A state with no yaPDPVersion, or an
    // unparsable one, cannot contradict anything and is treated as compatible.
    function checkVersionCompatibility(manifest, currentVersion) {
        var snap = manifest ? manifest.yaPDPVersion : undefined;
        if (!snap) return { compatible: true, warning: null };
        var s = parseSemver(snap);
        var c = parseSemver(currentVersion);
        if (!s || !c) return { compatible: true, warning: null };
        var newer = (s.major > c.major) ||
                    (s.major === c.major && s.minor > c.minor);
        if (!newer) return { compatible: true, warning: null };
        return {
            compatible: false,
            warning: {
                type: "newer_version",
                snapshotVersion: snap,
                currentVersion: String(currentVersion),
            },
        };
    }

    return {
        CONTAINER_VERSION: CONTAINER_VERSION,
        SCHEMA_VERSION: SCHEMA_VERSION,
        MAGIC: MAGIC,
        HEADER_LEN: HEADER_LEN,
        captureCPU: captureCPU,
        restoreCPU: restoreCPU,
        memoryToBytes: memoryToBytes,
        bytesToMemory: bytesToMemory,
        pack: pack,
        unpack: unpack,
        isContainer: isContainer,
        parseSemver: parseSemver,
        compareSemver: compareSemver,
        normalizeSchemaVersion: normalizeSchemaVersion,
        schemaMajor: schemaMajor,
        checkVersionCompatibility: checkVersionCompatibility,
    };
})();

if (typeof window !== "undefined") window.__yapdpStateFormat = StateFormat;
if (typeof module !== "undefined" && module.exports) {
    module.exports = { StateFormat: StateFormat };
}
