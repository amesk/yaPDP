// DiskStore — persistent write-back cache for disk/tape images
// ================================================================
// Persists modified cache blocks to IndexedDB so that guest-OS writes
// (files created, disks re-partitioned, configs saved) survive a page
// reload. Only blocks actually written by the guest are stored — the
// base image is still fetched from the network on every launch and the
// saved dirty blocks are overlaid on top of it.
//
// Moved out of iopage.js verbatim (refactor): DiskStore is NOT a device
// — it is the write-back layer shared by every machine stack (legacy
// iopage.js and the headless browser-machine). Loaded BEFORE the
// machine layer in pdp11.html; tests import it directly.
//
// Design notes:
// - Device control blocks (rkControlBlock etc.) live inside per-device
//   IIFEs, so DiskStore keeps its own registry: url -> { controlBlock,
//   dirty:Set }. diskIO() reports writes via markDirty().
// - fetchBlock() consults DiskStore BEFORE the network/DataLoader path
//   so a saved block always wins over the pristine base image.
// - Every saved block is tagged with IMAGE_VERSION. When the bundled
//   media images change (new .zst), bump IMAGE_VERSION so stale saved
//   blocks are ignored instead of being overlaid onto a different disk.
// - IndexedDB is used only when available (browser, Tauri WebView).
//   In pure Node test contexts (no indexedDB) DiskStore degrades to a
//   no-op that keeps state in memory only.
//
// Public API:
//   markDirty(controlBlock, block) — record a written block
//   flushAll()                     — persist all dirty blocks to IDB
//   flush(url)                     — persist dirty blocks of one image
//   getBlock(url, block)           — saved block bytes or undefined
//   hasDirty(url)                  — true if image has unsaved writes
//   listDirty()                    — urls with saved/unsaved changes
//   clear(url)                     — discard saved blocks of one image
//   clearAll()                     — discard all saved blocks
//   init()                         — open IDB, load saved-block index
// ================================================================
var DiskStore = (() => {
    "use strict";

    const DB_NAME = "yapdp-diskstore";
    const DB_STORE = "blocks";
    // Bump this when bundled media/ images change (new .zst files).
    const IMAGE_VERSION = "0.1.0";

    let dbPromise = null;
    let db = null;

    // url -> { controlBlock, dirty:Set(block) } — writes not yet flushed
    const pending = new Map();
    // url -> Set(block) — blocks known to be saved in IDB (loaded at init)
    const savedIndex = new Map();

    let flushTimer = null;

    // --- IndexedDB plumbing (mirrors dragdrop.js) ---
    function openDB() {
        if (dbPromise) return dbPromise;
        if (typeof indexedDB === "undefined") {
            dbPromise = Promise.resolve(null);
            return dbPromise;
        }
        dbPromise = new Promise((resolve) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(DB_STORE)) {
                    req.result.createObjectStore(DB_STORE);
                }
            };
            req.onsuccess = () => { db = req.result; resolve(db); };
            req.onerror = () => { db = null; resolve(null); };
        });
        return dbPromise;
    }

    function dbPut(key, value) {
        return openDB().then((d) => {
            if (!d) return Promise.resolve();
            return new Promise((resolve) => {
                const tx = d.transaction(DB_STORE, "readwrite");
                tx.objectStore(DB_STORE).put(value, key);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        });
    }

    function dbGet(key) {
        return openDB().then((d) => {
            if (!d) return Promise.resolve(undefined);
            return new Promise((resolve) => {
                const tx = d.transaction(DB_STORE, "readonly");
                const req = tx.objectStore(DB_STORE).get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(undefined);
            });
        });
    }

    function dbDelete(key) {
        return openDB().then((d) => {
            if (!d) return Promise.resolve();
            return new Promise((resolve) => {
                const tx = d.transaction(DB_STORE, "readwrite");
                tx.objectStore(DB_STORE).delete(key);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        });
    }

    function dbGetAllKeys() {
        return openDB().then((d) => {
            if (!d) return Promise.resolve([]);
            return new Promise((resolve) => {
                const tx = d.transaction(DB_STORE, "readonly");
                const req = tx.objectStore(DB_STORE).getAllKeys();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            });
        });
    }

    // --- Key helpers ---
    // Each saved block is stored under "url::block"; a per-image record
    // under "url::meta" carries the image version for staleness checks.
    function blockKey(url, block) { return url + "::" + block; }
    function metaKey(url) { return url + "::meta"; }

    // --- Core operations ---

    // Record a written block. Called from diskIO() on every OP_WRITE;
    // the Set deduplicates so repeated writes to the same block are cheap.
    function markDirty(controlBlock, block) {
        const url = controlBlock.url;
        let entry = pending.get(url);
        if (!entry) {
            entry = { controlBlock, dirty: new Set() };
            pending.set(url, entry);
        }
        entry.dirty.add(block);
        ensureFlushTimer();
    }

    // Start a lazy periodic flush; also flush on page hide (best-effort).
    function ensureFlushTimer() {
        if (flushTimer) return;
        flushTimer = setInterval(() => { flushAll(); }, 30000);
        if (typeof window !== "undefined" && window.addEventListener) {
            window.addEventListener("pagehide", () => {
                // A snapshot restore reloads the page to roll RAM AND the
                // disk overlay back to the snapshot's generation. Flushing
                // here would race the restore: the old page's IDB writes
                // (newer generation) can land AFTER restoreOverlay() in the
                // new page and re-corrupt the disk. Skip the flush while a
                // restore is pending — the writes made after the snapshot
                // are meant to be discarded anyway.
                if (typeof sessionStorage !== "undefined") {
                    try {
                        if (sessionStorage.getItem("yapdp.restore-pending")) return;
                    } catch (e) { /* ignore */ }
                }
                flushAll();
            });
        }
    }

    // Serialize a cache block (Uint16Array of IO_BLOCKSIZE/2 words) to
    // the exact byte size of the on-disk block (IO_BLOCKSIZE bytes).
    function blockToBytes(u16) {
        const bytes = new Uint8Array(u16.length * 2);
        for (let i = 0; i < u16.length; i++) {
            bytes[i * 2] = u16[i] & 0xFF;
            bytes[i * 2 + 1] = (u16[i] >>> 8) & 0xFF;
        }
        return bytes;
    }

    // Persist all dirty blocks of one image. Resolves true when anything
    // was written (or the write was at least attempted), false when the
    // image has no dirty blocks.
    function flush(url) {
        const entry = pending.get(url);
        if (!entry || entry.dirty.size === 0) return Promise.resolve(false);
        const { controlBlock, dirty } = entry;

        const writes = [];
        dirty.forEach((block) => {
            const cacheBlock = controlBlock.cache[block];
            if (cacheBlock !== undefined) {
                const payload = {
                    v: IMAGE_VERSION,
                    b: blockToBytes(cacheBlock).buffer,
                    t: Date.now()
                };
                writes.push(dbPut(blockKey(url, block), payload));
                let set = savedIndex.get(url);
                if (!set) { set = new Set(); savedIndex.set(url, set); }
                set.add(block);
            }
        });
        dirty.clear();

        writes.push(dbPut(metaKey(url), {
            v: IMAGE_VERSION,
            t: Date.now(),
            blocks: Array.from(savedIndex.get(url) || [])
        }));

        return Promise.all(writes).then(() => true);
    }

    // Persist all images with pending writes.
    function flushAll() {
        const urls = Array.from(pending.keys());
        return Promise.all(urls.map(flush)).then(() => {});
    }

    // Return the saved bytes of a block (Uint8Array) or undefined when
    // nothing is saved, the image version changed, or IDB is unavailable.
    function getBlock(url, block) {
        return dbGet(blockKey(url, block)).then((payload) => {
            if (!payload || payload.v !== IMAGE_VERSION) return undefined;
            return new Uint8Array(payload.b);
        });
    }

    function hasDirty(url) {
        const entry = pending.get(url);
        return !!(entry && entry.dirty.size > 0);
    }

    // Urls that have saved changes (either pending in memory or in IDB).
    function listDirty() {
        const urls = new Set();
        pending.forEach((entry, url) => {
            if (entry.dirty.size > 0) urls.add(url);
        });
        savedIndex.forEach((set, url) => {
            if (set.size > 0) urls.add(url);
        });
        return Array.from(urls).sort();
    }

    function dirtyBlockCount(url) {
        const saved = savedIndex.get(url);
        return saved ? saved.size : 0;
    }

    // Discard saved changes for one image (both IDB and in-memory index).
    function clear(url) {
        const entry = pending.get(url);
        if (entry) entry.dirty.clear();
        savedIndex.delete(url);
        return openDB().then((d) => {
            if (!d) return;
            return dbGetAllKeys().then((keys) => {
                const tx = d.transaction(DB_STORE, "readwrite");
                keys.forEach((key) => {
                    if (key === url || String(key).indexOf(url + "::") === 0) {
                        tx.objectStore(DB_STORE).delete(key);
                    }
                });
                return new Promise((resolve) => {
                    tx.oncomplete = resolve;
                    tx.onerror = resolve;
                });
            });
        });
    }

    function clearAll() {
        pending.forEach((entry) => entry.dirty.clear());
        savedIndex.clear();
        return openDB().then((d) => {
            if (!d) return;
            return new Promise((resolve) => {
                const tx = d.transaction(DB_STORE, "readwrite");
                tx.objectStore(DB_STORE).clear();
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        });
    }

    // Open IDB and rebuild the in-memory index of saved blocks. Safe to
    // call repeatedly; resolves when the index is ready.
    function init() {
        return openDB().then((d) => {
            if (!d) return;
            return dbGetAllKeys().then((keys) => {
                keys.forEach((key) => {
                    const sep = key.indexOf("::");
                    if (sep === -1) return;
                    const url = key.slice(0, sep);
                    const rest = key.slice(sep + 2);
                    if (rest === "meta") return;
                    const block = parseInt(rest, 10);
                    if (isNaN(block)) return;
                    let set = savedIndex.get(url);
                    if (!set) { set = new Set(); savedIndex.set(url, set); }
                    set.add(block);
                });
            });
        });
    }

    // --- Snapshot support: disk overlay capture/rollback ---
    // A machine snapshot freezes CPU+RAM at time T; for the restored guest
    // to see a CONSISTENT filesystem, the disk overlay must also go back to
    // T. Otherwise the kernel's in-RAM superblock (T) gets written over
    // newer disk data (T+delta) -> "bad free count" / "file system full".
    // captureOverlay() records every block that differs from the pristine
    // base image (latest bytes from the device cache, falling back to the
    // saved IDB copy); restoreOverlay() replaces the live overlay with a
    // captured one, discarding writes made after the snapshot.

    // Capture the full write-back overlay of every image with changes.
    async function captureOverlay() {
        const urls = new Set();
        pending.forEach((entry, url) => { if (entry.dirty.size > 0) urls.add(url); });
        savedIndex.forEach((set, url) => { if (set.size > 0) urls.add(url); });
        const out = {};
        for (const url of urls) {
            const entry = pending.get(url);
            const cb = entry ? entry.controlBlock : null;
            const wanted = new Set(savedIndex.get(url) || []);
            if (entry) entry.dirty.forEach((b) => wanted.add(b));
            const blocks = {};
            for (const b of wanted) {
                let bytes = null;
                if (cb && cb.cache && cb.cache[b] !== undefined) {
                    bytes = blockToBytes(cb.cache[b]);
                } else {
                    bytes = await getBlock(url, b); // undefined when stale
                }
                if (bytes !== undefined && bytes !== null) {
                    blocks[b] = bytes;
                }
            }
            if (Object.keys(blocks).length > 0) {
                out[url] = { v: IMAGE_VERSION, blocks };
            }
        }
        return out;
    }

    // Roll the disk overlay back to a captured snapshot's generation:
    // discard every block saved since the snapshot and write the snapshot's
    // own blocks instead. Live device caches are invalidated so the next
    // read re-fetches the restored bytes. Never rejects — a failing overlay
    // restore must not leave the machine half-restored.
    async function restoreOverlay(overlay) {
        if (!overlay || typeof overlay !== "object") return;
        for (const url of Object.keys(overlay)) {
            try {
                const rec = overlay[url];
                if (!rec || typeof rec.blocks !== "object") continue;
                // The bundled media images changed since the snapshot: its
                // blocks belong to a different disk. Ignore the overlay.
                if (rec.v !== IMAGE_VERSION) continue;
                const entry = pending.get(url);
                const cb = entry ? entry.controlBlock : null;
                await clear(url);
                if (cb && cb.cache) cb.cache.length = 0;
                const writes = [];
                const set = new Set();
                for (const b of Object.keys(rec.blocks)) {
                    const block = parseInt(b, 10);
                    if (!isFinite(block)) continue;
                    const bytes = new Uint8Array(rec.blocks[b]); // copy
                    writes.push(dbPut(blockKey(url, block), {
                        v: IMAGE_VERSION, b: bytes.buffer, t: Date.now()
                    }));
                    set.add(block);
                }
                writes.push(dbPut(metaKey(url), {
                    v: IMAGE_VERSION, t: Date.now(), blocks: Array.from(set)
                }));
                await Promise.all(writes);
                savedIndex.set(url, set);
            } catch (err) {
                console.warn("DiskStore.restoreOverlay: failed for " + url, err);
            }
        }
    }

    return {
        markDirty,
        flush,
        flushAll,
        getBlock,
        captureOverlay,
        restoreOverlay,
        hasDirty,
        listDirty,
        dirtyBlockCount,
        clear,
        clearAll,
        init,
        IMAGE_VERSION
    };
})();

// Node export for tests (browser: plain global, loaded before iopage.js).
if (typeof module !== "undefined" && module.exports) {
    module.exports = DiskStore;
}
