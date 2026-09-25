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
      other: "Русское издание — отдельный файл",
      foot: "Yet Another PDP-11/70 Emulator" },
    ru: { manual: "Руководство пользователя", machine: "DEC PDP-11/70 в браузере",
      other: "English edition is a separate file",
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
    <p class="pdf-cover-machine">yaPDP — ${t.foot}<br>${t.other}</p>
  </div>
  <div class="pdf-cover-meta">
    <b>yaPDP</b> · Yet Another PDP‑11/70 Emulator<br>
    Edition: ${t.manual} (${lang.toUpperCase()})<br>
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

  const pdf = await page.pdf({
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
  await page.close();

  return { pdf: pdf, out: spec.out };
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
