#!/usr/bin/env node
/**
 * bin2bootdump.js - convert a binary file (RT-11 .SAV memory image or any
 * raw PDP-11 image) into a bootcode.js-style octal word dump.
 *
 * The RT-11 .SAV produced by LINK (e.g. via the in-emulator pipeline
 * COPY -> MACRO -> LINK -> COPY DK1:BOOT.SAV PC:) is a plain memory image:
 * file offset == memory address, little-endian 16-bit words. This tool reads
 * such an image and emits words in the exact format used by src/bootcode.js:
 *
 *     var BOOTBASE=0120000;
 *     var bootcode=[
 *     0o000005,0o005037,...
 *     ];
 *
 * Word selection:
 *   --base <oct>    start dumping at this memory address (file offset).
 *                   BOOTBASE is set to this value.
 *   --marker <oct>  instead, scan for the first word equal to <oct> (e.g.
 *                   000005 = RESET, the first boot instruction) and start
 *                   there. BOOTBASE is set to the found address.
 *   --words <n>     number of words to emit (default: to end of file).
 *
 * Output:
 *   --var <name>    variable name (default: bootcode)
 *   --out <file>    write to file instead of stdout
 *
 * Example:
 *   node tools/bin2bootdump.js boot.sav --marker 000005 --words 979
 *     --var bootcode --out /tmp/bootcode.new.js
 */
"use strict";

const fs = require("fs");

function parseArgs(argv) {
  const opts = { base: null, marker: null, words: null, varName: "bootcode", out: null };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--base") opts.base = parseInt(val(), 8);
    else if (a === "--marker") opts.marker = parseInt(val(), 8);
    else if (a === "--words") opts.words = parseInt(val(), 10);
    else if (a === "--var") opts.varName = val();
    else if (a === "--out") opts.out = val();
    else if (a === "--help" || a === "-h") {
      console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 28).join("\n"));
      process.exit(0);
    } else files.push(a);
  }
  if (files.length !== 1) {
    console.error("usage: node tools/bin2bootdump.js <image.bin> [--base <oct>|--marker <oct>] [--words N] [--var name] [--out file]");
    process.exit(1);
  }
  return { ...opts, file: files[0] };
}

// Read a binary image as little-endian 16-bit words (address 0 = offset 0).
function readSavWords(savPath) {
  const b = fs.readFileSync(savPath);
  const words = [];
  for (let i = 0; i + 1 < b.length; i += 2) {
    words.push((b[i] | (b[i + 1] << 8)) & 0xffff);
  }
  return words;
}

// Serialise words into the bootcode.js array body (8 words per line, 0o octals).
function formatWords(words, varName) {
  let body = "var " + varName + "=[\n";
  for (let i = 0; i < words.length; i++) {
    body += "0o" + words[i].toString(8).padStart(6, "0");
    if (i < words.length - 1) body += ",";
    if ((i + 1) % 8 === 0) body += "\n";
  }
  body += "\n];\n";
  return body;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const words = readSavWords(opts.file);

  let start = 0; // word index
  let baseAddr = 0; // memory address (bytes) of word 0 of the dump
  if (opts.marker !== null) {
    const from = opts.base !== null ? opts.base / 2 : 0;
    const idx = words.indexOf(opts.marker, from);
    if (idx < 0) {
      console.error("marker word 0o" + opts.marker.toString(8) + " not found in " + opts.file);
      process.exit(1);
    }
    start = idx;
    baseAddr = idx * 2;
  } else if (opts.base !== null) {
    if (opts.base % 2 !== 0) {
      console.error("--base must be an even (word-aligned) address");
      process.exit(1);
    }
    start = opts.base / 2;
    baseAddr = opts.base;
  }

  if (start >= words.length) {
    console.error("start address 0o" + baseAddr.toString(8) + " is beyond the " +
      words.length + " words (" + (words.length * 2).toString(8) + " bytes) of " + opts.file);
    process.exit(1);
  }

  const n = opts.words !== null ? opts.words : words.length - start;
  if (start + n > words.length) {
    console.error("requested " + n + " words from 0o" + baseAddr.toString(8) +
      " but the image has only " + (words.length - start) + " words left");
    process.exit(1);
  }
  const dump = words.slice(start, start + n);

  const baseVar = opts.varName === "bootcode" ? "BOOTBASE" : opts.varName.toUpperCase() + "_BASE";
  const text = "var " + baseVar + "=" + baseAddr.toString(8) + ";\n" + formatWords(dump, opts.varName);

  if (opts.out) {
    fs.writeFileSync(opts.out, text, "utf8");
    console.log("wrote " + n + " words (addr 0o" + baseAddr.toString(8) + ") to " + opts.out);
  } else {
    process.stdout.write(text);
  }
}

main();
