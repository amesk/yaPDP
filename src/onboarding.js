/**
 * yaPDP — First-run onboarding hint
 *
 * On the very first launch (no saved flag in localStorage) a short modal
 * overlay explains what the user can do right away: which page to open,
 * which guest OSes are mounted and the exact `boot` command for each,
 * plus the drag & drop fallback for additional images.
 *
 * The flag is written to localStorage only when the user dismisses the
 * overlay, so closing the app before reading it shows the hint again on
 * the next launch. A "Show first-run hint" checkbox on the CONFIG|BEHAVIOUR
 * page calls setEnabled(), which clears or sets the flag, so the hint can be
 * re-shown on the next launch at any time.
 *
 * Single source of truth:
 *   The url -> OS -> boot-command mapping is NOT copied here. It is parsed
 *   at runtime from the "Guest Operating Systems" table on the Info page
 *   (<table id="guest-os-table"> in pdp11.html), so the hint always stays
 *   in sync with the documentation. parseBootRow() is pure and DOM-free;
 *   loadBootTable() adapts it to the live table element.
 *
 * The suggested boots are filtered by DataLoader.list() at display time.
 * In the desktop builds the bundled images are mounted asynchronously by
 * tauri-bundled.js, so while the overlay is visible the boots list is
 * refreshed on a short timer until it stabilises.
 *
 * Must be loaded AFTER iopage.js (defines DataLoader) and BEFORE
 * pdp11-app.js, which calls onboarding.init() during bootstrap.
 */
"use strict";

