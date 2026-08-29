#!/usr/bin/env node
/**
 * yaPDP — Diagnostic: manual front-panel bootstrap of RT-11 from rk1.
 *
 * Reproduces the exact "classic way" demo without recording: opens the
 * emulator with the machine POWERED OFF, switches to CONFIG and selects a
 * VT52 operator console (Apply reloads), then goes to the Panel, powers the
 * machine on, toggles in a hand-entered RK05 primary bootstrap via the data
 * switches (LOAD ADRS / DEP / START), and finally prints the VT52 console
 * output so we can see the RT-11 "." prompt and answer DUNGEON.
 *
 * This mirrors the planned capture flow but without recording — it is the
 * quick way to verify the bootstrap words and the panel-toggle mechanics
 * before re-rendering the video clip.
 *
 * Usage:
 *   node tools/_debug-panel-boot.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const consoleWait = require("./console-wait");

const ROOT = path.resolve(__dirname, "..");
const PORT = 11794;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

// Machine profile: powered OFF at startup, teletype console (we switch to
// VT52 on the CONFIG page live, exactly like the planned video).
const CFG = {
    consoleType: "teletype",
    userTerminals: 0,
    printer: true,   // RT-11 scenario enables the LP11 (matches OS_CFG.rk1vt52)
    vt11: false,
    teletypeSpeed: "authentic",
    upperCaseOnly: false,
    powerOn: false,  // the demo starts with the machine powered off
    autoBoot: false
};

// RK05 primary bootstrap for unit 1 (rk1), hand-entered at address 001000
// (the same address the panel sticker says). Mirrors bootrk in
// macro-asm/boot.mac but hardcodes unit 1 (RKDA = 1<<13) instead of taking
// the unit from R3. Reads ONE block (256 words = 512 bytes) into memory 0 —
// the RT-11 secondary loader — and jumps to it. Reading only 512 bytes is
// what keeps the hand-entered loader itself (at 001000) from being
// overwritten by the disk transfer:
//   001000  MOV #177412,R0      ; R0 -> RKDA
//   001004  MOV #020000,(R0)    ; RKDA = unit 1, track 0, sector 0
//   001010  CLR -(R0)           ; R0=177410, RKBA=0 (bus address 0)
//   001012  MOV #-256,-(R0)     ; R0=177406, RKWK=-256 (256 words = 512 bytes)
//   001016  MOV #5,-(R0)        ; R0=177404, RKCS=5 (read + go)
//   001022  TSTB (R0)           ; wait for controller ready
//   001024  BPL .-2             ; loop until ready
//   001026  CLR PC              ; jump to memory 0 (RT-11 secondary loader)
// Optional overrides for A/B experiments (octal): `node _debug-panel-boot.js
// [BOOT_ADDR] [BOOT_WC] [BOOT_R3]`. Defaults reproduce the shipping loader
// (001000, -256, no R3). BOOT_R3 seeds R3 with the unit<<13 value, mirroring
// bootrk's `ash #13., r3`.
const BOOT_ARGS = process.argv.slice(2);
const BOOT_ADDR = BOOT_ARGS[0] ? parseInt(BOOT_ARGS[0], 8) : 0o001000;
const BOOT_WC = BOOT_ARGS[1] ? parseInt(BOOT_ARGS[1], 8) : 0o177400; // -256 words
const BOOT_R3 = BOOT_ARGS[2] ? parseInt(BOOT_ARGS[2], 8) : 0;
const BOOT_DEV = BOOT_ARGS[4] === "rk"; // seed R1/R4 with the "RK" device code
const BOOT_WORDS = [];
if (BOOT_DEV) {
    BOOT_WORDS.push(0o012701, 0o113122);  // MOV #113122,R1 ; "RK" device code
    BOOT_WORDS.push(0o012704, 0o113122);  // MOV #113122,R4 ; "RK" device code
}
if (BOOT_R3) {
    BOOT_WORDS.push(0o012703, BOOT_R3);  // MOV #R3,R3
    BOOT_WORDS.push(0o012700, 0o177412); // MOV #177412,R0
    BOOT_WORDS.push(0o010310);           // MOV R3,(R0) ; DA = unit
} else {
    BOOT_WORDS.push(0o012700, 0o177412); // MOV #177412,R0
    BOOT_WORDS.push(0o012710, 0o020000); // MOV #020000,(R0) ; DA = unit 1
}
BOOT_WORDS.push(0o005040);               // CLR -(R0) ; BA = 0
BOOT_WORDS.push(0o012740, BOOT_WC);      // MOV #WC,-(R0)
BOOT_WORDS.push(0o012740, 0o000005);     // MOV #5,-(R0) ; CS = read+go
BOOT_WORDS.push(0o105710, 0o100376);     // TSTB (R0) / BPL .-2
BOOT_WORDS.push(0o005007);               // CLR PC

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        path.join(ROOT, "tools", "serve.js"), "--port", String(PORT)
    ], { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        if (await serverAlive()) return child;
        await sleep(200);
    }
    child.kill();
    throw new Error("Static server did not start");
}

function findBrowserExecutable() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ].filter(Boolean);
    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

async function waitFor(fn, timeout) {
    const startedAt = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - startedAt > timeout) return false;
        await sleep(200);
    }
}

async function elementCenter(page, selector) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, selector);
}

async function clickSel(page, selector) {
    const clicked = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.click();
        return true;
    }, selector);
    if (!clicked) throw new Error("element not found: " + selector);
    await sleep(250);
}

async function outputText(page) {
    return page.evaluate(() => window.__osShotOutput || "");
}

// Read the panel switch register / display address as octal strings.
async function panelState(page) {
    return page.evaluate(() => ({
        sr: (CPU.switchRegister & 0xFFFF).toString(8).padStart(6, "0"),
        da: (CPU.displayAddress & 0xFFFF).toString(8).padStart(6, "0"),
        pc: (CPU.registerVal[7] & 0xFFFF).toString(8).padStart(6, "0"),
        run: CPU.runState,
        halt: panel.halt,
        power: panel.powerSwitch,
        r0: (CPU.registerVal[0] & 0xFFFF).toString(8).padStart(6, "0")
    }));
}

// Click a panel data/address switch with a given weight. The click toggles
// the corresponding bit of CPU.switchRegister (setSwitch) and moves the
// rocker, exactly as a real operator would.
async function clickDataSwitch(page, weight) {
    await page.evaluate((w) => {
        const el = document.querySelector(`.switch[data-weight="${w}"]`);
        if (el) el.click();
    }, weight);
    await sleep(150);
}

// Set the panel switch register to `value` by flipping only the bits that
// differ from the current state (keeps the rocker movements minimal).
async function setPanelSwitches(page, value) {
    const current = await page.evaluate(() => CPU.switchRegister & 0xFFFF);
    const diff = (current ^ value) & 0xFFFF;
    for (let i = 0; i < 16; i++) {
        if (diff & (1 << i)) await clickDataSwitch(page, i);
    }
    const after = await page.evaluate(() => CPU.switchRegister & 0xFFFF);
    console.log(`      set switches -> want=${value.toString(8).padStart(6, "0")} ` +
        `got=${after.toString(8).padStart(6, "0")}`);
}

// Toggle in the bootstrap: HALT, LOAD ADRS with 001000, DEP each word
// (address auto-increments), then LOAD ADRS 001000 again, ENABLE and START.
async function toggleInBootstrap(page) {
    // HALT the CPU first (ENABLE/HALT switch -> HALT), the classic sequence.
    await clickSel(page, '[data-action="enableHalt"]');
    console.log("    after HALT:", JSON.stringify(await panelState(page)));

    // Load address 001000
    await setPanelSwitches(page, BOOT_ADDR);
    await clickSel(page, '[data-action="loadAdrs"]');
    console.log("    after LOAD ADRS:", JSON.stringify(await panelState(page)));

    // Deposit each word (DEP auto-increments the display address by 2)
    for (let idx = 0; idx < BOOT_WORDS.length; idx++) {
        const word = BOOT_WORDS[idx];
        await setPanelSwitches(page, word);
        await clickSel(page, '[data-action="deposit"]');
        const mem = await page.evaluate((a, i) => ({
            word: CPU.memory[(a >>> 1) + i],
            src: 0
        }), BOOT_ADDR, idx);
        console.log(`    dep[${idx}] @${((BOOT_ADDR + idx * 2) & 0xFFFF).toString(8).padStart(6, "0")} ` +
            `want=${word.toString(8).padStart(6, "0")} ` +
            `mem=${(mem.word & 0xFFFF).toString(8).padStart(6, "0")}`);
        await sleep(200);
    }
    console.log("    after deposits:", JSON.stringify(await panelState(page)));

    // Load start address, flip ENABLE/HALT back to ENABLE, then START.
    await setPanelSwitches(page, BOOT_ADDR);
    await clickSel(page, '[data-action="loadAdrs"]');
    console.log("    before ENABLE:", JSON.stringify(await panelState(page)));
    await clickSel(page, '[data-action="enableHalt"]');
    console.log("    after ENABLE:", JSON.stringify(await panelState(page)));
    await clickSel(page, '[data-action="start"]');
    await sleep(400);
    console.log("    after START:", JSON.stringify(await panelState(page)));
}

async function main() {
    let server = null;
    let browser = null;
    try {
        console.log("[1] starting server...");
        server = await ensureServer();
        const exe = findBrowserExecutable();
        if (!exe) throw new Error("No Edge/Chrome found");
        console.log("[2] launching browser...");
        browser = await puppeteer.launch({
            executablePath: exe,
            headless: "new",
            defaultViewport: VIEWPORT
        });
        const page = await browser.newPage();
        await page.setViewport(VIEWPORT);
        await page.evaluateOnNewDocument((seed) => {
            try {
                // Seed only on the first document; the CONFIG Apply reload
                // persists its own consoleType choice (vt52) via Config.set().
                if (!sessionStorage.getItem("yapdp.seeded.v1")) {
                    sessionStorage.setItem("yapdp.seeded.v1", "1");
                    localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
                }
                localStorage.setItem("yapdp.onboarding.v1", "done");
            } catch (err) { /* ignore */ }
        }, CFG);
        console.log("[3] goto pdp11.html...");
        await page.goto(`${BASE}/pdp11.html`, { waitUntil: "load", timeout: 90000 });
        await page.waitForFunction(() => typeof window.switchPage === "function",
            { timeout: 30000 });
        console.log("[4] installing console hooks...");
        await consoleWait.installConsoleHooks(page);

        // 1. The machine is powered off: show the Panel page.
        console.log("[5] switch to panel (powered off)...");
        await page.evaluate(() => window.switchPage('panel'));
        await sleep(800);

        // 2. CONFIG: select the VT52 operator console and Apply (reloads).
        console.log("[6] switch to config, pick VT52...");
        await page.evaluate(() => window.switchPage('config'));
        await sleep(600);
        await page.evaluate(() => {
            const r = document.querySelector('input[name="consoleType"][value="vt52"]');
            if (r) r.click();
        });
        await sleep(400);
        console.log("[7] apply (reload)...");
        await Promise.all([
            page.waitForNavigation({ waitUntil: "load", timeout: 30000 }).catch(() => {}),
            page.evaluate(() => {
                const b = document.getElementById('config-apply');
                if (b) b.click();
            })
        ]);
        await page.waitForFunction(() => typeof window.switchPage === "function",
            { timeout: 30000 });
        // Reload discarded our hooks — reinstall.
        await consoleWait.installConsoleHooks(page);
        await sleep(800);
        console.log("[8] reload done, hooks reinstalled");

        // Instrument DiskStore.markDirty BEFORE the boot so we can see whether
        // the panel bootstrap or the OS/game it loads writes anything to rk1.
        await page.evaluate(() => {
            window.__diskWrites = [];
            if (typeof DiskStore !== "undefined" && DiskStore.markDirty) {
                const orig = DiskStore.markDirty;
                DiskStore.markDirty = function (controlBlock, block) {
                    if (window.__diskWrites.length === 0 && typeof CPU !== "undefined") {
                        const rd = (a) => (typeof readWordByPhysical === "function"
                            ? (readWordByPhysical(a) & 0xFFFF) : null);
                        window.__firstWrite = {
                            r0: CPU.registerVal[0] & 0xFFFF,
                            r1: CPU.registerVal[1] & 0xFFFF,
                            r2: CPU.registerVal[2] & 0xFFFF,
                            r3: CPU.registerVal[3] & 0xFFFF,
                            r4: CPU.registerVal[4] & 0xFFFF,
                            r5: CPU.registerVal[5] & 0xFFFF,
                            sp: CPU.registerVal[6] & 0xFFFF,
                            pc: CPU.registerVal[7] & 0xFFFF,
                            psw: CPU.PSW,
                            mmuMode: CPU.mmuMode,
                            mmuEnable: CPU.mmuEnable,
                            rkcs: rd(0o17777404), rkwc: rd(0o17777406),
                            rkba: rd(0o17777410), rkda: rd(0o17777412)
                        };
                    }
                    window.__diskWrites.push({
                        url: controlBlock && controlBlock.url,
                        block: block,
                        pc: (typeof CPU !== "undefined")
                            ? (CPU.registerVal[7] & 0xFFFF).toString(8).padStart(6, "0")
                            : "?"
                    });
                    return orig.call(DiskStore, controlBlock, block);
                };
            }
        });
        console.log("[8b] DiskStore.markDirty instrumentation installed");

        // 3. Panel: power the machine on (POWER LOCK -> POWER).
        console.log("[9] switch to panel, power on...");
        await page.evaluate(() => window.switchPage('panel'));
        await sleep(600);
        await clickSel(page, '.lockPanelPos[data-power-state="run"]');
        await sleep(800);
        console.log("[10] power on clicked");

        // Optional experiment (4th arg "1"): simulate the power-on RESET that
        // boot() performs — writePSW(0) + iopage.reset() — to test whether the
        // missing reset is what makes the panel path dirty rk1 block 0.
        if (BOOT_ARGS[3] === "1") {
            await page.evaluate(() => {
                if (typeof writePSW === "function") writePSW(0);
                if (typeof iopage !== "undefined" && iopage.reset) iopage.reset();
                CPU.PIR = 0;
                CPU.registerVal[6] = 0o140000; // stack pointer (as boot() sets SP)
            });
            console.log("[10b] simulated reset (PSW+iopage+PIR+SP)");
        }

        // 4. Toggle in the bootstrap loader on the front panel.
        console.log("[11] toggling in bootstrap...");
        await toggleInBootstrap(page);
        console.log("[12] bootstrap toggled in");

        // 5. Switch to the VT52 console and wait for RT-11's "." prompt.
        console.log("[13] switch to vt52 console, waiting for '.'...");
        await page.evaluate(() => window.switchPage('vt52-console'));

        // Print console output as it arrives (what RT-11 actually sends),
        // plus the raw RK11 registers read straight out of the emulator.
        for (let t = 0; t < 30; t++) {
            await sleep(1000);
            const st = await page.evaluate(() => {
                const rd = (a) => (typeof readWordByPhysical === "function"
                    ? (readWordByPhysical(a) & 0xFFFF).toString(8).padStart(6, "0")
                    : "?");
                return {
                    pc: (CPU.registerVal[7] & 0xFFFF).toString(8).padStart(6, "0"),
                    run: CPU.runState,
                    r0: (CPU.registerVal[0] & 0xFFFF).toString(8).padStart(6, "0"),
                    rkds: rd(0o17777400),
                    rker: rd(0o17777402),
                    rkcs: rd(0o17777404),
                    rkwc: rd(0o17777406),
                    rkba: rd(0o17777410),
                    rkda: rd(0o17777412),
                    mem0: (CPU.memory[0] & 0xFFFF).toString(8).padStart(6, "0"),
                    mem2: (CPU.memory[1] & 0xFFFF).toString(8).padStart(6, "0")
                };
            });
            const out = await outputText(page);
            console.log(`  [watch ${t + 1}s] pc=${st.pc} run=${st.run} r0=${st.r0}`);
            console.log(`      rkds=${st.rkds} rker=${st.rker} rkcs=${st.rkcs} ` +
                `rkwc=${st.rkwc} rkba=${st.rkba} rkda=${st.rkda} ` +
                `mem0=${st.mem0} mem2=${st.mem2}`);
            console.log(`      out=${JSON.stringify(out.slice(-160))}`);
            if (out.includes('.')) { console.log("  '.' seen"); break; }
        }

        const ready = await waitFor(async () =>
            (await outputText(page)).includes('.'), 180000);
        console.log("RT-11 ready ('.' seen):", ready);
        await consoleWait.waitRenderStable(page, 2500, 120000,
            (r, g) => console.log(`  [render] ${r}/${g}`));

        // 6. Run DUNGEON and take a couple of steps.
        console.log("[14] sending 'R DUNGEON'...");
        await page.evaluate(() => {
            if (typeof window.dlReceiveQueue === 'function') {
                const s = 'R DUNGEON\r';
                window.dlReceiveQueue(0, Array.from(s, (c) => c.charCodeAt(0) & 0x7F));
            }
        });
        const gamePrompt = await waitFor(async () =>
            (await outputText(page)).includes('>'), 60000);
        console.log("DUNGEON prompt seen:", gamePrompt);
        await consoleWait.waitRenderStable(page, 2500, 60000,
            (r, g) => console.log(`  [render] ${r}/${g}`));
        await sleep(1000);

        const out = await outputText(page);
        console.log("---- console output ----");
        console.log(out);
        console.log("------------------------");

        // Report any disk writes recorded during the panel boot + DUNGEON,
        // plus the DiskStore dirty state straight from the emulator.
        const writes = await page.evaluate(() => window.__diskWrites || []);
        const ds = await page.evaluate(() => ({
            listDirty: (typeof DiskStore !== "undefined" && DiskStore.listDirty)
                ? DiskStore.listDirty() : [],
            hasDirtyRk1: (typeof DiskStore !== "undefined" && DiskStore.hasDirty)
                ? DiskStore.hasDirty("rk1.dsk") : null,
            savedRk1Blocks: (typeof DiskStore !== "undefined" && DiskStore.dirtyBlockCount)
                ? DiskStore.dirtyBlockCount("rk1.dsk") : null
        }));
        console.log("---- disk writes during panel boot ----");
        console.log("total writes:", writes.length);
        const byPc = {};
        writes.forEach((w) => { byPc[w.pc] = (byPc[w.pc] || 0) + 1; });
        console.log("by PC (octal):", JSON.stringify(byPc, null, 2));
        console.log("first 5:", JSON.stringify(writes.slice(0, 5)));
        const fw = await page.evaluate(() => window.__firstWrite || null);
        console.log("first-write state:", JSON.stringify(fw, null, 2));
        // Synchronous RK11 write-command log (from the temp rkGo instrumentation).
        const rkw = await page.evaluate(() => window.__rkWriteLog || []);
        const rkwByPc = {};
        rkw.forEach((w) => {
            const key = w.pc.toString(8).padStart(6, "0");
            if (!rkwByPc[key]) rkwByPc[key] = { count: 0, rkda: [], rkwc: [], rkba: [] };
            rkwByPc[key].count++;
            if (rkwByPc[key].rkda.length < 3) rkwByPc[key].rkda.push(w.rkda.toString(8).padStart(6, "0"));
            if (rkwByPc[key].rkwc.length < 3) rkwByPc[key].rkwc.push(w.rkwc.toString(8).padStart(6, "0"));
            if (rkwByPc[key].rkba.length < 3) rkwByPc[key].rkba.push(w.rkba.toString(8).padStart(6, "0"));
        });
        console.log("---- RK11 WRITE commands (sync, total " + rkw.length + ") ----");
        console.log(JSON.stringify(rkwByPc, null, 2));
        // Dump the monitor code around the write loop (PC=157562) so we can
        // disassemble what actually issues the RK11 write.
        const dump = await page.evaluate(() => {
            const base = 0o157520;
            const out = [];
            for (let i = 0; i < 48; i++) {
                const addr = base + i * 2;
                out.push(addr.toString(8).padStart(6, "0") + ": " +
                    (CPU.memory[addr >>> 1] & 0xFFFF).toString(8).padStart(6, "0"));
            }
            return out;
        });
        console.log("---- monitor code around 157562 ----");
        dump.forEach((line) => console.log("  " + line));
        console.log("---- DiskStore state ----");
        console.log(JSON.stringify(ds, null, 2));

        const sawDot = out.includes('.');
        const sawDungeon = /DUNGEON|>/.test(out);
        if (!sawDot || !sawDungeon) process.exitCode = 1;
    } finally {
        if (browser) { try { await browser.close(); } catch (err) { /* ignore */ } }
        if (server) server.kill();
    }
}

main().catch((err) => {
    console.error("DEBUG FAILED:", err.message);
    process.exit(1);
});
