#!/usr/bin/env node
/**
 * yaPDP — devlog generator.
 *
 * The devlog is the project's story: long-form posts written for readers who
 * arrive from Hacker News, r/retropc or a search engine, not from the sidebar.
 * Those readers want a plain page that renders without JavaScript — a blog post
 * inside a React bundle would show them a blank screen — so every post is a
 * static HTML file, styled with the SAME chrome as the user manual
 * (tools/manual-template-head.html), which is itself the landing page's look.
 *
 *   docs/devlog/<date>-<slug>.md ─┬─→ devlog/<date>-<slug>.html   (one page per post)
 *                                 ├─→ devlog/index.html           (list, newest first)
 *                                 └─→ devlog/feed.xml             (Atom feed)
 *
 * Source format: Markdown with a small front-matter block.
 *
 *   ---
 *   title: "..."
 *   date: 2026-09-23
 *   lang: en
 *   summary: "..."        # one or two sentences for the list and the feed
 *   ---
 *   ...body...
 *
 * Design choices worth knowing:
 *
 *   - No Markdown dependency, same as the manual: the body uses a deliberately
 *     small subset (headings, paragraphs, lists, block quotes, fenced code,
 *     images, links, inline code, bold, italic) and that subset is all this
 *     converter understands. The manual and the devlog share the same inline
 *     and block conventions (including the {.class} markers), so a post can be
 *     moved between them without rewriting anything.
 *
 *   - Order comes from the DATE, not from a list in a file: the newest post is
 *     always first, and a post cannot be published without a date. This is the
 *     opposite of docs/manual/_meta.yml, where the order IS the numbering.
 *
 *   - Targets are written to <name>.generated.<ext> unless --write is passed,
 *     so a reviewer can look at the output before it replaces anything.
 *
 * Usage:
 *   node tools/build-devlog.js            # write *.generated.* next to targets
 *   node tools/build-devlog.js --write    # write the real targets
 *   node tools/build-devlog.js --check    # exit non-zero if the real targets
 *                                         # are not what the source would emit
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "docs", "devlog");
const OUT_DIR = path.join(ROOT, "devlog");
const OUT_INDEX = path.join(OUT_DIR, "index.html");
const OUT_FEED = path.join(OUT_DIR, "feed.xml");
const TEMPLATE_HEAD = path.join(__dirname, "manual-template-head.html");
const TEMPLATE_TAIL = path.join(__dirname, "manual-template-tail.html");

const SITE = "https://amesk.github.io/yaPDP";

// --- front-matter -----------------------------------------------------------

// The three fields a post cannot do without, plus the summary used by the list
// and the feed. Deliberately tiny: a devlog post is a date, a title and text.
function parseFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) throw new Error("missing front-matter block (--- ... ---)");
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    // strip matching single or double quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[kv[1]] = value;
  }
  return { meta, body: text.slice(m[0].length) };
}

function postFiles() {
  if (!fs.existsSync(SRC)) return [];
  return fs.readdirSync(SRC)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

function loadPost(file) {
  const raw = fs.readFileSync(path.join(SRC, file), "utf8");
  const { meta, body } = parseFrontMatter(raw);
  const slug = file.replace(/\.md$/, "");
  const dateMatch = /^(\d{4}-\d{2}-\d{2})-/.exec(slug);
  if (!meta.date && !dateMatch) {
    throw new Error(file + ": no date (front-matter or YYYY-MM-DD- filename prefix)");
  }
  const date = meta.date || dateMatch[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(file + ": date must be YYYY-MM-DD, got " + JSON.stringify(date));
  }
  if (!meta.title) throw new Error(file + ": no title in front-matter");
  return {
    file,
    slug,
    date,
    lang: meta.lang || "en",
    title: meta.title,
    summary: meta.summary || "",
    blocks: parseBlocks(body),
    body,
  };
}

// --- the Markdown subset (shared with the manual) ---------------------------

function inline(text) {
  return String(text)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)(\{\.[a-z-. ]+\})?/g,
      (m, alt, src, cls) => {
        const c = cls ? cls.slice(2, -1).trim() : "shot";
        return '<img class="' + c + '" src="' + src + '" alt="' + alt + '">';
      })
    .replace(/(^|>)([^{}<>]+)\{\.([a-z-]+)\}/g,
      (m, pre, text, cls) => pre + '<span class="' + cls + '">' + text.trim() + "</span>")
    .replace(/\[([^\]]+)\]\(#([a-z0-9-]+)\)/g,
      (m, text, anchor) => '<a href="#' + anchor + '">' + text + '</a>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g,
      (m, text, href) => '<a href="' + href + '">' + text + '</a>')
    .replace(/`([^`]+)`/g, (m, code) => "<code>" + code + "</code>")
    .replace(/\*\*([^*]+)\*\*/g, (m, b) => "<strong>" + b + "</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, (m, pre, i) => pre + "<em>" + i + "</em>");
}

