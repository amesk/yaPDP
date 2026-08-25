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

    function capture(name) {
        return captureMemory().then(function (mem) {
            return {
                id: "snap-" + Date.now(),
                name: name || defaultName(),
                createdAt: Date.now(),
                schemaVersion: SCHEMA_VERSION,
                imageVersion: (typeof DiskStore !== "undefined" && DiskStore.IMAGE_VERSION)
                    ? DiskStore.IMAGE_VERSION : "unknown",
                cpu: captureCPU(),
                memory: mem,
                mounted: captureMounted(),
                cpuBytes: 0,
                memBytes: mem.data.byteLength || 0
            };
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
            // Mounted images: DataLoader entries are re-created by
            // dragdrop.init() from the images IDB on startup; nothing to
            // do here (URLs are recorded in the snapshot for the UI).
            if (typeof window !== "undefined" && window.__snapshotRestored) {
                window.__snapshotRestored(snap);
            }
            return true;
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
        } catch (e) {
            return Promise.resolve(false);
        }
        if (typeof location !== "undefined" && location.reload) {
            location.reload();
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }

    // Pending-snapshot application at startup. Halts the CPU synchronously
    // (before the 80ms CPU start timer), then restores async.
    function init() {
        let pendingId = null;
        try {
            pendingId = localStorage.getItem(PENDING_KEY);
        } catch (e) { /* no localStorage */ }

        // Even without a pending snapshot, populate the UI list.
        refreshUI();

        if (!pendingId) return Promise.resolve(false);
        try {
            localStorage.removeItem(PENDING_KEY);
        } catch (e) { /* ignore */ }

        // Stop the machine before it executes anything.
        if (typeof CPU !== "undefined") {
            CPU.runState = STATE_HALT;
        }

        return dbGet(pendingId).then(function (snap) {
            if (!snap) return false;
            return restore(snap);
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

    // Wire the Storage-page controls. Called on DOMContentLoaded.
    function wireUI() {
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
                if (!window.confirm("Restore this snapshot?\n\nThe current machine state will be lost (disks keep their saved changes).")) return;
                load(select.value);
            });
        }
        if (renameBtn) {
            renameBtn.addEventListener("click", function () {
                if (!select || !select.value) return;
                const name = window.prompt("Snapshot name:", "");
                if (!name) return;
                rename(select.value, name).then(refreshUI);
            });
        }
        if (deleteBtn) {
            deleteBtn.addEventListener("click", function () {
                if (!select || !select.value) return;
                if (!window.confirm("Delete this snapshot?")) return;
                remove(select.value).then(refreshUI);
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
