#!/usr/bin/env node
/**
 * rt11-term.js — RT-11 operator console bridge for the yaPDP emulator.
 *
 * Boots RT-11 (default: v4.0 on rk1, teletype console) in headless Chrome,
 * then bridges the guest console to the terminal:
 *
 *   - guest console output  -> stdout (character stream)
 *   - your lines            -> guest console (with modern readline editing)
 *   - lines starting with ":" are UTILITY commands, not guest input:
 *         :mount <file>   load a paper tape into the reader (.ptap or .zst)
 *         :rewind         rewind the reader tape to the start
 *         :export <file>  save the punch output accumulated since the last
 *                         export (or session start) and clear the buffer
 *         :wait <marker>  wait until the guest output contains <marker>
 *         :raw <hex>      send raw bytes to the guest console (e.g. :raw 03)
 *         :status         show mounted tape, punch byte count, mode
 *         :quit | :exit   shut down and exit
 *         :help           this list
 *
 * Batch mode (stdin is not a TTY, e.g. a pipe): every line of stdin is fed
 * to the guest (or handled as a command), the guest's print output goes to
 * stdout, and the utility exits at end of input.
 *
 * Prompt synchronization (batch mode): after sending a line the utility
 * waits for the RT-11 monitor prompt ("." at the start of a line followed
 * by a quiet period) before sending the next line, so a piped script cannot
 * outrun the guest. A ".". in the middle of program output is never taken
 * for the prompt: the marker must sit at the start of a line AND be
 * followed by ~300 ms of silence (configurable).
 *
 * Usage:
 *   node tools/rt11-term.js [options] [tape-file]
 *     --device <rk1|rk4>    RT-11 scenario to boot (default rk1)
 *     --prompt <marker>     prompt marker (default ".")
 *     --prompt-delay <ms>   silence window confirming a prompt (default 300)
 *     --prompt-timeout <s>  max wait for a prompt (default 15)
 *     --quiet               batch: do not echo sent lines (guest echo only)
 *     --port <n>            dev-server port (default 1170)
 *     --server <cmd>        dev-server command (default "node tools/serve.js")
 *
 * Environment:
 *   PUPPETEER_EXECUTABLE_PATH  path to Chrome/Chromium (optional)
 *   PUPPETEER_NO_SANDBOX=1     pass --no-sandbox to Chrome (root/CI)
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const puppeteer = require("puppeteer");

const REPO = path.resolve(__dirname, "..");
const MEDIA = path.join(REPO, "media");
const PREFIX = ":";
const TEMP_TAPE_PREFIX = "rt11term-";

// ----------------------------------------------------------------------
// CLI arguments
// ----------------------------------------------------------------------

const args = process.argv.slice(2);
const opts = {
    device: "rk1",
    prompt: ".",
    promptDelay: 300,
    promptTimeout: 15,
    quiet: false,
    port: 1170,
    serverCmd: null,
    tapeFile: null,
};
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === "--device") opts.device = next();
    else if (a.startsWith("--device=")) opts.device = a.slice(9);
    else if (a === "--prompt") opts.prompt = next();
    else if (a.startsWith("--prompt=")) opts.prompt = a.slice(9);
    else if (a === "--prompt-delay") opts.promptDelay = parseInt(next(), 10);
    else if (a.startsWith("--prompt-delay=")) opts.promptDelay = parseInt(a.slice(15), 10);
    else if (a === "--prompt-timeout") opts.promptTimeout = parseInt(next(), 10);
    else if (a.startsWith("--prompt-timeout=")) opts.promptTimeout = parseInt(a.slice(17), 10);
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--port") opts.port = parseInt(next(), 10);
    else if (a.startsWith("--port=")) opts.port = parseInt(a.slice(7), 10);
    else if (a === "--server") opts.serverCmd = next();
    else if (a === "--help" || a === "-h") {
        console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(0, 40).join("\n"));
        process.exit(0);
    }
    else if (a.startsWith("-")) {
        console.error("rt11-term: unknown option " + a);
        process.exit(2);
    }
    else opts.tapeFile = a;
}

const interactive = process.stdin.isTTY;

// ----------------------------------------------------------------------
// State
// ----------------------------------------------------------------------

let browser = null;
let page = null;
let serverProc = null;
let serverPort = opts.port;
let punchMirror = [];        // bytes punched by the guest since last export
let mountedTape = null;      // tape name currently loaded in the reader
const tempTapeFiles = [];    // media/ files created for :mount, cleaned up
let shuttingDown = false;
let rlRef = null;            // interactive readline (for prompt redraw)

// Prompt engine state.
let outTail = "";            // recent console output (for :wait matching)
let lineStart = true;        // next char starts a fresh line
let curLine = "";            // chars of the current line
let silenceTimer = null;     // armed when a candidate prompt line is seen
let promptWaiters = [];      // resolve() callbacks waiting for the prompt
let markerWaiters = [];      // { marker, lineStartOnly, resolve, timer }
let echoPending = null;      // line we sent, awaiting guest echo (batch)
let echoIdx = 0;
let echoFailed = false;

const MAX_TAIL = 65536;

// ----------------------------------------------------------------------
// Dev server
// ----------------------------------------------------------------------

async function serverUp(port) {
    try {
        const res = await fetch("http://localhost:" + port + "/pdp11.html");
        return res.ok;
    } catch (e) {
        return false;
    }
}

async function ensureServer() {
    if (await serverUp(serverPort)) return;
    const cmd = opts.serverCmd || ("node " + path.join("tools", "serve.js"));
    console.error("rt11-term: starting dev server on :" + serverPort + " (" + cmd + ")");
    serverProc = spawn(cmd, ["--port", String(serverPort)], {
        cwd: REPO,
        shell: true,
        stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
        if (await serverUp(serverPort)) return;
        await sleep(100);
    }
    throw new Error("dev server did not come up on :" + serverPort);
}

// ----------------------------------------------------------------------
// Puppeteer / page bridge
// ----------------------------------------------------------------------

async function launchBrowser() {
    const launchOpts = {
        headless: "new",
        args: ["--disable-gpu", "--disable-dev-shm-usage"],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    if (process.env.PUPPETEER_NO_SANDBOX === "1") {
        launchOpts.args.push("--no-sandbox", "--disable-setuid-sandbox");
    }
    browser = await puppeteer.launch(launchOpts);
    page = await browser.newPage();
    page.on("pageerror", (e) => {
        console.error("rt11-term: page error: " + e.message);
    });
}

// Hardware profile per boot device — mirrors the `hardware` block of the
// OSBoot scenario (osboot.js). The config is SEEDED before page load so the
// quick-boot wizard's hardwareDirty() check passes and launch() does not
// reload the page (a reload would wipe our console bridge mid-boot).
const HW_PROFILE = {
    rk1:     { consoleType: "teletype", printer: true, vt11: false },
    rk1vt52: { consoleType: "vt52",     printer: true, vt11: false },
    rk4:     { consoleType: "teletype", printer: true, vt11: false },
    _:       { consoleType: "teletype", printer: false, vt11: false },
};

// Seed the emulator config + onboarding flag in localStorage BEFORE the page
// loads (evaluateOnNewDocument), matching screenshots-os.js.
async function seedConfig(device) {
    const hw = HW_PROFILE[device] || HW_PROFILE._;
    const cfg = Object.assign({
        consoleType: "teletype",
        userTerminals: 0,
        printer: false,
        vt11: false,
        teletypeSpeed: "fast",   // generation hook is pacing-independent anyway
        powerOn: true,
        autoBoot: false,         // the wizard issues the boot itself
    }, hw);
    await page.evaluateOnNewDocument((seed) => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify(seed.cfg));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, { cfg });
}

async function waitForApp(timeoutMs) {
    const t0 = Date.now();
    for (;;) {
        const ok = await page.evaluate(() =>
            typeof CPU !== "undefined" &&
            typeof QuickBoot !== "undefined" &&
            typeof QuickBoot.launch === "function" &&
            typeof window.dlReceiveQueue === "function" &&
            typeof switchPage === "function").catch(() => false);
        if (ok) return;
        if (Date.now() - t0 > timeoutMs) throw new Error("emulator app did not become ready");
        await sleep(100);
    }
}

// Install (or re-install after a reload) the console-output and punch
// bridges. Idempotent per document: window flags survive until the next
// reload, so a re-install after a boot-driven reload is a no-op there.
async function installHooks() {
    await page.evaluate(() => {
        if (window.__rt11termHooked) return;
        window.__rt11termHooked = true;
        const prev = window.__consoleOutputHook;
        window.__consoleOutputHook = function (ch) {
            if (typeof prev === "function") prev(ch);
            // Forward to the host: the page and the utility share a global
            // event bus object created below.
            if (window.__rt11termBus) {
                window.__rt11termBus.chars.push(ch & 0x7f);
            }
        };
        if (typeof window.punchTapeAppend === "function" && !window.__rt11termPunch) {
            window.__rt11termPunch = true;
            const orig = window.punchTapeAppend;
            window.punchTapeAppend = function (buf, byte) {
                // Keep full 8-bit bytes: the emulator's punch buffer (and the
                // .ptap export) stores bytes as written by the device driver.
                // The on-screen Model 33 tape renders 7 bits only, but that is
                // a visualisation, not the data.
                if (window.__rt11termBus) window.__rt11termBus.punch.push(byte & 0xff);
                return orig(buf, byte);
            };
        }
        // Event bus: the host polls this instead of fighting CDP for every
        // character. Busy-wait is avoided by a notification counter.
        if (!window.__rt11termBus) {
            window.__rt11termBus = { chars: [], punch: [], version: 0 };
        }
        window.__rt11termBus.version++;
    });
}

// Poll the page-side event bus and feed chars/punch bytes to the host
// engines. One poller for both keeps ordering simple.
async function runBridge() {
    for (;;) {
        if (shuttingDown) return;
        const batch = await page.evaluate(() => {
            const bus = window.__rt11termBus;
            if (!bus) return null;
            const out = { chars: bus.chars.slice(), punch: bus.punch.slice() };
            bus.chars.length = 0;
            bus.punch.length = 0;
            return out;
        }).catch(() => null);
        if (batch) {
            for (const c of batch.chars) onConsoleChar(c);
            for (const b of batch.punch) onPunchByte(b);
        } else {
            // The page reloaded (or hooks were lost): re-install the bridge.
            try { await installHooks(); } catch (e) { /* page not ready yet */ }
        }
        await sleep(15);
    }
}

