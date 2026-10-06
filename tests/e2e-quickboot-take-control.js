#!/usr/bin/env node
/**
 * yaPDP "Take control!" end-to-end test (puppeteer + real Chromium).
 *
 * The quick-boot autoload blocks the operator's own input while it types, and
 * the ONLY way out is the toast's "Take control!" button. That safety rests on
 * one fragile link: the input gate exempts clicks whose target is inside
 * #quick-boot-balloon (src/quickboot.js, gateEvent), and the button is built
 * inside that same element (ensureBalloon). If the DOM id and the gate selector
 * ever drift apart, the button is swallowed by the gate it is meant to escape —
 * a trap, with no way out but a reload.
 *
 * No unit test can see that link: tests/quickboot-input-gate.test.js drives the
 * gate with a synthetic document, and tests/mobile-css.test.js only reads the
 * source. This test drives a REAL autoload in a real browser and pins the
 * whole chain:
 *
 *   1. the autoload starts (the toast is up, the gate is closed);
 *   2. the gate really blocks input (a dispatched keydown is cancelled and
 *      never reaches a document listener);
 *   3. a real mouse click on #quick-boot-take-control goes through — the DOM
 *      element the user sees is the element the gate exempts;
 *   4. the gate lets go (input is no longer cancelled and reaches listeners).
 *
 * Run with:  node tests/e2e-quickboot-take-control.js
 * (needs puppeteer, server on :1170 — see tools/serve.js)
 */
"use strict";

const puppeteer = require("puppeteer");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const BASE = "http://localhost:1170/pdp11.html";
// A scenario with a multi-step typed boot (RT-11: boot command, then a wait
// for the monitor prompt) so the toast lives long enough to be driven here.
const SCENARIO = "?boot=rk1";

const ROOT = path.resolve(__dirname, "..");

// --- shared dev server ------------------------------------------------------
// The suite needs a server on :1170 (the page and its media come from it).
// Start our own when nothing serves the port and stop it on the way out;
// reuse one that is already up (the shared server tools/validate.js starts).
const SERVE_URL = "http://localhost:1170/pdp11.html";
function serverAlive() {
    return new Promise((resolve) => {
        const req = http.get(SERVE_URL, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
}

async function ensureServer() {
    if (await serverAlive()) return null;
    const child = spawn(process.execPath, [
        path.join(ROOT, "tools", "serve.js"), "--port", "1170"
    ], { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        if (await serverAlive()) return child;
        await new Promise((r) => setTimeout(r, 200));
    }
    child.kill();
    throw new Error("Static server did not start on port 1170");
}

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
// destroyed by the profile reload the deep link can trigger.
async function poll(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await page.evaluate(predicate)) return true;
    } catch (e) { /* navigating: the context is gone, try again */ }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Dispatch a keydown on the document and report how it fared:
//   cancelled — preventDefault reached it (the gate is closed);
//   seen      — a plain bubble-phase document listener received it (the gate
//               did NOT stopImmediatePropagation).
async function probeKey(page) {
  return page.evaluate(() => {
    let seen = false;
    const onKey = () => { seen = true; };
    document.addEventListener("keydown", onKey); // bubble phase
    const notCancelled = document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "x", bubbles: true, cancelable: true
    }));
    document.removeEventListener("keydown", onKey);
    return { cancelled: notCancelled === false, seen: seen };
  });
}

(async () => {
  const server = await ensureServer();
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));

    await page.goto(BASE + SCENARIO, { waitUntil: "domcontentloaded", timeout: 90000 });

    // --- 1. The autoload starts -----------------------------------------
    const started = await poll(page, () =>
      !!(window.QuickBoot && window.QuickBoot.isAutoloading &&
         window.QuickBoot.isAutoloading() &&
         document.querySelector("#quick-boot-balloon.visible")),
      60000);
    check("the autoload started: the toast is up and the gate is closed", started);

    // The wiring this test exists for: the button the user clicks must live
    // inside the element the gate exempts.
    const wiring = await page.evaluate(() => {
      const toast = document.getElementById("quick-boot-balloon");
      const btn = document.getElementById("quick-boot-take-control");
      return {
        hasToast: !!toast,
        hasBtn: !!btn,
        btnInToast: !!(toast && btn && toast.contains(btn)),
        btnLabel: btn ? btn.textContent : null
      };
    });
    check("the toast carries the Take control! button",
      wiring.hasBtn && wiring.btnLabel === "Take control!", JSON.stringify(wiring));
    check("the button sits inside #quick-boot-balloon (the gate's exemption)",
      wiring.btnInToast === true, JSON.stringify(wiring));

    // --- 2. The gate really blocks input --------------------------------
    const whileClosed = await probeKey(page);
    check("a keystroke is cancelled while the autoload runs",
      whileClosed.cancelled === true, JSON.stringify(whileClosed));
    check("…and never reaches a document listener",
      whileClosed.seen === false, JSON.stringify(whileClosed));

    // --- 3. A real click on the button goes through ---------------------
    // page.click() dispatches real mousedown/mouseup/click; if the gate's
    // exemption did not match this DOM element, they would be swallowed and
    // the toast would stay up — which the next check catches.
    await page.click("#quick-boot-take-control");

    const released = await poll(page, () =>
      !window.QuickBoot.isAutoloading() &&
      !document.querySelector("#quick-boot-balloon.visible"),
      5000);
    check("clicking Take control! aborts the autoload and hides the toast", released);

    // --- 4. The gate lets go --------------------------------------------
    if (released) {
      const afterOpen = await probeKey(page);
      // The app's own keyboard handler (pdp11-app.js) may still preventDefault
      // — it consumes keys to drive the machine — so the GATE's signature is
      // the SWALLOW, not the cancel: while it is closed a plain document
      // listener never sees the event at all.
      check("the gate no longer swallows input once control is taken",
        afterOpen.seen === true, JSON.stringify(afterOpen));
    }

    check("no page errors during the take-control flow", errors.length === 0,
      errors.join(" | "));

    await page.close();
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  if (failures) {
    console.error("\n" + failures + " check(s) failed");
    process.exit(1);
  }
  console.log("\nTake control! e2e: all checks passed");
})();
