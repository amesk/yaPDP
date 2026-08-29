#!/usr/bin/env node
/**
 * yaPDP — Guest-OS demo video generator.
 *
 * Records short demonstration videos of the emulator booting real guest
 * operating systems and showing off the emulated hardware, exactly the same
 * way tools/screenshots-os.js captures screenshots:
 *   - the repository's own static server (tools/serve.js) is started on a
 *     private port so the emulator loads its media over HTTP like in prod;
 *   - each scenario opens pdp11.html seeded with a config matching the OS
 *     hardware profile, launches the quick-boot wizard (magic wand) by
 *     clicking the scenario option, waits for the OS to become ready, types
 *     demo commands and records the whole thing to a WebM file;
 *   - recording is done with puppeteer-stream (a WebRTC tab-capture + Media
 *     Recorder bridge), so both the video and the in-tab audio (teletype
 *     chatter, LP11 buzz, power-supply hum) end up in the file.
 *
 * The console is driven through the same globals the quick-boot wizard uses:
 * readiness is detected by wrapping window.__consoleOutputHook and demo
 * commands are typed through window.dlReceiveQueue(0, bytes).
 *
 * Note: puppeteer-stream installs its own copy of puppeteer-core and its own
 * `launch`/`getStream` (the launch wires a capture browser extension), so this
 * tool launches the browser through puppeteer-stream, not puppeteer-core.
 *
 * Usage:
 *   node tools/record-video.js                  # all clips
 *   node tools/record-video.js rt11             # only the 'rt11' clip (file
 *                                               # name without .webm, or a
 *                                               # device key)
 *   node tools/record-video.js --headed         # force a visible browser
 *                                               # window (more reliable audio)
 *   npm run record:video
 *
 * Output: assets/videos/<name>.webm
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { launch, getStream, wss } = require("puppeteer-stream");
const consoleWait = require("./console-wait");

const ROOT = path.resolve(__dirname, "..");
// Output goes to ./video/ (gitignored) — never assets/, which is published.
const OUT_DIR = path.join(ROOT, "video");
const PORT = 11790;
const BASE = `http://127.0.0.1:${PORT}`;

// Default capture resolution. chrome.tabCapture caps at 800x600 unless an
// explicit videoConstraints requests more — without it the raw WebM would be
// upscaled to 1280x800 in the export step and look blurry.
const WIDTH = 1280;
const HEIGHT = 800;
const FPS = 30;

// --- Guest OS boot / demo scenarios --------------------------------------
// `device`     — quick-boot scenario key (see src/osboot.js BOOT_SCENARIOS)
// `file`       — output WebM file name
// `readyWhen`  — console marker meaning "the OS is up"; the tool waits for it
//                after the wizard types the boot sequence. null = special
//                handling (RT-11 / Lunar Lander, see below).
// `readyAfter` — the marker is only trusted once this earlier text appeared
//                (e.g. "#" inside boot text vs "#" after "login:").
// `extra`      — demo commands typed after readiness, each followed by Enter
// `settle`     — extra wait (ms) after the last command
// `stable`     — (RT-11) wait until console output stops growing instead of
//                looking for a marker, so the whole boot prints on the paper.
// `stableAfterExtra` — wait for output to settle after the demo commands.
// `tail`       — extra seconds of recording after the settle, so the clip
//                ends on a calm, readable frame.
// `leadMs`     — pause (ms) after recording starts before the first click, so
//                the viewer sees the initial state first (human pacing).
// `punch`      — engage the paper-tape punch before booting (BASIC-11).
// `tape`       — BASIC program lines fed from the ASR paper-tape reader (AUTO)
//                instead of typed; the last line should be RUN.

// BASIC-11 demo program: a tiny banner loop, then RUN so the video shows real
// BASIC output, not just the "*O " prompt.
const BASIC_PROGRAM = [
    '10 PRINT "YA PDP-11/70"',
    "20 FOR I = 1 TO 5",
    "30 PRINT I, I * I",
    "40 NEXT I",
    "50 END",
    "RUN"
];

// BASIC-11 demo fed from the ASR paper-tape reader: a compact program that
// prints a filled heart on the teletype paper using integer-valued math only.
// This BASIC-11 V007A build has NO integer variables (I% is an illegal name,
// "ERROR 1") and TAB() fails ("ERROR 123" — see tools/_debug-basic-tape.js),
// so the program uses real variables holding exact small integers, leading-
// space loops for positioning, and no FPP built-ins (SIN/COS/SQR/...) and no
// fractional STEP — nothing that could hit an FPP rounding path. The last
// line RUN makes BASIC execute the program as soon as the tape has been read.
const BASIC_TAPE_LINES = [
    "10 REM BASIC-11 TAPE DEMO: HEART (INTEGER ONLY)",
    "20 FOR I=1 TO 2",
    '30 PRINT " ";',
    "40 NEXT I",
    '50 PRINT "***";',
    "60 FOR I=1 TO 5",
    '70 PRINT " ";',
    "80 NEXT I",
    '90 PRINT "***"',
    "100 DATA 2,13,2,13,3,11,4,9,5,7,6,5,7,3,8,1",
    "110 FOR I=1 TO 8",
    "120 READ S,W",
    "130 FOR X=1 TO S-1",
    '140 PRINT " ";',
    "150 NEXT X",
    "160 FOR X=1 TO W",
    '170 PRINT "*";',
    "180 NEXT X",
    "190 PRINT",
    "200 NEXT I",
    "210 END",
    "RUN"
];

// Build the raw bytes of the ASR tape from program lines: every line is
// terminated by CR (0x0D) — exactly the terminator DEC BASIC-11's line editor
// expects (the wizard's Enter is CR too). A plain LF file would not terminate
// a line. Pure and DOM-free.
function linesToTapeBytes(lines) {
    const text = lines.join("\r") + "\r";
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
        bytes.push(text.charCodeAt(i) & 0x7F);
    }
    return bytes;
}

// RK05 primary bootstrap for unit 1 (rk1), hand-entered on the front panel at
// address 001000. Mirrors bootrk in macro-asm/boot.mac but hardcodes unit 1
// (RKDA = 1<<13) instead of taking the unit from R3, so it can be toggled in
// cold. Reads ONE block (256 words = 512 bytes) into memory 0 — the RT-11
// secondary loader — then jumps to it; reading only 512 bytes keeps the
// hand-entered loader itself (at 001000) from being clobbered by the transfer.
const PANEL_BOOT_WORDS = [
    0o012700, 0o177412,   // MOV #177412,R0   ; R0 -> RKDA
    0o012710, 0o020000,   // MOV #020000,(R0) ; RKDA = unit 1, track 0, sector 0
    0o005040,             // CLR -(R0)        ; R0=177410, RKBA=0
    0o012740, 0o177400,   // MOV #-256,-(R0)  ; R0=177406, RKWK=-256 (256 words)
    0o012740, 0o000005,   // MOV #5,-(R0)     ; R0=177404, RKCS=5 (read + go)
    0o105710, 0o100376,   // TSTB (R0) / BPL .-2
    0o005007              // CLR PC           ; jump to memory 0
];
const PANEL_BOOT_ADDR = 0o001000;

const VIDEO_SHOTS = [
    // Front-panel "classic way": start cold (power off), switch to CONFIG and
    // pick the VT52 operator console, then toggle in the RK05 primary
    // bootstrap on the Panel, power on, START, and wait for RT-11's "." prompt
    // before running DUNGEON. Handled by capturePanelBoot().
    { device: "rk1panel", file: "rt11-panel-boot.webm", readyWhen: null,
        extra: [
            { send: "R DUNGEON", waitFor: ">" },
            { send: "OPEN MAILBOX", waitFor: ">" },
            { send: "LOOK", waitFor: ">" },
            { send: "TAKE LEAFLET", waitFor: ">" },
            { ctrlC: true }
        ], settle: 3000, tail: 2000, vt52: true },
    // Unix V5: the shell prompt "#" can also appear inside kernel boot text,
    // so it is only accepted after "login:" (auto-login has completed).
    { device: "rk0",    file: "unix_v5.webm",      readyWhen: "#", readyAfter: "login:",
        extra: ["cal 8 2026"], settle: 6000, tail: 3000 },
    // 2.11 BSD on a DECscope VT52 operator console. The loader prints a lot
    // before "login:"; `man cal` shows off a pager on the video terminal.
    { device: "rp1",    file: "bsd.webm",           readyWhen: "#", readyAfter: "login:",
        extra: ["man cal"], settle: 6000, tail: 3000, vt52: true },
    // RT-11: logically booted in a couple of seconds, but the teletype prints
    // the whole boot — wait for the render hook so the paper shows the full
    // boot and the final "." prompt. Demo: the DUNGEON (Adventure) game —
    // interactive steps wait for the game's ">" prompt, and ^C returns to the
    // RT-11 monitor (K-MON) at the end.
    { device: "rk1",    file: "rt11.webm",         readyWhen: null,
        extra: [
            { send: "R DUNGEON", waitFor: ">" },
            { send: "OPEN MAILBOX", waitFor: ">" },
            { send: "LOOK", waitFor: ">" },
            { send: "TAKE LEAFLET", waitFor: ">" },
            { ctrlC: true }
        ], settle: 3000, tail: 2000 },
    // RT-11 on a DECscope VT52 operator console — same rk1 image, monitor look.
    { device: "rk1vt52", file: "rt11-vt52.webm",   readyWhen: null,
        extra: [
            { send: "R DUNGEON", waitFor: ">" },
            { send: "OPEN MAILBOX", waitFor: ">" },
            { send: "LOOK", waitFor: ">" },
            { send: "TAKE LEAFLET", waitFor: ">" },
            { ctrlC: true }
        ], settle: 3000, tail: 2000, vt52: true },
    // XXDP+ diagnostics: answer the date prompt with 09-SEP-78, then wait
    // for the "." monitor prompt (console output stability).
    { device: "rk3",    file: "xxdp.webm",         readyWhen: "ENTER DATE",
        extra: ["09-SEP-78"], stableAfterExtra: 2500, settle: 1500, tail: 3000 },
    // BASIC-11: engage the punch before boot so the program and its RUN
    // output are duplicated onto the paper tape (visible in the clip).
    { device: "basic",  file: "basic.webm",        readyWhen: "*O",
        extra: BASIC_PROGRAM, settle: 5000, tail: 3000, punch: true },
    // BASIC-11 from the ASR tape: boot BASIC, then load the program tape into
    // the Model 33 reader (AUTO) so the heart program + RUN are fed from the
    // tape instead of being typed — and the drawing prints on the paper.
    { device: "basic",  file: "basic-tape.webm",   readyWhen: "*O",
        tape: BASIC_TAPE_LINES, settle: 5000, tail: 3000 },
    // Lunar Lander draws on the VT11 vector display, not the console — handled
    // by captureLander() (recording starts once the Display page is active).
    { device: "lander", file: "lunar-lander.webm", readyWhen: null, extra: [], settle: 0 }
];

// Machine profile seeded per device — mirrors the `hardware` block of each
// OSBoot scenario so the wizard's hardwareDirty() check passes and no reload
// is triggered mid-run. Shared keys are merged in openPage().
const OS_CFG = {
    rk0:    { consoleType: "teletype", printer: false, vt11: false },
    rp1:    { consoleType: "vt52",     printer: true,  vt11: false },
    rk1:    { consoleType: "teletype", printer: true,  vt11: false },
    rk1vt52: { consoleType: "vt52",    printer: true,  vt11: false },
    rk3:    { consoleType: "teletype", printer: false, vt11: false },
    basic:  { consoleType: "teletype", printer: false, vt11: false },
    lander: { consoleType: "teletype", printer: false, vt11: true },
    // Front-panel demo: starts COLD (power off) with a teletype console, then
    // the capture switches to VT52 on the CONFIG page before toggling the
    // loader. Seeded powerOn=false so the viewer sees the machine off first.
    rk1panel: { consoleType: "teletype", printer: true, vt11: false, powerOn: false }
};

// --- Utilities ------------------------------------------------------------

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

// Start the repo's static server unless something already serves the port.
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

// Resolve an installed Edge/Chrome for the browser launch.
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

// Launch the browser through puppeteer-stream so the capture extension is
// wired. headless:"new" works without a visible window; --headed forces a
// real window for the most reliable audio capture.
async function launchBrowser(headed) {
    const executablePath = findBrowserExecutable();
    if (!executablePath) {
        throw new Error(
            "No Edge/Chrome found. Install one or set PUPPETEER_EXECUTABLE_PATH."
        );
    }
    return launch({
        executablePath,
        headless: headed ? false : "new",
        defaultViewport: { width: WIDTH, height: HEIGHT }
    });
}

// Poll `fn` until it returns true or the timeout (ms) elapses.
async function waitFor(fn, timeout) {
    const startedAt = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - startedAt > timeout) return false;
        await sleep(200);
    }
}

// --- Page-side helpers ----------------------------------------------------

// Open a fresh emulator page seeded with a config that exactly matches the
// OS hardware profile, and wrap the console-output hook so we can watch for
// the OS readiness marker.
async function openPage(browser, shot) {
    const page = await browser.newPage();
    await page.setViewport({ width: shot.width || WIDTH, height: shot.height || HEIGHT });

    const cfg = Object.assign({
        consoleType: "teletype",
        userTerminals: 0,
        printer: false,
        vt11: false,
        // Authentic Model 33 ASR pace (110 baud, ~100 ms/char): the paper
        // prints at the real teletype speed so the demo looks genuine. The
        // render hook guarantees the capture waits for the FULL boot to print,
        // never cutting mid-way.
        teletypeSpeed: "authentic",
        // CONFIG is seeded before every capture: the Model 33 Upper-Case-Only
        // rule is applied to the fed bytes by the key feeder (see
        // installTeletypeKeyFeeder) and must be known up front per device.
        upperCaseOnly: false,
        powerOn: true,         // machine powered on at startup
        autoBoot: false        // the wizard issues the boot itself
    }, OS_CFG[shot.device] || {});

    await page.evaluateOnNewDocument((seed) => {
        try {
            // Seed the config only on the FIRST document of the tab. A
            // CONFIG/wizard-driven reload persists its own choice via
            // Config.set(); re-seeding on reload would overwrite it — e.g. the
            // front-panel demo switches consoleType to vt52 and the reload
            // must keep it (otherwise the OS prints to the hidden teletype).
            if (!sessionStorage.getItem("yapdp.seeded.v1")) {
                sessionStorage.setItem("yapdp.seeded.v1", "1");
                localStorage.setItem("yapdp.config.v1", JSON.stringify(seed.cfg));
            }
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, { cfg });

    await page.goto(`${BASE}/pdp11.html`, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => typeof window.switchPage === "function",
        { timeout: 30000 });
    try {
        await page.evaluate(() => document.fonts.ready);
    } catch (err) { /* fonts API may be missing in headless */ }

    // Wrap the generation + render hooks (see tools/console-wait.js) so the
    // capture can wait until the paced paper render has fully printed the boot.
    await consoleWait.installConsoleHooks(page);

    // On a teletype console, turn every byte fed into the console (including
    // the wizard's boot command and auto-login) into real Model 33 key presses
    // so the recording shows an operator actually typing. On a VT52 console
    // (no on-screen keyboard) the same bytes are delivered one at a time at
    // the same human pace.
    const tty = !(shot.vt52 ||
        (OS_CFG[shot.device] || {}).consoleType === "vt52");
    if (tty) {
        await installTeletypeKeyFeeder(page);
    } else {
        await installVt52PacedFeeder(page);
    }

    return page;
}

