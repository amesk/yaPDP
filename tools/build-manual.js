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
 * reads those files and emits ALL outputs from them, so the same fact can no
 * longer be written down in two places and disagree.
 *
 *   docs/manual/*.md ─┬─→ manual.html                    (user manual page, EN)
 *   docs/manual/ru/   ├─→ manual_ru.html                 (user manual page, RU)
 *                     └─→ landing/src/data/manualData.ts (React landing)
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
 *
 * The three outputs are produced, checked and written together: a page cannot
 * be left behind at an older revision because one of the three modes forgot it.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "docs", "manual");
const SRC_RU = path.join(SRC, "ru");
const OUT_HTML = path.join(ROOT, "manual.html");
const OUT_HTML_RU = path.join(ROOT, "manual_ru.html");
const OUT_TS = path.join(ROOT, "landing", "src", "data", "manualData.ts");

// --- the Markdown subset we actually use ------------------------------------

// Inline: `code`, **bold**, *italic*. Escaped HTML is not supported on purpose
// (the manual does not need raw HTML, and allowing it would defeat the point of
// having a single readable source).
function inline(text) {
  return String(text)
    // Comments go FIRST, before the escaping below turns their angle brackets
    // into visible text (&lt;!-- … --&gt;). A review marker that reaches the
    // page is worse than useless: the reader sees the note itself.
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // images first: they may sit inside a table cell (the floating-controls
    // table puts a button icon in front of the label), and the cell renderer
    // runs this same function.
    .replace(/!\[([^\]]*)\]\(([^)]+)\)(\{\.[a-z-. ]+\})?/g,
      (m, alt, src, cls) => {
        const c = cls ? cls.slice(2, -1).trim() : "shot";
        return '<img class="' + c + '" src="' + src + '" alt="' + alt + '">';
      })
    // a text run marked {.class} becomes a <span> — used for the control names
    // inside the floating-controls table, which the stylesheet grid-aligns.
    // A marked text run becomes a <span> — used for the control names in the
    // floating-controls table. It must wrap ONLY the label: the cell also holds
    // the button image, and .control-name styles text (weight, colour), so
    // swallowing the <img> inside the span broke the cell's layout.
    .replace(/(^|>)([^{}<>]+)\{\.([a-z-]+)\}/g,
      (m, pre, text, cls) => pre + '<span class="' + cls + '">' + text.trim() + "</span>")
    // internal links: [text](#anchor) — the manual cross-references itself,
    // and a plain-text "Config page" is a worse page than a link.
    .replace(/\[([^\]]+)\]\(#([a-z0-9-]+)\)/g,
      (m, text, anchor) => '<a href="#' + anchor + '">' + text + '</a>')
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
  let fence = null;   // inside a ``` block

  const flushPara = () => {
    if (para.length) { blocks.push({ type: "p", text: para.join(" ").trim() }); para = []; }
  };
  const flushList = () => {
    if (list) { blocks.push({ type: list.kind, items: list.items }); list = null; }
  };
  const flushTable = () => {
    if (table) { blocks.push({ type: "table", rows: table }); table = null; }
  };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (!line.trim()) { flushAll(); continue; }

    // A line that is only a comment (a review marker) carries no content.
    if (/^<!--[\s\S]*-->$/.test(line.trim())) continue;

    const h = /^(#{2,6})\s+(.*)$/.exec(line);
    if (h) {
      flushAll();
      blocks.push({ type: "h", level: h[1].length, text: h[2].trim() });
      continue;
    }

    const img = /^!\[([^\]]*)\]\(([^)]+)\)(\{\.[a-z-]+\})?$/.exec(line.trim());
    if (img) {
      flushAll();
      blocks.push({ type: "img", alt: img[1], src: img[2],
        cls: img[3] ? img[3].slice(2, -1) : "shot" });
      continue;
    }

    // Two list kinds, and the difference matters: a numbered list is a recipe
    // ("do these in order"), a bulleted one is a set. The converter used to
    // collapse both into <ul>, which turned the quick-boot steps and the panel
    // switch sequence into unordered bullets.
    // A fenced code block (``` ... ```) is a <pre> in the output: the panel
    // switch sequences are column-aligned recipes, and folding them into one
    // line loses the alignment that makes them readable.
    if (/^```/.test(line.trim())) {
      if (fence === null) { flushAll(); fence = []; }
      else { blocks.push({ type: "pre", text: fence.join("\n") }); fence = null; }
      continue;
    }
    if (fence !== null) { fence.push(raw.replace(/\s+$/, "")); continue; }

    // "> text" is a block quote — the one Note: in storage.md, which the
    // reference page sets as <blockquote><em>Note:</em> …</blockquote>.
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      flushAll();
      blocks.push({ type: "blockquote", text: bq[1].trim() });
      continue;
    }

    const li = /^[-*]\s+(.*)$/.exec(line);
    const oli = /^\d+[.)]\s+(.*)$/.exec(line);
    if (li || oli) {
      flushPara(); flushTable();
      const kind = oli ? "ol" : "ul";
      if (!list || list.kind !== kind) {
        flushList();
        list = { kind: kind, items: [] };
      }
      list.items.push((oli ? oli[1] : li[1]).trim());
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

    // ::: wrappers — the CONFIG tab cards are a two-column grid in the
    // stylesheet (.config-item), so the grouping has to survive the source.
    const wrap = /^:::([a-z-]*)$/.exec(line.trim());
    if (wrap) {
      flushAll();
      blocks.push({ type: wrap[1] ? "open" : "close", cls: wrap[1] });
      continue;
    }

    // an indented continuation belongs to the paragraph we are in
    para.push(line.trim());
  }
  if (fence !== null) throw new Error("unterminated ``` code block");
  flushAll();
  return blocks;
}

function blocksToHtml(blocks, level = 2, headings = null) {
  const out = [];
  const openWrappers = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    switch (b.type) {
      case "h": {
        const tag = "h" + Math.min(6, b.level);
        // `headings` supplies ready-made anchor ids, consumed in order. The
        // Russian page passes the ENGLISH ids here: slug() strips every
        // non-ASCII character, so a Russian <h3> would be emitted with an empty
        // id — and every heading of the section would then collide on that same
        // empty id. With the English ids the anchors stay unique and a deep link
        // resolves in either language.
        const id = headings && headings.length ? headings.shift() : slug(b.text);
        out.push("  <" + tag + (id ? ' id="' + id + '"' : "") + ">" + inline(b.text) +
          "</" + tag + ">");
        break;
      }
      case "p": {
        // A paragraph marked {.shot-caption} in the source is an image caption;
        // the stylesheet gives it its own typography. The marker lives in the
        // Markdown so the source still describes the look.
        const m = /^(.*)\{\.([a-z-]+)\}$/.exec(b.text);
        const cls = m ? m[2] : "";
        out.push("  <p" + (cls ? ' class="' + cls + '"' : "") + ">" +
          inline(m ? m[1] : b.text) + "</p>");
        break;
      }
      case "ul":
      case "ol":
        out.push("  <" + b.type + ">");
        for (const it of b.items) out.push("    <li>" + inline(it) + "</li>");
        out.push("  </" + b.type + ">");
        break;
      case "img": {
        // Inside a CONFIG card the image is a grid cell, not a standalone
        // picture: no <p> wrapper, or the grid breaks.
        const img = '<img class="' + (b.cls || "shot") + '" src="' + b.src +
          '" alt="' + inline(b.alt) + '">';
        if (openWrappers.length) { out.push("  " + img); break; }

        // A picture followed by a {.shot-caption} paragraph is one thing on the
        // page: the caption names the frame, and a reader who meets the caption
        // on the next sheet has lost which picture it belongs to. They used to
        // be emitted as two sibling <p> elements, so no CSS rule could hold them
        // together — page-break-inside: avoid needs a common box to protect.
        // Wrapped in a <figure>, the pair is one block and the break rule has
        // something to apply to. Seen in the printed manual: the Storage
        // screenshot stayed on page 17 while its caption went to page 18.
        const next = blocks[bi + 1];
        const isCaption = next && next.type === "p" && /\{\.shot-caption\}$/.test(next.text);
        if (isCaption) {
          const m = /^(.*)\{\.shot-caption\}$/.exec(next.text);
          out.push('  <figure class="shot-figure">');
          out.push("    " + img);
          out.push('    <figcaption class="shot-caption">' + inline(m[1]) +
            "</figcaption>");
          out.push("  </figure>");
          bi++;                     // the caption is consumed by the figure
          break;
        }
        out.push("  <p>" + img + "</p>");
        break;
      }
      case "open":
        out.push("  <div" + (b.cls ? ' class="' + b.cls + '"' : "") + ">");
        openWrappers.push(b.cls);
        break;
      case "close":
        // One ::: closes EVERY wrapper opened since the last close — the CONFIG
        // card opens two (<div class="config-item"><div ...-text">), and an
        // unbalanced <div> makes the browser swallow the rest of the document:
        // that is why every section after Configuration failed to render.
        while (openWrappers.length) {
          out.push("  </div>");
          openWrappers.pop();
        }
        break;
      case "blockquote":
        out.push("  <blockquote>" + inline(b.text) + "</blockquote>");
        break;
      case "pre":
        // <pre> keeps the alignment verbatim; the source's own indentation is
        // what the reference page shows, so no re-indenting here.
        out.push("  <pre>" + b.text + "</pre>");
        break;
      case "table": {
        out.push("  <table>");
        b.rows.forEach((row, i) => {
          out.push("    <tr>");
          for (const c of row) {
            const cell = i === 0 ? "th" : "td";
            // a cell may open with {.class} / {.a .b}: the class belongs to the
            // <td> itself (the disk/image tables style their first column).
            const m = /^\{\.([a-z-. ]+)\}\s*(.*)$/.exec(c.trim());
            // the marker is {.disk .control-cell}: strip the braces and turn
            // the dot-separated list into a real class list ("disk control-cell")
            const cls = m ? m[1].replace(/\./g, " ").replace(/\s+/g, " ").trim() : "";
            const text = m ? m[2] : c;
            out.push("      <" + cell + (cls ? ' class="' + cls + '"' : "") + ">" +
              inline(text) + "</" + cell + ">");
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
// A floating-controls cell now looks like this in the source:
//
//   {.disk .control-cell} ![Magic wand](…/btn-magicwand.png){.control-btn} Magic wand{.control-name}
//
// The leading {.class} marker on the CELL appeared later than this parser, and
// the icon/label markers came with it — so the parser must strip all three:
// a cell that starts with a marker used to fall through to "no image" and the
// whole line, picture and braces included, landed in the entry's name (the
// landing then rendered an empty src and shipped no icons at all).
function splitIcon(cell) {
  let text = String(cell).trim();
  // 1. the cell's own class marker
  text = text.replace(/^\{\.[a-z-. ]+\}\s*/, "");
  // 2. the icon, with its own {.class} marker
  const m = /^!\[([^\]]*)\]\(([^)]+)\)(?:\{\.[a-z-. ]+\})?\s*(.*)$/.exec(text);
  if (!m) return { image: "", text: text.trim() };
  // 3. the label's {.class} marker
  const label = m[3].replace(/\{\.[a-z-. ]+\}\s*$/, "").trim();
  return { image: m[2], text: label };
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

