#!/usr/bin/env node
/**
 * Model 33 ASR paper-tape reader tests.
 *
 * Three layers:
 *   1. Modular: extracts the pure bytesFromFile() helper straight from the
 *      real source (src/reader.js) and verifies .ptap raw bytes, .txt
 *      ASCII mapping and the empty-tape rejection (the .zst path needs the
 *      browser fzstd, so it is only checked structurally).
 *   2. Structural: string checks on the production markup (pdp11.html) —
 *      the #readertape window, the Load tape / Remove tape from reader
 *      buttons, the hidden file input with its accept list, the script tag —
 *      and on css/g60printer.css (the hanging-tape rules), src/iopage.js
 *      (the "input drained" signal), src/pdp11-app.js (mode wiring) and
 *      src/snapshots.js (L2 capture/restore).
 *   3. Behaviour (browser): a Puppeteer probe loads a real .ptap into the
 *      reader, checks the hanging tape, the FREE-only Remove button and the
 *      START-mode feed. Run with the dev server on :1170:
 *        node tests/reader.test.js --browser
 *
 * Run with:  node tests/reader.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "reader.js");
const HTML_PATH = path.join(__dirname, "..", "pdp11.html");
const CSS_PATH = path.join(__dirname, "..", "css", "g60printer.css");
const IOPAGE_PATH = path.join(__dirname, "..", "src", "iopage.js");
const APP_PATH = path.join(__dirname, "..", "src", "pdp11-app.js");
const SNAPSHOTS_PATH = path.join(__dirname, "..", "src", "snapshots.js");

// ------------------------------------------------------------------
// Minimal brace-balancing extractor for a single top-level function.
// ------------------------------------------------------------------
function extractBlock(src, startMarker, tail) {
  const start = src.indexOf(startMarker);
  if (start === -1) {
    throw new Error("marker not found: " + startMarker);
  }
  const open = src.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1) + (tail || "");
}

function loadReaderModule() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  // Stub the browser-only bits the module touches at load time.
  const sandbox = {
    window: {},
    document: undefined,
    fzstd: undefined,
    Config: undefined,
    Uint8Array,
    ArrayBuffer,
    TextDecoder,
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // The module defines window.tapeReader inside an IIFE; run it and pull the
  // pure helper out of the exposed object.
  vm.runInContext(src, sandbox);
  return sandbox.window.tapeReader;
}

// ------------------------------------------------------------------
// 1. Pure bytesFromFile() behaviour
// ------------------------------------------------------------------
{
  const reader = loadReaderModule();
  assert.ok(reader, "tapeReader exposed");

  // .ptap: raw bytes pass through unchanged.
  const raw = new Uint8Array([0x48, 0x49, 0x0d, 0x00, 0x7f]).buffer;
  const ptap = reader.bytesFromFile(raw, "tape.ptap");
  assert.deepStrictEqual(Array.from(ptap), [0x48, 0x49, 0x0d, 0x00, 0x7f],
    ".ptap bytes pass through unchanged");

  // .txt: characters become 7-bit ASCII codes (CR/LF and FF kept).
  const enc = new TextEncoder();
  const txt = reader.bytesFromFile(enc.encode("HI\r\n\f").buffer, "listing.txt");
  assert.deepStrictEqual(Array.from(txt), [0x48, 0x49, 0x0d, 0x0a, 0x0c],
    ".txt maps characters to 7-bit ASCII");

  // .txt masks to 7 bits (e.g. 'Ä' -> 0xC4 & 0x7F = 0x44).
  const utf = reader.bytesFromFile(enc.encode("Ä").buffer, "u.txt");
  assert.strictEqual(utf[0], 0x44, ".txt bytes are masked to 7 bits");

  // Empty tape is rejected.
  assert.strictEqual(reader.bytesFromFile(new ArrayBuffer(0), "empty.ptap"), null,
    "empty tape rejected");

  // Unknown extension: treated as raw bytes.
  const other = reader.bytesFromFile(raw, "tape.bin");
  assert.deepStrictEqual(Array.from(other), [0x48, 0x49, 0x0d, 0x00, 0x7f],
    "unknown extension treated as raw bytes");

  // .zst without fzstd (Node): rejected cleanly.
  assert.strictEqual(reader.bytesFromFile(raw, "tape.ptap.zst"), null,
    ".zst without fzstd rejected");
  console.log("OK  bytesFromFile (.ptap/.txt/empty/zst-without-fzstd)");
}

// ------------------------------------------------------------------
// 2. Structural checks on the production sources
// ------------------------------------------------------------------
{
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const css = fs.readFileSync(CSS_PATH, "utf8");
  const iopage = fs.readFileSync(IOPAGE_PATH, "utf8");
  const app = fs.readFileSync(APP_PATH, "utf8");
  const snaps = fs.readFileSync(SNAPSHOTS_PATH, "utf8");
  const src = fs.readFileSync(SOURCE_PATH, "utf8");

  // pdp11.html: the hanging-tape window inside the ASR tape unit, the two
  // operator buttons, the hidden file input with the .ptap/.ptap.zst/.txt
  // accept list, and the script tag.
  assert.ok(html.includes('<div id="readertape"></div>'),
    "pdp11.html has the #readertape window");
  assert.ok(html.includes('id="tty-load-tape"'),
    "pdp11.html has the Load tape button");
  assert.ok(html.includes('id="tty-remove-tape"'),
    "pdp11.html has the Remove tape from reader button");
  assert.ok(html.includes('class="tty-btn hidden" id="tty-remove-tape"'),
    "Remove tape from reader starts hidden");
  assert.ok(html.includes('id="tty-tape-file" accept=".ptap,.ptap.zst,.txt"'),
    "file input accepts .ptap, .ptap.zst and .txt");
  assert.ok(html.includes("src='src/reader.js'"),
    "pdp11.html loads src/reader.js");

  // css/g60printer.css: the reader tape hangs from the reader slot (top 298)
  // with the same ragged-end treatment as the punched tape.
  assert.ok(css.includes("#readertape"), "css styles #readertape");
  assert.ok(css.includes("top: 298px"), "reader tape hangs from the reader slot");
  assert.ok(css.includes("#readertape__body::after"), "reader tape has the ragged end");
  assert.ok(css.includes(".tty-btn.hidden"), "css hides the FREE-only button");

  // iopage.js: the DL11 console input signals "drained" for the AUTO reader.
  assert.ok(iopage.includes("window.onConsoleInputDrained"),
    "iopage.js fires the input-drained signal");

  // pdp11-app.js: the reader switch drives the mechanism and the FREE-only
  // button; X-ON kicks the AUTO reader.
  assert.ok(app.includes("window.tapeReader.setMode"),
    "pdp11-app.js drives the reader on mode change");
  assert.ok(app.includes("tty-remove-tape") && app.includes("mode !== 'free'"),
    "pdp11-app.js shows Remove tape only in FREE");
  assert.ok(app.includes("window.tapeReader.kick"),
    "pdp11-app.js kicks the AUTO reader on X-ON");
  assert.ok(app.includes("tty-load-tape") && app.includes("tty-tape-file"),
    "pdp11-app.js wires the Load tape button + file input");
  assert.ok(app.includes("window.tapeReader.removeTape"),
    "pdp11-app.js wires Remove tape from reader");

  // snapshots.js: the reader tape joins the machine-state capture/restore.
  assert.ok(snaps.includes("readertape: readertape"),
    "snapshots.js captures the reader tape");
  assert.ok(snaps.includes("window.tapeReader.restore"),
    "snapshots.js restores the reader tape");

  // reader.js itself: the AUTO signal listener is exposed.
  assert.ok(src.includes("window.onConsoleInputDrained = onDrained"),
    "reader.js exposes the drained listener");
  console.log("OK  structural checks (html/css/iopage/app/snapshots)");
}

// ------------------------------------------------------------------
// 3. Optional browser behaviour probe (needs the dev server on :1170)
// ------------------------------------------------------------------
async function browserProbe() {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      try { localStorage.setItem("yapdp.onboarding.v1", "done"); } catch (e) {}
    });
    await page.goto("http://localhost:1170/pdp11.html", { waitUntil: "load", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1200));

    // Open the teletype page (the reader lives in the ASR unit there).
    await page.click('[data-page="teletype"]');
    await new Promise((r) => setTimeout(r, 400));

    // Build a real .ptap fixture (36 bytes) and load it through the dialog.
    const fixture = Buffer.from(Array.from({ length: 36 }, (_, i) => 0x41 + (i % 26)));
    const tmp = path.join(require("os").tmpdir(), "reader-fixture.ptap");
    fs.writeFileSync(tmp, fixture);
    const input = await page.$("#tty-tape-file");
    await input.uploadFile(tmp);

    const loaded = await page.evaluate(() => {
      const rows = document.querySelectorAll("#readertape__body .pt-row").length;
      const btnHidden = document.getElementById("tty-remove-tape").classList.contains("hidden");
      return { rows, btnHidden };
    });
    assert.strictEqual(loaded.rows, 36, "loaded tape renders 36 rows");
    assert.strictEqual(loaded.btnHidden, true, "Remove tape hidden in STOP");
    console.log("OK  browser: tape loaded, 36 rows hang from the reader");

    // FREE shows the Remove button, STOP hides it.
    await page.click('[data-reader-mode="free"]');
    let vis = await page.evaluate(() =>
      document.getElementById("tty-remove-tape").classList.contains("hidden"));
    assert.strictEqual(vis, false, "Remove tape visible in FREE");
    await page.click('[data-reader-mode="stop"]');
    vis = await page.evaluate(() =>
      document.getElementById("tty-remove-tape").classList.contains("hidden"));
    assert.strictEqual(vis, true, "Remove tape hidden again in STOP");
    console.log("OK  browser: Remove tape button FREE-only");

    const countRows = () => page.evaluate(() =>
      document.querySelectorAll("#readertape__body .pt-row").length);

    // START feeds: rows disappear over time and bytes reach the DL11.
    await page.click('[data-reader-mode="start"]');
    await new Promise((r) => setTimeout(r, 1500));
    const fed = await page.evaluate(() => {
      const rows = document.querySelectorAll("#readertape__body .pt-row").length;
      const has = window.tapeReader.hasTape();
      return { rows, has };
    });
    assert.ok(fed.rows < 36, "START consumed rows (" + fed.rows + " left)");
    console.log("OK  browser: START feeds, tape moves up (" + fed.rows + " rows left)");

    // LOCAL: the tape becomes paper text only — nothing reaches the DL11.
    // Spy on dlReceiveQueue and count characters actually rendered on paper
    // via the render hook (the machine is halted, so only the reader prints).
    await page.click('[data-reader-mode="stop"]');
    await page.click('[data-tty-mode="local"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.evaluate(() => {
      window.__dlCalls = 0;
      window.__rendered = 0;
      window.__dbg = [];
      const original = window.dlReceiveQueue;
      window.dlReceiveQueue = function () {
        window.__dlCalls++;
        return original.apply(null, arguments);
      };
      window.__consoleRenderHook = function (code) {
        window.__rendered++;
        window.__dbg.push(code);
      };
    });
    // Let the printer's queue drain from the earlier LINE test, then reset
    // the render counter so it counts only the LOCAL read.
    await new Promise((r) => setTimeout(r, 1000));
    await page.evaluate(() => { window.__rendered = 0; });
    const localBefore = await countRows();
    await page.click('[data-reader-mode="start"]');
    await new Promise((r) => setTimeout(r, 1500));
    const local = await page.evaluate(() => ({
      rows: document.querySelectorAll("#readertape__body .pt-row").length,
      dlCalls: window.__dlCalls,
      rendered: window.__rendered,
    }));
    const localConsumed = localBefore - local.rows;
    assert.ok(localConsumed > 5, "LOCAL consumed rows (" + localConsumed + ")");
    assert.strictEqual(local.dlCalls, 0,
      "LOCAL sends nothing to the machine (dlReceiveQueue calls: " + local.dlCalls + ")");
    // Stop the reader, then let the paper printer's paced queue drain
    // before comparing rendered vs consumed.
    await page.click('[data-reader-mode="stop"]');
    await new Promise((r) => setTimeout(r, 600));
    const localRendered = await page.evaluate(() => window.__rendered);
    const dbg = await page.evaluate(() =>
      window.__dbg.map((c) => String.fromCharCode(c)).join(""));
    assert.strictEqual(localRendered, localConsumed,
      "LOCAL printed every read byte on paper (" + localRendered + " of " + localConsumed + ", dbg: " + dbg + ")");
    await page.click('[data-reader-mode="stop"]');
    await page.click('[data-tty-mode="line"]');
    await new Promise((r) => setTimeout(r, 200));
    console.log("OK  browser: LOCAL tape-to-paper copy, no DL11 traffic");

    // AUTO: one byte goes out immediately on engagement; the next byte
    // follows the DL11 "input drained" signal. The machine here is halted,
    // so the receiver never frees on its own — drive the signal directly to
    // verify the handshake chain deterministically.
    await page.click('[data-reader-mode="stop"]');
    const beforeAuto = await countRows();
    await page.click('[data-reader-mode="auto"]');
    await new Promise((r) => setTimeout(r, 150));
    const afterKick = await countRows();
    assert.strictEqual(afterKick, beforeAuto - 1,
      "AUTO sends one byte on engagement");

    // Drained signal -> the next byte goes out.
    await page.evaluate(() => window.onConsoleInputDrained());
    await new Promise((r) => setTimeout(r, 150));
    const afterDrained = await countRows();
    assert.strictEqual(afterDrained, afterKick - 1,
      "AUTO feeds one byte per drained signal");

    // DC3 (X-OFF) pauses the AUTO reader; drained signals feed nothing.
    await page.evaluate(() => window.g60ConsoleWrite(0x13));
    await page.evaluate(() => window.onConsoleInputDrained());
    await new Promise((r) => setTimeout(r, 150));
    const afterXoff = await countRows();
    assert.strictEqual(afterXoff, afterDrained,
      "DC3/X-OFF pauses the AUTO reader");

    // DC1 (X-ON) resumes: one byte goes out again.
    await page.evaluate(() => window.g60ConsoleWrite(0x11));
    await new Promise((r) => setTimeout(r, 150));
    const afterXon = await countRows();
    assert.strictEqual(afterXon, afterXoff - 1,
      "DC1/X-ON resumes the AUTO reader");
    console.log("OK  browser: AUTO per-byte handshake + X-ON/X-OFF");

    // Tape-to-tape duplication: punch ON + reader START punches every
    // read byte onto the output tape (the classic ASR copy trick).
    // Load a fresh tape first (the AUTO tests nearly consumed the old one).
    // Duplication runs in LOCAL: the reader drives the printer, and the
    // punch (on the same local loop) duplicates every byte onto the output
    // tape — the classic ASR copy, no computer involved.
    await page.click('[data-reader-mode="stop"]');
    await page.click('[data-tty-mode="local"]');
    await new Promise((r) => setTimeout(r, 200));
    const input2 = await page.$("#tty-tape-file");
    await input2.uploadFile(tmp);
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => {
      if (window.paperTape && typeof window.paperTape.clear === "function") {
        window.paperTape.clear();
      }
      window.__rendered = 0;
    });
    await page.click("#punch-on");
    await new Promise((r) => setTimeout(r, 200));
    const dupBefore = await countRows();
    await page.click('[data-reader-mode="start"]');
    await new Promise((r) => setTimeout(r, 1200));
    await page.click('[data-reader-mode="stop"]');
    await new Promise((r) => setTimeout(r, 700));
    const dup = await page.evaluate(() => ({
      readerRows: document.querySelectorAll("#readertape__body .pt-row").length,
      punchRows: document.querySelectorAll("#punchtape__body .pt-row").length,
      rendered: window.__rendered,
    }));
    const dupConsumed = dupBefore - dup.readerRows;
    assert.ok(dupConsumed > 3, "duplication consumed rows (" + dupConsumed + ")");
    assert.strictEqual(dup.punchRows, dupConsumed,
      "punch duplicated every read byte (" + dup.punchRows + " rows for " + dupConsumed + " bytes)");
    await page.click("#punch-off");
    console.log("OK  browser: punch duplicates the read tape (tape-to-tape)");

    // LINE with a halted machine: the reader sends bytes to the DL11 but
    // prints nothing locally — the guest's echo is the only print (BASIC
    // would otherwise double every entered character). The halted machine
    // echoes nothing, so rendered must stay 0.
    await page.click('[data-reader-mode="stop"]');
    // Tear off the punched tape first: a hanging punched tape passes in
    // front of the reader switch (authentic), so the switch is only
    // reachable once the tape is off.
    await page.evaluate(() => {
      if (window.paperTape && typeof window.paperTape.clear === "function") {
        window.paperTape.clear();
      }
    });
    await page.click('[data-tty-mode="line"]');
    await new Promise((r) => setTimeout(r, 200));
    const input3 = await page.$("#tty-tape-file");
    await input3.uploadFile(tmp);
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => {
      window.__dlCalls = 0;
      window.__rendered = 0;
    });
    const lineBefore = await countRows();
    await page.click('[data-reader-mode="start"]');
    await new Promise((r) => setTimeout(r, 1200));
    await page.click('[data-reader-mode="stop"]');
    await new Promise((r) => setTimeout(r, 700));
    const line = await page.evaluate(() => ({
      rows: document.querySelectorAll("#readertape__body .pt-row").length,
      dlCalls: window.__dlCalls,
      rendered: window.__rendered,
    }));
    const lineConsumed = lineBefore - line.rows;
    assert.ok(lineConsumed > 3, "LINE consumed rows (" + lineConsumed + ")");
    assert.strictEqual(line.dlCalls, lineConsumed,
      "LINE sent every byte to the machine (" + line.dlCalls + " of " + lineConsumed + ")");
    assert.strictEqual(line.rendered, 0,
      "LINE prints nothing locally (echo prints; rendered: " + line.rendered + ")");
    console.log("OK  browser: LINE sends to the machine, no local print");

    // Remove tape in FREE clears the reader.
    await page.click('[data-reader-mode="free"]');
    await page.click("#tty-remove-tape");
    const cleared = await page.evaluate(() => ({
      rows: document.querySelectorAll("#readertape__body .pt-row").length,
      has: window.tapeReader.hasTape(),
    }));
    assert.strictEqual(cleared.rows, 0, "reader empty after Remove tape");
    assert.strictEqual(cleared.has, false, "no tape after Remove tape");
    console.log("OK  browser: Remove tape clears the reader");
  } finally {
    await browser.close();
  }
}

if (process.argv.includes("--browser")) {
  browserProbe().then(() => {
    console.log("ALL BROWSER PROBES PASSED");
  }).catch((e) => {
    console.error("BROWSER PROBE FAILED:", e.message);
    process.exit(1);
  });
} else {
  console.log("All reader tests passed.");
}