// Launch the quick-boot wizard for a device by clicking the magic-wand button
// and then the scenario option — at a human pace so the recording reads
// clearly (WebRTC tab capture does not include the OS cursor, so the clicks
// are shown as real pointer clicks on the right elements).
async function launchDevice(page, device) {
    const wand = await elementCenter(page, "#quick-boot-btn");
    if (!wand) throw new Error("quick-boot button not found");
    await page.mouse.click(wand.x, wand.y);
    // Let the wizard dialog open and the viewer take it in before choosing
    // the operating system.
    await sleep(4000);

    const optSel = '.quickboot-option[data-quickboot-device="' + device + '"]';
    let opt = await elementCenter(page, optSel);
    if (!opt) throw new Error(`quick-boot option not found for ${device}`);

    // The wizard list is long (16 guest OSes) and the option may sit below the
    // fold — scroll the list down in small human-like steps until the option
    // is fully inside the visible area, so the viewer SEES which OS we pick.
    // The list opens at the top, so the scroll is DOWN-ONLY: an item already
    // visible (e.g. BASIC, the first paper tape) is never touched — otherwise
    // the list would jerk up and down on camera.
    await page.evaluate(async (sel) => {
        const list = document.querySelector(".quickboot-list");
        const item = document.querySelector(sel);
        if (!list || !item) return;
        const step = 96;
        for (let guard = 0; guard < 40; guard++) {
            const lr = list.getBoundingClientRect();
            const or = item.getBoundingClientRect();
            if (or.top >= lr.top && or.bottom <= lr.bottom) break; // visible
            if (or.top < lr.top) break; // scrolled past it — stop, never go up
            list.scrollTop += step;
            await new Promise((r) => setTimeout(r, 160));
        }
    }, optSel);
    await sleep(600);

    // Hover the option (highlight) and press it like a real button, so the
    // recording shows the click; then the wizard switches to the console and
    // the teletype key feeder types the boot command on the visible keyboard.
    opt = await elementCenter(page, optSel);
    if (!opt) throw new Error(`quick-boot option not found for ${device}`);
    await page.mouse.move(opt.x, opt.y);
    await sleep(400);
    await page.mouse.down();
    await sleep(220);
    await page.mouse.up();
    // Let the wizard finish typing the boot command and switch pages.
    await sleep(1500);
}

