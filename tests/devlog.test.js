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

  // --- 3. the generated pages exist and carry no root-relative links --------
  for (const p of posts) {
    const page = path.join(OUT, p.slug + ".html");
    assert.ok(fs.existsSync(page),
      "generated page is missing: devlog/" + p.slug + ".html — run npm run devlog:build");
    const html = fs.readFileSync(page, "utf8");

    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = m[1];
      if (/^(https?:|mailto:|#|\.\.\/)/.test(url)) continue;
      // Everything must climb one level: a post lives in devlog/. The favicon
      // used to be excused here, which quietly allowed the real defect it was
      // meant to catch — a post asking for devlog/favicon.ico, which does not
      // exist. It is rewritten by the generator like the stylesheet and the
      // assets, so no exception is needed.
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
