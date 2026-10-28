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
    // tracked here: the "Export image" rule uses this map to tell the
    // operator's own files from media the machine merely streams. The
    // "Mounted images" counter follows the LIST itself (see
    // refreshMountedList), so it can never contradict what the select shows.
    var userImages = {};

    // Resolves once the images persisted from a previous session are mounted.
    // Snapshot restore waits for it: judging a state before the user's own
    // images are back would compare it against the bundled image of the same
    // name, and refuse a state that is perfectly restorable. Held as a
    // resolver so a restore that starts early simply waits.
    var imagesReady = (typeof Promise === "function") ? (function () {
        var resolveReady = null;
        var promise = new Promise(function (resolve) { resolveReady = resolve; });
        return {
            promise: promise,
            resolve: function () { if (resolveReady) { resolveReady(); resolveReady = null; } }
        };
    })() : null;

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

    // Deleting an image is a deliberate, separate operator action (Unmount
    // only takes the medium out of the machine), so nothing calls this yet.
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

    // Erase every stored image in one transaction. Service mode (System Reset)
    // only: clearing the object store is safe on the connection this page
    // already holds, unlike indexedDB.deleteDatabase() which would wait for it.
    function dbClear() {
        return openDB().then(function (db) {
            if (!db) return Promise.resolve();
            return new Promise(function (resolve) {
                var tx = db.transaction(DB_STORE, "readwrite");
                tx.objectStore(DB_STORE).clear();
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        });
    }

    // Unmount everything the operator mounted from storage and drop the stored
    // copies. Bundled/network media is not in IndexedDB and is streamed again
    // on the next boot, so it is deliberately left alone.
    function clearAllImages() {
        var urls = Object.keys(userImages);
        return dbClear().then(function () {
            urls.forEach(function (url) { DataLoader.unmount(url); });
            // Cleared IN PLACE: window.yapdpExportList.userImages hands this
            // very object to the tests, so reassigning it would split the map
            // the page reads from the one that was handed out.
            urls.forEach(function (url) { delete userImages[url]; });
            refreshMountedList();
            refreshExportList();
            return urls.length;
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

    // Image url → [drives] currently bound to it (from MountMap), used to
    // show the binding in the "Mounted images" list.
    function bindingsByUrl() {
        var out = {};
        if (typeof MountMap === "undefined" || typeof MountMap.list !== "function") return out;
        var map = MountMap.list();
        Object.keys(map).forEach(function (drive) {
            var url = map[drive];
            if (!out[url]) out[url] = [];
            out[url].push(drive);
        });
        return out;
    }

    // Every Storage list shows at most NAME_LIMIT characters of an image name.
    // The length of a name is data (a dropped file can be 255 characters long)
    // and must never drive layout: a native <select> is as wide as its longest
    // option, which used to widen the whole STORAGE page.
    var NAME_LIMIT = 32;

    // Middle ellipsis: the head of the name stays readable, the tail is kept
    // because it carries the extension (.dsk / .tap.zst) that tells the
    // operator what the image is. Only the middle is what gets elided.
    function shortImageName(url, max) {
        var limit = (typeof max === "number" && max > 8) ? max : NAME_LIMIT;
        var s = String(url == null ? "" : url);
        if (s.length <= limit) return s;
        var tail = 12;
        if (limit > tail + 2) {
            return s.slice(0, limit - tail - 1) + "\u2026" + s.slice(s.length - tail);
        }
        return s.slice(0, limit - 1) + "\u2026";
    }

    // "rp1.dsk  →  RP1" when the image is bound to a drive, url alone otherwise.
    // An image whose saved changes came from a SHARED STATE says so: those
    // blocks are somebody else's work, not this operator's, and the Reset
    // control clears them like any other.
    //
    // `maxName` shortens ONLY the name (shortImageName); the drive / origin
    // markers stay whole, because they are what the line means. The lists pass
    // it and keep the untruncated label in the option's title.
    function imageLabel(url, bindings, maxName) {
        var base = maxName ? shortImageName(url, maxName) : url;
        var drives = bindings[url];
        if (drives && drives.length) {
            // `base`, not `url`: the binding must not bring the long name back.
            base = base + "  \u2192  " + drives.map(function (d) {
                return d.toUpperCase();
            }).join(", ");
        }
        if (typeof DiskStore !== "undefined" &&
            typeof DiskStore.originOf === "function" &&
            DiskStore.originOf(url) === "state") {
            base += "  (from a shared state)";
        }
        return base;
    }

    // Browsers do not reliably show an <option title> while the list is closed,
    // so the full label of the CURRENT entry is mirrored onto the <select>
    // itself: hovering the closed control explains a shortened name without
    // opening the list. Option titles are kept as well — an open list shows
    // them as tooltips.
    function syncSelectTitle(select) {
        if (!select) return;
        var full = "";
        var opts = select.options || [];
        for (var i = 0; i < opts.length; i++) {
            if (opts[i].value === select.value) {
                full = opts[i].title || opts[i].textContent || "";
                break;
            }
        }
        select.title = select.disabled ? "" : full;
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
            // A dropped .state file is a MACHINE STATE, not a disk image: it is
            // applied to the running machine instead of mounted as a drive.
            // This is the offline path (`file://` pages cannot fetch anything,
            // so drag & drop is the only way a state arrives there).
            // Both binary (.state.zst) and text envelope (.state.txt) are accepted.
            if (/\.state(\.(zst|txt))?$/i.test(file.name)) {
                file.arrayBuffer().then(function (buffer) {
                    var came = (typeof SnapshotStore !== "undefined" &&
                        typeof SnapshotStore.applyStateBytes === "function");
                    if (!came) {
                        if (++done === list.length) finish();
                        return;
                    }
                    // Auto-detect text envelope and decode to binary.
                    var raw = new Uint8Array(buffer);
                    var text = null;
                    try {
                        text = new TextDecoder("utf-8").decode(raw);
                    } catch (e) { /* not valid UTF-8, treat as binary */ }
                    var env = typeof StateEnvelope !== "undefined" ? StateEnvelope : window.__yapdpStateEnvelope;
                    if (text && env && env.isEnvelope(text)) {
                        var decoded = env.decode(text);
                        if (decoded) raw = decoded;
                    }
                    var result = SnapshotStore.applyStateBytes(raw, file.name);
                    if (result && typeof result.then === "function") {
                        result.then(function (r) {
                            if (!r || !r.ok) {
                                console.warn("dropped state not applied:",
                                    r && r.reason);
                                if (typeof window.__yapdpReportWarning === "function") {
                                    window.__yapdpReportWarning("Dropped state was not applied", "state-apply-failed");
                                }
                            }
                            if (++done === list.length) finish();
                        });
                    } else if (++done === list.length) {
                        finish();
                    }
                }).catch(function () {
                    if (++done === list.length) finish();
                });
                return;
            }
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
                // Core stack: register the lazy provider for this url so a
                // remapped drive reading it is served from DataLoader.
                if (typeof window !== "undefined" &&
                    typeof window.__yapdpMountProvider === "function") {
                    window.__yapdpMountProvider(url);
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
    // Paper-tape images share DataLoader with disk images, but belong in the
    // Paper Tapes selector, not in Storage's mounted-disk list.
    function diskImageUrls(urls) {
        return urls.filter(function (url) { return !isPtap(url); });
    }

    function refreshMountedList() {
        var select = document.getElementById("mounted-select");
        if (!select) return;
        var remove = document.getElementById("mounted-remove");
        var prev = select.value; // keep the operator's selection across rebuilds

        var urls = diskImageUrls(DataLoader.list()).sort();
        var bindings = bindingsByUrl();
        // Which of these images "Export image" can actually save. The same rule
        // as the export list itself (exportableUrls), computed HERE so the two
        // lists on one page can never tell different stories about one image.
        var changed = (typeof DiskStore !== "undefined" &&
                       typeof DiskStore.listDirty === "function")
            ? diskImageUrls(DiskStore.listDirty()) : [];
        var exportable = exportableUrls(urls, changed, userImages);
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
                // Say WHY an image has nothing to save. A pristine bundled image
                // is mounted and streaming but has no entry in "Export image"
                // (see exportableUrls), and a list that simply omits it reads as
                // a bug unless the image itself says so.
                var suffix = exportable.indexOf(url) === -1
                    ? "  \u00b7 nothing to export" : "";
                opt.textContent = imageLabel(url, bindings, NAME_LIMIT) + suffix;
                // The shortened name is a display choice, never a data loss:
                // the whole label is one hover away, and on the line below.
                opt.title = imageLabel(url, bindings) + suffix;
                select.appendChild(opt);
            });
        }
        select.disabled = urls.length === 0;
        if (remove) remove.disabled = urls.length === 0;
        if (prev && urls.indexOf(prev) !== -1) select.value = prev;
        refreshMountedCaption();
        syncSelectTitle(select);
        syncDriveSelectToList();
        refreshAssignControls();
        refreshDeleteButton();

        // The counter belongs to the list beside it, so it counts what the list
        // offers: every mounted image — dragged in, bundled, or fetched for a
        // restored state — not only the operator's own files. Counting
        // userImages read "0 images" next to the two disks a teleport was
        // running from.
        var count = document.getElementById("mounted-count");
        if (count) {
            var n = urls.length;
            count.textContent = n + " " + plural(n);
        }

        // Keep the "Paper tape reader file" list in sync so a .ptap image
        // imported via drag & drop (or restored from IndexedDB) can be chosen
        // as the tape read by the PTR11 reader.
        refreshPtrList();
        // Keep the "Export image" list in sync (core stack; see refreshExportList).
        refreshExportList();
    }

    // The select can only show a shortened name (shortImageName), so the full
    // label of the chosen image is printed on a line of its own under the list.
    // That line wraps: it must grow downwards, never sideways.
    function refreshMountedCaption() {
        var el = document.getElementById("mounted-full");
        if (!el) return;
        var select = document.getElementById("mounted-select");
        var url = select ? select.value : "";
        var full = url ? imageLabel(url, bindingsByUrl()) : "";
        el.textContent = full;
        el.hidden = !full;
    }

    // Size of a mounted image in bytes, or null when it is not mounted.
    function imageSize(url) {
        if (!url || typeof DataLoader === "undefined") return null;
        var bytes = DataLoader.get(url);
        return (bytes && typeof bytes.length === "number") ? bytes.length : null;
    }

    // Point the drive select at the image's current binding (or "not bound").
    // Used when the SELECTED IMAGE changes — never on every refresh, so a drive
    // the operator just picked is not overwritten under their hands.
    function syncDriveSelectToList() {
        var select = document.getElementById("mounted-select");
        var driveSel = document.getElementById("assign-drive");
        if (!select || !driveSel) return;
        var url = select.value || "";
        var bound = (url && bindingsByUrl()[url]) || [];
        driveSel.value = bound.length === 1 ? bound[0] : "";
    }

    // Enable the Apply/Assign-anyway buttons from the selected image + drive,
    // and REFUSE an image whose size does not fit the chosen controller
    // (DriveGeometry) unless "Assign anyway" is pressed. Picking "— not bound —"
    // IS the detach action (enabled only while the image is bound).
    function refreshAssignControls() {
        var select = document.getElementById("mounted-select");
        var driveSel = document.getElementById("assign-drive");
        var assignBtn = document.getElementById("assign-btn");
        var assignAnywayBtn = document.getElementById("assign-anyway-btn");
        var warning = document.getElementById("assign-warning");
        if (!select) return;

        var url = select.value || "";
        var isTape = /\.ptap$/i.test(url);
        var bound = (url && bindingsByUrl()[url]) || [];
        var drive = driveSel ? driveSel.value : "";
        var detach = (drive === "" && bound.length > 0);

        var fit = { ok: true, reason: "" };
        if (url && !isTape && drive &&
            typeof DriveGeometry !== "undefined" && DriveGeometry.check) {
            fit = DriveGeometry.check(drive, imageSize(url));
        }

        if (driveSel) driveSel.disabled = !url || isTape;
        if (assignBtn) {
            assignBtn.disabled = !(url && !isTape && (detach || (drive !== "" && fit.ok)));
        }
        var mismatch = !!(url && !isTape && drive !== "" && !fit.ok);
        if (assignAnywayBtn) {
            assignAnywayBtn.disabled = !mismatch;
            assignAnywayBtn.hidden = !mismatch;
        }
        if (warning) warning.textContent = fit.ok ? "" : fit.reason;
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
            // Same fixed budget as the disk lists: a dropped .ptap with a long
            // name must not widen the Paper Tapes tab either.
            opt.textContent = shortImageName(url);
            opt.title = url;
            opt.setAttribute("data-drop", "1");
            select.appendChild(opt);
        });
        syncSelectTitle(select);
    }

    // Unmount is "pull the cartridge out of the drive", not "throw it away":
    // the medium leaves the running machine, the operator keeps the file.
    //   - the stored copy stays in IndexedDB, so init() re-mounts the image on
    //     the next launch (docs/manual/storage.md promises exactly that);
    //   - userImages keeps the image exportable ("Export image") and owned;
    //   - the drive binding stays, so booting a drive whose medium is out
    //     reports a missing image instead of silently substituting whatever
    //     <unit>.dsk happens to be lying around.
    // Deleting the bytes is a separate, explicit action; nothing here may
    // destroy the operator's only copy. A bundled/network medium is simply
    // re-streamed on the next boot (the disk provider asks the loader again).
    function removeMounted(url) {
        if (!url) return;
        DataLoader.unmount(url);
        refreshMountedList();
    }

    // ------------------------------------------------------------------
    // Delete image — the one DESTRUCTIVE action on this page
    // ------------------------------------------------------------------
    // Unmount only takes the medium out of the machine (see above); erasing the
    // stored copy is a separate, confirmed decision, because IndexedDB holds the
    // operator's only copy of an imported image.

    // Only an image the operator imported lives in IndexedDB, so only it can be
    // deleted: bundled media is streamed from the server, and "deleting" it
    // would just drop the mount and re-download the same bytes.
    function canDeleteImage(url) {
        return !!url && !!userImages[url];
    }

    function refreshDeleteButton() {
        var btn = document.getElementById("mounted-delete");
        if (!btn) return;
        var select = document.getElementById("mounted-select");
        var url = select ? select.value : "";
        var ok = canDeleteImage(url);
        btn.disabled = !ok;
        btn.title = ok
            ? "Erase " + url + " from browser storage"
            : "Only an image you imported can be deleted";
    }

    var deleteDialog = null;
    var deleteTarget = "";

    function buildDeleteDialog() {
        if (deleteDialog) return deleteDialog;
        deleteDialog = document.createElement("div");
        deleteDialog.id = "imagedelete-overlay";
        deleteDialog.className = "modal-overlay";
        deleteDialog.innerHTML =
            '<div class="modal-box">' +
              '<span class="modal-title">Delete this image?</span>' +
              '<p class="modal-intro">The image <code id="imagedelete-url"></code> will be ' +
                'erased from the storage. This cannot be undone.</p>' +
              '<p class="modal-intro" id="imagedelete-warn"></p>' +
              '<button type="button" class="modal-close" ' +
                'data-imagedelete="cancel">Cancel</button>' +
              '<button type="button" class="modal-close" id="imagedelete-export" ' +
                'data-imagedelete="export">Export first</button>' +
              '<button type="button" class="modal-close modal-danger" ' +
                'id="imagedelete-confirm" data-imagedelete="delete">Delete</button>' +
            '</div>';
        deleteDialog.addEventListener("click", function (e) {
            if (e.target === deleteDialog) {
                closeDeleteDialog();
                return;
            }
            var action = e.target.getAttribute && e.target.getAttribute("data-imagedelete");
            if (action === "cancel") {
                closeDeleteDialog();
            } else if (action === "export") {
                // Save a copy first; the dialog stays open for the Delete.
                downloadImage(deleteTarget);
            } else if (action === "delete") {
                var url = deleteTarget;
                closeDeleteDialog();
                deleteImage(url);
            }
        });
        document.body.appendChild(deleteDialog);
        return deleteDialog;
    }

    function openDeleteDialog(url) {
        deleteTarget = url;
        var box = buildDeleteDialog();
        var code = box.querySelector("#imagedelete-url");
        if (code) code.textContent = url;
        var dirty = 0;
        try {
            if (typeof DiskStore !== "undefined" &&
                typeof DiskStore.dirtyBlockCount === "function") {
                dirty = DiskStore.dirtyBlockCount(url) || 0;
            }
        } catch (err) { dirty = 0; }
        var warn = box.querySelector("#imagedelete-warn");
        if (warn) {
            warn.textContent = dirty > 0
                ? "Guest writes saved for this image (" + dirty + " block" +
                  (dirty === 1 ? "" : "s") + ") go with it. \u201cExport first\u201d " +
                  "saves everything to your computer."
                : "\u201cExport first\u201d saves a copy to your computer before it goes.";
        }
        box.classList.add("visible");
        var primary = box.querySelector("#imagedelete-confirm");
        if (primary && primary.focus) primary.focus();
    }

    function closeDeleteDialog() {
        if (deleteDialog) deleteDialog.classList.remove("visible");
        deleteTarget = "";
    }

    // Erase one image from this browser: the guest's saved writes, the stored
    // bytes, the ownership mark and any drive binding that named it.
    function deleteImage(url) {
        if (!url) return;
        var work = [];
        if (typeof DiskStore !== "undefined" && typeof DiskStore.clear === "function") {
            work.push(Promise.resolve(DiskStore.clear(url)).catch(function () { /* ignore */ }));
        }
        work.push(dbDelete(url).catch(function () { /* ignore */ }));
        Promise.all(work).then(function () {
            DataLoader.unmount(url);
            delete userImages[url];
            if (typeof MountMap !== "undefined" && MountMap.removeByUrl) {
                MountMap.removeByUrl(url);
                if (MountMap.save) MountMap.save(window.localStorage);
            }
            refreshMountedList();
        });
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
        var prev = select.value; // keep the operator's selection across refreshes
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
                // This select is capped at 190px (see .persist-control), which
                // is why the name has to be shortened rather than merely clipped.
                opt.textContent = shortImageName(url) + " (" + n + " blocks)";
                opt.title = url + " (" + n + " blocks)";
                select.appendChild(opt);
            });
        }
        select.disabled = urls.length === 0;
        if (prev && urls.indexOf(prev) !== -1) select.value = prev;
        if (count) count.textContent = urls.length + " image(s) with changes";
        syncSelectTitle(select);
    }

    // ------------------------------------------------------------------
    // Export image (download a stored image, guest writes included)
    // ------------------------------------------------------------------
    // The rule is exportableUrls() below; exportLabel() then says WHY an entry
    // is offered: "rp1.dsk  →  RP1  (12 blocks changed)".

    /**
     * exportableUrls(mounted, changed, user) — which images "Export image"
     * offers.
     *
     * An image is offered when there is something to save:
     *
     *   - it has guest writes — saved in DiskStore, or still pending in the
     *     running machine (`changed` is that union, see DiskStore.listDirty),
     *     so a guest that writes re-adds its own image on the next refresh; or
     *   - the OPERATOR mounted it (drag & drop, or restored from IndexedDB):
     *     that is a file of theirs, whose current state they may want back.
     *
     * An image that merely happens to be mounted — bundled media the machine
     * streams while a guest runs, with no changes of its own — is NOT offered.
     * Listing it made "Export image" read like a directory of media/, and it is
     * exactly why "Reset all" could not fall back to "--none--": a pristine
     * bundled image is one download away and is nothing the operator produced.
     */
    function exportableUrls(mounted, changed, user) {
        var have = {};
        var out = [];
        mounted.concat(changed).forEach(function (url) {
            if (!url || have[url] || /\.ptap$/i.test(url)) return;
            var written = changed.indexOf(url) !== -1;
            var mine = !!(user && user[url]);
            if (!written && !mine) return;
            have[url] = true;
            out.push(url);
        });
        return out.sort();
    }

    function exportLabel(url, bindings, mounted, maxName) {
        var n = (typeof DiskStore !== "undefined" &&
                 typeof DiskStore.changedBlockCount === "function")
            ? DiskStore.changedBlockCount(url) : 0;
        var blocks = n === 1 ? "1 block changed" : n + " blocks changed";
        var state = (n === 0) ? "no changes" : blocks;
        if (mounted.indexOf(url) === -1) state = "not mounted, " + blocks;
        return imageLabel(url, bindings, maxName) + "  (" + state + ")";
    }

    // Core stack only: the legacy stack fills #downLoadSelect itself through
    // downLoadAdd(). Here the list is rebuilt from DataLoader and the download
    // goes through window.exportDiskImage (base + guest writes).
    function refreshExportList() {
        var select = document.getElementById("downLoadSelect");
        if (!select) return;
        if (typeof window === "undefined" ||
            typeof window.exportDiskImage !== "function") {
            return; // legacy stack manages this select on its own
        }
        var prev = select.value;
        // Which images may be exported — see exportableUrls(): guest writes, or
        // an image the operator mounted themselves.
        var mounted = (typeof DataLoader !== "undefined") ? diskImageUrls(DataLoader.list()) : [];
        var changed = (typeof DiskStore !== "undefined" && typeof DiskStore.listDirty === "function")
            ? diskImageUrls(DiskStore.listDirty()) : [];
        var urls = exportableUrls(mounted, changed, userImages);
        var bindings = bindingsByUrl();
        select.innerHTML = "";
        if (!urls.length) {
            var emptyOpt = document.createElement("option");
            emptyOpt.value = "";
            emptyOpt.textContent = "--none--";
            select.appendChild(emptyOpt);
        } else {
            urls.forEach(function (url) {
                var opt = document.createElement("option");
                opt.value = url;
                // Detached images have no live base yet — exportLabel says so
                // and the exporter fetches the base before assembling.
                opt.textContent = exportLabel(url, bindings, mounted, NAME_LIMIT);
                opt.title = exportLabel(url, bindings, mounted);
                select.appendChild(opt);
            });
        }
        select.disabled = urls.length === 0;
        if (prev && urls.indexOf(prev) !== -1) select.value = prev;
        var dlBtn = document.getElementById("download-btn");
        if (dlBtn) dlBtn.disabled = urls.length === 0;
        syncSelectTitle(select);
    }

    // Save one image to the operator's machine through the core exporter. Used
    // by "Export image" and by the Delete dialog's "Export first".
    function downloadImage(url) {
        if (!url) return;
        if (typeof window === "undefined" ||
            typeof window.exportDiskImage !== "function") {
            return;
        }
        Promise.resolve(window.exportDiskImage(url)).then(function (bytes) {
            if (!bytes || !bytes.length) {
                // Base image unavailable (not mounted and not fetchable): reuse
                // the project's modal that explains a failed image load.
                if (typeof window.reportImageLoadError === "function") {
                    window.reportImageLoadError(url, "network");
                } else if (typeof console !== "undefined") {
                    console.warn("Export image: base image unavailable for " + url);
                }
                return;
            }
            var blob = new Blob([bytes], { type: "application/octet-stream" });
            var href = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = href;
            a.download = url;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(href);
        });
    }

    // Download the image selected in "Export image".
    function exportSelectedImage() {
        var select = document.getElementById("downLoadSelect");
        downloadImage(select ? select.value : "");
    }

    // ------------------------------------------------------------------
    // UI wiring
    // ------------------------------------------------------------------
    // The full-window drop overlay and the window-level drop handling are
    // scoped to the Storage page: mounting media is a Storage-page action,
    // so the drop target must not appear (or silently do nothing) while the
    // user is looking at the Panel or any other page.
    function storagePageActive() {
      var page = document.getElementById("page-storage");
      return !!(page && page.classList.contains("active"));
    }

    // A dropped file name matches the paper-tape zone (raw or .zst).
    function isPtap(name) {
      var n = String(name || "").toLowerCase();
      return n.endsWith(".ptap") || n.endsWith(".ptap.zst");
    }

    // Wire one drop-zone element: click opens the file picker, drag events
    // highlight the zone, drops are processed (optionally filtered by name).
    function wireZone(zone, input, filter) {
      if (!zone) return;

      function pick(files) {
        var list = files ? Array.prototype.slice.call(files) : [];
        if (filter) list = list.filter(function (f) { return filter(f.name); });
        processFiles(list);
      }

      zone.addEventListener("click", function () {
        if (input) input.click();
      });
      if (input) {
        input.addEventListener("change", function () {
          pick(input.files);
          input.value = "";
        });
      }

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
        pick(e.dataTransfer && e.dataTransfer.files);
      });
    }

    function init() {
        var zone = document.getElementById("drop-zone");
        var overlay = document.getElementById("drop-overlay");
        var input = document.getElementById("drop-file-input");
        var ptapZone = document.getElementById("drop-zone-ptap");
        var ptapInput = document.getElementById("drop-file-input-ptap");

        // Re-mount images persisted from a previous session.
        dbGetAll().then(function (items) {
            items.forEach(function (item) {
                DataLoader.mount(item.key, item.bytes);
                userImages[item.key] = true;
                // Register the provider for user images too: a MountMap
                // override restored from storage may point a drive here.
                if (typeof window !== "undefined" &&
                    typeof window.__yapdpMountProvider === "function") {
                    window.__yapdpMountProvider(item.key);
                }
            });
            refreshMountedList();
        }).catch(function () {
            // Storage unavailable: nothing to wait for, never block a restore.
        }).then(function () {
            if (imagesReady) imagesReady.resolve();
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
                        // The image may now have no saved blocks left: drop it
                        // from "Export image" too if it is not mounted.
                        refreshExportList();
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
                        refreshExportList();
                    });
                }
            });
        }

        // Keep the "Persistent disk changes" list live while the Storage page is
        // on screen: guest writes are drained to DiskStore asynchronously
        // (browser-machine drains them on a timer), so the select must re-read
        // DiskStore periodically instead of only at startup.
        setInterval(function () {
            if (storagePageActive()) {
                refreshPersistList();
                refreshExportList();
            }
        }, 1500);

        // "Export image": the Download button grabs the selected image (core
        // stack only). A button, not a "change" handler: with a single option
        // the select is already at that value, so "change" would never fire.
        var downloadBtn = document.getElementById("download-btn");
        if (downloadBtn) downloadBtn.addEventListener("click", exportSelectedImage);

        // Clicking the small control-bar zone opens the file picker.
        wireZone(zone, input);
        // The Paper Tapes tab has its own small zone restricted to .ptap.
        wireZone(ptapZone, ptapInput, isPtap);

        // Unmount / Delete controls: Unmount takes the image out of the machine
        // (the stored copy stays), Delete erases it from this browser after a
        // confirmation. Only an image the operator imported can be deleted.
        var mountedSelect = document.getElementById("mounted-select");
        var mountedRemove = document.getElementById("mounted-remove");
        var mountedDelete = document.getElementById("mounted-delete");
        if (mountedSelect && mountedRemove) {
            mountedSelect.addEventListener("change", function () {
                mountedRemove.disabled = !mountedSelect.value;
                refreshDeleteButton();
                refreshMountedCaption();
                syncDriveSelectToList();
                refreshAssignControls();
            });
            mountedRemove.addEventListener("click", function () {
                removeMounted(mountedSelect.value);
            });
        }
        if (mountedSelect && mountedDelete) {
            mountedDelete.addEventListener("click", function () {
                var url = mountedSelect.value;
                if (canDeleteImage(url)) openDeleteDialog(url);
            });
        }

        // A shortened entry must stay readable from the CLOSED control: every
        // Storage list mirrors the full label of its selection into its own
        // tooltip, on rebuild (the refresh functions) and on every change.
        ["mounted-select", "downLoadSelect", "persist-select", "ptr"].forEach(function (id) {
            var sel = document.getElementById(id);
            if (!sel) return;
            sel.addEventListener("change", function () { syncSelectTitle(sel); });
            syncSelectTitle(sel);
        });

        // Binding control: one Bind button + the drive select. Picking a drive
        // assigns the image to it; picking "— not bound —" detaches it. Doing it
        // HERE — not at drop time — removes the "select the drive first"
        // ordering trap: the image is always already mounted when the drive is
        // chosen. A size mismatch disables Bind (see refreshAssignControls) and
        // the operator must take the explicit "Assign anyway" path.
        var assignDrive = document.getElementById("assign-drive");
        var assignBtn = document.getElementById("assign-btn");
        var assignAnywayBtn = document.getElementById("assign-anyway-btn");
        if (assignDrive) assignDrive.addEventListener("change", refreshAssignControls);

        function doApply() {
            var url = mountedSelect ? mountedSelect.value : "";
            if (!url || typeof MountMap === "undefined") return;
            var drive = assignDrive ? assignDrive.value : "";
            if (drive === "") {
                if (!MountMap.removeByUrl) return;
                MountMap.removeByUrl(url);
            } else {
                if (!MountMap.set) return;
                MountMap.set(drive, url);
            }
            MountMap.save(window.localStorage);
            refreshMountedList();
        }
        if (assignBtn) assignBtn.addEventListener("click", doApply);
        if (assignAnywayBtn) assignAnywayBtn.addEventListener("click", doApply);

        // The mounted-image list is built from DataLoader, but images can arrive
        // AFTER it was built: a restored state mounts the payload it carries
        // inline asynchronously, and QuickBoot fetches its boot disk in the
        // background. Rebuild the list whenever the operator opens Storage, so
        // the page never claims the machine has no disks while the guest is
        // running from one. switchPage() announces every page change.
        if (typeof document.addEventListener === "function") {
            document.addEventListener("yapdp:pagechange", function (e) {
                if (!e || !e.detail || e.detail.page !== "storage") return;
                refreshMountedList();
            });
        }

        // ------------------------------------------------------------------
        // Full-window drop overlay.
        // While a file drag is in progress anywhere over the Storage page,
        // show a large drop target on top of the whole UI; hide it as soon as
        // the drag leaves the window or the mouse is released. On any other
        // page the drag is left to the browser (the "not allowed" cursor), so
        // no drop affordance appears where mounting is not the current task.
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
            if (!hasFiles(e) || !storagePageActive()) return;
            e.preventDefault();
            dragDepth++;
            showOverlay();
        });
        window.addEventListener("dragover", function (e) {
            if (!hasFiles(e) || !storagePageActive()) return;
            e.preventDefault(); // required to allow the drop
        });
        window.addEventListener("dragleave", function (e) {
            if (dragDepth > 0) dragDepth--;
            if (dragDepth === 0) hideOverlay();
        });
        window.addEventListener("drop", function (e) {
            if (!hasFiles(e)) return;
            // Never let the browser open the dropped file itself; on pages
            // other than Storage the drop is simply ignored.
            e.preventDefault();
            hideOverlay();
            if (storagePageActive()) {
                processFiles(e.dataTransfer && e.dataTransfer.files);
            }
        });
        window.addEventListener("dragend", function (e) {
            e.preventDefault();
            hideOverlay();
        });
    }

    // The rule and the list builder, on window for the unit test
    // (tests/export-list.test.js) — the same kind of seam the VT52 marker
    // parser has (window.vt52MarkerVars). The page never reads it; the
    // userImages map is handed out so a test can mount an image "by hand" the
    // way a drag & drop would.
    if (typeof window !== "undefined") {
        // Startup readiness seam for snapshot restore. A restore may begin
        // before IndexedDB has handed back the user's images; racing a storage
        // read against a disk check produced a spurious "different build".
        // The timeout keeps a wedged IndexedDB from blocking restore forever.
        window.__yapdpImagesReady = {
            whenReady: function (timeoutMs) {
                if (!imagesReady) return Promise.resolve();
                var limit = (typeof timeoutMs === "number") ? timeoutMs : 2000;
                return Promise.race([
                    imagesReady.promise,
                    new Promise(function (resolve) { setTimeout(resolve, limit); })
                ]);
            }
        };
        window.yapdpExportList = {
            exportableUrls: exportableUrls,
            diskImageUrls: diskImageUrls,
            // Label policy of the Storage lists: the name is shortened to a
            // fixed budget so the page geometry cannot follow the data.
            shortImageName: shortImageName,
            refreshExportList: refreshExportList,
            // Rebuild the "Mounted images" select. Snapshots calls this after a
            // restore: the images it mounts arrive after init() already filled
            // the list, so the page would otherwise show none of them.
            refreshMountedList: refreshMountedList,
            userImages: userImages,
            // Service mode: erase the operator's stored images (see
            // clearAllImages above). Resolves with how many were unmounted.
            clearAll: clearAllImages
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
