#!/usr/bin/env node
/**
 * Rebuilds src/bootcode.js (and desktop/src/bootcode.js) from the MACRO-11
 * sources using the host-side cross tools:
 *
 *   - macro11.exe  : portable MACRO-11 assembler (Krehbiel/Hoppe)
 *   - pclink11.exe : PDP-11 linker (PCLINK11)
 *
 * boot.mac assembles byte-for-byte identical to the shipped bootcode.js
 * (verified), so the boot half of the image is rebuilt authentically. Since
 * the 2026-08-29 cleanup (variant A: ODT, lights, chaser and the MMU demo
 * removed) the image contains the boot module only.
 *
 * The boot module's banner string was replaced with `.blkb 52` (52 octal =
 * 42 bytes) so the module keeps its exact original size - only the author
 * credit banner is dropped.
 *
 * Usage:  node tools/rebuild-bootcode.js
 *         npm run rebuild-boot
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ASM_DIR = path.join(ROOT, "macro-asm");
const MACRO11 = path.join(ROOT, "macro11.exe");
const PCLINK11 = path.join(ROOT, "pclink11.exe");
const BOOTCODE_SRC = path.join(ROOT, "src", "bootcode.js");
const BOOTCODE_DESKTOP = path.join(ROOT, "desktop", "src", "bootcode.js");

const BOOT_BASE = 0o120000; // link base address (words stored from here)

function tmp(name) {
  return path.join(os.tmpdir(), "yapdp-" + name);
}

// Read a CR/CRLF source, return LF-normalised text.
function readLf(relName) {
  const raw = fs.readFileSync(path.join(ASM_DIR, relName), "latin1");
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Assemble a .mac to .obj with macro11.exe. Runs with cwd = macro-asm/ and
// relative file names (macro11 also parses "dev:file" RT-11 style specs).
function assemble(srcBase, objBase, extraOpts = []) {
  const lfBase = srcBase.replace(/\.mac$/i, "_lf.mac");
  fs.writeFileSync(path.join(ASM_DIR, lfBase), readLf(srcBase), "latin1");
  execFileSync(MACRO11, ["-o", objBase, "-ysl", "24", "-yus", ...extraOpts, lfBase],
    { cwd: ASM_DIR, stdio: "inherit" });
  const obj = path.join(ASM_DIR, objBase);
  console.log("  assembled " + srcBase + " -> " + objBase + " (" + fs.statSync(obj).size + " bytes)");
  return obj;
}

// Link boot.obj with base 120000 -> boot.sav. pclink11 parses its
// arguments as RT-11 "dev:file" specs, so absolute Windows paths ("E:\...")
// break it - pass relative names and run with cwd = macro-asm/.
function link() {
  const sav = path.join(ASM_DIR, "boot.sav");
  try { fs.unlinkSync(sav); } catch (e) { /* ignore */ }
  execFileSync(PCLINK11,
    ["-B:" + BOOT_BASE.toString(8), "-T:" + BOOT_BASE.toString(8),
     "-EXECUTE:boot.sav", "boot.obj"],
    { cwd: ASM_DIR, stdio: "inherit" });
  if (!fs.existsSync(sav)) {
    throw new Error("link did not produce boot.sav");
  }
  console.log("  linked -> boot.sav (" + fs.statSync(sav).size + " bytes)");
  return sav;
}

// Parse a .sav memory image (words from address 0) into a word array.
function readSavWords(savPath) {
  const b = fs.readFileSync(savPath);
  const words = [];
  for (let i = 0; i + 1 < b.length; i += 2) {
    words.push((b[i] | (b[i + 1] << 8)) & 0xffff);
  }
  return words;
}

// Read the current bootcode.js word array.
function readBootcodeWords(file) {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(/var bootcode=\[([\s\S]*?)\];/);
  if (!m) throw new Error("bootcode array not found in " + file);
  const words = [];
  for (const w of m[1].split(",")) {
    const t = w.trim();
    if (/^0o[0-7]+$/.test(t)) words.push(Number(t));
  }
  return words;
}

// Serialise words into the bootcode.js array body (8 words per line, 0o octals).
function formatWords(words) {
  let body = "var bootcode=[\n";
  for (let i = 0; i < words.length; i++) {
    body += "0o" + words[i].toString(8).padStart(6, "0");
    if (i < words.length - 1) body += ",";
    if ((i + 1) % 8 === 0) body += "\n";
  }
  body += "\n];\n";
  return body;
}

function writeBootcode(file, header, words) {
  fs.writeFileSync(file, header + formatWords(words), "utf8");
}

function main() {
  console.log("== host assembly ==");
  const bootObj = assemble("boot.mac", "boot.obj");

  console.log("== link ==");
  const sav = link();

  console.log("== extract boot module ==");
  const savWords = readSavWords(sav);
  const base = savWords.indexOf(0o000005); // first boot instruction (reset)
  if (base < 0) {
    throw new Error("boot module start (word 000005) not found in boot.sav");
  }
  // boot.sav contains the boot module only (odt11 is no longer linked), so
  // everything from the first boot instruction to the end of the image is the
  // module. The last data word is 0 (the UDA50 table terminator), so only
  // trim *extra* trailing zeros the linker may have padded past it.
  let newBoot = savWords.slice(base);
  let trail = 0;
  for (let i = newBoot.length - 1; i >= 0 && newBoot[i] === 0; i--) trail++;
  if (trail > 1) newBoot = newBoot.slice(0, newBoot.length - (trail - 1));
  if (newBoot.length === 0) {
    throw new Error("boot module is empty");
  }
  console.log("  boot module: " + newBoot.length + " words (addr " +
    (base * 2).toString(8) + ")");

  console.log("== rebuild src/bootcode.js ==");
  const srcText = fs.readFileSync(BOOTCODE_SRC, "utf8");
  const cur = readBootcodeWords(BOOTCODE_SRC);
  const words = newBoot;
  const header = srcText.slice(0, srcText.indexOf("var bootcode="));

  // Report how the new image differs from the previous one (informational).
  const diffs = [];
  for (let i = 0; i < Math.min(words.length, cur.length); i++) {
    if (words[i] !== cur[i]) diffs.push(i);
  }
  console.log("  boot diffs vs previous image: " + diffs.length +
    " word(s) at [" + diffs.slice(0, 20).join(",") +
    (diffs.length > 20 ? ",..." : "") + "]");
  console.log("  size change: " + cur.length + " -> " + words.length + " words");

  writeBootcode(BOOTCODE_SRC, header, words);
  console.log("  wrote src/bootcode.js (" + words.length + " words)");

  console.log("== sync desktop/src/bootcode.js ==");
  fs.copyFileSync(BOOTCODE_SRC, BOOTCODE_DESKTOP);
  console.log("  copied to desktop/src/bootcode.js");

  console.log("== done ==");
}

main();
