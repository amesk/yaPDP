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
                            memBytes: v.memBytes || 0
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
    // Serialize the CPU object: numbers/strings as-is, typed arrays as
    // plain arrays. CPU.memory is handled separately (raw bytes + gzip).
    function captureCPU() {
        const out = {};
        Object.keys(CPU).forEach(function (k) {
            if (k === "memory") return; // handled separately
            const v = CPU[k];
            if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
                out[k] = v;
            } else if (v instanceof Uint16Array) {
                out[k] = { t: "u16", d: Array.from(v) };
            } else if (v instanceof Uint32Array) {
                out[k] = { t: "u32", d: Array.from(v) };
            }
            // functions / other objects are runtime-only, not persisted
        });
        return out;
    }

    // RAM -> gzip bytes. Uses native CompressionStream when available,
    // otherwise stores raw bytes (still works, just bigger).
    function captureMemory() {
        const words = CPU.memory;
        const bytes = new Uint8Array(words.length * 2);
        for (let i = 0; i < words.length; i++) {
            bytes[i * 2] = words[i] & 0xff;
            bytes[i * 2 + 1] = words[i] >>> 8;
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
    var STRUCTURAL_CONFIG = ["consoleType", "userTerminals", "printer", "vt11"];

    function captureConfig() {
        if (typeof Config === "undefined" || typeof Config.get !== "function") return null;
        var c = Config.get();
        var out = {};
        STRUCTURAL_CONFIG.forEach(function (k) {
            out[k] = c[k];
        });
        return out;
    }

    function capture(name) {
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
                    imageVersion: (typeof DiskStore !== "undefined" && DiskStore.IMAGE_VERSION)
                        ? DiskStore.IMAGE_VERSION : "unknown",
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
        Object.keys(cpu || {}).forEach(function (k) {
            if (k === "runState") return; // applied after restoreMemory (see restore())
            const v = cpu[k];
            if (v && typeof v === "object" && v.t === "u16") {
                const arr = new Uint16Array(v.d);
                if (CPU[k] instanceof Uint16Array && CPU[k].length === arr.length) {
                    CPU[k].set(arr);
                } else {
                    CPU[k] = arr;
                }
            } else if (v && typeof v === "object" && v.t === "u32") {
                const arr = new Uint32Array(v.d);
                if (CPU[k] instanceof Uint32Array && CPU[k].length === arr.length) {
                    CPU[k].set(arr);
                } else {
                    CPU[k] = arr;
                }
            } else {
                CPU[k] = v;
            }
        });
    }

    function restoreMemory(mem) {
        if (!mem) return Promise.resolve();
        let p;
        if (mem.format === "gzip" && typeof DecompressionStream !== "undefined") {
            const ds = new DecompressionStream("gzip");
            const writer = ds.writable.getWriter();
            writer.write(new Uint8Array(mem.data));
            writer.close();
            p = new Response(ds.readable).arrayBuffer();
        } else {
            p = Promise.resolve(mem.data);
        }
        return p.then(function (buf) {
            const bytes = new Uint8Array(buf);
            const words = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 1);
            if (CPU.memory.length === words.length) {
                CPU.memory.set(words);
            } else {
                CPU.memory = words;
            }
        });
    }

    // Apply a snapshot to the live machine. Caller must have halted the
    // CPU first (or the CPU start timer must not have fired yet).
    function restore(snap) {
        if (!snap) return Promise.resolve(false);
        restoreCPU(snap.cpu);
        return restoreMemory(snap.memory).then(function () {
            // Device registers (L2) — restore after RAM so devices see
            // consistent memory; control blocks re-create lazily on I/O.
            if (snap.devices && typeof iopage !== "undefined" &&
                typeof iopage.restoreDevices === "function") {
                iopage.restoreDevices(snap.devices);
            }
            // Disk write-back overlay: roll the disks back to the snapshot's
            // generation BEFORE the CPU resumes, so the restored guest's
            // filesystem metadata (captured in RAM) and the disk contents
            // agree. The CPU is still halted here — runState is applied only
            // after the overlay is in place, so no instruction can run
            // against a mixed-generation disk.
            var overlayPromise = Promise.resolve();
            if (snap.overlay && typeof DiskStore !== "undefined" &&
                typeof DiskStore.restoreOverlay === "function") {
                overlayPromise = DiskStore.restoreOverlay(snap.overlay);
            }
            return overlayPromise.then(function () {
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
    function save(name) {
        return capture(name).then(function (snap) {
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

    // Does the snapshot's hardware config differ from the current machine's?
    // If so the device set (console type, LP11, terminals, VT11) is wrong and
    // the page must reload with the snapshot's config before restoring.
    function configNeedsReload(snap) {
        if (!snap || !snap.config || typeof Config === "undefined" ||
            typeof Config.get !== "function") return false;
        var cur = Config.get();
        for (var i = 0; i < STRUCTURAL_CONFIG.length; i++) {
            var k = STRUCTURAL_CONFIG[i];
            if (snap.config[k] !== undefined && snap.config[k] !== cur[k]) return true;
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
                return ok;
            });
        });
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------
    function refreshUI() {
        const select = document.getElementById("snap-select");
        if (!select) return;
        const loadBtn = document.getElementById("snap-load");
        const renameBtn = document.getElementById("snap-rename");
        const deleteBtn = document.getElementById("snap-delete");

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
                    const d = new Date(it.createdAt);
                    opt.textContent = it.name + "  (" + fmtSize(it.memBytes) + ")";
                    select.appendChild(opt);
                });
            }
            select.disabled = items.length === 0;
            if (loadBtn) loadBtn.disabled = items.length === 0;
            if (renameBtn) renameBtn.disabled = items.length === 0;
            if (deleteBtn) deleteBtn.disabled = items.length === 0;

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

    // ---- Styled confirmation modal ----
    // Reuses the shared modal-overlay style (modal-* classes, css/pdp11.css)
    // so it matches the reboot confirmation and the config leave dialog
    // instead of a native window.confirm().
    var __snapModal = null;
    var __snapModalOnConfirm = null;
    var __snapPrevFocus = null;

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
        const renameBtn = document.getElementById("snap-rename");
        const deleteBtn = document.getElementById("snap-delete");
        const select = document.getElementById("snap-select");

        if (saveBtn) {
            saveBtn.addEventListener("click", function () {
                saveBtn.disabled = true;
                save().then(function (snap) {
                    if (select) select.value = snap.id;
                    refreshUI();
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
                        rename(select.value, name).then(refreshUI);
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
                    onConfirm: function () { remove(select.value).then(refreshUI); }
                });
            });
        }
    }

    return {
        init: init,
        save: save,
        list: list,
        rename: rename,
        remove: remove,
        load: load,
        restore: restore,
        refreshUI: refreshUI,
        wireUI: wireUI,
        SCHEMA_VERSION: SCHEMA_VERSION
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