function parseBlocks(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  let list = null;
  let fence = null;

  const flushPara = () => {
    if (para.length) { blocks.push({ type: "p", text: para.join(" ").trim() }); para = []; }
  };
  const flushList = () => {
    if (list) { blocks.push({ type: list.kind, items: list.items }); list = null; }
  };
  const flushAll = () => { flushPara(); flushList(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (!line.trim()) { flushAll(); continue; }
    if (/^<!--[\s\S]*-->$/.test(line.trim())) continue;

    if (/^```/.test(line.trim())) {
      if (fence === null) { flushAll(); fence = []; }
      else { blocks.push({ type: "pre", text: fence.join("\n") }); fence = null; }
      continue;
    }
    if (fence !== null) { fence.push(raw.replace(/\s+$/, "")); continue; }

    const h = /^(#{2,6})\s+(.*)$/.exec(line);
    if (h) {
      flushAll();
      blocks.push({ type: "h", level: h[1].length, text: h[2].trim() });
      continue;
    }

    const img = /^!\[([^\]]*)\]\(([^)]+)\)(\{\.[a-z-. ]+\})?$/.exec(line.trim());
    if (img) {
      flushAll();
      blocks.push({ type: "img", alt: img[1], src: img[2],
        cls: img[3] ? img[3].slice(2, -1) : "shot" });
      continue;
    }

    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      flushAll();
      blocks.push({ type: "blockquote", text: bq[1].trim() });
      continue;
    }

    const li = /^[-*]\s+(.*)$/.exec(line);
    const oli = /^\d+[.)]\s+(.*)$/.exec(line);
    if (li || oli) {
      flushPara();
      const kind = oli ? "ol" : "ul";
      if (!list || list.kind !== kind) { flushList(); list = { kind: kind, items: [] }; }
      list.items.push((oli ? oli[1] : li[1]).trim());
      continue;
    }

    para.push(line.trim());
  }
  if (fence !== null) throw new Error("unterminated ``` code block");
  flushAll();
  return blocks;
}

function slug(text) {
  return String(text).toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim().replace(/\s+/g, "-");
}

function blocksToHtml(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case "h": {
        const tag = "h" + Math.min(6, b.level);
        out.push("  <" + tag + ' id="' + slug(b.text) + '">' + inline(b.text) +
          "</" + tag + ">");
        break;
      }
      case "p": {
        const m = /^(.*)\{\.([a-z-]+)\}$/.exec(b.text);
        const cls = m ? m[2] : "";
        out.push("  <p" + (cls ? ' class="' + cls + '"' : "") + ">" +
          inline(m ? m[1] : b.text) + "</p>");
        break;
      }
      case "img":
        out.push('  <p><img class="' + (b.cls || "shot") + '" src="' + b.src +
          '" alt="' + inline(b.alt) + '"></p>');
        break;
      case "ul":
      case "ol":
        out.push("  <" + b.type + ">");
        for (const it of b.items) out.push("    <li>" + inline(it) + "</li>");
        out.push("  </" + b.type + ">");
        break;
      case "blockquote":
        out.push("  <blockquote>" + inline(b.text) + "</blockquote>");
        break;
      case "pre":
        out.push("  <pre>" + b.text + "</pre>");
        break;
    }
    out.push("");
  }
  return out.join("\n");
}

// --- page chrome ------------------------------------------------------------

// The manual's template carries the hero and the page-local CSS. The devlog
// reuses it so a post looks like the rest of the site, and only the tokens it
// already knows are supplied. A token the manual has but a post has no use for
// (the contents list, the "previous" button) gets a sensible devlog string.
function chromeFor(post) {
  return {
    LANG: post.lang,
    TITLE: post.title + " — yaPDP devlog",
    DESCRIPTION: post.summary || post.title,
    KEYWORDS: "yaPDP,PDP,PDP-11,11/70,JavaScript,Emulator,devlog,retrocomputing,SM-4,SM-1420",
    HERO_TITLE: post.title,
    HERO_TAGLINE: post.summary || "",
    HERO_NOTE: "",
    BTN_LAUNCH: "Launch the emulator!",
    BTN_HOME: "All posts",
    ALT_HREF: "index.html",
    ALT_LABEL: "Devlog index",
    TOC: "",
    DATE: post.date,
  };
}

function renderPage(page, body, chrome) {
  let head = fs.readFileSync(TEMPLATE_HEAD, "utf8")
    .replace(/\{\{([A-Z_]+)\}\}/g, (m, key) =>
      Object.prototype.hasOwnProperty.call(chrome, key) ? chrome[key] : "")
    .replace(/\s+$/, "");
  // The manual's template carries the alternate-language link in TWO places (a
  // button in the hero and one in the closing block). A devlog post has a single
  // "All posts" button, so the second copy would render the same link twice.
  // The duplicate is dropped here rather than by editing the shared template.
  const dup = '<a class="btn-secondary" href="' + chrome.ALT_HREF + '">' +
    chrome.ALT_LABEL + "</a>";
  const first = head.indexOf(dup);
  if (first !== -1) {
    const second = head.indexOf(dup, first + dup.length);
    if (second !== -1) {
      head = head.slice(0, second) +
        '<a class="btn-secondary" href="../manual.html">User manual</a>' +
        head.slice(second + dup.length);
    }
  }
  const tail = fs.readFileSync(TEMPLATE_TAIL, "utf8");
  return head + "\n" + body + "\n" + tail + "\n";
}

function renderPost(post) {
  const chrome = chromeFor(post);
  chrome.ALT_HREF = "index.html";
  chrome.ALT_LABEL = "All posts";
  const meta = '            <p class="shot-caption">' + post.date + "</p>";
  let html = renderPage(post, "\n" + blocksToHtml(post.blocks) + "\n" + meta + "\n", chrome);
  // The post lives in devlog/, so every root-relative link needs one level up —
  // otherwise the hero buttons point at devlog/pdp11.html, which does not exist.
  html = html.replace(/href="(pdp11\.html|index\.html|manual\.html|manual_ru\.html)"/g,
    'href="../$1"');
  // inside the post body, the stylesheet and asset paths are root-relative too
  html = html.replace(/href="css\//g, 'href="../css/')
    .replace(/src="assets\//g, 'src="../assets/');
  return html;
}

// The index is one file with a list, newest first. No client-side filtering:
// a reader from a search engine may not run scripts at all.
function renderIndex(posts) {
  const items = posts.map((p) =>
    '            <h2><a href="' + p.slug + '.html">' + inline(p.title) + "</a></h2>\n" +
    '            <p class="shot-caption">' + p.date + "</p>\n" +
    "            <p>" + inline(p.summary || "") + "</p>").join("\n\n");
  const chrome = {
    LANG: "en",
    TITLE: "yaPDP devlog — building a PDP-11/70 in the browser",
    DESCRIPTION: "Notes from building yaPDP, a PDP-11/70 emulator with a Model 33 ASR teletype, " +
      "VT52/VT100 terminals and an SM-4 in mind.",
    KEYWORDS: "yaPDP,PDP,PDP-11,devlog,retrocomputing,emulator,SM-4,teletype,paper tape",
    HERO_TITLE: "yaPDP devlog",
    HERO_TAGLINE: "Notes from building a PDP-11/70 emulator in the browser — the machine room, " +
      "the teletype, the paper tape, and the Soviet SM-4 I am really after.",
    HERO_NOTE: "Newest first. There is also a feed: <a href=\"feed.xml\">feed.xml</a>.",
    BTN_LAUNCH: "Launch the emulator!",
    BTN_HOME: "User manual",
    ALT_HREF: "manual.html",
    ALT_LABEL: "User manual",
    TOC: "",
    DATE: posts.length ? posts[0].date : "",
  };
  const body = "\n" + items + "\n";
  let html = renderPage(null, body, chrome);
  // the index lives in devlog/, so the manual and feed links need one level up
  html = html.replace('href="manual.html"', 'href="../manual.html"')
    .replace('href="index.html"', 'href="../index.html"')
    .replace('href="pdp11.html"', 'href="../pdp11.html"');
  return html;
}

// Atom, not RSS: one format, well specified, and every reader eats it.
function renderFeed(posts) {
  const updated = posts.length ? posts[0].date + "T00:00:00Z" : "1970-01-01T00:00:00Z";
  const entries = posts.map((p) =>
    "  <entry>\n" +
    "    <title>" + escapeXml(p.title) + "</title>\n" +
    '    <link href="' + SITE + "/devlog/" + p.slug + '.html"/>\n' +
    '    <id>' + SITE + "/devlog/" + p.slug + ".html</id>\n" +
    "    <updated>" + p.date + "T00:00:00Z</updated>\n" +
    "    <summary>" + escapeXml(p.summary) + "</summary>\n" +
    "  </entry>").join("\n");
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<feed xmlns="http://www.w3.org/2005/Atom">\n' +
    "  <title>yaPDP devlog</title>\n" +
    '  <link href="' + SITE + '/devlog/feed.xml" rel="self"/>\n' +
    '  <link href="' + SITE + '/devlog/"/>\n' +
    "  <id>" + SITE + "/devlog/</id>\n" +
    "  <updated>" + updated + "</updated>\n" +
    entries + "\n</feed>\n";
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- main -------------------------------------------------------------------

function generate() {
  const posts = postFiles().map(loadPost)
    // newest first; a tie is broken by the slug so the order is stable
    .sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug)
      : (a.date < b.date ? 1 : -1)));
  if (!posts.length) throw new Error("no posts found in docs/devlog/");
  return {
    posts,
    pages: posts.map((p) => ({ slug: p.slug, html: renderPost(p) })),
    index: renderIndex(posts),
    feed: renderFeed(posts),
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
    console.error("build-devlog: " + err.message);
    process.exit(1);
  }

  const targets = [
    { path: OUT_INDEX, content: out.index },
    { path: OUT_FEED, content: out.feed },
  ].concat(out.pages.map((p) => ({
    path: path.join(OUT_DIR, p.slug + ".html"), content: p.html })));

  if (check) {
    const drift = [];
    for (const t of targets) {
      const cur = fs.existsSync(t.path) ? fs.readFileSync(t.path, "utf8") : "";
      if (cur !== t.content) drift.push(path.relative(ROOT, t.path));
    }
    if (drift.length) {
      console.error("build-devlog: generated output differs from " +
        drift.join(", ") + " — run `npm run devlog:build`");
      process.exit(1);
    }
    console.log("build-devlog: " + out.posts.length + " post(s), output in sync");
    return;
  }

  const suffix = write ? "" : ".generated";
  for (const t of targets) {
    fs.writeFileSync(t.path + suffix, t.content);
  }
  console.log("build-devlog: wrote " + targets.length + " file(s)" +
    (write ? "" : " as *.generated") + " (" + out.posts.length + " post(s))");
  if (!write) console.log("  review them, then run with --write to replace the live files");
}

if (require.main === module) main();

module.exports = { parseFrontMatter, parseBlocks, inline, renderFeed, generate };
