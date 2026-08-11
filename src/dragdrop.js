/**
 * PDP-11 Emulator — Disk/Tape Image Drag & Drop Import
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
    // Known device image URL shapes used for user feedback.
    // (Not an allow-list — any name is mounted; this only improves hints.)
    var KNOWN_URL_RE = /^(rk[0-4]|rl[0-3]|rp[0-4]|tm[0-3]|ra[0-2])\.(dsk|tap)$/;

    // Total number of images the user has mounted this session (via
    // drag & drop or restored from IndexedDB). Kept separate from the
    // per-call counters so the status line accumulates across drops.
    var userMounted = 0;

    function plural(n) {
        return n === 1 ? "image" : "images";
    }

    // ------------------------------------------------------------------
    // IndexedDB persistence
    // ------------------------------------------------------------------
    var DB_NAME = "pdp11-images";
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

    function isKnownUrl(url) {
        return KNOWN_URL_RE.test(url);
    }

    function setStatus(zone, text, cls) {
        if (!zone) return;
        var el = zone.querySelector(".drop-zone-status");
        if (el) {
            el.textContent = text || "";
            el.className = "drop-zone-status" + (cls ? " " + cls : "");
        }
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
    function processFiles(zone, files) {
        var list = Array.prototype.slice.call(files || []);
        if (!list.length) return;

        setStatus(zone, "Processing " + list.length + " file(s)…", "info");
        var done = 0;
        var ok = 0;
        var fail = 0;
        var lastMsg = "";

        function finish() {
            if (done !== list.length) return;
            refreshMountedList();
            if (fail === 0) {
                lastMsg = userMounted + " " + plural(userMounted) +
                    " mounted — type e.g. 'boot rp1' at the Boot> prompt";
                setStatus(zone, lastMsg, "ok");
            } else {
                lastMsg = ok + " mounted, " + fail + " failed";
                setStatus(zone, lastMsg, "error");
            }
        }

    list.forEach(function (file) {
        file.arrayBuffer().then(function (buffer) {
            var bytes = new Uint8Array(buffer);
            var url = canonicalName(file.name);
            var isZst = /\.zst$/i.test(file.name);
            // Was this URL already mounted? Re-dropping the same image
            // replaces its bytes but must NOT inflate the unique count.
            var wasMounted = DataLoader.has(url);

            var mounted;
                if (isZst) {
                    var raw = decompressZst(bytes);
                    if (raw === null) {
                        fail++;
                        lastMsg = "Failed to decompress '" + file.name + "'";
                        setStatus(zone, lastMsg, "error");
                        if (++done === list.length) finish();
                        return;
                    }
                    DataLoader.mount(url, raw);
                    // Store the decompressed bytes (as an exact-size buffer copy)
                    // so the image stays available offline on the next launch.
                    dbPut(url, raw.slice().buffer);
                    mounted = true;
                } else {
                    DataLoader.mount(url, bytes);
                    dbPut(url, buffer);
                    mounted = true;
                }

                if (mounted) {
                    ok++;
                    if (!wasMounted) userMounted++;
                    if (isKnownUrl(url)) {
                        lastMsg = "Mounted '" + url + "' — ready to boot";
                    } else {
                        lastMsg = "Mounted as '" + url + "' — rename to a known device (e.g. rp1.dsk) to boot it";
                    }
                    setStatus(zone, lastMsg, isKnownUrl(url) ? "ok" : "warn");
                }
                if (++done === list.length) finish();
            }).catch(function () {
                fail++;
                lastMsg = "Failed to read '" + file.name + "'";
                setStatus(zone, lastMsg, "error");
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
    }

    function removeMounted(url) {
        if (!url) return;
        DataLoader.unmount(url);
        dbDelete(url);
        if (userMounted > 0) userMounted--;
        refreshMountedList();
        setStatus(document.getElementById("drop-zone"), "Unmounted '" + url + "'", "info");
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
                userMounted++;
            });
            refreshMountedList();
            if (items.length) {
                setStatus(zone, items.length + " " + plural(items.length) +
                    " restored from storage", "info");
            }
        });

        // Clicking the small control-bar zone opens the file picker.
        if (zone) {
            zone.addEventListener("click", function () {
                if (input) input.click();
            });
        }
        if (input) {
            input.addEventListener("change", function () {
                processFiles(zone, input.files);
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
                processFiles(zone, e.dataTransfer && e.dataTransfer.files);
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
            processFiles(zone, e.dataTransfer && e.dataTransfer.files);
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