// The page chrome is NOT rebuilt from Markdown: each manual page has a hero
// block, two stylesheets and ~200 lines of page-local CSS that the source does
// not describe and should not start describing. Those parts are kept verbatim
// in tools/manual-template-head.html / -tail.html, sliced out of the live page,
// so regenerating the manual retains its exact look. Only the table of
// contents and the section bodies are generated.
//
// That chrome carries {{TOKENS}} because there are two manual pages now, one
// per language: the markup and the CSS are shared, the strings are not. A
// second head file would have duplicated all of it and the two copies would
// drift, so the translated strings live here and the template stays the single
// copy of the page.
const CHROME = {
  en: {
    lang: "en",
    title: "yaPDP — User Manual",
    description: "yaPDP — Yet Another PDP‑11/70 Emulator. A step-by-step user manual: quick boot, front panel, Model 33 ASR teletype console, VT52 and VT100 video terminals, LP11 line printer, storage, configuration and guest operating systems.",
    keywords: "yaPDP,PDP,PDP-11,11/70,JavaScript,Emulator,Teletype,Model 33,VT52,VT100,DECscope,ANSI,RT-11,RSX-11M,RSTS,BSD,Unix,manual,user guide",
    heroTitle: "yaPDP — User Manual",
    heroTagline: "Welcome to the machine. This guide walks you through every page of the emulator —\n" +
      "                    from the very first boot to the deepest configuration options — so you can spend your time in\n" +
      "                    the machine room, not in the documentation.",
    heroNote: "Everything below applies to both the browser version and the Tauri desktop app.",
    btnLaunch: "Launch Online!",
    btnHome: "Back to the Home Page",
    homeHref: "index.html",
    // The manual sits at the site root, so the post list is one hop down.
    btnPosts: "All posts",
    postsHref: "devlog/index.html",
    altHref: "manual_ru.html",
    altLabel: "Русская версия",
    langSwitchTitle: "Switch language",
    toc: "Table of Contents",
  },
  ru: {
    lang: "ru",
    title: "yaPDP — Руководство пользователя",
    description: "yaPDP — Yet Another PDP‑11/70 Emulator. Пошаговое руководство пользователя: быстрый запуск, пультовая панель, телетайп Model 33 ASR, видеотерминалы VT52 и VT100, построчный принтер LP11, работа с образами, конфигурация и гостевые операционные системы.",
    keywords: "yaPDP,PDP,PDP-11,11/70,эмулятор,телетайп,Model 33,VT52,VT100,DECscope,RT-11,RSX-11M,RSTS,BSD,Unix,руководство пользователя,мануал",
    heroTitle: "yaPDP — Руководство пользователя",
    heroTagline: "Добро пожаловать в машинный зал. Это руководство проведёт вас по каждой странице эмулятора —\n" +
      "                    от первого запуска до самых глубоких настроек, — чтобы вы проводили время за машиной, а не\n" +
      "                    за чтением документации.",
    heroNote: "Всё описанное ниже относится и к версии в браузере, и к настольному приложению на Tauri.",
    btnLaunch: "Запустить онлайн!",
    btnHome: "На главную страницу",
    homeHref: "index.html",
    btnPosts: "Все посты",
    postsHref: "devlog/index.html",
    altHref: "manual.html",
    altLabel: "English version",
    langSwitchTitle: "Переключить язык",
    toc: "Оглавление",
  },
};

