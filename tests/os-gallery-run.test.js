#!/usr/bin/env node
/**
 * Guest-OS gallery RUN links and the ?boot= deep link between them.
 *
 * Both landing pages — the classic index.html at the repo root and the React
 * SPA in landing/ — offer a Run button per guest OS. Each button carries a
 * QuickBoot SCENARIO key, never a disk URL: the emulator resolves the key
 * through OSBoot and brings the machine up with that scenario's hardware
 * profile (console, printer, VT11, force-upper). That is the whole point of
 * the split, and it is why the landing must never learn about hardware.
 *
 * What is pinned here, and why each failure is worth catching:
 *
 *   1. every key on either page resolves to a real scenario in src/osboot.js —
 *      a renamed or mistyped device key turns Run into a dead button, and the
 *      click looks like a broken page rather than a bad link;
 *   2. the two galleries offer the SAME set of guest OSes — a key added on one
 *      side and forgotten on the other is invisible in review;
 *   3. one RUN link per card in the classic carousel, each unique — the cards
 *      are cloned by the carousel script, so a copy-paste that leaves two
 *      tiles booting the same OS would show up as a silent duplicate;
 *   4. the classic carousel keeps the guard that stops a RUN click from also
 *      opening the lightbox (the whole card is clickable);
 *   5. QuickBoot.deviceFromSearch() — the emulator half of the contract:
 *      valid keys pass, unknown keys and malformed escapes return null instead
 *      of throwing halfway through page load, and the parameter composes with
 *      the other switches (?core=, ?bridge=).
 *
 * No browser: the pages are read as text and the two production modules are
 * driven in a VM sandbox, the same way tests/osboot.test.js does it.
 *
 * Run with:  node tests/os-gallery-run.test.js
 *
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const OSBOOT_PATH = path.join(ROOT, "src", "osboot.js");
const STEPENGINE_PATH = path.join(ROOT, "src", "step-engine.js");
const QUICKBOOT_PATH = path.join(ROOT, "src", "quickboot.js");
const CLASSIC_PATH = path.join(ROOT, "index.html");
const LANDING_DATA_PATH = path.join(ROOT, "landing", "src", "data.ts");

function loadModules() {
    const sandbox = { console, window: {}, setTimeout: setTimeout };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(OSBOOT_PATH, "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(STEPENGINE_PATH, "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(QUICKBOOT_PATH, "utf8"), sandbox);
    return { OSBoot: sandbox.OSBoot, QuickBoot: sandbox.QuickBoot };
}

// Device keys the classic page advertises, in document order. A RUN link is an
// <a class="run-btn" href="pdp11.html?boot=<device>">, so a link without the
// parameter is a failure in itself, not something to skip.
function classicRunKeys(html) {
    return [...html.matchAll(/<a\b[^>]*class="run-btn"[^>]*>/g)].map(function (m) {
        const href = /href="pdp11\.html\?boot=([a-z0-9]+)"/.exec(m[0]);
        assert.ok(href, "a .run-btn without a pdp11.html?boot= href: " + m[0]);
        return href[1];
    });
}

// Device keys the SPA advertises: the bootKey of every slide in the gallery.
function landingBootKeys(src) {
    const start = src.indexOf("GUEST_OS_SLIDES");
    assert.ok(start !== -1, "landing/src/data.ts has no GUEST_OS_SLIDES");
    const end = src.indexOf("];", start);
    assert.ok(end !== -1, "GUEST_OS_SLIDES is not a terminated array");
    return [...src.slice(start, end).matchAll(/bootKey:\s*'([^']+)'/g)]
        .map(function (m) { return m[1]; });
}

// The body of the carousel's wire() helper, where the RUN guard lives.
function carouselWireBody(html) {
    const at = html.indexOf("function wire(item)");
    assert.ok(at !== -1, "index.html: the carousel wire() helper is gone");
    const end = html.indexOf("\n            }", at);
    assert.ok(end !== -1, "index.html: wire() has no closing brace");
    return html.slice(at, end);
}

function run() {
    const { OSBoot, QuickBoot } = loadModules();
    const classic = fs.readFileSync(CLASSIC_PATH, "utf8");
    const landing = fs.readFileSync(LANDING_DATA_PATH, "utf8");

    assert.ok(OSBoot && OSBoot.BOOT_SCENARIOS && OSBoot.scenarioFor,
        "src/osboot.js did not load: the scenario table is the contract here");

    // --- 1. the classic gallery: one RUN link per card, all resolvable ------
    const cards = (classic.match(/class="carousel-item os-card-link"/g) || []).length;
    assert.ok(cards > 0, "the classic guest-OS carousel has no cards");
    const runKeys = classicRunKeys(classic);
    assert.strictEqual(runKeys.length, cards,
        "every guest-OS card needs a RUN link: " + runKeys.length +
        " link(s) for " + cards + " card(s)");
    assert.strictEqual(new Set(runKeys).size, runKeys.length,
        "two cards boot the same scenario: " + runKeys.join(", "));
    for (const key of runKeys) {
        assert.ok(OSBoot.scenarioFor(key),
            "index.html: RUN points at ?boot=" + key +
            ", which is not a scenario in src/osboot.js");
    }

    // --- 2. the SPA gallery: every slide carries a resolvable key ----------
    const spaKeys = landingBootKeys(landing);
    assert.ok(spaKeys.length > 0, "landing/src/data.ts declares no bootKey");
    for (const key of spaKeys) {
        assert.ok(OSBoot.scenarioFor(key),
            "landing/src/data.ts: bootKey '" + key +
            "' is not a scenario in src/osboot.js");
    }
    assert.strictEqual(new Set(spaKeys).size, spaKeys.length,
        "two SPA tiles boot the same scenario: " + spaKeys.join(", "));

    // --- 3. the two galleries agree ----------------------------------------
    // Not only "all keys are valid": the SAME keys, or one page quietly offers
    // a guest OS the other cannot start.
    assert.deepStrictEqual(spaKeys.slice().sort(), runKeys.slice().sort(),
        "the two guest-OS galleries must offer the same scenarios " +
        "(index.html vs landing/src/data.ts)");

    // --- 4. the classic carousel guard -------------------------------------
    // The card itself opens the lightbox on click, so a RUN click must bail out
    // before that. Without the guard every RUN click also opens the lightbox.
    const wire = carouselWireBody(classic);
    assert.ok(/run-btn/.test(wire),
        "index.html: the carousel click handler lost its .run-btn guard — " +
        "a RUN click would also open the lightbox");

    // --- 5. the emulator's own half of the contract ------------------------
    assert.strictEqual(typeof QuickBoot.deviceFromSearch, "function",
        "QuickBoot.deviceFromSearch is not exported (see src/quickboot.js)");
    const f = QuickBoot.deviceFromSearch;
    const cases = [
        ["", null],                       // no query at all
        ["?plain=1", null],               // some other parameter
        ["?boot=rk0", "rk0"],             // the plain deep link
        ["?core=1&boot=rp1", "rp1"],      // composes with the other switches
        ["?bridge=1&boot=rk1vt52", "rk1vt52"],
        ["?boot=rk1tty", "rk1tty"],       // a scenario that shares a disk image
        ["?boot=RK0", null],              // device keys are case-sensitive
        ["?boot=nope", null],             // unknown key: the page simply opens
        ["?boot=", null],                 // empty value
        ["?boot=%", null],                // dangling escape must not throw
    ];
    for (const [search, expected] of cases) {
        assert.strictEqual(f(search), expected,
            "deviceFromSearch(" + JSON.stringify(search) + ") should be " +
            JSON.stringify(expected));
    }

    // Every key the galleries advertise must survive the parser unescaped —
    // otherwise a valid link turns into a silent no-op.
    for (const key of runKeys.concat(spaKeys)) {
        assert.strictEqual(f("?boot=" + key), key,
            "deviceFromSearch must return the key the galleries advertise: " + key);
    }

    // --- 6. the raw key, for the "no such scenario" dialog ----------------
    // deviceFromSearch() answers "can this boot?"; bootKeyFromSearch() answers
    // "did anybody ask?" — the dialog names the key when the answer is no, so
    // the raw value has to come back exactly as typed.
    //
    // An EMPTY value (or a bare "?boot") is a request too: a link that lost its
    // key is a broken template, and it gets the dialog rather than silence.
    // Only the absence of the parameter means nobody asked.
    assert.strictEqual(typeof QuickBoot.bootKeyFromSearch, "function",
        "QuickBoot.bootKeyFromSearch is not exported (see src/quickboot.js)");
    const raw = QuickBoot.bootKeyFromSearch;
    const rawCases = [
        ["", null],                      // no query at all: nobody asked
        ["?plain=1", null],
        ["?boot=", ""],                  // a link that lost its key
        ["?boot", ""],                   // ... with the "=" lost as well
        ["?boot&x=1", ""],
        ["?x=1&boot=", ""],
        ["?boots=1", null],              // a different parameter must not match
        ["?noboot=1", null],
        ["?boot=rk0", "rk0"],
        ["?core=1&boot=rp1", "rp1"],
        ["?boot=%", "%"],                // dangling escape: echoed as typed
        ["?boot=not-a-scenario", "not-a-scenario"],
        ["?boot=%3Crk0%3E", "<rk0>"]     // decoded, then tamed by boundKey()
    ];
    for (const [search, expected] of rawCases) {
        assert.strictEqual(raw(search), expected,
            "bootKeyFromSearch(" + JSON.stringify(search) + ") should be " +
            JSON.stringify(expected));
    }
    // ... and an empty key is still not a scenario: nothing may boot from it.
    assert.strictEqual(f("?boot="), null, "an empty key must not resolve");
    assert.strictEqual(f("?boot"), null, "a keyless parameter must not resolve");

    // --- 7. the key as the dialog shows it --------------------------------
    // The key is URL text shown back in a modal: it is tamed, not escaped (the
    // dialog builds itself with textContent).
    assert.strictEqual(typeof QuickBoot.boundKey, "function",
        "QuickBoot.boundKey is not exported (see src/quickboot.js)");
    const bound = QuickBoot.boundKey;
    assert.strictEqual(bound(""), "");
    assert.strictEqual(bound("rk0"), "rk0");
    assert.strictEqual(bound("x".repeat(40)), "x".repeat(40), "40 is not too long");
    assert.strictEqual(bound("x".repeat(41)), "x".repeat(40) + "…");
    // Cut by CODE POINTS: 41 emoji must not become 20 whole ones plus half of
    // the 21st, which the browser would draw as a replacement glyph.
    assert.strictEqual(bound("😀".repeat(41)), "😀".repeat(40) + "…",
        "the cut must not split a surrogate pair");
    // Control characters would either break the paragraph or stay invisible.
    assert.strictEqual(bound("a\nb\tc\rd"), "a?b?c?d");
    assert.strictEqual(bound("a\u0000b\u007Fc"), "a?b?c");
    // Bidi overrides and line separators reorder or reshape what is read.
    assert.strictEqual(bound("rk\u202E0"), "rk?0");
    assert.strictEqual(bound("rk\u20280"), "rk?0");

    // --- 8. is the scenario's image actually in this BUILD? ----------------
    // A deep link is resolved on page load, before the manifest (which is
    // fetched asynchronously) has landed. Without this the key names a real
    // scenario, launch() runs, and the mount fails long after — the visitor
    // gets imgerror instead of an explanation. This is the emulator half of
    // "the build ships what the galleries advertise".
    assert.strictEqual(typeof QuickBoot.scenarioAvailable, "function",
        "QuickBoot.scenarioAvailable is not exported (see src/quickboot.js)");
    const avail = QuickBoot.scenarioAvailable;
    const rk0 = OSBoot.scenarioFor("rk0");
    const rk1tty = OSBoot.scenarioFor("rk1tty");
    const basic = OSBoot.scenarioFor("basic");

    // A build shipping only rk0.dsk keeps Unix V5 and drops RT-11 (same disk
    // family, different scenarios) — the case a stale link hits.
    assert.strictEqual(avail(rk0, ["rk0.dsk"], []), true,
        "a scenario whose image is in the manifest is available");
    assert.strictEqual(avail(rk1tty, ["rk0.dsk"], []), false,
        "a scenario whose image is absent from the manifest is not");

    // Paper tapes are selected through the #ptr control, never mounted: they
    // stay bootable in every build, however minimal.
    assert.strictEqual(avail(basic, [], []), true,
        "a paper-tape scenario stays available with an empty manifest");

    // No manifest at all (ad-hoc host, file://, fetch failed) proves nothing:
    // the scenario stays "possibly bootable" and the boot is allowed to try.
    // Tightening this to false would break every deployment without a
    // manifest, so it is pinned deliberately.
    assert.strictEqual(avail(rk0, null, []), true,
        "a failed manifest must not block a boot");
    assert.strictEqual(avail(rk0, undefined, []), true,
        "an absent manifest must not block a boot");

    // A user-mounted image (drag & drop, desktop bundle) makes its OS
    // bootable even when the build does not ship it — union semantics.
    assert.strictEqual(avail(OSBoot.scenarioFor("rk4"), null, ["rk4.dsk"]), true,
        "a mounted image makes its scenario available without a manifest");

    // A key that resolved to nothing is never "available".
    assert.strictEqual(avail(null, ["rk0.dsk"], []), false);
    assert.strictEqual(avail(undefined, ["rk0.dsk"], []), false);

    // Every key the galleries advertise must be in the manifest those very
    // galleries would run against — the build ships what the RUN buttons
    // promise. The repository's own media/manifest.json is that manifest.
    const buildManifest = JSON.parse(
        fs.readFileSync(path.join(ROOT, "media", "manifest.json"), "utf8")).media;
    for (const key of runKeys.concat(spaKeys)) {
        assert.strictEqual(avail(OSBoot.scenarioFor(key), buildManifest, []), true,
            "the build does not ship the image for ?boot=" + key +
            " — its RUN button would open a dead link on this deployment");
    }

    console.log("os-gallery-run: all tests passed (" +
        runKeys.length + " classic card(s), " + spaKeys.length +
        " SPA slide(s), " + OSBoot.BOOT_SCENARIOS.length + " scenario(s))");
}

run();
