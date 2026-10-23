#!/usr/bin/env node
/**
 * Probe — does the document builder keep every glyph of a hard line?
 *
 * Feeds a line shaped like a real `man` paragraph (leading indent, bold and
 * underlined spans, the double space after a full stop) through lineHtml() and
 * buildPrintDocument(), then strips the markup back off and compares. A missing
 * phrase in the print preview shows up here as a mismatch.
 *
 *   node tools/_probe-lp11-line.js
 */
"use strict";

const path = require("path");
const assert = require("assert");

const paper = require(path.join(__dirname, "..", "src", "lp11paper.js"));

const text = "      read from a terminal or a file.  See invocation for the";
const runs = [
    { at: 0, len: 6, kind: paper.BOLD },
    { at: 6, len: 34, kind: paper.UNDERLINE },
    { at: 40, len: 3, kind: paper.BOLD },
    { at: 43, len: 19, kind: paper.UNDERLINE },
];

function strip(markup) {
    return markup.replace(/<\/?[bu]>/g, "");
}

const line = paper.lineHtml({ text, runs });
console.log("lineHtml :", line);
assert.strictEqual(strip(line), text, "lineHtml keeps every glyph");

const doc = paper.buildPrintDocument([{ text, runs }], { columns: paper.DEFAULT_COLUMNS });
const pre = /<pre>([\s\S]*?)<\/pre>/.exec(doc);
assert.ok(pre, "the document has a <pre>");
console.log("pre      :", pre[1]);
assert.strictEqual(strip(pre[1]), text, "the document keeps every glyph");

// And through the text model, from the raw overstrike stream nroff emits:
// bold is "X\bX", underline is "_\bX" — the copy must read "read from a file."
const state = { buffer: [], bufferRuns: [], line: "", lineRuns: [], col: 0 };
const stream = [];
for (const ch of "read from a ") stream.push(ch.charCodeAt(0));
for (const ch of "file") stream.push(95, 8, ch.charCodeAt(0)); // _ BS c = underline
for (const ch of ".") stream.push(ch.charCodeAt(0));
stream.push(10);
for (const ch of stream) paper.textPut(state, ch);
console.log("model    :", JSON.stringify(state.buffer[0]), JSON.stringify(state.bufferRuns[0]));
assert.strictEqual(state.buffer[0], "read from a file.", "overstrike collapses to the glyph");
assert.deepStrictEqual(state.bufferRuns[0],
    [{ at: 12, len: 4, kind: paper.UNDERLINE }],
    "the four struck glyphs carry one merged underline run");

console.log("ok: no glyph is lost between the guest stream and the printed line");
