#!/usr/bin/env node
/**
 * restore-state.js — restore a machine state from a .state.zst file into a
 * headless machine, and report how long it took versus a cold boot.
 *
 * This is the other half of tools/export-state.js: the point of a state is
 * that starting from it is faster than booting the guest, and the only way to
 * know is to measure. It also proves the loop end to end — the container
 * written by the exporter is read back by the same src/state-format.js and
 * applied to the CPU and the devices.
 *
 * Usage:
 *   node tools/restore-state.js states/rp1-ready.state.zst
 *   node tools/restore-state.js states/rk1-ready.state.zst --twice
 *
 * What it does, in order:
 *   1. decompress the file — whichever frame the writer used, zstd or gzip —
 *      and unpack the container;
 *   2. boot a headless machine to its bootloader prompt (the machine has to
 *      exist before a state can be applied to it);
 *   3. halt the CPU, apply memory, CPU registers and device registers;
 *   4. resume and confirm the guest is alive on its own.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const { bootHeadless } = require("./headless-machine.js");
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
const StateIO = require("./state-io.js");

const T0 = Date.now();
const stamp = () => "[" + String(Date.now() - T0).padStart(7) + "ms] ";
const log = (...a) => console.log(stamp() + a.join(" "));

// Which frame carries the container (zstd from the tools, gzip from the
// browser's own export, none from a writer without a compressor) is
// src/state-frame.js's rule; tools/state-io.js supplies Node's codecs. A state
// saved in the browser therefore restores here.
function readContainer(file) {
    const read = StateIO.readBytes(path.resolve(ROOT, file));
    log("file: " + file + "  " + read.size + " bytes on disk (" + read.frame +
        ") -> " + read.container.length + " bytes unpacked");
    const parsed = StateFormat.unpack(read.container);
    if (!parsed) throw new Error("not a .state container: " + file);
    log("manifest: device=" + parsed.manifest.device +
        " profile=" + JSON.stringify(parsed.manifest.profile) +
        " createdAt=" + parsed.manifest.createdAt);
    return parsed;
}

async function restoreState(file) {
    const parsed = readContainer(file);

    // The machine must exist before a state can be applied to it: boot it to
    // the bootloader prompt, exactly as a user's page would, then overwrite
    // everything the state carries.
    const t0 = Date.now();
    const booted = await bootHeadless({
        image: "media/rk1.dsk.zst",   // only to get a live machine; the image
        urlName: "rk1.dsk",           // is irrelevant, the state overwrites it
        bootCmd: "",
        waitFor: "@",
        timeoutMs: 60000,
    });
    log("machine up in " + (Date.now() - t0) + "ms");

    // 1. Halt, then apply memory FIRST: a machine that runs with the old
    //    memory and a restored PC traps instantly (same order the browser
    //    store uses — see restore() in src/snapshots.js).
    booted.evalIn("CPU.runState = CPU.STATE_HALT");
    const t1 = Date.now();

    const CPU = booted.evalIn("CPU");
    const words = parsed.memoryWords;
    if (words) {
        if (CPU.memory.length === words.length) {
            CPU.memory.set(words);
            log("memory: " + words.length + " words applied in place");
        } else {
            log("memory: size differs (machine " + CPU.memory.length +
                " words, state " + words.length + ") — replacing");
            booted.evalIn("CPU.memory = new Uint16Array(" + words.length + ")");
            booted.evalIn("CPU").memory.set(words);
        }
    } else {
        log("memory: none in this state");
    }

    // 2. CPU registers (runState last: it is what lets the machine run).
    const savedCpu = parsed.manifest.cpu || {};
    StateFormat.restoreCPU(booted.evalIn("CPU"), savedCpu, true);
    log("cpu: " + Object.keys(savedCpu).length + " fields applied");

    // 3. Device registers.
    if (parsed.manifest.devices) {
        const n = booted.machine.bus.restoreDevices(parsed.manifest.devices);
        log("devices: restored (" + (typeof n === "number" ? n : "?") + " region(s))");
    }

    const applyMs = Date.now() - t1;

    // 4. Resume. The saved runState decides whether it runs or waits.
    const savedRunState = savedCpu.runState;
    booted.evalIn("CPU.runState = " + (typeof savedRunState === "number"
        ? savedRunState : "0"));
    log("resumed (runState=" + savedRunState + ") after " + applyMs + "ms");

    // 5. Is the guest alive? Feed it a newline and see if the console grows.
    const before = booted.getOut().length;
    booted.evalIn("window.dlReceiveQueue")(0, [13]);
    await new Promise((r) => setTimeout(r, 1500));
    const after = booted.getOut().length;
    const grew = after > before;
    log("liveness: console " + (grew ? "GREW" : "did not grow") +
        " (" + before + " -> " + after + " bytes)");
    if (grew) {
        log("  guest | " + booted.getOut().slice(before).split("\n")
            .filter(Boolean).slice(-3).join(" / "));
    }

    return { bootMs: Date.now() - t0 - applyMs, applyMs, alive: grew, booted };
}

if (require.main === module) {
    const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
    const file = args[0];
    if (!file) {
        console.error("usage: node tools/restore-state.js <file.state.zst>");
        process.exit(2);
    }
    restoreState(file).then((r) => {
        log("RESULT restore=" + r.applyMs + "ms alive=" + r.alive +
            " total=" + (r.bootMs + r.applyMs) + "ms");
        log("EXIT 0 (ok)");
        process.exit(0);
    }).catch((e) => {
        log("FAIL: " + (e && e.message ? e.message : e));
        if (e && e.stack) log(e.stack.split("\n").slice(0, 6).join("\n"));
        log("EXIT 1 (failed)");
        process.exit(1);
    });
}

module.exports = { restoreState, readContainer };
