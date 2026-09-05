#!/usr/bin/env node
/**
 * headless-term.js — RT-11 operator console bridge on the NEW headless
 * stack (no browser, no puppeteer, no iopage.js). Successor of the old
 * tools/rt11-term.js with full feature parity:
 *
 *   - boots a guest OS via bootHeadless() (default RT-11 v4.0 on rk1)
 *   - interactive mode (TTY stdin): lines go to the guest console,
 *     guest output streams to stdout, ":commands" drive the utility
 *   - batch mode (piped stdin): every line is fed to the guest (or
 *     handled as a command) with prompt synchronization — the utility
 *     waits for the RT-11 monitor prompt ("." at line start + a quiet
 *     period) before sending the next line, so a script cannot outrun
 *     the guest
 *   - guest console input through the ConsoleDL11 device, paper tape
 *     through the PtrPtp device + the shared DiskService (file provider)
 *
 * Usage:
 *   node tools/headless-term.js [image.zst] [url-name] [boot-cmd]
 *   node tools/headless-term.js [options] [tape-file]
 *
 * Options:
 *   --device <rk1|rk4>    boot profile (default rk1)
 *   --prompt <marker>     prompt marker (default ".")
 *   --prompt-delay <ms>   silence window confirming a prompt (default 300)
 *   --prompt-timeout <s>  max wait for a prompt (default 15)
 *   --quiet               batch: do not echo sent lines (guest echo only)
 *   --tape <file>         mount a paper tape (.ptap/.zst) after boot
 *   --step "send|waitFor" multi-step boot (repeatable): send <send>, wait
 *                         for <waitFor> in the output produced after the
 *                         send. E.g. Unix V5:
 *                         --step "boot rk0|@" --step "unix|login:"
 *                         --step "root|#" --prompt "#"
 *
 * Interactive commands (lines starting with ":"):
 *   :mount <file>   load a paper tape into the reader (.ptap or .zst)
 *   :rewind         rewind the reader tape
 *   :export <file>  save the punch output since the last export
 *   :wait <marker>  wait until the guest output contains <marker>
 *   :raw <hex>      send raw bytes to the guest console (e.g. :raw 03)
 *   :status         show reader tape / punch bytes / prompt marker
 *   :quit | :exit   shut down and exit
 *   :help           this list
 */
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const vm = require("vm");

const { bootHeadless } = require("./headless-machine.js");
const { IO_BLOCKSIZE } = require("../src/devices/disk-service.js");

const REPO = path.resolve(__dirname, "..");
const PREFIX = ":";
const MAX_TAIL = 65536;

// Boot profiles (mirror the OSBoot scenarios of the old rt11-term.js).
// On the headless stack the guest image is mounted as RK drive 0, so the
// boot command is BOOT RK0 regardless of which distribution image is used.
const DEVICE_PROFILES = {
    rk1:     { image: "media/rk1.dsk.zst", urlName: "rk0.dsk", bootCmd: "BOOT RK0\r" },
    rk1vt52: { image: "media/rk1.dsk.zst", urlName: "rk0.dsk", bootCmd: "BOOT RK0\r" },
    rk4:     { image: "media/rk4.dsk.zst", urlName: "rk0.dsk", bootCmd: "BOOT RK0\r" },
    // BSD 2.11 (RP06 on drive 1). The loader asks for a CR before the
    // kernel starts; pass --step "|login:" --step "root|#" to get a shell.
    // Boot reaches "login:" in ~160s of wall time (init spends ~70 virtual
    // seconds before the network/rc phase) — needs a generous boot timeout.
    rp1:     { image: "media/rp1.dsk.zst", urlName: "rp1.dsk", bootCmd: "boot rp1\r", timeoutMs: 240000 },
    // RSTS/E 9.6 and RSX-11M 4.6 (RP04 on drives 2/3) — full autoconfiguration
    // before a prompt; keep a generous boot timeout too.
    rp2:     { image: "media/rp2.dsk.zst", urlName: "rp2.dsk", bootCmd: "BOOT RP2\r", timeoutMs: 240000 },
    rp3:     { image: "media/rp3.dsk.zst", urlName: "rp3.dsk", bootCmd: "BOOT RP3\r", timeoutMs: 240000 },
};

