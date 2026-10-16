/**
 * yaPDP — Lightbox
 *
 * A minimal full-screen image viewer (click a thumbnail to see the image
 * large, click anywhere or press Esc to close). Kept as a standalone module on
 * purpose: the Scenario tab of the quick-boot wizard uses it for the saved
 * machine-state screenshots (src/quickboot.js), but any other surface that
 * shows a small preview of a larger image (galleries, snapshots, manuals) can
 * call the same two functions instead of reimplementing an overlay.
 *
 * The overlay reuses the shared .modal-overlay look (css/pdp11.css) but sits
 * one layer above the dialogs (z-index 100001 > 100000), so a lightbox opened
 * from inside a modal (the quick-boot dialog) covers it instead of hiding
 * behind it.
 *
 * API:
 *   Lightbox.show(src, alt)  — open src; alt becomes the caption (and the
 *                              img attribute, so a broken image still reads).
 *   Lightbox.hide()          — close; also closes on backdrop click / Esc.
 *
 * The DOM is built with createElement/textContent (never innerHTML with the
 * src — an image URL must not become markup).
 *
 * Load order: any time before the first show() call (pdp11.html loads it
 * before src/quickboot.js).
 */
"use strict";

var Lightbox = (function () {
    // Singleton overlay, created on first show().
    var overlay = null;

    function ensure() {
        if (overlay) return overlay;

        overlay = document.createElement("div");
        overlay.className = "lightbox-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");

        var img = document.createElement("img");
        img.className = "lightbox-image";
        img.alt = "";
        overlay.appendChild(img);

        var caption = document.createElement("div");
        caption.className = "lightbox-caption";
        caption.textContent = "";
        overlay.appendChild(caption);

        // Backdrop click closes. A click on the image itself does not — the
        // operator may be studying the picture — EXCEPT on a touch-only
        // device, where the backdrop is not reachable, so any tap closes.
        var touchOnly = typeof window.matchMedia === "function" &&
            window.matchMedia("(hover: none) and (pointer: coarse)").matches;
        overlay.addEventListener("click", function (e) {
            if (e.target === overlay || (touchOnly && e.target === overlay.querySelector(".lightbox-image"))) {
                hide();
            }
        });

        document.body.appendChild(overlay);
        return overlay;
    }

    function show(src, alt) {
        var el = ensure();
        var img = el.querySelector(".lightbox-image");
        img.src = String(src || "");
        img.alt = String(alt || "");
        el.querySelector(".lightbox-caption").textContent = String(alt || "");
        el.classList.add("visible");
    }

    function hide() {
        if (!overlay) return;
        overlay.classList.remove("visible");
        // Let the image stop loading once the viewer is gone.
        var img = overlay.querySelector(".lightbox-image");
        if (img) img.removeAttribute("src");
    }

    // Esc anywhere closes the viewer (matches the shared modal dialogs).
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" || e.keyCode === 27) hide();
    });

    return {
        show: show,
        hide: hide
    };
})();

if (typeof window !== "undefined") window.Lightbox = Lightbox;