// ----------------------------------------------------------------------
// Prompt / marker engine (host side)
// ----------------------------------------------------------------------

function onConsoleChar(c) {
    // Feed the :wait tail (raw, including the char).
    outTail += String.fromCharCode(c);
    if (outTail.length > MAX_TAIL) outTail = outTail.slice(-MAX_TAIL);
    checkMarkerWaiters();

    // Echo tracking (batch mode): the guest's hardcopy echo of a sent line
    // arrives as output; match it so we do not double-print the line.
    if (echoPending !== null) {
        if (c === echoPending.charCodeAt(echoIdx)) {
            echoIdx++;
            if (echoIdx >= echoPending.length) {
                echoPending = null; // guest echoed the whole line
                echoIdx = 0;
            }
        } else {
            echoPending = null;
            echoIdx = 0;
            echoFailed = true;
        }
    }

    // Line tracking. curLine accumulates from the last newline.
    if (lineStart) curLine = "";
    curLine += String.fromCharCode(c);
    if (c === 10 || c === 13) {
        lineStart = true;
        curLine = "";
    } else {
        lineStart = false;
    }

    // A line that is EXACTLY the prompt marker is a CANDIDATE: confirm it
    // only after `promptDelay` ms of silence (the real monitor prompt waits
    // for input; a dot inside program output keeps producing chars, which
    // disarms the timer).
    if (curLine === opts.prompt && opts.prompt !== "") {
        armSilenceTimer();
    } else {
        disarmSilenceTimer();
    }

    // Guest output to stdout.
    process.stdout.write(String.fromCharCode(c));
    // Interactive: redraw the readline input line after each output line so
    // the operator's half-typed line stays visible.
    if (rlRef && c === 10) {
        try { rlRef.prompt(true); } catch (e) { /* ignore */ }
    }
}

