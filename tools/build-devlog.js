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
const OUT_TS = path.join(ROOT, "landing", "src", "data", "devlogData.ts");
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

// A group of images shown side by side: the historical photograph next to the
// emulator's own rendering of the same machine. The point of a group is not
// that two pictures resemble each other — it is that the emulator was drawn
// FROM the photograph, so the outline is the same outline. The frames therefore
// keep their own proportions: a cut-out machine and a machine in its cabinet
// are crops of different scope, and forcing them to one ratio would silently
// crop the cabinet away.
//
// Source syntax (MUST be flush-left, one image per line):
//
//   :::pair
//   ![photo](assets/images/devlog/pairs/vt52-original.jpg){.shot}
//   ![emulator](assets/images/manual/console-vt52.png){.shot}
//   :::captions
//   The photograph, 1975
//   The same machine, in yaPDP
//   :::
//
// The colon count of every marker must line up (here three), so a group can
// never be closed by a marker that belongs to a different level. The captions
// block is optional; without it the group is just a row of images.
function parseGroup(lines, start) {
  const open = /^(:{2,})\s*(pair|row)\s*$/.exec(lines[start]);
  const fence = open[1];
  const kind = open[2];
  const images = [];
  let captions = null;
  let hi = start + 1;
  for (; hi < lines.length; hi++) {
    const line = lines[hi].trim();
    if (line === fence) break;                       // --- end of the group
    if (/^[:]{2,}\s*captions\s*$/.test(line)) {
      captions = [];
      for (hi++; hi < lines.length; hi++) {
        const cap = lines[hi].trim();
        if (cap === fence || cap === ":::") break;
        if (cap) captions.push(cap);
      }
      break;
    }
    const img = /^!\[([^\]]*)\]\(([^)]+)\)(\{\.[a-z-. ]+\})?$/.exec(line);
    if (img) {
      images.push({ alt: img[1], src: img[2],
        cls: img[3] ? img[3].slice(2, -1) : "shot" });
      continue;
    }
    throw new Error("group line " + (hi + 1) + ": expected an image, got " +
      JSON.stringify(lines[hi]));
  }
  if (hi >= lines.length) throw new Error("unterminated " + fence + kind + " group");
  if (images.length < 2) {
    throw new Error("a " + kind + " needs at least two images, got " + images.length);
  }
  if (captions && captions.length !== images.length) {
    throw new Error("" + kind + " has " + images.length + " image(s) but " +
      captions.length + " caption(s) — they must match one for one");
  }
  return { block: { type: "group", kind: kind, images: images, captions: captions },
    next: hi + 1 };
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

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");

    if (!line.trim()) { flushAll(); continue; }
    if (/^<!--[\s\S]*-->$/.test(line.trim())) continue;

    if (/^(:{2,})\s*(pair|row)\s*$/.test(line.trim())) {
      flushAll();
      const g = parseGroup(lines, i);
      blocks.push(g.block);
      i = g.next - 1;
      continue;
    }

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
      case "group": {
        // One row of frames that belong together. Each frame keeps its own
        // proportions (see parseGroup), and each may carry its own caption
        // directly under it, which is how a reader tells the photograph from
        // the rendering without counting places in a shared caption.
        out.push('  <div class="' + b.kind + '">');
        for (let i = 0; i < b.images.length; i++) {
          const im = b.images[i];
          out.push('    <figure>');
          out.push('      <img class="' + im.cls + '" src="' + im.src +
            '" alt="' + inline(im.alt) + '">');
          if (b.captions) {
            out.push('      <figcaption class="shot-caption">' +
              inline(b.captions[i]) + '</figcaption>');
          }
          out.push('    </figure>');
        }
        out.push('  </div>');
        break;
      }
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
    // A post is a static page: it works without JavaScript, and a reader who
    // arrives from a search engine or Hacker News gets the text, not a blank
    // screen. Its "All posts" therefore leads to the landing page's devlog
    // section, which is where a reader inside the site expects to land — the
    // standalone devlog/index.html stays as the no-JavaScript list (the footer
    // link below), not as the primary destination.
    BTN_HOME: "All posts",
    HOME_HREF: "../#devlog",
    ALT_HREF: "../manual.html",
    ALT_LABEL: "User manual",
    TOC: "",
    DATE: post.date,
  };
}

function renderPage(page, body, chrome) {
  let head = fs.readFileSync(TEMPLATE_HEAD, "utf8")
    .replace(/\{\{([A-Z_]+)\}\}/g, (m, key) =>
      Object.prototype.hasOwnProperty.call(chrome, key) ? chrome[key] : "")
    .replace(/\s+$/, "");
  const tail = fs.readFileSync(TEMPLATE_TAIL, "utf8");
  return head + "\n" + body + "\n" + tail + "\n";
}

