#!/usr/bin/env node
/**
 * Model 33 ASR teletype end-to-end test (puppeteer + real Chromium).
 *
 * Exercises the console teletype exactly the way an operator would — the
 * page is loaded with the teletype console, RT-11 is booted through the
 * quick-boot wizard, and then the MECHANICS are asserted on the live DOM:
 *
 *   1. boot output is really rendered on the paper (not just generated):
 *      #g60printer paper text contains the boot banner and the "." prompt,
 *      and the render hook (fired per actually-rendered character) counts
 *      hundreds of characters.
 *   2. on-screen keyboard input: clicking D/I/R/SYS etc. echoes on the
 *      paper and the guest executes the command ("FREE BLOCKS" appears).
 *   3. BREAK key: the machine survives an operator break and keeps
 *      accepting input afterwards.
 *   4. punch ON: output is duplicated onto the paper tape
 *      (#punchtape__body grows).
 *   5. CCU OFF: the unit is powered down — a key press neither echoes
 *      nor reaches the guest (output stops growing).
 *   6. Force PDP Output Uppercase: lower-case machine output prints as A-Z on
 *      the paper while the punch keeps the raw byte, and toggling the CONFIG
 *      option applies to the very next character (no reload).
 *
 * The teletype is the most hook-dense part of the emulator (keyboard ->
 * dlReceiveQueue, rendering -> g60printer onChar, prompt-waiting ->
 * __consoleOutputHook, tape drain -> onConsoleInputDrained), so this suite
 * is the regression net for the headless-machine refactor of iopage.js.
 *
 * Run with:  node tests/e2e-teletype.js
 * (needs puppeteer; starts the dev server itself if :1170 is not serving)
 */
"use strict";

const puppeteer = require("puppeteer");

const {
    check,
    failureCount,
    sleep,
    waitFor,
    ensureServer,
    openPage,
    launchDevice,
    outputContains,
    outputLength,
    waitStable,
    paperText,
    paperCount,
    pressSpecial,
    typeOnKeyboard,
} = require("./e2e-teletype-harness.js");