function armSilenceTimer() {
    if (silenceTimer) return;
    silenceTimer = setTimeout(() => {
        silenceTimer = null;
        const waiters = promptWaiters;
        promptWaiters = [];
        waiters.forEach((w) => w());
    }, opts.promptDelay);
}

function disarmSilenceTimer() {
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
}

function waitForPrompt(timeoutMs) {
    return new Promise((resolve) => {
        const t = setTimeout(() => {
            const i = promptWaiters.indexOf(resolve);
            if (i >= 0) promptWaiters.splice(i, 1);
            resolve(false);
        }, timeoutMs);
        promptWaiters.push(() => {
            clearTimeout(t);
            resolve(true);
        });
    });
}

// :wait <marker> — substring match anywhere in the output tail, confirmed
// by the same silence window.
function waitForMarker(marker, timeoutMs) {
    return new Promise((resolve) => {
        if (outTail.includes(marker)) {
            resolve(true);
            return;
        }
        const t = setTimeout(() => {
            const i = markerWaiters.indexOf(entry);
            if (i >= 0) markerWaiters.splice(i, 1);
            resolve(false);
        }, timeoutMs);
        const entry = {
            marker,
            resolve: () => {
                clearTimeout(t);
                const i = markerWaiters.indexOf(entry);
                if (i >= 0) markerWaiters.splice(i, 1);
                resolve(true);
            },
        };
        markerWaiters.push(entry);
    });
}