// The pages themselves. The section text is picked by field name, so nothing
// below knows how a section is shaped — only where its title and its body live.
const PAGES = [
  { lang: "en", out: OUT_HTML, titleField: "titleEn", bodyField: "blocksEn" },
  { lang: "ru", out: OUT_HTML_RU, titleField: "titleRu", bodyField: "blocksRu" },
];

// Fills the template's {{TOKEN}}s from the page's CHROME entry. An unknown token
// is an error rather than an empty string: a typo in the template would
// otherwise silently drop a piece of the page.
function fillChrome(template, page) {
  const c = CHROME[page.lang];
  if (!c) throw new Error("no chrome strings for language: " + page.lang);
  // The button row is built here, from a list of destinations, exactly as the
  // devlog does it (see navButtons in tools/build-devlog.js). The manual used
  // to fill three anchor slots in the template instead, which is why it drifted
  // from the devlog: same page, same chrome, two mechanisms. The language
  // switch stays a button in this row — it is a destination like the rest.
  // The language switch is not a button in this row: it is the landing page's
  // EN / RU control, with the active language highlighted and the other one a
  // link. Two labels for one destination ("Русская версия" / "English version")
  // told the reader which languages exist but not which one they were reading;
  // the landing page answers both questions at a glance, so the manual does the
  // same. The row is otherwise the same destinations in the same order as every
  // other page.
  const nav = [
    ["btn-primary", "pdp11.html", c.btnLaunch],
    ["btn-secondary", c.postsHref, c.btnPosts],
    ["btn-secondary", c.homeHref, c.btnHome],
  ]
    .filter(([, href, label]) => href && label)
    .map(([cls, href, label]) =>
      '                    <a class="' + cls + '" href="' + href + '">' + label + "</a>")
    .concat([langSwitch(c)])
    .join("\n");
  const vars = {
    LANG: c.lang, TITLE: c.title, DESCRIPTION: c.description, KEYWORDS: c.keywords,
    HERO_TITLE: c.heroTitle, HERO_TAGLINE: c.heroTagline, HERO_NOTE: c.heroNote,
    NAV_BUTTONS: nav,
    // The template carries one placeholder for a contents list and the manual
    // builds its own list of sections further down (buildHtml), so the token is
    // blank here rather than unknown. It must be declared: an undeclared token
    // is a hard error, which is how a renamed placeholder gets caught.
    TOC: "",
  };
  const filled = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m);
  const unknown = filled.match(/\{\{[^}]*\}\}/);
  if (unknown) throw new Error("unknown chrome token in the page template: " + unknown[0]);
  return filled;
}

