#!/usr/bin/env node
/**
 * yaPDP quick-boot manifest end-to-end test (puppeteer + real Chromium).
 *
 * Verifies that the quick-boot wizard and the Info page's guest-OS table
 * respect the build manifest (media/manifest.json):
 *   1. manifest present (reduced image set)  -> wizard lists only the
 *      shipped images (+ all paper tapes); Info table dims missing rows
 *   2. manifest absent                       -> wizard lists every scenario
 *      (previous behaviour, ad-hoc hosts)
 *   3. manifest + a drag-and-drop mounted image -> union: the imported
 *      image's OS appears even though the build does not ship it
 *
 * The manifest response is intercepted with page.route(), so no media files
 * are touched. Run with:  node tests/e2e-quickboot-manifest.js
 * (needs puppeteer, server on :1170 — see tools/serve.js)
 */
"use strict";

const puppeteer = require("puppeteer");

const URL = "http://localhost:1170/pdp11.html";
const MANIFEST_RE = /\/media\/manifest\.json(\?.*)?$/;

// A reduced build: Unix V5 (rk0) + RT-11 (rk1) + the paper tapes.
const REDUCED = { media: ["rk0.dsk", "rk1.dsk", "lander.ptap"] };

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  ok  " + name);
  } else {
    failures++;
    console.error("  FAIL " + name + (detail ? " — " + detail : ""));
  }
}

async function newPage(browser, mode) {
  const page = await browser.newPage();
  // Seed a stable config so the wizard and Info page render deterministically.
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem("yapdp.config.v1", JSON.stringify({
        consoleType: "teletype", printer: true, vt11: false,
        teletypeSpeed: "fast", powerOn: true, autoBoot: false,
        upperCaseOnly: true, hum: false, mute: false
      }));
      localStorage.setItem("yapdp.onboarding.v1", "done");
    } catch (e) {}
  });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (MANIFEST_RE.test(req.url())) {
      if (mode === "reduced") {
        req.respond({ status: 200, contentType: "application/json",
          body: JSON.stringify(REDUCED) });
      } else if (mode === "absent") {
        req.abort();
      } else {
        req.continue();
      }
    } else {
      req.continue();
    }
  });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(
    () => typeof QuickBoot !== "undefined" && typeof OSBoot !== "undefined",
    { timeout: 30000 });
  return page;
}