// Called for every char; checks substring waiters too.
function checkMarkerWaiters() {
    for (let i = markerWaiters.length - 1; i >= 0; i--) {
        if (outTail.includes(markerWaiters[i].marker)) {
            const w = markerWaiters[i];
            markerWaiters.splice(i, 1);
            w.resolve();
        }
    }
}

// ----------------------------------------------------------------------
// Guest I/O
// ----------------------------------------------------------------------

async function sendLine(line) {
    const bytes = [];
    for (let i = 0; i < line.length; i++) bytes.push(line.charCodeAt(i) & 0x7f);
    bytes.push(13); // CR — the teletype's Enter
    await sendBytes(bytes);
}

async function sendBytes(bytes) {
    await page.evaluate((bs) => {
        window.dlReceiveQueue(0, bs);
    }, bytes).catch(() => {});
}

// Echo a sent line ourselves (batch, non-quiet) — used only when the guest
// did not echo it within a short window.
function maybeEchoLine(line) {
    if (opts.quiet) return;
    process.stdout.write(line + "\r\n");
}

// ----------------------------------------------------------------------
// Tape mount / rewind / punch export
// ----------------------------------------------------------------------

function decompressZstInPage(zstPath) {
    const data = fs.readFileSync(zstPath);
    const b64 = data.toString("base64");
    return page.evaluate((b) => {
        const bin = atob(b);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const out = fzstd.decompress(bytes);
        return Array.from(out);
    }, b64);
}

// Load a host paper-tape file into the emulator's reader. .zst sources are
// decompressed (via the page's fzstd); raw bytes are served as-is from a
// temp copy under media/ (the dev server's web root).
async function mountTape(hostFile) {
    const resolved = path.resolve(hostFile);
    if (!fs.existsSync(resolved)) {
        console.error("rt11-term: no such file: " + hostFile);
        return false;
    }
    let raw;
    if (/\.zst$/i.test(resolved)) {
        console.error("rt11-term: decompressing " + path.basename(resolved) + " ...");
        raw = Buffer.from(await decompressZstInPage(resolved));
    } else {
        raw = fs.readFileSync(resolved);
    }
    const name = TEMP_TAPE_PREFIX + Date.now() + "-" +
        path.basename(resolved).replace(/\.zst$/i, "").replace(/\.ptap$/i, "") +
        ".ptap";
    const dest = path.join(MEDIA, name);
    fs.writeFileSync(dest, raw);
    tempTapeFiles.push(dest);

    await page.evaluate((n, data) => {
        // Mount into DataLoader so PTR11 sees the tape as a local image:
        // the end-of-tape check (iopage.js) only fires when
        // DataLoader.get(url) is defined, and without it COPY PC: would
        // read past the end forever and hang the guest.
        if (typeof DataLoader !== "undefined" && typeof DataLoader.mount === "function") {
            DataLoader.mount(n, new Uint8Array(data));
        }
        const select = document.getElementById("ptr");
        if (!select) return;
        let opt = null;
        for (const o of select.options) {
            if (o.value === n) { opt = o; break; }
        }
        if (!opt) {
            opt = document.createElement("option");
            opt.value = n;
            opt.textContent = n;
            select.appendChild(opt);
        }
        select.value = n;
        select.dispatchEvent(new Event("change"));
    }, name, Array.from(raw)).catch(() => {});
    mountedTape = name;
    console.error("rt11-term: mounted " + path.basename(resolved) + " (" + raw.length + " bytes)");
    return true;
}