var Onboarding = (function () {
    var ONBOARDING_KEY = "yapdp.onboarding.v1";
    var FLAG_VALUE = "done";
    var MAX_SUGGESTIONS = 4;
    var bootTable = null; // cached [{url, device, label, boot}] from Info page

    // ------------------------------------------------------------------
    // Pure helpers (no DOM) — unit-testable in Node
    // ------------------------------------------------------------------

    function getStorage() {
        try {
            return window.localStorage;
        } catch (err) {
            return null;
        }
    }

    // Decide whether the onboarding overlay should appear this launch.
    function shouldShowOnboarding(storage) {
        if (!storage) return false; // storage unavailable — do not nag
        try {
            return storage.getItem(ONBOARDING_KEY) !== FLAG_VALUE;
        } catch (err) {
            return false;
        }
    }

    // Record that the user has seen the hint.
    function markSeen(storage) {
        if (!storage) return;
        try {
            storage.setItem(ONBOARDING_KEY, FLAG_VALUE);
        } catch (err) { /* ignore */ }
    }

    // Forget the hint flag so it shows again.
    function clearFlag(storage) {
        if (!storage) return;
        try {
            storage.removeItem(ONBOARDING_KEY);
        } catch (err) { /* ignore */ }
    }

    // Whether the first-run hint should appear at launch: true while the
    // "seen" flag is unset. Backs the CONFIG|BEHAVIOUR "Show first-run hint"
    // checkbox (see syncHintCheckbox in the overlay section).
    function isEnabled() {
        return shouldShowOnboarding(getStorage());
    }

    // Turn the first-run hint on (clear the seen flag so it shows again on the
    // next launch) or off (mark it as seen so it stays hidden).
    function setEnabled(enabled) {
        if (enabled) {
            clearFlag(getStorage());
        } else {
            markSeen(getStorage());
        }
    }

    // Devices whose boot loader prompts with a symbol other than `Boot>`.
    // Keyed by device (not by image url) and used only as a UI hint for the
    // quick-start overlay — the authoritative sequence stays in the Info page.
    var PROMPT_HINT = {
        rk0: "@" // Unix V5 boot loader asks for the kernel name at the '@' prompt
    };

    // Parse one row of the Info page "Guest Operating Systems" table.
    // cells = the three <td> elements: [disk, system, how-to-boot].
    // Returns {url, device, label, boot, next, prompt} or null if the row is
    // not a standard boot row (e.g. a header row).
    //
    // `next` is the first follow-up input after `boot <dev>` — taken from the
    // second <code> in the "How to Boot" cell (e.g. "unix" for Unix V5). It is
    // only reported when that code is NOT a login credential: the text between
    // the boot command and that code must not contain "login"/"password"
    // (otherwise the code is a username/password, not a boot-time input).
    function parseBootRow(cells) {
        if (!cells || cells.length < 3) return null;
        var diskEl = cells[0], sysEl = cells[1], howEl = cells[2];
        if (!diskEl || !sysEl || !howEl) return null;

        var codes = howEl.querySelectorAll ? howEl.querySelectorAll("code") : [];
        var bootCmd = codes && codes[0] && codes[0].textContent
            ? codes[0].textContent.trim() : "";
        var m = /^boot\s+([a-z]{2}[0-9])/i.exec(bootCmd);
        if (!m) return null;

        var device = m[1].toLowerCase();
        var next = "";
        if (codes.length > 1 && codes[1].textContent) {
            var raw = howEl.textContent || "";
            var start = raw.indexOf(bootCmd);
            if (start !== -1) {
                start += bootCmd.length;
                var idx = raw.indexOf(codes[1].textContent, start);
                if (idx !== -1 && !/login|password/i.test(raw.slice(start, idx))) {
                    next = codes[1].textContent.trim();
                }
            }
        }

        return {
            url: device + (/^tm/i.test(device) ? ".tap" : ".dsk"),
            device: device,
            label: sysEl.textContent ? sysEl.textContent.trim() : device,
            boot: "boot " + device,
            next: next,
            prompt: PROMPT_HINT[device] || ""
        };
    }

    // Adapt parseBootRow() to the live table element.
    function loadBootTable(tableEl) {
        var rows = [];
        if (!tableEl || !tableEl.querySelector) return rows;
        var body = tableEl.querySelector("tbody");
        if (!body || !body.querySelectorAll) return rows;
        var trs = body.querySelectorAll("tr");
        for (var i = 0; i < trs.length; i++) {
            var row = parseBootRow(trs[i].cells);
            if (row) rows.push(row);
        }
        return rows;
    }

    // Filter the boot table to the currently mounted images, capped at
    // MAX_SUGGESTIONS (table order doubles as suggestion priority).
    function collectBootRows(images, table) {
        var mounted = {};
        (images || []).forEach(function (url) { mounted[url] = true; });
        var rows = [];
        (table || []).forEach(function (entry) {
            if (rows.length >= MAX_SUGGESTIONS) return;
            if (mounted[entry.url]) rows.push(entry);
        });
        return rows;
    }

    // How many bootable guest OSes are mounted (for the "+N more" line).
    function countBootable(images, table) {
        var mounted = {};
        (images || []).forEach(function (url) { mounted[url] = true; });
        var n = 0;
        (table || []).forEach(function (entry) { if (mounted[entry.url]) n++; });
        return n;
    }

    function mountedImages() {
        if (typeof DataLoader === "undefined" || !DataLoader ||
            typeof DataLoader.list !== "function") {
            return [];
        }
        return DataLoader.list();
    }

    // ------------------------------------------------------------------
    // Overlay DOM (browser only — not exercised by the Node tests)
    // ------------------------------------------------------------------

    var overlay = null;
    var refreshTimer = null;

    function ensureOverlay() {
        if (overlay) return overlay;
        overlay = document.createElement("div");
        overlay.id = "modal-overlay";
        overlay.className = "modal-overlay";
        // Delegate clicks: the "Got it" button and a click on the backdrop
        // both dismiss the overlay.
        overlay.addEventListener("click", function (e) {
            if (e.target === overlay ||
                (e.target.closest && e.target.closest(".modal-close"))) {
                hide();
            }
        });
        document.body.appendChild(overlay);
        return overlay;
    }

    function boxHtml() {
        return (
            '<div class="modal-box">' +
                '<span class="modal-title">Welcome to yaPDP — the PDP-11/70</span>' +
                '<p class="modal-intro">Here is how to get going in 30 seconds:</p>' +
                '<ol class="modal-steps">' +
                    '<li>Open the <b>Console</b> page in the left sidebar.</li>' +
                    '<li>At the <code>Boot></code> prompt type one of:</li>' +
                '</ol>' +
                '<ul class="modal-boots" id="modal-boots"></ul>' +
                '<p class="modal-drag">Missing an OS? Drag a <code>.dsk</code> / ' +
                    '<code>.tap</code> / <code>.ptap</code> / <code>.zst</code> image ' +
                    'into the <b>Drop zone</b> on the <b>Storage</b> page, or open ' +
                    '<b>Info</b> for the full OS list.</p>' +
                '<button type="button" class="modal-close">Got it</button>' +
            '</div>'
        );
    }

    function bootListItem(row) {
        var extra = "";
        if (row.next) {
            if (row.prompt) {
                extra = ' &mdash; at the <code>' + row.prompt +
                    '</code> prompt type <code>' + row.next + '</code>';
            } else {
                extra = ' &mdash; then type <code>' + row.next + '</code>';
            }
        }
        return '<li class="modal-boot"><code>' + row.boot +
            '</code> &mdash; ' + row.label + extra + '</li>';
    }

    function updateBoots() {
        var el = document.getElementById("modal-boots");
        if (!el) return;
        var table = bootTable || [];
        var images = mountedImages();
        var rows = collectBootRows(images, table);
        var total = countBootable(images, table);
        var html = "";
        if (rows.length) {
            rows.forEach(function (r) { html += bootListItem(r); });
            if (total > rows.length) {
                html += '<li class="modal-boot modal-more">+ ' +
                    (total - rows.length) + ' more on the Info page</li>';
            }
        } else if (table.length) {
            // Nothing bootable mounted yet (bundled images may still be
            // loading, or this is a browser session with no images at all)
            // — show the first two documented suggestions anyway.
            table.slice(0, 2).forEach(function (r) { html += bootListItem(r); });
        } else {
            html += '<li class="modal-boot">Type <code>boot rk0</code> (Unix V5) ' +
                'or <code>boot rk1</code> (RT-11)</li>';
        }
        el.innerHTML = html;
    }

    // Refresh the boots list while the overlay is visible so suggestions
    // become accurate once the asynchronously mounted bundled images land.
    function scheduleRefresh() {
        if (refreshTimer) return;
        var tries = 0;
        refreshTimer = setInterval(function () {
            tries++;
            if (!overlay || !overlay.classList.contains("visible")) {
                stopRefresh();
                return;
            }
            updateBoots();
            if (tries >= 12) stopRefresh(); // ~3s max
        }, 250);
    }

    function stopRefresh() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
    }

    function show() {
        var el = ensureOverlay();
        el.innerHTML = boxHtml();
        updateBoots();
        el.classList.add("visible");
        scheduleRefresh();
    }

    function hide() {
        stopRefresh();
        if (overlay) overlay.classList.remove("visible");
        markSeen(getStorage());
        syncHintCheckbox();
    }

    // Keep the CONFIG|BEHAVIOUR "Show first-run hint" checkbox in sync with the
    // underlying flag: dismissing the overlay marks the hint as seen, so the
    // checkbox must reflect that it will not auto-show on the next launch.
    function syncHintCheckbox() {
        var cb = document.getElementById("config-showFirstRunHint");
        if (cb) cb.checked = isEnabled();
    }

    // Called from pdp11-app.js during bootstrap — first-run gate.
    function init() {
        if (bootTable === null) {
            bootTable = loadBootTable(document.getElementById("guest-os-table"));
        }
        if (shouldShowOnboarding(getStorage())) {
            show();
        }
    }

    return {
        ONBOARDING_KEY: ONBOARDING_KEY,
        init: init,
        show: show,
        hide: hide,
        isEnabled: isEnabled,
        setEnabled: setEnabled,
        shouldShowOnboarding: shouldShowOnboarding,
        markSeen: markSeen,
        clearFlag: clearFlag,
        parseBootRow: parseBootRow,
        loadBootTable: loadBootTable,
        collectBootRows: collectBootRows,
        countBootable: countBootable
    };
})();
