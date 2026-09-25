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
      foot: "Yet Another PDP-11/70 Emulator",
      caption: "BASIC-11 on the Model 33 ASR teletype, punched to paper tape — a screenshot from the emulator itself" },
    ru: { manual: "Руководство пользователя", machine: "DEC PDP-11/70 в браузере",
      foot: "Yet Another PDP-11/70 Emulator",
      caption: "BASIC-11 на телетайпе Model 33 ASR, с выводом на перфоленту — кадр из самого эмулятора" },
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
  <figure class="pdf-cover-shot">
    <img src="http://127.0.0.1:${PORT}/assets/images/os/basic.png"
         alt="BASIC-11 running on the Model 33 ASR teletype in yaPDP">
    <figcaption>${t.caption}</figcaption>
  </figure>
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

/* The frame. A dark emulator screenshot floats on a white cover without one,
   and a photograph in a book is expected to be framed — this is that frame:
   a hairline in the cover's own grey, not the gold, which belongs to the brand
   line above. */
.pdf-cover-shot { margin: 0 0 8mm 0; }
.pdf-cover-shot img {
  display: block;
  width: 100%;
  height: auto;
  border: 0.75pt solid #8a8278;
  background: #12100d;
}
.pdf-cover-shot figcaption {
  font-size: 9pt;
  color: #4a453a;
  margin-top: 2mm;
  text-align: center;
}
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

  // --- the cover, printed on its own ---------------------------------------
  //
  // The cover is rendered as a separate one-page document rather than as the
  // first page of the manual, because a running header must not appear above a
  // title page. Both ways of hiding it on page one were measured and both
  // failed:
  //
  //   * @page :first { margin-top: … } — Chromium ignores the :first page
  //     selector entirely (a test page with a 40mm first-page margin printed
  //     its first page at the normal margin).
  //   * CSS inside headerTemplate cannot tell which page it is rendering, so a
  //     rule aimed at the first page put "HEADER" on every page.
  //
  // displayHeaderFooter applies to a whole print call and cannot be narrowed
  // per page. Printing the cover in its own call therefore needs no trick: no
  // header, no footer, nothing to suppress. The two files are not merged —
  // merging was abandoned earlier for good reason — the cover is kept beside the
  // body and the next step concatenates them the way the PDF format intends,
  // through a library rather than by pattern-matching bytes.
  const cover = await browser.newPage();
  await cover.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
  await cover.setContent(
    "<!DOCTYPE html><html><head><meta charset='UTF-8'>" +
    "<link rel='stylesheet' href='http://127.0.0.1:" + PORT + "/css/pdp11.css'>" +
    "<style>body{background:#fff !important;background-image:none !important;}" +
    "body>*{display:none;}</style></head><body></body></html>",
    { waitUntil: "load" });
  await cover.evaluateHandle("document.fonts.ready");
  await cover.addStyleTag({ content: COVER_CSS });
  await cover.evaluate((markup) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = markup;
    document.body.appendChild(wrap.firstElementChild);
  }, coverHtml(key, title, "DEC PDP-11/70 in the browser", stamp));
  const coverPdf = await cover.pdf({
    format: "A4", printBackground: true, displayHeaderFooter: false,
    margin: { top: "18mm", right: "18mm", bottom: "18mm", left: "18mm" },
  });
  await cover.close();

  // --- the body ------------------------------------------------------------
  await page.addStyleTag({ content: COVER_CSS });
  await page.evaluate((markup) => {
    // The body is the manual with its screen chrome removed by @media print; the
    // illustration viewer has nothing to click on paper.
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

  // Header and footer. Chromium prints these outside the content box, in the
  // margin, so the rules below are the only chrome the document carries. The
  // hairline under the header and above the footer separates them from the text
  // — without it the running title sits in the same visual field as the first
  // line of the page and reads as part of it.
  //
  // headerTemplate is only rendered when displayHeaderFooter is on; an empty
  // header meant no header at all, which is why the top of the page was bare.
  // The running title is the product's own description, not the document's:
  // "yaPDP — Yet Another PDP-11/70 Emulator" says which emulator the reader is
  // holding a manual for, which a bare "User Manual" does not.
  //
  // Header and footer are plain text blocks on purpose. An earlier version
  // centred the header with `display:flex; justify-content:flex-end`, and
  // Chromium's header/footer renderer does not lay out flex containers: it kept
  // only the trailing runs of the line, so the header printed as "User Manual"
  // with "yaPDP — " cut off. It renders these templates in a restricted mode —
  // borders are dropped there too — and a text block with text-align is what it
  // supports. Footer keeps a two-cell layout the same way, with justify between
  // the spans replaced by a table-free split: the page number goes in a
  // right-aligned block of its own.
  const productLine = "yaPDP — Yet Another PDP-11/70 Emulator";
  const docName = key === "en" ? "User Manual" : "Руководство пользователя";
  const chromeStyle =
    "width:100%;font-size:8pt;color:#6a5f4a;" +
    "font-family:'Courier Prime',monospace;padding:0 " + A4.margin + "mm;";

  const renderPdf = async () => page.pdf({
    format: "A4",
    printBackground: false,
    displayHeaderFooter: true,
    headerTemplate:
      '<div style="' + chromeStyle + 'text-align:right;">' +
      productLine + "</div>",
    footerTemplate:
      '<div style="' + chromeStyle + 'text-align:left;">' + docName + "</div>" +
      '<div style="' + chromeStyle + 'text-align:right;margin-top:-8pt;">' +
      '<span class="pageNumber"></span></div>',
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

  return { pdf: pdf, cover: coverPdf, out: spec.out, pages: written, passes: pass };
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
    const { PDFDocument, rgb } = await import("pdf-lib");
    for (const k of keys) {
      const { pdf, cover, out } = await buildOne(browser, k, stamp);
      // The cover and the body are joined with pdf-lib, which understands the
      // format. An earlier attempt did this by hand — renumbering objects and
      // splicing the page tree with regexes — and produced a file with no page
      // tree at all. A format with a grammar deserves a parser.
      const merged = await PDFDocument.create();
      const coverDoc = await PDFDocument.load(cover);
      const bodyDoc = await PDFDocument.load(pdf);
      const coverPages = await merged.copyPages(coverDoc, coverDoc.getPageIndices());
      for (const p of coverPages) merged.addPage(p);
      const bodyPages = await merged.copyPages(bodyDoc, bodyDoc.getPageIndices());
      for (const p of bodyPages) merged.addPage(p);

      // --- the rules under the header and over the footer --------------------
      //
      // They cannot be drawn by the header/footer templates: Chromium renders
      // those in a restricted mode that lays out text and drops borders, so the
      // two <div>s with border-bottom/border-top measured nothing at all — the
      // running titles appeared and the lines did not. Whatever the templates
      // do support, a hairline is not it.
      //
      // So the rules are drawn onto the finished pages. Coordinates are in
      // points, origin bottom-left, which is why the header rule sits near the
      // top of the sheet (height − offset) and the footer rule near the bottom.
      // The margin is 18mm and the rules sit inside it, away from the text
      // block: 12mm from each edge, in from the trim by the page margin.
      const MM = 72 / 25.4;
      // Darker than the #b8b0a0 first tried: that tone is a printer's hairline,
      // invisible on screen at 0.5pt, and it was reported as "the lines did not
      // appear" while they were in fact drawn on all 25 body pages. A rule that
      // cannot be seen is not a rule. #8a8278 reads as a deliberate line without
      // competing with the text, and 0.75pt survives both screen and press.
      const ruleColor = rgb(0.541, 0.510, 0.471); // #8a8278
      const marginPx = 18 * MM;
      // The cover is the first page and carries no running header or footer, so
      // it carries no rules either.
      for (let i = coverPages.length; i < merged.getPageCount(); i++) {
        const page = merged.getPage(i);
        const { width, height } = page.getSize();
        const topY = height - 12 * MM;
        const bottomY = 12 * MM;
        page.drawLine({ start: { x: marginPx, y: topY },
          end: { x: width - marginPx, y: topY }, thickness: 0.75, color: ruleColor });
        page.drawLine({ start: { x: marginPx, y: bottomY },
          end: { x: width - marginPx, y: bottomY }, thickness: 0.75, color: ruleColor });
      }

      const bytes = Buffer.from(await merged.save());
      fs.writeFileSync(path.join(OUT_DIR, out), bytes);
      console.log("wrote " + path.relative(ROOT, path.join(OUT_DIR, out)) +
        " (" + (bytes.length / 1024).toFixed(0) + " KB, " + merged.getPageCount() +
        " pages: cover + " + bodyDoc.getPageCount() + ", rules on " +
        (merged.getPageCount() - coverPages.length) + ")");
    }
  } finally {
    await browser.close();
    srv.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