// Centre of an element in viewport coordinates, or null if not found.
async function elementCenter(page, selector) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, selector);
}

// Random, human-like pause: a base delay plus uniform jitter, so the operator
// does not toggle switches with metronome regularity.
function humanPause(base, jitter) {
    return sleep(base + Math.random() * jitter);
}

// Click a panel control (switch or action pad) by its selector, at a human
// pace so the recording shows the switch throw. Used by the front-panel
// bootstrap capture (capturePanelBoot). The jittered tail pause keeps the
// rhythm uneven, like a real operator working the console.
async function clickPanelControl(page, selector) {
    const c = await elementCenter(page, selector);
    if (!c) throw new Error("panel control not found: " + selector);
    await page.mouse.click(c.x, c.y);
    await humanPause(220, 240);
}

// Click a data/address switch with a given bit weight. The click toggles the
// corresponding bit of CPU.switchRegister (setSwitch in src/pdp11-panel.js)
// and moves the rocker, exactly as a real operator would. A small pre-click
// pause reads as the operator finding and reaching for the next switch.
async function clickDataSwitch(page, weight) {
    await humanPause(90, 180);
    await clickPanelControl(page, `.switch[data-weight="${weight}"]`);
}

// Set the panel switch register to `value` by flipping only the bits that
// differ from the current state (keeps the rocker movements minimal).
async function setPanelSwitches(page, value) {
    const current = await page.evaluate(() => CPU.switchRegister & 0xFFFF);
    const diff = (current ^ value) & 0xFFFF;
    for (let i = 0; i < 16; i++) {
        if (diff & (1 << i)) await clickDataSwitch(page, i);
    }
}

