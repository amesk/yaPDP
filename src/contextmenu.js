/**
 * yaPDP — Global context-menu suppression.
 *
 * The emulator is an authentic front-panel "kiosk": right-click must never
 * open the browser/system context menu over the machine, in the plain browser
 * or in the Tauri webview alike. This module installs a page-wide
 * `contextmenu` handler that cancels the native menu.
 *
 * The helper is DOM-free and takes an explicit runtime object, so the module
 * can be unit-tested in Node (see tests/contextmenu.test.js), mirroring
 * src/fullscreen.js.
 *
 * Must be loaded before pdp11-app.js.
 */
"use strict";

var ContextMenu = (function () {
    "use strict";

    // Install a window-level `contextmenu` handler that cancels the native
    // menu. `win` is injectable for tests; the browser global is used by
    // default. Returns true when the handler was installed.
    function block(win) {
        win = win || (typeof window !== "undefined" ? window : null);
        if (!win || typeof win.addEventListener !== "function") return false;
        win.addEventListener("contextmenu", function (e) {
            if (e && typeof e.preventDefault === "function") {
                e.preventDefault();
            }
        });
        return true;
    }

    return {
        block: block
    };
})();

// Install as early as possible. The module is loaded at the end of <body>, so
// the DOM is usually already available; wait for DOMContentLoaded otherwise.
if (typeof document !== "undefined" && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
        ContextMenu.block();
    });
} else {
    ContextMenu.block();
}
