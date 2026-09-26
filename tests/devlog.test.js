#!/usr/bin/env node
/**
 * Devlog generation guard.
 *
 * docs/devlog/*.md is the source for the project's long-form posts, and
 * tools/build-devlog.js turns each one into a static page plus the index and
 * the Atom feed. Regenerating must keep the post readable by someone who
 * arrived from a search engine or a link aggregator — which is exactly the
 * reader who gets a blank screen if a post silently depends on something that
 * is not there.
 *
 * The failures this pins, all of them cheap to introduce and easy to miss:
 *
 *   1. a post without a date, a title, or a summary — the index and the feed
 *      both need them;
 *   2. an image the post names but that does not exist on disk (the post then
 *      ships with a broken picture);
 *   3. a root-relative link inside a post — the pages live one level down in
 *      devlog/, so "pdp11.html" resolves to devlog/pdp11.html and 404s. The
 *      hero buttons had exactly this defect on the first build;
 *   4. a page missing what the landing page carries (check 3b below);
 *   5. a generator marker ({.class}, :::) leaking into a published page;
 *   6. the feed not listing every post, or listing them out of date order.
 *
 * The pages, the index and the feed are generated in memory: devlog/ is a build
 * product (not committed — see .gitignore), so every check runs against exactly
 * what the Pages deploy publishes.
 *
 * Run with:  node tests/devlog.test.js
 *
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "docs", "devlog");
const { parseFrontMatter, generate } = require("../tools/build-devlog.js");

function postFiles() {
  return fs.readdirSync(SRC).filter((f) => f.endsWith(".md")).sort();
}

function run() {
  const files = postFiles();
  assert.ok(files.length > 0, "docs/devlog/ has no posts");

  // Built here, not read from disk: devlog/ is a build product, so the guard is
  // on what the generator produces — which is what the deploy publishes.
  const built = generate();
  const pageBySlug = {};
  for (const page of built.pages) pageBySlug[page.slug] = page.html;

  // --- 1. every post has what the index and the feed need -------------------
  const posts = files.map((f) => {
    const raw = fs.readFileSync(path.join(SRC, f), "utf8");
    const { meta } = parseFrontMatter(raw);
    assert.ok(meta.title, f + ": missing title");
    assert.ok(meta.date, f + ": missing date");
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(meta.date),
      f + ": date must be YYYY-MM-DD, got " + JSON.stringify(meta.date));
    assert.ok(meta.summary, f + ": missing summary (the index and feed use it)");
    return { file: f, meta, slug: f.replace(/\.md$/, "") };
  });

  // --- 2. every image the post names exists ---------------------------------
  for (const p of posts) {
    const body = fs.readFileSync(path.join(SRC, p.file), "utf8");
    for (const m of body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const src = m[1];
      if (/^https?:/.test(src)) continue;   // external: nothing to check locally
      // posts live in devlog/, so a source path is root-relative
      const onDisk = path.join(ROOT, src);
      assert.ok(fs.existsSync(onDisk),
        p.file + ": image does not exist: " + src);
    }
  }

  // --- 2b. a post's images live in a folder named after the post -------------
  //
  // Per-post images used to be spread over shared folders (sm4/, pairs/), so
  // after a few posts there was no way to tell which image belonged to which
  // article without opening them all. Each post now keeps its own folder under
  // assets/images/devlog/, named exactly like the post file — the same
  // <date>-<slug> form as docs/devlog/. Shared material that belongs to no
  // single post (the two terminal SVG sources, the inkscape export) stays in
  // pairs/ and is deliberately not forced into a post folder.
  const sharedDirs = ["pairs"];
  for (const p of posts) {
    const body = fs.readFileSync(path.join(SRC, p.file), "utf8");
    for (const m of body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const src = m[1];
      if (/^https?:/.test(src)) continue;
      const under = src.match(/^assets\/images\/devlog\/([^/]+)\//);
      if (!under) continue;   // outside the devlog tree: not this check's business
      const dir = under[1];
      if (sharedDirs.indexOf(dir) !== -1) continue;   // shared material
      assert.strictEqual(dir, p.slug,
        p.file + ": image " + src + " sits in \"" + dir + "\" — a post's " +
        "images belong in assets/images/devlog/" + p.slug + "/ (named after " +
        "the post). Shared material that belongs to no single post goes to " +
        "assets/images/devlog/pairs/ instead.");
    }
  }

  // --- 3. every post is generated and carries no root-relative links --------
  for (const p of posts) {
    const html = pageBySlug[p.slug];
    assert.ok(html, "the generator produced no page for " + p.slug +
      " (docs/devlog/" + p.file + ")");

    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = m[1];
      if (/^(https?:|mailto:|#|\.\.\/)/.test(url)) continue;
      // Every link must climb one level: a post lives in devlog/. The favicon
      // used to be excused here, which quietly allowed the real defect it was
      // meant to catch — a post asking for devlog/favicon.ico, which does not
      // exist. It is rewritten by the generator like the stylesheet and the
      // assets, so no exception is needed.
      //
      // Two legitimate exceptions, and both are pages that live in devlog/:
      //   index.html            the post list, which is this directory's own
      //                         index — in the shared template that name means
      //                         the landing page, so climbing would send the
      //                         reader somewhere the link does not promise
      //   <post-slug>.html      another post, sitting beside this one
      // Anything else relative is a root-relative path and must climb.
      if (url === "index.html") continue;
      if (/^[a-z0-9-]+\.html$/.test(url) &&
          Object.prototype.hasOwnProperty.call(pageBySlug, url.replace(/\.html$/, ""))) continue;
      assert.fail("devlog/" + p.slug + ".html: root-relative link in a page that " +
        "lives one level down: " + url + " (should start with ../)");
    }

    // --- 5. no generator marker reaches the page ---------------------------
    assert.ok(html.indexOf("{.") === -1,
      "devlog/" + p.slug + ".html: a {.class} marker leaked into the output");
    assert.ok(html.indexOf(":::") === -1,
      "devlog/" + p.slug + ".html: a ::: wrapper leaked into the output");

    // No raw Markdown link syntax may reach the page. inline() converts
    // [text](target) in three shapes — an anchor, an absolute URL and a
    // relative path — and a fourth shape nobody thought of would otherwise ship
    // silently: the opening bracket is eaten by the HTML escaping above it, so
    // the reader gets "The first article](2026-09-23-....html)" with no link at
    // all, and nothing in the suite noticed. This asserts the conversion
    // happened rather than that the text is present.
    assert.ok(!/\]\(/.test(html),
      "devlog/" + p.slug + ".html: raw ]( left in the output — inline() did not " +
      "convert a Markdown link in this post's text");

    // No pipe row may survive into the page. The parser understands tables now,
    // but a table written in a shape it does not recognise — indented, or with
    // a different separator row — would otherwise reach the reader as a run of
    // paragraphs made of pipes and dashes, which is exactly what happened before
    // it knew tables at all. This asserts the conversion, not the presence of a
    // table, so a post without one is unaffected.
    // The test is "a pipe where text begins", not "a line starting with a
    // pipe": an unconverted row lands in the page as <p>| a | b |</p>, so the
    // pipe sits after a tag rather than at the start of a line. Matching on
    // ^\s*\| missed exactly that and passed a page full of pipes.
    assert.ok(!/(^|>)\s*\|[^|]*\|/.test(html),
      "devlog/" + p.slug + ".html: a pipe row reached the page — a Markdown " +
      "table was not converted (see the \"table\" case in blocksToHtml, " +
      "tools/build-devlog.js)");

    // And no Russian may reach an English post: the code blocks are quoted from
    // the sources, whose comments are English, and the prose is written in
    // English. A block copied from the Russian edition of an article rather
    // than from the file would land here as Cyrillic inside the page.
    if (p.meta.lang === "en") {
      assert.ok(!/[\u0400-\u04FF]/.test(html),
        "devlog/" + p.slug + ".html: Cyrillic text in an English post — a block " +
        "or a paragraph was copied from the Russian source instead of translated");
    }

    // the title and the date must be on the page — that is what a reader
    // arriving from a feed needs to orient themselves
    assert.ok(html.indexOf(p.meta.title.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;").replace(/>/g, "&gt;")) !== -1
      || html.indexOf(p.meta.title) !== -1,
      "devlog/" + p.slug + ".html: the post title is not on the page");
    assert.ok(html.indexOf(p.meta.date) !== -1,
      "devlog/" + p.slug + ".html: the post date is not on the page");
  }

  // --- 3b. a page must carry what the landing page carries ------------------
  //
  // The manual and the devlog are generated from tools/manual-template-head.html
  // while the landing page is a React bundle styled with Tailwind. One look
  // therefore lives in two unrelated places, and everything present in one copy
  // and missing from the other breaks silently. Five defects of that shape were
  // found by a human in a single day: a missing backdrop (a relative url() that
  // does not climb for a page under devlog/), a stretched backdrop (the slab
  // scrolled the document instead of itself), a white band under the index, and
  // the gold edge lines and drop shadow that only the landing page carried.
  //
  // Each check below pins one of those to the generated output, so the next
  // occurrence fails here rather than in review. The landing page itself is
  // never read: it is a moving target (Tailwind classes, a bundle) and holding
  // generated HTML against a bundle would be brittle. What is pinned is the
  // effect, named in the message so a failure says what is missing.
  const landing = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const pages = posts.map((p) => ["devlog/" + p.slug + ".html", pageBySlug[p.slug]]);
  pages.push(["devlog/index.html", built.index]);

  const shared = [
    // the machine-room backdrop, reachable from one level down
    [/\.\.\/assets\/images\/pdp11-machine-room\.jpg/,
      "the machine-room backdrop (url(\"../assets/images/pdp11-machine-room.jpg\"))"],
    // the slab scrolls itself, as on the landing page and the emulator: body
    // must NOT grow, or background-size: cover stretches the photograph
    [/height:\s*var\(--app-h,\s*100(?:d)?vh\)/,
      "the slab height from the shared base (.app-layout { height: var(--app-h, ...) })"],
    // display: flex on .app-layout is not decoration: .landing-page carries
    // flex: 1, which only grows inside a flex parent. Without it the slab is as
    // tall as its content, so the devlog index — shorter than the window — ended
    // right after the first post instead of running to the bottom.
    [/\.app-layout\s*\{[^}]*display:\s*flex/,
      "display: flex on .app-layout (without it the slab does not fill the window)"],
    // the gold edge lines and the drop shadow around the reading column
    [/border-left:\s*1px solid #3a3528/, "the left gold edge line"],
    [/border-right:\s*1px solid #3a3528/, "the right gold edge line"],
    [/box-shadow:\s*0 0 60px rgba\(0, 0, 0, 0\.85\)/, "the slab drop shadow"],
    // the reading column is the typographic width, not the old 960
    [/max-width:\s*800px/, "the 800px reading column"],
  ];

  for (const [label, html] of pages) {
    for (const [re, what] of shared) {
      assert.ok(re.test(html),
        label + ": missing " + what + " — the landing page has it, so the " +
        "generated pages must too (see tests/devlog.test.js, check 3b)");
    }
    // and the opposite direction: nothing may scroll the document here, because
    // that is what stretched the backdrop
    assert.ok(!/body\s*\{[^}]*overflow:\s*auto/.test(html),
      label + ": body is set to overflow: auto — the document must not scroll, " +
      "the slab does (see css/pdp11.css .app-layout)");
    assert.ok(!/min-height:\s*100vh/.test(html),
      label + ": min-height: 100vh found — that grew body and stretched the " +
      "backdrop (see the reverted fix in the git log)");

    // Every devlog page must offer a way back to the landing page. The pages
    // live one level down, so the way home is "../" — an absolute-looking URL
    // (/ or index.html) would work on GitHub Pages but breaks a reader who
    // opened the directory over file:// or under a sub-path, which is the whole
    // reason these pages are generated with relative links.
    //
    // This check exists because the link was lost once: the index carried the
    // manual in the home slot and blanked the alternate slot, so the template's
    // home anchor was removed and nothing replaced it. Two buttons shipped —
    // "Launch the emulator!" and "User manual" — and only a human reading the
    // live page noticed. The button must be present AND point at the root.
    assert.ok(html.indexOf('<a class="btn-secondary" href="../">') !== -1,
      label + ": no link back to the landing page — every devlog page needs " +
      "\"Back to the Home Page\" → \"../\" (see tools/build-devlog.js chromeFor/" +
      "renderIndex, and tests/devlog.test.js check 3b)");
  }

  // the backdrop file itself must exist — the reference above is worthless if
  // the photograph was renamed
  assert.ok(fs.existsSync(path.join(ROOT, "assets", "images", "pdp11-machine-room.jpg")),
    "assets/images/pdp11-machine-room.jpg is missing: every page names it as the backdrop");

  // --- 4. (gone) "the committed output matches the source" ------------------
  // There is no committed output to compare any more: devlog/ is a build
  // product, regenerated by the Pages deploy and by `npm run devlog:build`.
  // Every check above already runs on the generator's output, which is what
  // those builds publish.

  // --- 6. the feed lists every post, newest first ---------------------------
  //
  // The order is the generator's (newest first, slug as the tie-break), not the
  // order the files come back from the filesystem. docs/devlog/ holds
  // `<date>-<slug>.md`, so readdir already sorts ascending by date — comparing
  // readdir order against a reversed copy of itself passed for the wrong reason
  // and failed the moment the two disagreed.
  const feed = built.feed;
  assert.ok(feed.length > 0, "the generator produced an empty feed");
  for (const p of posts) {
    assert.ok(feed.indexOf(p.slug + ".html") !== -1,
      "the feed does not list the post: " + p.slug);
  }
  // The feed lists newest first, so its order is the check: the first post
  // named in the feed must be the newest one.
  const feedOrder = [...feed.matchAll(/([^/"<>]+\.html)/g)]
    .map((m) => m[1].replace(/\.html$/, ""))
    .filter((s, i, a) => a.indexOf(s) === i);
  assert.ok(feedOrder.length === posts.length,
    "the feed names " + feedOrder.length + " post(s), expected " + posts.length);
  const bySlug = {};
  for (const p of posts) bySlug[p.slug] = p.meta.date;
  const feedDates = feedOrder.map((s) => bySlug[s]);
  const dates = posts.map((p) => p.meta.date).slice()
    .sort((a, b) => (a === b ? 0 : (a < b ? 1 : -1)));
  assert.deepStrictEqual(feedDates, dates,
    "the feed is not ordered newest-first: " + JSON.stringify(feedDates) +
    " — the feed itself is what a reader subscribes to, so its order is checked" +
    " rather than the directory listing");

  // the index links every post too
  const index = built.index;
  for (const p of posts) {
    assert.ok(index.indexOf(p.slug + ".html") !== -1,
      "the index does not link the post: " + p.slug);
  }

  console.log("devlog: all checks passed (" + posts.length + " post(s): " +
    posts.map((p) => p.slug).join(", ") + ")");
}

run();