// The anchor ids of a block list's headings — used to hand the Russian page the
// English ids (slug() cannot slug Cyrillic: see blocksToHtml).
function headingIds(blocks) {
  return blocks.filter((b) => b.type === "h").map((b) => slug(b.text));
}

function langSwitch(c) {
  // The landing page's control, in the same markup: a bordered pill, the active
  // language in gold and bold, the other one a link to the other manual. The
  // page knows its own language (c.lang), so the active half is a <span> and the
  // inactive half an <a> — nothing is clickable that would not move the reader.
  const en = c.lang === "en"
    ? '<span class="lang-active">EN</span>'
    : '<a href="manual.html">EN</a>';
  const ru = c.lang === "ru"
    ? '<span class="lang-active">RU</span>'
    : '<a href="manual_ru.html">RU</a>';
  return '                    <span class="lang-switch" title="' + c.langSwitchTitle +
    '">' + en + '<span class="lang-sep">/</span>' + ru + "</span>";
}

function buildHtml(sections, page) {
  const headFile = path.join(__dirname, "manual-template-head.html");
  const tailFile = path.join(__dirname, "manual-template-tail.html");
  if (!fs.existsSync(headFile) || !fs.existsSync(tailFile)) {
    throw new Error("missing page template: expected tools/manual-template-head.html " +
      "and tools/manual-template-tail.html (sliced from the live manual.html)");
  }
  // The template's own trailing whitespace is not part of the contract: the
  // join below adds it, so a template re-saved by an editor that trims the
  // final newline cannot glue the table of contents onto the hero separator.
  const head = fillChrome(fs.readFileSync(headFile, "utf8"), page).replace(/\s+$/, "");
  const tail = fs.readFileSync(tailFile, "utf8");

  const toc = sections.map((s) =>
    "                <li><a href=\"#" + s.id + "\">" + inline(s[page.titleField]) +
    "</a></li>").join("\n");
  const bodies = sections.map((s) =>
    '            <h2 id="' + s.id + '">' + inline(s[page.titleField]) + "</h2>\n\n" +
    blocksToHtml(s[page.bodyField], 2,
      page.lang === "en" ? null : headingIds(s.blocksEn).slice())
      .replace(/^ {2}/gm, "            ")).join("\n\n");

  return head + "\n\n            <h2>" + CHROME[page.lang].toc + "</h2>\n\n            <ol>\n" +
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
  // Cells in these tables carry their own {.class} markers (the stylesheet
  // styles the first column). Strip them here: the marker is page decoration
  // and must never reach the data the landing renders.
  const bare = (cell) => String(cell || "").replace(/\{\.[a-z-. ]+\}/g, "").trim();

  // The TS output is DATA for React, which renders it as plain text — so
  // Markdown syntax has to come off: a link showed up in the landing as
  // "See [Quick Start](#quick-start)." with the brackets intact. The visible
  // words stay, the syntax does not.
  const plain = (text) => String(text || "")
    .replace(/\[([^\]]+)\]\(#[a-z0-9-]+\)/g, "$1")   // [text](#anchor) -> text
    .replace(/`([^`]+)`/g, "$1")                          // `code` -> code
    .replace(/\*\*([^*]+)\*\*/g, "$1")                // **bold** -> bold
    .replace(/\*([^*]+)\*/g, "$1")                      // *italic* -> italic
    .trim();

  const GUEST_OS_TABLE = guestEn.slice(1).map((row, i) => {
    const ruRow = guestRu[i + 1] || [];
    const entry = {
      disk: bare(row[0]),
      name: bare(row[1]),
      bootCommand: bare(row[2]),
      instructionsEn: bare(row[3]),
      instructionsRu: bare(ruRow[3]),
    };
    // An optional fifth column carries the login credentials, where the guest
    // has a documented one. Kept out of the table when empty rather than
    // emitted as '', so the landing's `credentials?: string` keeps its meaning.
    if (bare(row[4])) entry.credentials = bare(row[4]);
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
      nameEn: plain(en0.text), nameRu: plain(ru0.text),
      whereEn: plain(row[1]), whereRu: plain(ruRow[1]),
      descEn: plain(row[2]), descRu: plain(ruRow[2]),
    };
  });

  const CONFIG_TABS_DATA = configTabs(secById["config"].blocksEn, secById["config"].blocksRu);

  return {
    html: buildHtml(sections, PAGES[0]),
    htmlRu: buildHtml(sections, PAGES[1]),
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

  const { html, htmlRu, ts, sections } = out;
  const missing = sections.filter((s) => !s.titleRu || !s.blocksRu.length)
    .map((s) => s.id);
  if (missing.length) {
    console.error("build-manual: no Russian translation for: " + missing.join(", "));
    process.exit(1);
  }

  // The three outputs, listed once: --check, --write and the review run all walk
  // this list, so a new output cannot be forgotten by one of the three modes.
  const targets = [
    { file: OUT_HTML, content: html },
    { file: OUT_HTML_RU, content: htmlRu },
    { file: OUT_TS, content: ts },
  ];
  const names = (suffix) => targets.map((t) => path.basename(t.file) + (suffix || ""));

  if (check) {
    const drift = targets.filter((t) =>
      !fs.existsSync(t.file) || fs.readFileSync(t.file, "utf8") !== t.content)
      .map((t) => path.basename(t.file));
    if (drift.length) {
      console.error("build-manual: generated output differs from " + drift.join(" and ") +
        " — run `npm run manual:build`");
      process.exit(1);
    }
    console.log("build-manual: " + sections.length + " sections, output in sync (" +
      names().join(", ") + ")");
    return;
  }

  if (write) {
    for (const t of targets) fs.writeFileSync(t.file, t.content);
    console.log("build-manual: wrote " + names().join(", ") +
      " (" + sections.length + " sections)");
    return;
  }

  for (const t of targets) fs.writeFileSync(t.file + ".generated", t.content);
  console.log("build-manual: wrote " + names(".generated").join(", ") +
    " (" + sections.length + " sections, " + html.length + " + " + htmlRu.length +
    " + " + ts.length + " bytes)");
  console.log("  review them, then run with --write to replace the live files");
}

if (require.main === module) main();

module.exports = { parseBlocks, inline, slug, generate };