// How long bootHeadless waits for the prompt to appear. Individual profiles
// may override (see DEVICE_PROFILES: rp* guests boot slowly to login). The
// interactive/batch prompt sync after boot uses --prompt-timeout instead.
const DEFAULT_BOOT_TIMEOUT_MS = 90000;

// ----------------------------------------------------------------------
// CLI arguments
// ----------------------------------------------------------------------

/** parseStep — "--step send|waitFor" (or just send). */
function parseStep(s) {
    const i = s.indexOf("|");
    if (i < 0) return { send: s, waitFor: "" };
    return { send: s.slice(0, i), waitFor: s.slice(i + 1) };
}

const opts = {
    device: null,
    prompt: ".",
    promptDelay: 300,
    promptTimeout: 15,
    quiet: false,
    tapeFile: null,
    image: null,
    urlName: null,
    bootCmd: null,
    steps: [],
};

const args = process.argv.slice(2);
const positional = [];
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
    else if (a === "--tape") opts.tapeFile = next();
    else if (a.startsWith("--tape=")) opts.tapeFile = a.slice(7);
    else if (a === "--step") opts.steps.push(parseStep(next()));
    else if (a.startsWith("--step=")) opts.steps.push(parseStep(a.slice(7)));
    else if (a === "--help" || a === "-h") {
        console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(0, 45).join("\n"));
        process.exit(0);
    }
    else if (a.startsWith("-")) {
        console.error("headless-term: unknown option " + a);
        process.exit(2);
    }
    else positional.push(a);
}

// Resolve the boot configuration: explicit profile > positional args
// (image, url-name, boot-cmd) > defaults. The old rt11-term convention
// `node tools/rt11-term.js <tape-file>` is honoured: a first positional
// argument that names an existing non-disk file is treated as a tape.
let image = opts.image;
let urlName = opts.urlName;
let bootCmd = opts.bootCmd;
const prof = (opts.device && DEVICE_PROFILES[opts.device]) || null;
if (prof) {
    if (!image) image = prof.image;
    if (!urlName) urlName = prof.urlName;
    if (!bootCmd) bootCmd = prof.bootCmd;
}
if (positional.length) {
    const p0 = path.resolve(REPO, positional[0]);
    if (fs.existsSync(p0) && !/\.dsk(\.zst)?$/i.test(positional[0])) {
        if (!opts.tapeFile) opts.tapeFile = positional[0];
    } else {
        if (!image && positional[0]) image = positional[0];
        if (!urlName && positional[1]) urlName = positional[1];
        if (!bootCmd && positional[2]) bootCmd = positional[2].endsWith("\r") ? positional[2] : positional[2] + "\r";
    }
}
if (!image) image = "media/rk1.dsk.zst";
if (!urlName) urlName = "rk0.dsk";
if (!bootCmd) bootCmd = "BOOT RK0\r";

const interactive = process.stdin.isTTY;

// ----------------------------------------------------------------------
// State
// ----------------------------------------------------------------------

let boot = null;
let consoleDev = null;
let ptr = null;
let disk = null;
let shuttingDown = false;
let rlRef = null;            // interactive readline (for prompt redraw)

// Paper-tape tracking. The PtrPtp device holds tape data in the shared
// DiskService and exposes only ptControlblock/tapeState; :rewind forgets
// the device's block (so ptControlblock.url would read "(none)"), and the
// device's tapeState is coarse. Track the mounted tape name + state here so
// :status stays truthful after a rewind and can report reader state
// the way the legacy puppeteer tool did.
let mountedTapeName = null;  // basename of the tape loaded in the reader
let mountedTapeState = "none"; // none|at-start|ready|consumed (from PtrPtp)

/** tapeStateLabel — human label for a PtrPtp tapeState. */
function tapeStateLabel(state) {
    switch (state) {
        case "at-start": return "at start";
        case "ready":  return "ready";
        case "consumed": return "end";
        case "none":  return "(no tape)";
        default:      return state || "?";
    }
}

// Prompt engine state (identical contract to rt11-term.js).
let outTail = "";            // recent console output (for :wait matching)
let lineStart = true;        // next char starts a fresh line
let curLine = "";            // chars of the current line
let silenceTimer = null;     // armed when a candidate prompt line is seen
let promptWaiters = [];      // resolve() callbacks waiting for the prompt
let markerWaiters = [];      // { marker, resolve, timer }
let echoPending = null;      // line we sent, awaiting guest echo (batch)
let echoIdx = 0;
let echoFailed = false;

