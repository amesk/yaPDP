#!/usr/bin/env node
/**
 * VT52 DECscope SVG art layer — geometry contract tests.
 *
 * The VT52 cabinet is drawn by assets/vt52.svg. Its Screen marker is read AT
 * RUNTIME (loadVt52Artwork in src/vt52.js) and pushed into the --vt52-*
 * variables of every .vt52-rig, so moving the marker in Inkscape moves the
 * canvas — the numbers in css/pdp11.css are only the fallback for builds where
 * the artwork cannot be fetched. Same contract as the Model 33 artwork
 * (tests/teletype-svg-backdrop.test.js), scaled down to a single marker.
 *
 * The artwork is the source of truth for the tube: the marker must be 4:3, so
 * the 672x504 canvas fills it without stretching.
 *
 * Run with:  node tests/vt52-svg-backdrop.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SVG_PATH = path.join(__dirname, "..", "assets", "vt52.svg");
const CSS_PATH = path.join(__dirname, "..", "css", "pdp11.css");
const JS_PATH = path.join(__dirname, "..", "src", "vt52.js");

// The canvas the marker must fit (see the <canvas> width/height in pdp11.html).
const CANVAS_W = 672;
const CANVAS_H = 504;

const EPS = 1e-4;

function close(actual, expected, message) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < EPS,
    message + " (expected " + expected + ", got " + actual + ")");
}

// Extract a top-level function body from the production source (brace
// matching), so the runtime parser can be exercised outside the browser.
function extractBlock(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start !== -1, "function not found: " + marker);
  const braceOpen = src.indexOf("{", start);
  assert.ok(braceOpen !== -1, "no opening brace for: " + marker);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces for: " + marker);
}

// The Screen marker rect, found through its Inkscape label (the artwork does
// not promise an id for it).
function screenRect(svg) {
  const m = /<rect[^>]*inkscape:label="Screen"[^>]*\/>/.exec(svg);
  assert.ok(m, 'the artwork must declare a rect with inkscape:label="Screen"');
  return m[0];
}

function attr(rectText, name) {
  const m = new RegExp(name + '="([-0-9.eE]+)"').exec(rectText);
  assert.ok(m, "the Screen marker must carry a numeric " + name);
  return parseFloat(m[1]);
}

// The ---- variables of the .vt52-rig rule (the last declaration wins).
function rigVars(css) {
  const idx = css.lastIndexOf(".vt52-rig {");
  assert.ok(idx !== -1, "css/pdp11.css must define the .vt52-rig rule");
  const open = css.indexOf("{", idx);
  let depth = 0;
  let end = -1;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end !== -1, "unbalanced braces in the .vt52-rig rule");
  const body = css.slice(open, end);
  const vars = {};
  const re = /(--vt52-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) vars[m[1]] = m[2].trim();
  return vars;
}

// The declarations of a TOP-LEVEL rule whose selector starts its own line. A
// rule that merely CONTAINS the selector as a descendant (".vt52-zoomed
// .vt52-crt" carries the same tail) must not be picked up by a naive search.
function ruleBody(css, selector) {
  let idx = -1;
  for (let at = css.indexOf(selector + " {"); at !== -1; at = css.indexOf(selector + " {", at + 1)) {
    const lineStart = css.lastIndexOf("\n", at) + 1;
    if (css.slice(lineStart, at).trim() === "") idx = at; // selector starts the line
  }
  assert.ok(idx !== -1, "css/pdp11.css must define the " + selector + " rule");
  const open = css.indexOf("{", idx);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced braces in the " + selector + " rule");
}

// The Markers layer's own translate(). The Screen rect sits INSIDE that layer,
// so the layer shift is part of where the tube lands: the stylesheet adds it to
// the marker x/y by hand (the runtime parser reads the plain rect only, and the
// rect must stay transform-free — see the "PLAIN rect" assertion).
function markersTranslate(svg) {
  const m = /inkscape:label="Markers"[\s\S]{0,300}?transform="translate\(([-0-9.eE]+)[, ]+([-0-9.eE]+)\)"/.exec(svg);
  assert.ok(m, "the Markers layer must carry a translate(): the Screen rect is " +
    "placed inside it and the tube's px offsets include that shift");
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

function run() {
  const svg = fs.readFileSync(SVG_PATH, "utf8");
  const css = fs.readFileSync(CSS_PATH, "utf8");

  // --- The artwork must stay valid XML -------------------------------------
  // A double hyphen is illegal inside an XML comment: the browser would then
  // render the artwork as NOTHING while the HTML overlay stays visible.
  {
    const comments = svg.match(/<!--[\s\S]*?-->/g) || [];
    for (const comment of comments) {
      assert.ok(comment.slice(4, -3).indexOf("--") === -1,
        "an XML comment must not contain '--' (the artwork would fail to parse):\n" +
        comment.slice(0, 240));
    }
    assert.ok(/<\/svg>\s*$/.test(svg), "the artwork must close with </svg>");
  }

  // --- Embedded raster: ALLOWED while the artist still traces ---------------
  // The drawing is meant to ship as pure vector: the tracing source (a
  // data:image/png layered under the art) is stripped before release, so the
  // asset stays small and the art scales cleanly. While the artist is still
  // tracing fine details the photo stays in the file on purpose — the check is
  // therefore a WARNING, not a failure. Strip the <image> element and flip this
  // warning into a hard assertion before shipping the release build.
  {
    const hasRaster = svg.indexOf("data:image") !== -1;
    const hasImage = /<image\b/.test(svg);
    if (hasRaster || hasImage) {
      console.log("warning: assets/vt52.svg still embeds its tracing raster " +
        "(data:image=" + (hasRaster ? 1 : 0) + ", <image>=" + (hasImage ? 1 : 0) + "); " +
        "strip the <image> element before shipping the release build");
    } else {
      console.log("note: assets/vt52.svg is pure vector (no embedded raster)");
    }
  }

  // --- The drawing layers the cabinet is built from ------------------------
  for (const layer of ["Hull", "Bezel", "Glass", "Keyboard", "Keypad", "Leg"]) {
    assert.ok(new RegExp('inkscape:label="' + layer + '"').test(svg),
      'the artwork must keep its "' + layer + '" layer');
  }

  // --- The Screen marker keeps its contract with the artist ----------------
  // The marker may be left VISIBLE while the artist is still positioning it
  // against the glass (a red outline over the drawing is how it is tuned), so
  // visibility is NOT contract. What IS contract: the marker exists, it is a
  // plain rectangle (no transform — an x/y/w/h-only rect is what the runtime
  // parser reads), and its size is the documented 4:3 tube.
  {
    assert.ok(svg.indexOf('inkscape:label="Markers"') !== -1,
      "the artwork must declare the Markers layer");
    const rect = screenRect(svg);
    assert.ok(!/transform=/.test(rect),
      "the Screen marker must stay a PLAIN rect (x/y/w/h only): a transform " +
      "would make the runtime parser read the untransformed numbers:\n" + rect);
    assert.ok(/id="Screen"/.test(rect),
      'the Screen marker must keep id="Screen":\n' + rect);
  }

  // --- The marker is 4:3, so the canvas fills it without stretching --------
  {
    const rect = screenRect(svg);
    const w = attr(rect, "width");
    const h = attr(rect, "height");
    close(w / h, CANVAS_W / CANVAS_H,
      "the Screen marker must be 4:3 (" + CANVAS_W + "x" + CANVAS_H + " canvas)");
    assert.ok(w > 0 && h > 0, "the marker must have a positive size");
    assert.ok(h > 20 && h < 200,
      "the marker height must stay in SVG user units (mm-ish), got " + h);
  }

  // --- The viewBox and the rig fallback agree ------------------------------
  const vars = rigVars(css);
  {
    const vb = /viewBox="0 0 ([-0-9.eE]+) ([-0-9.eE]+)"/.exec(svg);
    assert.ok(vb, "the artwork must declare a viewBox");
    close(parseFloat(vars["--vt52-vb-w"]), parseFloat(vb[1]),
      "--vt52-vb-w must match the artwork viewBox width");
    close(parseFloat(vars["--vt52-vb-h"]), parseFloat(vb[2]),
      "--vt52-vb-h must match the artwork viewBox height");
  }

  // --- The marker numbers match the stylesheet fallback --------------------
  {
    const rect = screenRect(svg);
    close(parseFloat(vars["--vt52-screen-x"]), attr(rect, "x"),
      "--vt52-screen-x must match the Screen marker x");
    close(parseFloat(vars["--vt52-screen-y"]), attr(rect, "y"),
      "--vt52-screen-y must match the Screen marker y");
    close(parseFloat(vars["--vt52-screen-w"]), attr(rect, "width"),
      "--vt52-screen-w must match the Screen marker width");
    close(parseFloat(vars["--vt52-screen-h"]), attr(rect, "height"),
      "--vt52-screen-h must match the Screen marker height");
  }

  // --- ... and the TUBE actually follows those numbers ---------------------
  // .vt52-crt is written in PRE-MULTIPLIED px, not as a calc() over the marker
  // variables: a calc() resolves to 0 while the artwork is still being fetched,
  // which once collapsed the tube into the corner. Nothing rewrites them at
  // runtime either, so the stylesheet IS the tube's geometry — a nudge of the
  // Screen marker in Inkscape must be carried over to these four numbers, or
  // the canvas drifts off the drawn glass while every check stays green. The
  // tolerance is the one the 4-decimal px literals deserve (0.01px).
  {
    const rect = screenRect(svg);
    const layer = markersTranslate(svg);
    const u = parseFloat(vars["--vt52-u"]);
    assert.ok(Number.isFinite(u) && u > 0, "--vt52-u must be a positive px size");
    // Comments stripped first: they mention left/top/width/height by name.
    const body = ruleBody(css, ".vt52-crt").replace(/\/\*[\s\S]*?\*\//g, " ");
    const px = (name) => {
      const m = new RegExp("(?:^|;)\\s*" + name + "\\s*:\\s*([-0-9.eE]+)px").exec(body);
      assert.ok(m, ".vt52-crt must carry a numeric " + name + " in px:\n" + body);
      return parseFloat(m[1]);
    };
    const closePx = (actual, expected, message) =>
      assert.ok(Math.abs(actual - expected) < 0.01,
        message + " (expected " + expected + ", got " + actual + ")");
    closePx(px("left"), (attr(rect, "x") + layer.x) * u,
      ".vt52-crt left must be the Screen marker x (inside its layer) at --vt52-u");
    closePx(px("top"), (attr(rect, "y") + layer.y) * u,
      ".vt52-crt top must be the Screen marker y (inside its layer) at --vt52-u");
    closePx(px("width"), attr(rect, "width") * u,
      ".vt52-crt width must be the Screen marker width at --vt52-u");
    closePx(px("height"), attr(rect, "height") * u,
      ".vt52-crt height must be the Screen marker height at --vt52-u");
  }

  // --- The backdrop draws the artwork, and never steals a click ------------
  {
    // Find the BASE backdrop rule, not a variant: the zoom rule
    // (".vt52-zoomed .vt52-backdrop") contains the same substring and would be
    // picked up by a naive lastIndexOf, hiding the assertions.
    let idx = -1;
    for (let at = css.indexOf(".vt52-backdrop {"); at !== -1; at = css.indexOf(".vt52-backdrop {", at + 1)) {
      const lineStart = css.lastIndexOf("\n", at) + 1;
      if (css.slice(lineStart, at).trim() === "") idx = at; // selector starts the line
    }
    assert.ok(idx !== -1, "css/pdp11.css must define the .vt52-backdrop rule");
    const open = css.indexOf("{", idx);
    let depth = 0;
    let end = -1;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    const body = css.slice(open, end);
    // The artwork is INLINED at runtime (inlineVt52Artwork in src/vt52.js), not
    // a background-image: an inlined <svg> is part of the document, so the
    // stylesheet can reach inside the drawing (that is what lets the glass
    // follow the reverse-video mode). The backdrop must therefore be a bare
    // positioned box, with no background of its own.
    assert.ok(!/url\(/.test(body),
      "the backdrop must NOT paint the artwork as a background image any more " +
      "(it is inlined at runtime):\n" + body);
    assert.ok(/pointer-events\s*:\s*none/.test(body),
      "the backdrop must not steal clicks (pointer-events: none):\n" + body);
    // ... and the loader must actually inline it.
    const jsSrc = fs.readFileSync(JS_PATH, "utf8");
    assert.ok(/function inlineVt52Artwork/.test(jsSrc),
      "src/vt52.js must inline the artwork into .vt52-backdrop");
    assert.ok(/window\.vt52InlineArtwork\s*=\s*inlineVt52Artwork/.test(jsSrc),
      "the inliner must be exported for inspection");
  }

  // --- The CSS case is gone: the artwork draws the cabinet now -------------
  {
    const idx = css.lastIndexOf(".vt52-terminal {");
    assert.ok(idx !== -1, "css/pdp11.css must keep the .vt52-terminal rule");
    const open = css.indexOf("{", idx);
    let depth = 0;
    let end = -1;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    const body = css.slice(open, end);
    assert.ok(!/linear-gradient|radial-gradient/.test(body),
      ".vt52-terminal must not paint a second cabinet behind the artwork:\n" + body);
    assert.ok(!/box-shadow/.test(body),
      ".vt52-terminal must not carry the old case shadow:\n" + body);
    assert.strictEqual(css.indexOf(".vt52-terminal::before"), -1,
      "the CSS top highlight must be gone with the CSS case");
  }

  // --- The runtime parser reads the very same numbers ---------------------
  // src/vt52.js fetches the artwork at page load (loadVt52Artwork) and pushes
  // the marker numbers into the --vt52-* variables of every .vt52-rig.
  {
    const src = fs.readFileSync(JS_PATH, "utf8");
    const code =
      extractBlock(src, "function vt52MarkerVars") + "\n" +
      "; this.parse = vt52MarkerVars;";
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    const parsed = sandbox.parse(svg);
    assert.ok(parsed, "vt52MarkerVars must parse the artwork");

    const viewBox = /viewBox="0 0 ([-0-9.eE]+) ([-0-9.eE]+)"/.exec(svg);
    close(parseFloat(parsed["--vt52-vb-w"]), parseFloat(viewBox[1]),
      "the parser must report the viewBox width");
    close(parseFloat(parsed["--vt52-vb-h"]), parseFloat(viewBox[2]),
      "the parser must report the viewBox height");

    const rect = screenRect(svg);
    close(parseFloat(parsed["--vt52-screen-x"]), attr(rect, "x"),
      "the parser must report the Screen marker x");
    close(parseFloat(parsed["--vt52-screen-y"]), attr(rect, "y"),
      "the parser must report the Screen marker y");
    close(parseFloat(parsed["--vt52-screen-w"]), attr(rect, "width"),
      "the parser must report the Screen marker width");
    close(parseFloat(parsed["--vt52-screen-h"]), attr(rect, "height"),
      "the parser must report the Screen marker height");

    // The parser is exported to the page (loadVt52Artwork consumes it).
    assert.ok(/window\.vt52MarkerVars\s*=\s*vt52MarkerVars/.test(src),
      "src/vt52.js must export vt52MarkerVars to the page");
    assert.ok(/window\.vt52LoadArtwork\s*=\s*loadVt52Artwork/.test(src),
      "src/vt52.js must export the artwork loader");
    assert.ok(/assets\/vt52\.svg/.test(src),
      "the loader must fetch assets/vt52.svg");

    // Defensive: garbage input never throws and yields no variables.
    assert.strictEqual(sandbox.parse(""), null, "empty input -> null");
    assert.deepStrictEqual(Object.keys(sandbox.parse("<svg/>")).length, 0,
      "an artwork without the marker -> no variables (CSS fallback stays)");
    assert.deepStrictEqual(
      Object.keys(sandbox.parse('<svg><rect inkscape:label="Other"/></svg>')),
      [], "a different marker label is not the Screen marker");
  }

  // --- The page wires the loader -------------------------------------------
  {
    const app = fs.readFileSync(path.join(__dirname, "..", "src", "pdp11-app.js"), "utf8");
    assert.ok(/window\.vt52LoadArtwork\(\)/.test(app),
      "src/pdp11-app.js must call window.vt52LoadArtwork() during startup");
    const html = fs.readFileSync(path.join(__dirname, "..", "pdp11.html"), "utf8");
    // The wrapper and the artwork box are SEPARATE elements: .vt52-terminal
    // carries the page flow, .vt52-rig owns the geometry (so the two class
    // rules can never fight over width/height by cascade order).
    const rigs = html.match(/class="vt52-rig"/g) || [];
    assert.ok(rigs.length >= 3,
      "every VT52 page must carry its own artwork box (.vt52-rig), found " + rigs.length);
    const wrappers = html.match(/class="vt52-terminal"/g) || [];
    assert.strictEqual(wrappers.length, rigs.length,
      "each .vt52-rig must sit inside exactly one .vt52-terminal wrapper");
    const backdrops = html.match(/class="vt52-backdrop"/g) || [];
    assert.strictEqual(backdrops.length, rigs.length,
      "each rig must own exactly one backdrop (variant A)");
    // The obsolete decoration must not come back: the cabinet is the artwork.
    assert.strictEqual(html.indexOf("vt52-badge"), -1,
      "the \"digital vt52\" badge is a leftover of the CSS cabinet — the " +
      "artwork carries the wordmark now");
  }

  console.log("vt52-svg-backdrop: all tests passed");
}

run();