async function main() {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    try {
        const page = await openPage(browser);

        // ---- 1. Boot prints on the paper --------------------------------
        await launchDevice(page, "rk1tty");
        if (!await waitStable(page, 2500, 120000)) {
            throw new Error("RT-11 did not reach its prompt (output: " +
                JSON.stringify(await outputTail(page, 200)) + ")");
        }
        check("boot output reaches the \".\" prompt (generated)",
            await outputContains(page, "."));
        // The paper renders at teletype pace (~30ms/char), which lags the
        // generated output — wait until the rendered paper catches up.
        check("boot banner really rendered on the paper",
            await waitFor(async () =>
                (await paperText(page)).indexOf("RT-11") !== -1, 30000),
            "paper starts with: " + JSON.stringify((await paperText(page)).slice(0, 60)));
        check("prompt rendered on the paper",
            await waitFor(async () => {
                const txt = await paperText(page);
                return txt.indexOf("\n.") !== -1 || txt.trimEnd().endsWith(".");
            }, 30000),
            "paper tail: " + JSON.stringify((await paperText(page)).slice(-60)));
        // The "." prompt appears on the paper ahead of the paced render;
        // let the render queue drain before counting (renders are paced at
        // ~30ms/char, so this also covers slower machines).
        await waitFor(async () => {
            const a = await page.evaluate(() => window.__osRenderCount);
            await sleep(400);
            const b = await page.evaluate(() => window.__osRenderCount);
            return b === a;
        }, 15000);
        const renderCount = await page.evaluate(() => window.__osRenderCount);
        check("hundreds of characters actually rendered (render hook)",
            renderCount > 100, "renderCount=" + renderCount);

        // ---- 2. On-screen keyboard: echo + guest executes ---------------
        // DIR SYS*.* prints ~250 chars (~8s at fast speed) — a real command
        // with a distinctive footer we can wait for on the paper.
        const before = await paperCount(page, "FREE BLOCKS");
        await typeOnKeyboard(page, "DIR SYS*.*");
        check("keyboard input echoed on the paper",
            await waitFor(async () =>
                (await paperText(page)).indexOf("DIR SYS*.*") !== -1, 15000),
            "paper tail: " + JSON.stringify((await paperText(page)).slice(-80)));
        check("guest executed the typed command (FREE BLOCKS printed again)",
            await waitFor(async () =>
                (await paperCount(page, "FREE BLOCKS")) > before, 60000),
            "FREE BLOCKS count: " + (await paperCount(page, "FREE BLOCKS")));

        // ---- 3. BREAK key ----------------------------------------------
        const breakOk = await pressSpecial(page, "break");
        check("BREAK key exists on the keyboard", breakOk);
        await sleep(1000);
        const before2 = await paperCount(page, "FREE BLOCKS");
        await typeOnKeyboard(page, "DIR SYS*.*");
        check("machine keeps working after operator BREAK",
            await waitFor(async () =>
                (await paperCount(page, "FREE BLOCKS")) > before2, 60000),
            "FREE BLOCKS count after BREAK: " +
                (await paperCount(page, "FREE BLOCKS")));

        // ---- 4. Punch ON: output duplicated onto the tape ---------------
        await page.evaluate(() => {
            const btn = document.getElementById("punch-on");
            if (btn) btn.click();
        });
        await sleep(300);
        const tapeBefore = await page.evaluate(() => {
            const el = document.getElementById("punchtape__body");
            return el ? el.childElementCount : 0;
        });
        const before3 = await paperCount(page, "FREE BLOCKS");
        await typeOnKeyboard(page, "DIR SYS*.*");
        await waitFor(async () =>
            (await paperCount(page, "FREE BLOCKS")) > before3, 60000);
        await sleep(1500); // let the punch catch up with the print queue
        const tapeAfter = await page.evaluate(() => {
            const el = document.getElementById("punchtape__body");
            return el ? el.childElementCount : 0;
        });
        check("punch ON duplicates output onto the paper tape",
            tapeAfter > tapeBefore,
            "tape rows: " + tapeBefore + " -> " + tapeAfter);

        // ---- 5. CCU OFF: unit powered down ------------------------------
        await page.evaluate(() => {
            const off = document.querySelector('[data-tty-mode="off"]');
            if (off) off.click();
        });
        await sleep(300);
        const ttyMode = await page.evaluate(() => window.ttyMode);
        check("CCU switch moved to OFF", ttyMode === "off", "ttyMode=" + ttyMode);
        const paperLenBefore = (await paperText(page)).length;
        const outLenBefore = await outputLength(page);
        await typeOnKeyboard(page, "ZZZ");
        await sleep(2000);
        const paperLenAfter = (await paperText(page)).length;
        const outLenAfter = await outputLength(page);
        check("key presses do not echo while OFF",
            paperLenAfter === paperLenBefore,
            "paper: " + paperLenBefore + " -> " + paperLenAfter);
        check("no output reaches the guest while OFF",
            outLenAfter === outLenBefore,
            "output: " + outLenBefore + " -> " + outLenAfter);
        // restore LINE for any later manual inspection
        await page.evaluate(() => {
            const line = document.querySelector('[data-tty-mode="line"]');
            if (line) line.click();
        });

        // ---- 6. LOCAL: echo prints, guest does not receive --------------
        await page.evaluate(() => {
            const loc = document.querySelector('[data-tty-mode="local"]');
            if (loc) loc.click();
        });
        await sleep(300);
        const paperLenB2 = (await paperText(page)).length;
        const outLenB2 = await outputLength(page);
        await typeOnKeyboard(page, "HI");
        await sleep(2000);
        const paperLenA2 = (await paperText(page)).length;
        const outLenA2 = await outputLength(page);
        check("LOCAL echoes on the paper",
            paperLenA2 > paperLenB2,
            "paper: " + paperLenB2 + " -> " + paperLenA2);
        check("LOCAL does not deliver to the guest",
            outLenA2 === outLenB2,
            "output: " + outLenB2 + " -> " + outLenA2);
        await page.evaluate(() => {
            const line = document.querySelector('[data-tty-mode="line"]');
            if (line) line.click();
        });

        // ---- 7. Force PDP Output Uppercase (CONFIG, ON by default) ------
        // A real Model 33 ASR print mechanism has no lower-case type: lower-case
        // machine output must reach the PAPER as A-Z, while the punch keeps the
        // raw byte (an ASR punch copies the received code). Toggling the option
        // must apply to the very next character — no reload.
        {
            await page.evaluate(() => {
                if (!window.ttyPunchEnabled) {
                    const on = document.getElementById("punch-on");
                    if (on) on.click();
                }
            });
            await sleep(300);
            // Print on a FRESH page. After a long DIR listing the carriage sits at
            // the right margin, where a character overstrikes the last column
            // instead of growing the paper text (the punch still records it), so
            // the assertion would read an empty delta. Clearing the paper makes
            // the single glyph land on a new sheet, where it is unambiguous.
            const tapeBefore = await page.evaluate(() => {
                if (window.g60printer && window.g60printer.clear) {
                    window.g60printer.clear();
                }
                return window.paperTape.snapshot().buffer.length;
            });
            await page.evaluate(() => window.g60ConsoleWrite(0x61)); // 'a'
            await waitFor(async () =>
                (await paperText(page)).indexOf("A") !== -1, 15000);
            await sleep(1500); // let the punch catch up with the print queue
            const paperDelta = await paperText(page);
            const tapeDelta = await page.evaluate((n) =>
                window.paperTape.snapshot().buffer.slice(n), tapeBefore);
            check("lower-case machine output prints as UPPER CASE on the paper",
                paperDelta.indexOf("A") !== -1 && paperDelta.indexOf("a") === -1,
                "paper: " + JSON.stringify(paperDelta.slice(0, 40)));
            check("the punch keeps the RAW lower-case byte",
                tapeDelta.indexOf(0x61) !== -1 && tapeDelta.indexOf(0x41) === -1,
                "tape delta: " + JSON.stringify(tapeDelta));

            // Off: the next character reaches the paper as lower case (the
            // option is read per printed glyph, so no reload is involved).
            await page.evaluate(() => {
                if (window.g60printer && window.g60printer.clear) {
                    window.g60printer.clear();
                }
                const cb = document.getElementById("config-forceUpperCaseOut");
                if (cb) { cb.checked = false; cb.dispatchEvent(new Event("change")); }
            });
            await page.evaluate(() => window.g60ConsoleWrite(0x62)); // 'b'
            await waitFor(async () =>
                (await paperText(page)).indexOf("b") !== -1, 15000);
            const paperDelta2 = await paperText(page);
            check("the option applies immediately (off: 'b' stays lower case)",
                paperDelta2.indexOf("b") !== -1 && paperDelta2.indexOf("B") === -1,
                "paper: " + JSON.stringify(paperDelta2.slice(0, 40)));
            // Restore the authentic default before any later inspection.
            await page.evaluate(() => {
                const cb = document.getElementById("config-forceUpperCaseOut");
                if (cb) { cb.checked = true; cb.dispatchEvent(new Event("change")); }
            });
        }
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    console.log(failureCount() === 0
        ? "\nE2E TELETYPE: ALL CHECKS PASSED"
        : `\nE2E TELETYPE: ${failureCount()} CHECK(S) FAILED`);
    process.exit(failureCount() === 0 ? 0 : 1);
}

// outputTail helper used in error messages
async function outputTail(page, n) {
    return page.evaluate((count) => (window.__osShotOutput || "").slice(-count), n);
}

main().catch((e) => {
    console.error("E2E TELETYPE ERROR:", e.message);
    process.exit(1);
});
