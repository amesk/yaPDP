#!/usr/bin/env node
/**
 * yaPDP — structural test for the record-video browser resolution.
 *
 * tools/record-video.js launches Chrome/Edge through puppeteer-stream, which
 * needs an explicit executablePath. findBrowserExecutable() resolves it from,
 * in order: PUPPETEER_EXECUTABLE_PATH, the well-known Windows paths, the common
 * Linux Chromium/Chrome locations, and finally the browser bundled by the
 * `puppeteer` postinstall (~/.cache/puppeteer). The Linux fallbacks are what
 * let the demo-reel CI workflow (ubuntu runner) record without apt-installing
 * a browser. This file pins that resolution ORDER structurally, so a future
 * edit cannot silently drop the Linux path or reorder the env override.
 *
 * Run with:  node tests/record-browser.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "tools", "record-video.js"), "utf8");

// The resolver must exist.
assert.ok(src.includes("function findBrowserExecutable()"),
    "findBrowserExecutable() must be defined");

// The function body (between the two braces) must list the candidates in the
// documented order: env first, then Windows, then Linux, then the puppeteer
// bundled browser. We simply assert the ordering of the markers in the source.
const markers = [
    'process.env.PUPPETEER_EXECUTABLE_PATH',
    '"C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe"',
    '"C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe"',
    '"/usr/bin/google-chrome"',
    '"/usr/bin/chromium"',
    'require("puppeteer").executablePath()'
];
let last = -1;
for (const m of markers) {
    const idx = src.indexOf(m);
    assert.ok(idx !== -1, "record-video must reference: " + m);
    assert.ok(idx > last,
        "browser candidates must be ordered (env > Windows > Linux > puppeteer): " + m);
    last = idx;
}

// The puppeteer fallback must be guarded (it throws when puppeteer is absent).
assert.ok(src.includes('require("puppeteer").executablePath()'),
    "the puppeteer bundled-browser fallback must be used");
assert.ok(src.includes("/* no puppeteer installation to fall back on */") ||
    src.includes("catch (err)"),
    "the puppeteer fallback must be wrapped in try/catch");

// assemble-video.js must consume the shared font resolver (its sibling change
// keeps the reel cards renderable on the Linux runner too).
const assemble = fs.readFileSync(
    path.join(ROOT, "tools", "assemble-video.js"), "utf8");
assert.ok(assemble.includes('require("./reel-font-util.js")'),
    "assemble-video must use the cross-platform font resolver");
assert.ok(assemble.includes("fonts.resolveFontPaths()"),
    "assemble-video must resolve FONT/FONT_BOLD through reel-font-util");

console.log("record-browser tests passed.");