// Toggle in the RK05 primary bootstrap on the front panel: HALT, LOAD ADRS
// with 001000, DEP each word (address auto-increments), then LOAD ADRS 001000
// again, ENABLE and START. Uneven pauses between actions keep the whole
// sequence feeling hand-operated rather than scripted.
async function toggleInPanelBootstrap(page) {
    await clickPanelControl(page, '[data-action="enableHalt"]'); // HALT
    await humanPause(250, 300);
    await setPanelSwitches(page, PANEL_BOOT_ADDR);
    await clickPanelControl(page, '[data-action="loadAdrs"]');
    await humanPause(200, 300);
    for (const word of PANEL_BOOT_WORDS) {
        await setPanelSwitches(page, word);
        await clickPanelControl(page, '[data-action="deposit"]');
        await humanPause(120, 320);
    }
    await setPanelSwitches(page, PANEL_BOOT_ADDR);
    await clickPanelControl(page, '[data-action="loadAdrs"]');
    await humanPause(200, 300);
    await clickPanelControl(page, '[data-action="enableHalt"]'); // ENABLE
    await humanPause(200, 300);
    await clickPanelControl(page, '[data-action="start"]');
}

// After switching to a VT52 page that was hidden while the guest printed
// (e.g. the front-panel demo: RT-11 boots while the Panel page is active), the
// canvas was sized/repainted off-screen. Force a re-size + full repaint so the
// already-generated screen buffer becomes visible on camera.
async function redrawVt52(page, unit) {
    await page.evaluate((u) => {
        const term = window.vt52Get && window.vt52Get(u);
        if (!term) return;
        if (typeof term.resizeCanvas === "function") term.resizeCanvas();
        if (typeof term.render === "function") term.render(true);
    }, unit || 0);
}

