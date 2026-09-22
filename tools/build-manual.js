#!/usr/bin/env node
/**
 * yaPDP — user-manual generator.
 *
 * The user manual used to live twice: manual.html (hand-written HTML, English)
 * and landing/src/data/manualData.ts (TypeScript objects, English + Russian).
 * Every documentation change was written twice, and the two copies drifted —
 * the landing had no Troubleshooting text at all while the HTML had a full
 * section for it.
 *
 * docs/manual/*.md is now the single source: one Markdown file per section,
 * English, with docs/manual/ru/ holding the Russian translation. This script
 * reads those files and emits BOTH outputs from them, so the same fact can no
 * longer be written down in two places and disagree.
 *
 *   docs/manual/*.md ─┬─→ manual.html                 (user manual page)
 *   docs/manual/ru/   └─→ landing/src/data/manualData.ts (React landing)
 *
 * Design choices worth knowing:
 *
 *   - No Markdown dependency. The manual is written in a deliberately small
 *     subset (headings, paragraphs, lists, tables, images, inline code, bold)
 *     and the converter below handles exactly that subset. Pulling a parser in
 *     would add a dependency and an upgrade chore for no gain here.
 *
 *   - The section ORDER and its numbering come from the files, not from a
 *     stored field: sections are numbered 1..N by the order they appear in
 *     docs/manual/_meta.yml, so the "number 13 sits between 7 and 8" class of
 *     bug cannot be written down at all.
 *
 *   - Targets are written to <name>.generated.<ext> by default. Nothing
 *     overwrites the live files until --write is passed, so a reviewer can
 *     compare the generated output against what ships today before switching.
 *
 * Usage:
 *   node tools/build-manual.js            # write *.generated.* next to targets
 *   node tools/build-manual.js --write    # write the real targets
 *   node tools/build-manual.js --check    # exit non-zero if the real targets
 *                                         # are not what the source would emit
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "docs", "manual");
const SRC_RU = path.join(SRC, "ru");
const OUT_HTML = path.join(ROOT, "manual.html");
const OUT_TS = path.join(ROOT, "landing", "src", "data", "manualData.ts");

// --- the Markdown subset we actually use ------------------------------------

// Inline: `code`, **bold**, *italic*. Escaped HTML is not supported on purpose
// (the manual does not need raw HTML, and allowing it would defeat the point of
// having a single readable source).
function inline(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // images first: they may sit inside a table cell (the floating-controls
    // table puts a button icon in front of the label), and the cell renderer
    // runs this same function.
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
      (m, alt, src) => '<img src="' + src + '" alt="' + alt + '">')
    .replace(/`([^`]+)`/g, (m, code) => "<code>" + code + "</code>")
    .replace(/\*\*([^*]+)\*\*/g, (m, b) => "<strong>" + b + "</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, (m, pre, i) => pre + "<em>" + i + "</em>");
}

// One Markdown file -> a list of blocks. Kept structural (not a string of
// HTML) because both outputs need the same pieces in different shapes.
function parseBlocks(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  let list = null;
  let table = null;

  const flushPara = () => {
    if (para.length) { blocks.push({ type: "p", text: para.join(" ").trim() }); para = []; }
  };
  const flushList = () => {
    if (list) { blocks.push({ type: "ul", items: list }); list = null; }
  };
  const flushTable = () => {
    if (table) { blocks.push({ type: "table", rows: table }); table = null; }
  };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (!line.trim()) { flushAll(); continue; }

    const h = /^(#{2,6})\s+(.*)$/.exec(line);
    if (h) {
      flushAll();
      blocks.push({ type: "h", level: h[1].length, text: h[2].trim() });
      continue;
    }

    const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line.trim());
    if (img) {
      flushAll();
      blocks.push({ type: "img", alt: img[1], src: img[2] });
      continue;
    }

    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      flushPara(); flushTable();
      if (!list) list = [];
      list.push(li[1].trim());
      continue;
    }

    if (/^\|/.test(line)) {
      flushPara(); flushList();
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      // separator row (| --- | --- |) is structure, not content
      if (!cells.every((c) => /^-{2,}$/.test(c) || c === "")) {
        if (!table) table = [];
        table.push(cells);
      }
      continue;
    }

    // an indented continuation belongs to the paragraph we are in
    para.push(line.trim());
  }
  flushAll();
  return blocks;
}

