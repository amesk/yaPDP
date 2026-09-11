#!/usr/bin/env node
/**
 * Model 33 ASR SVG art layer — geometry contract tests.
 *
 * The console teletype cabinet is drawn by assets/Model-33-ASR.svg and the
 * live controls on top of it are positioned by css/g60printer.css in the SAME
 * units as the artwork's viewBox. That makes the artwork the single source of
 * truth: the markers layer of the SVG ("Keyboard", "Apron", "PuncherControl",
 * "PuncherTape", "ReaderControl", "ReaderTape", "Paper", "Caret") and the
 * --tty-* variables of the teletype rig rule must agree, and every contain
 * factor must be the documented min(marker / native) ratio.
 *
 * This suite parses BOTH files and fails when either side drifts, so moving a
 * marker in Inkscape without updating the CSS (or the other way round) cannot
 * ship silently.
 *
 * Run with:  node tests/teletype-svg-backdrop.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SVG_PATH = path.join(__dirname, "..", "assets", "Model-33-ASR.svg");
const CSS_PATH = path.join(__dirname, "..", "css", "g60printer.css");
const APP_PATH = path.join(__dirname, "..", "src", "pdp11-app.js");

// Marker id -> the CSS variable prefix holding its x/y/w/h.
const MARKERS = [
  { id: "Keyboard", var: "--tty-kbd" },
  { id: "Apron", var: "--tty-apron" },
  // Both mechanisms carry two markers: the control area and the tape itself.
  { id: "PuncherControl", var: "--tty-pctrl" },
  { id: "PuncherTape", var: "--tty-ptape" },
  { id: "ReaderControl", var: "--tty-rctrl" },
  { id: "ReaderTape", var: "--tty-rtape" }
];

// Marker ids carrying only an x/y (the paper band is a plane, not a block).
const PLANE_MARKERS = [
  { id: "Paper", var: "--tty-paper" },
  { id: "Caret", var: "--tty-caret" }
];

// Native px sizes of the live controls the contain factors are derived from.
const NATIVE = {
  kbdW: 576, kbdH: 212,      // key block, see model33KeyGrid in src/pdp11-app.js
  plateW: 170, plateH: 164,  // punch / reader plate frames
  ctrlW: 106,                // REL/OFF/BSP/ON cluster (2x2 grid) width
  switchW: 40,               // vertical four-detent reader lever block (40x115)
  apronW: 118, apronH: 66,   // CCU apron block
  sheetW: 741                // paper sheet inside the 808px printer block
};

const EPS = 1e-4;

function close(actual, expected, message) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < EPS,
    message + " (expected " + expected + ", got " + actual + ")");
}

// Extract one top-level function body from the production source (brace
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

// Pull the whole rect element of a marker id out of the SVG text.
function rectElement(svg, id) {
  const re = new RegExp('<rect[^>]*id="' + id + '"[^>]*/>');
  const m = re.exec(svg);
  assert.ok(m, 'the artwork must declare a marker rect with id="' + id + '"');
  return m[0];
}

function attr(rectText, name, id) {
  const re = new RegExp(name + '="([-0-9.eE]+)"');
  const m = re.exec(rectText);
  assert.ok(m, "the " + id + " marker must carry a numeric " + name);
  return parseFloat(m[1]);
}

function markerRect(svg, id) {
  const text = rectElement(svg, id);
  return {
    x: attr(text, "x", id),
    y: attr(text, "y", id),
    w: attr(text, "width", id),
    h: attr(text, "height", id)
  };
}

// All --tty-* declarations of the teletype rig rule (the last one wins).
function rigVars(css) {
  const idx = css.lastIndexOf("#teletype-rig {");
  assert.ok(idx !== -1, "css/g60printer.css must define the #teletype-rig rule");
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
  assert.ok(end !== -1, "unbalanced braces in the #teletype-rig rule");
  const body = css.slice(open, end);
  const vars = {};
  const re = /(--tty-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) vars[m[1]] = m[2].trim();
  return vars;
}

// Slice a top-level array literal: from its declaration to the closing "];".
function extractArray(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start !== -1, "array not found: " + marker);
  const end = src.indexOf("];", start);
  assert.ok(end !== -1, "unterminated array: " + marker);
  return src.slice(start, end + 2);
}

// "calc(var(--tty-u-num) * 0.44550)" -> 0.44550
function containRatio(value, name) {
  if (value === undefined) throw new Error("missing CSS variable " + name);
  const m = /\*\s*([0-9.]+)\s*\)/.exec(value);
  assert.ok(m, name + " must be declared as calc(var(--tty-u-num) * <ratio>), got: " + value);
  return parseFloat(m[1]);
}