// Replace window.dlReceiveQueue on a TELEtype page so every byte fed into the
// console — the wizard's boot command and auto-login AND our demo commands —
// becomes a real key press on the Model 33 keyboard (visible .down + key sound).
//
// The press is VISUAL ONLY: we dispatch mousedown (adds .down, plays the sound)
// but never mouseup, so the key's own sendChar never runs — that would deliver
// the key's UPPERCASE byte and silently break lowercase commands ("cal", "man").
// The exact byte is delivered explicitly afterwards via the original queue,
// honouring the CONFIG "upperCaseOnly" option (Model 33 Upper Case Only): when
// it is enabled the lowercase letters are uppercased exactly like the physical
// keyboard path does (see model33UpperOnly in pdp11-app.js). A serial promise
// queue keeps the presses in order when the wizard pushes several steps
// back-to-back.
async function installTeletypeKeyFeeder(page) {
    await page.evaluate(() => {
        if (window.__m33FeederInstalled) return;
        window.__m33FeederInstalled = true;

        const orig = window.dlReceiveQueue;
        // Keep the raw queue reachable so the capture can temporarily restore
        // it while the ASR tape reader feeds a program — the reader's bytes
        // must NOT animate the keys (a real ASR-33 feeds the machine directly).
        window.__dlReceiveQueueRaw = orig;
        let tail = Promise.resolve();

        // Same upper-case-only rule as the physical keyboard (pdp11-app.js).
        // Config.upperCaseOnly is seeded before every capture (see openPage).
        function upperOnly(ch) {
            if (typeof Config !== "undefined" && Config.get) {
                const cfg = Config.get();
                if (cfg && cfg.upperCaseOnly && ch >= 0x61 && ch <= 0x7A) {
                    return ch - 0x20;
                }
            }
            return ch;
        }

        function findKeyEl(code) {
            const keyEls = document.querySelectorAll(
                "#punchkeyboard .m33-key, #punchkeyboard .m33-space");
            for (const el of keyEls) {
                const d = el._def;
                if (!d) continue;
                if (code === 32 && d.special === "space") return el;
                if (code === 13 && d.special === "cr") return el;
                if (code === 10 && d.special === "lf") return el;
                if (d.label) {
                    const want = String.fromCharCode(code).trim().toUpperCase();
                    if (want && d.label.trim().toUpperCase() === want) return el;
                }
            }
            return null;
        }

        function pressEl(el) {
            return new Promise((resolve) => {
                el.dispatchEvent(new MouseEvent("mousedown",
                    { bubbles: true, cancelable: true, view: window }));
                setTimeout(() => {
                    el.classList.remove("down");
                    resolve();
                }, 90);
            });
        }

        window.dlReceiveQueue = function (unit, bytes) {
            tail = tail.then(async () => {
                for (let i = 0; i < bytes.length; i++) {
                    const code = bytes[i] & 0x7F;
                    const el = findKeyEl(code);
                    if (el) await pressEl(el);
                    if (typeof orig === "function") orig(0, [upperOnly(code)]);
                    // Uneven human rhythm between keystrokes (instead of a
                    // metronomic cadence) so typing reads as a person, not a
                    // script. The ~90 ms key hold above plus this gap stays in
                    // the believable 3-6 chars/sec range.
                    await new Promise((r) => setTimeout(r, 90 + Math.random() * 160));
                }
            }).catch(() => { /* keep the queue alive */ });
        };
    });
}

// Temporarily restore the RAW console input queue so the ASR tape reader's
// bytes reach the machine without the visible Model 33 key presses (the key
// feeder animates typed commands, but reading a tape must not press keys —
// on a real ASR-33 the reader feeds the machine directly).
async function disableTeletypeKeyVisuals(page) {
    await page.evaluate(() => {
        if (window.__dlReceiveQueueRaw) {
            window.dlReceiveQueue = window.__dlReceiveQueueRaw;
        }
    });
}

// On a VT52 console there are no Model 33 keys to press, but the operator
// still "types" at a human pace: wrap window.dlReceiveQueue so every byte the
// wizard feeds (boot command, login) is delivered one character at a time with
// the same delay as the teletype (instead of the whole line appearing at once).
async function installVt52PacedFeeder(page) {
    await page.evaluate(() => {
        if (window.__vt52PacedInstalled) return;
        window.__vt52PacedInstalled = true;
        const orig = window.dlReceiveQueue;
        let tail = Promise.resolve();
        window.dlReceiveQueue = function (unit, bytes) {
            tail = tail.then(async () => {
                for (let i = 0; i < bytes.length; i++) {
                    if (typeof orig === "function") orig(0, [bytes[i] & 0x7F]);
                    // Uneven typing cadence: each character lands after a
                    // slightly different pause, so the command reads as typed
                    // by a person rather than replayed at a fixed tempo.
                    await new Promise((r) => setTimeout(r, 90 + Math.random() * 160));
                }
            }).catch(() => { /* keep the queue alive */ });
        };
    });
}

// Human-paced typing on the Model 33 ASR teletype: each character is fed into
// the console one at a time. The actual inter-key cadence is produced by the
// key feeder (installTeletypeKeyFeeder), whose serial queue adds a jittered
// pause after every keystroke — so the visible key presses and their rhythm
// stay in one place and never double up with an extra sleep here.
async function typeTextHuman(page, text, perCharMs) {
    for (const ch of text) {
        await page.evaluate((c) => {
            if (typeof window.dlReceiveQueue === "function") {
                window.dlReceiveQueue(0, [c.charCodeAt(0) & 0x7F]);
            }
        }, ch);
    }
    await page.evaluate(() => {
        if (typeof window.dlReceiveQueue === "function") {
            window.dlReceiveQueue(0, [13]); // Enter
        }
    });
    await sleep(250);
}

// Character-by-character input for a VT52 console (no teletype keys on screen):
// bytes are queued one at a time and the VT52 paced feeder adds an uneven,
// human cadence between them, instead of the whole line appearing instantly.
async function typeTextPaced(page, text, perCharMs) {
    for (const ch of text) {
        await page.evaluate((c) => {
            if (typeof window.dlReceiveQueue === "function") {
                window.dlReceiveQueue(0, [c.charCodeAt(0) & 0x7F]);
            }
        }, ch);
    }
    await page.evaluate(() => {
        if (typeof window.dlReceiveQueue === "function") {
            window.dlReceiveQueue(0, [13]); // Enter
        }
    });
    await sleep(250);
}

// Whether the accumulated console output contains the readiness marker.
async function outputContains(page, needle) {
    return page.evaluate((n) => {
        return !!(window.__osShotOutput &&
            window.__osShotOutput.indexOf(n) !== -1);
    }, needle);
}

// Whether the accumulated console output contains `needle` at or after the
// LAST occurrence of `after`.
async function outputContainsAfter(page, needle, after) {
    return page.evaluate((n, a) => {
        const out = window.__osShotOutput || "";
        const start = a ? out.lastIndexOf(a) : 0;
        return start !== -1 && out.indexOf(n, start) !== -1;
    }, needle, after);
}

