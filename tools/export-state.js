#!/usr/bin/env node
/**
 * export-state.js — take a machine state from a headless boot and write it
 * as a .state.zst file.
 *
 * The state FORMAT is src/state-format.js, the same module the browser store
 * uses. This tool adds the two Node ends: driving a headless machine to the
 * SAME readiness point the quick-boot wizard reaches, and compressing the
 * container to disk.
 *
 * The steps are the scenario's own (`src/osboot.js` -> steps[]), replayed in
 * the order the wizard plays them, waiting for each step's prompt before the
 * next one goes out. That is the whole point: a state is taken where the
 * "magic wand" finishes, which is where a user of the wizard ends up. Taking
 * it anywhere else (e.g. waiting for a prompt nobody sent the keystrokes for)
 * is a different, and wrong, moment.
 *
 * Usage:
 *   node tools/export-state.js <device> [out.state.zst]
 *   node tools/export-state.js rk0
 *   node tools/export-state.js rp1 states/rp1-ready.state.zst
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const { bootHeadless } = require("./headless-machine.js");
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
const StateIO = require("./state-io.js");

// The application version this tool speaks for — the same source the page uses
// (package.json, which src/version.js mirrors on the browser side). Stamped
// into every state as yaPDPVersion for the newer-snapshot warning.
const YA_PDP_VERSION = require(path.join(ROOT, "package.json")).version;

function loadScenarios() {
    const sb = { console, window: {} };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "osboot.js"), "utf8"), sb);
    return sb.OSBoot;
}

function scenarioFor(osboot, device) {
    const sc = osboot.BOOT_SCENARIOS.find((s) => s.device === device);
    if (!sc) {
        throw new Error("no scenario '" + device + "' (known: " +
            osboot.BOOT_SCENARIOS.map((s) => s.device).join(", ") + ")");
    }
    return sc;
}

function profileKey(sc) {
    const h = sc.hardware || {};
    return [h.console, h.printer, h.vt11].map(String).join("|");
}

function firstExisting(candidates) {
    for (const c of candidates) {
        if (fs.existsSync(path.join(ROOT, c))) return c;
    }
    throw new Error("no image found, tried: " + candidates.join(", "));
}

function imageFor(osboot, sc) {
    if (sc.paperTape) {
        return {
            image: firstExisting([
                "media/" + sc.paperTape + ".ptap.zst",
                "media/" + sc.paperTape + ".ptap"]),
            urlName: sc.paperTape + ".ptap",
        };
    }
    const url = sc.url || osboot.urlFor(sc.device);
    return {
        image: firstExisting([
            "media/" + url.replace(/\.dsk$/, "") + ".dsk.zst",
            "media/" + url]),
        urlName: url,
    };
}

// --- the wizard's step loop, headless ----------------------------------
// Mirrors runSteps()/waitForPrompt() in src/quickboot.js, TIMING INCLUDED.
// The timing is not decoration: the console is an authentic 110-baud
// teletype, and a step that goes out before the guest is ready for it gets
// its first byte swallowed by the previous command (measured: "@boot rk0u"
// then "@nixr" — the 'u' of "unix" and the 'r' of "root" eaten).
//
//   step 0 (the boot command) waits delayFor(0) = 2 x base
//   a plain step waits base before sending
//   a step with waitFor sends only once its marker appears, then waits base
//
// base = stepDelayMs(speed): 800ms fast, 1600ms authentic.
function stepDelayMs(speed) {
    return (speed === "authentic") ? 1600 : 800;
}

function delayFor(index, base) {
    return (index === 0) ? base * 2 : base;
}

async function runSteps(booted, sc, opts, echo) {
    const base = stepDelayMs((opts && opts.speed) || "fast");
    // The wizard's own wait budget (WAIT_TIMEOUT_MS in src/quickboot.js).
    const waitTimeoutMs = (opts && opts.stepTimeoutMs) || 180000;
    const waitPollMs = 200;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Steps as the wizard builds them: the boot command first, then the
    // scenario's own follow-ups.
    const steps = [{ send: sc.boot }].concat(sc.steps || []);
    log("steps to run: " + steps.length + " (" + steps.map((s) =>
        s.ctrlD ? "^D" : JSON.stringify(s.send == null ? "" : s.send)).join(" -> ") + ")");

    // window.dlReceiveQueue feeds the console device (bridge contract).
    const queue = booted.evalIn("window.dlReceiveQueue");
    const send = (step) => {
        const bytes = step.ctrlD ? [4]
            : (step.send || "").split("").map((c) => c.charCodeAt(0)).concat([13]);
        log("  send | " + (step.ctrlD ? "^D" : JSON.stringify(step.send == null ? "" : step.send)) +
            "  (" + bytes.length + " bytes)");
        queue(0, bytes);
        if (echo) echo();
    };
    const contains = (needle) => booted.getOut().indexOf(needle) !== -1;

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        log("step " + (i + 1) + "/" + steps.length + (step.waitFor
            ? " waiting for " + JSON.stringify(step.waitFor) : " (no marker)"));
        if (step.wait) {
            // Pure delay step (no input): let the guest settle.
            await sleep(step.wait);
            continue;
        }
        if (step.waitFor) {
            // Do not send until the marker appears — but the step that CARRIES
            // the marker is sent first (it is the one that triggers it), so the
            // send happens after the wait, as in waitForPrompt().
            await sleep(step.wait || 0);
            const t0 = Date.now();
            let lastSeen = booted.getOut().length;
            while (!contains(step.waitFor)) {
                if (echo) echo();
                // While waiting, report the console growth so a long boot is
                // legible: "nothing new for 12.3s" is information, silence is
                // not. Printed every poll, which is cheap and bounded.
                const nowLen = booted.getOut().length;
                if (nowLen !== lastSeen) {
                    lastSeen = nowLen;
                    log("  waiting for " + JSON.stringify(step.waitFor) +
                        ": console at " + nowLen + " bytes (" +
                        ((Date.now() - t0) / 1000).toFixed(1) + "s)");
                }
                if (Date.now() - t0 > waitTimeoutMs) {
                    throw new Error("step " + (i + 1) + " timed out after " +
                        (Date.now() - t0) + "ms waiting for " +
                        JSON.stringify(step.waitFor) + "\n--- console tail ---\n" +
                        tail(booted.getOut(), 1200));
                }
                await sleep(waitPollMs);
            }
            log("  marker seen: " + JSON.stringify(step.waitFor) +
                " after " + (Date.now() - t0) + "ms");
            send(step);
            await sleep(base);
        } else {
            await sleep(delayFor(i, base));
            send(step);
        }
        if (echo) echo();
    }
    log("all steps done");
}

function tail(s, n) {
    return s.length <= n ? s : "…" + s.slice(s.length - n);
}

// --- logging ------------------------------------------------------------
// Every line carries a timestamp and a tag, and the guest's console is echoed
// as it grows, so a failed run is READ instead of guessed. The rule this
// enforces: never report "it worked" without the artifact or the error.
const T0 = Date.now();
function stamp() {
    const ms = Date.now() - T0;
    return "[" + String(ms).padStart(7) + "ms] ";
}
const log = (...a) => console.log(stamp() + a.join(" "));
const err = (...a) => console.error(stamp() + a.join(" "));

// Echo console output incrementally: print only what is new since the last
// pump, one line at a time, so the guest's progress is visible in the log.
function makeEchoer(booted) {
    let shown = 0;
    return function pump() {
        const out = booted.getOut();
        if (out.length === shown) return;
        const fresh = out.slice(shown);
        shown = out.length;
        fresh.split("\n").forEach((line) => {
            if (line.length) log("  guest | " + line);
        });
    };
}

// --- capture ------------------------------------------------------------
function captureState(booted, sc) {
    const CPU = booted.evalIn("CPU");
    const manifest = {
        schemaVersion: (StateFormat.SCHEMA_VERSION || "1.0.0"),
        yaPDPVersion: YA_PDP_VERSION,
        base: null,                       // rests directly on the disk image
        device: sc.device,
        label: sc.label || sc.device,
        profile: {
            console: (sc.hardware || {}).console,
            printer: (sc.hardware || {}).printer,
            vt11: (sc.hardware || {}).vt11,
        },
        createdAt: new Date().toISOString(),
        cpu: StateFormat.captureCPU(CPU),
        devices: booted.machine.bus.snapshotDevices(),
    };
    return StateFormat.pack(manifest, CPU.memory);
}

// --- main ---------------------------------------------------------------
async function exportState(device, outPath, opts) {
    const osboot = loadScenarios();
    const sc = scenarioFor(osboot, device);
    const { image, urlName } = imageFor(osboot, sc);

    const timeoutMs = (opts && opts.timeoutMs) || 180000;
    log("=== export " + sc.device + " (" + (sc.label || "") + ") ===");
    log("image:   " + image);
    log("urlName: " + urlName);
    log("profile: " + profileKey(sc));
    log("boot cmd: " + JSON.stringify(sc.boot));

    const t0 = Date.now();
    const booted = await bootHeadless({
        image,
        urlName,
        bootCmd: "",
        waitFor: "@",
        timeoutMs,
    });
    const bootMs = Date.now() - t0;
    log("bootloader prompt after " + bootMs + "ms");

    const echo = makeEchoer(booted);
    echo();

    const t1 = Date.now();
    await runSteps(booted, sc, opts, echo);
    const stepsMs = Date.now() - t1;
    log("steps finished in " + stepsMs + "ms");

    const packed = captureState(booted, sc);
    log("container packed: " + packed.length + " bytes");
    const out = outPath || path.join(ROOT, "states", sc.device + "-ready.state.zst");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // The frame is tools/state-io.js's decision: zstd where this Node can, gzip
    // otherwise (Node 20 has no zstd in zlib). Never a bare container — that
    // would put the state back at its raw size on disk.
    const frame = StateIO.writeBytes(out, Buffer.from(packed));
    if (booted.halt) booted.halt();

    const written = fs.statSync(out);
    log("written: " + path.relative(ROOT, out) + "  " + written.size +
        " bytes (" + frame + ")");

    const kb = (n) => (n / 1024).toFixed(1) + " KB";
    log([
        "RESULT",
        sc.device,
        "profile=" + profileKey(sc),
        "boot=" + bootMs + "ms",
        "steps=" + stepsMs + "ms",
        kb(written.size),
        "(" + (written.size / packed.length * 100).toFixed(1) + "%)",
        "file=" + path.relative(ROOT, out),
    ].join(" "));

    return {
        device: sc.device,
        profile: profileKey(sc),
        packed: packed.length,
        compressed: written.size,
        bootMs, stepsMs,
    };
}

if (require.main === module) {
    const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
    const device = args[0];
    if (!device) {
        console.error("usage: node tools/export-state.js <device> [out.state.zst]");
        process.exit(2);
    }
    exportState(device, args[1]).then(() => {
        log("EXIT 0 (ok)");
        process.exit(0);
    }).catch((e) => {
        err("FAIL(" + device + "): " + (e && e.message ? e.message : e));
        if (e && e.stack) err(e.stack.split("\n").slice(0, 6).join("\n"));
        err("EXIT 1 (failed)");
        process.exit(1);
    });
}

module.exports = { exportState, scenarioFor, profileKey, runSteps };