async function rewindTape() {
    await page.evaluate(() => {
        if (typeof window.ptrRewindTape === "function") window.ptrRewindTape();
    }).catch(() => {});
    console.error("rt11-term: reader tape rewound");
}

async function exportPunch(hostFile) {
    if (!punchMirror.length) {
        console.error("rt11-term: punch buffer is empty — nothing to export");
        return false;
    }
    fs.writeFileSync(path.resolve(hostFile), Buffer.from(punchMirror));
    console.error("rt11-term: exported " + punchMirror.length + " bytes to " + hostFile);
    punchMirror = [];
    // Keep the emulator's own punch buffer in sync so the Storage page
    // indicator matches ("fresh tape").
    await page.evaluate(() => {
        if (typeof window.clearPunchTape === "function") window.clearPunchTape();
    }).catch(() => {});
    return true;
}

function onPunchByte(b) {
    punchMirror.push(b);
}

// ----------------------------------------------------------------------
// Status / commands
// ----------------------------------------------------------------------

async function cmdStatus() {
    const st = await page.evaluate(() => {
        const select = document.getElementById("ptr");
        return {
            tape: select ? select.value : null,
            state: (document.getElementById("ptr-state") || {}).textContent || "",
        };
    }).catch(() => ({}));
    console.error("rt11-term: device=" + opts.device +
        " | reader tape=" + (st.tape || "(none)") + " (" + (st.state || "") + ")" +
        " | punch=" + punchMirror.length + " bytes" +
        " | prompt=" + JSON.stringify(opts.prompt));
}

async function handleCommand(line) {
    const rest = line.slice(PREFIX.length).trim();
    const [cmd, ...argParts] = rest.split(/\s+/);
    const arg = argParts.join(" ");
    switch (cmd) {
        case "mount":
            if (!arg) { console.error("rt11-term: usage: :mount <file>"); break; }
            await mountTape(arg);
            break;
        case "rewind":
            await rewindTape();
            break;
        case "export":
            if (!arg) { console.error("rt11-term: usage: :export <file>"); break; }
            await exportPunch(arg);
            break;
        case "wait":
            if (!arg) { console.error("rt11-term: usage: :wait <marker>"); break; }
            console.error("rt11-term: waiting for " + JSON.stringify(arg) + " ...");
            const ok = await waitForMarker(arg, opts.promptTimeout * 1000);
            console.error(ok ? "rt11-term: marker seen" : "rt11-term: TIMEOUT waiting for marker");
            break;
        case "raw": {
            const hex = arg.replace(/[^0-9a-fA-F]/g, "");
            if (!hex || hex.length % 2) {
                console.error("rt11-term: usage: :raw <hex bytes, e.g. 0304>");
                break;
            }
            const bytes = [];
            for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
            await sendBytes(bytes);
            break;
        }
        case "status":
            await cmdStatus();
            break;
        case "help":
            console.error(
                "rt11-term commands:\n" +
                "  :mount <file>   load paper tape (.ptap/.zst) into the reader\n" +
                "  :rewind         rewind the reader tape\n" +
                "  :export <file>  save punch output since last export, clear buffer\n" +
                "  :wait <marker>  wait for <marker> in guest output\n" +
                "  :raw <hex>      send raw bytes (e.g. :raw 03 = ^C)\n" +
                "  :status         show reader tape / punch bytes / mode\n" +
                "  :quit | :exit   exit\n" +
                "  :help           this help");
            break;
        case "quit":
        case "exit":
            await shutdown(0);
            break;
        default:
            console.error("rt11-term: unknown command :" + cmd + " (try :help)");
    }
}