// Current length of the captured console output.
async function outputLength(page) {
    return page.evaluate(() => (window.__osShotOutput || "").length);
}

// Wait until the console output stops growing for `stableMs`, or the timeout
// elapses (the teletype has finished printing).
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

// --- Recording ------------------------------------------------------------

// Start tab capture for the given page and pipe the WebM stream to disk.
async function startRecording(page, shot) {
    const file = fs.createWriteStream(path.join(OUT_DIR, shot.file));
    const stream = await getStream(page, {
        audio: true,
        video: true,
        mimeType: "video/webm",
        videoBitsPerSecond: 16_000_000,
        audioBitsPerSecond: 192_000,
        frameSize: 40,
        // Request the full native tab resolution (chrome.tabCapture would cap
        // at 800x600 by default); without this the export upscales and blurs.
        videoConstraints: {
            mandatory: {
                maxWidth: WIDTH,
                maxHeight: HEIGHT,
                maxFrameRate: FPS
            }
        }
    });
    stream.pipe(file);
    return { file, stream };
}

// Stop the MediaRecorder through the extension, let the stream flush its
// final WebM chunks, then close the output file.
async function stopRecording(rec) {
    if (!rec || !rec.stream) return;
    await rec.stream.stop().catch(() => { /* already stopped */ });
    await new Promise((resolve) => {
        if (rec.stream.readableEnded) return resolve();
        rec.stream.once("end", resolve);
        setTimeout(resolve, 3000); // fallback if 'end' never fires
    });
    await new Promise((resolve) => rec.file.end(() => resolve()));
}

// --- Captures -------------------------------------------------------------

// One console-based guest OS: start the recording, boot via the wizard, wait
// for the ready marker, type the demo commands, settle and stop.
async function captureConsoleOS(browser, shot) {
    const page = await openPage(browser, shot);
    let rec = null;
    // Timestamp of the OS readiness marker (prompt) — the recording must linger
    // for at least 5 s after it so the viewer can read the final prompt.
    let readyAt = Date.now();
    try {
        // Engage the paper-tape punch before booting so the boot banner and
        // the demo command are duplicated onto the tape (visible in the clip).
        if (shot.punch) {
            await page.evaluate(() => {
                if (typeof window.setTtyPunch === "function") {
                    window.setTtyPunch(true);
                }
            });
            await sleep(300);
        }

        rec = await startRecording(page, shot);

        // Human pacing: let the viewer see the initial state before the first
        // click on the magic-wand button.
        await sleep(shot.leadMs || 3000);

        await launchDevice(page, shot.device);

        // A config-driven wizard reload (hardware profile change) would have
        // discarded our hook wrappers — re-install them so the readiness
        // detection keeps working (idempotent when no reload happened).
        await consoleWait.installConsoleHooks(page);

        // On a VT52 monitor the console renders instantly (no paced paper), so
        // "generation stable" already means "everything is on screen" — the
        // teletype render hook does not fire there.
        const isVt52 = shot.vt52 ||
            (OS_CFG[shot.device] || {}).consoleType === "vt52";
        // A wizard reload would also have discarded our console feeders —
        // re-install the right one (idempotent when nothing happened) so the
        // demo commands below are still typed as visible key presses (teletype)
        // or at a human pace (VT52).
        if (isVt52) {
            await installVt52PacedFeeder(page);
        } else {
            await installTeletypeKeyFeeder(page);
        }

        if (shot.readyWhen) {
            // Wait for the OS prompt in the GENERATED output (e.g. "#" after
            // login, "*O " for BASIC); the render is drained below.
            const ok = await waitFor(
                () => shot.readyAfter
                    ? outputContainsAfter(page, shot.readyWhen, shot.readyAfter)
                    : outputContains(page, shot.readyWhen), 240000);
            if (!ok) {
                console.error(`  WARN: readiness marker '${shot.readyWhen}' not seen`);
            }
            // Let the wizard finish its own trailing input (e.g. BASIC's
            // empty Enter after "*O ") before we type demo commands.
            await sleep(1500);
        }

        // Drain the console: wait until every generated character has actually
        // been rendered (authentic teletype pace on paper, instantly on a VT52)
        // so the recording shows the full boot instead of cutting mid-print.
        const drained = isVt52
            ? await waitStable(page, 2500, 120000)
            : await consoleWait.waitRenderStable(page, 2500, 240000,
                (r, g) => console.log(`  [render] ${r}/${g} chars`));
        if (!drained) {
            console.error("  WARN: console did not finish rendering the boot");
        }

        // The OS prompt is now fully on paper — start the 5 s final countdown
        // from here.
        readyAt = Date.now();

        // ASR-tape input: load the BASIC program into the Model 33 reader and
        // read it in AUTO mode (one byte per DL11 drained signal). The tape's
        // last line is RUN, so the program executes as soon as the tape ends.
        if (shot.tape && Array.isArray(shot.tape)) {
            // The reader feeds through window.dlReceiveQueue — restore the raw
            // queue first so the tape bytes do not animate the keys.
            await disableTeletypeKeyVisuals(page);
            await page.evaluate((bytes) => {
                if (window.tapeReader && typeof window.tapeReader.loadBytes === "function") {
                    window.tapeReader.loadBytes(new Uint8Array(bytes));
                }
            }, linesToTapeBytes(shot.tape));
            // Let the viewer take in the loaded tape before the reader starts.
            await sleep(2500);
            await page.evaluate(() => {
                if (typeof window.setReaderMode === "function") {
                    window.setReaderMode("auto");
                }
            });
            // Wait for the whole tape to be read into the machine.
            const consumed = await waitFor(async () => {
                return page.evaluate(() => {
                    const tr = window.tapeReader;
                    return tr ? !tr.hasTape() : true;
                });
            }, 180000);
            if (!consumed) {
                console.error("  WARN: ASR tape was not fully read");
            }
        }

        // On a teletype console the keys are typed one at a time at the human
        // ~110 baud pace (a VT52 accepts the whole line instantly).
        const humanTyping = !isVt52;
        for (const cmd of shot.extra || []) {
            if (cmd && cmd.ctrlC) {
                // ^C on the console: interrupt the running program (Dungeon)
                // and return to the RT-11 monitor (K-MON).
                await page.evaluate(() => {
                    if (typeof window.dlReceiveQueue === "function") {
                        window.dlReceiveQueue(0, [3]);
                    }
                });
                await sleep(1500);
            } else if (cmd && typeof cmd === "object") {
                // Interactive step: type the command, then wait for the OS to
                // print the next prompt before continuing (e.g. Dungeon's ">").
                if (humanTyping) await typeTextHuman(page, cmd.send);
                else await typeTextPaced(page, cmd.send);
                const ok = await waitFor(() => outputContains(page, cmd.waitFor), 60000);
                if (!ok) {
                    console.error(`  WARN: prompt '${cmd.waitFor}' not seen`);
                }
                await sleep(1200);
                // On the teletype the paper lags behind: wait until the render
                // has CAUGHT UP with the generated output (e.g. the game's ">"
                // prompt is really on paper) before typing the next command —
                // otherwise ">" prints together with the first letter of the
                // next line. Fall back to a settle if the counters diverge.
                if (humanTyping) {
                    const caught = await consoleWait.waitRenderCaughtUp(page, 120000);
                    if (!caught) {
                        const drained = await consoleWait.waitRenderStable(page, 2500, 120000);
                        if (!drained) {
                            console.error("  WARN: console did not finish the response render");
                        }
                    }
                }
            } else {
                if (humanTyping) await typeTextHuman(page, cmd);
                else await typeTextPaced(page, cmd);
                await sleep(700);
            }
        }

        // Drain again so the demo-command response (e.g. RT-11 DIR listing)
        // is fully rendered before the settle/tail.
        const drainedExtra = isVt52
            ? await waitStable(page, 2500, 120000)
            : await consoleWait.waitRenderStable(page, 2500, 240000,
                (r, g) => console.log(`  [render] ${r}/${g} chars`));
        if (!drainedExtra) {
            console.error("  WARN: console did not finish rendering the response");
        }

        await sleep(shot.settle || 2000);
        // Keep recording for at least 5 s after the readiness prompt so the
        // viewer can read the final state before the clip ends.
        const sinceReady = Date.now() - readyAt;
        await sleep(Math.max(5000 - sinceReady, shot.tail || 0, 0));

        await stopRecording(rec);
        rec = null;
        const kb = Math.round(fs.statSync(path.join(OUT_DIR, shot.file)).size / 1024);
        console.log(`  saved ${shot.file} (${kb} kB)`);
    } finally {
        if (rec) { try { await stopRecording(rec); } catch (err) { /* best effort */ } }
        await page.close();
    }
}

