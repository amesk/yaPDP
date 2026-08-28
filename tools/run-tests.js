#!/usr/bin/env node
/**
 * yaPDP unit-test runner.
 *
 * Runs every tests/*.test.js in the canonical order (the same order the
 * package.json && chain used), then prints a summary and exits non-zero if
 * any test failed. Unlike the old chain it does NOT stop at the first
 * failure — you see every broken file in one run.
 *
 * Usage:
 *   node tools/run-tests.js          run the full suite (this is `npm test`)
 *   node tools/run-tests.js reader   run only tests whose file name contains
 *                                    "reader" (any number of substrings ok)
 *   node tools/run-tests.js --list   print the run order and exit
 *
 * New test files dropped into tests/ are picked up automatically (appended
 * after the canonical list, with a notice); nothing is ever skipped in
 * silence. e2e tests (tests/e2e-*.js) need a live server + puppeteer and
 * stay separate by design.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTS = path.join(ROOT, "tests");

// Canonical order — the historical package.json && chain, kept as-is so the
// run order never changes underneath the suite.
const ORDER = [
    "config.test.js",
    "snapshotstore.test.js",
    "punchtape.test.js",
    "reader.test.js",
    "pasteutil.test.js",
    "paper-geometry.test.js",
    "lp11-text.test.js",
    "lp11-scaling.test.js",
    "panel-scaling.test.js",
    "teletype-scaling.test.js",
    "lp11-cabinet-css.test.js",
    "lp11-online.test.js",
    "teletype-paper-css.test.js",
    "teletype-paper-growth.test.js",
    "teletype-brandplate-css.test.js",
    "teletype-cabinet-css.test.js",
    "vt52-cabinet-css.test.js",
    "dataloader.test.js",
    "diskstore.test.js",
    "onboarding.test.js",
    "imgerror.test.js",
    "osboot.test.js",
    "media-manifest.test.js",
    "vt52.test.js",
    "g60printer-flush.test.js",
    "dl11-recv.test.js",
    "vt11.test.js",
    "contextmenu.test.js",
    "fullscreen.test.js",
    "hum.test.js",
    "model33-keyboard.test.js",
    "navactivity.test.js",
    "nav-led-css.test.js",
    "nav-tooltip.test.js",
    "panel-led.test.js",
];

function allTestFiles() {
    return fs.readdirSync(TESTS)
        .filter((f) => f.endsWith(".test.js"))
        .sort();
}

function runOrder() {
    const known = new Set(ORDER);
    const files = allTestFiles();
    const ordered = ORDER.filter((f) => files.includes(f));
    const leftovers = files.filter((f) => !known.has(f)); // already sorted
    return { ordered, leftovers };
}

const args = process.argv.slice(2);
if (args.includes("--list")) {
    const { ordered, leftovers } = runOrder();
    ordered.concat(leftovers).forEach((f) => console.log(f));
    process.exit(0);
}

const filters = args.filter((a) => !a.startsWith("-"));

const { ordered, leftovers } = runOrder();
let files = ordered.concat(leftovers);

if (filters.length) {
    files = files.filter((f) =>
        filters.every((sub) => f.includes(sub)));
    if (!files.length) {
        console.error(`No test files match: ${filters.join(" ")}`);
        process.exit(1);
    }
}

if (leftovers.length) {
    console.log(`note: ${leftovers.length} new test file(s) not in the ` +
        "canonical order — appended:\n  " + leftovers.join("\n  "));
}

const results = [];
for (const file of files) {
    const r = spawnSync(process.execPath, [path.join(TESTS, file)], {
        stdio: "inherit",
    });
    results.push({ file, ok: r.status === 0 });
}

const failed = results.filter((r) => !r.ok);
console.log(
    `\n${results.length - failed.length}/${results.length} test file(s) passed`
);
if (failed.length) {
    console.error("Failed:");
    failed.forEach((r) => console.error("  " + r.file));
    process.exit(1);
}
