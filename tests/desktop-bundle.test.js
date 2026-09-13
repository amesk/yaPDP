#!/usr/bin/env node
/**
 * Tauri desktop build — bundle inventory contract.
 *
 * Two inventories decide whether the installer can actually serve the page,
 * and neither of them is covered by the browser-side suites:
 *
 *   1. FRONTEND. tools/build-desktop.js stages pdp11.html, favicon.ico and the
 *      whole css/, src/ and assets/ trees into desktop/ (build.frontendDist of
 *      both tauri.conf variants). The page fetches the Teletype artwork
 *      (TTY_ART_URL in src/pdp11-app.js) and css/g60printer.css paints it as the
 *      cabinet backdrop, so every asset the frontend references must exist and
 *      be covered by that staging step. A rename that misses one of the two
 *      references leaves the desktop build without the artwork and the CSS
 *      fallback silently takes over — the "the backdrop disappeared" class of
 *      bug.
 *
 *   2. INSTALLER. The bundled media list (BUNDLED in src/tauri-bundled.js) must
 *      match bundle.resources of the tauri.conf variants: the full build ships
 *      every image, the minimal build a documented subset of it. An image that
 *      the page mounts from the bundle but that is missing from the resources
 *      map only fails at runtime, inside the packaged app.
 *
 * Run with:  node tests/desktop-bundle.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const BUILD_SCRIPT = path.join(ROOT, "tools", "build-desktop.js");
const APP = path.join(ROOT, "src", "pdp11-app.js");
const BUNDLED_MODULE = path.join(ROOT, "src", "tauri-bundled.js");
const CSS_DIR = path.join(ROOT, "css");
const MEDIA_DIR = path.join(ROOT, "media");
const CONFIGS = {
  minimal: path.join(ROOT, "src-tauri", "tauri.conf.minimal.json"),
  full: path.join(ROOT, "src-tauri", "tauri.conf.full.json")
};

function read(file) {
  return fs.readFileSync(file, "utf8");
}

// Every ../assets/... reference of a stylesheet, without the url() wrapper and
// without the #fragment / ?query suffixes (font-face targets use both).
function cssAssetRefs(cssText) {
  const refs = [];
  for (const hit of cssText.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    const ref = hit[1].split("#")[0].split("?")[0].trim();
    if (ref.startsWith("../assets/")) refs.push(ref.slice(3)); // -> assets/...
  }
  return refs;
}

function run() {
  const script = read(BUILD_SCRIPT);
  const app = read(APP);

  // --- The staging step copies the whole frontend trees --------------------
  // Not a per-file list: a new file under assets/ (the artwork, a screenshot,
  // a font) reaches desktop/ without touching the build script at all. That is
  // the property the two reference checks below rely on.
  {
    assert.ok(/fs\.copyFileSync\(path\.join\(ROOT, "pdp11\.html"\)/.test(script),
      "tools/build-desktop.js must stage pdp11.html");
    assert.ok(/fs\.copyFileSync\(path\.join\(ROOT, "favicon\.ico"\)/.test(script),
      "tools/build-desktop.js must stage favicon.ico");
    for (const tree of ["css", "src", "assets"]) {
      assert.ok(
        new RegExp('copyDir\\(path\\.join\\(ROOT, "' + tree + '"\\), ' +
          'path\\.join\\(DEST, "' + tree + '"\\)\\)').test(script),
        "tools/build-desktop.js must stage the whole " + tree + "/ tree " +
        "(a per-file list is how a new asset gets forgotten)");
    }
  }

  // --- Both installer variants serve that staged directory ------------------
  const configs = {};
  for (const [variant, file] of Object.entries(CONFIGS)) {
    const conf = JSON.parse(read(file));
    configs[variant] = conf;
    assert.strictEqual(conf.build.frontendDist, "../desktop",
      "tauri.conf." + variant + ".json must serve the staged desktop/ dir");
    assert.strictEqual(conf.app.windows[0].url, "pdp11.html",
      "tauri.conf." + variant + ".json must open pdp11.html");
    assert.strictEqual(conf.app.security.csp, null,
      "the artwork is fetched at runtime, so the CSP must stay off");
  }

  // --- Every asset the frontend references exists on disk ------------------
  {
    const artUrl = /var TTY_ART_URL = '([^']+)'/.exec(app);
    assert.ok(artUrl, "src/pdp11-app.js must declare TTY_ART_URL");
    const artFile = path.join(ROOT, artUrl[1]);
    assert.ok(fs.existsSync(artFile),
      "the artwork the page fetches at runtime must exist: " + artUrl[1]);

    const refs = new Set();
    const cssFiles = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"));
    for (const name of cssFiles) {
      for (const ref of cssAssetRefs(read(path.join(CSS_DIR, name)))) {
        refs.add(ref);
      }
    }
    assert.ok(refs.has("assets/Model-33-ASR.svg"),
      "css/g60printer.css must still paint the cabinet from assets/Model-33-ASR.svg");
    for (const ref of refs) {
      assert.ok(fs.existsSync(path.join(ROOT, ref)),
        "a stylesheet references a missing asset: " + ref);
    }
  }

  // --- The bundled media list matches bundle.resources ---------------------
  {
    const bundled = [];
    for (const hit of read(BUNDLED_MODULE)
      .matchAll(/\{\s*resource:\s*"([^"]+)"/g)) {
      bundled.push(hit[1]);
    }
    assert.ok(bundled.length > 0,
      "src/tauri-bundled.js must declare its BUNDLED resource list");

    const full = configs.full.bundle.resources;
    const minimal = configs.minimal.bundle.resources;

    for (const name of bundled) {
      const key = "../media/" + name;
      assert.strictEqual(full[key], "media/" + name,
        "the full installer must ship every image the page mounts (" + name +
        " is missing from tauri.conf.full.json -> bundle.resources)");
      // Resource keys are relative to src-tauri/ (where cargo runs).
      assert.ok(fs.existsSync(path.join(ROOT, "src-tauri", key)),
        "the bundled resource does not exist in the repo: " + key);
    }
    // The minimal build deliberately ships a subset; the page mounts what is
    // there and reports the rest through DataLoader's fallbacks.
    assert.ok(Object.keys(minimal).length < Object.keys(full).length,
      "the minimal installer must stay smaller than the full one");

    // Nothing in media/ is silently left out of the FULL installer: a new disk
    // or tape image added to the repo but not to the resources map would only
    // surface inside the packaged app. (manifest.json and README.md are build
    // inputs, never payloads.)
    const payloads = fs.readdirSync(MEDIA_DIR)
      .filter((f) => /\.(dsk|tap)\.zst$/.test(f) || /\.ptap(\.zst)?$/.test(f));
    assert.ok(payloads.length > 0, "media/ must carry the boot images");
    for (const payload of payloads) {
      assert.strictEqual(full["../media/" + payload], "media/" + payload,
        "media/" + payload + " is not registered in " +
        "tauri.conf.full.json -> bundle.resources (the full installer would " +
        "boot without it)");
    }

    for (const key of Object.keys(minimal)) {
      assert.ok(full[key], "the minimal installer must stay a subset of the " +
        "full one (" + key + " is only in tauri.conf.minimal.json)");
    }
  }

  console.log("desktop-bundle: all tests passed");
}

run();
