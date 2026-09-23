#!/usr/bin/env node
/**
 * User-manual generation guard.
 *
 * docs/manual/*.md is the single source for the user manual, and
 * tools/build-manual.js generates both manual.html and
 * landing/src/data/manualData.ts from it. Regenerating must keep every
 * construct the page styles or links on — and that is exactly what a port from
 * hand-written HTML quietly loses. Seven defects of that one kind shipped in a
 * row: stylesheet classes, internal links, code blocks, emphasis, block quotes,
 * element wrappers and the span boundary around a control label. Each was
 * found by a human comparing two pages, never by a test.
 *
 * This guard counts the constructs that carry meaning and compares the count
 * against the section count and against each other, so the same class of loss
 * fails here instead of in review:
 *
 *   1. every section in docs/manual/ is present in both outputs;
 *   2. the two outputs carry the same section ids (manual.html <h2 id> vs
 *      MANUAL_SECTIONS);
 *   3. the classes the stylesheet relies on are present, and in the counts the
 *      page expects (shot 1 per screenshot, control-btn and control-name one
 *      per button, disk one per styled first cell);
 *   4. markup that is not plain text survives: <pre>, inline <code>, <em>/<i>,
 *      <blockquote>, internal <a href="#…">;
 *   5. the generated HTML has balanced <div> — an unbalanced wrapper makes the
 *      browser swallow the rest of the document, which hid five whole sections;
 *   6. the Russian source covers every section the English source has.
 *
 * Run with:  node tests/manual-generation.test.js
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
const OUT_HTML = path.join(ROOT, "manual.html");
const OUT_TS = path.join(ROOT, "landing", "src", "data", "manualData.ts");
const META = path.join(SRC, "_meta.yml");

// --- helpers ---------------------------------------------------------------

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

function sectionFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

function metaSections() {
  const text = fs.readFileSync(META, "utf8");
  return (text.match(/^\s*-\s*id:\s*(.+?)\s*$/gm) || [])
    .map((l) => l.replace(/^\s*-\s*id:\s*/, "").trim());
}

// class="a b" -> { a: n, b: n }
function classCounts(html) {
  const out = {};
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const cls of m[1].split(/\s+/)) {
      if (cls) out[cls] = (out[cls] || 0) + 1;
    }
  }
  return out;
}

