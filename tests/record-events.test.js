#!/usr/bin/env node
/**
 * yaPDP — structural tests for the timed reel-event recording.
 *
 * tools/record-video.js now stamps timed reel events (chapters, banner titles,
 * spoken phrases, bottom subtitles) while a demo clip is being recorded and
 * writes them to video/<base>.events.json for tools/assemble-video.js. Those
 * paths need a real browser capture, so — like tests/video-shots.test.js —
 * this file pins the WIRING structurally: the recorder/helpers exist, every
 * capture function starts the media-time clock and writes the sidecar, and the
 * declarative shot annotations drive the demo steps.
 *
 * Run with:  node tests/record-events.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "tools", "record-video.js"), "utf8");

// --- Wiring: helpers ---------------------------------------------------------

assert.ok(src.includes('const timeline = require("./reel-timeline-util.js");'),
    "record-video must use the shared reel-timeline model");

// The recorder exposes the three (plus subtitle) primitives and a start() that
// anchors the media-time origin to the moment the capture begins.
assert.ok(src.includes("function createEventRecorder()"),
    "an event recorder must be defined");
for (const method of ["start", "markChapter", "title", "speak", "subtitle"]) {
    assert.ok(new RegExp("\\b" + method + "\\s*\\(").test(src),
        "the recorder must expose " + method + "()");
}

assert.ok(src.includes("function stampStepEvents(recorder, cmd)"),
    "declarative step annotations must be stamped by a shared helper");
assert.ok(src.includes("function writeEventSidecar(shot, recorder)"),
    "a sidecar writer must be defined");
assert.ok(src.includes('path.join(OUT_DIR, base + ".events.json")'),
    "events must be written as video/<base>.events.json");

// --- Wiring: every capture path ----------------------------------------------

// Each of the three capture functions creates a recorder, anchors it right
// after startRecording() and writes the sidecar after a successful save.
assert.ok((src.match(/events\.start\(\);/g) || []).length >= 3,
    "every capture function must anchor the media-time origin after startRecording");
assert.ok((src.match(/writeEventSidecar\(shot, events\);/g) || []).length >= 3,
    "every capture function must write the events sidecar on success");

// The demo-step loops stamp declarative annotations and skip pure annotation
// steps (no command to type). Both console-style and panel-boot loops need it.
assert.ok((src.match(/stampStepEvents\(events, cmd\);/g) || []).length >= 2,
    "both console and panel-boot demo loops must stamp step events");
assert.ok(src.includes("if (!cmd.send && !cmd.ctrlC) continue;"),
    "a pure annotation step must not try to type anything");

// Imperative examples: a banner during the panel bootstrap and one on the
// Lunar Lander start-up card (which survives the assembler's cut).
assert.ok(src.includes('events.title("MANUAL BOOTSTRAP", 6)'),
    "the panel-boot capture announces the bootstrap with a title");
assert.ok(src.includes('events.title("LUNAR LANDER  ·  VT11", 5)'),
    "the lander capture announces the clip on its title card");

// The ASR-tape demo announces the tape load imperatively (basic-tape has no
// typed demo steps to hang an annotation on).
assert.ok(src.includes('events.speak("Loading the heart program from punched tape.")'),
    "the tape feed speaks while the loaded tape is in view");

// --- Declarative annotations in the shot data --------------------------------

// The DUNGEON demos annotate their first step; BASIC and UNIX V5 get a
// leading annotation-only step before their typed commands.
assert.ok(/chapter:\s*"DUNGEON"/.test(src),
    "the DUNGEON steps must carry a chapter annotation");
assert.ok(/speak:\s*"Time for DUNGEON, Digital's text adventure\."/.test(src),
    "the DUNGEON steps must carry a spoken phrase");
assert.ok(/chapter:\s*"BASIC-11",\s*speak:/.test(src),
    "the BASIC shot must open with a chapter + spoken phrase");
assert.ok(/chapter:\s*"UNIX V5",\s*speak:/.test(src),
    "the UNIX V5 shot must open with a chapter + spoken phrase");
assert.ok(src.includes("...BASIC_PROGRAM"),
    "the BASIC shot must still type its BASIC_PROGRAM lines after the annotation");

// --- Sanity: the reel-timeline model still validates our sample --------------

const timeline = require(path.join(ROOT, "tools", "reel-timeline-util.js"));
const sample = timeline.validateEvents([
    { type: "chapter", t: 12, text: "DUNGEON" },
    { type: "speak", t: 12.5, text: "Time for DUNGEON." }
]);
assert.strictEqual(sample.length, 2, "the recorder's events must validate");

process.stdout.write("All record-events structural tests passed.\n");