// ----------------------------------------------------------------------
// Batch mode
// ----------------------------------------------------------------------

async function runBatch() {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    for await (const line of rl) {
        if (shuttingDown) break;
        const trimmed = line.replace(/\r$/, "");
        if (trimmed.startsWith(PREFIX)) {
            await handleCommand(trimmed);
            continue;
        }
        // Echo the line ourselves only if the guest does not (hardcopy
        // echo). Set up the matcher, send, then wait for the prompt.
        echoPending = trimmed;
        echoIdx = 0;
        echoFailed = false;
        await sendLine(trimmed);
        const ok = await waitForPrompt(opts.promptTimeout * 1000);
        if (!ok) {
            console.error("rt11-term: TIMEOUT waiting for prompt after: " + trimmed);
        }
        if (echoFailed && !opts.quiet) {
            process.stdout.write(trimmed + "\r\n");
        }
    }
    console.error("rt11-term: end of input");
    await shutdown(0);
}

// ----------------------------------------------------------------------
// Interactive mode
// ----------------------------------------------------------------------

async function runInteractive() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        prompt: "",
    });
    rlRef = rl;
    // Ctrl+C sends the operator's ^C to the guest instead of killing the
    // utility; Ctrl+D on an empty line exits.
    rl.on("SIGINT", () => {
        sendBytes([3]); // ETX
    });
    rl.on("close", () => {
        shutdown(0);
    });
    rl.prompt();
    rl.on("line", async (line) => {
        if (shuttingDown) return;
        if (line.startsWith(PREFIX)) {
            await handleCommand(line);
        } else {
            await sendLine(line);
        }
        rl.prompt();
    });
    console.error("rt11-term: RT-11 console online. Lines go to the guest; " +
        PREFIX + "prefix = utility commands (:help). Ctrl+C -> ^C to guest, Ctrl+D exits.");
}

// ----------------------------------------------------------------------
// Shutdown
// ----------------------------------------------------------------------

async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
        if (browser) await browser.close();
    } catch (e) { /* ignore */ }
    for (const f of tempTapeFiles) {
        try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
    }
    if (serverProc) {
        serverProc.kill();
        serverProc = null;
    }
    process.exit(code);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

(async () => {
    process.on("SIGINT", () => { shutdown(0); });
    process.on("SIGTERM", () => { shutdown(0); });

    await ensureServer();
    await launchBrowser();
    await seedConfig(opts.device);
    await page.goto("http://localhost:" + serverPort + "/pdp11.html", {
        waitUntil: "load",
    });
    await waitForApp(30000);
    await installHooks();
    runBridge();

    console.error("rt11-term: booting " + opts.device + " ...");
    await page.evaluate((d) => { QuickBoot.launch(d); }, opts.device).catch(() => {});
    // Config was pre-seeded, so launch() should NOT reload the page and the
    // hooks stay intact. If a reload still happened (unforeseen profile
    // difference), re-install the bridge after the page settles.
    await sleep(300);
    await waitForApp(30000);
    await installHooks();

    // First prompt: RT-11 takes a while to boot; allow a generous timeout.
    const booted = await waitForPrompt(60000);
    if (!booted) {
        console.error("rt11-term: did not see the RT-11 prompt within 60s " +
            "(is the " + opts.device + " image present?)");
    } else {
        console.error("rt11-term: RT-11 is up (prompt \"" + opts.prompt + "\").");
    }

    if (opts.tapeFile) {
        await mountTape(opts.tapeFile);
    }

    if (interactive) {
        await runInteractive();
    } else {
        await runBatch();
    }
})().catch((e) => {
    console.error("rt11-term: fatal: " + (e && e.stack || e));
    shutdown(2);
});
