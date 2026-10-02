/**
 * yaPDP — Media download progress
 *
 * A single channel through which every disk/tape image fetch reports how much
 * of its body has arrived, and a thin status bar that shows the aggregate. It
 * exists because image loading is LAZY: the first time the machine reads a
 * block the whole .zst image is fetched, and on a slow link that can mean many
 * seconds of silence — during the quick-boot autoload, a manual BOOT, or a
 * mount alike. The bar answers "is it still downloading, and how far along".
 *
 * The bar is deliberately minimal: a 3px gold strip along the bottom edge and
 * a small "Loading N%" tag. It is pointer-events:none, sits BELOW the modal
 * overlays and the autoload toast (z-index 50000), and only appears after a
 * 150ms threshold so a warm-cache load never flickers it.
 *
 * fetchBytes(url) replaces response.arrayBuffer() with a streaming read that
 * publishes { loaded, total } as the body arrives. When the transfer is
 * content-encoded (e.g. GitHub Pages serves .zst as gzip, and the browser
 * transparently decodes the body) or has no Content-Length, total is -1 and
 * the bar falls back to an indeterminate sweep — never a lie like "134%".
 *
 * Public surface: window.__yapdpMediaProgress (browser) and module.exports
 * { MediaProgress } (Node tests). Test hooks: start/tick/finish/fail/percent.
 */
"use strict";