// The front-panel "classic way": start with the machine POWERED OFF, switch
// to CONFIG and pick the VT52 operator console, then go to the Panel, power
// the machine on, toggle in the RK05 primary bootstrap by hand, START it, and
// wait for RT-11's "." prompt before running DUNGEON. The whole sequence is
// recorded so the viewer sees the operator work the switches.
async function capturePanelBoot(browser, shot) {
    const page = await openPage(browser, shot);
    let rec = null;
    // Timestamp of the "." readiness prompt — the recording must linger at
    // least 5 s after it so the viewer can read the final RT-11 prompt.
    let readyAt = Date.now();
    try {
        rec = await startRecording(page, shot);

        // Human pacing: let the viewer see the cold, powered-off machine.
        await sleep(shot.leadMs || 3000);

        // 1. CONFIG: select the VT52 operator console and Apply (reloads).
        await page.evaluate(() => window.switchPage('config'));
        await sleep(1200);
        await page.evaluate(() => {
            const r = document.querySelector('input[name="consoleType"][value="vt52"]');
            if (r) r.click();
        });
        await sleep(600);
        await Promise.all([
            page.waitForNavigation({ waitUntil: "load", timeout: 30000 }).catch(() => {}),
            page.evaluate(() => {
                const b = document.getElementById('config-apply');
                if (b) b.click();
            })
        ]);
        await page.waitForFunction(() => typeof window.switchPage === "function",
            { timeout: 30000 });
        // Reload discarded our hooks/feeders — reinstall for the VT52 console.
        await consoleWait.installConsoleHooks(page);
        await installVt52PacedFeeder(page);
        await sleep(800);

        // 2. Panel: power the machine on (POWER LOCK -> POWER).
        await page.evaluate(() => window.switchPage('panel'));
        await sleep(800);
        await clickPanelControl(page, '.lockPanelPos[data-power-state="run"]');
        await sleep(800);

        // 2b. Help Me! — let the powered-on panel settle for a moment, then
        // press the Help Me! button so the operator's hand-written bootstrap
        // sticky note is on camera before the loader is toggled in. The note
        // is pointer-events:none (css/pdp11.css), so it never swallows the
        // switch clicks that follow.
        await sleep(2000);
        await clickPanelControl(page, '#panel-sticker-btn');
        await sleep(1500);

        // 3. Toggle in the bootstrap loader and START it.
        await toggleInPanelBootstrap(page);
        await sleep(500);

        // 4. Switch to the VT52 console and wait for RT-11 to finish booting.
        await page.evaluate(() => window.switchPage('vt52-console'));
        // The RT-11 boot printed while the Panel page was active, so the hidden
        // VT52 canvas was not repainted — force a re-size + full repaint now
        // that the page is visible, so the boot text shows on camera.
        await sleep(600);
        await redrawVt52(page, 0);
        const drained = await waitStable(page, 2500, 120000);
        if (!drained) {
            console.error("  WARN: console did not finish rendering the RT-11 boot");
        }
        readyAt = Date.now();

        // 5. Demo commands on the VT52 console.
        for (const cmd of shot.extra || []) {
            if (cmd && cmd.ctrlC) {
                await page.evaluate(() => {
                    if (typeof window.dlReceiveQueue === "function") {
                        window.dlReceiveQueue(0, [3]);
                    }
                });
                await sleep(1500);
            } else if (cmd && typeof cmd === "object") {
                await typeTextPaced(page, cmd.send);
                const ok = await waitFor(() => outputContains(page, cmd.waitFor), 60000);
                if (!ok) {
                    console.error(`  WARN: prompt '${cmd.waitFor}' not seen`);
                }
                await sleep(1200);
            }
        }

        const drainedExtra = await waitStable(page, 2500, 120000);
        if (!drainedExtra) {
            console.error("  WARN: console did not finish rendering the response");
        }

        await sleep(shot.settle || 2000);
        const sinceReady = Date.now() - readyAt;
        await sleep(Math.max(5000 - sinceReady, shot.tail || 0, 0));

        await stopRecording(rec);
        rec = null;
        const kb = Math.round(fs.statSync(path.join(OUT_DIR, shot.file)).size / 1024);
        console.log(`  saved ${shot.file} (${kb} kB)`);

        // A hand-toggled RK05 bootstrap is read-only by definition, but this
        // RT-11 image writes its directory/home area during a cold panel boot
        // (RT-11 monitor, not the loader — the loader only reads block 0).
        // Discard those writes from the DiskStore write-back cache before the
        // page closes (pagehide flushes), so the shared browser profile's rk1
        // image stays pristine for the rk1 / rk1vt52 clips recorded later in
        // the same run.
        try {
            await page.evaluate(() => {
                if (typeof DiskStore !== "undefined" && DiskStore.clear) {
                    return DiskStore.clear("rk1.dsk");
                }
            });
        } catch (err) { /* best effort */ }
    } finally {
        if (rec) { try { await stopRecording(rec); } catch (err) { /* best effort */ } }
        await page.close();
    }
}

