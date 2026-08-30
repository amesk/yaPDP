#!/usr/bin/env node
/**
 * DataLoader + fetchBlock modular tests.
 *
 * These tests extract the DataLoader, createCache, and fetchBlock sections
 * directly from the real source file (src/iopage.js) so they exercise the
 * actual production code rather than a copy, then run them in an isolated
 * VM context with lightweight stubs for browser-only globals.
 *
 * Run with:  node tests/dataloader.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const DATALOADER_PATH = path.join(__dirname, "..", "src", "dataloader.js");
const IOPAGE_PATH = path.join(__dirname, "..", "src", "iopage.js");

// ------------------------------------------------------------------
// Minimal brace-balancing extractor for a single top-level declaration
// ------------------------------------------------------------------
function extractBlock(src, startMarker, tail) {
  const start = src.indexOf(startMarker);
  if (start === -1) {
    throw new Error("marker not found: " + startMarker);
  }
  const braceOpen = src.indexOf("{", start);
  if (braceOpen === -1) {
    throw new Error("no opening brace for: " + startMarker);
  }
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        // For IIFE-style declarations (e.g. `var DataLoader = (() => { ... })();`)
        // the closing `}` must be followed by a required tail such as `)();`.
        if (tail) {
          const rest = src.slice(i + 1, i + 1 + tail.length);
          if (rest !== tail) {
            throw new Error("expected tail '" + tail + "' after " + startMarker);
          }
          return src.slice(start, i + 1 + tail.length);
        }
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error("unbalanced braces for: " + startMarker);
}

function buildSandbox() {
  // Browser-only globals are stubbed; `fetch` itself is injected by
  // makeContext() as a counting stub so the HTTP path is observable.
  return {
    console,
    Uint8Array,
    Uint16Array,
    ArrayBuffer,
    DataView,
    Map,
    Set,
    fzstd: { decompress: null }, // replaced per-test when needed
    downLoadAdd: () => {},       // no-op: browser download dropdown not needed
  };
}

function loadSections() {
  // DataLoader moved to its own file (refactor); the fetch/cache helpers
  // still live in iopage.js.
  const dl = fs.readFileSync(DATALOADER_PATH, "utf8");
  const src = fs.readFileSync(IOPAGE_PATH, "utf8");

  const ioBlockSize = "const IO_BLOCKSIZE = 131072;";
  const dataLoader = extractBlock(dl, "var DataLoader = (() => {", ")();");
  const createCache = extractBlock(src, "function createCache(cache, block, dataView)");
  const fetchBlock = extractBlock(src, "async function fetchBlock(controlBlock, block)");
  const imageError = extractBlock(src, "function imageError(reason, message)");
  const assertCompleteImage = extractBlock(src, "function assertCompleteImage(response, buffer, url)");

  return { ioBlockSize, dataLoader, createCache, fetchBlock, imageError, assertCompleteImage };
}

// fetchCode, when provided, is a string of VM code that defines `fetch`
// (e.g. a stub returning a full, truncated or failing response). The default
// stub counts calls and answers 404 so the HTTP path is observable.
function makeContext(sandbox, sections, fetchCode) {
  const fetchImpl = fetchCode || [
    "var _fetchCalls = 0;",
    "async function __fetch() { _fetchCalls++; return { ok:false, status:404, arrayBuffer: async () => new ArrayBuffer(0) }; }",
    "fetch = __fetch;",
  ].join("\n");
  const code = [
    sections.ioBlockSize,
    "var DataLoader;",
    sections.dataLoader,
    sections.createCache,
    sections.imageError,
    sections.assertCompleteImage,
    sections.fetchBlock,
    fetchImpl,
  ].join("\n");

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  // Expose the VM-internal call counter for assertions.
  Object.defineProperty(sandbox, "__fetchCalls", {
    get: () => sandbox._fetchCalls,
  });

  return sandbox;
}

async function run() {
  const sections = loadSections();

  // ---- Test 1: mount/get/has/list/unmount/sourceOf -----------------
  {
    const sb = buildSandbox();
    makeContext(sb, sections);
    const DataLoader = sb.DataLoader;

    const bytes = new Uint8Array([1, 2, 3, 4]);
    DataLoader.mount("rk0.dsk", bytes);

    assert.strictEqual(DataLoader.has("rk0.dsk"), true);
    assert.strictEqual(DataLoader.get("rk0.dsk"), bytes);
    assert.strictEqual(DataLoader.has("rp1.dsk"), false);
    assert.strictEqual(DataLoader.get("missing.dsk"), undefined);
    assert.deepStrictEqual(Array.from(DataLoader.list()), ["rk0.dsk"]);
    assert.strictEqual(DataLoader.sourceOf("rk0.dsk"), "local");

    DataLoader.unmount("rk0.dsk");
    assert.strictEqual(DataLoader.has("rk0.dsk"), false);
    console.log("PASS test 1: mount/get/has/list/unmount/sourceOf");
  }

  // ---- Test 2: mountZst decompresses via fzstd ---------------------
  {
    const sb = buildSandbox();
    sb.fzstd.decompress = (buf) => {
      assert.ok(buf instanceof Uint8Array, "fzstd should receive Uint8Array");
      // "Decompress" [10, 20, 30] -> identity for the test.
      return new Uint8Array(buf);
    };
    makeContext(sb, sections);
    const DataLoader = sb.DataLoader;

    const len = DataLoader.mountZst("tm0.tap", new Uint8Array([10, 20, 30]));
    assert.strictEqual(len, 3);
    assert.deepStrictEqual(Array.from(DataLoader.get("tm0.tap")), [10, 20, 30]);
    console.log("PASS test 2: mountZst decompresses via fzstd");
  }

  // ---- Test 3: fetchBlock serves a mounted image without network ----
  {
    const sb = buildSandbox();
    makeContext(sb, sections);

    // Build a small "disk" larger than one cache block so slicing is
    // exercised. IO_BLOCKSIZE is 131072 bytes.
    const imgLen = 131072 + 64; // one full block + a partial tail
    const img = new Uint8Array(imgLen);
    for (let i = 0; i < imgLen; i++) img[i] = i & 0xFF;
    sb.DataLoader.mount("rk0.dsk", img);

    const ctrl = { cache: [], url: "rk0.dsk", compressed: true };
    const status = await sb.fetchBlock(ctrl, 0);

    assert.strictEqual(status, 200);
    assert.strictEqual(sb.__fetchCalls, 0, "HTTP fetch must NOT be called for mounted image");
    assert.ok(ctrl.cache[0] !== undefined, "cache block 0 must be populated");
    assert.strictEqual(ctrl.cache[0].length, 131072 >>> 1, "cache block holds words");

    // Spot-check: first word should be packed little-endian from img[0], img[1].
    assert.strictEqual(ctrl.cache[0][0], (img[0] & 0xFF) | (img[1] << 8));
    // Last word of the full block corresponds to img[131070], img[131071].
    assert.strictEqual(
      ctrl.cache[0][(131072 >>> 1) - 1],
      (img[131070] & 0xFF) | (img[131071] << 8)
    );
    console.log("PASS test 3: fetchBlock serves mounted image without HTTP");
  }

  // ---- Test 4: fetchBlock block slicing at non-zero offset ----------
  {
    const sb = buildSandbox();
    makeContext(sb, sections);

    const img = new Uint8Array(3 * 131072 + 10);
    for (let i = 0; i < img.length; i++) img[i] = (i * 7) & 0xFF;
    sb.DataLoader.mount("rk0.dsk", img);

    const ctrl = { cache: [], url: "rk0.dsk", compressed: true };
    const status = await sb.fetchBlock(ctrl, 1); // request the SECOND block

    assert.strictEqual(status, 200);
    const blk1 = ctrl.cache[1];
    assert.ok(blk1 !== undefined, "cache block 1 must be populated");
    // First word of block 1 corresponds to img[131072], img[131073].
    assert.strictEqual(
      blk1[0],
      (img[131072] & 0xFF) | (img[131073] << 8)
    );
    console.log("PASS test 4: fetchBlock slices mounted image at non-zero block");
  }

  // ---- Test 5: fetchBlock falls back to HTTP when not mounted -------
  {
    const sb = buildSandbox();
    makeContext(sb, sections);

    const ctrl = { cache: [], url: "rp1.dsk", compressed: true };
    let threw = false;
    try {
      await sb.fetchBlock(ctrl, 0);
    } catch (err) {
      threw = true; // expected: the 404 stub cannot provide a .zst image
    }

    assert.ok(threw, "HTTP path should fail (throw) when .zst is unavailable");
    assert.ok(sb.__fetchCalls >= 1, "HTTP fetch must be attempted for unmounted image");
    assert.strictEqual(ctrl.cache[0], undefined, "failed fetch leaves cache empty");
    console.log("PASS test 5: unmounted image still uses HTTP path");
  }

  // ---- Test 6: createCache packs bytes into 16-bit words ------------
  {
    const sb = buildSandbox();
    makeContext(sb, sections);

    const cache = [];
    sb.createCache(cache, 0, new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    assert.ok(cache[0] !== undefined);
    assert.strictEqual(cache[0][0], 0x0201); // low byte first (little-endian)
    assert.strictEqual(cache[0][1], 0x0403);
    console.log("PASS test 6: createCache packs bytes little-endian");
  }

  // ---- Test 7: ptrUrlFor resolves paper-tape select values ---------
  {
    const src = fs.readFileSync(IOPAGE_PATH, "utf8");
    const fn = extractBlock(src, "function ptrUrlFor(name)");
    const sb = buildSandbox();
    vm.createContext(sb);
    vm.runInContext(fn, sb);

    assert.strictEqual(sb.ptrUrlFor("DEC-11-AJPB-PB"), "DEC-11-AJPB-PB.ptap");
    assert.strictEqual(sb.ptrUrlFor("lander"), "lander.ptap");
    assert.strictEqual(sb.ptrUrlFor("bootcode"), "bootcode.ptap");
    assert.strictEqual(sb.ptrUrlFor("foo.ptap"), "foo.ptap");
    assert.strictEqual(sb.ptrUrlFor("MYTAPE.PTAP"), "MYTAPE.PTAP");
    console.log("PASS test 7: ptrUrlFor resolves paper-tape select values");
  }

  // ---- Test 8: fetchBlock serves a mounted .ptap without network ---
  {
    const sb = buildSandbox();
    makeContext(sb, sections);

    const bytes = new Uint8Array([0x55, 0xAA, 0x01, 0x02]);
    sb.DataLoader.mount("foo.ptap", bytes);

    const ctrl = { cache: [], url: "foo.ptap" };
    const status = await sb.fetchBlock(ctrl, 0);

    assert.strictEqual(status, 200);
    assert.strictEqual(sb.__fetchCalls, 0, "HTTP fetch must NOT be called for mounted .ptap");
    assert.strictEqual(ctrl.cache[0][0], 0xAA55); // little-endian packed word
    assert.strictEqual(ctrl.cache[0][1], 0x0201);
    console.log("PASS test 8: fetchBlock serves mounted .ptap without HTTP");
  }

  // ---- Test 9: punchTapeAppend accumulates raw punch bytes --------
  {
    const src = fs.readFileSync(IOPAGE_PATH, "utf8");
    const fn = extractBlock(src, "function punchTapeAppend(buffer, byte)");
    const sb = buildSandbox();
    vm.createContext(sb);
    vm.runInContext(fn, sb);

    const buf = [];
    sb.punchTapeAppend(buf, 0x41);
    sb.punchTapeAppend(buf, 0x0d);
    sb.punchTapeAppend(buf, 0x0a);
    sb.punchTapeAppend(buf, 0x1ff); // only the low 8 bits are kept
    assert.deepStrictEqual(buf, [0x41, 0x0d, 0x0a, 0xff]);
    console.log("PASS test 9: punchTapeAppend accumulates raw punch bytes");
  }

  // ---- Test 10: fetchBlock flags a truncated .zst download ----------
  {
    const sb = buildSandbox();
    // Decompress would succeed if reached; the truncation check must trip first.
    sb.fzstd.decompress = (buf) => new Uint8Array(buf);
    makeContext(sb, sections, [
      "fetch = async () => ({",
      "  ok: true,",
      "  status: 200,",
      "  headers: { get: (name) => (name === 'content-length' ? '100' : null) },",
      "  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer",
      "});",
    ].join("\n"));

    const ctrl = { cache: [], url: "rp1.dsk", compressed: true };
    let caught = null;
    try {
      await sb.fetchBlock(ctrl, 0);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "truncated download should throw");
    assert.strictEqual(caught.imageReason, "truncated",
      "truncated download should be reported as 'truncated'");
    console.log("PASS test 10: fetchBlock detects a truncated .zst download");
  }

  // ---- Test 11: fetchBlock flags a corrupt .zst body -----------------
  {
    const sb = buildSandbox();
    sb.fzstd.decompress = () => { throw new Error("bad zst frame"); };
    makeContext(sb, sections, [
      "fetch = async () => ({",
      "  ok: true,",
      "  status: 200,",
      "  headers: { get: () => null },",
      "  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer",
      "});",
    ].join("\n"));

    const ctrl = { cache: [], url: "rp1.dsk", compressed: true };
    let caught = null;
    try {
      await sb.fetchBlock(ctrl, 0);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "corrupt .zst should throw");
    assert.strictEqual(caught.imageReason, "decompress",
      "corrupt .zst body should be reported as 'decompress'");
    console.log("PASS test 11: fetchBlock flags a corrupt .zst body");
  }

  // ---- Test 12: fetchBlock reports an unreachable .zst as network ----
  {
    const sb = buildSandbox();
    sb.fzstd.decompress = (buf) => new Uint8Array(buf);
    makeContext(sb, sections); // default 404 stub

    const ctrl = { cache: [], url: "rp1.dsk", compressed: true };
    let caught = null;
    try {
      await sb.fetchBlock(ctrl, 0);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "missing .zst should throw");
    assert.strictEqual(caught.imageReason, "network",
      "unreachable .zst should be reported as 'network'");
    console.log("PASS test 12: fetchBlock reports an unreachable .zst as network");
  }

  // ---- Test 13: HTTP image URLs are page-relative (media/…), not ../media ----
  // The image URL is resolved relative to the document URL, so it must start
  // with "media/" — a "../media/" prefix would break whenever the repository is
  // served from a subpath (e.g. GitVerse Pages under /yapdp/).
  {
    const sb = buildSandbox();
    makeContext(sb, sections, [
      "var _fetchedUrls = [];",
      "async function __fetch(url) { _fetchedUrls.push(String(url)); return { ok:false, status:404, arrayBuffer: async () => new ArrayBuffer(0) }; }",
      "fetch = __fetch;",
    ].join("\n"));
    Object.defineProperty(sb, "__fetchedUrls", { get: () => sb._fetchedUrls });

    const ctrl = { cache: [], url: "rp1.dsk", compressed: true };
    try {
      await sb.fetchBlock(ctrl, 0);
    } catch (err) { /* 404 stub: expected to fail */ }

    const urls = sb.__fetchedUrls || [];
    assert.ok(urls.length >= 1, "HTTP fetch should be attempted for unmounted image");
    const first = urls[0];
    assert.ok(/^media\/rp1\.dsk\.zst$/.test(first),
      "image URL must be page-relative media/…, got: " + first);
    assert.ok(first.indexOf("../") === -1, "image URL must not use ../media");
    console.log("PASS test 13: HTTP image URLs are page-relative (media/…), not ../media");
  }

  // ---- Test 14: paper-tape blocks use the .zst fast path like disks ----
  // PTR11 marks its control block `compressed: true` (same as RK/RL/RP/TM),
  // so fetchBlock() must try the bundled `.ptap.zst` FIRST. Before that flag
  // a missing raw `.ptap` was probed with a Range request; a SPA-fallback
  // server could answer it with 200 HTML, filling the cache with garbage that
  // never raises a load error — the boot hung silently instead of showing the
  // "Image load interrupted" overlay.
  {
    const sb = buildSandbox();
    sb.fzstd.decompress = (buf) => new Uint8Array(buf);
    makeContext(sb, sections, [
      "var _fetchedUrls = [];",
      "async function __fetch(url) { _fetchedUrls.push(String(url)); return { ok:false, status:404, arrayBuffer: async () => new ArrayBuffer(0) }; }",
      "fetch = __fetch;",
    ].join("\n"));
    Object.defineProperty(sb, "__fetchedUrls", { get: () => sb._fetchedUrls });

    const ctrl = { cache: [], url: "DEC-11-AJPB-PB.ptap", compressed: true };
    let caught = null;
    try {
      await sb.fetchBlock(ctrl, 0);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "unavailable .zst paper tape should throw");
    assert.strictEqual(caught.imageReason, "network",
      "unreachable .ptap.zst should be reported as 'network'");
    const urls = sb.__fetchedUrls || [];
    assert.ok(urls.length >= 1, "HTTP fetch should be attempted");
    assert.strictEqual(urls[0], "media/DEC-11-AJPB-PB.ptap.zst",
      "compressed paper tape must fetch the .zst file first, got: " + urls[0]);
    console.log("PASS test 14: paper-tape blocks use the .zst fast path");
  }

  // ---- Test 15: raw .ptap fallback when the .zst probe is a SPA page ----
  // A host that answers non-existent .zst paths with a 200 SPA fallback page
  // would otherwise make decompression throw even though the raw .ptap is
  // available (e.g. Lunar Lander ships raw). A .ptap failure must fall through
  // to the raw-file probe and boot from the real bytes.
  {
    const sb = buildSandbox();
    sb.fzstd.decompress = (buf) => {
      throw new Error("not a zst frame");
    };
    makeContext(sb, sections, [
      "var _fetchedUrls = [];",
      "async function __fetch(url) {",
      "  _fetchedUrls.push(String(url));",
      // .zst probe answered 200 with an HTML page (SPA fallback)
      "  if (String(url).indexOf('.zst') !== -1) {",
      "    return { ok:true, status:200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array([0x3c,0x21,0x44,0x4f]).buffer };",
      "  }",
      // raw .ptap answered with the real tape bytes
      "  return { ok:true, status:206, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array([0x55,0xAA,0x01,0x02]).buffer };",
      "}",
      "fetch = __fetch;",
    ].join("\n"));
    Object.defineProperty(sb, "__fetchedUrls", { get: () => sb._fetchedUrls });

    const ctrl = { cache: [], url: "lander.ptap", compressed: true };
    let status = 0;
    let caught = null;
    try {
      status = await sb.fetchBlock(ctrl, 0);
    } catch (err) {
      caught = err;
    }
    assert.strictEqual(caught, null,
      "raw .ptap must not fail when the .zst probe is a SPA page");
    assert.strictEqual(status, 206, "raw .ptap probe must provide the image");
    assert.strictEqual(ctrl.cache[0][0], 0xAA55,
      "cache must be filled from the raw .ptap bytes");
    console.log("PASS test 15: raw .ptap fallback when .zst probe is a SPA page");
  }

  // ---- Test 16: content-encoded .zst must not trip the truncated check ----
  // GitHub Pages answers .zst files with Content-Encoding: gzip. The browser
  // decodes the body transparently, so buffer.byteLength (decoded payload)
  // no longer matches Content-Length (compressed transfer). assertCompleteImage
  // must not misreport such a fully-received image as truncated.
  {
    const sb = buildSandbox();
    sb.fzstd.decompress = (buf) => new Uint8Array(buf);
    makeContext(sb, sections, [
      "fetch = async () => ({",
      "  ok: true,",
      "  status: 200,",
      "  headers: { get: (name) => (name === 'content-length' ? '100' : (name === 'content-encoding' ? 'gzip' : null)) },",
      "  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer",
      "});",
    ].join("\n"));

    const ctrl = { cache: [], url: "rp1.dsk", compressed: true };
    let caught = null;
    let status = 0;
    try {
      status = await sb.fetchBlock(ctrl, 0);
    } catch (err) {
      caught = err;
    }
    assert.strictEqual(caught, null,
      "content-encoded .zst must NOT be reported as truncated");
    assert.strictEqual(status, 200, "content-encoded .zst must load successfully");
    assert.ok(ctrl.cache[0] !== undefined, "cache must be populated");
    console.log("PASS test 16: content-encoded .zst is not flagged as truncated");
  }

  console.log("\nAll DataLoader tests passed.");
}

run().catch((err) => {
  console.error("TEST FAILURE:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
