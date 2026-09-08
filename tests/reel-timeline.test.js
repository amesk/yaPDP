#!/usr/bin/env node
/**
 * yaPDP — reel-timeline pure-helper tests.
 *
 * tools/record-video.js stamps timed reel events (chapters, titles, spoken
 * phrases, subtitles) onto each recorded clip and writes them to a .events.json
 * sidecar; tools/assemble-video.js maps them onto the final timeline, speaks
 * the phrases and emits chapter/subtitle files. All of the pure maths that does
 * not touch the browser/ffmpeg/disk lives in tools/reel-timeline-util.js — so
 * this file pins it here:
 *   1. validateEvents()/parseSidecar() accept well-formed events and reject
 *      malformed ones;
 *   2. resolveEvents() maps clip-relative times onto the absolute timeline;
 *   3. estimateDur() sizes a missing subtitle/banner duration by reading speed;
 *   4. fmtMmss()/fmtSrtTs()/formatChapters()/formatSrt() render the YouTube
 *      chapter block and the SRT document;
 *   5. phraseCacheKey() is content-addressed (stable, changes with text/engine).
 *
 * Run with:  node tests/reel-timeline.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const path = require("path");
const util = require(path.join(__dirname, "..", "tools", "reel-timeline-util.js"));

const { validateEvents, parseSidecar, resolveEvents, planArtifacts,
    estimateDur, fmtMmss, fmtSrtTs, formatChapters, formatSrt,
    phraseCacheKey, SUB_MIN, SUB_MAX, SUB_RATE } = util;

// --- 1. validateEvents / parseSidecar --------------------------------------

// A well-formed event list normalises (title gets the default "banner" mode).
const ev = validateEvents([
    { type: "chapter", t: 3.0, text: "Booting" },
    { type: "title", t: 12.4, text: "DUNGEON" },
    { type: "title", t: 20, text: "Big", mode: "card" }, // card not supported yet -> banner
    { type: "speak", t: 30, text: "Watch the prompt.", dur: 0 },
    { type: "subtitle", t: 40, text: "A line", dur: 2.5 }
]);
assert.strictEqual(ev.length, 5);
assert.strictEqual(ev[0].type, "chapter");
assert.strictEqual(ev[0].t, 3.0);
assert.strictEqual(ev[1].mode, "banner", "title defaults to banner");
assert.strictEqual(ev[2].mode, "banner", "unsupported mode falls back to banner");
assert.strictEqual(ev[3].dur, 0, "an explicit dur is kept (0 allowed)");
assert.ok(!("dur" in ev[0]), "chapters carry no dur");

assert.throws(() => validateEvents("nope"), "a non-array must be rejected");
assert.throws(() => validateEvents([null]), "a null event must be rejected");
assert.throws(() => validateEvents([{ type: "bogus", t: 1, text: "x" }]),
    "an unknown type must be rejected");
assert.throws(() => validateEvents([{ type: "chapter", t: -1, text: "x" }]),
    "a negative t must be rejected");
assert.throws(() => validateEvents([{ type: "chapter", t: "a", text: "x" }]),
    "a non-numeric t must be rejected");
assert.throws(() => validateEvents([{ type: "chapter", t: 1, text: "  " }]),
    "empty text must be rejected");
assert.throws(() => validateEvents([{ type: "speak", t: 1, text: "x", dur: -2 }]),
    "a negative dur must be rejected");

// parseSidecar wraps the clip name + validated events.
const sidecar = parseSidecar({ clip: "rt11.webm", events: ev });
assert.strictEqual(sidecar.clip, "rt11.webm");
assert.strictEqual(sidecar.events.length, 5);
assert.deepStrictEqual(parseSidecar({ events: [] }).events, []);

// --- 2. resolveEvents --------------------------------------------------------

// A clip that starts at absolute 8.2 s on the output maps media time onto it.
const resolved = resolveEvents(ev, 8.2);
assert.strictEqual(resolved[0].abs, 11.2, "abs = clipStart + t");
assert.strictEqual(resolved[1].abs, 20.6);
assert.strictEqual(resolveEvents([], 5).length, 0);
assert.strictEqual(resolveEvents(ev, undefined)[0].abs, 3.0,
    "a missing clipStart keeps media time (clip starts at 0)");

// --- 2b. planArtifacts ---------------------------------------------------------

// A clip that starts at absolute 100 s on the output: chapters become marks,
// spoken phrases (with a measured dur) become bottom subtitles, title events
// become burned banners, explicit subtitles become more srt blocks. A phrase
// without a WAV (no dur) must be skipped.
const art = planArtifacts([
    { type: "chapter", t: 3, text: "Booting" },
    { type: "title", t: 5, text: "DUNGEON", dur: 6 },
    { type: "speak", t: 7, text: "Watch the prompt.", dur: 2.4 },
    { type: "speak", t: 9, text: "never voiced" },
    { type: "subtitle", t: 12, text: "A line", dur: 3 }
], 100);
assert.deepStrictEqual(art.chapters, [{ start: 103, text: "Booting" }],
    "chapters are mapped onto the absolute timeline");
assert.deepStrictEqual(art.banners, [{ start: 105, end: 111, text: "DUNGEON" }],
    "title banners carry an absolute [start,end] window");
assert.strictEqual(art.srt.length, 2, "unvoiced phrases are skipped");
assert.strictEqual(art.srt[0].start, 107, "a spoken subtitle starts with the phrase");
assert.strictEqual(art.srt[0].end, 107 + 2.4 + 0.25, "a spoken subtitle adds a tail");
assert.strictEqual(art.srt[1].start, 112, "an explicit subtitle uses its dur");
assert.deepStrictEqual(planArtifacts([], 0),
    { chapters: [], srt: [], banners: [] }, "empty events yield empty artifacts");

// --- 3. estimateDur -----------------------------------------------------------

// ~15 chars/s, floored to SUB_MIN and capped at SUB_MAX.
assert.strictEqual(estimateDur("Hi"), SUB_MIN, "short text hits the floor");
assert.strictEqual(estimateDur(""), SUB_MIN);
assert.strictEqual(estimateDur("x".repeat(SUB_MAX * SUB_RATE + 100)), SUB_MAX,
    "very long text is capped");
const mid = estimateDur("x".repeat(30));
assert.ok(Math.abs(mid - 30 / 15) < 1e-6, "duration tracks reading speed");
assert.strictEqual(estimateDur("Hello there", { min: 3, rate: 5 }), 3,
    "min/rate options must be honoured");

// --- 4. Formatters ------------------------------------------------------------

assert.strictEqual(fmtMmss(0), "0:00");
assert.strictEqual(fmtMmss(59), "0:59");
assert.strictEqual(fmtMmss(60), "1:00");
assert.strictEqual(fmtMmss(754), "12:34");
assert.strictEqual(fmtMmss(3723), "1:02:03", "hours get the H:MM:SS shape");
assert.strictEqual(fmtMmss(-5), "0:00", "negative clamps to zero");

assert.strictEqual(fmtSrtTs(1.5), "00:00:01,500");
assert.strictEqual(fmtSrtTs(3723.05), "01:02:03,050");

// Chapters: ordered, de-duplicated lines in MM:SS Title form (12.4 -> 0:12).
const chapters = formatChapters([
    { start: 30, text: "RT-11 prompt" },
    { start: 12.4, text: "DUNGEON" },
    { start: 12.4, text: "DUNGEON" },
    { start: 0, text: "" }
]);
assert.strictEqual(chapters, "0:12 DUNGEON\n0:30 RT-11 prompt",
    "chapters are sorted and deduped");

// SRT: sorted blocks, gaps dropped, standard layout.
const srt = formatSrt([
    { start: 0, end: 5, text: "One" },
    { start: 3, end: 1, text: "bad window" },
    { start: 6, end: 8.5, text: "Two" },
    { text: "no window" }
]);
assert.ok(srt.startsWith("1\n00:00:00,000 --> 00:00:05,000\nOne\n"),
    "SRT must open with the first block");
assert.ok(srt.indexOf("2\n00:00:06,000 --> 00:00:08,500\nTwo\n") !== -1,
    "the second valid block must follow");
assert.ok(srt.indexOf("bad window") === -1 && srt.indexOf("no window") === -1,
    "bad/empty windows are dropped");
assert.strictEqual(formatSrt([]), "");

// --- 5. phraseCacheKey ---------------------------------------------------------

const k1 = phraseCacheKey("Hello world", "auto");
assert.strictEqual(k1.length, 16, "key is a short hex digest");
assert.strictEqual(phraseCacheKey("Hello world", "auto"), k1,
    "same text+engine must be stable");
assert.notStrictEqual(phraseCacheKey("Hello world", "kokoro"), k1,
    "a changed engine must change the key");
assert.notStrictEqual(phraseCacheKey("Hello world!", "auto"), k1,
    "a changed phrase must change the key");

process.stdout.write("All reel-timeline tests passed.\n");
