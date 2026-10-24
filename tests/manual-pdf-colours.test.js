#!/usr/bin/env node
/**
 * Printed-manual colour guard.
 *
 * The PDF manual is black on white with one muted chrome — the running header
 * and footer and the hairlines over them. Nothing else may be coloured: on
 * paper a screen accent reads as a mistake, and the glossary's gold terms were
 * exactly that until they were overridden in the print block.
 *
 * Two checks, because the same defect can enter by two doors:
 *
 *   1. The print stylesheet (tools/manual-template-head.html, the @media print
 *      block) may declare only paper colours. This is the cheap, deterministic
 *      half: a screen rule whose colour is never overridden on paper is
 *      caught here, without a browser.
 *   2. If manual.pdf / manual_ru.pdf are present, the fill colours Chromium
 *      actually wrote onto the glossary pages are read back with PDF.js and
 *      must be the paper set as well. This is the half that would have caught
 *      the gold terms: the browser converts #e8d080 into the print profile, so
 *      the value in the file is #948551 — not the token you typed.
 *
 * The glossary pages are taken as the range from the chapter heading (set in
 * the large face, so the contents list does not match) to the page before the
 * next chapter. Hiding the failure inside a chapter that is never checked is
 * the other way this could go wrong, hence the assertion that the chapter was
 * found at all.
 *
 * Run with:  node tests/manual-pdf-colours.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TEMPLATE = path.join(ROOT, "tools", "manual-template-head.html");

// What a printed sheet may carry: white ground, black text, the chrome colour
// of the running header/footer (#6a5f4a) and the hairlines drawn over them
// (#8a8278). Anything else means an accent reached the paper.
const PAPER_FILLS = new Set(["#000000", "#ffffff", "#6a5f4a", "#8a8278"]);

// Values a `color` declaration inside @media print may carry. Keep this
// deliberately short: a colour that is not here needs a reason, and the reason
// belongs in the discussion, not in a silent pass.
const PAPER_COLOUR_DECLS = new Set([
  "#000", "#000000", "#fff", "#ffffff", "inherit", "currentcolor", "transparent",
]);

const PDFS = [
  { file: "manual.pdf", chapter: "glossary" },
  { file: "manual_ru.pdf", chapter: "глоссарий" },
];

// A heading is typeset large; the same words in the contents list are body
// text. 15pt separates the two in a real render (17.95pt against 11.96pt), the
// same threshold tools/build-manual-pdf.js uses for its cross-references.
const HEADING_MIN_HEIGHT = 15;

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// The contents of the first block opened by `marker`, found by balancing
// braces. A regex cannot do this: the block contains one rule per selector.
function blockAfter(css, marker) {
  const at = css.indexOf(marker);
  if (at === -1) return null;
  const open = css.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && !--depth) return css.slice(open + 1, i);
  }
  return null;
}

// Flatten a CSS block into { selector, prop, value } records. The template is
// written one declaration per `;` and one rule per `{}`, so a character walk is
// enough; nested at-rules do not occur inside @media print.
function declarations(block) {
  const out = [];
  const stack = [];
  let buf = "";
  for (const ch of block) {
    if (ch === "{") {
      stack.push(buf.trim());
      buf = "";
    } else if (ch === "}") {
      stack.pop();
      buf = "";
    } else if (ch === ";") {
      const decl = buf.trim();
      buf = "";
      const m = /^([-a-zA-Z]+)\s*:\s*(.+)$/.exec(decl);
      if (m) {
        out.push({
          selector: stack[stack.length - 1] || "",
          prop: m[1].toLowerCase(),
          value: m[2].replace(/\s*!important\s*$/i, "").trim(),
        });
      }
    } else {
      buf += ch;
    }
  }
  return out;
}

function checkStylesheet() {
  const css = stripComments(fs.readFileSync(TEMPLATE, "utf8"));
  const print = blockAfter(css, "@media print");
  assert.ok(print, path.relative(ROOT, TEMPLATE) + " must carry an @media print block");
  const offenders = declarations(print)
    .filter((d) => d.prop === "color" && !PAPER_COLOUR_DECLS.has(d.value.toLowerCase()))
    .map((d) => d.selector + " { color: " + d.value + "; }");
  assert.deepStrictEqual(offenders, [],
    "the @media print block may declare paper colours only; these rules would " +
    "print a screen accent:\n  " + offenders.join("\n  "));
}

async function loadPdfJs() {
  const url = require("url");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Same worker wiring as tools/build-manual-pdf.js: the path has to be a real
  // file, and a URL rather than a Windows path with its drive-letter "scheme".
  pdfjs.GlobalWorkerOptions.workerSrc = url.pathToFileURL(
    require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  return pdfjs;
}

async function pageReport(pdfjs, buffer) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const heading = content.items
      .filter((it) => it.height >= HEADING_MIN_HEIGHT)
      .map((it) => it.str).join("").replace(/\s+/g, "").toLowerCase();
    const ops = await page.getOperatorList();
    const fills = new Set();
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] === pdfjs.OPS.setFillRGBColor) {
        fills.add(ops.argsArray[i].join(",").toLowerCase());
      }
    }
    pages.push({ n, heading, fills });
  }
  if (doc.cleanup) await doc.cleanup();
  return pages;
}

async function checkPdf(pdfjs, spec) {
  const file = path.join(ROOT, spec.file);
  if (!fs.existsSync(file)) {
    console.log("manual-pdf-colours: " + spec.file + " is not built — " +
      "PDF colour check skipped (run `npm run manual:pdf` to include it)");
    return;
  }

  const pages = await pageReport(pdfjs, fs.readFileSync(file));
  const chapters = pages.filter((p) => p.heading);
  const at = chapters.findIndex((p) => p.heading.indexOf(spec.chapter) !== -1);
  assert.ok(at !== -1, spec.file + ": no chapter heading containing '" +
    spec.chapter + "' was found — the colour check needs the glossary chapter");

  const from = chapters[at].n;
  const to = at + 1 < chapters.length ? chapters[at + 1].n - 1 : pages.length;
  const glossary = pages.filter((p) => p.n >= from && p.n <= to);
  assert.ok(glossary.length, spec.file + ": the glossary chapter occupies no pages");

  for (const p of glossary) {
    assert.ok(p.fills.size, spec.file + ": page " + p.n + " carries no fill colours — " +
      "the page was probably not rendered and the check would pass for nothing");
    const extra = [...p.fills].filter((c) => !PAPER_FILLS.has(c));
    assert.deepStrictEqual(extra, [], spec.file + ": page " + p.n +
      " (glossary, pages " + from + "–" + to + ") prints colours that are not paper:\n  " +
      extra.join("\n  "));
  }

  const all = new Set();
  for (const p of glossary) for (const c of p.fills) all.add(c);
  console.log("manual-pdf-colours: " + spec.file + " glossary pages " + from + "–" +
    to + " use " + [...all].join(", "));
}

(async () => {
  checkStylesheet();
  const pdfjs = await loadPdfJs();
  for (const spec of PDFS) await checkPdf(pdfjs, spec);
  console.log("All printed-manual colour checks passed.");
})().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
