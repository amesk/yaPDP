#!/usr/bin/env node
/**
 * Model 33 ASR paper-tape end-to-end test (puppeteer + real Chromium).
 *
 * The companion to e2e-teletype.js: that suite covers the keyboard / CCU
 * mechanics, this one covers the PAPER TAPE — the ASR's whole reason to
 * exist. RT-11 is booted through the quick-boot wizard on the teletype
 * console, then the tape path is exercised exactly like an operator would:
 *
 *   1. tape input: a .ptap/.txt tape loaded into the READER feeds its bytes
 *      to the guest in START mode (the guest executes a command off tape).
 *   2. LOCAL tape-to-tape copy: reader + punch in LOCAL duplicate a tape
 *      without the machine seeing a byte (and print it on paper).
 *   3. LINE tape-to-tape copy: the read bytes go to the guest AND the
 *      echo punches a fresh tape at the same time.
 *   4. BSP + DELETE: BSP backs the punch head up one row and the next byte
 *      overpunches in place; RUB OUT turns the row into DEL (all tracks).
 *   5. automatic NUL lead-in: a fresh tape (tear-off) starts with 6 blank
 *      NUL rows (feed holes only — historic practice; RUB OUT leaders were
 *      bad, the dense hole pattern made the tape tear on loading), and the
 *      data rows follow on top.
 *   6. computer-driven punch: DC2 (0x12) from the machine engages the
 *      punch, output bytes punch rows, DC4 (0x14) disengages — punching
 *      the automatic NUL trailer first; the control bytes are never
 *      printed themselves.
 *   6a. bare tape: disengaging the punch (OFF button or DC4) when nothing
 *      was punched after the automatic NUL lead-in adds NO trailer — the
 *      lead-in alone does not count as punched data, so a bare tape stays
 *      bare (regression test for the bare-tape trailer fix).
 *   7. AUTO reader + X-ON/X-OFF: DC3 pauses the auto-fed reader, DC1
 *      resumes it (the guest drives the tape flow).
 *   8. HERE IS: the answerback drum taps CR LF ACK "PDP-11/70" CR LF into
 *      the line in LINE, prints it locally in LOCAL, stays silent in OFF.
 *   9. full keyboard layout: EVERY key x {base, SHIFT, CTRL, CTRL+SHIFT}
 *      is pressed through the real mousedown/mouseup path and the byte
 *      that reaches dlReceiveQueue is compared to the layout model
 *      (catches mis-mapped keys, wrong shift legends, broken CTRL codes —
 *      incl. the bit-paired CTRL+SHIFT+P = NUL).
 *  10. Save tape: the punched tape downloads as a .ptap byte-exact,
 *      including the automatic NUL lead-in.
 *
 * Run with:  node tests/e2e-teletype-tape.js
 * (needs puppeteer; starts the dev server itself if :1170 is not serving)
 */
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..");
const PORT = 1170;
const BASE = `http://127.0.0.1:${PORT}`;

const CFG = {
    consoleType: "teletype",
    userTerminals: 0,
    printer: true,           // must EXACTLY match the rk1 (RT-11) wizard
    vt11: false,             // scenario hardware block or the wizard reloads
    teletypeSpeed: "fast",   // ~30ms/char instead of authentic ~100ms
    powerOn: true,
    autoBoot: false          // the wizard issues the boot itself
};

let failures = 0;

// --- helpers (same infra as e2e-teletype.js) -------------------------------

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeout) {
    const startedAt = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - startedAt > timeout) return false;
        await sleep(200);
    }
}

