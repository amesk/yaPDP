#!/usr/bin/env node
/**
 * Landing user-guide coverage guard.
 *
 * The user manual has one source — docs/manual/*.md (+ docs/manual/ru) — and
 * tools/build-manual.js generates manual.html, manual_ru.html and the landing's
 * data modules from it. The landing's own guide, however, is a hand-written
 * React component (landing/src/components/UserManual.tsx): its prose is a third
 * copy that nobody regenerates. So it drifts, and it drifts silently.
 *
 * It did: the Troubleshooting chapter of the guide carried one topic ("An image
 * cannot be loaded") while docs/manual/troubleshooting.md described eight —
 * missing a snapshot refused after an image update, a guest that does not boot,
 * a keyboard that does not type, no sound, poor performance, a blank screen and
 * CORS errors. Nothing failed; a human noticed, months later. Three more
 * chapters had drifted the same way (quick-start, machine-state, controls) and
 * were brought back in line once this guard existed to keep them there.
 *
 * This guard makes that class of drift fail here instead of in review:
 *
 *   1. every <section id> of the guide is a real manual chapter — a typo or a
 *      deleted chapter must not leave an orphan anchor behind;
 *   2. every manual chapter is either carried by the guide or listed in
 *      CHAPTERS_NOT_ON_LANDING, so a NEW chapter cannot be forgotten in
 *      silence: it fails until somebody decides where it belongs;
 *   3. every carried chapter renders at least as many topics (<h3> in that
 *      section) as the manual has (### headings), minus an explicit, shrinking
 *      deficit — this is the check that would have caught Troubleshooting;
 *   4. a chapter in KNOWN_TOPIC_DEFICITS that has caught up is a failure too:
 *      the list may only shrink, never quietly rot;
 *   5. the Russian source carries as many topics as the English one, or the
 *      translation is behind its own source;
 *   6. every scrollToSection('…') target of the guide exists as an id="…" in
 *      the same file — a cross-reference between chapters is a string, and a
 *      renamed anchor turns it into a dead click.
 *
 * Deliberately NOT checked: the wording of a heading. The guide shortens some
 * manual titles on purpose ("Machine State" instead of "Machine State (STATE
 * button)"), and a guard that insisted on identical titles would be edited into
 * uselessness. Topics are counted; titles are the author's business.
 *
 * Run with:  node tests/landing-manual-coverage.test.js
 *
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "docs", "manual");
const SRC_RU = path.join(SRC, "ru");
const META = path.join(SRC, "_meta.yml");
const GUIDE = path.join(ROOT, "landing", "src", "components", "UserManual.tsx");

// Chapters the landing deliberately does not carry: About and Fidelity are
// marketing/policy pages that live on the landing itself, and the Glossary is a
// reference list the manual page owns. Adding a chapter to docs/manual/ means
// answering this question — implement it in the guide, or list it here.
const CHAPTERS_NOT_ON_LANDING = ["about", "glossary", "fidelity"];

// Chapters whose topics are not <h3> elements: the CONFIG chapter renders its
// four tabs from the generated CONFIG_TABS_DATA (built from the same Markdown),
// so its topics cannot drift and cannot be counted here.
const DATA_DRIVEN_CHAPTERS = new Set(["config"]);

// Known drift, in topics: chapter id -> how many manual topics the guide still
// lacks. Empty today, and it is meant to stay that way — an entry is a
// documented debt, not a licence. The list may only shrink: a chapter that
// catches up must be removed from here (check 4), so it cannot rot.
const KNOWN_TOPIC_DEFICITS = {};

// --- helpers ---------------------------------------------------------------

function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

// The manual's chapters, in reading order, as tools/build-manual.js sees them.
function metaChapters() {
  const lines = readText(META).split("\n");
  const out = [];
  for (const line of lines) {
    const m = /^\s*-\s*id:\s*([a-z0-9-]+)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

// Topics of one Markdown chapter: the ### headings. The ## heading is the
// chapter title, which the guide is free to shorten.
function manualTopics(file) {
  if (!fs.existsSync(file)) return 0;
  return (readText(file).match(/^###\s+/gm) || []).length;
}

// The guide, split into chapters at its <section id="…"> boundaries.
function guideChapters(text) {
  const marks = [...text.matchAll(/<section id="([a-z0-9-]+)"/g)];
  const out = new Map();
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(start, end);
    out.set(marks[i][1], (body.match(/<h3\b/g) || []).length);
  }
  return out;
}

function anchorsOf(text) {
  return new Set([...text.matchAll(/\sid="([a-z0-9-]+)"/g)].map((m) => m[1]));
}

function scrollTargets(text) {
  return new Set([...text.matchAll(/scrollToSection\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
}

// --- the guard -------------------------------------------------------------

function run() {
  assert.ok(fs.existsSync(GUIDE), "landing/src/components/UserManual.tsx is missing");
  const text = readText(GUIDE);
  const meta = metaChapters();
  assert.ok(meta.length > 0, "docs/manual/_meta.yml lists no chapters");

  const guide = guideChapters(text);
  assert.ok(guide.size > 0, "the landing guide renders no <section id=\"…\"> chapters");

  // --- 1. no orphan chapters in the guide ----------------------------------
  for (const id of guide.keys()) {
    assert.ok(meta.indexOf(id) !== -1,
      'the landing guide has a section "' + id + '", but docs/manual/_meta.yml ' +
      "lists no such chapter — a renamed or deleted chapter left its anchor behind");
  }

  // --- 2. every manual chapter is either carried or explicitly skipped ------
  const carried = meta.filter((id) => guide.has(id));
  const skipped = meta.filter((id) => !guide.has(id));
  const unforeseen = skipped.filter((id) => CHAPTERS_NOT_ON_LANDING.indexOf(id) === -1);
  const staleAllowlist = CHAPTERS_NOT_ON_LANDING.filter((id) => skipped.indexOf(id) === -1);
  assert.deepStrictEqual(unforeseen, [],
    "docs/manual has chapters the landing guide does not render and no allowlist " +
    "entry explains: " + unforeseen.join(", ") +
    " — implement them in landing/src/components/UserManual.tsx or add them to " +
    "CHAPTERS_NOT_ON_LANDING with a reason");
  assert.deepStrictEqual(staleAllowlist, [],
    "CHAPTERS_NOT_ON_LANDING names chapters the guide actually renders: " +
    staleAllowlist.join(", ") + " — the allowlist may only shrink");

  // --- 3/4. topic coverage per carried chapter ------------------------------
  const failures = [];
  const stale = [];
  for (const id of carried) {
    if (DATA_DRIVEN_CHAPTERS.has(id)) continue;
    const want = manualTopics(path.join(SRC, id + ".md"));
    const have = guide.get(id);
    const deficit = KNOWN_TOPIC_DEFICITS[id] || 0;
    if (have + deficit < want) {
      failures.push('"' + id + '": the guide renders ' + have + " topic(s), the manual has " +
        want + " — " + (want - have) + " missing, only " + deficit +
        " accounted for in KNOWN_TOPIC_DEFICITS");
    }
    if (deficit > 0 && have >= want) {
      stale.push('"' + id + '" is listed with a deficit of ' + deficit +
        ", but the guide already matches the manual (" + have + " >= " + want + ")");
    }
  }
  assert.ok(failures.length === 0,
    "landing/src/components/UserManual.tsx is behind docs/manual:\n  " + failures.join("\n  "));
  assert.ok(stale.length === 0,
    "KNOWN_TOPIC_DEFICITS is out of date — remove these entries:\n  " + stale.join("\n  "));

  // --- 5. the Russian source is not behind the English one -----------------
  for (const id of meta) {
    const en = manualTopics(path.join(SRC, id + ".md"));
    const ru = manualTopics(path.join(SRC_RU, id + ".md"));
    assert.strictEqual(ru, en,
      "docs/manual/ru/" + id + ".md has " + ru + " topic(s), docs/manual/" + id +
      ".md has " + en + " — the translation is behind its own source");
  }

  // --- 6. every cross-reference points at an anchor that exists ------------
  const anchors = anchorsOf(text);
  const dangling = [...scrollTargets(text)].filter((target) => !anchors.has(target));
  assert.ok(dangling.length === 0,
    "the landing guide links to anchors it does not render (dead click): " +
    dangling.join(", "));

  const topics = [...guide.entries()]
    .filter(([id]) => !DATA_DRIVEN_CHAPTERS.has(id))
    .reduce((sum, [, n]) => sum + n, 0);
  console.log("All landing-manual coverage checks passed (" +
    carried.length + " of " + meta.length + " chapters carried, " +
    topics + " topics rendered, " +
    Object.values(KNOWN_TOPIC_DEFICITS).reduce((a, b) => a + b, 0) +
    " topic(s) of known drift).");
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error("FAIL: " + (err && err.message ? err.message : err));
  process.exit(1);
}
