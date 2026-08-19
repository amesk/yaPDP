/**
 * yaPDP — Image load error dialog
 *
 * When a disk/tape image cannot be fetched completely (the hosting server
 * drops the connection part-way through a large file, e.g. a big BSD image on
 * GitVerse Pages, or the file is simply unreachable in the minimal desktop
 * build), the emulator would otherwise stall with no explanation — the guest
 * OS just hangs at boot.
 *
 * This module turns that silent failure into a modal overlay (reusing the
 * .modal-* classes from css/pdp11.css, same as the first-run hint, the CONFIG
 * leave dialog and the reboot confirmation) so the operator knows what
 * happened and how to fix it: download the image and drop it into the Drop
 * zone on the Storage page.
 *
 * Wiring:
 *   - iopage.js calls the global window.reportImageLoadError(url, reason)
 *     whenever fetchBlock() fails with a load error (see diskIO() catch).
 *   - This module is a no-op unless that hook is invoked; it never blocks
 *     normal startup.
 *
 * The overlay is shown on EVERY reported error (no deduplication) as
 * requested: each new failure simply refreshes the same overlay.
 *
 * The dialog is built with createElement/textContent (never innerHTML with
 * user data), so an image name can never inject markup.
 *
 * Must be loaded AFTER pdp11-panel.js (switchPage) and BEFORE pdp11-app.js.
 */
"use strict";

var ImageError = (function () {
    // ------------------------------------------------------------------
    // Pure helpers (no DOM) — unit-testable in Node
    // ------------------------------------------------------------------

    // Describe a failed image fetch. reason is one of:
    //   "network"    — fetch() failed / non-OK status / file not found
    //   "truncated"  — response shorter than its Content-Length (dropped)
    //   "decompress" — fzstd could not decompress the received bytes
    //
    // context (optional) shapes the wording for a "network" failure:
    //   { fileProtocol } — page opened as a local file:// (browser blocks fetch)
    //   { tauri }        — Tauri desktop build, image not bundled (Minimal)
    // Returns {title, intro, url, body} used by the overlay and by tests.
    function messageFor(url, reason, context) {
        var dropHint = " Download the file and drop it into the Drop zone on " +
            "the Storage page.";
        var why;
        switch (reason) {
            case "truncated":
                why = "The server sent only part of the image before the " +
                    "connection was dropped, so the file is incomplete." + dropHint;
                break;
            case "decompress":
                why = "The image arrived damaged or incomplete and could not " +
                    "be decompressed." + dropHint;
                break;
            default:
                if (context && context.fileProtocol) {
                    why = "Your browser blocked the request because the page " +
                        "was opened as a local file (file://), which does not " +
                        "allow fetching the media directory. Open the emulator " +
                        "through a local web server, or drop the downloaded " +
                        "file into the Drop zone.";
                } else if (context && context.tauri) {
                    why = "This image is not shipped with the Minimal desktop " +
                        "build. Drop the downloaded file into the Drop zone on " +
                        "the Storage page.";
                } else {
                    why = "The image could not be reached over the network." + dropHint;
                }
                break;
        }
        return {
            title: "Image load interrupted",
            intro: "The disk/tape image",
            url: String(url || ""),
            body: " was not loaded. " + why +
                " A guest OS cannot boot from a partial image."
        };
    }

    // ------------------------------------------------------------------
    // Overlay DOM (browser only — not exercised by the Node tests)
    // ------------------------------------------------------------------

    var overlay = null;

    // Detect the runtime the overlay is shown in, so a fetch failure can be
    // phrased correctly: a local file:// page blocks fetch (CORS), and the
    // Tauri Minimal build simply does not ship most images.
    function contextFor() {
        var fileProtocol = typeof window !== "undefined" && window.location &&
            window.location.protocol === "file:";
        var tauri = typeof window !== "undefined" && window.__TAURI__ &&
            typeof window.__TAURI__.core !== "undefined";
        return { fileProtocol: !!fileProtocol, tauri: !!tauri };
    }

    function hide() {
        if (overlay) overlay.classList.remove("visible");
    }

    function show(url, reason) {
        if (typeof document === "undefined") return;
        // A failed image fetch invalidates any in-flight autoload: the guest
        // cannot boot, so "don't touch the keyboard" no longer applies. Abort
        // the wizard's typing chain and hide its balloon (quickboot.js). The
        // hook is published by quickboot.js at load time and guarded here so a
        // load-order change never throws.
        if (typeof window !== "undefined" &&
            typeof window.__autoloadAbort === "function") {
            window.__autoloadAbort();
        }
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "imgerror-overlay";
            overlay.className = "modal-overlay";
            overlay.addEventListener("click", function (e) {
                if (e.target === overlay) {
                    hide();
                    return;
                }
                var action = e.target.getAttribute &&
                    e.target.getAttribute("data-imgerror-action");
                if (action === "storage") {
                    hide();
                    // Sidebar navigation lives on pdp11-panel.js. Guard the
                    // call so a load-order change never throws here.
                    if (typeof switchPage === "function") switchPage("storage");
                } else if (action === "close" || (e.target.closest &&
                        e.target.closest(".modal-close"))) {
                    hide();
                }
            });
            document.body.appendChild(overlay);
        }

        var msg = messageFor(url, reason, contextFor());
        var box = document.createElement("div");
        box.className = "modal-box error";

        var title = document.createElement("span");
        title.className = "modal-title";
        title.textContent = msg.title;
        box.appendChild(title);

        var intro = document.createElement("p");
        intro.className = "modal-intro";
        intro.appendChild(document.createTextNode(msg.intro + " "));
        var code = document.createElement("code");
        code.textContent = msg.url;
        intro.appendChild(code);
        intro.appendChild(document.createTextNode(msg.body));
        box.appendChild(intro);

        var storageBtn = document.createElement("button");
        storageBtn.type = "button";
        storageBtn.className = "modal-close";
        storageBtn.setAttribute("data-imgerror-action", "storage");
        storageBtn.textContent = "Open Storage";
        box.appendChild(storageBtn);

        var gotItBtn = document.createElement("button");
        gotItBtn.type = "button";
        gotItBtn.className = "modal-close";
        gotItBtn.setAttribute("data-imgerror-action", "close");
        gotItBtn.textContent = "Got it";
        box.appendChild(gotItBtn);

        overlay.innerHTML = "";
        overlay.appendChild(box);
        overlay.classList.add("visible");
    }

    // Global entry point called from iopage.js (diskIO error path).
    window.reportImageLoadError = function (url, reason) {
        show(url, reason);
    };

    return {
        messageFor: messageFor,
        show: show,
        hide: hide
    };
})();