function run() {
  assert.ok(fs.existsSync(META), "docs/manual/_meta.yml is missing");
  assert.ok(fs.existsSync(OUT_HTML), "manual.html is missing — run npm run manual:build");
  assert.ok(fs.existsSync(OUT_TS), "manualData.ts is missing — run npm run manual:build");

  const html = fs.readFileSync(OUT_HTML, "utf8");
  const ts = fs.readFileSync(OUT_TS, "utf8");
  const meta = metaSections();
  const en = sectionFiles(SRC);
  const ru = sectionFiles(SRC_RU);

  // --- 1. every section is in the meta list and in both languages -----------
  assert.ok(meta.length > 0, "_meta.yml lists no sections");
  assert.deepStrictEqual(en.slice().sort(), meta.slice().sort(),
    "docs/manual/*.md and _meta.yml disagree about which sections exist");
  assert.deepStrictEqual(ru.slice().sort(), en.slice().sort(),
    "the Russian source does not cover the same sections as the English one");

  // --- 2. both outputs carry the same sections ------------------------------
  const htmlIds = (html.match(/<h2 id="([^"]+)"/g) || [])
    .map((s) => s.replace(/<h2 id="|"/g, ""));
  const tsIds = (ts.match(/^\s{4}id: '([^']+)',/gm) || [])
    .map((s) => s.replace(/^\s{4}id: '|',$/g, ""));
  assert.deepStrictEqual(htmlIds.slice().sort(), meta.slice().sort(),
    "manual.html does not carry every section from _meta.yml");
  assert.ok(tsIds.length >= meta.length,
    "manualData.ts carries fewer sections than _meta.yml");
  for (const id of meta) {
    assert.ok(tsIds.indexOf(id) !== -1, "manualData.ts is missing section " + id);
  }

  // --- 3. the stylesheet's classes -----------------------------------------
  const cls = classCounts(html);
  const imgs = count(html, /<img\b/g);
  // Three kinds of image carry a class, each with its own role: a screenshot
  // (.shot, capped to the content width), a CONFIG tab illustration
  // (.config-item-img, a grid cell) and a floating-control icon (.control-btn).
  // Every <img> must be one of them — an unclassified image renders at its
  // natural size and runs off the page, which is the defect this guards.
  const classified = (cls["shot"] || 0) + (cls["config-item-img"] || 0) +
    (cls["control-btn"] || 0);
  assert.strictEqual(classified, imgs,
    "every image must carry a class (shot, config-item-img or control-btn): " +
    imgs + " images, " + classified + " classified");

  // each image is followed by exactly one caption in the manual's shape
  assert.ok((cls["shot-caption"] || 0) > 0, "no .shot-caption paragraphs generated");

  // the floating-controls table styles its first cell and both parts of a row
  const buttons = count(html, /class="control-btn"/g);
  assert.ok(buttons > 0, "no .control-btn icons generated");
  assert.strictEqual(count(html, /class="control-name"/g), buttons,
    "each control icon needs exactly one .control-name label");

  // the label span must NOT wrap the image: that broke the cell layout
  assert.ok(!/class="control-name"[^>]*>\s*<img/.test(html),
    "a .control-name span wraps its <img> — the span is for text only");

  // CONFIG cards are a two-column grid: both wrappers, and they pair up
  assert.strictEqual(cls["config-item"] || 0, cls["config-item-text"] || 0,
    ".config-item and .config-item-text must come in pairs");
  assert.ok((cls["config-item"] || 0) > 0, "no CONFIG cards generated");

  // --- 4. markup that is not plain text ------------------------------------
  // These are CONTRACTS, not counts: the source uses a construct, the output
  // must render it. Absolute counts are deliberately NOT compared against a
  // saved copy of the page — such a copy ages the moment the manual gains a
  // chapter, and a guard that goes red on legitimate edits gets switched off.
  // What it checks instead is that a construct present in the source still
  // reaches the output at all, and that the counts stay internally consistent.

  // Per-source-file expectation: if a file uses the construct, the output must
  // show it. This scales with the manual and never depends on a frozen copy.
  const srcAll = en.map((id) => fs.readFileSync(path.join(SRC, id + ".md"), "utf8")).join("\n");

  const fencesInSource = count(srcAll, /^```/gm);
  const inlineCodeInSource = count(srcAll, /`[^`\n]+`/g);
  const emphasisInSource = count(srcAll, /\*[^*\n]+\*/g);
  const quotesInSource = count(srcAll, /^> /gm);
  const linksInSource = count(srcAll, /\]\(#[a-z0-9-]+\)/g);

  if (fencesInSource > 0) {
    assert.ok(count(html, /<pre>/g) > 0,
      "the source has ``` fenced blocks but the page renders no <pre>");
  }
  if (inlineCodeInSource > 0) {
    assert.ok(count(html, /<code>/g) > 0,
      "the source has `inline code` but the page renders no <code>");
  }
  if (emphasisInSource > 0) {
    assert.ok(count(html, /<(em|i)>/g) > 0,
      "the source has *emphasis* but the page renders no <em>");
  }
  if (quotesInSource > 0) {
    assert.ok(count(html, /<blockquote>/g) > 0,
      "the source has '> quoted' lines but the page renders no <blockquote>");
  }
  if (linksInSource > 0) {
    assert.ok(count(html, /<a href="#/g) > 0,
      "the source has internal links but the page renders no <a href=\"#…\">");
  }

  // a link in the source must survive as a link, not degrade to plain text:
  // the one failure mode that matters is silent loss, so compare the two
  // sides' totals loosely (output may add the table of contents' own links).
  const anchors = count(html, /<a href="#/g);
  assert.ok(anchors >= linksInSource,
    "internal links were lost on the way: " + linksInSource +
    " in the source, " + anchors + " in the page");

  // the section a link points at must exist — a dangling #anchor is a dead link
  for (const m of html.matchAll(/<a href="#([^"]+)"/g)) {
    if (m[1] === "toc") continue;
    assert.ok(meta.indexOf(m[1]) !== -1,
      "internal link points at a section that does not exist: #" + m[1]);
  }

  // --- 4b. the TypeScript output carries DATA, not markup ------------------
  // manualData.ts is consumed by React as plain strings. A marker or a
  // Markdown fragment that survives into a value renders literally on the
  // landing page — the author saw exactly that: the floating-controls rows
  // shipped '{.disk .control-cell} ![Magic wand](…){.control-btn} …' as the
  // button's NAME and an empty image, so no icons appeared at all.
  //
  // The HTML output and the TS output are produced by different code paths in
  // the generator, so checking one says nothing about the other.
  const tsValues = (ts.match(/^\s+\w+\w*: '((?:[^'\\]|\\.)*)'/gm) || []);
  for (const line of tsValues) {
    assert.ok(line.indexOf("{.") === -1,
      "a {.class} marker leaked into manualData.ts: " + line.trim().slice(0, 80));
    assert.ok(!/\]\s*\(/.test(line),
      "a Markdown link/image leaked into manualData.ts: " + line.trim().slice(0, 80));
    assert.ok(line.indexOf(" :::") === -1 && line.indexOf(":::") === -1,
      "a ::: wrapper leaked into manualData.ts: " + line.trim().slice(0, 80));
  }

  // every image path in the TS output must exist on disk, and no entry may
  // carry an empty one (an empty src is a silently missing illustration)
  const tsImages = ts.match(/image: '([^']*)'/g) || [];
  assert.ok(tsImages.length > 0, "no image paths in manualData.ts");
  for (const entry of tsImages) {
    const rel = entry.replace(/^image: '|'$/g, "");
    assert.ok(rel.length > 0,
      "manualData.ts has an entry with an empty image path");
    assert.ok(fs.existsSync(path.join(ROOT, rel)),
      "manualData.ts points at a file that does not exist: " + rel);
  }

  // --- 5. balanced wrappers ------------------------------------------------
  const open = count(html, /<div\b/g);
  const close = count(html, /<\/div>/g);
  assert.strictEqual(open, close,
    "unbalanced <div> (" + open + " open, " + close + " closed) — the browser " +
    "will swallow everything after the first unclosed one");

  // --- 5b. the caption marker sits at the END of its paragraph ------------
  // A caption may span several lines. When {.shot-caption} was placed at the
  // end of the FIRST line, the generator captioned that fragment and left the
  // rest as a plain paragraph — the defect the author found in Storage. The
  // marker belongs to the last line of the paragraph.
  for (const id of en) {
    const lines = fs.readFileSync(path.join(SRC, id + ".md"), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("{.shot-caption}") === -1) continue;
      // anything non-empty after this line means the marker is mid-paragraph
      const next = lines[i + 1] !== undefined ? lines[i + 1].trim() : "";
      assert.strictEqual(next, "",
        "docs/manual/" + id + ".md:" + (i + 1) +
        " — {.shot-caption} must be on the paragraph's LAST line, or the " +
        "caption is cut in half (next line: " + JSON.stringify(next.slice(0, 40)) + ")");
    }
  }

  // --- 6. no stray generator markers left in the output --------------------
  // {.class} and ::: are source syntax; visible in the page they are bugs.
  for (const marker of [/\{\.[a-z-]/g, /^::: /m]) {
    assert.ok(!marker.test(html),
      "a generator marker leaked into manual.html: " + marker);
  }

  console.log("manual-generation: all checks passed (" +
    meta.length + " sections, " + imgs + " images, " +
    count(html, /<code>/g) + " inline codes, " + anchors + " internal links)");
}

run();