// Lazy fzstd (assets/vendor/fzstd.js) in its own VM context for .zst tapes.
let _fzstd = null;
function fzstd() {
    if (_fzstd) return _fzstd;
    const sb = vm.createContext({});
    vm.runInContext(
        fs.readFileSync(path.join(REPO, "assets/vendor/fzstd.js"), "utf8"),
        sb, { filename: "assets/vendor/fzstd.js" });
    _fzstd = sb.fzstd;
    return _fzstd;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ----------------------------------------------------------------------
// Prompt / marker engine
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

// :wait <marker> — substring match anywhere in the output tail.
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

function sendLine(line) {
    const bytes = [];
    for (let i = 0; i < line.length; i++) bytes.push(line.charCodeAt(i) & 0x7f);
    bytes.push(13); // CR — the teletype's Enter
    sendBytes(bytes);
}

function sendBytes(bytes) {
    if (consoleDev) consoleDev.receive(bytes);
}

// ----------------------------------------------------------------------
// Tape mount / rewind / punch export
// ----------------------------------------------------------------------

function resolveTapeFile(hostFile) {
    const candidates = [
        path.resolve(hostFile),
        path.resolve(REPO, hostFile),
        path.resolve(REPO, "media", hostFile),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return candidates[0];
}

function mountTape(hostFile) {
    const resolved = resolveTapeFile(hostFile);
    if (!fs.existsSync(resolved)) {
        console.error("headless-term: no such file: " + hostFile);
        return false;
    }
    let raw;
    if (/\.zst$/i.test(resolved)) {
        console.error("headless-term: decompressing " + path.basename(resolved) + " ...");
        raw = Buffer.from(fzstd().decompress(new Uint8Array(fs.readFileSync(resolved))));
    } else {
        raw = fs.readFileSync(resolved);
    }
    // Mount into the shared DiskService so PTR11 sees the tape: the
    // end-of-tape condition (provider.length) lets the guest driver finish
    // the transfer instead of reading past the end forever.
    const name = path.basename(hostFile).replace(/\.zst$/i, "").replace(/\.ptap$/i, "") + ".ptap";
    disk.mountDrive(name, {
        readBlock: async (n) => {
            const start = n * IO_BLOCKSIZE;
            if (start >= raw.length) return new Uint8Array(0);
            return raw.subarray(start, Math.min(start + IO_BLOCKSIZE, raw.length));
        },
        writeBlock: async () => { /* tapes are read-only */ },
        length: raw.length,
    });
    ptr.loadTape(name);
    mountedTapeName = name;
    mountedTapeState = ptr.tapeState || "at-start";
    console.error("headless-term: mounted " + path.basename(hostFile) + " (" + raw.length + " bytes)");
    return true;
}

function rewindTape() {
    // Rewind the reader to the start of the CURRENTLY mounted tape. The
    // PtrPtp device forgets its control block on rewind (ptControlblock =>
    // undefined, tapeState => "none"), but the tape data lives on in the
    // shared DiskService. Remember the mounted name so :status stays
    // truthful — a rewind doesn't unmount the tape.
    if (!mountedTapeName && !(ptr.ptControlblock || {}).url) {
        console.error("headless-term: no tape mounted — nothing to rewind");
        return;
    }
    const name = mountedTapeName || (ptr.ptControlblock && ptr.ptControlblock.url);
    mountedTapeName = name;
    ptr.loadTape(name); // re-mount at position 0 (start of tape)
    mountedTapeState = "at-start";
    console.error("headless-term: reader tape rewound (" + name + ")");
}

function exportPunch(hostFile) {
    const out = ptr.punchBytes();
    if (!out.length) {
        console.error("headless-term: punch buffer is empty — nothing to export");
        return false;
    }
    fs.writeFileSync(path.resolve(REPO, hostFile), Buffer.from(out));
    console.error("headless-term: exported " + out.length + " bytes to " + hostFile);
    ptr.clearPunch();
    return true;
}

// ----------------------------------------------------------------------
// Commands
// ----------------------------------------------------------------------

async function handleCommand(line) {
    // The ':' prefix is optional (command mode enters commands bare, SIMH
    // style); guest-mode ':' lines and batch lines keep working unchanged.
    const rest = (line.startsWith(PREFIX) ? line.slice(PREFIX.length) : line).trim();
    const [cmd, ...argParts] = rest.split(/\s+/);
    const arg = argParts.join(" ");
    switch (cmd) {
        case "mount":
            if (!arg) { console.error("headless-term: usage: :mount <file>"); break; }
            mountTape(arg);
            break;
        case "rewind":
            rewindTape();
            break;
        case "export":
            if (!arg) { console.error("headless-term: usage: :export <file>"); break; }
            exportPunch(arg);
            break;
        case "wait": {
            if (!arg) { console.error("headless-term: usage: :wait <marker>"); break; }
            console.error("headless-term: waiting for " + JSON.stringify(arg) + " ...");
            const ok = await waitForMarker(arg, opts.promptTimeout * 1000);
            console.error(ok ? "headless-term: marker seen" : "headless-term: TIMEOUT waiting for marker");
            break;
        }
        case "raw": {
            const hex = arg.replace(/[^0-9a-fA-F]/g, "");
            if (!hex || hex.length % 2) {
                console.error("headless-term: usage: :raw <hex bytes, e.g. 0304>");
                break;
            }
            const bytes = [];
            for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
            sendBytes(bytes);
            break;
        }
        case "status":
            // Truthful reader tape name/state tracked here: the PtrPtp
            // device forgets ptControlblock on rewind, and its live tapeState
            // is coarse — so surface our tracked mount + a human state label.
            const tapeName = mountedTapeName ||
                (ptr.ptControlblock && ptr.ptControlblock.url) || null;
            const stateLabel = tapeStateLabel(ptr.tapeState || "none");
            console.error("headless-term: device=" + (opts.device || "custom") +
                " | reader tape=" + (tapeName || "(none)") +
                " (" + stateLabel + ")" +
                " | punch=" + ptr.punchBytes().length + " bytes" +
                " | prompt=" + JSON.stringify(opts.prompt));
            break;
        case "help":
            console.error(
                "headless-term commands:\n" +
                "  :mount <file>   load paper tape (.ptap/.zst) into the reader\n" +
                "  :rewind         rewind the reader tape\n" +
                "  :export <file>  save punch output since last export, clear buffer\n" +
                "  :wait <marker>  wait for <marker> in guest output\n" +
                "  :raw <hex>      send raw bytes (e.g. :raw 03 = ^C)\n" +
                "  :status         show reader tape / punch bytes / mode\n" +
                "  :quit | :exit   exit\n" +
                "  :help           this help\n" +
                "Command mode (SIMH-style): Ctrl+E on an empty line enters or\n" +
                "leaves it. In command mode the ':' prefix is optional and\n" +
                "'guest' (or 'go') returns to the RT-11 console.");
            break;
        case "quit":
        case "exit":
            await shutdown(0);
            break;
        default:
            console.error("headless-term: unknown command :" + cmd + " (try :help)");
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
        sendLine(trimmed);
        const ok = await waitForPrompt(opts.promptTimeout * 1000);
        if (!ok) {
            console.error("headless-term: TIMEOUT waiting for prompt after: " + trimmed);
        }
        if (echoFailed && !opts.quiet) {
            process.stdout.write(trimmed + "\r\n");
        }
    }
    console.error("headless-term: end of input");
    await shutdown(0);
}

// ----------------------------------------------------------------------
// Interactive mode
// ----------------------------------------------------------------------

function runInteractive() {
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
    // SIMH-style command mode: Ctrl+E (0x05) on an empty line enters or
    // leaves it. In command mode every line is a utility command and the
    // ':' prefix is optional; 'guest' (or 'go') returns to the console.
    // The switch is accepted only on an empty line so a half-typed guest
    // line is never mangled (same convention as Ctrl+D-to-exit).
    let cmdMode = false;
    const CMD_PROMPT = "headless-term> ";
    const enterCmdMode = () => {
        cmdMode = true;
        rl.setPrompt(CMD_PROMPT);
        rl.prompt();
        console.error("headless-term: command mode (SIMH-style). Commands without ':' " +
            "(:help lists them); 'guest' or Ctrl+E returns to the RT-11 console.");
    };
    const leaveCmdMode = () => {
        cmdMode = false;
        rl.setPrompt("");
        rl.prompt();
        console.error("headless-term: back to the RT-11 console (Ctrl+E re-enters command mode).");
    };
    process.stdin.on("keypress", (str, key) => {
        if (!key || !key.ctrl || key.name !== "e") return;
        if (cmdMode) {
            if (!rl.line) leaveCmdMode();
        } else if (!rl.line) {
            enterCmdMode();
        }
    });

    rl.prompt();
    rl.on("line", async (line) => {
        if (shuttingDown) return;
        if (cmdMode) {
            const t = line.trim();
            if (t === "guest" || t === "go") {
                leaveCmdMode();
            } else {
                await handleCommand(line);
            }
        } else if (line.startsWith(PREFIX)) {
            await handleCommand(line);
        } else {
            sendLine(line);
        }
        rl.prompt();
    });
    console.error("headless-term: RT-11 console online. Lines go to the guest; " +
        PREFIX + "prefix = utility commands (:help). Ctrl+C -> ^C to guest, " +
        "Ctrl+D exits, Ctrl+E (empty line) toggles command mode (SIMH-style).");
}

// ----------------------------------------------------------------------
// Shutdown
// ----------------------------------------------------------------------

async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (boot && typeof boot.halt === "function") {
        try { boot.halt(); } catch (e) { /* ignore */ }
    }
    process.exit(code);
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

(async () => {
    process.on("SIGINT", () => { shutdown(0); });
    process.on("SIGTERM", () => { shutdown(0); });

    boot = await bootHeadless({
        image: image,
        urlName: urlName,
        bootCmd: opts.steps.length ? undefined : bootCmd,
        steps: opts.steps.length ? opts.steps : undefined,
        waitFor: opts.prompt,
        // Honor a per-profile boot timeout (rp* guests boot slowly to login;
        // see DEVICE_PROFILES) falling back to the default. Custom images
        // (no profile) keep DEFAULT_BOOT_TIMEOUT_MS.
        timeoutMs: (prof && prof.timeoutMs) || DEFAULT_BOOT_TIMEOUT_MS,
    });
    consoleDev = boot.machine.findDevice("console");
    ptr = boot.machine.findDevice("ptr");
    disk = boot.machine.disk;

    // Wire live output: every character the guest prints after boot
    // streams through the prompt/marker engine to stdout. The tail starts
    // from the boot output so :wait can match markers already printed.
    consoleDev.installOutputHook((ch) => { onConsoleChar(ch & 0x7f); });
    outTail = boot.out.slice(-MAX_TAIL);
    process.stdout.write(boot.out);
    console.error("headless-term: RT-11 is up (prompt " + JSON.stringify(opts.prompt) + ").");

    if (opts.tapeFile) {
        mountTape(opts.tapeFile);
    }

    if (interactive) {
        runInteractive();
    } else {
        await runBatch();
    }
})().catch((e) => {
    // Explicit, unmistakable timeout notice (plus the guest output we managed
    // to capture, so the point where boot stalled is visible). Tailouts embed
    // the collected console text either on the error object (partialOut) or in
    // the message after the first newline; surface it, then report clearly.
    const isTimeout = /timeout/i.test(String(e && e.message || e));
    if (isTimeout) {
      // Collect whatever console output came with the error.
      let captured = "";
      if (e && e.partialOut) captured = e.partialOut;
      else if (e && e.message) {
        const nl = e.message.indexOf("\n");
        if (nl !== -1) captured = e.message.slice(nl + 1);
      }
      const head = (e && e.message || "").split("\n")[0];
      console.error("headless-term: TIMEOUT -- " + head);
      console.error("headless-term: (boot did not reach the expected prompt; " +
        "raise --prompt-timeout or the profile timeout if this is a slow guest)");
      if (captured) {
        process.stdout.write(captured);
        if (!/\n$/.test(captured)) process.stdout.write("\n");
      }
      shutdown(2);
      return;
    }
    console.error("headless-term: fatal: " + (e && e.stack || e));
    shutdown(2);
});
