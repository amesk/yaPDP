#!/usr/bin/env node
/**
 * yaPDP ?boot= deep-link end-to-end test (puppeteer + real Chromium).
 *
 * The landing galleries (the classic index.html and the React SPA) boot a guest
 * OS by opening pdp11.html?boot=<device>, where <device> names a QuickBoot
 * SCENARIO — boot command, typed steps and the machine profile (console,
 * printer, VT11) included. This test drives that link in a real browser and
 * pins the three things that are easy to get wrong:
 *
 *   1. the parameter is CONSUMED — dropped from the URL as soon as it is read,
 *      so a config-driven reload cannot start the same scenario twice;
 *   2. a scenario whose hardware profile differs from the current config
 *      reloads the page and then RESUMES (the pending key), leaving the machine
 *      configured as the guest OS needs — for RT-11 that is a VT100 console;
 *   3. exactly ONE boot sequence is typed into the console, counted across the
 *      reload — the regression the strip in (1) exists to prevent.
 *
 * Plus the negative cases: an unknown key must leave the machine alone (no
 * boot, and the error dialog explaining why), a key full of markup must arrive
 * as text, and on the classic gallery a RUN click must navigate instead of
 * tripping the card's own lightbox.
 *
 * State is polled from Node rather than with waitForFunction: case 2 reloads
 * itself, and a wait bound to the pre-reload execution context never settles.
 *
 * Run with:  node tests/e2e-quickboot-deeplink.js
 * (needs puppeteer, server on :1170 — see tools/serve.js)
 */
"use strict";

const puppeteer = require("puppeteer");

const BASE = "http://localhost:1170/pdp11.html";
const TYPED_KEY = "yapdp.e2e.typed";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  ok  " + name);
  } else {
    failures++;
    console.error("  FAIL " + name + (detail ? " — " + detail : ""));
  }
}

// Poll a page predicate from Node, tolerating the execution context being
// destroyed by a reload in between attempts. Returns false on timeout.
async function poll(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await page.evaluate(predicate)) return true;
    } catch (e) { /* navigating: the context is gone, try again */ }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Count every typed console step, across page reloads: a step is one
// dlReceiveQueue() call whose bytes end with CR (quickboot.js sends the whole
// step — text plus Enter — in one call). The bridge is created by iopage.js
// after document start, so the trap is installed on the property itself.
function installTypedCounter(page) {
  return page.evaluateOnNewDocument(() => {
    let real = null;
    Object.defineProperty(window, "__yapdpBridge", {
      configurable: true,
      get() { return real; },
      set(value) {
        real = value;
        const original = value.dlReceiveQueue;
        value.dlReceiveQueue = function (unit, bytes) {
          try {
            if (bytes && bytes.length && bytes[bytes.length - 1] === 13) {
              const n = parseInt(sessionStorage.getItem("yapdp.e2e.typed") || "0", 10);
              sessionStorage.setItem("yapdp.e2e.typed", String(n + 1));
            }
          } catch (e) { /* sessionStorage unavailable: the check below fails loudly */ }
          return original.apply(this, arguments);
        };
      }
    });
  });
}

function readTyped(page) {
  return page.evaluate(() => parseInt(sessionStorage.getItem("yapdp.e2e.typed") || "0", 10));
}

