#!/usr/bin/env node
/**
 * Four-point marker (perspective area) — pure helper tests.
 *
 * A marker may be drawn as a quadrilateral; the page then projects the matching
 * HTML layer onto it with a matrix3d(). Extracts the pure helpers straight from
 * the real source (src/pdp11-app.js) and runs them in an isolated VM context:
 *
 *   - ttyMarkerQuad(svgText, id): the four corners of a quad marker, or null for
 *     a plain <rect> (rectangles keep the honest uniform fit) / curved path.
 *   - ttyStraightPathPoints(d): the node list of a straight-line SVG path.
 *   - ttyQuadMatrix3d(w, h, quad): the CSS matrix3d() mapping a w x h box onto
 *     the quad, or null when the quad is degenerate.
 *
 * Run with:  node tests/tty-quad-matrix.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "pdp11-app.js");

function extractBlock(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error("marker not found: " + startMarker);
  const braceOpen = src.indexOf("{", start);
  if (braceOpen === -1) throw new Error("no opening brace for: " + startMarker);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces for: " + startMarker);
}

function loadHelpers() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const code =
    extractBlock(src, "function ttyMarkerQuad") + "\n" +
    extractBlock(src, "function ttyMarkerTransform") + "\n" +
    extractBlock(src, "function ttyMatrixMultiply") + "\n" +
    extractBlock(src, "function ttyStraightPathPoints") + "\n" +
    extractBlock(src, "function ttyQuadMatrix3d") + "\n" +
    extractBlock(src, "function ttySolveLinear") + "\n" +
    extractBlock(src, "function ttyAffineMatrix3d") + "\n" +
    extractBlock(src, "function ttyMarkerRectTransform") + "\n" +
    extractBlock(src, "function ttyQuadLayerMatrix") + "\n" +
    "; this.q = { quad: ttyMarkerQuad, points: ttyStraightPathPoints, " +
    "matrix: ttyQuadMatrix3d, solve: ttySolveLinear, " +
    "transform: ttyMarkerTransform, affine: ttyAffineMatrix3d, " +
    "rectTransform: ttyMarkerRectTransform, layer: ttyQuadLayerMatrix };";
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.q;
}

// Apply a matrix3d() argument list (column-major) to a point.
function project(matrix, x, y) {
  const m = /matrix3d\(([^)]+)\)/.exec(matrix)[1].split(",").map(Number);
  const X = m[0] * x + m[4] * y + m[12];
  const Y = m[1] * x + m[5] * y + m[13];
  const W = m[3] * x + m[7] * y + m[15];
  return [X / W, Y / W];
}

function closePoint(actual, expected, message) {
  assert.ok(Math.abs(actual[0] - expected[0]) < 1e-6 &&
    Math.abs(actual[1] - expected[1]) < 1e-6,
    message + " (expected " + expected + ", got " + actual + ")");
}

function run() {
  const { quad, points, matrix, layer, rectTransform } = loadHelpers();

  // --- Parsing: only an explicit quadrilateral turns the mapping on ---------
  {
    assert.strictEqual(quad('<rect id="X" x="1" y="2" width="3" height="4"/>', "X"),
      null, "a rectangle must NOT produce a quad (the uniform fit stays)");

    // The helpers run in a VM realm, so the returned arrays carry the sandbox
    // prototype: compare their JSON instead of deep-equalling the objects.
    const poly = quad('<polygon id="X" points="0,0 10,0 10,5 0,5"/>', "X");
    assert.strictEqual(JSON.stringify(poly),
      JSON.stringify([[0, 0], [10, 0], [10, 5], [0, 5]]),
      "polygon points are read in order");

    const multiLine = '<rect id="Other" width="1" height="1"/>\n' +
      '<polygon id="X" points="1,1 2,1 2,2 1,2"/>';
    assert.strictEqual(quad(multiLine, "X").length, 4,
      "the parser must pick the marker by id, not the first shape");

    assert.strictEqual(quad('<polygon id="X" points="0,0 1,1 2,2"/>', "X"), null,
      "a polygon without four points is not a quad");
    assert.strictEqual(quad('<polygon id="X" points="0,0 1,0 1,1 0,1 2,2"/>', "X"),
      null, "five points are not a quad");
    assert.strictEqual(quad('<rect id="Y" width="1" height="1"/>', "X"), null,
      "a missing marker yields null");

    // A marker rect that carries its OWN transform (Inkscape's rotate()/
    // matrix(), e.g. a marker tilted over a tilted drawing) is a quad too.
    const rotated = quad('<rect id="X" x="10" y="20" width="4" height="2" ' +
      'transform="rotate(90)"/>', "X");
    assert.ok(rotated, "a rotated marker rect yields a quad");
    const rotatedExpected = [[-20, 10], [-20, 14], [-22, 14], [-22, 10]];
    for (let i = 0; i < 4; i++) {
      closePoint(rotated[i], rotatedExpected[i],
        "rotate(90) turns corner " + i + " about the origin");
    }

    const shifted = quad('<rect id="X" x="0" y="0" width="10" height="10" ' +
      'transform="matrix(1,0,0,1,5,7)"/>', "X");
    assert.strictEqual(JSON.stringify(shifted),
      JSON.stringify([[5, 7], [15, 7], [15, 17], [5, 17]]),
      "a matrix() transform is applied to the corners");

    assert.strictEqual(quad('<rect id="X" x="0" y="0" width="1" height="1" ' +
      'transform="skewX(10)"/>', "X"), null,
      "an unsupported transform falls back to the uniform fit");
    assert.strictEqual(quad('<rect id="X" x="0" y="0" width="3" height="4"/>', "X"),
      null, "a rect without a transform is still not a quad");
  }

  // --- Parsing: straight-line paths ----------------------------------------
  {
    const rel = points("m 1,2 l 10,0 l 0,5 l -10,0 z");
    assert.strictEqual(JSON.stringify(rel),
      JSON.stringify([[1, 2], [11, 2], [11, 7], [1, 7]]),
      "relative lineto chains accumulate the current point");

    const abs = points("M 1 2 H 11 V 7 H 1 Z");
    assert.strictEqual(JSON.stringify(abs),
      JSON.stringify([[1, 2], [11, 2], [11, 7], [1, 7]]),
      "absolute H/V segments are supported");

    assert.strictEqual(points("m 0,0 c 1,1 2,2 3,3 l 1,0 l 0,1 z"), null,
      "a curved path is refused (we cannot map a curve)");
    assert.strictEqual(points("m 0,0 l 1,0 l 1,1 l 0,1 l -1,0 z"), null,
      "a path with five nodes is not a quad");
    assert.strictEqual(points("m 0,0 a 1,1 0 0 1 2,2 l 1,0 l 0,1 z"), null,
      "an arc is refused");
  }

  // --- The matrix: identity, scale, affine, perspective --------------------
  {
    const w = 106, h = 64;
    const id = [[0, 0], [w, 0], [w, h], [0, h]];

    const identity = matrix(w, h, id);
    assert.ok(/^matrix3d\(/.test(identity), "a valid quad yields matrix3d()");
    const args = identity.slice(9, -1).split(",").map(Number);
    assert.deepStrictEqual(args, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      "an unmodified quad yields the identity matrix");

    const scaled = [[0, 0], [2 * w, 0], [2 * w, 2 * h], [0, 2 * h]];
    for (let i = 0; i < 4; i++) {
      closePoint(project(matrix(w, h, scaled), id[i][0], id[i][1]), scaled[i],
        "a uniform scale maps corner " + i);
    }

    // Parallelogram: an affine transform, no perspective terms.
    const skew = [[0, 0], [116, 10], [126, 74], [10, 64]];
    const skewMatrix = matrix(w, h, skew);
    for (let i = 0; i < 4; i++) {
      closePoint(project(skewMatrix, id[i][0], id[i][1]), skew[i],
        "an affine skew maps corner " + i);
    }
    const skewArgs = skewMatrix.slice(9, -1).split(",").map(Number);
    assert.ok(Math.abs(skewArgs[3]) < 1e-9 && Math.abs(skewArgs[7]) < 1e-9,
      "a parallelogram has no perspective terms (m6 = m7 = 0)");

    // Trapezoid: the top edge is narrower than the bottom one -> perspective.
    const trap = [[10, 0], [96, 0], [116, 64], [-10, 64]];
    const trapMatrix = matrix(w, h, trap);
    for (let i = 0; i < 4; i++) {
      closePoint(project(trapMatrix, id[i][0], id[i][1]), trap[i],
        "a perspective quad maps corner " + i);
    }
    const trapArgs = trapMatrix.slice(9, -1).split(",").map(Number);
    assert.ok(Math.abs(trapArgs[3]) > 1e-6 || Math.abs(trapArgs[7]) > 1e-6,
      "a trapezoid carries perspective terms");

    // The centre of the box lands inside the quad (a sanity check that the
    // whole area is projected, not just the corners).
    const centre = project(trapMatrix, w / 2, h / 2);
    assert.ok(centre[0] > -10 && centre[0] < 116 && centre[1] > 0 && centre[1] < 64,
      "the box centre lands inside the quad" + JSON.stringify(centre));
  }

  // --- Layer modes: corner / centre / sheet --------------------------------
  // ttyQuadLayerMatrix() turns a marker quad into the matrix3d() one specific
  // layer consumes. The mode decides WHERE the projection grows from and
  // whether a layer's own dynamic scale survives.
  {
    // Unitless (unit = 1) so the SVG units below read as the layer's px.
    const src = [[0, 0], [576, 0], [576, 212], [0, 212]];

    // corner: the layer sits at the marker's top-left, so its native box is
    // mapped onto the quad from that corner (an affine and a free-form quad).
    const corner = { id: "Keyboard", prefix: "--tty-kbd", anchor: "corner", w: 576, h: 212 };
    const cornerVars = { "--tty-kbd-x": "10", "--tty-kbd-y": "20",
                         "--tty-kbd-w": "100", "--tty-kbd-h": "40" };
    // The marker rect (10,20)-(110,60) rotated by +3 degrees about its corner.
    const tilt = [[10, 20], [109.8632, 25.2360], [107.7692, 65.1810], [7.9068, 59.9450]];
    const tiltM = layer(corner, tilt, cornerVars, { unit: 1 });
    for (let i = 0; i < 4; i++) {
      closePoint(project(tiltM, src[i][0], src[i][1]),
        [tilt[i][0] - 10, tilt[i][1] - 20],
        "corner mode projects the native box corner " + i + " onto a tilted marker");
    }

    const trapVars = { "--tty-kbd-x": "0", "--tty-kbd-y": "0",
                       "--tty-kbd-w": "100", "--tty-kbd-h": "64" };
    const trap = [[10, 0], [96, 0], [116, 64], [-10, 64]];
    const trapM = layer(corner, trap, trapVars, { unit: 1 });
    for (let i = 0; i < 4; i++) {
      closePoint(project(trapM, src[i][0], src[i][1]), trap[i],
        "corner mode projects corner " + i + " of a hand-drawn trapezoid");
    }

    // centre: the CCU block is centred on the marker, so the projection grows
    // from the marker CENTRE (the stylesheet keeps the centring through the
    // fallback, which the projection replaces).
    const centreEntry = { id: "Apron", prefix: "--tty-apron", anchor: "centre", w: 118, h: 66 };
    const centreVars = { "--tty-apron-x": "100", "--tty-apron-y": "200",
                         "--tty-apron-w": "40", "--tty-apron-h": "20" };
    const apronQuad = [[100, 200], [140, 200], [140, 220], [100, 220]];
    const apronM = layer(centreEntry, apronQuad, centreVars, { unit: 1 });
    const apronSrc = [[0, 0], [118, 0], [118, 66], [0, 66]];
    for (let i = 0; i < 4; i++) {
      closePoint(project(apronM, apronSrc[i][0], apronSrc[i][1]),
        [apronQuad[i][0] - 120, apronQuad[i][1] - 210],
        "centre mode projects the box corner " + i + " from the marker centre");
    }

    // sheet: the printer block keeps its own dynamic scale, so only the artist's
    // transform is published — checked through the RIG space. Without a marker
    // transform a local point p lands at C + k*(p - pivot); with one, the same
    // point lands where the artist's transform puts that rig position (C is the
    // print point: the Paper marker's centre-x on the Caret line).
    const sheet = { id: "Paper", prefix: "--tty-paper", anchor: "sheet",
                    altId: "Caret", pivot: [404, 316] };
    const sheetVars = { "--tty-paper-x": "0", "--tty-paper-y": "90",
                        "--tty-paper-w": "200", "--tty-caret-line-y": "150" };
    const k = 0.5;
    const line = [100, 150];
    const quadDummy = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const rotateBack = "matrix(0.99862953,-0.05233596,0.05233596,0.99862953,0,0)";
    const sheetM = layer(sheet, quadDummy, sheetVars,
      { unit: 1, sheetK: k, artTransform: rotateBack });
    assert.ok(sheetM, "an affine marker transform yields the sheet projection");
    const rigOf = (x, y) => [line[0] + k * (x - 404), line[1] + k * (y - 316)];
    for (const p of [[0, 0], [404, 316], [808, 380]]) {
      const wanted = rigOf(p[0], p[1]);
      const moved = [0.99862953 * wanted[0] + 0.05233596 * wanted[1],
                     -0.05233596 * wanted[0] + 0.99862953 * wanted[1]];
      const got = project(sheetM, p[0], p[1]);
      closePoint(rigOf(got[0], got[1]), moved,
        "the sheet follows the artist's transform about the print point");
    }

    assert.strictEqual(layer(sheet, quadDummy, sheetVars,
      { unit: 1, sheetK: k, artTransform: "" }), null,
      "a sheet marker without its own transform publishes nothing (upright sheet)");
    assert.strictEqual(layer(sheet, quadDummy, sheetVars,
      { unit: 1, sheetK: k, artTransform: "skewX(10)" }), null,
      "a non-affine sheet transform is refused — the honest upright sheet stays");

    // Missing numbers and a zero scale never throw, they just keep the fallback.
    assert.strictEqual(layer(corner, tilt, {}, { unit: 1 }), null,
      "a marker without numbers publishes nothing");
    assert.strictEqual(layer(corner, tilt, cornerVars, { unit: 0 }), null,
      "a zero unit is refused");
    assert.strictEqual(layer(null, tilt, cornerVars, { unit: 1 }), null,
      "no entry -> null");

    // The artist's transform attribute is read straight off the rect.
    assert.strictEqual(rectTransform(
      '<rect id="Paper" width="1" height="1" transform="rotate(3)"/>', "Paper"),
      "rotate(3)", "the sheet projection reads the marker rect's transform");
    assert.strictEqual(rectTransform('<rect id="Paper" width="1" height="1"/>', "Paper"),
      "", "a plain marker rect has no transform attribute");
  }

  // --- Degenerate input keeps the fallback ---------------------------------
  {
    const w = 106, h = 64;
    assert.strictEqual(matrix(w, h, [[0, 0], [10, 0], [20, 0], [30, 0]]), null,
      "four collinear points are degenerate -> null (uniform fit stays)");
    assert.strictEqual(matrix(w, h, [[0, 0], [10, 0], [10, 10]]), null,
      "three points are not a quad");
    assert.strictEqual(matrix(0, h, [[0, 0], [1, 0], [1, 1], [0, 1]]), null,
      "a zero-sized source box is refused");
    assert.strictEqual(matrix(w, h, null), null, "no quad -> null");
  }

  console.log("tty-quad-matrix: all tests passed");
}

run();