function blocksToHtml(blocks, level = 2) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case "h": {
        const tag = "h" + Math.min(6, b.level);
        const id = slug(b.text);
        out.push("  <" + tag + ' id="' + id + '">' + inline(b.text) + "</" + tag + ">");
        break;
      }
      case "p":
        out.push("  <p>" + inline(b.text) + "</p>");
        break;
      case "ul":
        out.push("  <ul>");
        for (const it of b.items) out.push("    <li>" + inline(it) + "</li>");
        out.push("  </ul>");
        break;
      case "img":
        out.push('  <img src="' + b.src + '" alt="' + inline(b.alt) + '">');
        break;
      case "table": {
        out.push("  <table>");
        b.rows.forEach((row, i) => {
          out.push("    <tr>");
          for (const c of row) {
            const cell = i === 0 ? "th" : "td";
            out.push("      <" + cell + ">" + inline(c) + "</" + cell + ">");
          }
          out.push("    </tr>");
        });
        out.push("  </table>");
        break;
      }
    }
    out.push("");
  }
  return out.join("\n");
}

function slug(text) {
  return String(text).toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim().replace(/\s+/g, "-");
}

// --- reading the source ------------------------------------------------------

function readMeta() {
  // _meta.yml — the section list. Deliberately tiny YAML: the file holds an
  // ordered list of {id, ru}, where `ru` is the Russian title. Numbering is
  // positional (see the header comment), so no numbers are stored.
  const file = path.join(SRC, "_meta.yml");
  if (!fs.existsSync(file)) {
    // Fall back to the alphabetical file order so the generator still works
    // while the meta file is being written.
    const ids = fs.readdirSync(SRC).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
    return ids.map((id) => ({ id, ru: id }));
  }
  const text = fs.readFileSync(file, "utf8");
  const sections = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const mId = /^\s*-\s*id:\s*(.+?)\s*$/.exec(line);
    if (mId) { cur = { id: mId[1].replace(/^["']|["']$/g, "") }; sections.push(cur); continue; }
    const mRu = /^\s*ru:\s*(.+?)\s*$/.exec(line);
    if (mRu && cur) cur.ru = mRu[1].replace(/^["']|["']$/g, "");
    const mImg = /^\s*image:\s*(.+?)\s*$/.exec(line);
    if (mImg && cur) cur.image = mImg[1].replace(/^["']|["']$/g, "");
  }
  return sections;
}

function readSection(dir, id) {
  const file = path.join(dir, id + ".md");
  if (!fs.existsSync(file)) return null;
  return parseBlocks(fs.readFileSync(file, "utf8"));
}

// A section's first heading is its title; the rest is its body.
function splitTitle(blocks) {
  const first = blocks[0];
  if (first && first.type === "h") return { title: first.text, body: blocks.slice(1) };
  return { title: "", body: blocks };
}


// --- the three table-shaped structures the landing imports ------------------
//
// MANUAL_SECTIONS is generated from the section files themselves; the other
// three are tables inside those sections. They are read from the same Markdown
// so the landing and the manual can never disagree about, say, what boots from
// RK1 or what the Mute button does.
//
// The English cell text comes from docs/manual/*.md, the Russian from
// docs/manual/ru/*.md, and the two are married by ROW ORDER rather than by a
// key: the tables are short, ordered deliberately, and a key would have to be
// written twice (once per language) and could drift.

// Rows of the first table in a section, minus the header row.
function tableIn(blocks) {
  const t = blocks.find((b) => b.type === "table");
  return t ? t.rows : [];
}

// "| ![alt](src) Label | ... |" -> { image, text }
function splitIcon(cell) {
  const m = /^!\[([^\]]*)\]\(([^)]+)\)\s*(.*)$/.exec(cell.trim());
  if (!m) return { image: "", text: cell.trim() };
  return { image: m[2], text: m[3].trim() };
}

// CONFIG tabs: each h3 in config.md opens a tab; its bullets are the items,
// "**Label** — description" (the pattern the manual already uses).
function configTabs(blocksEn, blocksRu) {
  const tabs = [];
  let cur = null;
  for (let i = 0; i < blocksEn.length; i++) {
    const b = blocksEn[i];
    if (b.type === "h" && b.level === 3) {
      cur = { titleKey: b.text, itemsEn: [], image: "" };
      // the image that introduces a tab sits in the block just before/after it
      for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
        if (blocksEn[k].type === "img") { cur.image = blocksEn[k].src; break; }
      }
      tabs.push(cur);
      continue;
    }
    if (cur && b.type === "ul") {
      for (const it of b.items) {
        const m = /^\*\*([^*]+)\*\*\s*—\s*(.*)$/.exec(it);
        if (m) cur.itemsEn.push({ label: m[1].trim(), desc: m[2].trim() });
      }
    }
  }
  // marry to Russian by index
  const ruTabs = [];
  let curRu = null;
  for (const b of blocksRu) {
    if (b.type === "h" && b.level === 3) { curRu = { title: b.text, items: [] }; ruTabs.push(curRu); continue; }
    if (curRu && b.type === "ul") {
      for (const it of b.items) {
        const m = /^\*\*([^*]+)\*\*\s*—\s*(.*)$/.exec(it);
        if (m) curRu.items.push({ label: m[1].trim(), desc: m[2].trim() });
      }
    }
  }
  return tabs.map((t, i) => ({
    id: slug(t.titleKey),
    titleEn: t.titleKey,
    titleRu: ruTabs[i] ? ruTabs[i].title : t.titleKey,
    image: t.image,
    itemsEn: t.itemsEn,
    itemsRu: (ruTabs[i] ? ruTabs[i].items : []),
  }));
}

// --- outputs -----------------------------------------------------------------

// The page chrome is NOT rebuilt from Markdown: manual.html has a hero block,
// two stylesheets and ~200 lines of page-local CSS that the source does not
// describe and should not start describing. Those parts are kept verbatim in
// tools/manual-template-head.html / -tail.html, sliced out of the live page,
// so regenerating the manual retains its exact look. Only the table of
// contents and the section bodies are generated.
function buildHtml(sections) {
  const headFile = path.join(__dirname, "manual-template-head.html");
  const tailFile = path.join(__dirname, "manual-template-tail.html");
  if (!fs.existsSync(headFile) || !fs.existsSync(tailFile)) {
    throw new Error("missing page template: expected tools/manual-template-head.html " +
      "and tools/manual-template-tail.html (sliced from the live manual.html)");
  }
  const head = fs.readFileSync(headFile, "utf8");
  const tail = fs.readFileSync(tailFile, "utf8");

  const toc = sections.map((s, i) =>
    "                <li><a href=\"#" + s.id + "\">" + inline(s.titleEn) + "</a></li>").join("\n");
  const bodies = sections.map((s) =>
    '            <h2 id="' + s.id + '">' + inline(s.titleEn) + "</h2>\n\n" +
    blocksToHtml(s.blocksEn, 2).replace(/^ {2}/gm, "            ")).join("\n\n");

  return head + "            <h2>Table of Contents</h2>\n\n            <ol>\n" +
    toc + "\n            </ol>\n\n            <hr>\n\n" + bodies + "\n" + tail + "\n";
}

function tsString(s) {
  return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, " ") + "'";
}

function buildTs(sections, tables) {
  const secs = sections.map((s) => {
    const subs = s.subsectionsEn || [];
    const subLines = subs.length
      ? "\n    subsections: [\n" + subs.map((x) =>
          "      { id: " + tsString(x.id) + ", titleEn: " + tsString(x.titleEn) +
          ", titleRu: " + tsString(x.titleRu) + " },").join("\n") + "\n    ],"
      : "";
    return [
      "  {",
      "    id: " + tsString(s.id) + ",",
      "    // number is positional: generated from _meta.yml order, never stored",
      "    number: " + tsString(String(s.number)) + ",",
      "    titleEn: " + tsString(s.titleEn) + ",",
      "    titleRu: " + tsString(s.titleRu) + "," + subLines,
      "  },",
    ].join("\n");
  }).join("\n");

  const t = tables || {};
  const out = [
    "// GENERATED by tools/build-manual.js from docs/manual/*.md — do not edit.",
    "// The manual source is Markdown; this file is one of its two outputs.",
    "",
    "export interface ManualSection {",
    "  id: string;",
    "  titleEn: string;",
    "  titleRu: string;",
    "  number?: string;",
    "  subsections?: { id: string; titleEn: string; titleRu: string }[];",
    "}",
    "",
    "export const MANUAL_SECTIONS: ManualSection[] = [",
    secs,
    "];",
    "",
  ];

  if (t.GUEST_OS_TABLE) {
    out.push(
      "export interface GuestOsEntry {",
      "  disk: string;",
      "  name: string;",
      "  bootCommand: string;",
      "  instructionsEn: string;",
      "  instructionsRu: string;",
      "  credentials?: string;",
      "}",
      "",
      "// Read from the how-to-boot table in docs/manual(+ru)/guest-oses.md.",
      "export const GUEST_OS_TABLE: GuestOsEntry[] = [",
      t.GUEST_OS_TABLE.map((e) => {
        const lines = [
          "  {",
          "    disk: " + tsString(e.disk) + ",",
          "    name: " + tsString(e.name) + ",",
          "    bootCommand: " + tsString(e.bootCommand || "") + ",",
          "    instructionsEn: " + tsString(e.instructionsEn) + ",",
          "    instructionsRu: " + tsString(e.instructionsRu) + ",",
        ];
        if (e.credentials) lines.push("    credentials: " + tsString(e.credentials) + ",");
        lines.push("  },");
        return lines.join("\n");
      }).join("\n"),
      "];",
      ""
    );
  }

  if (t.CONFIG_TABS_DATA) {
    const items = (arr) => "[" + arr.map((x) =>
      "{ label: " + tsString(x.label) + ", desc: " + tsString(x.desc) + " }").join(", ") + "]";
    out.push(
      "export interface ConfigTabEntry {",
      "  id: string;",
      "  titleEn: string;",
      "  titleRu: string;",
      "  image: string;",
      "  itemsEn: { label: string; desc: string }[];",
      "  itemsRu: { label: string; desc: string }[];",
      "}",
      "",
      "// Read from the four CONFIG tabs in docs/manual(+ru)/config.md.",
      "export const CONFIG_TABS_DATA: ConfigTabEntry[] = [",
      t.CONFIG_TABS_DATA.map((tab) => [
        "  {",
        "    id: " + tsString(tab.id) + ",",
        "    titleEn: " + tsString(tab.titleEn) + ",",
        "    titleRu: " + tsString(tab.titleRu) + ",",
        "    image: " + tsString(tab.image) + ",",
        "    itemsEn: " + items(tab.itemsEn) + ",",
        "    itemsRu: " + items(tab.itemsRu) + ",",
        "  },",
      ].join("\n")).join("\n"),
      "];",
      ""
    );
  }

  if (t.FLOATING_CONTROLS_DATA) {
    out.push(
      "export interface FloatingControlEntry {",
      "  image: string;",
      "  nameEn: string;",
      "  nameRu: string;",
      "  whereEn: string;",
      "  whereRu: string;",
      "  descEn: string;",
      "  descRu: string;",
      "}",
      "",
      "// Read from the floating-controls table in docs/manual(+ru)/controls.md.",
      "export const FLOATING_CONTROLS_DATA: FloatingControlEntry[] = [",
      t.FLOATING_CONTROLS_DATA.map((e) => [
        "  {",
        "    image: " + tsString(e.image) + ",",
        "    nameEn: " + tsString(e.nameEn) + ", nameRu: " + tsString(e.nameRu) + ",",
        "    whereEn: " + tsString(e.whereEn) + ", whereRu: " + tsString(e.whereRu) + ",",
        "    descEn: " + tsString(e.descEn) + ", descRu: " + tsString(e.descRu) + ",",
        "  },",
      ].join("\n")).join("\n"),
      "];",
      ""
    );
  }

  return out.join("\n");
}

// --- main --------------------------------------------------------------------

function generate() {
  const meta = readMeta();
  if (!meta.length) throw new Error("no sections found in " + SRC);

  const sections = meta.map((m, i) => {
    const en = readSection(SRC, m.id);
    if (!en) throw new Error("missing English source: docs/manual/" + m.id + ".md");
    const ru = readSection(SRC_RU, m.id);
    if (!ru) throw new Error("missing Russian source: docs/manual/ru/" + m.id + ".md");
    const enSplit = splitTitle(en);
    const ruSplit = splitTitle(ru);
    // subsection ids come from the English h3s, so both languages stay aligned
    const subsEn = en.blocksEn = enSplit.body.filter((b) => b.type === "h" && b.level === 3);
    const subsRu = ruSplit.body.filter((b) => b.type === "h" && b.level === 3);
    return {
      id: m.id,
      number: i + 1,
      titleEn: enSplit.title,
      titleRu: ruSplit.title,
      blocksEn: enSplit.body,
      blocksRu: ruSplit.body,
      subsectionsEn: subsEn.map((b, k) => ({
        id: slug(b.text),
        titleEn: b.text,
        titleRu: subsRu[k] ? subsRu[k].text : b.text,
      })),
    };
  });

  // the three table-shaped structures, read from their own sections
  const secById = {};
  for (const s of sections) secById[s.id] = s;

  const guestEn = tableIn(secById["guest-oses"].blocksEn);
  const guestRu = tableIn(secById["guest-oses"].blocksRu);
  // Columns: Disk | Operating System | Boot Command | What Happens.
  // The boot COMMAND is language-independent (it is typed at the guest), so it
  // is taken once, from the English source; only "what happens" differs per
  // language and comes from its own file.
  const GUEST_OS_TABLE = guestEn.slice(1).map((row, i) => {
    const ruRow = guestRu[i + 1] || [];
    const entry = {
      disk: row[0] || "",
      name: row[1] || "",
      bootCommand: row[2] || "",
      instructionsEn: row[3] || "",
      instructionsRu: ruRow[3] || "",
    };
    // An optional fifth column carries the login credentials, where the guest
    // has a documented one. Kept out of the table when empty rather than
    // emitted as '', so the landing's `credentials?: string` keeps its meaning.
    if (row[4]) entry.credentials = row[4];
    return entry;
  });

  const ctrlEn = tableIn(secById["controls"].blocksEn);
  const ctrlRu = tableIn(secById["controls"].blocksRu);
  const FLOATING_CONTROLS_DATA = ctrlEn.slice(1).map((row, i) => {
    const en0 = splitIcon(row[0] || "");
    const ru0 = splitIcon((ctrlRu[i + 1] && ctrlRu[i + 1][0]) || "");
    const ruRow = ctrlRu[i + 1] || [];
    return {
      image: en0.image,
      nameEn: en0.text, nameRu: ru0.text,
      whereEn: row[1] || "", whereRu: ruRow[1] || "",
      descEn: row[2] || "", descRu: ruRow[2] || "",
    };
  });

  const CONFIG_TABS_DATA = configTabs(secById["config"].blocksEn, secById["config"].blocksRu);

  return {
    html: buildHtml(sections),
    ts: buildTs(sections, { GUEST_OS_TABLE, FLOATING_CONTROLS_DATA, CONFIG_TABS_DATA }),
    sections,
  };
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const check = args.includes("--check");

  let out;
  try {
    out = generate();
  } catch (err) {
    console.error("build-manual: " + err.message);
    process.exit(1);
  }

  const { html, ts, sections } = out;
  const missing = sections.filter((s) => !s.titleRu || !s.blocksRu.length)
    .map((s) => s.id);
  if (missing.length) {
    console.error("build-manual: no Russian translation for: " + missing.join(", "));
    process.exit(1);
  }

  if (check) {
    const curHtml = fs.existsSync(OUT_HTML) ? fs.readFileSync(OUT_HTML, "utf8") : "";
    const curTs = fs.existsSync(OUT_TS) ? fs.readFileSync(OUT_TS, "utf8") : "";
    const drift = [];
    if (curHtml !== html) drift.push("manual.html");
    if (curTs !== ts) drift.push("manualData.ts");
    if (drift.length) {
      console.error("build-manual: generated output differs from " + drift.join(" and ") +
        " — run `npm run manual:build`");
      process.exit(1);
    }
    console.log("build-manual: " + sections.length + " sections, output in sync");
    return;
  }

  if (write) {
    fs.writeFileSync(OUT_HTML, html);
    fs.writeFileSync(OUT_TS, ts);
    console.log("build-manual: wrote manual.html and manualData.ts (" +
      sections.length + " sections)");
    return;
  }

  fs.writeFileSync(OUT_HTML + ".generated", html);
  fs.writeFileSync(OUT_TS + ".generated", ts);
  console.log("build-manual: wrote manual.html.generated and manualData.ts.generated (" +
    sections.length + " sections, " + html.length + " + " + ts.length + " bytes)");
  console.log("  review them, then run with --write to replace the live files");
}

if (require.main === module) main();

module.exports = { parseBlocks, inline, slug, generate };
