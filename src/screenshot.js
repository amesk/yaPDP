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
        canvasToBlob(canvas).then(function (blob) {
            try {
                var url = URL.createObjectURL(blob);
                var a = document.createElement("a");
                a.href = url;
                a.download = stampName();
                a.click();
                URL.revokeObjectURL(url);
            } catch (e) {
                // Fallback: data-URL.
                try {
                    var dataUrl = canvas.toDataURL("image/png");
                    var a = document.createElement("a");
                    a.href = dataUrl;
                    a.download = stampName();
                    a.click();
                } catch (e2) { /* give up */ }
            }
        });
    }

    // ── Copy to clipboard ──────────────────────────────────────────────
    function copyScreenshot(canvas) {
        if (!canvas) return;
        if (typeof navigator === "undefined" || !navigator.clipboard) return;
        
        // Диагностика
        console.log('Canvas dimensions:', canvas.width, 'x', canvas.height);
        console.log('Canvas context:', !!canvas.getContext);
        
        if (canvas.width === 0 || canvas.height === 0) {
            console.error('Canvas has zero dimensions');
            return;
        }
        
        canvasToBlob(canvas, "image/png").then(function (blob) {
            if (!blob) {
                console.error('toBlob returned null - canvas may be empty or tainted');
                return;
            }

            if (typeof ClipboardItem !== "undefined" &&
                typeof navigator.clipboard.write === "function") {
                navigator.clipboard.write([
                    new ClipboardItem({ "image/png": blob })
                ]).catch(function (err) {
                    console.warn('Clipboard write failed:', err);
                });
            } 
            else if (typeof navigator.clipboard.writeText === "function") {
                navigator.clipboard.writeText(
                    canvas.toDataURL("image/png")
                ).catch(function (err) {
                    console.warn('Clipboard writeText failed:', err);
                });
            }
        }).catch(function(err) {
            console.error('Canvas to blob conversion failed:', err);
        });
    }
    
    // ── Share via Web Share API ────────────────────────────────────────
    function shareScreenshot(canvas) {
        if (!canvas) return;
        if (typeof navigator !== "undefined" && navigator.share &&
            typeof navigator.share === "function") {
            navigator.share({
                title: "yaPDP — PDP-11/70 emulator screenshot",
                text: "A screenshot from the yaPDP PDP-11/70 web emulator"
            }).catch(function () { /* ignore share errors */ });
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

        // Capture the screenshot lazily — when the user picks an action,
        // not when they right-click.  This way the menu always appears,
        // even on pages without a canvas (e.g. the panel page).
        // captureScreenshot() now returns a Promise<canvas|null>.
        var items = [
            { label: "Save image", action: function () {
                captureScreenshot().then(function (c) { if (c) saveScreenshot(c); });
            }},
            { label: "Copy to clipboard", action: function () {
                captureScreenshot().then(function (c) { if (c) copyScreenshot(c); });
            }},
        ];
        if (typeof navigator !== "undefined" && navigator.share) {
            items.push({ label: "Share\u2026", action: function () {
                captureScreenshot().then(function (c) { if (c) shareScreenshot(c); });
            }});
        }

        for (var i = 0; i < items.length; i++) {
            (function (itemData) {
                var item = document.createElement("button");
                item.className = "screenshot-context-item";
                item.textContent = itemData.label;
                item.addEventListener("click", function () {
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