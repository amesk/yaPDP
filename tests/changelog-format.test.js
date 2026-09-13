#!/usr/bin/env node
/**
 * CHANGELOG.md format guard.
 *
 * The release journals have a single, strict shape (see
 * `.roo/rules-journalist/JOURNAL.md` and `docs/RELEASING.md`). Two real
 * defects slipped in by hand — an empty released heading left ABOVE
 * `[Unreleased]`, and records that never moved under their version — so this
 * test pins the mechanical part of the rule and will fail CI when it breaks:
 *
 *   1. `[Unreleased]` is the first release section after the preamble.
 *   2. Every released heading carries an ISO date: `[X.Y.Z] - YYYY-MM-DD`.
 *   3. Released versions are listed newest first (SemVer descending).
 *   4. Every released version and `[Unreleased]` has a compare link at the
 *      bottom, and the version links are in the same descending order.
 *   5. Working-tree entries carry no development-history markers (reverts,
 *      "again reworked", "fixed for good", numbered layering steps) — the
 *      changelog records the release, not the journey.
 *
 * Run with:  node tests/changelog-format.test.js
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FILE = path.join(ROOT, "CHANGELOG.md");

function readChangelog() {
    return fs.readFileSync(FILE, "utf8").split("\n");
}

// Heading lines: "## [1.2.3] - 2026-01-02", "## [Unreleased]", "## [0.1.0-alpha2] - ..."
function headingMatches(lines) {
    const out = [];
    lines.forEach((line, i) => {
        const m = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/.exec(line);
        if (m) out.push({ line: i + 1, label: m[1], date: m[2] || null });
    });
    return out;
}

// SemVer-ish compare for release labels like 0.2.0 / 0.1.0-alpha2.
function versionParts(label) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(label);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || "" };
}

function compareDesc(a, b) {
    // True when a should appear ABOVE b (a is newer).
    if (a.major !== b.major) return a.major > b.major;
    if (a.minor !== b.minor) return a.minor > b.minor;
    if (a.patch !== b.patch) return a.patch > b.patch;
    // A release outranks its own pre-release; otherwise compare prerelease text.
    if (!a.pre && b.pre) return true;
    if (a.pre && !b.pre) return false;
    return a.pre >= b.pre;
}

function run() {
    const lines = readChangelog();
    const heads = headingMatches(lines);
    assert.ok(heads.length >= 2, "the CHANGELOG must carry at least [Unreleased] + one release");

    // 1. [Unreleased] first, exactly once.
    const unreleased = heads.filter((h) => h.label === "Unreleased");
    assert.strictEqual(unreleased.length, 1, "exactly one [Unreleased] section");
    assert.strictEqual(heads[0].label, "Unreleased",
        "[Unreleased] must be the first release section after the preamble; " +
        "found '" + heads[0].label + "' on line " + heads[0].line);

    // 2. + 3. released sections: dated, newest first.
    const releases = heads.slice(1);
    let prev = null;
    for (const h of releases) {
        assert.ok(h.date, "released heading [" + h.label + "] on line " + h.line +
            " must be dated '[X.Y.Z] - YYYY-MM-DD'");
        assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(h.date),
            "date must be YYYY-MM-DD, got '" + h.date + "' on line " + h.line);
        const v = versionParts(h.label);
        assert.ok(v, "released heading label '" + h.label + "' must be SemVer ([X.Y.Z])");
        if (prev) {
            assert.ok(compareDesc(prev.v, v),
                "releases must be newest-first: [" + h.label + "] on line " + h.line +
                " must not come after newer [" + prev.label + "]");
        }
        prev = { label: h.label, v };
    }

    // 4. compare links at the bottom for [Unreleased] and every release.
    const tail = lines.slice(Math.max(0, lines.length - 40)).join("\n");
    const linkFor = (label) => new RegExp("^\\[" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "\\]:\\s*https://github\\.com/\\S+$", "m").test(tail);
    for (const h of heads) {
        assert.ok(linkFor(h.label),
            "missing or malformed compare link '[" + h.label + "]: https://github.com/...' " +
            "at the bottom of CHANGELOG.md");
    }
    assert.ok(/^\[Unreleased\]:\s*https:\/\/github\.com\/\S+\.\.\.HEAD\s*$/m.test(tail),
        "the [Unreleased] link must compare the latest release tag ...HEAD");

    // 5. no development-history markers in the working-tree entries.
    const body = lines.slice(heads[0].line, (heads[1] ? heads[1].line - 1 : lines.length)).join("\n");
    const forbidden = [
        /\brevert(ed|s)?\b/i,
        /\bagain reworked\b/i,
        /\bfixed for good\b/i,
        /\bwas wrong\b/i,
        /\binitially\b.*\bthen\b/i,
    ];
    for (const re of forbidden) {
        const m = re.exec(body);
        assert.ok(!m, "development-history marker in [Unreleased] ('" + m + "'): " +
            "record the final state, not the path to it (journalist rules)");
    }

    console.log("All Changelog-format tests passed.");
}

run();