function renderPost(post) {
  // No ALT_* override here: chromeFor already supplies the two secondary
  // buttons for a post ("All posts", then the manual). Overriding them after
  // the fact rendered "All posts" twice — the button map belongs in one place.
  const chrome = chromeFor(post);
  // The date line, plus the no-JavaScript way to the list. The button above
  // leads to the landing page's devlog section, which needs the SPA bundle; a
  // reader who has scripts off (or is a robot) still needs a plain list, and
  // that is the standalone index this link points at.
  const meta = '            <p class="shot-caption">' + post.date +
    ' — <a href="index.html">all posts as a plain list</a></p>';
  let html = renderPage(post, "\n" + blocksToHtml(post.blocks) + "\n" + meta + "\n", chrome);
  // The post lives in devlog/, so every root-relative link needs one level up —
  // otherwise the hero buttons point at devlog/pdp11.html, which does not exist.
  //
  // Everything climbs one level — except index.html, which is a trap: in the
  // manual's template that name means the landing page, but a post's "All posts"
  // must reach the devlog index, and from inside devlog/ that is plain
  // index.html. Climbing sent the reader to the landing page instead: the button
  // said "All posts" and did something else. So index.html is restored after the
  // other links climb, and the chrome above already points everything else at
  // ../ explicitly.
  html = html.replace(/href="(pdp11\.html|manual\.html|manual_ru\.html)"/g,
    'href="../$1"')
    .replace(/href="\.\.\/index\.html"/g, 'href="index.html"');
  // inside the post body, the stylesheet and asset paths are root-relative too
  html = html.replace(/href="css\//g, 'href="../css/')
    .replace(/src="assets\//g, 'src="../assets/')
    // The favicon is named without a directory in the shared template, so a
    // post at devlog/<slug>.html asks for devlog/favicon.ico, which does not
    // exist. It has to climb one level like the stylesheet and the assets.
    .replace(/href="favicon\.ico"/g, 'href="../favicon.ico"')
    // The page-local CSS names the machine-room backdrop with a relative url(),
    // and that is neither href nor src: a post asked for
    // devlog/assets/images/pdp11-machine-room.jpg and lost the backdrop
    // entirely. Every relative url() in the template climbs with the rest.
    .replace(/url\("assets\//g, 'url("../assets/');
    // ...but the pair/row figures and the viewer use url-free rules, so nothing
    // else here needs the same treatment. If the template gains a url() that is
    // not under assets/, this replace will not cover it — add it here. 
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
    // On the index itself "All posts" would be a link to this very page, so the
    // manual takes that slot and the second button (the template's duplicate)
    // carries the emulator. The second button used to repeat "User manual" with
    // a wrong href: only the path had been rewritten, not the label.
    BTN_HOME: "User manual",
    HOME_HREF: "../manual.html",
    ALT_HREF: "../pdp11.html",
    ALT_LABEL: "Launch the emulator!",
    TOC: "",
    DATE: posts.length ? posts[0].date : "",
  };
  const body = "\n" + items + "\n";
  let html = renderPage(null, body, chrome);
  // The index lives in devlog/, so links to the rest of the site climb a level.
  // index.html is deliberately NOT touched: on this page that name is the page
  // itself, and rewriting it sent "User manual" to the landing page.
  html = html.replace(/href="(manual\.html|manual_ru\.html|pdp11\.html)"/g,
    'href="../$1"')
    // the favicon is named without a directory, so it needs the same climb
    .replace('href="favicon.ico"', 'href="../favicon.ico"')
    // ...and so does the machine-room backdrop named inside the page CSS
    .replace('url("assets/', 'url("../assets/');
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

// The landing shows the devlog as its own section (a list of posts), while the
// posts themselves stay static pages: a reader from a search engine must get
// text, not a React bundle, and the section must not duplicate the text.
// So the landing gets DATA — title, date, summary and the URL of the page.
function renderTs(posts) {
  const items = posts.map((p) => [
    "  {",
    "    slug: " + tsString(p.slug) + ",",
    "    date: " + tsString(p.date) + ",",
    "    title: " + tsString(p.title) + ",",
    "    summary: " + tsString(p.summary) + ",",
    "  },",
  ].join("\n")).join("\n");

  return [
    "// GENERATED by tools/build-devlog.js from docs/devlog/*.md — do not edit.",
    "// The devlog source is Markdown; the posts are static pages, and this file",
    "// is only the landing's list of them.",
    "",
    "export interface DevlogPost {",
    "  slug: string;",
    "  date: string;",
    "  title: string;",
    "  summary: string;",
    "}",
    "",
    "export const DEVLOG_POSTS: DevlogPost[] = [",
    items,
    "];",
    "",
  ].join("\n");
}

function tsString(s) {
  return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, " ") + "'";
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
    ts: renderTs(posts),
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
    { path: OUT_TS, content: out.ts },
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
