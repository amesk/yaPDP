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

// Default capture resolution.
const WIDTH = 1280;
const HEIGHT = 800;

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

const VIDEO_SHOTS = [
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
    lander: { consoleType: "teletype", printer: false, vt11: true }
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
            localStorage.setItem("yapdp.config.v1", JSON.stringify(seed.cfg));
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
    await page.evaluate(async (sel) => {
        const list = document.querySelector(".quickboot-list");
        const item = document.querySelector(sel);
        if (!list || !item) return;
        const step = 96;
        for (let guard = 0; guard < 40; guard++) {
            const lr = list.getBoundingClientRect();
            const or = item.getBoundingClientRect();
            if (or.top >= lr.top + 6 && or.bottom <= lr.bottom - 6) break;
            list.scrollTop += (or.top < lr.top ? -1 : 1) * step;
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
                }
            }).catch(() => { /* keep the queue alive */ });
        };
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
                    await new Promise((r) => setTimeout(r, 130));
                }
            }).catch(() => { /* keep the queue alive */ });
        };
    });
}

// Human-paced typing on the Model 33 ASR teletype: each character is fed into
// the console one at a time (window.dlReceiveQueue, which installTeletypeKeyFeeder
// turns into a visible key press). The pace matches the authentic ~110 baud.
async function typeTextHuman(page, text, perCharMs) {
    const pace = perCharMs || 130;
    for (const ch of text) {
        await page.evaluate((c) => {
            if (typeof window.dlReceiveQueue === "function") {
                window.dlReceiveQueue(0, [c.charCodeAt(0) & 0x7F]);
            }
        }, ch);
        await sleep(pace);
    }
    await page.evaluate(() => {
        if (typeof window.dlReceiveQueue === "function") {
            window.dlReceiveQueue(0, [13]); // Enter
        }
    });
    await sleep(250);
}

// Character-by-character input for a VT52 console (no teletype keys on screen):
// each byte is sent with the same per-character delay as the teletype, so the
// operator "types" at the same human pace instead of the whole line appearing
// instantly.
async function typeTextPaced(page, text, perCharMs) {
    const pace = perCharMs || 130;
    for (const ch of text) {
        await page.evaluate((c) => {
            if (typeof window.dlReceiveQueue === "function") {
                window.dlReceiveQueue(0, [c.charCodeAt(0) & 0x7F]);
            }
        }, ch);
        await sleep(pace);
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
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 128_000,
        frameSize: 40
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