async function wizardDevices(page) {
  await page.evaluate(() => QuickBoot.show());
  await page.waitForSelector(".quickboot-option", { timeout: 5000 });
  const devices = await page.$$eval(".quickboot-option",
    (els) => els.map((e) => e.getAttribute("data-quickboot-device")));
  await page.evaluate(() => QuickBoot.hide());
  return devices.sort();
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const consoleErrors = [];

  try {
    // --- 1. Reduced manifest: wizard shows only shipped images ----------
    {
      const page = await newPage(browser, "reduced");
      page.on("pageerror", (e) => consoleErrors.push(String(e)));
      await page.waitForFunction(
        () => QuickBoot.manifest && typeof QuickBoot.manifest === "function",
        { timeout: 10000 });
      // Wait until the manifest has been applied (list settles) — the
      // wizard prefetches it, so the filtered render happens automatically.
      await page.waitForFunction(async () => {
        const m = await QuickBoot.manifest();
        return m && m.length === 3;
      }, { timeout: 10000 });

      const devices = await wizardDevices(page);
      // rk1vt52 shares rk1.dsk, so it is listed too (see the dedicated check
      // below); rp1 (BSD 2.11) is not shipped and must be hidden.
      check("reduced manifest: wizard lists only shipped + paper tapes",
        JSON.stringify(devices) ===
        JSON.stringify(["basic", "ed11", "lander", "odt11", "rk0", "rk1",
          "rk1vt52"]),
        JSON.stringify(devices));
      check("reduced manifest: rp1 (BSD 2.11) hidden",
        devices.indexOf("rp1") === -1, "rp1 present");
      check("reduced manifest: rk1vt52 kept via shared rk1.dsk",
        devices.indexOf("rk1vt52") !== -1, "rk1vt52 missing");
      await page.close();
    }

    // --- 2. No manifest: wizard shows everything (previous behaviour) ----
    {
      const page = await newPage(browser, "absent");
      await page.waitForFunction(async () => {
        const m = await QuickBoot.manifest();
        return m === null;
      }, { timeout: 10000 });
      const devices = await wizardDevices(page);
      const all = await page.evaluate(() =>
        OSBoot.BOOT_SCENARIOS.map((s) => s.device).sort());
      check("no manifest: wizard lists every scenario",
        JSON.stringify(devices) === JSON.stringify(all),
        JSON.stringify(devices));
      await page.close();
    }

    // --- 3. Union: mounted image (drag-and-drop) adds its OS ------------
    {
      const page = await newPage(browser, "reduced");
      await page.waitForFunction(async () => {
        const m = await QuickBoot.manifest();
        return m && m.length === 3;
      }, { timeout: 10000 });
      // Simulate a drag-and-drop import of BSD 2.9 (rl0.dsk) via DataLoader.
      await page.evaluate(() => {
        DataLoader.mount("rl0.dsk", new Uint8Array(1024));
      });
      const devices = await wizardDevices(page);
      check("union: drag-and-drop mounted rl0.dsk adds BSD 2.9",
        devices.indexOf("rl0") !== -1, JSON.stringify(devices));
      check("union: manifest images still listed",
        devices.indexOf("rk0") !== -1, JSON.stringify(devices));
      check("union: neither-source image still hidden",
        devices.indexOf("rp1") === -1, JSON.stringify(devices));
      await page.close();
    }

    // --- 4. Info page: missing rows dimmed, shipped rows untouched -------
    {
      const page = await newPage(browser, "reduced");
      await page.waitForFunction(async () => {
        const m = await QuickBoot.manifest();
        return m && m.length === 3;
      }, { timeout: 10000 });
      await page.evaluate(() => switchPage("instructions"));
      await page.waitForSelector("#guest-os-table", { timeout: 5000 });
      const rows = await page.evaluate(() => {
        const out = {};
        document.querySelectorAll("#guest-os-table tbody tr").forEach((tr) => {
          const disk = tr.querySelector("td.disk").textContent.trim();
          out[disk] = {
            missing: tr.classList.contains("guest-os-missing"),
            note: !!(tr.querySelector(".guest-os-note"))
          };
        });
        return out;
      });
      check("Info: RK0 row not dimmed (rk0.dsk shipped)",
        rows.RK0 && !rows.RK0.missing && !rows.RK0.note, JSON.stringify(rows.RK0));
      check("Info: RK1 row not dimmed (rk1.dsk shipped)",
        rows.RK1 && !rows.RK1.missing, JSON.stringify(rows.RK1));
      check("Info: RP1 row dimmed with note (rp1.dsk not shipped)",
        rows.RP1 && rows.RP1.missing && rows.RP1.note, JSON.stringify(rows.RP1));
      check("Info: RL0 row dimmed (rl0.dsk not shipped)",
        rows.RL0 && rows.RL0.missing, JSON.stringify(rows.RL0));
      await page.close();
    }

    // --- 5. Real manifest (no interception): full repo = full list -------
    {
      const page = await newPage(browser, "real");
      await page.waitForFunction(async () => {
        const m = await QuickBoot.manifest();
        return m && m.length > 20;
      }, { timeout: 10000 });
      const devices = await wizardDevices(page);
      const all = await page.evaluate(() =>
        OSBoot.BOOT_SCENARIOS.map((s) => s.device).sort());
      check("real manifest: wizard lists every scenario (full repo)",
        JSON.stringify(devices) === JSON.stringify(all),
        JSON.stringify(devices));
      await page.close();
    }

    if (consoleErrors.length) {
      failures++;
      console.error("  FAIL page errors:\n" + consoleErrors.join("\n"));
    }
  } finally {
    await browser.close();
  }

  if (failures) {
    console.error(`e2e-quickboot-manifest: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("e2e-quickboot-manifest: ALL CHECKS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
