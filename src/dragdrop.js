/**
 * yaPDP — Disk/Tape Image Drag & Drop Import
 *
 * Lets the user drop (or pick) disk/tape/paper-tape images directly onto
 * the page. Images are mounted into DataLoader (defined in iopage.js) so
 * fetchBlock() serves them from memory instead of over HTTP — this works
 * identically in the browser AND the Tauri desktop WebView.
 *
 * Supported input:
 *   - Raw images:          *.dsk, *.tap, *.ptap
 *   - ZST-compressed:      *.dsk.zst, *.tap.zst, *.ptap.zst
 *
 * The image is mounted under its canonical device URL name
 * (e.g. "RP1.DSK.ZST" -> "rp1.dsk") so the guest OS can `boot rp1`.
 *
 * Persistence:
 *   Successfully mounted images are stored in IndexedDB and re-mounted
 *   automatically on the next launch, so they remain available offline
 *   without re-dropping.
 *
 * Must be loaded AFTER iopage.js (defines DataLoader) and fzstd.js.
 */
"use strict";

(function () {
    // Images the user has mounted this session (via drag & drop or restored
    // from IndexedDB), keyed by canonical URL. Bundled desktop images are NOT
    // tracked here, so the "Mounted images" counter reflects user images only.
    var userImages = {};

    function plural(n) {
        return n === 1 ? "image" : "images";
    }

    // ------------------------------------------------------------------
    // IndexedDB persistence
    // ------------------------------------------------------------------
    var DB_NAME = "yapdp-images";
    var DB_STORE = "images";
    var dbPromise = null;

    function openDB() {
        if (dbPromise) return dbPromise;
        if (typeof indexedDB === "undefined") {
            dbPromise = Promise.resolve(null);
            return dbPromise;
        }
        dbPromise = new Promise(function (resolve) {
            var req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = function () {
                if (!req.result.objectStoreNames.contains(DB_STORE)) {
                    req.result.createObjectStore(DB_STORE);
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { resolve(null); };
        });
        return dbPromise;
    }

    function dbPut(key, buffer) {
        return openDB().then(function (db) {
            if (!db) return Promise.resolve();
            return new Promise(function (resolve) {
                var tx = db.transaction(DB_STORE, "readwrite");
                tx.objectStore(DB_STORE).put(buffer, key);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        });
    }

    function dbGetAll() {
        return openDB().then(function (db) {
            if (!db) return [];
            return new Promise(function (resolve) {
                var tx = db.transaction(DB_STORE, "readonly");
                var req = tx.objectStore(DB_STORE).getAllKeys();
                req.onsuccess = function () {
                    var keys = req.result || [];
                    var items = [];
                    var pending = keys.length;
                    if (!pending) { resolve(items); return; }
                    keys.forEach(function (key) {
                        var getReq = tx.objectStore(DB_STORE).get(key);
                        getReq.onsuccess = function () {
                            items.push({ key: key, bytes: new Uint8Array(getReq.result) });
                            if (--pending === 0) resolve(items);
                        };
                        getReq.onerror = function () {
                            if (--pending === 0) resolve(items);
                        };
                    });
                };
                req.onerror = function () { resolve([]); };
            });
        });
    }

    function dbDelete(key) {
        return openDB().then(function (db) {
            if (!db) return Promise.resolve();
            return new Promise(function (resolve) {
                var tx = db.transaction(DB_STORE, "readwrite");
                tx.objectStore(DB_STORE).delete(key);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        });
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function canonicalName(fileName) {
        var name = String(fileName || "").toLowerCase();
        if (name.endsWith(".zst")) name = name.slice(0, -4); // rp1.dsk.zst -> rp1.dsk
        return name;
    }

    function decompressZst(bytes) {
        if (typeof fzstd === "undefined" || typeof fzstd.decompress !== "function") {
            return null;
        }
        try {
            return fzstd.decompress(bytes);
        } catch (err) {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // File processing
    // ------------------------------------------------------------------
    function processFiles(files) {
        var list = Array.prototype.slice.call(files || []);
        if (!list.length) return;

        var done = 0;

        function finish() {
            if (done !== list.length) return;
            refreshMountedList();
        }

        list.forEach(function (file) {
            file.arrayBuffer().then(function (buffer) {
                var bytes = new Uint8Array(buffer);
                var url = canonicalName(file.name);
                var isZst = /\.zst$/i.test(file.name);

                if (isZst) {
                    var raw = decompressZst(bytes);
                    if (raw === null) {
                        if (++done === list.length) finish();
                        return;
                    }
                    DataLoader.mount(url, raw);
                    // Store the decompressed bytes (as an exact-size buffer copy)
                    // so the image stays available offline on the next launch.
                    dbPut(url, raw.slice().buffer);
                } else {
                    DataLoader.mount(url, bytes);
                    dbPut(url, buffer);
                }
                userImages[url] = true;
                // A freshly dropped image replaces whatever was on disk:
                // discard any previously saved write-back blocks so stale
                // guest writes cannot overlay the new image.
                if (typeof DiskStore !== "undefined" && DiskStore.clear) {
                    DiskStore.clear(url);
                }
                if (++done === list.length) finish();
            }).catch(function () {
                if (++done === list.length) finish();
            });
        });
    }

    // ------------------------------------------------------------------
    // Mounted-image management (unmount UI)
    // ------------------------------------------------------------------
    function refreshMountedList() {
        var select = document.getElementById("mounted-select");
        if (!select) return;
        var remove = document.getElementById("mounted-remove");

        var urls = DataLoader.list().sort();
        select.innerHTML = "";
        if (!urls.length) {
            var emptyOpt = document.createElement("option");
            emptyOpt.value = "";
            emptyOpt.textContent = "--mounted images--";
            select.appendChild(emptyOpt);
        } else {
            urls.forEach(function (url) {
                var opt = document.createElement("option");
                opt.value = url;
                opt.textContent = url;
                select.appendChild(opt);
            });
        }
        select.disabled = urls.length === 0;
        if (remove) remove.disabled = urls.length === 0;

        // Show how many user-mounted images there are next to the Unmount
        // button (drag & drop + IndexedDB restores only, not bundled desktop
        // images), mirroring the "EXPORT PAPER TAPE" size indicator style.
        var count = document.getElementById("mounted-count");
        if (count) {
            var n = Object.keys(userImages).length;
            count.textContent = n + " " + plural(n);
        }

        // Keep the "Paper tape reader file" list in sync so a .ptap image
        // imported via drag & drop (or restored from IndexedDB) can be chosen
        // as the tape read by the PTR11 reader.
        refreshPtrList();
    }

    // Rebuild the dynamic (dropped) part of the "Paper tape reader file"
    // select (#ptr). Static HTML options are preserved; options added here
    // are tagged with data-drop="1" and re-created on every refresh.
    // Duplicates against the static base names are skipped.
    function refreshPtrList() {
        var select = document.getElementById("ptr");
        if (!select) return;

        // Remove previously added dynamic options and collect the base names
        // (lower-cased, without the ".ptap" suffix) already offered statically.
        var existing = {};
        // Copy the live HTMLOptionsCollection first so removing dynamic
        // options during iteration does not shift indices and skip entries.
        Array.prototype.slice.call(select.options).forEach(function (opt) {
            if (opt.getAttribute("data-drop") === "1") {
                select.removeChild(opt);
            } else {
                var base = String(opt.value || "").toLowerCase();
                if (base.endsWith(".ptap")) base = base.slice(0, -5);
                existing[base] = true;
            }
        });

        DataLoader.list().forEach(function (url) {
            var base = String(url).toLowerCase();
            if (!base.endsWith(".ptap")) return;
            base = base.slice(0, -5);
            if (existing[base]) return;
            existing[base] = true;
            var opt = document.createElement("option");
            opt.value = url; // full url so PTR11 resolves it as-is
            opt.textContent = url;
            opt.setAttribute("data-drop", "1");
            select.appendChild(opt);
        });
    }

    function removeMounted(url) {
        if (!url) return;
        DataLoader.unmount(url);
        dbDelete(url);
        delete userImages[url];
        refreshMountedList();
    }

    // ------------------------------------------------------------------
    // Persistent disk changes UI (write-back cache)
    // ------------------------------------------------------------------
    // Populates the "Persistent disk changes" select in the Storage page
    // with images that have saved (or unsaved) guest writes, and keeps the
    // block-count label in sync.
    function refreshPersistList() {
        var select = document.getElementById("persist-select");
        if (!select) return;
        var count = document.getElementById("persist-count");
        if (typeof DiskStore === "undefined") {
            select.innerHTML = "";
            if (count) count.textContent = "";
            return;
        }
        var urls = DiskStore.listDirty();
        select.innerHTML = "";
        if (!urls.length) {
            var emptyOpt = document.createElement("option");
            emptyOpt.value = "";
            emptyOpt.textContent = "--no saved changes--";
            select.appendChild(emptyOpt);
        } else {
            urls.forEach(function (url) {
                var opt = document.createElement("option");
                opt.value = url;
                var n = DiskStore.dirtyBlockCount(url);
                opt.textContent = url + " (" + n + " blocks)";
                select.appendChild(opt);
            });
        }
        select.disabled = urls.length === 0;
        if (count) count.textContent = urls.length + " image(s) with changes";
    }

    // ------------------------------------------------------------------
    // UI wiring
    // ------------------------------------------------------------------
    function init() {
        var zone = document.getElementById("drop-zone");
        var overlay = document.getElementById("drop-overlay");
        var input = document.getElementById("drop-file-input");

        // Re-mount images persisted from a previous session.
        dbGetAll().then(function (items) {
            items.forEach(function (item) {
                DataLoader.mount(item.key, item.bytes);
                userImages[item.key] = true;
            });
            refreshMountedList();
        });

        // Load the write-back index of saved disk changes and wire up the
        // persistence controls in the Storage page.
        if (typeof DiskStore !== "undefined" && DiskStore.init) {
            DiskStore.init().then(function () {
                refreshPersistList();
            });
        }
        var persistReset = document.getElementById("persist-reset");
        if (persistReset) {
            persistReset.addEventListener("click", function () {
                var sel = document.getElementById("persist-select");
                if (sel && sel.value && typeof DiskStore !== "undefined") {
                    DiskStore.clear(sel.value).then(function () {
                        refreshPersistList();
                    });
                }
            });
        }
        var persistResetAll = document.getElementById("persist-reset-all");
        if (persistResetAll) {
            persistResetAll.addEventListener("click", function () {
                if (typeof DiskStore !== "undefined" && DiskStore.clearAll) {
                    DiskStore.clearAll().then(function () {
                        refreshPersistList();
                    });
                }
            });
        }

        // Clicking the small control-bar zone opens the file picker.
        if (zone) {
            zone.addEventListener("click", function () {
                if (input) input.click();
            });
        }
        if (input) {
            input.addEventListener("change", function () {
                processFiles(input.files);
                input.value = "";
            });
        }

        // Unmount control: select an image and press Unmount to remove it
        // from DataLoader (and from IndexedDB so it does not return on reload).
        var mountedSelect = document.getElementById("mounted-select");
        var mountedRemove = document.getElementById("mounted-remove");
        if (mountedSelect && mountedRemove) {
            mountedSelect.addEventListener("change", function () {
                mountedRemove.disabled = !mountedSelect.value;
            });
            mountedRemove.addEventListener("click", function () {
                removeMounted(mountedSelect.value);
            });
        }

        // The small control-bar zone stays usable as an in-place target too.
        if (zone) {
            ["dragenter", "dragover"].forEach(function (evt) {
                zone.addEventListener(evt, function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    zone.classList.add("dragover");
                });
            });
            ["dragleave", "dragend"].forEach(function (evt) {
                zone.addEventListener(evt, function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    zone.classList.remove("dragover");
                });
            });
            zone.addEventListener("drop", function (e) {
                e.preventDefault();
                e.stopPropagation();
                zone.classList.remove("dragover");
                processFiles(e.dataTransfer && e.dataTransfer.files);
            });
        }

        // ------------------------------------------------------------------
        // Full-window drop overlay.
        // While a file drag is in progress anywhere over the window, show a
        // large drop target on top of the whole UI; hide it as soon as the
        // drag leaves the window or the mouse is released.
        // ------------------------------------------------------------------
        var dragDepth = 0;

        function showOverlay() {
            if (overlay) overlay.classList.add("visible");
        }
        function hideOverlay() {
            if (overlay) overlay.classList.remove("visible");
            dragDepth = 0;
        }
        function hasFiles(e) {
            var dt = e.dataTransfer;
            if (!dt || !dt.types) return false;
            return Array.prototype.indexOf.call(dt.types, "Files") !== -1;
        }

        window.addEventListener("dragenter", function (e) {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth++;
            showOverlay();
        });
        window.addEventListener("dragover", function (e) {
            if (!hasFiles(e)) return;
            e.preventDefault(); // required to allow the drop
        });
        window.addEventListener("dragleave", function (e) {
            if (dragDepth > 0) dragDepth--;
            if (dragDepth === 0) hideOverlay();
        });
        window.addEventListener("drop", function (e) {
            e.preventDefault();
            hideOverlay();
            processFiles(e.dataTransfer && e.dataTransfer.files);
        });
        window.addEventListener("dragend", function (e) {
            e.preventDefault();
            hideOverlay();
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
