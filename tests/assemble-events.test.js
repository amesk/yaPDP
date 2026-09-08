#!/usr/bin/env node
/**
 * yaPDP — structural tests for the reel-event consumption in the assembler.
 *
 * tools/assemble-video.js now reads the video/<base>.events.json sidecars that
 * tools/record-video.js writes, synthesises the spoken phrases through
 * tools/voicer.js, mixes them into the clip audio at their media offsets, and
 * emits chapters/subtitle sidecars + burned banner (and, with --burn-subtitles,
 * bottom-subtitle) overlays. Full runs need ffmpeg + a real render, so — like
 * tests/video-shots.test.js — this file pins the WIRING structurally.
 *
 * Run with:  node tests/assemble-events.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "tools", "assemble-video.js"), "utf8");

// --- Helpers must exist ------------------------------------------------------

assert.ok(src.includes('const timeline = require("./reel-timeline-util.js");'),
    "assemble-video must use the shared reel-timeline model");

for (const fn of ["readClipEvents", "voiceClipEvents", "clipPhrases",
    "mixClipPhrases", "writeMediaSidecars", "burnOverlays"]) {
    assert.ok(src.includes("function " + fn),
        "the assembler must define " + fn + "()");
}

// --- Sidecar reading + phrase caching ----------------------------------------

assert.ok(src.includes('timeline.validateEvents((data && data.events) || [])'),
    "clip events must be validated via the shared model");
assert.ok(src.includes('"phr-" + timeline.phraseCacheKey(e.text, engine)'),
    "spoken phrases must use the content-addressed WAV cache");
assert.ok(src.includes("e.wav = wav || null;"),
    "each speak event must carry its synthesised WAV");

// --- Clip audio mixing --------------------------------------------------------

assert.ok(src.includes("adelay=") && src.includes("apad[px") &&
    src.includes("amix=inputs="),
    "phrases must be delayed + mixed into the clip audio");
assert.ok(src.includes('"-map", "0:v", "-map", "[aout]"'),
    "the phrase mix must keep the clip video and replace only the audio");

// --- main(): load events, tag clip segments, aggregate reel sidecars ----------

assert.ok(src.includes("const clipEvents = {};"),
    "main() must load the clip events once");
assert.ok(src.includes("await voiceClipEvents(ev, voiceForce, voiceEngine)"),
    "main() must voice the loaded clip events up front");
assert.ok(src.includes("clipEvents, burnSubtitles"),
    "the voice ctx must carry clip events + the burn flag to exportIndividual");
assert.ok(src.includes('base: path.basename(c.file, ".webm")'),
    "reel clip segments must be tagged with their clip base name");
assert.ok(src.includes("clipPhrases(clipEvents[entry.base])"),
    "the reel segment loop must mix a clip's spoken phrases");
assert.ok(src.includes("const segStarts = vutil.segmentStarts(durs, FADE);"),
    "the reel must compute absolute segment starts for event mapping");
assert.ok(src.includes("timeline.planArtifacts(evs, segStarts[rawIndexByBase[base]])"),
    "reel events must be mapped via each clip's segment start");
assert.ok(src.includes("writeMediaSidecars(OUT, reelChapters, reelSrt)"),
    "the reel must write its chapters/subtitle sidecars");
assert.ok(src.includes('burnOverlays(OUT, burned, reelBanners, reelSrt, burnSubtitles)'),
    "the reel must burn its banner overlays");

// --- exportIndividual(): mix phrases + write clip sidecars --------------------

assert.ok(src.includes("mixClipPhrases(aClip, clipPhrasesNow"),
    "exportIndividual must mix the clip's phrases into its aligned segment");
assert.ok(src.includes("timeline.planArtifacts(clipEv, starts[2])"),
    "exportIndividual must map the clip's events onto its own timeline (clip = segment 2)");
assert.ok(src.includes("writeMediaSidecars(out, art.chapters, art.srt)"),
    "exportIndividual must write the clip's chapters/subtitle sidecars");

process.stdout.write("All assemble-events structural tests passed.\n");
