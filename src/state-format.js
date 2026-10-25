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
 *   legacy: "YAPDPSTA" + manifest length + JSON manifest + raw RAM bytes
 *   current: "YAPDPSTA" + manifest length + JSON manifest + a catalogued blob region
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
 *   CONTAINER_VERSION (number)  how the payload bytes are laid out. The first
 *                               canonical blob layout is version 1; the
 *                               unpublished YAPDPST2 prototype is migration-only.
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

    // Container layout version, independent of schemaVersion. The first
    // canonical layout already uses a descriptor-driven blob region for RAM,
    // overlays and embedded resources, so it is version 1. The earlier
    // YAPDPST2/containerVersion 2 layout was an unpublished prototype, not a
    // released contract; the migration reader below accepts it temporarily.
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

    var LEGACY_MAGIC = [0x59, 0x41, 0x50, 0x44, 0x50, 0x53, 0x54, 0x41]; // "YAPDPSTA"
    // Intermediate development format. It was never part of a released contract.
    var INTERMEDIATE_MAGIC = [0x59, 0x41, 0x50, 0x44, 0x50, 0x53, 0x54, 0x32]; // "YAPDPST2"
    var MAGIC = LEGACY_MAGIC;
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

    // --- Front panel <-> plain object ------------------------------------
    // The operator's side of the machine: the POWER LOCK key, the two rotary
    // switches and the three toggles. These are INDEPENDENT state — nothing in
    // the CPU or in any device can recreate them — so a state has to carry
    // them. Everything else on the panel is derived: the lamp masks come from
    // updateLights() (CPU/MMU/rotary), and the address/data rockers follow
    // CPU.switchRegister, which the CPU block already stores.
    var PANEL_FIELDS = ["powerSwitch", "rotary0", "rotary1", "lampTest", "halt", "step"];
    // Legal detents: powerSwitch -1 OFF / 0 POWER (RUN) / 1 LOCK, rotary0 0..7,
    // rotary1 0..3, and the three toggles are two-position rockers (0/1).
    var PANEL_RANGE = {
        powerSwitch: [-1, 1],
        rotary0: [0, 7],
        rotary1: [0, 3],
        lampTest: [0, 1],
        halt: [0, 1],
        step: [0, 1]
    };

    // One field, range-checked. Returns the integer detent, or null when the
    // value is missing, not a number, or outside the switch's travel — a state
    // read from a file must never put a physical switch between detents.
    function panelField(key, value) {
        var range = PANEL_RANGE[key];
        if (!range || typeof value !== "number" || !isFinite(value)) return null;
        var n = Math.round(value);
        if (n < range[0] || n > range[1]) return null;
        return n;
    }

    // capturePanel(panel) -> { powerSwitch, rotary0, rotary1, lampTest, halt,
    // step } | null. Whitelisted on purpose: the live panel object also holds
    // DOM id arrays and lamp masks, which are runtime cache, not machine state.
    function capturePanel(panel) {
        if (!panel || typeof panel !== "object") return null;
        var out = {};
        for (var i = 0; i < PANEL_FIELDS.length; i++) {
            var key = PANEL_FIELDS[i];
            var value = panelField(key, panel[key]);
            if (value !== null) out[key] = value;
        }
        return Object.keys(out).length ? out : null;
    }

    // applyPanelFields(panel, saved) -> the keys actually applied. Range-checked
    // for the same reason as capturePanel: hand-edited and future states are
    // inputs here, and an out-of-range detent would confuse the lamp logic.
    function applyPanelFields(panel, saved) {
        var applied = [];
        if (!panel || typeof panel !== "object" ||
            !saved || typeof saved !== "object") return applied;
        for (var i = 0; i < PANEL_FIELDS.length; i++) {
            var key = PANEL_FIELDS[i];
            var value = panelField(key, saved[key]);
            if (value === null) continue;
            panel[key] = value;
            applied.push(key);
        }
        return applied;
    }

    // panelPowerOn(savedPanel, runState, haltState, profilePowerOn)
    //   -> { powerOn: boolean, position: -1|0|1, legacy: boolean }
    //
    // Where the POWER LOCK stood in a state. A state may predate the panel
    // block (everything written before it, and everything the Node tools
    // exported), so the fallback order is:
    //   1. the block decides, when it is present;
    //   2. a machine restored RUNNING was powered on — a switched-off 11/70
    //      does not run. This is the case that left a working guest sitting
    //      behind an OFF panel;
    //   3. a halted machine keeps the recorded Behaviour preference (a browser
    //      snapshot of a machine the operator deliberately left switched off);
    //   4. otherwise the state came from a working machine: power it on.
    function panelPowerOn(savedPanel, runState, haltState, profilePowerOn) {
        if (savedPanel && typeof savedPanel === "object") {
            var saved = panelField("powerSwitch", savedPanel.powerSwitch);
            if (saved !== null) {
                return { powerOn: saved >= 0, position: saved, legacy: false };
            }
        }
        var running = typeof runState === "number" && runState !== haltState;
        if (!running && profilePowerOn === false) {
            return { powerOn: false, position: -1, legacy: true };
        }
        return { powerOn: true, position: 0, legacy: true };
    }

    // --- Container pack / unpack -----------------------------------------
    // Binary overlay codec. The small JSON index describes disk identities and
    // block locations; block contents themselves remain binary.
    function encodeOverlay(overlay) {
        if (!overlay || typeof overlay !== "object") return null;
        var entries = [];
        var chunks = [];
        var offset = 0;
        Object.keys(overlay).forEach(function (url) {
            var rec = overlay[url];
            if (!rec || typeof rec !== "object" ||
                !rec.blocks || typeof rec.blocks !== "object") return;
            var entry = { url: url, v: rec.v == null ? null : rec.v,
                origin: rec.origin == null ? null : rec.origin, blocks: [] };
            Object.keys(rec.blocks).forEach(function (key) {
                var value = rec.blocks[key];
                var bytes = value instanceof Uint8Array ? value
                    : Array.isArray(value) ? Uint8Array.from(value)
                    : value && typeof value === "object"
                        ? Uint8Array.from(Object.values(value)) : null;
                if (!bytes || !bytes.length) return;
                entry.blocks.push({ block: Number(key), offset: offset, length: bytes.length });
                chunks.push(bytes);
                offset += bytes.length;
            });
            if (entry.blocks.length) entries.push(entry);
        });
        var meta = utf8Encode(JSON.stringify({ version: 1, entries: entries }));
        var out = new Uint8Array(4 + meta.length + offset);
        out[0] = meta.length & 0xff;
        out[1] = (meta.length >>> 8) & 0xff;
        out[2] = (meta.length >>> 16) & 0xff;
        out[3] = (meta.length >>> 24) & 0xff;
        out.set(meta, 4);
        var cursor = 4 + meta.length;
        chunks.forEach(function (chunk) {
            out.set(chunk, cursor);
            cursor += chunk.length;
        });
        return out;
    }

    function decodeOverlay(bytes) {
        if (!bytes || bytes.length < 4) return null;
        var metaLength = bytes[0] | (bytes[1] << 8) |
            (bytes[2] << 16) | (bytes[3] << 24);
        if (metaLength < 0 || 4 + metaLength > bytes.length) return null;
        var meta;
        try {
            meta = JSON.parse(utf8Decode(bytes.subarray(4, 4 + metaLength)));
        } catch (e) {
            return null;
        }
        if (!meta || meta.version !== 1 || !Array.isArray(meta.entries)) return null;
        var dataStart = 4 + metaLength;
        var out = {};
        for (var i = 0; i < meta.entries.length; i++) {
            var entry = meta.entries[i];
            if (!entry || typeof entry.url !== "string" || !Array.isArray(entry.blocks)) return null;
            var blocks = {};
            for (var j = 0; j < entry.blocks.length; j++) {
                var item = entry.blocks[j];
                if (!item || !Number.isInteger(item.block) || item.block < 0 ||
                    !Number.isInteger(item.offset) || item.offset < 0 ||
                    !Number.isInteger(item.length) || item.length <= 0 ||
                    item.offset + item.length > bytes.length - dataStart) return null;
                blocks[String(item.block)] = bytes.slice(
                    dataStart + item.offset, dataStart + item.offset + item.length);
            }
            out[entry.url] = { v: entry.v == null ? null : entry.v, blocks: blocks };
            if (entry.origin != null) out[entry.url].origin = entry.origin;
        }
        return out;
    }

    function blobHash(bytes) {
        var fingerprint = (typeof ImageFingerprint !== "undefined") ? ImageFingerprint : null;
        if (!fingerprint && typeof module !== "undefined" && module.exports) {
            try { fingerprint = require("./imagefingerprint.js").ImageFingerprint; }
            catch (e) { fingerprint = null; }
        }
        return fingerprint && typeof fingerprint.ofBytes === "function"
            ? fingerprint.ofBytes(bytes) : null;
    }

    function writeHeader(out, magic, manifestBytes) {
        out.set(magic, 0);
        var len = manifestBytes.length;
        out[MAGIC_LEN] = len & 0xff;
        out[MAGIC_LEN + 1] = (len >>> 8) & 0xff;
        out[MAGIC_LEN + 2] = (len >>> 16) & 0xff;
        out[MAGIC_LEN + 3] = (len >>> 24) & 0xff;
        out.set(manifestBytes, HEADER_LEN);
    }

    function packLegacy(manifest, memoryWords) {
        var memBytes = memoryWords ? memoryToBytes(memoryWords) : new Uint8Array(0);
        var manifestBytes = utf8Encode(JSON.stringify(manifest));
        var out = new Uint8Array(HEADER_LEN + manifestBytes.length + memBytes.length);
        writeHeader(out, LEGACY_MAGIC, manifestBytes);
        out.set(memBytes, HEADER_LEN + manifestBytes.length);
        return out;
    }

    /**
     * pack(manifest, memoryWords, extraBlobs) -> Uint8Array.
     * Container version 1 stores RAM, binary disk overlays, and caller-supplied
     * resources in one offset-addressable blob region. Blob offsets are relative
     * to that region, not the compressed outer frame.
     */
    function pack(manifest, memoryWords, extraBlobs) {
        var saved = Object.assign({}, manifest || {});
        var blobs = [];
        var memoryBytes = memoryWords ? memoryToBytes(memoryWords) : new Uint8Array(0);
        if (memoryWords) {
            blobs.push({ id: "memory", mediaType: "application/vnd.yapdp.ram", bytes: memoryBytes });
            saved.memoryBlob = "memory";
        } else {
            delete saved.memoryBlob;
        }
        if (saved.overlay && typeof saved.overlay === "object") {
            var overlayBytes = encodeOverlay(saved.overlay);
            if (overlayBytes) {
                blobs.push({ id: "disk-overlay", mediaType: "application/vnd.yapdp.disk-overlay", bytes: overlayBytes });
                saved.overlayBlob = "disk-overlay";
            } else {
                delete saved.overlayBlob;
            }
            delete saved.overlay;
        }
        (extraBlobs || []).forEach(function (blob) {
            if (!blob || typeof blob.id !== "string" || !blob.id ||
                blob.id === "memory" || blob.id === "disk-overlay") {
                throw new Error("Invalid or reserved state blob id");
            }
            var bytes = blob.bytes instanceof Uint8Array
                ? blob.bytes : new Uint8Array(blob.bytes || 0);
            blobs.push({ id: blob.id, mediaType: blob.mediaType || "application/octet-stream", bytes: bytes });
        });

        var cursor = 0;
        var catalog = [];
        var stored = [];
        var ids = Object.create(null);
        var content = Object.create(null);
        blobs.forEach(function (blob) {
            if (ids[blob.id]) throw new Error("Duplicate state blob id: " + blob.id);
            ids[blob.id] = true;
            var hash = blobHash(blob.bytes);
            var key = hash ? "sha256:" + hash : "blob:" + blob.id;
            var location = content[key];
            if (!location) {
                location = { offset: cursor, size: blob.bytes.length };
                content[key] = location;
                stored.push(blob);
                cursor += blob.bytes.length;
            } else if (location.size !== blob.bytes.length) {
                throw new Error("State blob digest collision");
            }
            catalog.push({
                id: blob.id,
                mediaType: blob.mediaType,
                offset: location.offset,
                size: location.size,
                sha256: hash
            });
        });
        saved.containerVersion = CONTAINER_VERSION;
        saved.blobCatalog = catalog;
        var manifestBytes = utf8Encode(JSON.stringify(saved));
        var out = new Uint8Array(HEADER_LEN + manifestBytes.length + cursor);
        writeHeader(out, MAGIC, manifestBytes);
        cursor = HEADER_LEN + manifestBytes.length;
        stored.forEach(function (blob) {
            out.set(blob.bytes, cursor);
            cursor += blob.bytes.length;
        });
        return out;
    }

    function readManifest(bytes) {
        if (!bytes || bytes.length < HEADER_LEN) return null;
        var len = bytes[MAGIC_LEN] | (bytes[MAGIC_LEN + 1] << 8) |
                  (bytes[MAGIC_LEN + 2] << 16) | (bytes[MAGIC_LEN + 3] << 24);
        if (len < 0 || HEADER_LEN + len > bytes.length) return null;
        try {
            return JSON.parse(utf8Decode(bytes.subarray(HEADER_LEN, HEADER_LEN + len)));
        } catch (e) {
            return null;
        }
    }

    function unpack(bytes) {
        if (!bytes || bytes.length < HEADER_LEN) return null;
        var legacyMagic = startsWith(bytes, LEGACY_MAGIC);
        var intermediateMagic = startsWith(bytes, INTERMEDIATE_MAGIC);
        if (!legacyMagic && !intermediateMagic) return null;
        var manifest = readManifest(bytes);
        if (!manifest || typeof manifest !== "object") return null;
        var payloadStart = HEADER_LEN + (bytes[MAGIC_LEN] | (bytes[MAGIC_LEN + 1] << 8) |
            (bytes[MAGIC_LEN + 2] << 16) | (bytes[MAGIC_LEN + 3] << 24));
        // Released legacy containers have no containerVersion/blobCatalog and
        // store RAM as the entire payload. The new canonical format deliberately
        // keeps the same magic; the manifest discriminator selects the layout.
        // YAPDPST2 is accepted only to migrate an unpublished development format.
        var blobContainer = manifest.containerVersion === CONTAINER_VERSION &&
            Array.isArray(manifest.blobCatalog);
        var intermediateContainer = intermediateMagic && manifest.containerVersion === 2 &&
            Array.isArray(manifest.blobCatalog);
        if (!blobContainer && !intermediateContainer) {
            // A manifest that declares a container layout but uses an unknown
            // version must not fall through to the legacy "all payload is RAM"
            // interpretation.
            if (intermediateMagic || manifest.containerVersion != null ||
                Array.isArray(manifest.blobCatalog)) return null;
            var legacyMemory = bytes.subarray(payloadStart);
            if (legacyMemory.length & 1) return null;
            return { manifest: manifest,
                memoryWords: legacyMemory.length ? bytesToMemory(legacyMemory) : null };
        }
        var catalog = Object.create(null);
        var payloadLength = bytes.length - payloadStart;
        for (var i = 0; i < manifest.blobCatalog.length; i++) {
            var item = manifest.blobCatalog[i];
            if (!item || typeof item.id !== "string" ||
                !Number.isInteger(item.offset) || item.offset < 0 ||
                !Number.isInteger(item.size) || item.size < 0 ||
                item.offset + item.size > payloadLength || catalog[item.id]) return null;
            var blobBytes = bytes.slice(payloadStart + item.offset,
                payloadStart + item.offset + item.size);
            if (item.sha256 != null && blobHash(blobBytes) !== item.sha256) return null;
            catalog[item.id] = blobBytes;
        }
        var memory = null;
        if (manifest.memoryBlob != null) {
            if (!catalog[manifest.memoryBlob] || (catalog[manifest.memoryBlob].length & 1)) return null;
            memory = bytesToMemory(catalog[manifest.memoryBlob]);
        }
        if (manifest.overlayBlob != null) {
            if (!catalog[manifest.overlayBlob]) return null;
            manifest.overlay = decodeOverlay(catalog[manifest.overlayBlob]);
            if (!manifest.overlay) return null;
        }
        var blobCatalog = manifest.blobCatalog.slice();
        delete manifest.blobCatalog;
        delete manifest.memoryBlob;
        delete manifest.overlayBlob;
        delete manifest.containerVersion;
        return { manifest: manifest, memoryWords: memory, blobs: catalog, blobCatalog: blobCatalog };
    }

    function startsWith(bytes, magic) {
        if (!bytes || bytes.length < magic.length) return false;
        for (var i = 0; i < magic.length; i++) {
            if (bytes[i] !== magic[i]) return false;
        }
        return true;
    }

    function isContainer(bytes) {
        return startsWith(bytes, LEGACY_MAGIC) || startsWith(bytes, INTERMEDIATE_MAGIC);
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
        LEGACY_MAGIC: LEGACY_MAGIC,
        INTERMEDIATE_MAGIC: INTERMEDIATE_MAGIC,
        HEADER_LEN: HEADER_LEN,
        captureCPU: captureCPU,
        restoreCPU: restoreCPU,
        memoryToBytes: memoryToBytes,
        bytesToMemory: bytesToMemory,
        // Front panel: what a state must carry for the POWER LOCK key, the
        // rotary switches and the toggles to come back with the machine.
        PANEL_FIELDS: PANEL_FIELDS.slice(),
        capturePanel: capturePanel,
        applyPanelFields: applyPanelFields,
        panelPowerOn: panelPowerOn,
        pack: pack,
        packLegacy: packLegacy,
        unpack: unpack,
        encodeOverlay: encodeOverlay,
        decodeOverlay: decodeOverlay,
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
