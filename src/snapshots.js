/**
 * yaPDP — SnapshotStore: machine-state persistence (save/restore)
 *
 * Saves the full machine state (CPU registers, PSW, MMU, RAM and the list
 * of mounted images) to IndexedDB so the user can quit and later resume
 * exactly where they left off.
 *
 * Level 1 (implemented): CPU + RAM + mounted images.
 * The snapshot payload is versioned (schemaVersion) and extensible — later
 * levels add device registers (L2) and terminal/printer/punch buffers (L3)
 * without breaking existing snapshots.
 *
 * Load flow: load(id) writes the id into localStorage and reloads the page;
 * init() (DOMContentLoaded) sees the pending id, halts the CPU immediately
 * (synchronously, before the 80ms CPU start timer fires), restores RAM/CPU
 * and releases the CPU with the saved run state.
 *
 * Requires: pdp11.js (CPU), iopage.js (DataLoader), fzstd.js (optional,
 * for gzip of RAM we use the native CompressionStream when available).
 * Must be loaded AFTER pdp11-app.js so all modules are ready.
 */
var SnapshotStore = (() => {
    "use strict";

    const DB_NAME = "yapdp-snapshots";
    const DB_STORE = "snapshots";
    const SCHEMA_VERSION = 1;
    const PENDING_KEY = "yapdp-pending-snapshot";
    const MAX_SNAPSHOTS = 10;

    let dbPromise = null;
    let db = null;

    // ------------------------------------------------------------------
    // IndexedDB helpers (same pattern as DiskStore / dragdrop)
    // ------------------------------------------------------------------
    function openDB() {
        if (dbPromise) return dbPromise;
        if (typeof indexedDB === "undefined") {
            dbPromise = Promise.resolve(null);
            return dbPromise;
        }
        dbPromise = new Promise(function (resolve) {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = function () {
                if (!req.result.objectStoreNames.contains(DB_STORE)) {
                    req.result.createObjectStore(DB_STORE);
                }
            };
            req.onsuccess = function () { db = req.result; resolve(db); };
            req.onerror = function () { resolve(null); };
        });
        return dbPromise;
    }

    function dbPut(key, value) {
        return openDB().then(function (d) {
            if (!d) return Promise.resolve();
            return new Promise(function (resolve) {
                const tx = d.transaction(DB_STORE, "readwrite");
                tx.objectStore(DB_STORE).put(value, key);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        });
    }

    function dbGet(key) {
        return openDB().then(function (d) {
            if (!d) return Promise.resolve(undefined);
            return new Promise(function (resolve) {
                const tx = d.transaction(DB_STORE, "readonly");
                const req = tx.objectStore(DB_STORE).get(key);
                req.onsuccess = function () { resolve(req.result); };
                req.onerror = function () { resolve(undefined); };
            });
        });
    }

    function dbGetAll() {
        return openDB().then(function (d) {
            if (!d) return [];
            return new Promise(function (resolve) {
                const tx = d.transaction(DB_STORE, "readonly");
                const req = tx.objectStore(DB_STORE).getAll();
                req.onsuccess = function () {
                    const items = (req.result || []).map(function (v) {
                        return {
                            id: v.id,
                            name: v.name,
                            createdAt: v.createdAt,
                            schemaVersion: v.schemaVersion,
                            cpuBytes: v.cpuBytes || 0,
                            memBytes: v.memBytes || 0,
                            hasSteps: v.steps && Array.isArray(v.steps) && v.steps.length > 0,
                            stepsMessage: v.stepsMessage || null,
                        };
                    });
                    items.sort(function (a, b) { return a.createdAt - b.createdAt; });
                    resolve(items);
                };
                req.onerror = function () { resolve([]); };
            });
        });
    }

    function dbDelete(key) {
        return openDB().then(function (d) {
            if (!d) return Promise.resolve();
            return new Promise(function (resolve) {
                const tx = d.transaction(DB_STORE, "readwrite");
                tx.objectStore(DB_STORE).delete(key);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        });
    }

    // ------------------------------------------------------------------
    // Capture (save)
    // ------------------------------------------------------------------
    // The state FORMAT lives in src/state-format.js, shared with the Node
    // tools (tools/export-state.js, tools/headless-term.js) so there is one
    // definition of what a .state is. This module keeps only what is
    // browser-specific: IndexedDB, field capture from the live CPU, and the
    // gzip fallback for states written before the container existed.
    function captureCPU() {
        return StateFormat.captureCPU(CPU);
    }

    // RAM -> compressed bytes for storage in IndexedDB.
    //
    // New states are packed with the shared container (raw memory bytes, no
    // Array.from of millions of words) and compressed with zstd — the format
    // the images already use and the reason fzstd is on the page. The gzip
    // path stays for reading OLD snapshots: a state saved before this change
    // carries { format: "gzip", data }, and restoreMemory still understands
    // it.
    function captureMemory() {
        const bytes = StateFormat.memoryToBytes(CPU.memory);
        if (typeof fzstd !== "undefined" && typeof fzstd.compress === "function") {
            try {
                return Promise.resolve({ format: "zstd", data: fzstd.compress(bytes) });
            } catch (err) { /* fall through to gzip */ }
        }
        if (typeof CompressionStream !== "undefined") {
            const cs = new CompressionStream("gzip");
            const writer = cs.writable.getWriter();
            writer.write(bytes);
            writer.close();
            return new Response(cs.readable).arrayBuffer().then(function (buf) {
                return { format: "gzip", data: buf };
            });
        }
        return Promise.resolve({ format: "raw", data: bytes.buffer });
    }

    // Compress raw memory bytes for IndexedDB storage (same logic as captureMemory
    // but takes bytes instead of reading from CPU.memory). Used by importState().
    function compressBytes(bytes) {
        if (typeof fzstd !== "undefined" && typeof fzstd.compress === "function") {
            try {
                return Promise.resolve({ format: "zstd", data: fzstd.compress(bytes) });
            } catch (err) { /* fall through to gzip */ }
        }
        if (typeof CompressionStream !== "undefined") {
            var cs = new CompressionStream("gzip");
            var writer = cs.writable.getWriter();
            writer.write(bytes);
            writer.close();
            return new Response(cs.readable).arrayBuffer().then(function (buf) {
                return { format: "gzip", data: buf };
            });
        }
        return Promise.resolve({ format: "raw", data: bytes.buffer });
    }

    function captureMounted() {
        if (typeof DataLoader === "undefined" || !DataLoader.list) return [];
        return DataLoader.list();
    }

    // Which page the operator was viewing at capture time (panel, teletype,
    // vt52-console, storage, printer, ...). Restore returns the operator to
    // that same page after the reload instead of the default PANEL.
    function capturePage() {
        if (typeof document === "undefined" ||
            typeof document.querySelector !== "function") return null;
        try {
            var active = document.querySelector(".page.active");
            if (!active || !active.id || active.id.indexOf("page-") !== 0) return null;
            return active.id.slice(5);
        } catch (e) {
            return null;
        }
    }

    // Structural config that defines the installed device set. Quick-booting
    // a different guest OS (quickboot.js) changes these fields, so a snapshot
    // must record them to bring the right devices back on restore.
    // userTerminalTypes is structural too: it decides which cabinet each user
    // terminal is built as, so a snapshot taken with VT100 terminals must not be
    // restored onto a machine whose terminals are DECscopes.
    var STRUCTURAL_CONFIG = ["consoleType", "userTerminals", "userTerminalTypes",
                             "printer", "vt11"];

    function captureConfig() {
        if (typeof Config === "undefined" || typeof Config.get !== "function") return null;
        var c = Config.get();
        var out = {};
        STRUCTURAL_CONFIG.forEach(function (k) {
            out[k] = c[k];
        });
        return out;
    }

    function capture(name, steps, stepsMessage) {
        // Stop-the-world: freeze the CPU for the duration of the capture so
        // RAM, device registers and the disk overlay all come from the same
        // instant. Without this the asynchronous gzip compression lets the
        // guest keep running between the RAM capture (T0) and the device/
        // overlay capture (T1); a snapshot whose RAM predates its disk makes
        // the restored guest overwrite newer disk blocks with older metadata
        // (mixed generations) — observed as "bad free count" / "file system
        // full" corruption in 2.11 BSD after save+restore. The captured
        // runState is overridden to RUN so the restored machine continues.
        var prevRunState = CPU.runState;
        var wasRunning = prevRunState === STATE_RUN;
        if (wasRunning) CPU.runState = STATE_HALT;
        return captureMemory().then(function (mem) {
            var devices = null;
            if (typeof iopage !== "undefined" && typeof iopage.snapshotDevices === "function") {
                devices = iopage.snapshotDevices();
            }
            var punchtape = null;
            if (typeof window !== "undefined" && window.paperTape &&
                typeof window.paperTape.snapshot === "function") {
                punchtape = window.paperTape.snapshot();
            }
            var readertape = null;
            if (typeof window !== "undefined" && window.tapeReader &&
                typeof window.tapeReader.snapshot === "function") {
                readertape = window.tapeReader.snapshot();
            }
            var vt52 = null;
            if (typeof window !== "undefined" && window.vt52SnapshotAll &&
                typeof window.vt52SnapshotAll === "function") {
                vt52 = window.vt52SnapshotAll();
            }
            // Disk write-back overlay: the blocks that differ from the
            // pristine base image at capture time. Restoring them rolls the
            // disks back to the same generation as the captured RAM, so the
            // restored guest's filesystem metadata stays consistent with the
            // disk contents.
            var overlayPromise = (typeof DiskStore !== "undefined" &&
                typeof DiskStore.captureOverlay === "function")
                ? DiskStore.captureOverlay() : Promise.resolve({});
            return overlayPromise.then(function (overlay) {
                var snap = {
                    id: "snap-" + Date.now(),
                    name: name || defaultName(),
                    createdAt: Date.now(),
                    schemaVersion: SCHEMA_VERSION,
                    // Identity of every image the snapshot's disks belong to:
                    // { "rk0.dsk": "a1b2c3d4", ... }. A null/absent value
                    // means the identity was never learned (file://, desktop
                    // bundle) and never invalidates anything.
                    imageFingerprints: captureImageFingerprints(),
                    cpu: captureCPU(),
                    memory: mem,
                    mounted: captureMounted(),
                    config: captureConfig(),
                    page: capturePage(),
                    devices: devices,
                    punchtape: punchtape,
                    readertape: readertape,
                    vt52: vt52,
                    overlay: overlay,
                    steps: steps || null,
                    stepsMessage: stepsMessage || null,
                    cpuBytes: 0,
                    memBytes: mem.data.byteLength || 0
                };
                // The CPU was frozen for the capture, so the recorded
                // runState is HALT; the restored machine must RUN on.
                if (wasRunning) snap.cpu.runState = STATE_RUN;
                return snap;
            });
        }).then(function (snap) {
            // Resume the live machine (the CPU loop re-schedules itself, so
            // flipping runState back is enough).
            if (wasRunning) CPU.runState = prevRunState;
            return snap;
        }, function (err) {
            if (wasRunning) CPU.runState = prevRunState;
            throw err;
        });
    }

    function defaultName() {
        const d = new Date();
        function p(n) { return (n < 10 ? "0" : "") + n; }
        return "snap " + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
            + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    // ------------------------------------------------------------------
    // Restore (load)
    // ------------------------------------------------------------------
    function restoreCPU(cpu) {
        // runState is applied by restore() AFTER memory is back: a machine that
        // runs with the old memory traps instantly.
        StateFormat.restoreCPU(CPU, cpu, true);
    }

    function restoreMemory(mem) {
        return decompressMemoryToWords(mem).then(function (words) {
            if (CPU.memory.length === words.length) {
                CPU.memory.set(words);
            } else {
                CPU.memory = words;
            }
        });
    }

    // Decompress stored memory {format, data} back to raw Uint16Array words.
    // Shared by restoreMemory() and exportSnapshot().
    function decompressMemoryToWords(mem) {
        if (!mem) return Promise.resolve(new Uint16Array(0));
        var p;
        if (mem.format === "zstd" && typeof fzstd !== "undefined" &&
            typeof fzstd.decompress === "function") {
            try {
                p = Promise.resolve(Uint8Array.from(fzstd.decompress(new Uint8Array(mem.data))).buffer);
            } catch (e) {
                p = Promise.resolve(mem.data);
            }
        } else if (mem.format === "gzip" && typeof DecompressionStream !== "undefined") {
            var ds = new DecompressionStream("gzip");
            var writer = ds.writable.getWriter();
            writer.write(new Uint8Array(mem.data));
            writer.close();
            p = new Response(ds.readable).arrayBuffer();
        } else {
            p = Promise.resolve(mem.data);
        }
        return p.then(function (buf) {
            return StateFormat.bytesToMemory(new Uint8Array(buf));
        });
    }

    // Apply a snapshot to the live machine. Caller must have halted the
    // CPU first (or the CPU start timer must not have fired yet).
    // Fingerprints of the images this machine is currently running on, read
    // from DiskStore (which learns them from the bytes the browser received).
    // Falls back to null per url, which callers treat as "unknown".
    function captureImageFingerprints() {
        var out = {};
        if (typeof DiskStore === "undefined" ||
            typeof DiskStore.fingerprintOf !== "function") return out;
        var urls = listMountedUrls(snapMountedList());
        urls.forEach(function (url) {
            var fp = DiskStore.fingerprintOf(url);
            if (fp != null) out[url] = fp;
        });
        return out;
    }

    // The mounted image list as the emulator sees it (DataLoader), as urls.
    function snapMountedList() {
        if (typeof DataLoader === "undefined" ||
            typeof DataLoader.list !== "function") return [];
        try { return DataLoader.list() || []; } catch (e) { return []; }
    }

    function listMountedUrls(list) {
        return (list || []).map(function (u) { return String(u); });
    }

    // Which images in the snapshot no longer match the ones loaded now.
    // An unknown fingerprint on either side is NOT a mismatch: a value that
    // was never computed cannot contradict anything, and treating it as a
    // mismatch would refuse good snapshots on every host without a .zst.
    // Returns [{url, then, now}, ...] — empty when the snapshot is usable.
    function incompatibleImages(snap) {
        var saved = (snap && snap.imageFingerprints) || null;
        if (!saved || typeof saved !== "object") return [];
        var F = (typeof ImageFingerprint !== "undefined") ? ImageFingerprint : null;
        var bad = [];
        Object.keys(saved).forEach(function (url) {
            var then = saved[url];
            var now = (typeof DiskStore !== "undefined" &&
                typeof DiskStore.fingerprintOf === "function")
                ? DiskStore.fingerprintOf(url) : null;
            // Only a KNOWN current fingerprint can contradict a known saved
            // one; if the image is not loaded now, `now` is null and the
            // snapshot is not refused for it (it may still be mounted later).
            if (now == null) return;
            var ok = F && typeof F.matches === "function"
                ? F.matches(then, now)
                : String(then) === String(now);
            if (!ok) bad.push({ url: url, then: then, now: now });
        });
        return bad;
    }

    // Mount disk images from a snapshot's mounted list into DataLoader and
    // ensure their drive providers are set up. Used by restore() so that a
    // state loaded via ?state= has its disks available — the images are not
    // mounted by dragdrop.init() because there is no page reload.
    function mountStateDisks(mounted) {
        if (!mounted || !Array.isArray(mounted) || !mounted.length) {
            if (typeof console !== "undefined") console.log("mountStateDisks: no mounted urls");
            return Promise.resolve();
        }
        var urls = mounted.filter(function (u) { return u && typeof u === "string"; });
        if (!urls.length) {
            if (typeof console !== "undefined") console.log("mountStateDisks: no valid urls after filter");
            return Promise.resolve();
        }
        if (typeof console !== "undefined") console.log("mountStateDisks: mounting", JSON.stringify(urls));
        var promises = [];
        for (var i = 0; i < urls.length; i++) {
            (function (url) {
                var p = Promise.resolve();
                if (typeof DataLoader !== "undefined" &&
                    typeof DataLoader.has === "function" && !DataLoader.has(url)) {
                    if (typeof window !== "undefined" &&
                        typeof window.__yapdpLoadImage === "function") {
                        if (typeof console !== "undefined") console.log("mountStateDisks: loading", url);
                        p = window.__yapdpLoadImage(url);
                    }
                } else {
                    if (typeof console !== "undefined") console.log("mountStateDisks: already in DataLoader:", url);
                }
                promises.push(p.then(function () {
                    if (typeof window !== "undefined" &&
                        typeof window.__yapdpMountProvider === "function") {
                        if (typeof console !== "undefined") console.log("mountStateDisks: mounting provider for", url);
                        window.__yapdpMountProvider(url);
                    }
                }));
            })(urls[i]);
        }
        return Promise.all(promises);
    }

    function restore(snap) {
        if (!snap) return Promise.resolve(false);
        // Refuse BEFORE touching CPU/RAM: a snapshot whose disks changed under
        // it cannot be restored consistently, and a half-applied restore
        // (new RAM on an old disk) is worse than no restore at all. The same
        // rule DiskStore.restoreOverlay applies per block, applied to the
        // snapshot as a whole.
        var bad = incompatibleImages(snap);
        if (bad.length > 0) {
            showIncompatibleImageDialog(snap, bad);
            return Promise.resolve(false);
        }
        restoreCPU(snap.cpu);
        return restoreMemory(snap.memory).then(function () {
            // Device registers (L2) — restore after RAM so devices see
            // consistent memory; control blocks re-create lazily on I/O.
            if (snap.devices && typeof iopage !== "undefined" &&
                typeof iopage.restoreDevices === "function") {
                iopage.restoreDevices(snap.devices);
            }
            // Clear ALL existing overlays from IndexedDB — a stale overlay
            // from a previous session would corrupt the restored filesystem
            // (blocks written by a different boot would be overlaid onto the
            // restored base image). The snapshot's own overlay is applied
            // AFTER the images are mounted (see below), so that the
            // fingerprint check in restoreOverlay() can match against the
            // freshly-registered image identity.
            var overlayPromise = Promise.resolve();
            if (typeof DiskStore !== "undefined" &&
                typeof DiskStore.clearAll === "function") {
                overlayPromise = DiskStore.clearAll();
            }
            return overlayPromise.then(function () {
                // Mount disk images from the snapshot BEFORE the CPU resumes,
                // so the guest OS can read its drives immediately. The images
                // are loaded into DataLoader and their providers are set up
                // (see mountStateDisks). Without this, a state loaded via
                // ?state= restores CPU/RAM/devices but the disks are not
                // accessible — fetchBlock() finds nothing in DataLoader and
                // the guest OS hangs or fails to boot.
                //
                // Mount disks BEFORE applying the overlay so that the image
                // fingerprint is registered in DiskStore — restoreOverlay()
                // checks matchOk(rec.v, fingerprintOf(url)) and would skip
                // the overlay when the fingerprint is still unknown (null).
                return mountStateDisks(snap.mounted);
            }).then(function () {
                // Apply the overlay AFTER the images are mounted, so the
                // fingerprint check in restoreOverlay() can match against
                // the freshly-registered image identity.
                if (snap.overlay && typeof DiskStore !== "undefined" &&
                    typeof DiskStore.restoreOverlay === "function") {
                    return DiskStore.restoreOverlay(snap.overlay);
                }
            }).then(function () {
                // Resume the CPU only after RAM is back in place: running with
                    // the old memory contents (boot code / garbage) and the restored
                    // PC traps instantly, and a trap inside a trap overflows the
                    // stack. runState was deferred by restoreCPU() for this reason;
                    // the trap() recursion guard makes this safe even if the restored
                    // image is mid-garbage.
                    if (snap.cpu && typeof snap.cpu.runState === "number") {
                        CPU.runState = snap.cpu.runState;
                    }
                    // Visual punched tape (L2) — re-render the hanging ASR tape
                    // from the captured byte array (no-op when the tape UI is
                    // absent, e.g. VT52 console).
                    if (snap.punchtape && typeof window !== "undefined" &&
                        window.paperTape && typeof window.paperTape.restore === "function") {
                        window.paperTape.restore(snap.punchtape.buffer);
                    }
                    // ASR reader tape (L2) — re-render the loaded tape and its read
                    // position (no-op when the tape UI is absent or no tape was
                    // loaded at capture time).
                    if (snap.readertape && typeof window !== "undefined" &&
                        window.tapeReader && typeof window.tapeReader.restore === "function") {
                        window.tapeReader.restore(snap.readertape);
                        // A restored tape is paused like a freshly loaded one: the
                        // reader switch goes to STOP so the UI never shows a
                        // running reader with a stopped motor.
                        if (typeof window.setReaderMode === "function") {
                            window.setReaderMode("stop");
                        }
                    }
                    // VT52 terminals (L3) — screen buffer, hardcopy scrollback,
                    // cursor, modes. Restored after RAM/devices so a repaint sees
                    // consistent state. No-op when the terminal API is absent.
                    if (snap.vt52 && typeof window !== "undefined" &&
                        window.vt52RestoreAll && typeof window.vt52RestoreAll === "function") {
                        window.vt52RestoreAll(snap.vt52);
                    }
                    // The TELETYPE's paper — the console screen for half the
                    // guests, and not a VT52: it is printed paper, captured as
                    // rendered rows. Without this a restored teletype guest wakes
                    // up with a BLANK screen (the boot banner and the prompt are
                    // on paper nobody put back). No-op when the printer API or the
                    // field is absent (an older state).
                    if (snap.teletypepaper && typeof window !== "undefined" &&
                        window.g60printer && typeof window.g60printer.restore === "function") {
                        window.g60printer.restore(snap.teletypepaper);
                    }
                    // Mounted images: DataLoader entries are re-created by
                    // dragdrop.init() from the images IDB on startup; nothing to
                    // do here (URLs are recorded in the snapshot for the UI).
                    if (typeof window !== "undefined" && window.__snapshotRestored) {
                        window.__snapshotRestored(snap);
                    }
                    // Return the operator to the page they were viewing at capture
                    // time (console, printer, storage, ...) instead of the default
                    // PANEL that the reload would otherwise show. No-op for
                    // snapshots taken before this field existed, when switchPage is
                    // unavailable, or when the page is missing from this document
                    // (device set no longer includes it).
                    if (snap.page && typeof switchPage === "function" &&
                        typeof document !== "undefined" &&
                        typeof document.getElementById === "function" &&
                        document.getElementById("page-" + snap.page)) {
                        switchPage(snap.page);
                    }
                    return true;
                });
            });
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    function save(name, steps, stepsMessage) {
        return capture(name, steps, stepsMessage).then(function (snap) {
            return dbPut(snap.id, snap).then(function () {
                // Keep the store bounded.
                return dbGetAll().then(function (items) {
                    const excess = items.length - MAX_SNAPSHOTS;
                    if (excess > 0) {
                        const doomed = items.slice(0, excess);
                        return Promise.all(doomed.map(function (it) {
                            return dbDelete(it.id);
                        })).then(function () { return snap; });
                    }
                    return snap;
                });
            });
        });
    }

    function list() {
        return dbGetAll();
    }

    function rename(id, name) {
        return dbGet(id).then(function (snap) {
            if (!snap) return Promise.resolve(false);
            snap.name = name;
            return dbPut(id, snap);
        });
    }

    function remove(id) {
        return dbDelete(id);
    }

    // --- Loading a state from a URL (?state= deep link) ------------------
    //
    // The second kind of shareable link (see docs/ROADMAP.md): ?boot= names a
    // scenario this build ships, ?state= points at a machine state — one the
    // project hosts (states/<name>.state.zst) or one a visitor put on their own
    // host. The URL is validated by the caller before we get here
    // (QuickBoot.stateUrlAllowed); this function defends the LOAD: a size
    // bound so a link cannot make the browser allocate without limit, and the
    // container check so a page that is not a state is refused up front rather
    // than half-applied.
    //
    // A state fetched here is NOT written to the store: it belongs to somebody
    // else's link, and copying it into the user's snapshot list would be a
    // surprise. It is applied to the live machine, once.
    var MAX_STATE_BYTES = 16 * 1024 * 1024;   // a state, not an image

    // opts.onRestored(manifest) — called AFTER the state is applied but BEFORE
    // the promise settles, so a caller can raise a "preparing" toast for the
    // disk image the restored guest is about to read, and resolve when it has
    // arrived. The manifest is passed because WHICH image only becomes known
    // once the container is unpacked — checking earlier cannot know what to
    // wait for (measured 2026-10-02: checking first meant the toast never came).
    // A deep link whose state needs a DIFFERENT device set (a different console
    // type, user terminals the state does not carry, the printer or VT11 the
    // other way round) must be resumed after a reload: devices are registered
    // at page load, so a new set cannot appear in the running one.
    //
    // The URL is remembered in sessionStorage and the page reloads; init()
    // reads the key and calls loadFromUrl() again, this time against the right
    // device set. The state itself is NOT copied into the store: it is fetched
    // again, from where its link points.
    const PENDING_STATE_KEY = "yapdp-pending-state-url";

    function pendingStateUrl() {
        try {
            if (typeof sessionStorage === "undefined") return null;
            return sessionStorage.getItem(PENDING_STATE_KEY);
        } catch (e) { return null; }
    }

    function clearPendingStateUrl() {
        try {
            if (typeof sessionStorage !== "undefined") {
                sessionStorage.removeItem(PENDING_STATE_KEY);
            }
        } catch (e) { /* ignore */ }
    }

    function loadFromUrl(url, opts) {
        var u = String(url || "");
        if (!u) return Promise.resolve({ ok: false, reason: "missing-url" });
        var onRestored = (opts && typeof opts.onRestored === "function")
            ? opts.onRestored : null;
        // A same-origin relative path resolves against the page, which is how
        // the project hosts its own states.
        var target = u;
        if (typeof location !== "undefined" && !/^https?:\/\//i.test(u)) {
            try { target = new URL(u, location.href).href; } catch (e) { /* keep u */ }
        }
        return fetch(target, { cache: "no-store" }).then(function (res) {
            if (!res.ok) {
                return { ok: false, reason: "http-" + res.status, url: target };
            }
            var len = parseInt(res.headers.get("content-length"), 10);
            if (Number.isFinite(len) && len > MAX_STATE_BYTES) {
                return { ok: false, reason: "too-large", url: target, size: len };
            }
            return res.arrayBuffer().then(function (buf) {
                if (buf.byteLength > MAX_STATE_BYTES) {
                    return { ok: false, reason: "too-large", url: target,
                             size: buf.byteLength };
                }
                // The state's OWN device set is applied unconditionally — no
                // comparison, no question asked. A state is a whole machine,
                // and a machine restored onto a different device set is not
                // "mostly working": only the parts that happened to match work
                // (measured 2026-10-02 — a guest restored with two extra user
                // terminals came up with BOTH terminals dead while the console
                // was fine, because the state simply had no registers for
                // them). Applying the profile is what makes the teleport work
                // for someone who never ran yaPDP before, which is the whole
                // point of the link.
                // A state's manifest decides whether the page has to reload
                // BEFORE the state is applied (the profile check below), and
                // reading it may be asynchronous: zstd and a bare container are
                // decoded on the spot, while a gzip frame — the browser's own
                // export, and therefore every shared state — goes through the
                // platform decoder. peekManifest() returns the manifest or a
                // Promise for it, and this is the one place that cares which.
                var peeked = peekManifest(new Uint8Array(buf));
                if (peeked && typeof peeked.then === "function") {
                    return peeked.then(finishLoad, function () { return finishLoad(null); });
                }
                return finishLoad(peeked);

                // Hoisted so both peek paths reach it: apply the state, or
                // reload the page once the config it asks for is in place.
                function finishLoad(parsedManifest) {
                    if (parsedManifest && configNeedsReload({ config: parsedManifest.profile })) {
                        applySnapshotConfig({ config: parsedManifest.profile });
                        try {
                            if (typeof sessionStorage !== "undefined") {
                                sessionStorage.setItem(PENDING_STATE_KEY, target);
                                sessionStorage.setItem("yapdp.restore-pending", "1");
                                // Persist steps, description and button label across
                                // the reload so they can be shown on the second load.
                                if (parsedManifest.steps) {
                                    sessionStorage.setItem("yapdp.state-steps",
                                        JSON.stringify(parsedManifest.steps));
                                }
                                if (parsedManifest.stepsMessage) {
                                    sessionStorage.setItem("yapdp.state-steps-message",
                                        parsedManifest.stepsMessage);
                                }
                                if (parsedManifest.buttonLabel) {
                                    sessionStorage.setItem("yapdp.state-button-label",
                                        parsedManifest.buttonLabel);
                                }
                            }
                        } catch (e) { /* ignore */ }
                        if (typeof window !== "undefined") window.__allowConfigReload = true;
                        if (typeof location !== "undefined" && location.reload) {
                            location.reload();
                            return { ok: true, reloading: true, url: target };
                        }
                    }
                    var applied = applyStateBytes(new Uint8Array(buf), target);
                    if (!onRestored) return applied;
                    return applied.then(function (result) {
                        if (!result || !result.ok) return result;
                        return Promise.resolve(onRestored(lastStateManifest))
                            .then(function () {
                                // Steps run AFTER image loading, gate still ON
                                var steps = (lastStateManifest && lastStateManifest.steps &&
                                    Array.isArray(lastStateManifest.steps) && lastStateManifest.steps.length > 0)
                                    ? lastStateManifest.steps : null;
                                // Fall back to steps persisted across a config-driven
                                // reload (saved in sessionStorage before reload()).
                                if (!steps) {
                                    try {
                                        var saved = sessionStorage.getItem("yapdp.state-steps");
                                        if (saved) {
                                            steps = JSON.parse(saved);
                                            sessionStorage.removeItem("yapdp.state-steps");
                                        }
                                    } catch (e) { /* ignore */ }
                                }
                                if (steps) {
                                    return StepEngine.runSteps(steps, {
                                        sendBytes: StepEngine.sendBytes,
                                        outputContains: StepEngine.outputContains,
                                        stepDelayMs: 800,
                                        onDone: function () {
                                            // Close the preparing balloon after all steps
                                            // complete (the OK button was already clicked).
                                            if (typeof window !== "undefined" &&
                                                typeof window.__hideStatePreparing === "function") {
                                                window.__hideStatePreparing();
                                            }
                                        },
                                    });
                                }
                            })
                            .then(function () { return result; });
                    }, function (err) {
                        return { ok: false, reason: "network", url: target,
                                 detail: String(err && err.message ? err.message : err) };
                    });
                }
            });
        }).catch(function (err) {
            return { ok: false, reason: "network", url: target,
                     detail: String(err && err.message ? err.message : err) };
        });
    }

    // Read the manifest out of a container without applying anything, so the
    // device set can be checked BEFORE the machine is touched. Returns the
    // manifest, a Promise for it (a gzip frame needs the platform decoder), or
    // null when the bytes are not a container.
    function peekManifest(bytes) {
        var container = readStateContainer(new Uint8Array(bytes));
        if (container === null) return null;
        var read = function (raw) {
            var parsed = (typeof StateFormat !== "undefined" &&
                typeof StateFormat.unpack === "function")
                ? StateFormat.unpack(raw) : null;
            return parsed ? parsed.manifest : null;
        };
        if (container && typeof container.then === "function") {
            return container.then(read, function () { return null; });
        }
        return read(container);
    }

    // The codecs src/state-frame.js asks for: the PAGE supplies the platform
    // halves. fzstd decodes zstd — the frame the tools write — and gzip goes
    // through the built-in DecompressionStream, which is ASYNCHRONOUS, so
    // unwrap() returns a Promise for that one and the callers below accept
    // either shape. Which frames exist and which one is preferred is NOT
    // decided here.
    function stateCodecs() {
        var haveZstd = (typeof fzstd !== "undefined" &&
            typeof fzstd.decompress === "function");
        return {
            isContainer: (typeof StateFormat !== "undefined" &&
                typeof StateFormat.isContainer === "function")
                ? StateFormat.isContainer : null,
            zstdDecode: haveZstd ? function (b) {
                return Uint8Array.from(fzstd.decompress(new Uint8Array(b)));
            } : null,
            gzipDecode: gunzipBytes
        };
    }

    // The container under the frame, or null when there is none: no
    // StateFrame on the page, an unrecognised frame, or bytes that are not a
    // state at all. May return a Promise — a gzip frame needs the platform
    // decoder — which the callers handle explicitly.
    function readStateContainer(bytes) {
        if (typeof StateFrame === "undefined") return null;
        try {
            return StateFrame.unwrap(bytes, stateCodecs());
        } catch (e) {
            return null;
        }
    }

    // Decompress + unpack + restore, in one place so the browser path and any
    // future caller agree. A .state file is a CONTAINER (src/state-format.js)
    // wrapped in a frame, and the frame is whatever the WRITER had: zstd from
    // the tools and the repo's own states, gzip from the browser's own export
    // (CompressionStream — the page ships no zstd encoder), or nothing at all
    // when the writer had no compressor. src/state-frame.js owns that rule;
    // the codecs above are this page's half of it.
    function applyStateBytes(bytes, url) {
        var container = readStateContainer(new Uint8Array(bytes));
        if (container === null) {
            return Promise.resolve({ ok: false, reason: "not-a-state", url: url });
        }
        if (container && typeof container.then === "function") {
            return container.then(function (raw) {
                return applyContainer(raw, url);
            }, function () {
                return { ok: false, reason: "not-a-state", url: url };
            });
        }
        return Promise.resolve(applyContainer(container, url));
    }

    // The container half: unpack, stamp the overlay's origin, hand it to
    // restore(). Split out so both the sync and the gzip path share it.
    // The manifest of the state most recently unpacked, for callers that need
    // to know what it will ASK FOR before it is restored — the deep-link path
    // uses the device to learn which image the guest will read, so it can show
    // the "preparing" toast while that image is still being fetched instead of
    // letting the visitor meet a download strip mid-session (2026-10-02).
    var lastStateManifest = null;

    function applyContainer(raw, url) {
        var parsed = (typeof StateFormat !== "undefined" &&
            typeof StateFormat.unpack === "function") ? StateFormat.unpack(raw) : null;
        if (!parsed) {
            if (typeof console !== "undefined") console.log("applyContainer: unpack failed");
            return { ok: false, reason: "not-a-state", url: url };
        }
        lastStateManifest = parsed.manifest || null;
        if (typeof console !== "undefined") console.log("applyContainer: manifest set, device=", parsed.manifest ? parsed.manifest.device : "null");
        // A container state arrives as manifest + raw words; the rest of the
        // restore path wants a snapshot-shaped object (cpu/memory/devices).
        // The overlay is stamped with its origin so the Storage UI can say
        // "changes from a shared state" — these blocks came from somebody
        // else's link, not from this user's own work.
        var overlay = deserializeOverlay(parsed.manifest.overlay);
        if (overlay && typeof overlay === "object") {
            Object.keys(overlay).forEach(function (u) {
                if (overlay[u] && typeof overlay[u] === "object") {
                    overlay[u].origin = "state";
                }
            });
        }
        var snap = {
            id: "url-state",
            name: parsed.manifest.label || parsed.manifest.device || url,
            schemaVersion: parsed.manifest.schemaVersion,
            imageFingerprints: parsed.manifest.imageFingerprints || null,
            cpu: parsed.manifest.cpu || {},
            memory: { format: "raw", data: parsed.memoryWords
                ? parsed.memoryWords.buffer : new ArrayBuffer(0) },
            devices: parsed.manifest.devices || null,
            config: parsed.manifest.profile || null,
            overlay: overlay,
            page: parsed.manifest.page || null,
            // The operator's view: terminal screens and the paper in the
            // teletype. Without these a restored guest is alive but blind —
            // its screen is blank (measured: BASIC-11 restarted with an empty
            // teletype). restore() already knows how to put them back.
            punchtape: parsed.manifest.punchtape || null,
            readertape: parsed.manifest.readertape || null,
            vt52: parsed.manifest.vt52 || null,
            teletypepaper: parsed.manifest.teletypepaper || null,
            mounted: parsed.manifest.mounted || [],
        };
        return restore(snap).then(function (applied) {
            return applied ? { ok: true, url: url, name: snap.name }
                           : { ok: false, reason: "incompatible", url: url };
        });
    }

    // Export the live machine as a .state container's bytes, ready to write
    // somewhere. This is the one path both consumers share:
    //   - the Machine-state dialog's "Export state" button (download a file);
    //   - tools/export-state-browser.js, which calls this through page.evaluate
    //     and writes the bytes to states/, so a state is taken from the REAL
    //     browser — the same configuration a visitor gets.
    //
    // Returns a Promise<Uint8Array> (the raw container, zstd-compressed).
    function exportBytes(name) {
        // Build the same manifest the file tools build, so a state taken here
        // and one taken by tools/export-state.js are the same kind of thing.
        var prevRunState = CPU.runState;
        var wasRunning = prevRunState === STATE_RUN;
        if (wasRunning) CPU.runState = STATE_HALT;

        var devices = (typeof iopage !== "undefined" &&
            typeof iopage.snapshotDevices === "function")
            ? iopage.snapshotDevices() : null;

        // Everything restore() knows how to put back, not just the machine's
        // silicon. A state that carried only cpu/devices/memory restored a
        // guest with a BLANK SCREEN: the terminal's own contents live in these
        // fields (measured: BASIC-11 came back alive but the teletype paper was
        // empty, so the login banner and the *O prompt were gone). The set
        // mirrors capture() — if it grows there, it grows here.
        var punchtape = null;
        if (typeof window !== "undefined" && window.paperTape &&
            typeof window.paperTape.snapshot === "function") {
            punchtape = window.paperTape.snapshot();
        }
        var readertape = null;
        if (typeof window !== "undefined" && window.tapeReader &&
            typeof window.tapeReader.snapshot === "function") {
            readertape = window.tapeReader.snapshot();
        }
        var vt52 = null;
        if (typeof window !== "undefined" && window.vt52SnapshotAll &&
            typeof window.vt52SnapshotAll === "function") {
            vt52 = window.vt52SnapshotAll();
        }
        // The TELETYPE's paper — the console screen for half the guests. It is
        // not a VT52 (no screen snapshots exist for it), so without this a
        // restored teletype guest comes back alive but BLIND: the boot banner
        // and the prompt were printed on paper that nobody captured (measured:
        // BASIC-11 restored with an empty screen).
        var teletypepaper = null;
        if (typeof window !== "undefined" && window.g60printer &&
            typeof window.g60printer.snapshot === "function") {
            teletypepaper = window.g60printer.snapshot();
        }

        // Disk write-back overlay: the blocks that differ from the pristine
        // base image at export time. Restoring them rolls the disks back to
        // the same generation as the exported RAM, so the restored guest's
        // filesystem metadata stays consistent with the disk contents.
        // Mirror of capture() — if it grows there, it grows here.
        var overlayPromise = (typeof DiskStore !== "undefined" &&
            typeof DiskStore.captureOverlay === "function")
            ? DiskStore.captureOverlay() : Promise.resolve({});

        return overlayPromise.then(function (overlay) {
            return captureImageFingerprintsAsync().then(function (fps) {
                var manifest = {
                    schemaVersion: SCHEMA_VERSION,
                    base: null,
                    device: name || "live",
                    label: name || "live machine",
                    createdAt: new Date().toISOString(),
                    profile: captureConfig(),
                    imageFingerprints: fps,
                    cpu: captureCPU(),
                    devices: devices,
                    // The operator's view of the machine, not just its state:
                    // terminal screens, the paper in the teletype, the loaded
                    // reader tape (and its read position).
                    punchtape: punchtape,
                    readertape: readertape,
                    vt52: vt52,
                    teletypepaper: teletypepaper,
                    mounted: captureMounted(),
                    overlay: serializeOverlay(overlay),
                    page: capturePage(),
                    steps: null,
                    stepsMessage: null,
                };
                // The CPU was frozen for the capture (stop-the-world, above), so
                // the recorded runState is HALT. A state is a machine that was
                // RUNNING — recording HALT would make every restored guest sit
                // dead with a loaded memory (measured: BASIC-11 restored, runState
                // 3, nothing happened). Same correction capture() makes.
                if (wasRunning) manifest.cpu.runState = STATE_RUN;
                var packed = StateFormat.pack(manifest, CPU.memory);
                // Compress with what the BROWSER already has. fzstd is
                // decompress-only by design, and pulling a zstd compressor into
                // the page would cost ~1-2 MB of script for a button nobody
                // presses daily. CompressionStream is built in and free; the
                // container is unchanged — only the frame around it differs, and
                // both decompressors (fzstd for zstd, DecompressionStream for
                // gzip) are on the page already.
                return gzipCompress(packed).then(function (bytes) {
                    if (wasRunning) CPU.runState = prevRunState;
                    return bytes;
                }, function () {
                    if (wasRunning) CPU.runState = prevRunState;
                    return packed;   // no CompressionStream: uncompressed container
                });
            });
        });
    }

    // gzip a container with the browser's own compressor. Rejects when
    // CompressionStream is unavailable so the caller can fall back to the
    // uncompressed container (still a valid state).
    function gzipCompress(bytes) {
        if (typeof CompressionStream === "undefined") {
            return Promise.reject(new Error("no CompressionStream"));
        }
        var cs = new CompressionStream("gzip");
        var writer = cs.writable.getWriter();
        writer.write(bytes);
        writer.close();
        return new Response(cs.readable).arrayBuffer().then(function (buf) {
            return new Uint8Array(buf);
        });
    }

    // The inverse, for a state that arrives gzipped (the browser's own export,
    // and any state a visitor's browser produced).
    function gunzipBytes(bytes) {
        if (typeof DecompressionStream === "undefined") {
            return Promise.resolve(bytes);
        }
        var ds = new DecompressionStream("gzip");
        var writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        return new Response(ds.readable).arrayBuffer().then(function (buf) {
            return new Uint8Array(buf);
        });
    }

    // Fingerprints are read synchronously today; wrap for the export path so a
    // later async source does not change the signature.
    function captureImageFingerprintsAsync() {
        return Promise.resolve(captureImageFingerprints());
    }

    // ---- Overlay (write-back disk blocks) serialisation ------------------
    // The overlay is url -> { v, blocks: { blockNo: <bytes> } }. IndexedDB
    // stores the bytes as Uint8Array (structured clone), but a .state
    // container is JSON: JSON.stringify turns a Uint8Array into
    // {"0":..,"1":..} — a shape no reader expects, and one that
    // DiskStore.restoreOverlay used to read as an empty block, zeroing every
    // restored sector (the "disk fell off" after export/import). A state is
    // therefore written with plain ARRAYS of byte values and read back into
    // Uint8Array, so the format does not depend on how JSON stringifies a
    // typed array. DiskStore.restoreOverlay still normalises all three shapes
    // for OLD states written before this change.
    function serializeOverlay(overlay) {
        if (!overlay || typeof overlay !== "object") return null;
        var out = {};
        Object.keys(overlay).forEach(function (url) {
            var rec = overlay[url];
            if (!rec || typeof rec !== "object" ||
                !rec.blocks || typeof rec.blocks !== "object") {
                out[url] = rec;
                return;
            }
            var blocks = {};
            Object.keys(rec.blocks).forEach(function (b) {
                var v = rec.blocks[b];
                blocks[b] = (v instanceof Uint8Array) ? Array.from(v)
                    : Array.isArray(v) ? v.slice()
                    : (v && typeof v === "object") ? Object.values(v)
                    : v;
            });
            out[url] = Object.assign({}, rec, { blocks: blocks });
        });
        return out;
    }

    function deserializeOverlay(overlay) {
        if (!overlay || typeof overlay !== "object") return null;
        var out = {};
        Object.keys(overlay).forEach(function (url) {
            var rec = overlay[url];
            if (!rec || typeof rec !== "object" ||
                !rec.blocks || typeof rec.blocks !== "object") {
                out[url] = rec;
                return;
            }
            var blocks = {};
            Object.keys(rec.blocks).forEach(function (b) {
                var v = rec.blocks[b];
                blocks[b] = (v instanceof Uint8Array) ? new Uint8Array(v)
                    : Array.isArray(v) ? Uint8Array.from(v)
                    : (v && typeof v === "object") ? new Uint8Array(Object.values(v))
                    : new Uint8Array(0);
            });
            out[url] = Object.assign({}, rec, { blocks: blocks });
        });
        return out;
    }

    // ------------------------------------------------------------------
    // Export a stored snapshot (from IndexedDB) as .state container bytes.
    // Returns Promise<Uint8Array|null> — null when the id does not exist.
    // ------------------------------------------------------------------
    function exportSnapshot(id) {
        return dbGet(id).then(function (snap) {
            if (!snap) return null;
            // device = boot disk name from mounted images (e.g. "rp1").
            // Only set when we can derive it; otherwise omit so ?state=
            // does not try to pre-load a non-existent image.
            var deviceKey = deviceKeyFromMounted(snap.mounted);
            return decompressMemoryToWords(snap.memory).then(function (memoryWords) {
                var manifest = {
                    schemaVersion: SCHEMA_VERSION,
                    base: null,
                    label: snap.name,
                    // device is set only when we can derive it from mounted
                    // images; otherwise omitted to avoid wrong pre-load.
                    device: deviceKey,
                    createdAt: new Date(snap.createdAt).toISOString(),
                    profile: snap.config,
                    imageFingerprints: snap.imageFingerprints,
                    cpu: snap.cpu,
                    devices: snap.devices,
                    punchtape: snap.punchtape,
                    readertape: snap.readertape,
                    vt52: snap.vt52,
                    teletypepaper: snap.teletypepaper,
                    mounted: snap.mounted,
                    page: snap.page,
                    steps: snap.steps,
                    stepsMessage: snap.stepsMessage,
                    overlay: serializeOverlay(snap.overlay),
                };
                var packed = StateFormat.pack(manifest, memoryWords);
                return gzipCompress(packed).then(function (bytes) {
                    return bytes;
                }, function () {
                    return packed;   // uncompressed container fallback
                });
            });
        });
    }

    // Derive a device key from the mounted image URLs, so ?state= can
    // look up the correct disk image via OSBoot scenarios.
    // Takes the first mounted URL, strips directory/extension, e.g.
    // "rp1.dsk" → "rp1",  "media/rk0.dsk.zst" → "rk0".
    // Returns null when no mounted images or none look like a device key.
    function deviceKeyFromMounted(mounted) {
        if (!mounted || !Array.isArray(mounted) || !mounted.length) return null;
        var url = String(mounted[0]);
        // Strip directory, keep basename.
        var base = url.split("/").pop() || url;
        // Strip .dsk.zst, .dsk, .zst, .ptap etc.
        base = base.replace(/\.(dsk|ptap|tap|zst)?(\.zst)?$/i, "");
        return base.length > 0 ? base : null;
    }

    // ------------------------------------------------------------------
    // Create a shareable .state.zst from a stored snapshot, adding
    // human-readable description and an optional one-command handoff
    // scenario. The original snapshot is NOT modified and is NOT saved
    // to the snapshot store — the result is returned as bytes for download.
    // Returns Promise<Uint8Array|null> — null when the id does not exist.
    // ------------------------------------------------------------------
    function createShareableState(id, opts) {
        return dbGet(id).then(function (snap) {
            if (!snap) return null;
            var shareName = (opts && opts.title && opts.title.trim())
                ? opts.title.trim() : snap.name;
            var stepsMessage = (opts && opts.description || "").trim() || null;
            var buttonLabel = (opts && opts.buttonLabel || "").trim() || null;
            var screenshot = (opts && opts.screenshot || "").trim() || null;
            var steps = null;
            if (opts && opts.command && opts.command.trim()) {
                steps = [{ send: opts.command.trim() }];
            }
            // Derive the device key from the first mounted image URL, so
            // ?state= can pre-load the correct disk image via OSBoot scenarios.
            // Only set when we can derive it; otherwise omit so ?state=
            // does not try to pre-load a non-existent image.
            var deviceKey = deviceKeyFromMounted(snap.mounted);
            return decompressMemoryToWords(snap.memory).then(function (memoryWords) {
                var manifest = {
                    schemaVersion: SCHEMA_VERSION,
                    base: null,
                    device: deviceKey,
                    label: shareName,
                    createdAt: new Date().toISOString(),
                    profile: snap.config,
                    imageFingerprints: snap.imageFingerprints,
                    cpu: snap.cpu,
                    devices: snap.devices,
                    punchtape: snap.punchtape,
                    readertape: snap.readertape,
                    vt52: snap.vt52,
                    teletypepaper: snap.teletypepaper,
                    mounted: snap.mounted,
                    page: snap.page,
                    steps: steps,
                    stepsMessage: stepsMessage,
                    buttonLabel: buttonLabel,
                    screenshot: screenshot,
                    overlay: serializeOverlay(snap.overlay),
                };
                var packed = StateFormat.pack(manifest, memoryWords);
                return gzipCompress(packed).then(function (bytes) {
                    return bytes;
                }, function () {
                    return packed;
                });
            });
        });
    }

    // ------------------------------------------------------------------
    // Import a .state container bytes into the snapshot store.
    // Returns Promise<{ok:true, id, name}> or {ok:false, reason, detail?}.
    // ------------------------------------------------------------------
    function importState(bytes) {
        if (!bytes || bytes.byteLength > MAX_STATE_BYTES) {
            return Promise.resolve({ ok: false, reason: "too-large" });
        }
        var input = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
        return unpackContainer(input).then(function (parsed) {
            var manifest = parsed.manifest;
            if (!manifest || typeof manifest !== "object") {
                return { ok: false, reason: "invalid-manifest" };
            }
            if (!manifest.schemaVersion || manifest.schemaVersion > SCHEMA_VERSION) {
                return { ok: false, reason: "unsupported-version" };
            }
            // Compress memory for IndexedDB storage.
            var memBytes = StateFormat.memoryToBytes(parsed.memoryWords || new Uint16Array(0));
            return compressBytes(memBytes).then(function (mem) {
                var baseName = manifest.label || manifest.device || "Imported state";
                var snap = {
                    id: "snap-" + Date.now(),
                    name: baseName,
                    createdAt: Date.now(),
                    schemaVersion: SCHEMA_VERSION,
                    imageFingerprints: manifest.imageFingerprints || null,
                    cpu: manifest.cpu || {},
                    memory: mem,
                    mounted: manifest.mounted || [],
                    config: manifest.profile || null,
                    page: manifest.page || null,
                    devices: manifest.devices || null,
                    punchtape: manifest.punchtape || null,
                    readertape: manifest.readertape || null,
                    vt52: manifest.vt52 || null,
                    teletypepaper: manifest.teletypepaper || null,
                    overlay: deserializeOverlay(manifest.overlay),
                    steps: manifest.steps || null,
                    stepsMessage: manifest.stepsMessage || null,
                    cpuBytes: 0,
                    memBytes: mem.data.byteLength || 0,
                };
                // If a snapshot with the same name already exists, append a
                // number so repeated imports of the same file stay distinct:
                // "state", "state (1)", "state (2)", ...
                return dbGetAll().then(function (items) {
                    var used = {};
                    items.forEach(function (it) { used[it.name] = true; });
                    var name = baseName;
                    var n = 1;
                    while (used[name]) {
                        name = baseName + " (" + n + ")";
                        n++;
                    }
                    snap.name = name;
                    return dbPut(snap.id, snap).then(function () {
                        return { ok: true, id: snap.id, name: snap.name };
                    });
                });
            });
        }, function (err) {
            return { ok: false, reason: "not-a-state",
                     detail: String(err && err.message ? err.message : err) };
        });
    }

    // Decompress (zstd/gzip/bare) and unpack a .state container.
    // Returns Promise<{manifest, memoryWords}>.
    function unpackContainer(bytes) {
        var container = readStateContainer(new Uint8Array(bytes));
        if (container === null) return Promise.reject(new Error("not-a-state"));
        return Promise.resolve(container).then(function (raw) {
            var parsed = (typeof StateFormat !== "undefined" &&
                typeof StateFormat.unpack === "function")
                ? StateFormat.unpack(raw) : null;
            if (!parsed) throw new Error("not-a-state");
            return parsed;
        });
    }

    function load(id) {
        try {
            localStorage.setItem(PENDING_KEY, id);
            // A restore reload must NOT flush the write-back overlay on the
            // way out (see DiskStore's pagehide handler): the disk rolls
            // back to the snapshot's generation, and a late flush from the
            // old page would re-corrupt it. sessionStorage survives the
            // reload (and the config-mismatch second reload) and is cleared
            // once the restore completes in init().
            if (typeof sessionStorage !== "undefined") {
                sessionStorage.setItem("yapdp.restore-pending", "1");
                // Clear any stale ?state= pending URL from a previous deep-link
                // attempt — it would otherwise be handled by init() BEFORE the
                // snapshot, causing the wrong state to be applied (or a failure
                // dialog) while the snapshot sits ignored in localStorage.
                sessionStorage.removeItem(PENDING_STATE_KEY);
            }
        } catch (e) {
            return Promise.resolve(false);
        }
        // If the snapshot needs a different hardware configuration (device
        // set), apply it NOW so the single reload boots with the right
        // devices and init() can restore directly.
        return dbGet(id).then(function (snap) {
            if (configNeedsReload(snap)) {
                applySnapshotConfig(snap);
            }
            if (typeof location !== "undefined" && location.reload) {
                // applySnapshotConfig() just rewrote the persisted config
                // behind the Config form's back, so isConfigDirty() would
                // make the beforeunload guard ask "Reload site?" — suppress
                // it exactly like the quick-boot wizard does.
                if (typeof window !== "undefined") window.__allowConfigReload = true;
                location.reload();
                return true;
            }
            return false;
        });
    }

    /**
     * sameStructuralValue(a, b) — compare one structural config field.
     * Arrays (userTerminalTypes) compare element by element; everything else
     * compares by strict value. A snapshot saved before a field existed has it
     * undefined and is skipped by the caller.
     */
    function sameStructuralValue(a, b) {
        if (Array.isArray(a) || Array.isArray(b)) {
            if (!Array.isArray(a) || !Array.isArray(b)) return false;
            if (a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) return false;
            }
            return true;
        }
        return a === b;
    }

    // Does the snapshot's hardware config differ from the current machine's?
    // If so the device set (console type, LP11, terminals, VT11) is wrong and
    // the page must reload with the snapshot's config before restoring.
    function configNeedsReload(snap) {
        if (!snap || !snap.config || typeof Config === "undefined" ||
            typeof Config.get !== "function") return false;
        var cur = Config.get();
        for (var i = 0; i < STRUCTURAL_CONFIG.length; i++) {
            var k = STRUCTURAL_CONFIG[i];
            if (snap.config[k] === undefined) continue;
            // Scalar fields compare by value; userTerminalTypes is an array and
            // would otherwise compare by reference and always report "different".
            if (!sameStructuralValue(snap.config[k], cur[k])) return true;
        }
        return false;
    }

    // Apply the snapshot's structural config (device set) to the persisted
    // config. Only the STRUCTURAL_CONFIG fields are touched — the operator's
    // sound/behaviour preferences are never overridden by a snapshot.
    function applySnapshotConfig(snap) {
        var patch = {};
        STRUCTURAL_CONFIG.forEach(function (k) {
            if (snap.config[k] !== undefined) patch[k] = snap.config[k];
        });
        if (typeof Config !== "undefined" && typeof Config.set === "function") {
            Config.set(patch);
        }
    }

    // Pending-snapshot application at startup. Halts the CPU synchronously
    // (before the 80ms CPU start timer), then restores async. If the snapshot
    // was saved with a different hardware configuration, applies that config
    // first and reloads once more — the pending key stays set so the next
    // boot performs the actual restore with the correct device set.
    function init() {
        let pendingId = null;
        try {
            pendingId = localStorage.getItem(PENDING_KEY);
        } catch (e) { /* no localStorage */ }

        // Even without a pending snapshot, populate the UI list.
        refreshUI();

        // A deep link whose device set differed from the loaded one reloaded
        // the page with its URL parked here (see loadFromUrl). The device set
        // is now the state's own, so the link is fetched and applied again —
        // this time it lands. Checked BEFORE the snapshot id: a state link is
        // an explicit request, and it supersedes a snapshot left pending from
        // an earlier session.
        var pendingState = pendingStateUrl();
        if (pendingState) {
            clearPendingStateUrl();
            if (typeof CPU !== "undefined") CPU.runState = STATE_HALT;
            if (typeof window !== "undefined" &&
                typeof window.__yapdpApplyStateLink === "function") {
                window.__yapdpApplyStateLink(pendingState);
            } else if (typeof QuickBoot !== "undefined" &&
                       typeof QuickBoot.applyStateLinkNow === "function") {
                QuickBoot.applyStateLinkNow(pendingState);
            }
            return Promise.resolve(true);
        }

        if (!pendingId) {
            // No restore pending: drop any stale restore flag so the
            // write-back flush works normally on future reloads.
            if (typeof sessionStorage !== "undefined") {
                try { sessionStorage.removeItem("yapdp.restore-pending"); } catch (e) { /* ignore */ }
            }
            return Promise.resolve(false);
        }

        // Stop the machine before it executes anything.
        if (typeof CPU !== "undefined") {
            CPU.runState = STATE_HALT;
        }

        return dbGet(pendingId).then(function (snap) {
            if (!snap) return false;
            if (configNeedsReload(snap)) {
                applySnapshotConfig(snap);
                if (typeof location !== "undefined" && location.reload) {
                    // Same as in load(): the persisted config changed behind
                    // the Config form's back — suppress the beforeunload
                    // "Reload site?" prompt.
                    if (typeof window !== "undefined") window.__allowConfigReload = true;
                    location.reload();
                    return false;
                }
            }
            try {
                localStorage.removeItem(PENDING_KEY);
            } catch (e) { /* ignore */ }
            return restore(snap).then(function (ok) {
                // Restore done (machine resumes with the rolled-back disk);
                // re-enable the write-back flush for future reloads.
                if (typeof sessionStorage !== "undefined") {
                    try { sessionStorage.removeItem("yapdp.restore-pending"); } catch (e) { /* ignore */ }
                }
                if (ok && snap.steps && Array.isArray(snap.steps) && snap.steps.length > 0) {
                    StepEngine.runSteps(snap.steps, {
                        sendBytes: StepEngine.sendBytes,
                        outputContains: StepEngine.outputContains,
                        stepDelayMs: 800,
                    });
                }
                return ok;
            });
        });
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------
    // preferId — an explicit request for what stays selected after the
    // rebuild. The Save/Import flows pass the snapshot they just created:
    // it is not in the (stale) options yet, so select.value cannot carry it.
    // Without it, the caller's current selection is preserved.
    function refreshUI(preferId) {
        const select = document.getElementById("snap-select");
        if (!select) return;
        const loadBtn = document.getElementById("snap-load");
        const exportBtn = document.getElementById("snap-export");
        const shareBtn = document.getElementById("snap-share");
        const renameBtn = document.getElementById("snap-rename");
        const deleteBtn = document.getElementById("snap-delete");

        // Read the selection synchronously, before the async list() below.
        const keepId = preferId || select.value;

        list().then(function (items) {
            select.innerHTML = "";
            if (!items.length) {
                const opt = document.createElement("option");
                opt.value = "";
                opt.textContent = "--no snapshots--";
                select.appendChild(opt);
            } else {
                items.forEach(function (it) {
                    const opt = document.createElement("option");
                    opt.value = it.id;
                    // Keep the bare name for the rename dialog prefill —
                    // the visible label also carries the capture size.
                    opt.dataset.name = it.name;
                    var label = it.name + "  (" + fmtSize(it.memBytes) + ")";
                    if (it.hasSteps) {
                        label += "  \u21E8 " + (it.stepsMessage || it.steps.length + " steps");
                    }
                    opt.textContent = label;
                    select.appendChild(opt);
                });
            }
            // Restore the requested selection when it still exists; otherwise
            // fall back to the newest snapshot (list() is oldest-first).
            if (keepId && items.some(function (i) { return i.id === keepId; })) {
                select.value = keepId;
            } else if (items.length > 0) {
                select.selectedIndex = items.length - 1;
            }

            const hasSelection = !!select.value;
            select.disabled = items.length === 0;
            if (loadBtn) loadBtn.disabled = !hasSelection;
            if (exportBtn) exportBtn.disabled = !hasSelection;
            if (renameBtn) renameBtn.disabled = !hasSelection;
            if (shareBtn) shareBtn.disabled = !hasSelection;
            if (deleteBtn) deleteBtn.disabled = !hasSelection;

            const count = document.getElementById("snap-count");
            if (count) {
                count.textContent = items.length + " " + (items.length === 1 ? "snapshot" : "snapshots");
            }
        });
    }

    function fmtSize(n) {
        if (!n) return "0 B";
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        return (n / (1024 * 1024)).toFixed(1) + " MB";
    }

    // --- "Snapshot not restored" dialog -----------------------------------
    // A snapshot whose disk images changed under it is an explicit request that
    // cannot be met. It gets the same treatment as a failed image fetch: the
    // .modal-box.error shell from css/pdp11.css, one "Got it" to dismiss and
    // one action that leads somewhere useful. Built with createElement/
    // textContent, the way imgerror.js builds its overlay, so an image name —
    // which comes from a stored snapshot, not from a URL we validated — is
    // data, never markup.
    //
    // The optional third action deletes the incompatible snapshot. Offered,
    // never automatic: it is the user's work.
    var __snapIncompatModal = null;

    function incompatibleText(bad) {
        return bad.map(function (b) {
            var F = (typeof ImageFingerprint !== "undefined") ? ImageFingerprint : null;
            var detail = (F && typeof F.describe === "function")
                ? F.describe(b.then, b.now)
                : (String(b.then) + " vs " + String(b.now));
            return b.url + " (" + detail + ")";
        }).join(", ");
    }

    function showIncompatibleImageDialog(snap, bad) {
        if (typeof document === "undefined") return;
        // The SYSTEM raised this dialog (a refused restore), so nobody asked for
        // it and nobody can dismiss it while the autoload owns the input — the
        // gate swallows the click and the toast's way out sits underneath. Hand
        // the machine back first, exactly as the first-run hint does.
        // (Guarded: QuickBoot may be absent in a headless harness.)
        if (typeof QuickBoot !== "undefined" &&
            typeof QuickBoot.yieldToOperator === "function") {
            QuickBoot.yieldToOperator();
        }
        if (!__snapIncompatModal) {
            __snapIncompatModal = document.createElement("div");
            __snapIncompatModal.id = "snap-incompatible-overlay";
            __snapIncompatModal.className = "modal-overlay";
            __snapIncompatModal.addEventListener("click", function (e) {
                var action = e.target.getAttribute &&
                    e.target.getAttribute("data-snap-action");
                if (action === "remove") {
                    var id = __snapIncompatModal.getAttribute("data-snap-id");
                    hideIncompatibleImageDialog();
                    if (id) remove(id).then(function () { refreshUI(); });
                } else if (action === "close" || e.target === __snapIncompatModal ||
                        (e.target.closest && e.target.closest(".modal-close"))) {
                    hideIncompatibleImageDialog();
                }
            });
            document.body.appendChild(__snapIncompatModal);
        }

        var box = document.createElement("div");
        box.className = "modal-box error";

        var title = document.createElement("span");
        title.className = "modal-title";
        title.textContent = "Snapshot not restored";
        box.appendChild(title);

        var intro = document.createElement("p");
        intro.className = "modal-intro";
        intro.appendChild(document.createTextNode("The snapshot "));
        var name = document.createElement("code");
        name.textContent = String(snap.name || snap.id || "");
        intro.appendChild(name);
        intro.appendChild(document.createTextNode(
            " was taken on a different build of "));
        var img = document.createElement("code");
        img.textContent = incompatibleText(bad);
        intro.appendChild(img);
        intro.appendChild(document.createTextNode(
            ". The image has been updated since, so restoring would put the " +
            "saved memory on top of a disk it does not match — the guest would " +
            "see a corrupted file system. The machine was left as it is. " +
            "Delete the snapshot, or take a fresh one on this build."));
        box.appendChild(intro);

        var gotItBtn = document.createElement("button");
        gotItBtn.type = "button";
        gotItBtn.className = "modal-close";
        gotItBtn.setAttribute("data-snap-action", "close");
        gotItBtn.textContent = "Got it";
        box.appendChild(gotItBtn);

        var removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "modal-close";
        removeBtn.setAttribute("data-snap-action", "remove");
        removeBtn.textContent = "Delete this snapshot";
        box.appendChild(removeBtn);

        __snapIncompatModal.innerHTML = "";
        __snapIncompatModal.setAttribute("data-snap-id", String(snap.id || ""));
        __snapIncompatModal.appendChild(box);
        __snapIncompatModal.classList.add("visible");
    }

    function hideIncompatibleImageDialog() {
        if (__snapIncompatModal) {
            __snapIncompatModal.classList.remove("visible");
        }
    }

    // ---- Styled confirmation modal ----
    // Reuses the shared modal-overlay style (modal-* classes, css/pdp11.css)
    // so it matches the reboot confirmation and the config leave dialog
    // instead of a native window.confirm().
    var __snapModal = null;
    var __snapModalOnConfirm = null;
    var __snapPrevFocus = null;

    // Escape a string for insertion into the modal markup (innerHTML) — both
    // as text and as a quoted attribute value. Every user-supplied name that
    // reaches this markup must pass through here; the Share dialog used to
    // carry its own copy of this chain with the entity values dropped, which
    // made it a no-op and let a crafted snapshot name inject HTML.
    function escapeHtml(str) {
        // The entity texts are assembled from an ampersand constant; the
        // result is the same five-character escape the Prompt dialog writes
        // inline.
        var amp = "&";
        return String(str == null ? "" : str)
            .replace(/&/g, amp + "amp;").replace(/</g, amp + "lt;").replace(/>/g, amp + "gt;")
            .replace(/"/g, amp + "quot;").replace(/'/g, amp + "#39;");
    }

    // Hide the confirm/prompt overlay and return focus to the element that
    // opened it (e.g. the manager-modal Rename button), so keyboard input
    // keeps flowing inside the right dialog.
    function snapCloseModal() {
        if (!__snapModal) return;
        __snapModal.classList.remove("visible");
        __snapModalOnConfirm = null;
        var el = __snapPrevFocus;
        __snapPrevFocus = null;
        if (el && el.focus && el.isConnected && !el.disabled) {
            try { el.focus(); } catch (e) { /* ignore */ }
        }
    }

    function showConfirmModal(opts) {
        if (typeof document === "undefined") return;
        if (!__snapModal) {
            __snapModal = document.createElement("div");
            __snapModal.id = "snap-confirm-overlay";
            __snapModal.className = "modal-overlay";
            __snapModal.addEventListener("click", function (e) {
                var action = e.target.getAttribute && e.target.getAttribute("data-snap-action");
                if (action === "confirm") {
                    var cb = __snapModalOnConfirm;
                    snapCloseModal();
                    if (cb) cb();
                } else if (action === "cancel" || e.target === __snapModal) {
                    snapCloseModal();
                }
            });
            document.body.appendChild(__snapModal);
        }
        __snapPrevFocus = document.activeElement;
        __snapModal.innerHTML =
            '<div class="modal-box">' +
                '<span class="modal-title">' + opts.title + '</span>' +
                '<p class="modal-intro">' + opts.intro + '</p>' +
                '<button type="button" class="modal-close" data-snap-action="cancel">Cancel</button>' +
                '<button type="button" class="modal-close" data-snap-action="confirm">' + opts.confirmLabel + '</button>' +
            '</div>';
        __snapModalOnConfirm = opts.onConfirm;
        __snapModal.classList.add("visible");
    }

    // ---- Styled text-input modal (replaces native window.prompt) ----
    function showPromptModal(opts) {
        if (typeof document === "undefined") return;
        if (!__snapModal) {
            // Reuse the same overlay machinery as showConfirmModal.
            showConfirmModal({});
            __snapModalOnConfirm = null;
        }
        __snapPrevFocus = document.activeElement;
        var safeValue = String(opts.value == null ? "" : opts.value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        __snapModal.innerHTML =
            '<div class="modal-box">' +
                '<span class="modal-title">' + opts.title + '</span>' +
                '<p class="modal-intro">' + opts.intro + '</p>' +
                '<input type="text" class="modal-input" id="snap-prompt-input" ' +
                    'value="' + safeValue + '" maxlength="64" autocomplete="off" spellcheck="false">' +
                '<button type="button" class="modal-close" data-snap-action="cancel">Cancel</button>' +
                '<button type="button" class="modal-close" data-snap-action="confirm">' + opts.confirmLabel + '</button>' +
            '</div>';
        __snapModalOnConfirm = function () {
            var input = document.getElementById("snap-prompt-input");
            var value = input ? input.value : "";
            if (opts.onConfirm) opts.onConfirm(value);
        };
        __snapModal.classList.add("visible");
        var input = document.getElementById("snap-prompt-input");
        if (input) {
            input.focus();
            input.select();
            input.addEventListener("keydown", function (e) {
                if (e.key === "Enter") {
                    // preventDefault: without it, Chrome runs the keydown's
                    // default action against whichever element gains focus
                    // during the handler (the renamed snapshot's button),
                    // synthesising a second click that reopens this dialog.
                    e.preventDefault();
                    var btn = __snapModal.querySelector('[data-snap-action="confirm"]');
                    if (btn) btn.click();
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    var cancelBtn = __snapModal.querySelector('[data-snap-action="cancel"]');
                    if (cancelBtn) cancelBtn.click();
                }
            });
        }
    }

    // ---- Machine-state manager modal ----
    // The STATE floating button opens a dialog with Save + the snapshot list
    // (Load / Rename / Delete). Uses the shared modal-overlay style. The
    // element ids match the old Storage-page section, so refreshUI() works
    // unchanged against the controls inside this modal.
    var __snapManager = null;

    function ensureManagerModal() {
        if (__snapManager) return __snapManager;
        __snapManager = document.createElement("div");
        __snapManager.id = "snap-manager-overlay";
        __snapManager.className = "modal-overlay";
        // Focusable so the overlay itself can take focus (Escape handling)
        // when the select list is empty.
        __snapManager.tabIndex = -1;
        __snapManager.innerHTML =
            '<div class="modal-box">' +
                '<span class="modal-title">Machine state</span>' +
                '<p class="modal-intro">Save a snapshot of the full machine state, or restore a saved one. ' +
                    'Loading restarts the machine; restoring rolls the disks back to the saved state too.</p>' +
                '<button type="button" class="modal-close modal-primary" id="snap-save">Save state</button>' +
                '<select id="snap-select" class="modal-select" disabled>' +
                    '<option value="">--no snapshots--</option>' +
                '</select>' +
                '<div class="modal-actions">' +
                    '<button type="button" id="snap-load" class="modal-close" disabled>Load</button>' +
                    '<button type="button" id="snap-export" class="modal-close" disabled>Export</button>' +
                    '<button type="button" id="snap-share" class="modal-close" disabled>Share</button>' +
                    '<input type="file" id="snap-import-input" accept=".state.zst,.state" style="display:none">' +
                    '<button type="button" class="modal-close" id="snap-import">Import</button>' +            
                '</div>' +
                '<div class="modal-actions">' +
                    '<button type="button" id="snap-rename" class="modal-close" disabled>Rename</button>' +
                    '<button type="button" id="snap-delete" class="modal-close" disabled>Delete</button>' +
                    '<span id="snap-count" class="snap-count"></span>' +
                '</div>' +
                '<button type="button" class="modal-close" data-state-action="close">Close</button>' +
            '</div>';
        __snapManager.addEventListener("click", function (e) {
            var action = e.target.getAttribute && e.target.getAttribute("data-state-action");
            if (action === "close" || e.target === __snapManager) {
                __snapManager.classList.remove("visible");
            }
        });
        // Escape closes the manager (only fires while focus is inside this
        // modal — the rename input lives in a separate overlay).
        __snapManager.addEventListener("keydown", function (e) {
            if (e.key === "Escape") __snapManager.classList.remove("visible");
        });
        document.body.appendChild(__snapManager);
        return __snapManager;
    }

    function openManager() {
        ensureManagerModal();
        __snapManager.classList.add("visible");
        refreshUI();
        var select = document.getElementById("snap-select");
        // Focus the select when it has real options (it is enabled then);
        // otherwise focus the overlay itself so Escape still closes the
        // dialog. Both targets live inside the overlay, so the keydown
        // listener always fires.
        if (select && !select.disabled) select.focus();
        else __snapManager.focus();
    }

    // Wire the STATE floating button and the manager-modal controls.
    // Called on DOMContentLoaded.
    function wireUI() {
        const stateBtn = document.getElementById("state-btn");
        if (stateBtn) {
            stateBtn.addEventListener("click", openManager);
        }

        // The controls live inside the lazily-created manager modal; build it
        // first so the lookups below find the buttons to wire.
        ensureManagerModal();

        const saveBtn = document.getElementById("snap-save");
        const loadBtn = document.getElementById("snap-load");
        const exportBtn = document.getElementById("snap-export");
        const shareBtn = document.getElementById("snap-share");
        const renameBtn = document.getElementById("snap-rename");
        const deleteBtn = document.getElementById("snap-delete");
        const select = document.getElementById("snap-select");
        const importBtn = document.getElementById("snap-import");
        const importInput = document.getElementById("snap-import-input");

        if (saveBtn) {
            saveBtn.addEventListener("click", function () {
                saveBtn.disabled = true;
                save().then(function (snap) {
                    // Select the snapshot just saved: an explicit request,
                    // since the fresh entry is not in the stale options yet.
                    refreshUI(snap.id);
                    saveBtn.disabled = false;
                });
            });
        }
        if (loadBtn) {
            loadBtn.addEventListener("click", function () {
                if (!select || !select.value) return;
                showConfirmModal({
                    title: "Restore snapshot?",
                    intro: "The current machine state will be lost. The machine — including " +
                        "disk writes made after the snapshot — rolls back to the saved state. " +
                        "If the snapshot was saved with a different hardware configuration " +
                        "(console type, printer, terminals, VT11), it is applied automatically.",
                    confirmLabel: "Restore",
                    onConfirm: function () { load(select.value); }
                });
            });
        }
        if (exportBtn) {
            exportBtn.addEventListener("click", function () {
                if (!select || !select.value) return;
                exportBtn.disabled = true;
                exportSnapshot(select.value).then(function (bytes) {
                    exportBtn.disabled = false;
                    if (!bytes) return;
                    var opt = select.options[select.selectedIndex];
                    var name = sanitizeFilename(opt && opt.dataset ? (opt.dataset.name || "snapshot") : "snapshot")
                        + ".state.zst";
                    var blob = new Blob([bytes], { type: "application/octet-stream" });
                    var url = URL.createObjectURL(blob);
                    var a = document.createElement("a");
                    a.href = url;
                    a.download = name;
                    a.click();
                    URL.revokeObjectURL(url);
                });
            });
        }
        if (shareBtn) {
            shareBtn.addEventListener("click", function () {
                if (!select || !select.value) return;
                showShareDialog(select.value);
            });
        }
        if (renameBtn) {
            renameBtn.addEventListener("click", function () {
                if (!select || !select.value) return;
                var opt = select.options[select.selectedIndex];
                var currentName = opt ? (opt.dataset.name || opt.text) : "";
                showPromptModal({
                    title: "Rename snapshot",
                    intro: "Enter a new name for the snapshot.",
                    value: currentName,
                    confirmLabel: "Rename",
                    onConfirm: function (name) {
                        name = (name || "").trim();
                        if (!name || name === currentName) return;
                        rename(select.value, name).then(function () { refreshUI(); });
                    }
                });
            });
        }
        if (deleteBtn) {
            deleteBtn.addEventListener("click", function () {
                if (!select || !select.value) return;
                showConfirmModal({
                    title: "Delete snapshot?",
                    intro: "The snapshot will be permanently removed from the store.",
                    confirmLabel: "Delete",
                    onConfirm: function () { remove(select.value).then(function () { refreshUI(); }); }
                });
            });
        }
        if (importBtn && importInput) {
            importBtn.addEventListener("click", function () {
                importInput.click();
            });
            importInput.addEventListener("change", function () {
                var file = importInput.files[0];
                if (!file) return;
                importInput.value = "";   // reset so the same file can be re-imported
                file.arrayBuffer().then(function (buf) {
                    return importState(new Uint8Array(buf));
                }).then(function (result) {
                    if (result.ok) {
                        // Select the snapshot just imported.
                        refreshUI(result.id);
                    } else {
                        showImportError(result);
                    }
                });
            });
        }
    }

    // ---- Helpers for export/import UI ------------------------------------
    function sanitizeFilename(s) {
        return String(s || "snapshot")
            .replace(/[<>:"\/\\|?*]/g, "")
            .replace(/\s+/g, "-")
            .slice(0, 100)
            .toLowerCase();
    }

    function showImportError(result) {
        var msgs = {
            "not-a-state": "The file is not a valid .state file.",
            "too-large": "The file is too large (max 16 MB).",
            "unsupported-version": "Unsupported state format version.",
            "invalid-manifest": "The state manifest is invalid or missing.",
        };
        var msg = msgs[result.reason] || "An unknown error occurred (" + (result.reason || "unknown") + ").";
        if (typeof document === "undefined") return;
        if (!__snapModal) { showConfirmModal({}); __snapModalOnConfirm = null; }
        __snapPrevFocus = document.activeElement;
        __snapModal.innerHTML =
            '<div class="modal-box">' +
                '<span class="modal-title">Unable to import state</span>' +
                '<p class="modal-intro">' + msg + '</p>' +
                '<button type="button" class="modal-close" data-snap-action="cancel">Got it</button>' +
            '</div>';
        __snapModalOnConfirm = null;
        __snapModal.classList.add("visible");
    }

    // ---- Share dialog ----------------------------------------------------
    function showShareDialog(snapId) {
        if (typeof document === "undefined") return;
        // Fetch the snapshot to get its name for the preview.
        dbGet(snapId).then(function (snap) {
            if (!snap) return;
            var snapName = snap.name || "";
            if (!__snapModal) { showConfirmModal({}); __snapModalOnConfirm = null; }
            __snapPrevFocus = document.activeElement;
            var safeName = escapeHtml(snapName);
            __snapModal.innerHTML =
                '<div class="modal-box">' +
                    '<span class="modal-title">Share snapshot</span>' +
                    '<p class="modal-intro">Create a shareable machine state from <strong>' + safeName + '</strong>.' +
                        ' The original snapshot will not be changed.</p>' +
                    '<label class="modal-field">Title' +
                        '<input type="text" class="modal-input" id="share-title" value="' + safeName + '"' +
                        ' maxlength="64" autocomplete="off" spellcheck="false"></label>' +
                    '<label class="modal-field">Description' +
                        '<textarea class="modal-input" id="share-desc" rows="2" maxlength="256"' +
                        ' autocomplete="off" spellcheck="true"></textarea></label>' +
                    '<label class="modal-field">Button label' +
                        '<input type="text" class="modal-input" id="share-btn" maxlength="32"' +
                        ' autocomplete="off" spellcheck="false" placeholder="e.g. Got it"></label>' +
                    '<label class="modal-field">Screenshot' +
                        '<div class="share-screenshot-area" id="share-screenshot-area">' +
                        '<input type="file" id="share-screenshot-file" accept="image/png,image/jpeg,image/webp"' +
                        ' style="display:none">' +
                        '<span class="share-screenshot-placeholder" id="share-screenshot-placeholder">' +
                        'Paste or click to add a screenshot\u2026</span>' +
                        '<img class="share-screenshot-preview" id="share-screenshot-preview" style="display:none">' +
                        '<button type="button" class="share-screenshot-remove" id="share-screenshot-remove"' +
                        ' style="display:none">Remove</button>' +
                        '</div></label>' +
                    '<label class="modal-field">Run after restore' +
                        '<input type="text" class="modal-input" id="share-cmd" maxlength="128"' +
                        ' autocomplete="off" spellcheck="false" placeholder="e.g. RUN SPCINV"></label>' +
                    '<button type="button" class="modal-close" data-snap-action="cancel">Cancel</button>' +
                    '<button type="button" class="modal-close" id="share-create">Create Shareable State</button>' +
                '</div>';
            __snapModalOnConfirm = null;
            __snapModal.classList.add("visible");

            var titleInput = document.getElementById("share-title");
            var descInput = document.getElementById("share-desc");
            var btnInput = document.getElementById("share-btn");
            var cmdInput = document.getElementById("share-cmd");
            var screenshotData = null; // base64 data URL or null
            var screenshotArea = document.getElementById("share-screenshot-area");
            var screenshotFile = document.getElementById("share-screenshot-file");
            var screenshotPlaceholder = document.getElementById("share-screenshot-placeholder");
            var screenshotPreview = document.getElementById("share-screenshot-preview");
            var screenshotRemove = document.getElementById("share-screenshot-remove");

            function setScreenshot(dataUrl) {
                screenshotData = dataUrl;
                if (screenshotPlaceholder) screenshotPlaceholder.style.display = "none";
                if (screenshotPreview) {
                    screenshotPreview.src = dataUrl;
                    screenshotPreview.style.display = "block";
                }
                if (screenshotRemove) screenshotRemove.style.display = "inline-block";
            }

            function clearScreenshot() {
                screenshotData = null;
                if (screenshotPlaceholder) screenshotPlaceholder.style.display = "";
                if (screenshotPreview) { screenshotPreview.style.display = "none"; screenshotPreview.src = ""; }
                if (screenshotRemove) screenshotRemove.style.display = "none";
            }

            // Helper: load an image (from blob or file), resize to thumbnail,
            // and store as a PNG data URL in screenshotData.
            function loadScreenshot(blob) {
                var url = URL.createObjectURL(blob);
                var img = document.createElement("img");
                img.onload = function () {
                    URL.revokeObjectURL(url);
                    var maxW = 400;
                    var w = img.width;
                    var h = img.height;
                    if (w > maxW) { h = h * maxW / w; w = maxW; }
                    var c = document.createElement("canvas");
                    c.width = Math.ceil(w);
                    c.height = Math.ceil(h);
                    var ctx = c.getContext("2d");
                    if (ctx) {
                        ctx.drawImage(img, 0, 0, c.width, c.height);
                        setScreenshot(c.toDataURL("image/png"));
                    }
                };
                img.onerror = function () { URL.revokeObjectURL(url); };
                img.src = url;
            }

            // Paste handler: catch Ctrl+V on the screenshot area.
            if (screenshotArea) {
                screenshotArea.addEventListener("paste", function (e) {
                    var data = e.clipboardData;
                    if (!data || !data.items || !data.items.length) return;
                    for (var i = 0; i < data.items.length; i++) {
                        var item = data.items[i];
                        if (item.type && item.type.startsWith("image/")) {
                            e.preventDefault();
                            var blob = item.getAsBlob();
                            if (blob) { loadScreenshot(blob); }
                            break;
                        }
                    }
                });

                // Click to open file picker.
                screenshotArea.addEventListener("click", function () {
                    if (screenshotFile) screenshotFile.click();
                });

                if (screenshotFile) {
                    screenshotFile.addEventListener("change", function () {
                        var file = screenshotFile.files[0];
                        if (file) loadScreenshot(file);
                    });
                }

                if (screenshotRemove) {
                    screenshotRemove.addEventListener("click", function (e) {
                        e.stopPropagation();
                        clearScreenshot();
                    });
                }
            }

            // Create button handler.
            var createBtn = document.getElementById("share-create");
            if (createBtn) {
                createBtn.addEventListener("click", function () {
                    var title = (titleInput ? titleInput.value : "").trim();
                    var desc = (descInput ? descInput.value : "").trim();
                    var btn = (btnInput ? btnInput.value : "").trim();
                    var cmd = (cmdInput ? cmdInput.value : "").trim();
                    createBtn.disabled = true;
                    createShareableState(snapId, {
                        title: title,
                        description: desc,
                        buttonLabel: btn || null,
                        screenshot: screenshotData,
                        command: cmd,
                    }).then(function (bytes) {
                        createBtn.disabled = false;
                        snapCloseModal();
                        if (!bytes) return;
                        var name = sanitizeFilename(title || snapName) + ".state.zst";
                        var blob = new Blob([bytes], { type: "application/octet-stream" });
                        var url = URL.createObjectURL(blob);
                        var a = document.createElement("a");
                        a.href = url;
                        a.download = name;
                        a.click();
                        URL.revokeObjectURL(url);
                    });
                });
            }
        });
    }

    return {
        init: init,
        save: save,
        list: list,
        rename: rename,
        remove: remove,
        load: load,
        restore: restore,
        // The ?state= deep link: fetch a state and apply it to the live
        // machine. Never stored — it belongs to somebody else's link.
        loadFromUrl: loadFromUrl,
        applyStateBytes: applyStateBytes,
        // Take the live machine's state as container bytes (the Machine-state
        // Export button and tools/export-state-browser.js both use this).
        exportBytes: exportBytes,
        // Export a stored snapshot as .state container bytes.
        exportSnapshot: exportSnapshot,
        // Create a shareable .state.zst with description and optional command.
        createShareableState: createShareableState,
        // Import .state container bytes into the snapshot store.
        importState: importState,
        // What the last loaded state asked for (device, profile). Read by the
        // deep-link path to show the "preparing" toast for the right image.
        lastStateManifest: lastStateManifest,
        refreshUI: refreshUI,
        wireUI: wireUI,
        SCHEMA_VERSION: SCHEMA_VERSION,
        // Exposed for tests: the compatibility rule and its dialog, and the
        // HTML escaper the Share dialog applies to a snapshot name.
        incompatibleImages: incompatibleImages,
        showIncompatibleImageDialog: showIncompatibleImageDialog,
        hideIncompatibleImageDialog: hideIncompatibleImageDialog,
        escapeHtml: escapeHtml
    };
})();

// Startup: restore pending snapshot (if any) and wire UI after the DOM is
// ready. All scripts have already executed by DOMContentLoaded; the CPU
// start timer (80ms) fires after this, so halting in init() is safe.
if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", function () {
        SnapshotStore.init();
        SnapshotStore.wireUI();
    });
}