function serverAlive() {
    return new Promise((resolve) => {
        const req = http.get(`${BASE}/pdp11.html`, (res) => {
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
        path.join(ROOT, "tools", "serve.js"),
        "--port", String(PORT)
    ], { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        if (await serverAlive()) return child;
        await sleep(200);
    }
    child.kill();
    throw new Error(`Static server did not start on port ${PORT}`);
}

async function openPage(browser) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.evaluateOnNewDocument((seed) => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, CFG);

    // E2E_CORE=1 exercises the refactored machine layer (?core=1).
    const coreParam = process.env.E2E_CORE ? "core=1&" : "";
    await page.goto(`${BASE}/pdp11.html?${coreParam}cfg=teletype`, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => typeof window.switchPage === "function",
        { timeout: 30000 });

    await page.evaluate(() => {
        if (window.__osHooksInstalled) return;
        window.__osHooksInstalled = true;
        window.__osShotOutput = "";
        const genHook = window.__consoleOutputHook;
        window.__consoleOutputHook = function (ch) {
            if (typeof genHook === "function") genHook(ch);
            window.__osShotOutput += String.fromCharCode(ch & 0x7F);
            if (window.__osShotOutput.length > 8192) {
                window.__osShotOutput = window.__osShotOutput.slice(-8192);
            }
        };
    });

    return page;
}

async function launchDevice(page, device) {
    await page.evaluate(() => {
        const btn = document.getElementById("quick-boot-btn");
        if (btn) btn.click();
    });
    await sleep(500);
    const clicked = await page.evaluate((d) => {
        const opt = document.querySelector(
            '.quickboot-option[data-quickboot-device="' + d + '"]');
        if (opt) { opt.click(); return true; }
        return false;
    }, device);
    if (!clicked) throw new Error(`quick-boot option not found for ${device}`);
}

async function outputContains(page, needle) {
    return page.evaluate((n) => {
        return !!(window.__osShotOutput &&
            window.__osShotOutput.indexOf(n) !== -1);
    }, needle);
}

async function outputLength(page) {
    return page.evaluate(() => (window.__osShotOutput || "").length);
}

async function waitStable(page, stableMs, timeout) {
    const startedAt = Date.now();
    let last = await outputLength(page);
    let lastChanged = Date.now();
    while (Date.now() - startedAt < timeout) {
        await sleep(500);
        const len = await outputLength(page);
        if (len !== last) {
            last = len;
            lastChanged = Date.now();
        } else if (Date.now() - lastChanged >= stableMs) {
            return true;
        }
    }
    return false;
}

function paperText(page) {
    return page.evaluate(() => {
        const el = document.getElementById("paper_printarea");
        return el ? el.textContent.replace(/\u00A0/g, " ") : "";
    });
}

function paperCount(page, needle) {
    return page.evaluate((n) => {
        const el = document.getElementById("paper_printarea");
        const txt = el ? el.textContent.replace(/\u00A0/g, " ") : "";
        return (txt.match(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    }, needle);
}

async function pressKey(page, key) {
    return page.evaluate((k) => {
        const keys = document.querySelectorAll("#punchkeyboard .m33-key, #punchkeyboard .m33-space");
        const fire = (el) => {
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        };
        for (const el of keys) {
            const d = el._def;
            if (!d || d.special) continue;
            if (k.code !== undefined && d.code === k.code) { fire(el); return true; }
            if (k.label !== undefined && d.label === k.label) { fire(el); return true; }
        }
        for (const el of keys) {
            const d = el._def;
            if (!d || d.special) continue;
            if (k.code !== undefined && d.shiftCode === k.code) {
                for (const s of keys) {
                    if (s._def && s._def.special === "shift") { fire(s); break; }
                }
                fire(el);
                return true;
            }
        }
        return false;
    }, key);
}

async function pressSpecial(page, special) {
    return page.evaluate((s) => {
        const keys = document.querySelectorAll("#punchkeyboard .m33-key, #punchkeyboard .m33-space");
        for (const el of keys) {
            const d = el._def;
            if (d && d.special === s) {
                el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                return true;
            }
        }
        return false;
    }, special);
}

async function typeOnKeyboard(page, text) {
    for (const ch of text) {
        if (ch === " ") {
            const ok = await pressSpecial(page, "space");
            if (!ok) throw new Error("no SPACE bar on the on-screen keyboard");
        } else {
            const ok = await pressKey(page, { code: ch.charCodeAt(0) });
            if (!ok) throw new Error(`no on-screen key for character ${JSON.stringify(ch)}`);
        }
        await sleep(20);
    }
    const ok = await pressSpecial(page, "cr");
    if (!ok) throw new Error("no RETURN key on the on-screen keyboard");
}

// --- tape-specific helpers --------------------------------------------------

// Punched rows currently on the output tape (#punchtape__body).
// Automatic NUL lead-in/trailer length, read from the live page (the
// punchtape.js TAPE_LEADER constant) — tests never hard-code it, so the
// value can change without breaking the suite.
async function tapeLeader(page) {
    return page.evaluate(() =>
        (window.paperTape && window.paperTape.TAPE_LEADER) || 6);
}

function tapeRows(page) {    return page.evaluate(() => {
        const el = document.getElementById("punchtape__body");
        return el ? el.childElementCount : 0;
    });
}

// Rows still left on the reader tape (#readertape__body).
function readerRows(page) {
    return page.evaluate(() => {
        const el = document.getElementById("readertape__body");
        return el ? el.childElementCount : 0;
    });
}

function readerHasTape(page) {
    return page.evaluate(() =>
        !!(window.tapeReader && window.tapeReader.hasTape()));
}

// Punch-track pattern of the row at 0-based index `i` counting from the
// BOTTOM of the output tape (index 0 = the FIRST punched byte). The fresh
// rows are prepended at the top (the tape hangs from the punch head), so
// DOM order is newest-first; the helper flips it back to chronological.
function tapeRowTracks(page, i) {
    return page.evaluate((idx) => {
        const el = document.getElementById("punchtape__body");
        if (!el) return null;
        const row = el.children[el.childElementCount - 1 - idx];
        if (!row) return null;
        const holes = row.querySelectorAll(".pt-hole.on");
        const all = row.querySelectorAll(".pt-hole");
        const tracks = [];
        for (const h of all) tracks.push(h.classList.contains("on") ? 1 : 0);
        return { tracks, holes: holes.length };
    }, i);
}

// Load a tape file into the READER through the real file-input path.
async function loadTape(page, filePath) {
    const input = await page.$("#tty-tape-file");
    if (!input) throw new Error("no #tty-tape-file input");
    await input.uploadFile(filePath);
    await sleep(400); // FileReader + loadBytes + setReaderMode('stop')
    if (!await readerHasTape(page)) {
        throw new Error("tape did not load: " + path.basename(filePath));
    }
}

async function setReaderMode(page, mode) {
    return page.evaluate((m) => {
        const btn = document.querySelector('[data-reader-mode="' + m + '"]');
        if (btn) { btn.click(); return true; }
        return false;
    }, mode);
}

async function setTtyMode(page, mode) {
    return page.evaluate((m) => {
        const btn = document.querySelector('[data-tty-mode="' + m + '"]');
        if (btn) { btn.click(); return true; }
        return false;
    }, mode);
}

async function punchOn(page) {
    await page.evaluate(() => {
        const btn = document.getElementById("punch-on");
        if (btn) btn.click();
    });
    await sleep(200);
}

async function punchOff(page) {
    await page.evaluate(() => {
        const btn = document.getElementById("punch-off");
        if (btn) btn.click();
    });
    await sleep(200);
}

// Clear the output tape (operator pulls the punched tape out).
async function tapeClear(page) {
    await page.evaluate(() => {
        if (window.paperTape && typeof window.paperTape.clear === "function") {
            window.paperTape.clear();
        }
    });
    await sleep(100);
}

// Wait until the paper stops growing (the print queue drains; output-length
// stability is NOT enough — paper renders behind the generation hook).
async function waitPaperStable(page, stableMs, timeout) {
    const startedAt = Date.now();
    let last = (await paperText(page)).length;
    let lastChanged = Date.now();
    while (Date.now() - startedAt < timeout) {
        await sleep(stableMs);
        const len = (await paperText(page)).length;
        if (len !== last) {
            last = len;
            lastChanged = Date.now();
        } else if (Date.now() - lastChanged >= stableMs) {
            return true;
        }
    }
    return false;
}

function check(name, cond, extra) {
    if (cond) {
        console.log("PASS: " + name);
    } else {
        failures++;
        console.log("FAIL: " + name + (extra ? " — " + extra : ""));
    }
}

// --- main -------------------------------------------------------------------

async function main() {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    // Tape fixtures in a temp dir.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ttytape-"));
    const tapeDir = path.join(tmp, "dir-sys.txt");       // "DIR SYS*.*\r"
    const tapeHello = path.join(tmp, "hello.txt");       // "HELLO"
    const tapeAbcdef = path.join(tmp, "abcdef.txt");     // "ABCDEFGH"
    fs.writeFileSync(tapeDir, "DIR SYS*.*\r");
    fs.writeFileSync(tapeHello, "HELLO");
    fs.writeFileSync(tapeAbcdef, "ABCDEFGH");

    try {
        const page = await openPage(browser);

        // ---- 0. Boot -----------------------------------------------------
        await launchDevice(page, "rk1");
        if (!await waitStable(page, 2500, 120000)) {
            throw new Error("RT-11 did not reach its prompt (output: " +
                JSON.stringify(await page.evaluate(() =>
                    (window.__osShotOutput || "").slice(-200))) + ")");
        }
        check("boot output reaches the \".\" prompt (generated)",
            await outputContains(page, "."));

        // ---- 1. Tape input: guest executes a command off the tape -------
        await loadTape(page, tapeDir);
        const before = await paperCount(page, "Free blocks");
        await setReaderMode(page, "start");
        check("START mode reads the tape into the guest",
            await waitFor(async () =>
                (await paperCount(page, "Free blocks")) > before, 60000),
            "Free blocks: " + (await paperCount(page, "Free blocks")));
        check("tape fully consumed by the reader",
            await waitFor(async () => !await readerHasTape(page), 15000),
            "readerRows=" + (await readerRows(page)));

        // ---- 2. LOCAL tape-to-tape copy ----------------------------------
        await setTtyMode(page, "local");
        await punchOn(page);
        await tapeClear(page);
        await loadTape(page, tapeHello);
        const outBefore = await outputLength(page);
        const paperBefore = (await paperText(page)).length;
        await setReaderMode(page, "start");
        check("LOCAL copy punches the read bytes onto a fresh tape",
            await waitFor(async () => (await tapeRows(page)) >= 5, 15000),
            "tapeRows=" + (await tapeRows(page)));
        check("LOCAL copy prints the tape on paper",
            await waitFor(async () =>
                (await paperText(page)).indexOf("HELLO") !== -1, 15000),
            "paper tail: " + JSON.stringify((await paperText(page)).slice(-40)));
        await sleep(500); // let any stray byte settle
        check("LOCAL copy never reaches the guest",
            (await outputLength(page)) === outBefore,
            "output: " + outBefore + " -> " + (await outputLength(page)));

        // ---- 3. LINE tape-to-tape copy (echo punches) --------------------
        await setTtyMode(page, "line");
        await loadTape(page, tapeDir);
        const rowsBefore3 = await tapeRows(page);
        const before3 = await paperCount(page, "Free blocks");
        await setReaderMode(page, "start");
        check("LINE copy delivers the tape to the guest",
            await waitFor(async () =>
                (await paperCount(page, "Free blocks")) > before3, 60000));
        check("LINE copy punches the guest echo onto the tape",
            await waitFor(async () => (await tapeRows(page)) > rowsBefore3, 60000),
            "tapeRows: " + rowsBefore3 + " -> " + (await tapeRows(page)));
        await punchOff(page);

        // ---- 4. BSP + DELETE: overpunch and RUB OUT ----------------------
        // Printing is paced (~30ms/char): the punch follows the RENDER, so
        // every step waits for the tape rows to settle before the next one.
        // A fresh tape starts with the automatic NUL rows (TAPE_LEADER), so
        // all row counts below are offset by it (data rows sit on top of the
        // leader; tapeRowTracks indexes from the BOTTOM of the tape).
        const leader = await tapeLeader(page);
        await setTtyMode(page, "local"); // keep the garbage off the line
        await punchOn(page);
        await tapeClear(page);
        await pressKey(page, { code: "A".charCodeAt(0) });
        await waitFor(async () => (await tapeRows(page)) === leader + 1, 10000);
        await pressKey(page, { code: "B".charCodeAt(0) });
        await waitFor(async () => (await tapeRows(page)) === leader + 2, 10000);
        await page.evaluate(() => {
            const btn = document.getElementById("punch-bsp");
            if (btn) btn.click();
        });
        await sleep(100); // BSP is instant; C below goes through the print queue
        await pressKey(page, { code: "C".charCodeAt(0) }); // overpunches B
        await waitFor(async () => (await tapeRows(page)) === leader + 2, 10000);
        await pressSpecial(page, "del");                  // RUB OUT -> new DEL row
        await waitFor(async () => (await tapeRows(page)) === leader + 3, 10000);
        const rowA = await tapeRowTracks(page, leader);
        const rowBC = await tapeRowTracks(page, leader + 1);
        const rowDel = await tapeRowTracks(page, leader + 2);
        const A = 0x41, BC = 0x41 | 0x43, DEL = 0x7F;
        check("BSP row exists after A, B, BSP, C, RUBOUT (3 data rows + leader)",
            rowA && rowBC && rowDel, "rows=" + (await tapeRows(page)));
        check("first row is A (0x41)",
            rowA && rowA.tracks.join("") === (await page.evaluate((c) =>
                window.paperTape.encodePunch(c).join(""), A)),
            JSON.stringify(rowA && rowA.tracks));
        check("BSP overpunch merged B and C (0x41|0x43)",
            rowBC && rowBC.tracks.join("") === (await page.evaluate((c) =>
                window.paperTape.encodePunch(c).join(""), BC)),
            JSON.stringify(rowBC && rowBC.tracks));
        check("RUB OUT punched an all-tracks DEL row",
            rowDel && rowDel.holes === 7,
            "holes=" + (rowDel && rowDel.holes));

        // ---- 5. Automatic NUL lead-in ------------------------------------
        // Historic practice: lead-in is NUL (0x00) — blank rows with only
        // the feed holes. RUB OUT leaders were avoided: the dense hole
        // pattern made the tape mechanically weak and it tore on loading.
        // A fresh tape (tear-off / clear) automatically starts with
        // TAPE_LEADER blank NUL rows, punched silently by the machine.
        await tapeClear(page);
        const autoRows = await tapeRows(page);
        let leadInOk = autoRows === leader;
        for (let i = 0; i < leader; i++) {
            const r = await tapeRowTracks(page, i);
            if (!r || r.holes !== 0) { leadInOk = false; break; }
        }
        await pressKey(page, { code: "X".charCodeAt(0) });
        await waitFor(async () => (await tapeRows(page)) === leader + 1, 10000);
        const rowX = await tapeRowTracks(page, leader);
        check("automatic lead-in: " + leader + " NUL rows are blank (feed holes only)",
            leadInOk, "rows=" + autoRows);
        check("lead-in followed by the data row X (0x58)",
            rowX && rowX.tracks.join("") === (await page.evaluate((c) =>
                window.paperTape.encodePunch(c).join(""), 0x58)),
            JSON.stringify(rowX && rowX.tracks));
        await punchOff(page);

        // ---- 6. Computer-driven punch: DC2 engages, DC4 disengages ------
        await setTtyMode(page, "line");
        await tapeClear(page);
        const rowsBefore6 = await tapeRows(page); // leader (auto lead-in)
        await page.evaluate(() => window.g60ConsoleWrite(0x12)); // DC2
        await page.evaluate(() => {
            window.g60ConsoleWrite(0x48); // 'H'
            window.g60ConsoleWrite(0x49); // 'I'
        });
        // The punch follows the paced render: wait for H and I to punch
        // BEFORE sending DC4 (otherwise the punch is already off when the
        // render fires and the rows are lost).
        check("DC2 engages the punch, output punches rows",
            await waitFor(async () =>
                (await tapeRows(page)) === rowsBefore6 + 2, 10000),
            "rows: " + rowsBefore6 + " -> " + (await tapeRows(page)));
        const paperBefore6 = (await paperText(page)).length;
        await page.evaluate(() => window.g60ConsoleWrite(0x14)); // DC4
        // DC4 punches the automatic NUL trailer (TAPE_LEADER) before the
        // punch stops: the tape gets its blank mechanical tail.
        const rowsAfterDc4 = await tapeRows(page);
        check("DC4 punches the automatic NUL trailer",
            rowsAfterDc4 === rowsBefore6 + 2 + leader,
            "rows: " + rowsBefore6 + " +2 -> DC4 -> " + rowsAfterDc4);
        await page.evaluate(() => window.g60ConsoleWrite(0x58)); // 'X'
        await sleep(600); // let X render (it must NOT punch)
        const punchOnFlag = await page.evaluate(() => window.ttyPunchEnabled);
        check("DC4 disengages the punch (X is not punched)",
            punchOnFlag === false && (await tapeRows(page)) === rowsAfterDc4,
            "ttyPunchEnabled=" + punchOnFlag +
                " rows: " + rowsAfterDc4 + " -> " + (await tapeRows(page)));
        const paperText6 = await paperText(page);
        check("DC2/DC4 control bytes are not printed on the paper",
            paperText6.length - paperBefore6 === 1 &&  // only the X rendered
            paperText6.indexOf("\u0012") === -1 &&
            paperText6.indexOf("\u0014") === -1,
            "paper delta: " + (paperText6.length - paperBefore6));

        // ---- 6a. Bare tape: disengage adds no NUL trailer ---------------
        // A fresh tape holds exactly the automatic TAPE_LEADER NUL lead-in
        // and nothing else. Disengaging the punch (OFF button, then DC4)
        // must NOT append the NUL trailer when nothing was punched after
        // the lead-in — a bare tape stays bare (the lead-in alone does not
        // count as punched data).
        await setTtyMode(page, "line");
        await tapeClear(page);
        const bareRows = await tapeRows(page);
        check("bare tape holds exactly the TAPE_LEADER lead-in rows",
            bareRows === leader, "rows=" + bareRows);
        await punchOff(page); // OFF button: nothing punched -> no trailer
        const bareRowsAfterOff = await tapeRows(page);
        check("OFF on a bare tape adds no NUL trailer",
            bareRowsAfterOff === bareRows,
            "rows: " + bareRows + " -> " + bareRowsAfterOff);
        await page.evaluate(() => window.g60ConsoleWrite(0x12)); // DC2 engage
        await sleep(300); // punch arms; no output -> no rows
        await page.evaluate(() => window.g60ConsoleWrite(0x14)); // DC4
        await sleep(300);
        const bareRowsAfterDc4 = await tapeRows(page);
        check("DC4 on a bare tape adds no NUL trailer",
            bareRowsAfterDc4 === bareRows,
            "rows: " + bareRows + " -> " + bareRowsAfterDc4);

        // ---- 7. AUTO reader: DC3 pauses, DC1 resumes ---------------------
        await loadTape(page, tapeAbcdef);
        await setReaderMode(page, "auto");
        await page.evaluate(() => window.g60ConsoleWrite(0x13)); // X-OFF first
        await page.evaluate(() => window.g60ConsoleWrite(0x11)); // X-ON
        check("AUTO reader starts feeding on X-ON",
            await waitFor(async () => (await readerRows(page)) < 8, 10000),
            "readerRows=" + (await readerRows(page)));
        await page.evaluate(() => window.g60ConsoleWrite(0x13)); // X-OFF
        await sleep(300);
        const pausedRows = await readerRows(page);
        await sleep(1500);
        check("X-OFF pauses the reader",
            (await readerRows(page)) === pausedRows,
            "readerRows: " + pausedRows + " -> " + (await readerRows(page)));
        await page.evaluate(() => window.g60ConsoleWrite(0x11)); // X-ON
        check("X-ON resumes the reader",
            await waitFor(async () => !await readerHasTape(page), 10000),
            "readerRows=" + (await readerRows(page)));

        // ---- 8. HERE IS (answerback drum) --------------------------------
        await setTtyMode(page, "line");
        await pressSpecial(page, "hereis");
        check("HERE IS reaches the guest in LINE",
            await waitFor(async () =>
                await outputContains(page, "PDP-11/70"), 15000),
            "output tail: " + JSON.stringify(await page.evaluate(() =>
                (window.__osShotOutput || "").slice(-80))));
        await setTtyMode(page, "local");
        await waitStable(page, 1000, 5000); // let the LINE echo tail settle
        const outBefore8 = await outputLength(page);
        const paperBefore8 = (await paperText(page)).length;
        await pressSpecial(page, "hereis");
        check("HERE IS prints locally in LOCAL",
            await waitFor(async () =>
                (await paperText(page)).indexOf("PDP-11/70") !== -1, 10000),
            "paper tail: " + JSON.stringify((await paperText(page)).slice(-40)));
        check("HERE IS does not reach the guest in LOCAL",
            (await outputLength(page)) === outBefore8,
            "output: " + outBefore8 + " -> " + (await outputLength(page)));
        await setTtyMode(page, "off");
        await sleep(300);
        await waitStable(page, 1000, 5000); // let the LINE echo tail settle
        await waitPaperStable(page, 600, 8000); // ...and the LOCAL print tail
        const outBefore8b = await outputLength(page);
        const hereisBefore8b = await paperCount(page, "PDP-11/70");
        await pressSpecial(page, "hereis");
        await sleep(1000);
        check("HERE IS is silent in OFF",
            (await outputLength(page)) === outBefore8b &&
            (await paperCount(page, "PDP-11/70")) === hereisBefore8b,
            "output grew? " + ((await outputLength(page)) - outBefore8b) +
                " | PDP-11/70 count: " + hereisBefore8b +
                " -> " + (await paperCount(page, "PDP-11/70")));
        await setTtyMode(page, "line");

        // ---- 9. Full keyboard layout --------------------------------------
        const layout = await page.evaluate(() => {
            if (typeof window.model33KeyCode !== "function") {
                return { error: "model33KeyCode not global" };
            }
            // Collect bytes the keyboard sends, WITHOUT forwarding to the
            // guest (this is the last check; RT-11 must not see 200 keys).
            const got = [];
            window.dlReceiveQueue = function (unit, bytes) {
                for (const b of bytes) got.push(b & 0x7F);
            };
            const keys = document.querySelectorAll(
                "#punchkeyboard .m33-key, #punchkeyboard .m33-space");
            const fire = (el) => {
                el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            };
            const fireSpecial = (s) => {
                for (const el of keys) {
                    if (el._def && el._def.special === s) { fire(el); return; }
                }
            };
            const results = [];
            for (const el of keys) {
                const def = el._def;
                if (!def) continue;
                // Specials that send a byte (SPACE/ESC/LF/CR/DEL): base only.
                if (def.special) {
                    if (def.code == null) continue;
                    if (def.special !== "space" && def.special !== "esc" &&
                        def.special !== "lf" && def.special !== "cr" &&
                        def.special !== "del") continue;
                    got.length = 0;
                    fire(el);
                    const exp = def.code & 0x7F;
                    results.push({
                        label: def.label, base: got[0] !== undefined ? got[0] : -1,
                        expBase: exp, ok: got[0] === exp
                    });
                    continue;
                }
                const states = [
                    { name: "base", shifted: false, ctrl: false },
                    { name: "shift", shifted: true, ctrl: false },
                    { name: "ctrl", shifted: false, ctrl: true },
                    { name: "ctrlShift", shifted: true, ctrl: true }
                ];
                const row = { label: def.label, ok: true };
                for (const st of states) {
                    got.length = 0;
                    if (st.shifted) fireSpecial("shift");
                    if (st.ctrl) fireSpecial("ctrl");
                    fire(el);
                    const exp = window.model33KeyCode(def, st);
                    const act = got[0] !== undefined ? got[0] : -1;
                    row[st.name] = act;
                    row["exp" + st.name] = exp;
                    if (act !== exp) row.ok = false;
                }
                results.push(row);
            }
            return { results, count: results.length };
        });
        if (layout.error) {
            check("keyboard layout checked", false, layout.error);
        } else {
            const bad = layout.results.filter((r) => !r.ok);
            check("keyboard layout: " + layout.count + " keys x modifiers",
                bad.length === 0,
                bad.slice(0, 6).map((r) =>
                    r.label + " [" + ["base", "shift", "ctrl", "ctrlShift"]
                        .map((m) => r[m] + "!=" + r["exp" + m])
                        .filter((_, i) => {
                            const m = ["base", "shift", "ctrl", "ctrlShift"][i];
                            return r[m] !== r["exp" + m];
                        }).join(",") + "]").join(" | "));
            // sanity: the bit-paired NUL is producible (CTRL+SHIFT+P = 0x00)
            const nulKey = layout.results.find((r) => r.label === "P");
            check("CTRL+SHIFT+P produces the bit-paired NUL (0x00)",
                !!nulKey && nulKey.ctrlShift === 0,
                nulKey ? "ctrlShift=" + nulKey.ctrlShift : "no P key");
        }

        // ---- 10. Save tape: .ptap download is byte-exact ----------------
        await setTtyMode(page, "local");
        await punchOn(page);
        await tapeClear(page);
        // typeOnKeyboard appends a CR — punch the 4 letters directly.
        for (const ch of "SAVE") {
            await pressKey(page, { code: ch.charCodeAt(0) });
            await sleep(40);
        }
        // The tape is the NUL leader rows + the 4 data rows.
        await waitFor(async () =>
            (await tapeRows(page)) === leader + 4, 10000);
        // The puppeteer 'download' event does not fire in this headless
        // Chrome; Page.setDownloadBehavior intercepts the file instead.
        const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttytape-dl-"));
        const cdp = await page.createCDPSession();
        await cdp.send("Page.setDownloadBehavior", {
            behavior: "allow",
            downloadPath: dlDir
        });
        await page.evaluate(() => {
            const btn = document.getElementById("tty-save-tape");
            if (btn) btn.click();
        });
        const dlFile = path.join(dlDir, "teletype-tape.ptap");
        const saved = await waitFor(() => fs.existsSync(dlFile), 15000);
        if (!saved) throw new Error("save-tape download file never appeared");
        const bytes = fs.readFileSync(dlFile);
        // Byte-exact: leader x NUL + "SAVE".
        let leaderOk = bytes.length === leader + 4;
        for (let i = 0; i < leader; i++) {
            if (bytes[i] !== 0x00) { leaderOk = false; break; }
        }
        const dataOk = leaderOk &&
            bytes[leader] === 0x53 && bytes[leader + 1] === 0x41 &&
            bytes[leader + 2] === 0x56 && bytes[leader + 3] === 0x45;
        check("Save tape downloads a byte-exact .ptap (NUL leader + data)",
            dataOk,
            "file=teletype-tape.ptap bytes=" +
                Array.from(bytes).map((b) => b.toString(16)).join(","));
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    console.log(failures === 0
        ? "\nE2E TELETYPE TAPE: ALL CHECKS PASSED"
        : `\nE2E TELETYPE TAPE: ${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error("E2E TELETYPE TAPE ERROR:", e.message);
    process.exit(1);
});
