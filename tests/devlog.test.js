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
 *   4. the generated pages drifting from their Markdown source (npm run
 *      devlog:check is what tells a committer to regenerate);
 *   5. a generator marker ({.class}, :::) leaking into a published page;
 *   6. the feed not listing every post, or listing them out of date order.
 *
 * Run with:  node tests/devlog.test.js
 *
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "docs", "devlog");
const OUT = path.join(ROOT, "devlog");
const { parseFrontMatter } = require("../tools/build-devlog.js");

function postFiles() {
  return fs.readdirSync(SRC).filter((f) => f.endsWith(".md")).sort();
}

function run() {
  const files = postFiles();
  assert.ok(files.length > 0, "docs/devlog/ has no posts");

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

  // --- 3. the generated pages exist and carry no root-relative links --------
  for (const p of posts) {
    const page = path.join(OUT, p.slug + ".html");
    assert.ok(fs.existsSync(page),
      "generated page is missing: devlog/" + p.slug + ".html — run npm run devlog:build");
    const html = fs.readFileSync(page, "utf8");

    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = m[1];
      if (/^(https?:|mailto:|#|\.\.\/)/.test(url)) continue;
      // Every link must climb one level: a post lives in devlog/. The favicon
      // used to be excused here, which quietly allowed the real defect it was
      // meant to catch — a post asking for devlog/favicon.ico, which does not
      // exist. It is rewritten by the generator like the stylesheet and the
      // assets, so no exception is needed.
      //
      // index.html is the one legitimate exception, and the reason is a trap in
      // the shared template: there that name means the landing page, but a
      // post's "All posts" must reach the devlog index — and from inside
      // devlog/ that is plain index.html. Climbing sent the reader to the
      // landing page: the button said "All posts" and did something else.
      if (url === "index.html") continue;
      assert.fail("devlog/" + p.slug + ".html: root-relative link in a page that " +
        "lives one level down: " + url + " (should start with ../)");
    }

    // --- 5. no generator marker reaches the page ---------------------------
    assert.ok(html.indexOf("{.") === -1,
      "devlog/" + p.slug + ".html: a {.class} marker leaked into the output");
    assert.ok(html.indexOf(":::") === -1,
      "devlog/" + p.slug + ".html: a ::: wrapper leaked into the output");

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
  const pages = posts.map((p) => ["devlog/" + p.slug + ".html",
    fs.readFileSync(path.join(OUT, p.slug + ".html"), "utf8")]);
  pages.push(["devlog/index.html", fs.readFileSync(path.join(OUT, "index.html"), "utf8")]);

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

  // --- 4. the committed output matches the source ---------------------------
  // This is the check that makes the suite useful in CI: a post edited in
  // Markdown but never regenerated fails here, with the command to run.
  try {
    execFileSync(process.execPath, [path.join(ROOT, "tools", "build-devlog.js"), "--check"],
      { cwd: ROOT, stdio: "pipe" });
  } catch (err) {
    const out = String(err.stdout || "") + String(err.stderr || "");
    assert.fail("generated devlog output is stale: " + out.trim());
  }

  // --- 6. the feed lists every post, newest first ---------------------------
  const feedPath = path.join(OUT, "feed.xml");
  assert.ok(fs.existsSync(feedPath), "devlog/feed.xml is missing");
  const feed = fs.readFileSync(feedPath, "utf8");
  for (const p of posts) {
    assert.ok(feed.indexOf(p.slug + ".html") !== -1,
      "the feed does not list the post: " + p.slug);
  }
  const dates = posts.map((p) => p.meta.date);
  const sorted = dates.slice().sort().reverse();
  assert.deepStrictEqual(dates, sorted,
    "posts are not ordered newest-first: " + JSON.stringify(dates));

  // the index links every post too
  const index = fs.readFileSync(path.join(OUT, "index.html"), "utf8");
  for (const p of posts) {
    assert.ok(index.indexOf(p.slug + ".html") !== -1,
      "the index does not link the post: " + p.slug);
  }

  console.log("devlog: all checks passed (" + posts.length + " post(s): " +
    posts.map((p) => p.slug).join(", ") + ")");
}

run();