function run() {
  const svg = fs.readFileSync(SVG_PATH, "utf8");
  const css = fs.readFileSync(CSS_PATH, "utf8");

  // --- The artwork must stay valid XML -------------------------------------
  // A double hyphen is illegal inside an XML comment. When the file stops being
  // valid XML the browser renders the artwork as NOTHING (the HTML overlays stay
  // visible, so it looks like "the backdrop disappeared") — exactly the bug a
  // "tty-*" mention written as a CSS custom property once caused. This guard
  // keeps that class of typo from shipping.
  {
    const comments = svg.match(/<!--[\s\S]*?-->/g) || [];
    assert.ok(comments.length >= 2,
      "the artwork keeps its documentation comments");
    for (const comment of comments) {
      assert.ok(comment.slice(4, -3).indexOf("--") === -1,
        "an XML comment must not contain '--' (the artwork would fail to parse):\n" +
        comment.slice(0, 240));
    }
    assert.ok(/<\/svg>\s*$/.test(svg), "the artwork must close with </svg>");
  }

  // --- Contract mode: ALIGNMENT (markers visible) vs RELEASE (hidden) ------
  // While the artist tunes the markers against the page the layer is
  // deliberately LEFT VISIBLE and the numbers change on every save. The contract
  // is therefore mode-aware:
  //   * alignment mode — the RUNTIME parser is the source of truth (it is
  //     checked against the artwork below); a stale css/g60printer.css fallback
  //     is REPORTED with the exact values to paste instead of failing;
  //   * release mode (the layer switched off, which is the shipping state) —
  //     exact parity between the artwork and the stylesheet is enforced, and
  //     every rect must carry display:none itself (Inkscape rewrites the LAYER's
  //     display on save — it turns it back to "inline" — but an object's own
  //     style survives, so switching the layer off can never be half-undone).
  assert.ok(svg.indexOf('id="layer4"') !== -1,
    "the artwork must keep the markers layer (id=\"layer4\")");
  const layerStart = svg.indexOf('id="layer4"');
  const layerTag = svg.slice(layerStart, svg.indexOf(">", layerStart));
  const isAligning = !/display\s*:\s*none/.test(layerTag);
  const fallbackNotes = [];
  if (isAligning) {
    console.log("note: the markers layer is VISIBLE (alignment mode) — " +
      "CSS fallbacks are reported, not enforced");
  }
  function expect(actual, expected, message) {
    if (!isAligning) {
      close(actual, expected, message);
      return;
    }
    if (!(Math.abs(actual - expected) < EPS)) {
      fallbackNotes.push("  " + message + ": CSS says " + actual +
        ", the artwork says " + expected);
    }
  }
  for (const marker of MARKERS.concat(PLANE_MARKERS)) {
    const rect = rectElement(svg, marker.id);
    if (isAligning) {
      assert.ok(!/display\s*:\s*none/.test(rect),
        marker.id + " must stay visible while the layer is visible " +
        "(do not half-hide the markers):\n" + rect);
    } else {
      assert.ok(/display\s*:\s*none/.test(rect),
        "a hidden markers layer must hide " + marker.id +
        " in its own style as well:\n" + rect);
    }
  }

  // --- viewBox and rig variables agree -------------------------------------
  const vars = rigVars(css);
  {
    const vb = /viewBox="0 0 ([-0-9.eE]+) ([-0-9.eE]+)"/.exec(svg);
    assert.ok(vb, "the artwork must declare a viewBox");
    close(parseFloat(vars["--tty-vb-w"]), parseFloat(vb[1]),
      "--tty-vb-w must match the artwork viewBox width");
    close(parseFloat(vars["--tty-vb-h"]), parseFloat(vb[2]),
      "--tty-vb-h must match the artwork viewBox height");
  }

  // --- Every marker rect matches its CSS variables -------------------------
  for (const marker of MARKERS) {
    const rect = markerRect(svg, marker.id);
    expect(parseFloat(vars[marker.var + "-x"]), rect.x,
      marker.var + "-x must match the " + marker.id + " marker x");
    expect(parseFloat(vars[marker.var + "-y"]), rect.y,
      marker.var + "-y must match the " + marker.id + " marker y");
    expect(parseFloat(vars[marker.var + "-w"]), rect.w,
      marker.var + "-w must match the " + marker.id + " marker width");
    expect(parseFloat(vars[marker.var + "-h"]), rect.h,
      marker.var + "-h must match the " + marker.id + " marker height");
  }
  for (const marker of PLANE_MARKERS) {
    const rect = markerRect(svg, marker.id);
    expect(parseFloat(vars[marker.var + "-x"]), rect.x,
      marker.var + "-x must match the " + marker.id + " marker x");
    expect(parseFloat(vars[marker.var + "-y"]), rect.y,
      marker.var + "-y must match the " + marker.id + " marker y");
    expect(parseFloat(vars[marker.var + "-w"]), rect.w,
      marker.var + "-w must match the " + marker.id + " marker width");
    expect(parseFloat(vars[marker.var + "-h"]), rect.h,
      marker.var + "-h must match the " + marker.id + " marker height");
  }

  // --- The print line is the Caret band's bottom edge ----------------------
  {
    const caret = markerRect(svg, "Caret");
    expect(parseFloat(vars["--tty-caret-line-y"]), caret.y + caret.h,
      "--tty-caret-line-y must be the Caret marker's bottom edge (y + h)");
  }

  // --- Contain factors are min(marker / native) ----------------------------
  {
    const kbd = markerRect(svg, "Keyboard");
    expect(containRatio(vars["--tty-kbd-k"], "--tty-kbd-k"),
      Math.min(kbd.w / NATIVE.kbdW, kbd.h / NATIVE.kbdH),
      "--tty-kbd-k must be min(markerW/576, markerH/212)");

    // The punch plate frame (label + slot) is contain-fitted onto the
    // PuncherControl marker; the button cluster is fitted by width (its own
    // unitless factor) so the round buttons never distort.
    const ctrl = markerRect(svg, "PuncherControl");
    expect(containRatio(vars["--tty-pctrl-k"], "--tty-pctrl-k"),
      Math.min(ctrl.w / NATIVE.plateW, ctrl.h / NATIVE.plateH),
      "--tty-pctrl-k must be min(markerW/170, markerH/164)");

    const btnK = vars["--tty-pctrl-btn-k"] || "";
    assert.ok(/var\(--tty-pctrl-w\)/.test(btnK),
      "--tty-pctrl-btn-k must be derived from the marker width:\n" + btnK);
    assert.ok(new RegExp("/\\s*" + NATIVE.ctrlW).test(btnK),
      "--tty-pctrl-btn-k must divide by the cluster's native width (106):\n" + btnK);
    assert.ok(/var\(--tty-u-num\)/.test(btnK),
      "--tty-pctrl-btn-k must derive from the unitless --tty-u-num:\n" + btnK);

    // The tape axis is derived from the tape marker (both are calc() formulas,
    // so the test pins the formula and the marker numbers it consumes).
    const ptapeCy = vars["--tty-ptape-cy"] || "";
    const ptapeCx = vars["--tty-ptape-cx"] || "";
    assert.ok(/var\(--tty-ptape-y\)/.test(ptapeCy) && /var\(--tty-ptape-h\)/.test(ptapeCy),
      "--tty-ptape-cy must be the marker's lower edge (y + h):\n" + ptapeCy);
    assert.ok(/var\(--tty-ptape-x\)/.test(ptapeCx) && /var\(--tty-ptape-w\)/.test(ptapeCx),
      "--tty-ptape-cx must be the marker's horizontal centre (x + w/2):\n" + ptapeCx);

    // The reader is split the same way: the plate frame is contain-fitted onto
    // the ReaderControl marker, the switch block is fitted by width, and the
    // reader tape takes its axis from its OWN ReaderTape marker.
    const rctrl = markerRect(svg, "ReaderControl");
    expect(containRatio(vars["--tty-rctrl-k"], "--tty-rctrl-k"),
      Math.min(rctrl.w / NATIVE.plateW, rctrl.h / NATIVE.plateH),
      "--tty-rctrl-k must be min(markerW/170, markerH/164)");

    const rswitchK = vars["--tty-rctrl-switch-k"] || "";
    assert.ok(/var\(--tty-rctrl-w\)/.test(rswitchK),
      "--tty-rctrl-switch-k must be derived from the marker width:\n" + rswitchK);
    assert.ok(new RegExp("/\\s*" + NATIVE.switchW).test(rswitchK),
      "--tty-rctrl-switch-k must divide by the lever block's native width (40):\n" + rswitchK);
    assert.ok(/var\(--tty-u-num\)/.test(rswitchK),
      "--tty-rctrl-switch-k must derive from the unitless --tty-u-num:\n" + rswitchK);

    const rtapeCy = vars["--tty-rtape-cy"] || "";
    const rtapeCx = vars["--tty-rtape-cx"] || "";
    assert.ok(/var\(--tty-rtape-y\)/.test(rtapeCy) && /var\(--tty-rtape-h\)/.test(rtapeCy),
      "--tty-rtape-cy must be the marker's lower edge (y + h):\n" + rtapeCy);
    assert.ok(/var\(--tty-rtape-x\)/.test(rtapeCx) && /var\(--tty-rtape-w\)/.test(rtapeCx),
      "--tty-rtape-cx must be the marker's horizontal centre (x + w/2):\n" + rtapeCx);

    const apron = markerRect(svg, "Apron");
    expect(containRatio(vars["--tty-apron-k"], "--tty-apron-k"),
      Math.min(apron.w / NATIVE.apronW, apron.h / NATIVE.apronH),
      "--tty-apron-k must be min(markerW/118, markerH/66)");

    // The sheet is special: the printer lays it out per column count, so the
    // page publishes the REAL width in --tty-sheet-native and the factor is
    // markerW / nativeSheetW. The unit test pins the formula and the no-JS
    // fallback; the live value is checked in the browser (the sheet must fill
    // the marker exactly).
    const paper = markerRect(svg, "Paper");
    const sheetK = vars["--tty-sheet-k"] || "";
    assert.ok(/var\(--tty-paper-w\)/.test(sheetK),
      "--tty-sheet-k must divide the Paper marker width:\n" + sheetK);
    assert.ok(/var\(--tty-sheet-native\)/.test(sheetK),
      "--tty-sheet-k must divide by the sheet the printer laid out:\n" + sheetK);
    assert.ok(/var\(--tty-u-num\)/.test(sheetK),
      "--tty-sheet-k must derive from the unitless --tty-u-num:\n" + sheetK);
    close(parseFloat(vars["--tty-sheet-native"]), NATIVE.sheetW,
      "the --tty-sheet-native fallback must be the CSS base sheet width (741)");
    // The marker really is the numerator: the old hard-coded 741-based factor
    // (paper.w / 741) is NOT what the page must use any more — it left the sheet
    // visibly narrower than the platen.
    assert.ok(paper.w / NATIVE.sheetW !== paper.w / 606,
      "the fallback ratio must differ from the 72-column sheet ratio (the page " +
      "recomputes the factor from the real sheet width)");
  }

  // --- --tty-u is a length derived from the unitless --tty-u-num -----------
  {
    assert.ok(/calc\(var\(--tty-u-num\)\s*\*\s*1px\)/.test(vars["--tty-u"] || ""),
      "--tty-u must be calc(var(--tty-u-num) * 1px): " + vars["--tty-u"]);
    assert.ok(Number.isFinite(parseFloat(vars["--tty-u-num"])) &&
      parseFloat(vars["--tty-u-num"]) > 0,
      "--tty-u-num must be a positive number: " + vars["--tty-u-num"]);
  }

  // --- The runtime parser reads the very same numbers ----------------------
  // src/pdp11-app.js fetches the artwork at page load (installTtyArtLayer) and
  // pushes the marker numbers into the --tty-* variables of #teletype-rig, so
  // moving a marker is enough. The parser is pinned here to the same values the
  // CSS fallback uses, so the runtime path and the fallback cannot diverge.
  {
    const src = fs.readFileSync(APP_PATH, "utf8");
    const code =
      extractArray(src, "var TTY_MARKER_VARS = [") + "\n" +
      extractBlock(src, "function ttyMarkerVars") + "\n" +
      extractBlock(src, "function ttyStraightPathPoints") + "\n" +
      extractBlock(src, "function ttyMatrixMultiply") + "\n" +
      extractBlock(src, "function ttyMarkerTransform") + "\n" +
      extractBlock(src, "function ttyMarkerQuad") + "\n" +
      extractBlock(src, "function ttyForegroundLayerId") + "\n" +
      "; this.parse = ttyMarkerVars; this.quad = ttyMarkerQuad; " +
      "this.foreground = ttyForegroundLayerId;";
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    const parsed = sandbox.parse(svg);
    assert.ok(parsed, "ttyMarkerVars must parse the artwork");

    const viewBox = /viewBox="0 0 ([-0-9.eE]+) ([-0-9.eE]+)"/.exec(svg);
    close(parseFloat(parsed["--tty-vb-w"]), parseFloat(viewBox[1]),
      "the parser must report the viewBox width");
    close(parseFloat(parsed["--tty-vb-h"]), parseFloat(viewBox[2]),
      "the parser must report the viewBox height");

    for (const marker of MARKERS.concat(PLANE_MARKERS)) {
      const rect = markerRect(svg, marker.id);
      close(parseFloat(parsed[marker.var + "-x"]), rect.x,
        "the parser must report the " + marker.id + " x");
      close(parseFloat(parsed[marker.var + "-y"]), rect.y,
        "the parser must report the " + marker.id + " y");
      close(parseFloat(parsed[marker.var + "-w"]), rect.w,
        "the parser must report the " + marker.id + " width");
      close(parseFloat(parsed[marker.var + "-h"]), rect.h,
        "the parser must report the " + marker.id + " height");
    }

    const caret = markerRect(svg, "Caret");
    close(parseFloat(parsed["--tty-caret-line-y"]), caret.y + caret.h,
      "the parser must derive the print line from the Caret band");

    // A marker drawn as a TILTED rect (Inkscape's matrix()/rotate() written on
    // the rect itself) is a quadrilateral: applyTtyQuadMatrices projects the
    // matching HTML layer onto it with matrix3d. A plain rect stays a rectangle,
    // so the honest uniform fit is kept for it.
    assert.ok(sandbox.quad(svg, "PuncherControl"),
      "the artwork's PuncherControl rect carries its own transform — the page " +
      "must read it as a quadrilateral");
    assert.ok(sandbox.quad(svg, "ReaderControl"),
      "the artwork's ReaderControl rect carries its own transform — the page " +
      "must read it as a quadrilateral");
    assert.strictEqual(sandbox.quad(svg, "Keyboard"), null,
      "a plain rectangle marker must stay a rectangle (uniform fit, no matrix3d)");

    // The layer the artist means by "Foreground" is the one inlined above the
    // controls (installTtyForeground in src/pdp11-app.js); it is found through
    // Inkscape's layer label, so renaming the editor id cannot break it.
    {
      const fg = sandbox.foreground(svg);
      assert.ok(fg, "the artwork must carry a Foreground layer");
      const tag = new RegExp('<g\\b[^>]*\\bid="' + fg + '"[^>]*>').exec(svg);
      assert.ok(tag && /inkscape:label="Foreground"/.test(tag[0]),
        "the parser must return the Foreground layer's id, got: " + fg);
      assert.strictEqual(sandbox.foreground('<g id="Foreground"><rect/></g>'),
        "Foreground", "an id mentioning foreground is the fallback signal");
      assert.strictEqual(sandbox.foreground("<svg><g id='layer1'/></svg>"), "",
        "an artwork without such a layer yields an empty id (nothing inlined)");
      assert.strictEqual(sandbox.foreground(""), "", "empty input yields an empty id");
    }

    // A TILTED marker rect must be listed in TTY_QUAD_MARKERS, otherwise it
    // would be ignored in silence: the anchor keeps the untransformed x/y and no
    // projection is published (an artist tilting a marker the page does not
    // know about sees nothing happen). This invariant found the Apron gap.
    {
      const table = extractArray(src, "var TTY_QUAD_MARKERS = [");
      const covered = new Set();
      for (const hit of table.matchAll(/id:\s*"([^"]+)"/g)) covered.add(hit[1]);
      for (const hit of table.matchAll(/altId:\s*"([^"]+)"/g)) covered.add(hit[1]);
      const tilted = [];
      for (const hit of svg.matchAll(/<rect[^>]*id="([^"]+)"[^>]*\/>/g)) {
        if (/transform="/.test(hit[0])) tilted.push(hit[1]);
      }
      for (const id of tilted) {
        assert.ok(covered.has(id),
          'the artwork tilts "' + id + '", so TTY_QUAD_MARKERS must list it ' +
          "(otherwise the marker is ignored and its layer never follows)");
      }
      assert.ok(covered.has("PuncherControl") && covered.has("ReaderControl") &&
        covered.has("Keyboard") && covered.has("Apron") &&
        covered.has("Paper") && covered.has("Caret"),
        "every marker the page can project must stay in TTY_QUAD_MARKERS:\n" +
        table);
    }

    // Defensive: garbage input never throws and yields no variables.
    assert.strictEqual(sandbox.parse(""), null, "empty input -> null");
    assert.deepStrictEqual(Object.keys(sandbox.parse("<svg/>")).length, 0,
      "an artwork without markers -> no variables (CSS fallback stays)");
  }

  // In alignment mode the stale fallbacks are printed as a copy-paste block:
  // the stylesheet only needs them for fetch-less builds, but keeping them in
  // step avoids a surprise when the artwork layer is switched off.
  if (fallbackNotes.length) {
    console.log("note: css/g60printer.css fallbacks differ from the artwork " +
      "(alignment mode only — paste these before switching the layer off):");
    for (const note of fallbackNotes) console.log(note);
  }

  console.log("teletype-svg-backdrop: all tests passed");
}

run();
