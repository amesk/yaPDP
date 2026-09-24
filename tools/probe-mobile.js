#!/usr/bin/env node
/**
 * Compare the computed styles of the landing page and the generated pages on a
 * phone-sized viewport.
 *
 * Written after four wrong diagnoses in a row about the "strips of the machine
 * room photograph down the sides of the article": the difference between the
 * landing page (which reads well on a phone) and the devlog/manual (which did
 * not) was being guessed at from the CSS source. This measures it instead.
 *
 * For each page it reports the box and the computed style of the elements that
 * decide the layout — body, the flex container, the reading column — so the two
 * can be diffed rather than reasoned about.
 *
 *   node tools/probe-mobile.js <port> [--json]
 */
"use strict";

const puppeteer = require("puppeteer");

const PORT = process.argv[2] || "1181";

// A Redmi Note 13 Pro is 1220x2712 physical at DPR ~3.1, i.e. about 393x873 CSS
// pixels. 360x800 is the narrow-Android control.
const VIEWPORTS = [
  { name: "redmi-393", width: 393, height: 873, dpr: 3.1, mobile: true },
  { name: "narrow-360", width: 360, height: 800, dpr: 3, mobile: true },
];

const PAGES = [
  { name: "landing", url: "/" },
  { name: "devlog-index", url: "/devlog/index.html" },
  { name: "devlog-post", url: "/devlog/2026-09-24-own-pdp11-anyway.html" },
  { name: "manual", url: "/manual.html" },
];

// Every element worth comparing, named by what it is rather than by how it is
// reached in a particular DOM.
const TARGETS = {
  body: "body",
  "flex-root": "body > div",
  "app-layout": ".app-layout",
  "landing-page": ".landing-page",
  "hero": ".hero",
  "panel-actions": ".panel-actions-landing",
  "content-slab": "main, .landing-page",
};

const PROBE = (targets) => {
  const out = {};
  for (const [label, sel] of Object.entries(targets)) {
    const el = document.querySelector(sel);
    if (!el) { out[label] = null; continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out[label] = {
      selector: sel,
      tag: el.tagName.toLowerCase(),
      rect: {
        x: Math.round(r.x), width: Math.round(r.width),
        height: Math.round(r.height),
      },
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      style: {
        display: cs.display,
        flexDirection: cs.flexDirection,
        flex: cs.flex,
        width: cs.width,
        minWidth: cs.minWidth,
        maxWidth: cs.maxWidth,
        margin: cs.margin,
        padding: cs.padding,
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        height: cs.height,
        minHeight: cs.minHeight,
        borderLeft: cs.borderLeftWidth,
        borderRight: cs.borderRightWidth,
        backgroundImage: cs.backgroundImage === "none" ? "none" : "<backdrop>",
        backgroundAttachment: cs.backgroundAttachment,
        boxShadow: cs.boxShadow === "none" ? "none" : "<shadow>",
      },
    };
  }
  // What the page itself thinks its viewport is, and whether anything scrolls
  // the document rather than an inner element.
  out._viewport = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    bodyScrolls: document.body.scrollHeight > window.innerHeight,
    docScroller: document.scrollingElement
      ? document.scrollingElement.tagName.toLowerCase() : null,
  };
  return out;
};

(async () => {
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const results = {};
  for (const vp of VIEWPORTS) {
    results[vp.name] = {};
    for (const page of PAGES) {
      const p = await browser.newPage();
      await p.setViewport({
        width: vp.width, height: vp.height,
        deviceScaleFactor: vp.dpr, isMobile: vp.mobile, hasTouch: vp.mobile,
      });
      await p.goto("http://127.0.0.1:" + PORT + page.url, { waitUntil: "load" });
      // Let the SPA mount and any fonts settle.
      await new Promise((r) => setTimeout(r, 700));
      results[vp.name][page.name] =
        await p.evaluate(PROBE, TARGETS);
      await p.close();
    }
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
