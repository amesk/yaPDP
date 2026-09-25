#!/usr/bin/env node
/**
 * yaPDP — printed manual generator.
 *
 * Renders manual.html and manual_ru.html to PDF through puppeteer, with a
 * cover page for each language, so the manual can be attached to a release
 * asset and downloaded from the landing page. The document is the SAME
 * document as the web manual: the print rules live in @media print inside
 * tools/manual-template-head.html, and nothing here re-implements the layout.
 *
 * The PDF is honest about being digital — Chromium's own engine produces it and
 * the metadata says so. What it is: a properly paginated manual with a cover,
 * real selectable text, working links and pictures that keep their captions.
 *
 * Usage:
 *   node tools/build-manual-pdf.js              # both languages
 *   node tools/build-manual-pdf.js en           # only manual.pdf
 *   node tools/build-manual-pdf.js ru           # only manual_ru.pdf
 *
 * Output: dist-docs/manual.pdf, dist-docs/manual_ru.pdf
 *
 * The pages are loaded over HTTP from the repository's own static server
 * (tools/serve.js) on a private port, because a file:// page cannot fetch the
 * fonts and pictures the way the deployed site does.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist-docs");
const PORT = 1187;

// A4 at 96dpi minus the margins puppeteer applies, in millimetres. The numbers
// are the ones passed to page.pdf() below; keeping them here means the cover
// and the body agree on the page box.
// Keeping them together means the cover and the body agree on the page box.
const A4 = { width: 210, height: 297, margin: 18 };

const PAGES = {
  en: { file: "manual.html", out: "manual.pdf", lang: "EN" },
  ru: { file: "manual_ru.html", out: "manual_ru.pdf", lang: "RU" },
};

function startServer() {
  return new Promise((resolve, reject) => {
    const srv = spawn(process.execPath, [path.join(ROOT, "tools", "serve.js"),
      "--port", String(PORT), "--dir", ROOT], { stdio: "ignore" });
    srv.on("error", reject);
    // Poll until it answers, rather than sleeping a fixed amount: a slow machine
    // would otherwise fail the first request.
    let tries = 0;
    const tick = () => {
      http.get({ host: "127.0.0.1", port: PORT, path: "/manual.html" }, (res) => {
        res.resume();
        resolve(srv);
      }).on("error", () => {
        if (++tries > 50) return reject(new Error("serve.js did not come up"));
        setTimeout(tick, 100);
      });
    };
    tick();
  });
}

// The cover is the first block of the printed document, not a separate PDF that
// has to be merged afterwards.
//
// Merging was tried first and abandoned: it meant renumbering PDF objects and
// splicing page trees by pattern, which is guessing at a format that has a
// grammar. Appending the cover as the first page of the same HTML keeps the
// file's structure entirely Chromium's business — one page.pdf() call, no
// dependency, nothing to get wrong.
//
// It carries a page break after it so the body starts on a fresh page, and it
// is hidden with @media screen rules injected alongside: this markup only ever
// exists for the PDF run, because the script injects it into the loaded page.
function coverHtml(lang, title, subtitle, date) {
  const t = {
    en: { manual: "User Manual", machine: "DEC PDP-11/70 in the browser",
      foot: "Yet Another PDP-11/70 Emulator" },
    ru: { manual: "Руководство пользователя", machine: "DEC PDP-11/70 в браузере",
      foot: "Yet Another PDP-11/70 Emulator" },
  }[lang];
  return `
<div class="pdf-cover">
  <div class="pdf-cover-brand">
    <span class="pdf-cover-digital">digital</span>
    <span class="pdf-cover-model">| PDP-11/70</span>
  </div>
  <div class="pdf-cover-mid">
    <h1 class="pdf-cover-title">${title}</h1>
    <p class="pdf-cover-subtitle">${t.manual} · ${t.machine}</p>
    <p class="pdf-cover-machine">yaPDP — ${t.foot}</p>
  </div>
  <div class="pdf-cover-meta">
    <b>yaPDP</b> · Yet Another PDP‑11/70 Emulator<br>
    Date: ${date}<br>
    Panel adapted from Paul Nankervis's pdp11-js · printing engine from
    mass:werk (Norbert Landsteiner)
  </div>
</div>`;
}

// The cover's own rules, injected with it. Kept next to the markup rather than
// in the shared template: the web pages never show a cover, so putting it in
// manual-template-head.html would be dead CSS on every screen.

// The cover's rules, injected with its markup. Kept here rather than in the
// shared template: the web pages never show a cover, so putting it in
// manual-template-head.html would be dead CSS on every screen.
const COVER_CSS = `
.pdf-cover {
  display: flex;
  flex-direction: column;
  height: 250mm;
  padding: 12mm 6mm;
  box-sizing: border-box;
  page-break-after: always;
  break-after: page;
  color: #1a1815;
}
.pdf-cover-brand {
  display: flex;
  align-items: baseline;
  gap: 6px;
  border-bottom: 2px solid #c8a860;
  padding-bottom: 6mm;
}
.pdf-cover-digital { font-size: 20pt; font-weight: bold; letter-spacing: 2px; }
.pdf-cover-model { font-size: 20pt; color: #8a7650; }
.pdf-cover-mid { flex: 1; display: flex; flex-direction: column; justify-content: center; }
.pdf-cover-title { font-size: 28pt; line-height: 1.25; margin: 0 0 6mm 0; color: #1a1815; }
.pdf-cover-subtitle { font-size: 13pt; color: #4a453a; margin: 0 0 10mm 0; }
.pdf-cover-machine { font-size: 11pt; color: #6a5f4a; margin: 0; }
.pdf-cover-meta {
  border-top: 1px solid #d8d0bc;
  padding-top: 4mm;
  font-size: 9pt;
  color: #6a5f4a;
  line-height: 1.7;
}
.pdf-cover-meta b { color: #1a1815; }
`;

// The title of the document, taken from its own <h1> so the cover cannot drift
// from the page it introduces.
// --- reading the finished PDF ------------------------------------------------

// Where each contents entry landed in a finished PDF, keyed by the anchor id the
// contents list links to.
//
// PDF.js parses the file properly and getTextContent() returns every run with
// its coordinates, so a heading can be found by its own text rather than
// guessed at from the flow. Titles are matched longest-first, because a short
// heading can be a prefix of a longer one — "Storage" inside "Storage (paper
// tape, disk & tape images)" — and the longer candidate must win that race.
//
async function pageNumbersFor(pdfBuffer, candidates) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // The worker path must point at a real file. An empty string does not mean
  // "run in-process": PDF.js then fails with "Setting up fake worker failed",
  // which is how this was discovered. The path is resolved from the package
  // location, so it holds wherever the tool is run from.
  const worker = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;

  // Page 1 is the cover and is not numbered, so the printed page numbers are
  // the indices minus one. The cover is where the reader sees "no number"; the
  // contents therefore refers to the PDF's own pages, which is what a PDF
  // reader shows in its toolbar, and that is the number the footer prints too.
  const found = {};
  // A heading is typeset as a heading; the same words in the contents list are
  // body text. That difference is the whole test: "The Front Panel (Panel page)"
  // appears on two pages — once in the list of contents and once where the
  // section starts — and only the second one is set in the large face. Matched
  // by text alone the map pointed at the contents page. Measured on a real
  // render: 17.95pt for a body heading against 11.96pt for its contents entry,
  // so a threshold between them separates the two reliably.
  const HEADING_MIN_HEIGHT = 15;
  for (let pageNo = 1; pageNo <= doc.numPages && candidates.length; pageNo++) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    // Only items set large enough to be a heading take part; the rest of the
    // page is still joined into `text` for nothing — the needle search below
    // runs against the heading runs alone.
    const headingText = content.items
      .filter((it) => it.height >= HEADING_MIN_HEIGHT)
      .map((it) => it.str).join(" ").replace(/\s+/g, " ");
    if (!headingText) continue;
    for (const c of candidates.slice()) {
      if (found[c.id] !== undefined) continue;
      const needle = c.title.replace(/\s+/g, " ");
      if (headingText.indexOf(needle) !== -1) {
        found[c.id] = pageNo;
        candidates.splice(candidates.indexOf(c), 1);
      }
    }
  }
  if (doc.cleanup) await doc.cleanup();
  return found;
}

function titleOf(html) {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "yaPDP";
}

async function buildOne(browser, key, stamp) {
  const spec = PAGES[key];
  const url = "http://127.0.0.1:" + PORT + "/" + spec.file;
  const html = fs.readFileSync(path.join(ROOT, spec.file), "utf8");
  const title = titleOf(html);

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.evaluateHandle("document.fonts.ready");
  // The cover and its styles are injected into the loaded page, so the PDF is a
  // single call over a single document and its structure stays Chromium's
  // business. Neither reaches the web manual.
  await page.addStyleTag({ content: COVER_CSS });
  await page.evaluate((markup) => {
    const host = document.querySelector(".landing-page") || document.body;
    const wrap = document.createElement("div");
    wrap.innerHTML = markup;
    host.insertBefore(wrap.firstElementChild, host.firstChild);
    // The illustration viewer is a JavaScript overlay with nothing to click on
    // paper; @media print hides it, and this drops the empty host as well.
    document.querySelectorAll(".shot-viewer").forEach((el) => el.remove());
  }, coverHtml(key, title, "DEC PDP-11/70 in the browser", stamp));

  // --- page numbers in the table of contents -------------------------------
  //
  // A contents list belongs on paper with page numbers, and the paginator decides
  // them after layout — the two-pass affair LaTeX makes of \tableofcontents.
  //
  // Two attempts are recorded here because both failed in instructive ways:
  //
  //   1. floor(offsetTop / page height). Wrong: page-break-inside: avoid on
  //      figures and tables pushes whole blocks to the next page, so the
  //      document runs longer than a division of the flow predicts, and the
  //      error grows as you read — measured +1 by the second section, +6 by the
  //      tenth.
  //   2. content: target-counter(attr(href url), page). CSS.supports answers
  //      true for it, but Chromium has no counter(page) — also verified — so
  //      there is nothing for target-counter to read. Nothing was rendered.
  //
  // What works is asking the finished PDF where each heading landed, and the
  // tool for that is PDF.js: it is the engine behind Firefox's viewer now
  // compiled for Node, it parses the file properly, and getTextContent() hands
  // back every run with its coordinates. One dependency, no native build, same
  // behaviour on every platform. The generator therefore runs twice: render,
  // read the map, write the numbers in, render again. If the second render
  // shifts the pagination the numbers are checked once more and the pass is
  // repeated, which is exactly what "rerun to get cross-references right"
  // means in LaTeX.
  await page.emulateMediaType("print");
  await page.addStyleTag({ content:
    "@media print {" +
    ".landing-page ol { list-style: none; padding-left: 0; }" +
    ".landing-page ol li { position: relative; page-break-inside: avoid;" +
    " break-inside: avoid; padding-right: 12mm; }" +
    /* Reserved for the number, written into the list by the caller. Absolute
       positioning keeps a long title from wrapping around it. */
    ".landing-page ol li .toc-page { position: absolute; right: 0;" +
    " color: #000; font-variant-numeric: tabular-nums; }" +
    "}" });

  const renderPdf = async () => page.pdf({
    format: "A4",
    printBackground: false,
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate:
      '<div style="width:100%;font-size:8pt;color:#6a5f4a;' +
      "font-family:'Courier Prime',monospace;padding:0 " + A4.margin + 'mm;' +
      'display:flex;justify-content:space-between;">' +
      "<span>yaPDP — " + (key === "en" ? "User Manual" : "Руководство пользователя") +
      '</span><span class="pageNumber"></span></div>',
    margin: { top: A4.margin + "mm", right: A4.margin + "mm",
      bottom: A4.margin + "mm", left: A4.margin + "mm" },
  });

  // Which contents entries the list carries, in order, with the heading text
  // each one points at. Read from the live document so the map keys and the
  // markup cannot disagree.
  const entries = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".landing-page ol li a[href^='#']").forEach((a) => {
      out.push({ id: a.getAttribute("href").slice(1), title: a.textContent.trim() });
    });
    return out;
  });

  // The heading text must be found in a page's text layer, and headings are
  // typeset as headings — but the layer carries the same characters, so an exact
  // match on the title is the test. Titles are matched by longest-first: a short
  // heading can be a prefix of a longer one ("Storage" inside "Storage (paper
  // tape, disk & tape images)"), so the longer candidate has to win.
  const byTitle = entries.slice().sort((a, b) => b.title.length - a.title.length);

  let pdf = await renderPdf();
  const written = {};
  let pass = 0;
  while (pass < 3) {
    pass++;
    const map = await pageNumbersFor(pdf, byTitle);
    // Stop when a pass changes nothing: the numbers are then stable and a
    // further render would only repeat the same file.
    let changed = false;
    for (const id of Object.keys(map)) {
      if (written[id] !== map[id]) changed = true;
    }
    if (!changed && pass > 1) break;
    Object.assign(written, map);
    const applied = await page.evaluate((numbers) => {
      let n = 0;
      document.querySelectorAll(".landing-page ol li").forEach((li) => {
        const a = li.querySelector("a[href^='#']");
        if (!a) return;
        const id = a.getAttribute("href").slice(1);
        const num = numbers[id];
        if (num === undefined) return;
        let span = li.querySelector(".toc-page");
        if (!span) {
          span = document.createElement("span");
          span.className = "toc-page";
          li.appendChild(span);
        }
        span.textContent = String(num);
        n++;
      });
      return n;
    }, written);
    if (!applied) break;
    pdf = await renderPdf();
  }
  await page.close();

  return { pdf: pdf, out: spec.out, pages: written, passes: pass };
}


(async () => {
  const want = process.argv[2];
  const keys = want ? [want] : Object.keys(PAGES);
  for (const k of keys) {
    if (!PAGES[k]) {
      console.error("unknown language: " + k + " (expected en or ru)");
      process.exit(2);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const srv = await startServer();
  const browser = await puppeteer.launch({
    args: process.env.PUPPETEER_NO_SANDBOX ? ["--no-sandbox"] : [],
  });

  // The date on the cover is the day the file was produced, not the day of the
  // build: a printed edition carries its own date.
  const stamp = new Date().toISOString().slice(0, 10);

  try {
    for (const k of keys) {
      const { pdf, out } = await buildOne(browser, k, stamp);
      fs.writeFileSync(path.join(OUT_DIR, out), pdf);
      const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
      console.log("wrote " + path.relative(ROOT, path.join(OUT_DIR, out)) +
        " (" + (pdf.length / 1024).toFixed(0) + " KB, " + pages + " pages)");
    }
  } finally {
    await browser.close();
    srv.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
