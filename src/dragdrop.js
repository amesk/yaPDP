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

    // "rp1.dsk  →  RP1" when the image is bound to a drive, url alone otherwise.
    // An image whose saved changes came from a SHARED STATE says so: those
    // blocks are somebody else's work, not this operator's, and the Reset
    // control clears them like any other.
    function imageLabel(url, bindings) {
        var base = url;
        var drives = bindings[url];
        if (drives && drives.length) {
            base = url + "  \u2192  " + drives.map(function (d) {
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
            if (/\.state(\.zst)?$/i.test(file.name)) {
                file.arrayBuffer().then(function (buffer) {
                    var came = (typeof SnapshotStore !== "undefined" &&
                        typeof SnapshotStore.applyStateBytes === "function");
                    if (!came) {
                        if (++done === list.length) finish();
                        return;
                    }
                    var result = SnapshotStore.applyStateBytes(
                        new Uint8Array(buffer), file.name);
                    if (result && typeof result.then === "function") {
                        result.then(function (r) {
                            if (!r || !r.ok) {
                                console.warn("dropped state not applied:",
                                    r && r.reason);
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
    function refreshMountedList() {
        var select = document.getElementById("mounted-select");
        if (!select) return;
        var remove = document.getElementById("mounted-remove");
        var prev = select.value; // keep the operator's selection across rebuilds

        var urls = DataLoader.list().sort();
        var bindings = bindingsByUrl();
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
                opt.textContent = imageLabel(url, bindings);
                select.appendChild(opt);
            });
        }
        select.disabled = urls.length === 0;
        if (remove) remove.disabled = urls.length === 0;
        if (prev && urls.indexOf(prev) !== -1) select.value = prev;
        syncDriveSelectToList();
        refreshAssignControls();

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
        // Keep the "Export image" list in sync (core stack; see refreshExportList).
        refreshExportList();
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
        // Drop any drive binding that pointed at this image, so a later boot
        // does not fall back to an unmounted url.
        if (typeof MountMap !== "undefined" && MountMap.removeByUrl) {
            MountMap.removeByUrl(url);
            MountMap.save(window.localStorage);
        }
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
                opt.textContent = url + " (" + n + " blocks)";
                select.appendChild(opt);
            });
        }
        select.disabled = urls.length === 0;
        if (prev && urls.indexOf(prev) !== -1) select.value = prev;
        if (count) count.textContent = urls.length + " image(s) with changes";
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
            if (!url || have[url]) return;
            var written = changed.indexOf(url) !== -1;
            var mine = !!(user && user[url]);
            if (!written && !mine) return;
            have[url] = true;
            out.push(url);
        });
        return out.sort();
    }

    function exportLabel(url, bindings, mounted) {
        var n = (typeof DiskStore !== "undefined" &&
                 typeof DiskStore.changedBlockCount === "function")
            ? DiskStore.changedBlockCount(url) : 0;
        var blocks = n === 1 ? "1 block changed" : n + " blocks changed";
        var state = (n === 0) ? "no changes" : blocks;
        if (mounted.indexOf(url) === -1) state = "not mounted, " + blocks;
        return imageLabel(url, bindings) + "  (" + state + ")";
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
        var mounted = (typeof DataLoader !== "undefined") ? DataLoader.list() : [];
        var changed = (typeof DiskStore !== "undefined" && typeof DiskStore.listDirty === "function")
            ? DiskStore.listDirty() : [];
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
                opt.textContent = exportLabel(url, bindings, mounted);
                select.appendChild(opt);
            });
        }
        select.disabled = urls.length === 0;
        if (prev && urls.indexOf(prev) !== -1) select.value = prev;
        var dlBtn = document.getElementById("download-btn");
        if (dlBtn) dlBtn.disabled = urls.length === 0;
    }

    // Download the image selected in "Export image" through the core exporter.
    function exportSelectedImage() {
        var select = document.getElementById("downLoadSelect");
        var url = select ? select.value : "";
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

        // Unmount control: select an image and press Unmount to remove it
        // from DataLoader (and from IndexedDB so it does not return on reload).
        var mountedSelect = document.getElementById("mounted-select");
        var mountedRemove = document.getElementById("mounted-remove");
        if (mountedSelect && mountedRemove) {
            mountedSelect.addEventListener("change", function () {
                mountedRemove.disabled = !mountedSelect.value;
                syncDriveSelectToList();
                refreshAssignControls();
            });
            mountedRemove.addEventListener("click", function () {
                removeMounted(mountedSelect.value);
            });
        }

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
        window.yapdpExportList = {
            exportableUrls: exportableUrls,
            refreshExportList: refreshExportList,
            userImages: userImages
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
