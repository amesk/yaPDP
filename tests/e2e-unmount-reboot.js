#!/usr/bin/env node
/**
 * Unmount → REBOOT regression test (puppeteer + real Chromium, ?core=1).
 *
 * Reported symptom: boot RT-11 from RK1, unmount RK1 on the Storage page, then
 * REBOOT — every boot variant ended in "HALT at 2 PSW: 4", and the manual
 * BOOT RK1 typed at the '@' prompt did the same. The medium was still on the
 * server the whole time.
 *
 * Root cause: the lazy disk provider (src/browser-machine.js) latched its
 * "network attempt done" flag on the FIRST attempt — including successful ones
 * — so once Unmount dropped the bytes from DataLoader the provider served an
 * all-zero block forever. The boot ROM never checks the controller error bits
 * (macro-asm/boot.mac: bootrk does `clr pc`), so the CPU executed zeros and
 * halted.
 *
 * This suite pins the behaviour an operator expects:
 *
 *   1. Unmount does not destroy the medium: the next boot of a bundled image
 *      streams it again (fetch media/<url>.zst, mounted as "network").
 *   2. Both boot variants recover: the 'last medium' preset and a manual
 *      "BOOT RK1" at the interactive '@' prompt.
 *   3. An imported image that has no server copy reports the failure with the
 *      "Image load interrupted" dialog instead of dying silently, and the
 *      stored copy survives Unmount (it is back after a reload).
 *
 * Run with:  node tests/e2e-unmount-reboot.js
 * (needs puppeteer; starts the dev server itself if :1170 is not serving)
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");

const h = require("./e2e-teletype-harness.js");

// The reboot dialog must appear (we choose the boot device there) and the
// rest must match the rk1tty scenario profile, or the wizard reloads the page.
const CFG = Object.assign({}, h.CFG, { confirmReboot: true });

// The imported image lives only in IndexedDB. It must NOT be named after a
// bundled medium (media/rk3.dsk.zst exists), otherwise the broken provider
// would be masked by a successful re-stream from the server.
const LOCAL_IMAGE = "myrt.dsk";
const LOCAL_DRIVE = "rk4";

const sleep = h.sleep;

// --- page ------------------------------------------------------------------

async function openTestPage(browser) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.evaluateOnNewDocument((seed) => {
        try {
            // Seed ONCE per browser profile: a reload has to keep what the
            // reboot dialog persisted (bootDevice) and what the ROM
            // remembered (yapdp.lastboot) — the test asserts on both.
            if (!localStorage.getItem("yapdp.config.v1")) {
                localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
            }
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, CFG);

    await page.goto(`${h.BASE}/pdp11.html?bridge=1&cfg=teletype`,
        { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => typeof window.switchPage === "function",
        { timeout: 30000 });
    await h.installHooks(page);
    return page;
}

// --- reading / driving the machine -----------------------------------------

function machineState(page) {
    return page.evaluate(() => ({
        pc: (typeof CPU !== "undefined") ? CPU.registerVal[7].toString(8) : "?",
        runState: (typeof CPU !== "undefined") ? CPU.runState : "?",
        mounted: (typeof DataLoader !== "undefined") ? DataLoader.list() : [],
        sources: (typeof DataLoader !== "undefined")
            ? DataLoader.list().map((u) => u + ":" + DataLoader.sourceOf(u)) : [],
        mountedOptions: (function () {
            const sel = document.getElementById("mounted-select");
            return sel ? Array.from(sel.options).map((o) => o.value) : [];
        })(),
        mountMap: (typeof MountMap !== "undefined") ? MountMap.list() : {},
        imageErrorShown: (function () {
            const el = document.getElementById("imgerror-overlay");
            return !!(el && el.classList.contains("visible"));
        })(),
        deleteEnabled: (function () {
            const btn = document.getElementById("mounted-delete");
            return !!(btn && !btn.disabled);
        })(),
        deleteDialogShown: (function () {
            const el = document.getElementById("imagedelete-overlay");
            return !!(el && el.classList.contains("visible"));
        })(),
    }));
}

// Select an entry of the Mounted images list (fires the change handler the
// Unmount / Delete / Bind controls depend on).
async function selectMounted(page, url) {
    return page.evaluate((u) => {
        const sel = document.getElementById("mounted-select");
        if (!sel) return "no mounted select";
        if (!Array.from(sel.options).some((o) => o.value === u)) return "not listed: " + u;
        sel.value = u;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return "ok";
    }, url);
}

function outputMark(page) {
    return page.evaluate(() => (window.__osShotOutput || "").length);
}

function outputSince(page, mark) {
    return page.evaluate((m) => (window.__osShotOutput || "").slice(m), mark);
}

async function waitForOutput(page, mark, needle, timeout) {
    return h.waitFor(async () => (await outputSince(page, mark)).indexOf(needle) !== -1,
        timeout);
}

// The REBOOT button opens the machine dialog; the boot-device select there is
// the operator's choice ("none" / "interactive@" / "last").
async function reboot(page, bootDevice) {
    await page.evaluate(() => {
        const btn = document.getElementById("reboot-btn");
        if (btn) btn.click();
    });
    await sleep(500);
    const clicked = await page.evaluate((v) => {
        const sel = document.getElementById("machine-action-bootDevice");
        const primary = document.getElementById("machine-action-primary");
        if (!sel || !primary) return false;
        sel.value = v;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        primary.click();
        return true;
    }, bootDevice);
    if (!clicked) throw new Error("reboot dialog did not open");
await sleep(1000);
}

// Bind the selected mounted image to a drive ("Assign to drive" on Storage).
async function bindDrive(page, url, drive) {
return page.evaluate((u, d) => {
    const sel = document.getElementById("mounted-select");
    const driveSel = document.getElementById("assign-drive");
    const btn = document.getElementById("assign-btn");
    if (!sel || !driveSel || !btn) return "assign controls missing";
    sel.value = u;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    driveSel.value = d;
    driveSel.dispatchEvent(new Event("change", { bubbles: true }));
    if (btn.disabled) return "bind disabled";
    btn.click();
    return "ok";
}, url, drive);
}

async function unmount(page, url) {
    return page.evaluate((u) => {
        const sel = document.getElementById("mounted-select");
        if (!sel) return "no mounted select";
        if (!Array.from(sel.options).some((o) => o.value === u)) {
            return "not listed: " + u;
        }
        sel.value = u;
        const btn = document.getElementById("mounted-remove");
        if (!btn) return "no unmount button";
        btn.click();
        return "ok";
    }, url);
}

async function gotoStorage(page) {
    await page.evaluate(() => window.switchPage("storage"));
    await sleep(800);
}

// --- the suite -------------------------------------------------------------

async function main() {
    const server = await h.ensureServer();
    const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const tmpFile = path.join(os.tmpdir(), LOCAL_IMAGE + ".zst");
    fs.copyFileSync(path.join(h.ROOT, "media", "rk1.dsk.zst"), tmpFile);

    try {
        const page = await openTestPage(browser);

        // ---- 1. boot RT-11 from the gallery --------------------------------
        await h.launchDevice(page, "rk1tty");
        const booted = await h.waitStable(page, 3000, 150000);
        let st = await machineState(page);
        h.check("RT-11 boots from the gallery as rk1.dsk", booted &&
            (await h.outputContains(page, ".")) &&
            st.mounted.indexOf("rk1.dsk") !== -1,
            JSON.stringify(st));

        // ---- 2. Unmount the medium ----------------------------------------
        await gotoStorage(page);
        h.check("Unmount of the boot medium is offered",
            (await unmount(page, "rk1.dsk")) === "ok");
        await sleep(1200);
        st = await machineState(page);
        h.check("Unmount takes the medium out of the machine",
            st.mounted.length === 0 && st.mountedOptions.indexOf("rk1.dsk") === -1,
            JSON.stringify(st));

        // ---- 3. REBOOT with the "last medium" preset ----------------------
        let mark = await outputMark(page);
        await reboot(page, "last");
        h.check("REBOOT after Unmount streams the bundled medium again",
            await waitForOutput(page, mark, "RT-11SJ", 60000),
            "output: " + JSON.stringify((await outputSince(page, mark)).slice(-160)));
        st = await machineState(page);
        h.check("the re-streamed image is mounted again",
            st.mounted.indexOf("rk1.dsk") !== -1 &&
            st.sources.indexOf("rk1.dsk:network") !== -1,
            JSON.stringify(st));
        h.check("the CPU runs instead of halting at address 2",
            st.pc !== "2" && st.runState !== 3, JSON.stringify(st));
        await selectMounted(page, "rk1.dsk");
        h.check("a bundled medium cannot be deleted",
            (await machineState(page)).deleteEnabled === false,
            JSON.stringify(await machineState(page)));

        // ---- 4. REBOOT to '@' and BOOT RK1 by hand ------------------------
        await gotoStorage(page);
        await unmount(page, "rk1.dsk");
        await sleep(800);
        mark = await outputMark(page);
        await reboot(page, "interactive@");
        h.check("REBOOT after Unmount reaches the interactive loader",
            await waitForOutput(page, mark, "@", 30000),
            "output: " + JSON.stringify(await outputSince(page, mark)));
        await h.typeOnKeyboard(page, "BOOT RK1");
        h.check("manual BOOT RK1 after Unmount boots the guest again",
            await waitForOutput(page, mark, "RT-11SJ", 60000),
            "output: " + JSON.stringify((await outputSince(page, mark)).slice(-160)));

        // ---- 5. imported image: no server copy ----------------------------
        // A dropped image lives only in IndexedDB, so after Unmount it cannot
        // be re-streamed. The operator must be told (dialog), not left with a
        // halted CPU.
        await gotoStorage(page);
        const input = await page.$("#drop-file-input");
        if (!input) throw new Error("drop file input is missing on Storage");
        await input.uploadFile(tmpFile);
        h.check("a dropped image appears in the mounted list",
            await h.waitFor(async () =>
                (await machineState(page)).mounted.indexOf(LOCAL_IMAGE) !== -1, 30000),
            JSON.stringify(await machineState(page)));
        const bound = await bindDrive(page, LOCAL_IMAGE, LOCAL_DRIVE);
        await sleep(500);
        st = await machineState(page);
        h.check("the dropped image binds to a drive",
            bound === "ok" && st.mountMap[LOCAL_DRIVE] === LOCAL_IMAGE,
            bound + " " + JSON.stringify(st.mountMap));
        h.check("the dropped image can be unmounted",
            (await unmount(page, LOCAL_IMAGE)) === "ok");
        await sleep(1000);

        mark = await outputMark(page);
        await reboot(page, "interactive@");
        await waitForOutput(page, mark, "@", 30000);
        await h.typeOnKeyboard(page, "BOOT " + LOCAL_DRIVE.toUpperCase());
        h.check("booting an unmounted local image reports a missing image",
            await h.waitFor(async () => (await machineState(page)).imageErrorShown, 30000),
            "state: " + JSON.stringify(await machineState(page)));

        // ---- 6. the stored copy survived Unmount --------------------------
        await page.reload({ waitUntil: "load", timeout: 90000 });
        await page.waitForFunction(() => typeof window.switchPage === "function",
            { timeout: 30000 });
        await h.installHooks(page);
        h.check("the imported image is still stored after Unmount + reload",
            await h.waitFor(async () =>
                (await machineState(page)).mounted.indexOf(LOCAL_IMAGE) !== -1, 30000),
            JSON.stringify(await machineState(page)));

        // ---- 7. Delete image — the explicit, confirmed erase ---------------
        await gotoStorage(page);
        h.check("the stored image can be selected",
            (await selectMounted(page, LOCAL_IMAGE)) === "ok");
        st = await machineState(page);
        h.check("Delete image is offered for an imported image",
            st.deleteEnabled === true, JSON.stringify(st));
        await page.evaluate(() => document.getElementById("mounted-delete").click());
        h.check("Delete asks for confirmation",
            await h.waitFor(async () => (await machineState(page)).deleteDialogShown, 5000),
            JSON.stringify(await machineState(page)));
        await page.evaluate(() => document.getElementById("imagedelete-confirm").click());
        h.check("the deleted image leaves the mounted list",
            await h.waitFor(async () =>
                (await machineState(page)).mounted.indexOf(LOCAL_IMAGE) === -1, 15000),
            JSON.stringify(await machineState(page)));
        h.check("the deleted image loses its drive binding",
            (await machineState(page)).mountMap[LOCAL_DRIVE] === undefined,
            JSON.stringify(await machineState(page)));

        await page.reload({ waitUntil: "load", timeout: 90000 });
        await page.waitForFunction(() => typeof window.switchPage === "function",
            { timeout: 30000 });
        await h.installHooks(page);
        await page.evaluate(() => (window.__yapdpImagesReady &&
            typeof window.__yapdpImagesReady.whenReady === "function")
            ? window.__yapdpImagesReady.whenReady(5000) : null);
        await sleep(1000);
        st = await machineState(page);
        h.check("a deleted image does not come back after a reload",
            st.mountedOptions.indexOf(LOCAL_IMAGE) === -1, JSON.stringify(st));
    } finally {
        await browser.close();
        if (server) server.kill();
        try { fs.unlinkSync(tmpFile); } catch (err) { /* ignore */ }
    }

    const failures = h.failureCount();
    console.log(failures === 0
        ? "unmount-reboot: all checks passed"
        : `unmount-reboot: ${failures} check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("unmount-reboot: FAILED —", err && err.message);
    process.exit(1);
});