var MediaProgress = (function () {
    var jobs = {};            // url -> { loaded, total } (total -1 = indeterminate)
    var el = null;
    var bar = null;
    var label = null;
    var shownAt = 0;
    var hideTimer = null;

    var SHOW_DELAY_MS = 150;  // ignore sub-150ms downloads (cache hits)
    var HIDE_DELAY_MS = 400;  // linger briefly after the last job settles

    function totals() {
        var loaded = 0;
        var total = 0;
        var indeterminate = false;
        for (var url in jobs) {
            if (!Object.prototype.hasOwnProperty.call(jobs, url)) continue;
            var j = jobs[url];
            loaded += Math.max(0, j.loaded);
            if (j.total < 0) indeterminate = true;
            else total += j.total;
        }
        return { loaded: loaded, total: total, indeterminate: indeterminate };
    }

    function percent() {
        var t = totals();
        if (t.indeterminate || t.total <= 0) return null;
        var p = Math.round((t.loaded / t.total) * 100);
        return Math.max(0, Math.min(100, p));
    }

    function ensureEl() {
        if (el || typeof document === "undefined" || !document.body) return el;
        el = document.createElement("div");
        el.id = "yapdp-media-progress";
        el.className = "media-progress";
        el.setAttribute("role", "progressbar");
        el.setAttribute("aria-hidden", "true");

        label = document.createElement("div");
        label.className = "media-progress-label";

        var track = document.createElement("div");
        track.className = "media-progress-track";
        bar = document.createElement("div");
        bar.className = "media-progress-bar";
        track.appendChild(bar);

        el.appendChild(label);
        el.appendChild(track);
        document.body.appendChild(el);
        return el;
    }

    function render() {
        if (typeof document === "undefined") return;
        var root = ensureEl();
        if (!root) return;
        var p = percent();
        var visible = Object.keys(jobs).length > 0;
        if (visible && (Date.now() - shownAt) >= SHOW_DELAY_MS) {
            root.classList.add("visible");
            root.setAttribute("aria-hidden", "false");
        }
        if (bar) {
            bar.style.width = (p === null) ? "" : p + "%";
            bar.classList.toggle("indeterminate", p === null);
        }
        if (label) {
            label.textContent = (p === null) ? "Loading\u2026" : "Loading " + p + "%";
        }
        if (p !== null) root.setAttribute("aria-valuenow", String(p));
        else root.removeAttribute("aria-valuenow");
    }

    function emit() {
        var t = totals();
        if (typeof document !== "undefined" && typeof document.dispatchEvent === "function") {
            try {
                document.dispatchEvent(new CustomEvent("yapdp:media-progress", {
                    detail: { loaded: t.loaded, total: t.total, percent: percent() }
                }));
            } catch (err) { /* ignore: the bar still renders */ }
        }
        render();
    }

    function scheduleHide() {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            hideTimer = null;
            if (Object.keys(jobs).length === 0) {
                if (el) el.classList.remove("visible");
                if (el) el.setAttribute("aria-hidden", "true");
                shownAt = 0;
            }
        }, HIDE_DELAY_MS);
    }

    function start(url, total) {
        if (!url) return;
        if (!Object.prototype.hasOwnProperty.call(jobs, url)) shownAt = Date.now();
        jobs[url] = { loaded: 0, total: (typeof total === "number" ? total : -1) };
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        emit();
    }

    function tick(url, loaded) {
        var j = jobs[url];
        if (!j) return;
        j.loaded = loaded;
        emit();
    }

    function finish(url) {
        delete jobs[url];
        emit();
        scheduleHide();
    }

    function fail(url) {
        delete jobs[url];
        emit();
        scheduleHide();
    }

    function active() {
        return Object.keys(jobs).slice();
    }

    // Total bytes of an image body when it can be known, otherwise -1.
    function contentLengthOf(response) {
        var encoding = String(response.headers.get("content-encoding") || "")
            .trim().toLowerCase();
        var encoded = encoding && encoding !== "identity";
        if (encoded) return -1;
        var cl = parseInt(response.headers.get("content-length"), 10);
        return (Number.isFinite(cl) && cl > 0) ? cl : -1;
    }

    // Stream a fetch response while publishing progress. Resolves to
    // { bytes, response }; the caller still checks response.ok and applies
    // its own completeness assertion (assertCompleteImage in iopage.js).
    // One file, one download.
    //
    // Two callers can want the same image at the same moment — the disk
    // provider reading its first block and the "preparing" path asking for it
    // up front — and a page reload restarts the whole sequence. Each request
    // used to open its own fetch, so `jobs` accumulated entries and the
    // aggregate percentage jumped around as one download overtook another
    // (measured 2026-10-02: the bar "hopped back and forth, as if two images
    // were loading in parallel"). In-flight requests are shared instead: the
    // same url gets the same promise, so there is one job and one honest
    // percentage, and the second caller simply waits for the first download.
    var inflight = {};

    function fetchBytes(url) {
        if (inflight[url]) return inflight[url];
        var p = doFetchBytes(url);
        inflight[url] = p;
        // Clear the slot when the download settles, success or failure, so a
        // later request (a re-mount, a cache drop) fetches afresh instead of
        // receiving a settled promise forever.
        var clear = function () { delete inflight[url]; };
        p.then(clear, clear);
        return p;
    }

    function doFetchBytes(url) {
        return fetch(url).then(function (response) {
            if (!response.ok) {
                // A 404/error body is not a download worth measuring.
                return { bytes: new Uint8Array(0), response: response };
            }
            var body = response.body;
            var total = contentLengthOf(response);
            if (!body || typeof body.getReader !== "function") {
                // No streaming body (older engine): indeterminate, then done.
                start(url, -1);
                return response.arrayBuffer().then(function (buf) {
                    finish(url);
                    return { bytes: new Uint8Array(buf), response: response };
                });
            }
            start(url, total);
            var reader = body.getReader();
            var chunks = [];
            var loaded = 0;
            function pump(res) {
                if (res.done) {
                    var merged = new Uint8Array(loaded);
                    var off = 0;
                    for (var i = 0; i < chunks.length; i++) {
                        merged.set(chunks[i], off);
                        off += chunks[i].length;
                    }
                    finish(url);
                    return { bytes: merged, response: response };
                }
                var piece = new Uint8Array(res.value);
                chunks.push(piece);
                loaded += piece.length;
                tick(url, loaded);
                return reader.read().then(pump);
            }
            return reader.read().then(pump);
        }).catch(function (err) {
            fail(url);
            throw err;
        });
    }

    return {
        start: start,
        tick: tick,
        finish: finish,
        fail: fail,
        active: active,
        percent: percent,
        totals: totals,
        fetchBytes: fetchBytes
    };
})();

if (typeof window !== "undefined") window.__yapdpMediaProgress = MediaProgress;
if (typeof module !== "undefined" && module.exports) module.exports = { MediaProgress: MediaProgress };