// Page state, retried: a profile change reloads the page, so an evaluate can
// land while the context is being torn down. The retry only rides over that
// window — a real failure still surfaces once the deadline passes.
async function settledSnapshot(page, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  for (;;) {
    try {
      return await snapshot(page);
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

function snapshot(page) {
  return page.evaluate(() => ({
    search: location.search,
    consoleType: (typeof Config !== "undefined" && Config.get) ? Config.get().consoleType : null,
    pending: (function () {
      try { return localStorage.getItem("yapdp.quickboot.pending"); } catch (e) { return "?"; }
    })(),
    balloon: !!document.getElementById("quick-boot-balloon"),
    wizard: !!document.querySelector("#quick-boot-overlay.visible"),
    ptr: document.getElementById("ptr") ? document.getElementById("ptr").value : null
  }));
}

// A deterministic starting machine: teletype console, printer on, VT11 off.
// Seeded on the emulator page itself (not with evaluateOnNewDocument, which
// would re-seed on the reload that case 2 depends on).
async function seededPage(browser, errors) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(
    () => typeof QuickBoot !== "undefined" && typeof Config !== "undefined",
    { timeout: 30000 });
  await page.evaluate(() => {
    localStorage.setItem("yapdp.config.v1", JSON.stringify({
      consoleType: "teletype", printer: true, vt11: false,
      teletypeSpeed: "fast", powerOn: true, autoBoot: false,
      upperCaseOnly: true, hum: false, mute: false
    }));
    localStorage.setItem("yapdp.onboarding.v1", "done");
    localStorage.removeItem("yapdp.quickboot.pending");
    sessionStorage.removeItem("yapdp.e2e.typed");
  });
  return page;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const errors = [];

  try {
    // --- 1. A scenario that needs no profile change ----------------------
    // BASIC-11 is a paper tape with a teletype console, which is what the
    // seeded machine already is: the link boots it with no reload at all.
    {
      const page = await seededPage(browser, errors);
      await installTypedCounter(page);
      await page.goto(BASE + "?boot=basic", { waitUntil: "domcontentloaded", timeout: 60000 });
      const launched = await poll(page, () => !!document.getElementById("quick-boot-balloon"), 30000);
      check("?boot=basic: the scenario launched (autoload balloon appears)", launched);
      // The wizard waits a step before typing (the boot command needs the @
      // prompt), so give the first step its time rather than asserting at once.
      const typed = await poll(page,
        () => parseInt(sessionStorage.getItem("yapdp.e2e.typed") || "0", 10) >= 1, 15000);

      const state = await settledSnapshot(page);
      check("?boot=basic: the parameter is consumed (no boot= left in the URL)",
        state.search.indexOf("boot=") === -1, state.search);
      check("?boot=basic: the wizard did NOT take over", state.wizard === false);
      check("?boot=basic: the scenario's paper tape was selected",
        state.ptr === "DEC-11-AJPB-PB", String(state.ptr));
      check("?boot=basic: the console was typed into", typed);
      await page.close();
    }

    // --- 2. A scenario that reconfigures the machine ---------------------
    // RT-11 v4.0 wants a VT100 console; the seeded machine has a teletype, so
    // launch() persists the profile and reloads, and the pending key resumes
    // the boot afterwards. The parameter must NOT survive that reload, and the
    // boot must be typed exactly once — not once per page load.
    {
      const page = await seededPage(browser, errors);
      await installTypedCounter(page);
      await page.goto(BASE + "?boot=rk1", { waitUntil: "domcontentloaded", timeout: 60000 });

      const applied = await poll(page, () => {
        const want = OSBoot.scenarioFor("rk1").hardware;
        const cfg = (typeof Config !== "undefined" && Config.get) ? Config.get() : null;
        return !!cfg && cfg.consoleType === want.console && cfg.vt11 === want.vt11;
      }, 60000);
      check("?boot=rk1: the scenario's console profile was applied", applied);

      // The profile is persisted a moment BEFORE the reload starts, so the
      // check above can pass in the outgoing document. The balloon only exists
      // in the resumed one, which makes it the honest "we are past the reload"
      // signal — and the typed count is only complete after that.
      const resumed = await poll(page,
        () => !!document.getElementById("quick-boot-balloon"), 30000);
      check("?boot=rk1: the boot was resumed after the reload", resumed);
      await poll(page,
        () => parseInt(sessionStorage.getItem("yapdp.e2e.typed") || "0", 10) >= 1, 15000);

      const state = await settledSnapshot(page);
      check("?boot=rk1: the deep link did not survive the reload",
        state.search.indexOf("boot=") === -1, state.search);
      check("?boot=rk1: the pending key is cleared after the resume",
        state.pending === null, String(state.pending));
      check("?boot=rk1: the boot was resumed, not opened in the wizard",
        state.balloon === true && state.wizard === false);
      check("?boot=rk1: exactly one boot sequence typed across the reload",
        (await readTyped(page)) === 1, String(await readTyped(page)));
      await page.close();
    }

    // --- 3. An unknown key is explained, not swallowed -------------------
    // A link asking for a scenario this build does not have is an explicit
    // request that cannot be met: the dialog says so, names the key, and offers
    // the quick-boot list — instead of leaving the visitor staring at an idle
    // machine and wondering whether the link did anything at all.
    {
      const page = await seededPage(browser, errors);
      await page.goto(BASE + "?boot=not-a-scenario",
        { waitUntil: "domcontentloaded", timeout: 60000 });
      const explained = await poll(page, () => {
        const overlay = document.querySelector("#quickboot-link-error.visible");
        if (!overlay) return false;
        const intro = overlay.querySelector(".modal-intro");
        return !!intro && intro.textContent.indexOf("not-a-scenario") !== -1;
      }, 30000);
      check("unknown key: the error dialog opens and names the key", explained);
      // Give the (deferred) launch a chance to fire if it wrongly would.
      await new Promise((r) => setTimeout(r, 750));

      const state = await snapshot(page);
      check("unknown key: nothing boots", state.balloon === false);
      check("unknown key: the wizard does not open behind the dialog",
        state.wizard === false);
      check("unknown key: the parameter is left untouched (it names nothing)",
        state.search.indexOf("boot=not-a-scenario") !== -1, state.search);
      check("unknown key: the machine still works (no page errors)",
        errors.length === 0, errors.join(" | "));

      // The dialog's action leads to the list — an explanation that offers no
      // way out is only half a dialog.
      await page.click("#quickboot-link-error [data-bootlink-action='wizard']");
      const opened = await poll(page, () => !!document.querySelector("#quick-boot-overlay.visible"), 10000);
      const options = opened
        ? await page.$$eval(".quickboot-option", (els) => els.length) : 0;
      check("unknown key: 'Choose a guest OS' opens the quick-boot list",
        opened && options > 0, String(options) + " option(s)");
      const closed = await page.evaluate(() =>
        !document.querySelector("#quickboot-link-error.visible"));
      check("unknown key: the error dialog closes behind it", closed);
      await page.close();
    }

    // --- 3b. A link that lost its key is a broken link, not silence -------
    // "?boot=" with nothing after it is what a template with an unset variable
    // emits. The parameter IS there, so somebody asked for something: the same
    // dialog, with wording of its own — there is no key to name.
    {
      const page = await seededPage(browser, errors);
      await page.goto(BASE + "?boot=", { waitUntil: "domcontentloaded", timeout: 60000 });
      const explained = await poll(page, () => {
        const overlay = document.querySelector("#quickboot-link-error.visible");
        if (!overlay) return false;
        const intro = overlay.querySelector(".modal-intro");
        return !!intro && intro.textContent.indexOf("no key at all") !== -1;
      }, 30000);
      check("keyless ?boot=: the dialog explains the missing key", explained);

      const state = await settledSnapshot(page);
      check("keyless ?boot=: nothing boots", state.balloon === false);
      check("keyless ?boot=: the parameter is left in the URL",
        state.search.indexOf("boot=") !== -1, state.search);
      const emptyCode = await page.evaluate(() =>
        !!document.querySelector("#quickboot-link-error .modal-intro code"));
      check("keyless ?boot=: no empty <code> element is printed", emptyCode === false);
      check("keyless ?boot=: no page errors", errors.length === 0, errors.join(" | "));
      await page.close();
    }

    // --- 3c. A cold start: the link is the FIRST thing the page is asked -----
    // Everything above warms the page up first (seededPage() navigates to BASE),
    // so the manifest is already in the HTTP cache and the deep link is resolved
    // against a known-good list. That is exactly how the feature does NOT get
    // used: a visitor follows a link from an article into a browser that has
    // never seen the site. Here the very first navigation carries the
    // parameter, in a fresh context with an empty cache and no localStorage —
    // the case where the manifest is still in flight when init() runs.
    //
    // The point is not that it is fast: it is that the boot waits for that
    // answer (or the grace period) instead of racing it. A boot may not start
    // before the build has said whether it ships the image.
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));
      await installTypedCounter(page);
      // No seeding, no warm-up: the deep link IS the first request.
      await page.goto(BASE + "?boot=rk0", { waitUntil: "domcontentloaded", timeout: 60000 });

      const launched = await poll(page, () => !!document.getElementById("quick-boot-balloon"), 45000);
      check("cold start: the scenario launched on the first navigation", launched);
      const typed = await poll(page,
        () => parseInt(sessionStorage.getItem("yapdp.e2e.typed") || "0", 10) >= 1, 20000);
      check("cold start: the console was typed into", typed);

      const state = await settledSnapshot(page);
      check("cold start: the parameter is consumed",
        state.search.indexOf("boot=") === -1, state.search);
      check("cold start: nothing was refused that the build ships",
        state.wizard === false && !(await page.$("#quickboot-link-error.visible")));
      await page.close();
      await context.close();
    }

    // --- 3d. A key the build does not ship ---------------------------------
    // A scenario this build HAS the hardware profile for but not the image: a
    // stale link to an OS that was dropped from the deployment. The manifest is
    // the only thing that knows, and it lands after init(), so this case is the
    // cold-start race seen from the other side: the boot is held until the
    // answer arrives, and the answer is "no" — the dialog, not a stalled mount.
    //
    // media/manifest.json in the repo ships every gallery image, so the way to
    // produce a missing one is to serve the page with the manifest fetch
    // pointed at a list that omits it. That is done by intercepting the one
    // request, which leaves every other byte of the page exactly as shipped.
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        if (/media\/manifest\.json/.test(req.url())) {
          // A build that ships only the Unix V5 disk: ?boot=rk1 names a real
          // scenario (RT-11) whose image is simply not here.
          req.respond({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ media: ["rk0.dsk"] })
          });
        } else {
          req.continue();
        }
      });
      await page.goto(BASE + "?boot=rk1", { waitUntil: "domcontentloaded", timeout: 60000 });

      const explained = await poll(page, () => {
        const overlay = document.querySelector("#quickboot-link-error.visible");
        if (!overlay) return false;
        const intro = overlay.querySelector(".modal-intro");
        return !!intro && intro.textContent.indexOf("rk1") !== -1;
      }, 45000);
      check("missing image: the dialog explains it (rather than stalling on a mount)",
        explained);

      const state = await settledSnapshot(page);
      check("missing image: nothing boots", state.balloon === false);
      check("missing image: the parameter is left in the URL",
        state.search.indexOf("boot=rk1") !== -1, state.search);
      const wording = await page.evaluate(() => {
        const overlay = document.querySelector("#quickboot-link-error");
        const title = overlay ? overlay.querySelector(".modal-title") : null;
        return title ? title.textContent : "";
      });
      check("missing image: the dialog says the image is unavailable, not the scenario",
        wording === "Quick boot image not available", wording);
      check("missing image: no page errors", errors.length === 0, errors.join(" | "));
      await page.close();
      await context.close();
    }

    // --- 4. The key is data, not markup ----------------------------------
    // The key comes from a URL nobody validated and is shown back in the
    // dialog: it must arrive as text, in the shared error shell.
    {
      const page = await seededPage(browser, errors);
      await page.goto(BASE + "?boot=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
        { waitUntil: "domcontentloaded", timeout: 60000 });
      const explained = await poll(page,
        () => !!document.querySelector("#quickboot-link-error.visible"), 30000);
      check("hostile key: the error dialog opens", explained);

      const state = await page.evaluate(() => {
        const overlay = document.querySelector("#quickboot-link-error");
        const code = overlay ? overlay.querySelector(".modal-intro code") : null;
        return {
          text: code ? code.textContent : "",
          injected: !!(overlay && overlay.querySelector("img")),
          errorShell: overlay ? overlay.querySelectorAll(".modal-box.error").length : 0
        };
      });
      check("hostile key: shown as text, not parsed as markup",
        state.text === "<img src=x onerror=alert(1)>", state.text);
      check("hostile key: nothing was injected into the dialog",
        state.injected === false);
      check("hostile key: the shared error shell is used", state.errorShell === 1);
      check("hostile key: no page errors", errors.length === 0, errors.join(" | "));
      await page.close();
    }

    // --- 5. The classic gallery: RUN navigates, the card enlarges ---------
    // The whole card opens the lightbox on click and RUN is an anchor inside
    // it, so the carousel's wire() guard is what keeps a RUN click from doing
    // both. A dispatched click on an anchor still follows the link — the first
    // run of this case proved it by navigating out from under the test — so a
    // capture listener cancels the navigation and leaves the guard as the only
    // thing under observation. The keys are compared as a set: the raw count of
    // .run-btn elements is not seven, because the carousel clones its cards.
    {
      const page = await browser.newPage();
      page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));
      await page.goto("http://localhost:1170/index.html",
        { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector(".carousel-item.os-card-link .run-btn", { timeout: 15000 });

      const hrefs = await page.$$eval(".carousel-item.os-card-link .run-btn",
        (els) => els.map((e) => e.getAttribute("href")));
      const uniqueHrefs = Array.from(new Set(hrefs));
      check("classic gallery: every card carries a ?boot= link",
        uniqueHrefs.length === 7 &&
        hrefs.every((h) => /^pdp11\.html\?boot=[a-z0-9]+$/.test(h)),
        uniqueHrefs.join(", "));

      const lightboxAfterRun = await page.evaluate(() => {
        const run = document.querySelector(".carousel-item.os-card-link .run-btn");
        run.addEventListener("click", (e) => e.preventDefault(), true);
        run.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return document.getElementById("os-lightbox").hidden;
      });
      check("classic gallery: a RUN click does not open the lightbox",
        lightboxAfterRun === true);

      const lightboxAfterShot = await page.evaluate(() => {
        document.querySelector(".carousel-item.os-card-link img").dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }));
        return document.getElementById("os-lightbox").hidden;
      });
      check("classic gallery: clicking the screenshot still enlarges it",
        lightboxAfterShot === false);
      await page.close();
    }
  } finally {
    await browser.close();
  }

  if (failures) {
    console.error("\n" + failures + " check(s) failed");
    process.exit(1);
  }
  console.log("\n?boot= deep-link e2e: all checks passed");
})();
