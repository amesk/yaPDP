/**
 * yaPDP — Touch zoom & pan for the machine pages.
 *
 * A phone in a browser can zoom the PAGE itself, and that is what the viewport
 * meta in pdp11.html allows. A STANDALONE context cannot: an iOS home-screen web
 * app has no page zoom at all, so a two-finger pinch there does nothing at all.
 * The emulator therefore has to understand the gesture itself.
 *
 * This module adds exactly that, on the pages that show a MACHINE — the front
 * panel, the Model 33 rig, the VT52/VT100 cabinets, the LP11 line printer and
 * the VT11 display:
 *   • two fingers pinch the picture open (and closed again, down to 1:1);
 *   • the same two fingers drag it around, and one finger pans once zoomed;
 *   • the transform goes on the PAGE element, so the navigation bar and the
 *     floating controls (all of them siblings of the pages, not children) stay
 *     where they are, and taps still reach the terminal — hit testing follows
 *     the transform.
 *
 * It is ADAPTIVE on purpose. While the BROWSER is zooming the page (a real
 * mobile browser: a tab or an iframe on the landing page), the visual viewport
 * scale moves during the gesture; the module notices on the first move and steps
 * aside, so there the gesture keeps the behaviour the browser already gives.
 * Standalone nothing moves that scale, and the emulator takes the gesture over.
 *
 * Every other page (CONFIG, Storage, Info) is left alone: its content is a form
 * or a document that the browser scrolls and zooms by itself.
 *
 * The scale arithmetic is DOM-free and exported, so it can be unit-tested in
 * Node (tests/touchzoom.test.js), mirroring src/mobile-input.js.
 *
 * Must be loaded before pdp11-app.js.
 */
"use strict";

