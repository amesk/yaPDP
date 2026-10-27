/**
 * screenshot.js — Take a PNG screenshot of the emulator view.
 *
 * A round camera-icon button fixed to the bottom-left corner, next to the
 * mute button. Left-click saves a PNG screenshot of the emulator's console
 * and panel; right-click opens a context menu with additional options.
 *
 * Must be loaded AFTER pdp11-app.js (for the mute button pattern) and
 * BEFORE the closing </body> in pdp11.html.
 *
 * Screenshot capture:
 *   The emulator renders its console and panel into <canvas> elements.
 *   We composite them into a single image via a temporary canvas, then
 *   convert to PNG via .toBlob('image/png', callback).
 *
 * Context menu (right-click):
 *   - Save image       — download the PNG file
 *   - Copy to clipboard — copy the PNG data to the system clipboard
 *   - Share…           — invoke the Web Share API (mobile-friendly)
 */
"use strict";

(function () {
    if (typeof document === "undefined") return;

    var btn = document.getElementById("screenshot-btn");
    if (!btn) return;

    // ── Helpers ────────────────────────────────────────────────────────

    // canvas.toBlob(callback, type) is asynchronous.  Wrap it in a Promise.
    function canvasToBlob(canvas, type) {
        type = type || "image/png";
        return new Promise(function(resolve, reject) {
            try {
                canvas.toBlob(function(blob) {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('toBlob returned null'));
                    }
                }, type);
            } catch (e) {
                reject(e);
            }
        });
    }

    // Build a timestamp-based filename for the downloaded PNG.
    function stampName() {
        var ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
        return "yapdp-" + ts + ".png";
    }

    // Fire-and-forget toast helper: the Toasts subsystem (src/toasts.js) owns
    // the queue/timing; a missing subsystem is a silent no-op.
    function toast(opts) {
        if (typeof Toasts !== "undefined" && typeof Toasts.show === "function") {
            Toasts.show(opts);
        }
    }

    // ── Capture ────────────────────────────────────────────────────────
    // Capture the active page as a canvas.  Returns a Promise<HTMLCanvasElement|null>.
    // Uses html2canvas (when available) to render the entire page (cabinet,
    // bezel, screen, panel) into a single image.  Falls back to capturing
    // just the console canvas.
    function captureScreenshot() {
        // Try html2canvas first — captures the entire active page including
        // the terminal cabinet, bezel, and screen.
        if (typeof html2canvas === "function") {
            var target = document.querySelector(".page.active") || document.body;
            return html2canvas(target, {
                useCORS: false,
                scale: 1,
                width: target.clientWidth,
                height: target.clientHeight,
                // .page is transparent (the body photo backdrop shows
                // through), so html2canvas falls back to its default white
                // canvas fill. Match the emulator's dark colour scheme instead.
                backgroundColor: "#000",
            });
        }

        // Fallback: capture just the console canvas.
        var activePage = document.querySelector(".page.active");
        var consoleCanvas = activePage
            ? activePage.querySelector("canvas")
            : document.querySelector("canvas[width]");
        if (!consoleCanvas) return Promise.resolve(null);

        var cw = consoleCanvas.width;
        var ch = consoleCanvas.height;
        if (cw < 1 || ch < 1) return Promise.resolve(null);

        var temp = document.createElement("canvas");
        temp.width = cw;
        temp.height = ch;
        var ctx = temp.getContext("2d");
        if (!ctx) return Promise.resolve(null);

        ctx.drawImage(consoleCanvas, 0, 0);
        return Promise.resolve(temp);
    }

    // ── Save as file ───────────────────────────────────────────────────
    function saveScreenshot(canvas) {
        if (!canvas) return;
        var name = stampName();
        canvasToBlob(canvas).then(function (blob) {
            try {
                var url = URL.createObjectURL(blob);
                var a = document.createElement("a");
                a.href = url;
                a.download = name;
                a.click();
                URL.revokeObjectURL(url);
                // Saving succeeds silently: the browser's own download UI is
                // feedback enough. Only a real failure raises a toast.
            } catch (e) {
                // Fallback: data-URL.
                try {
                    var dataUrl = canvas.toDataURL("image/png");
                    var a = document.createElement("a");
                    a.href = dataUrl;
                    a.download = name;
                    a.click();
                } catch (e2) {
                    toast({ text: "Could not save screenshot", category: "error" });
                }
            }
        });
    }

    // ── Copy to clipboard ──────────────────────────────────────────────
    function copyScreenshot(canvas) {
        if (!canvas) return;
        if (typeof navigator === "undefined" || !navigator.clipboard) return;
        
        
        if (canvas.width === 0 || canvas.height === 0) {
            return;
        }
        
        canvasToBlob(canvas, "image/png").then(function (blob) {
            if (!blob) return;

            if (typeof ClipboardItem !== "undefined" &&
                typeof navigator.clipboard.write === "function") {
                navigator.clipboard.write([
                    new ClipboardItem({ "image/png": blob })
                ]).then(function () {
                    toast({ text: "Copied to clipboard", category: "info" });
                }).catch(function () {
                    toast({ text: "Could not copy screenshot", category: "error" });
                });
            } 
            else if (typeof navigator.clipboard.writeText === "function") {
                navigator.clipboard.writeText(
                    canvas.toDataURL("image/png")
                ).then(function () {
                    toast({ text: "Copied to clipboard", category: "info" });
                }).catch(function () {
                    toast({ text: "Could not copy screenshot", category: "error" });
                });
            }
        }).catch(function () {
            toast({ text: "Could not copy screenshot", category: "error" });
        });
    }
    
    // ── Share via Web Share API ────────────────────────────────────────
    // Prepare the PNG before the Share click. Web Share must be invoked from
    // the click handler itself while transient user activation is still valid.
    function prepareShareFile(canvas) {
        if (!canvas || typeof File === "undefined") {
            return Promise.reject(new Error("File sharing is not supported"));
        }
        return canvasToBlob(canvas, "image/png").then(function (blob) {
            var file = new File([blob], stampName(), { type: "image/png" });
            if (typeof navigator.canShare !== "function" ||
                !navigator.canShare({ files: [file] })) {
                throw new Error("Sharing image files is not supported by this browser");
            }
            return file;
        });
    }

    function shareScreenshot(file) {
        if (!file || typeof navigator === "undefined" ||
            typeof navigator.share !== "function") {
            toast({ text: "Sharing screenshots is not supported", category: "error" });
            return;
        }

        // Do not await anything before this call: it must remain directly
        // inside the trusted click handler to open Android's share sheet.
        try {
            var result = navigator.share({
                files: [file],
                title: "yaPDP — PDP-11/70 emulator screenshot",
                text: "A screenshot from the yaPDP PDP-11/70 web emulator"
            });
            if (result && typeof result.catch === "function") {
                result.catch(function (error) {
                    // User cancellation is expected and should stay silent.
                    if (!error || error.name !== "AbortError") {
                        toast({ text: "Could not share screenshot", category: "error" });
                    }
                });
            }
        } catch (error) {
            toast({ text: "Could not share screenshot", category: "error" });
        }
    }

    // ── Context menu ───────────────────────────────────────────────────
    var contextMenu = null;

    function showContextMenu(e) {
        e.preventDefault();
        hideContextMenu();

        contextMenu = document.createElement("div");
        contextMenu.className = "screenshot-context-menu";
        contextMenu.setAttribute("role", "menu");

        // Save and Copy capture lazily when selected. Share is different:
        // prepare its PNG while the menu is open, so the subsequent Share
        // click can call navigator.share() synchronously with user activation.
        var shareFile = null;
        var shareItem = null;
        var items = [
            { label: "Save image", action: function () {
                captureScreenshot().then(function (c) { if (c) saveScreenshot(c); });
            }},
            { label: "Copy to clipboard", action: function () {
                captureScreenshot().then(function (c) { if (c) copyScreenshot(c); });
            }},
        ];
        if (typeof navigator !== "undefined" && navigator.share) {
            shareItem = {
                label: "Share…",
                disabled: true,
                action: function () {
                    if (shareFile) shareScreenshot(shareFile);
                }
            };
            items.push(shareItem);
        }

        for (var i = 0; i < items.length; i++) {
            (function (itemData) {
                var item = document.createElement("button");
                item.className = "screenshot-context-item";
                item.textContent = itemData.label;
                item.disabled = !!itemData.disabled;
                item.addEventListener("click", function () {
                    if (item.disabled) return;
                    hideContextMenu();
                    itemData.action();
                });
                contextMenu.appendChild(item);
            })(items[i]);
        }

        // Position the menu, flipping above the cursor when there is not
        // enough room below.
        var menuW = 180;
        var menuH = items.length * 32 + 8;
        var vpW = document.documentElement.clientWidth;
        var vpH = document.documentElement.clientHeight;
        var left = Math.min(e.clientX, vpW - menuW);
        var top_ = e.clientY;
        if (top_ + menuH > vpH) top_ = Math.max(0, vpH - menuH);
        contextMenu.style.left = left + "px";
        contextMenu.style.top = top_ + "px";

        document.body.appendChild(contextMenu);

        if (shareItem) {
            var shareButton = contextMenu.querySelector("button:last-child");
            captureScreenshot().then(prepareShareFile).then(function (file) {
                shareFile = file;
                if (shareButton && shareButton.isConnected) shareButton.disabled = false;
            }).catch(function () {
                if (shareButton && shareButton.isConnected) {
                    shareButton.title = "Could not prepare screenshot for sharing";
                }
                toast({ text: "Could not prepare screenshot for sharing", category: "error" });
            });
        }
    }

    function hideContextMenu() {
        if (contextMenu) {
            contextMenu.remove();
            contextMenu = null;
        }
    }

    // ── Wire events ────────────────────────────────────────────────────
    btn.addEventListener("click", function (e) {
        if (e.button !== 0) return;
        captureScreenshot().then(function (c) { if (c) saveScreenshot(c); });
    });

    btn.addEventListener("contextmenu", function (e) {
        showContextMenu(e);
    });

    document.addEventListener("click", function (e) {
        if (contextMenu && !contextMenu.contains(e.target)) {
            hideContextMenu();
        }
    });

    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && contextMenu) {
            hideContextMenu();
        }
    });
})();