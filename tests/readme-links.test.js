#!/usr/bin/env node
/**
 * README guard.
 *
 * The README is the shop window of the project, so the defects it can carry
 * are not cosmetic. Three of them have already happened once and this test
 * pins them down mechanically:
 *
 *   1. The live-demo link pointed at the upstream author's site
 *      (paulnank.github.io/pdp11-js) instead of this fork's own demo,
 *      so the top-of-page traffic left the project. The README must never
 *      advertise a foreign demo host again.
 *   2. The guest-OS table is a hand-maintained mirror of the shipped manual
 *      table (docs/manual/guest-oses.md) — and the prose drifted: it claimed
 *      "16 guest operating systems" while both tables list 15 devices.
 *      A device added to one table only is caught here.
 *   3. Relative links and images rot silently: a renamed screenshot or moved
 *      doc turns the README into a page of 404s. Every local target is
 *      resolved against the repository root.
 *
 * Run with:  node tests/readme-links.test.js
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FILE = path.join(ROOT, "README.md");
const MANUAL_FILE = path.join(ROOT, "docs", "manual", "guest-oses.md");

// The fork's own demo. Every "try it" link in the README must point here.
const OWN_HOST = "amesk.github.io/yaPDP";
// The upstream author's demo — the README must not funnel visitors away.
const FOREIGN_DEMO = "paulnank.github.io/pdp11-js";

function read(file) {
    return fs.readFileSync(file, "utf8");
}

// Markdown [text](target) links plus href/src attributes of inline HTML.
function linkTargets(md) {
    const out = [];
    for (const re of [/\[[^\]]*\]\(([^)\s]+)\)/g, /(?:href|src)=["']([^"']+)["']/g]) {
        let m;
        while ((m = re.exec(md)) !== null) out.push(m[1]);
    }
    return out;
}

function isExternal(target) {
    return /^(https?:|mailto:|#|data:)/i.test(target);
}

function localPath(target) {
    return decodeURI(target.split("#")[0].split("?")[0]);
}

// The device column of a guest-OS table: README writes "| **RK0** |",
// the manual writes "| RK0{.disk} |". Both yield RK0.
function tableDevices(md) {
    const re = /^\|\s*\*{0,2}([A-Z]{2}\d)\*{0,2}(?:\{[^}]*\})?\s*\|/gm;
    const out = [];
    let m;
    while ((m = re.exec(md)) !== null) out.push(m[1]);
    return out;
}

function run() {
    const readme = read(FILE);

    // 1. every local link / image resolves inside the repository.
    const missing = linkTargets(readme)
        .filter((t) => !isExternal(t))
        .map(localPath)
        .filter(Boolean)
        .filter((t) => !fs.existsSync(path.join(ROOT, t)));
    assert.strictEqual(missing.length, 0,
        "README links files that do not exist: " + missing.join(", "));

    // 2. no traffic leak to the upstream demo; the fork's own demo is present.
    assert.ok(!readme.includes(FOREIGN_DEMO),
        "README still links the upstream demo (" + FOREIGN_DEMO + "); the live " +
        "link must be " + OWN_HOST + "/pdp11.html");
    assert.ok(readme.includes(OWN_HOST),
        "README must advertise this fork's live demo at " + OWN_HOST);

    // 3. the guest-OS table cannot drift from the shipped manual.
    const manualDevices = tableDevices(read(MANUAL_FILE));
    const readmeDevices = tableDevices(readme);
    assert.ok(readmeDevices.length > 0, "README guest-OS table is missing");
    const onlyReadme = readmeDevices.filter((d) => !manualDevices.includes(d));
    const onlyManual = manualDevices.filter((d) => !readmeDevices.includes(d));
    assert.ok(onlyReadme.length === 0 && onlyManual.length === 0,
        "README and docs/manual/guest-oses.md guest-OS tables disagree " +
        "(README only: " + (onlyReadme.join(", ") || "-") + "; manual only: " +
        (onlyManual.join(", ") || "-") + ") — update both, and any count in prose");

    // 4. a POSIX text file ends with a newline; the README once did not.
    assert.ok(readme.endsWith("\n"), "README.md must end with a newline");

    console.log("All README tests passed.");
}

run();