var TouchZoom = (function () {
    // How far the picture may be opened. Four times is enough to read a caption
    // on the panel and to work a control on the Model 33, and it keeps the
    // bitmap of a terminal's tube from turning into a smear.
    var MAX_SCALE = 4;

    // The pages that show a machine. `#page-panel .frame` is scoped because
    // .frame is a generic name; everything else is a cabinet of its own.
    var MACHINE_SELECTOR = "#teletype-rig, .vt52-rig, .lp11-cabinet, " +
        ".vt11-container, #page-panel .frame";

    // --- the arithmetic (DOM-free) ------------------------------------
    function clampScale(scale, max) {
        if (!isFinite(scale) || scale <= 0) return 1;
        var top = (typeof max === "number" && max > 1) ? max : MAX_SCALE;
        if (scale < 1) return 1;
        return scale > top ? top : scale;
    }

    function isZoomed(scale) {
        return clampScale(scale) > 1.0001;
    }

    // The scale a pinch asks for: the start scale times how much farther apart
    // the fingers are now. A pinch that starts with the fingers already together
    // (a degenerate distance) keeps the scale it had.
    function pinchScale(startScale, startDistance, distance, max) {
        if (!isFinite(startDistance) || startDistance <= 0) return clampScale(startScale, max);
        if (!isFinite(distance) || distance < 0) return clampScale(startScale, max);
        return clampScale(startScale * (distance / startDistance), max);
    }

    // Where the page has to sit so that the point BETWEEN THE FINGERS stays under
    // them. With screen = pan + scale * local, the machine point that was under
    // the starting centroid is local = (centroid0 - pan0) / scale0, and keeping it
    // under the moving centroid means pan = centroid - scale * local. Growing from
    // the page's corner instead (the first version) threw the point the operator
    // was looking at out of view, and he had to zoom back out and pan to find it.
    function pinchPan(pan0, scale0, centroid0, centroid, scale) {
        var s0 = (typeof scale0 === "number" && isFinite(scale0) && scale0 > 0) ? scale0 : 1;
        var p0 = pan0 || {};
        var c0 = centroid0 || {};
        var c = centroid || {};
        var localX = ((isFinite(c0.x) ? c0.x : 0) - (isFinite(p0.x) ? p0.x : 0)) / s0;
        var localY = ((isFinite(c0.y) ? c0.y : 0) - (isFinite(p0.y) ? p0.y : 0)) / s0;
        var s = (typeof scale === "number" && isFinite(scale) && scale > 0) ? scale : 1;
        return {
            x: (isFinite(c.x) ? c.x : 0) - s * localX,
            y: (isFinite(c.y) ? c.y : 0) - s * localY
        };
    }

    // One axis of the pan. The page is scaled about its own top-left corner, so
    // its box grows to size*scale; the pan may only slide inside that box, never
    // past an edge (no empty margin can be dragged into view).
    function clampAxis(value, size, scale) {
        // Number() first: `null`, an absent pan and a string all have to end up
        // as a real pixel offset rather than as themselves.
        var v = Number(value);
        if (!isFinite(v)) v = 0;
        if (!isFinite(size) || size <= 0 || !isZoomed(scale)) return 0;
        var min = size * (1 - scale);          // a negative number
        if (v > 0) return 0;
        return v < min ? min : v;
    }

    function clampPan(pan, scale, width, height) {
        pan = (pan && typeof pan === "object") ? pan : {};
        return {
            x: clampAxis(pan.x, width, scale),
            y: clampAxis(pan.y, height, scale)
        };
    }

    // --- the pinned control blocks (DOM-free decision) ----------------
    // A machine page carries its own operator controls: the Model 33's row of
    // buttons, the printer's console and its Print/Save row, the front panel's
    // action buttons. They are CONTROLS, not part of the picture, so they must
    // not slide or grow with the zoom. The module moves them into a layer of
    // their own (see pinLayer) and gives THAT layer the inverse of the page's
    // transform: the layer sits at the page's origin, so scale(1/s) followed by
    // translate(-pan) cancels translate(pan) scale(s) exactly.
    var PINNED_SELECTOR = "#teletype-controls, .lp11-console, " +
        ".printer-actions, .panel-actions";
    var PIN_LAYER_CLASS = "touch-pin";

    function inverseTransform(scale, pan) {
        var s = (typeof scale === "number" && isFinite(scale) && scale > 0) ? scale : 1;
        var x = (pan && isFinite(pan.x)) ? pan.x : 0;
        var y = (pan && isFinite(pan.y)) ? pan.y : 0;
        return "scale(" + (1 / s) + ") translate(" + (-x) + "px, " + (-y) + "px)";
    }

    // --- gesture helpers (DOM-free decisions) -------------------------
    function touchDistance(touches) {
        if (!touches || touches.length < 2) return 0;
        var dx = touches[0].clientX - touches[1].clientX;
        var dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function touchCentroid(touches) {
        if (!touches || !touches.length) return { x: 0, y: 0 };
        var x = 0;
        var y = 0;
        for (var i = 0; i < touches.length; i++) {
            x += touches[i].clientX;
            y += touches[i].clientY;
        }
        return { x: x / touches.length, y: y / touches.length };
    }

    // --- the live page ------------------------------------------------
    var doc = null;
    var page = null;            // the page element the transform sits on
    var scale = 1;
    var pan = { x: 0, y: 0 };
    var gesture = null;
    var installed = false;

    function visualScale() {
        var vv = (typeof window !== "undefined") ? window.visualViewport : null;
        return (vv && typeof vv.scale === "number") ? vv.scale : 1;
    }

    function machinePage(d) {
        var active = d.querySelector(".page.active");
        if (!active) return null;
        return active.querySelector(MACHINE_SELECTOR) ? active : null;
    }

    // The layer the operator controls live in, created on first use inside a
    // machine page and filled once. The controls are MOVED into it (their ids and
    // wiring are position-independent — the app looks them up by id), so they are
    // no longer scaled by the page transform but by the layer's inverse of it.
    function pinLayer(p) {
        if (!p || !doc || !doc.createElement) return null;
        if (p.__touchPinLayer && p.__touchPinLayer.parentNode === p) {
            return p.__touchPinLayer;
        }
        var layer = doc.createElement("div");
        layer.className = PIN_LAYER_CLASS;
        // Appended LAST so the controls paint above the machine; the stylesheet
        // keeps the layer itself transparent to taps (only its children take them).
        p.appendChild(layer);
        p.__touchPinLayer = layer;
        var blocks = p.querySelectorAll(PINNED_SELECTOR);
        for (var i = 0; i < blocks.length; i++) layer.appendChild(blocks[i]);
        return layer;
    }

    function apply() {
        if (!page) return;
        if (!isZoomed(scale) && pan.x === 0 && pan.y === 0) {
            clearPinned();
            page.style.transform = "";
            page.style.transformOrigin = "";
            page.classList.remove("touch-zoomed");
            return;
        }
        // The controls first: they were laid out while the page was at 1:1, so
        // the layer has to cancel the transform that is about to be applied.
        applyPinned();
        // transform-origin is the top-left corner: the pan arithmetic above is
        // written for that, and it keeps the visible corner still while pinching.
        page.style.transformOrigin = "0 0";
        page.style.transform = "translate(" + pan.x + "px, " + pan.y + "px) " +
            "scale(" + scale + ")";
        page.classList.add("touch-zoomed");
    }

    function applyPinned() {
        var layer = pinLayer(page);
        if (!layer) return;
        layer.style.transformOrigin = "0 0";
        layer.style.transform = inverseTransform(scale, pan);
    }

    function clearPinned() {
        if (!page) return;
        var layer = page.__touchPinLayer;
        if (layer) layer.style.transform = "";
    }

    // Back to 1:1. Called when the operator leaves the page and by the tests.
    function reset() {
        if (page) {
            clearPinned();
            page.style.transform = "";
            page.style.transformOrigin = "";
            page.classList.remove("touch-zoomed");
        }
        scale = 1;
        pan = { x: 0, y: 0 };
        gesture = null;
    }

    function onTouchStart(ev) {
        var active = machinePage(doc);
        if (!active) return;
        if (active !== page) {
            // A different machine: the old page must not stay zoomed behind.
            reset();
            page = active;
        }
        var touches = ev.touches;
        if (touches.length === 2) {
            gesture = {
                mode: "pinch",
                startDistance: touchDistance(touches),
                startScale: scale,
                startPan: { x: pan.x, y: pan.y },
                startCentroid: touchCentroid(touches),
                viewportScale: visualScale()
            };
        } else if (touches.length === 1 && isZoomed(scale)) {
            // One finger pans a zoomed picture; at 1:1 it is a tap (or the rig's
            // own drag), so it is left alone.
            gesture = {
                mode: "pan",
                startPan: { x: pan.x, y: pan.y },
                startCentroid: { x: touches[0].clientX, y: touches[0].clientY },
                viewportScale: visualScale()
            };
        }
    }

    function onTouchMove(ev) {
        if (!page || !gesture) return;
        // The browser is zooming the page itself: it wins, and this module backs
        // out of the gesture entirely (the behaviour a mobile browser in a tab or
        // an iframe on the landing page already gives).
        if (visualScale() !== gesture.viewportScale) {
            reset();
            return;
        }
        var touches = ev.touches;
        var width = page.clientWidth;
        var height = page.clientHeight;
        if (gesture.mode === "pinch" && touches.length >= 2) {
            scale = pinchScale(gesture.startScale, gesture.startDistance,
                touchDistance(touches), MAX_SCALE);
            // Anchored on the fingers: the machine point that was between them
            // stays between them, so a two-finger drag pans and zooms at once.
            pan = pinchPan(gesture.startPan, gesture.startScale, gesture.startCentroid,
                touchCentroid(touches), scale);
        } else if (gesture.mode === "pan" && touches.length === 1 && isZoomed(scale)) {
            pan = {
                x: gesture.startPan.x + (touches[0].clientX - gesture.startCentroid.x),
                y: gesture.startPan.y + (touches[0].clientY - gesture.startCentroid.y)
            };
        } else {
            return;
        }
        var clamped = clampPan(pan, scale, width, height);
        pan = clamped;
        // Stop the browser's own scrolling/refresh for the gesture this module
        // took over (the listener is registered non-passive for this).
        if (ev.cancelable && typeof ev.preventDefault === "function") ev.preventDefault();
        apply();
    }

    function onTouchEnd(ev) {
        if (!gesture) return;
        if (!ev.touches || ev.touches.length === 0) {
            gesture = null;
            return;
        }
        // Lifting one finger of a pinch hands the gesture over to the finger that
        // stayed, anchored where it is — otherwise the picture would jump by the
        // distance the lifted finger used to contribute.
        if (gesture.mode === "pinch" && ev.touches.length === 1 && isZoomed(scale)) {
            gesture = {
                mode: "pan",
                startPan: { x: pan.x, y: pan.y },
                startCentroid: {
                    x: ev.touches[0].clientX,
                    y: ev.touches[0].clientY
                },
                viewportScale: visualScale()
            };
        }
    }

    // A page switch must not leave a zoomed page behind. The app switches pages
    // by toggling the `active` class, so watching that attribute is enough — and
    // it keeps this module free of app coupling. The undo is DEFERRED to a task
    // and happens ONCE per stale page: writing styles from inside the mutation
    // callback fed the app's own layout observers and locked the renderer up —
    // measured as the whole page going silent for minutes after a page switch.
    function watchPageSwitches() {
        if (typeof MutationObserver === "undefined") return;
        var pages = doc.querySelectorAll(".page");
        var observer = new MutationObserver(function () {
            if (!page) return;
            if (doc.querySelector(".page.active") !== page) setTimeout(releaseStalePage, 0);
        });
        for (var i = 0; i < pages.length; i++) {
            observer.observe(pages[i], { attributes: true, attributeFilter: ["class"] });
        }
    }

    // Undo the transform of a page that is no longer the visible one and forget
    // it: the module holds one page at a time, so this runs at most once for
    // each page the operator leaves.
    function releaseStalePage() {
        if (!page) return;
        if (doc && doc.querySelector(".page.active") === page) return;   // it came back
        var stale = page;
        var layer = stale.__touchPinLayer;
        page = null;
        scale = 1;
        pan = { x: 0, y: 0 };
        gesture = null;
        if (layer) layer.style.transform = "";
        stale.style.transform = "";
        stale.style.transformOrigin = "";
        stale.classList.remove("touch-zoomed");
    }

    // opts: { document: <Document> }. A desktop is left completely alone: the
    // browser's own zooming (Ctrl+wheel, trackpad pinch) is the right tool there,
    // and it is handled by the browser, not by this module.
    function install(opts) {
        opts = opts || {};
        var d = opts.document || (typeof document !== "undefined" ? document : null);
        if (!d || !d.body || installed) return false;
        var coarse = (typeof MobileInput !== "undefined")
            ? MobileInput.isCoarse()
            : false;
        if (!coarse) return false;
        doc = d;
        d.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
        d.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
        d.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
        d.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: true });
        d.body.classList.add("touch-gestures");
        installed = true;
        // Dock every machine page's operator controls straight away: on a touch
        // device they belong in the strip from the first frame, not only once the
        // operator happens to pinch. (pinLayer is idempotent.)
        var pages = d.querySelectorAll(".page");
        for (var i = 0; i < pages.length; i++) {
            if (pages[i].querySelector(MACHINE_SELECTOR)) pinLayer(pages[i]);
        }
        watchPageSwitches();
        return true;
    }

    return {
        MAX_SCALE: MAX_SCALE,
        PINNED_SELECTOR: PINNED_SELECTOR,
        install: install,
        reset: reset,
        inverseTransform: inverseTransform,
        clampScale: clampScale,
        isZoomed: isZoomed,
        pinchScale: pinchScale,
        pinchPan: pinchPan,
        clampAxis: clampAxis,
        clampPan: clampPan,
        touchDistance: touchDistance,
        touchCentroid: touchCentroid,
        // The live state, for tests and for the app when it needs to know.
        state: function () {
            return { scale: scale, pan: { x: pan.x, y: pan.y }, page: page };
        }
    };
})();

// Same explicit export as MobileInput/MobileKeys: pdp11-app.js installs it.
if (typeof window !== "undefined") {
    window.TouchZoom = TouchZoom;
}