// Lunar Lander draws on the VT11 vector display, not the console. Boot it
// through the wizard, wait for the Display page, start the recording once the
// vector drawing is underway, let the lander descend, then stop.
async function captureLander(browser, shot) {
    const page = await openPage(browser, shot);
    let rec = null;
    try {
        await launchDevice(page, "lander");

        let onDisplay = false;
        for (let i = 0; i < 60; i++) {
            await sleep(1000);
            onDisplay = await page.evaluate(() => {
                const p = document.getElementById("page-vt11");
                return !!(p && p.classList.contains("active"));
            });
            if (onDisplay) break;
        }
        if (!onDisplay) {
            throw new Error("Lunar Lander did not switch to the Display page");
        }

        // Record the WHOLE run from the very start: the start-up text card,
        // then the long terrain draw, then the lander descent. The assembler
        // later trims out the long wait with a fade (cutLander in
        // assemble-video.js) so only a short title + the descent remain.
        // Moving the mouse across the window keeps the page painting (same
        // trick as the screenshot generator).
        rec = await startRecording(page, shot);
        const total = 100000; // ~100 s covers the text, the draw and a descent
        const steps = 40;
        for (let i = 0; i < steps; i++) {
            await page.mouse.move(
                80 + ((i * 97) % 1100),
                80 + ((i * 71) % 620));
            await sleep(Math.round(total / steps));
        }
        await page.evaluate(() => window.switchPage("vt11"));
        // Keep the final Display page on screen for at least 5 s.
        await sleep(5000);

        await stopRecording(rec);
        rec = null;
        const kb = Math.round(fs.statSync(path.join(OUT_DIR, shot.file)).size / 1024);
        console.log(`  saved ${shot.file} (${kb} kB)`);
    } finally {
        if (rec) { try { await stopRecording(rec); } catch (err) { /* best effort */ } }
        await page.close();
    }
}

// --- Main -----------------------------------------------------------------

(async function main() {
    let server = null;
    let browser = null;
    try {
        const args = process.argv.slice(2);
        const headed = args.includes("--headed");
        // Optional selector: a file name without the .webm suffix or a device
        // key. When given, only the matching clip is generated.
        const selector = (args.find((a) => !a.startsWith("--")) || "")
            .toLowerCase().replace(/\.webm$/, "");

        fs.mkdirSync(OUT_DIR, { recursive: true });
        server = await ensureServer();
        browser = await launchBrowser(headed);

        for (const shot of VIDEO_SHOTS.filter((s) =>
            !selector || s.file === selector + ".webm" || s.device === selector)) {
            console.log(`\n== ${shot.device} -> ${shot.file} ==`);
            try {
                if (shot.device === "lander") {
                    await captureLander(browser, shot);
                } else if (shot.device === "rk1panel") {
                    await capturePanelBoot(browser, shot);
                } else {
                    await captureConsoleOS(browser, shot);
                }
            } catch (err) {
                console.error(`  FAILED ${shot.file}: ${err.message}`);
            }
        }

        console.log("\nDone. Videos written to " +
            path.relative(ROOT, OUT_DIR) + ".");
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    } finally {
        if (browser) { try { await browser.close(); } catch (err) { /* best effort */ } }
        if (server) server.kill();
        // Close the capture bridge WebSocket server so the process can exit.
        try { (await wss).close(); } catch (err) { /* already closed */ }
    }
})();
