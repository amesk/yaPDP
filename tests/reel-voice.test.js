#!/usr/bin/env node
/**
 * yaPDP — reel-voice pure-helper tests.
 *
 * tools/assemble-video.js now narrates its title cards with a TTS voice-over
 * (tools/voicer.js) and ducks the background music while the narration plays.
 * All of the timing maths that decides (a) how long a card must be to fit its
 * speech and (b) where on the final timeline the music must turn down lives in
 * tools/reel-voice-util.js, away from ffmpeg — so this file pins it without a
 * browser or even an ffmpeg binary:
 *   1. speechTargetDuration() stretches a card to fit the narration;
 *   2. voicedSpan() reports the narration's audible span (incl. reverb tail);
 *   3. reelVoiceWindows() maps voiced cards onto the final xfade/acrossfade
 *      timeline (both the reel's FADE=0.8 and exportIndividual's fade=0.6);
 *   4. musicDuckFilters() builds the ffmpeg volume chain (base + per-window
 *      ducking) from those windows.
 *
 * Run with:  node tests/reel-voice.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const path = require("path");
const util = require(path.join(__dirname, "..", "tools", "reel-voice-util.js"));

const { VOICE_PRE, VOICE_PRE_INTRO, VOICE_POST, REVERB_TAIL, VOICE_HOLD_EDGE,
    REVERB_AECHO, speechTargetDuration, voicedSpan, reelVoiceWindows,
    speechDuckWindows, musicDuckFilters, DUCK_BASE, DUCK_LEVEL,
    voiceSignature } = util;

const near = (a, b, eps) => assert.ok(Math.abs(a - b) < (eps || 1e-6),
    `expected ${a} ~= ${b}`);

// --- 1. speechTargetDuration / voicedSpan ---------------------------------

assert.strictEqual(VOICE_PRE, 0.7, "VOICE_PRE must stay 0.7");
assert.ok(VOICE_POST >= REVERB_TAIL,
    "VOICE_POST must absorb the reverb tail so it stays inside the card");

// Base card longer than the speech -> base duration wins.
assert.strictEqual(speechTargetDuration(9, 3), 9,
    "a long card must not grow for short narration");
// Speech longer than the base card -> stretch: PRE + speech + POST.
assert.strictEqual(speechTargetDuration(3, 5),
    VOICE_PRE + 5 + VOICE_POST,
    "a short card must grow to fit long narration");
// Equality at the boundary keeps the card as long as the narration needs.
near(speechTargetDuration(6.5, 5), 6.5);

// The intro card gets a longer lead-in and must be sized by it too.
assert.ok(VOICE_PRE_INTRO > VOICE_PRE,
    "the intro must wait for its title to fade in before speaking");
assert.strictEqual(speechTargetDuration(3, 5, VOICE_PRE_INTRO),
    VOICE_PRE_INTRO + 5 + VOICE_POST,
    "an explicit pre-roll must drive the target length");

// Audible span = PRE + speech + reverb margin.
assert.strictEqual(voicedSpan(2), VOICE_PRE + 2 + Math.max(VOICE_POST, REVERB_TAIL));

// Reverb preset must keep the per-channel "|" values quoted, otherwise the
// filtergraph parser treats "|" as a chain separator.
assert.ok(REVERB_AECHO.indexOf("'20|30'") !== -1,
    "reverb preset must quote per-channel delays");
assert.ok(REVERB_AECHO.indexOf("'0.08|0.06'") !== -1,
    "reverb preset must quote per-channel decays");

// The frame mixSpeech freezes when stretching a card must be a sane number
// (an undefined constant would silently produce NaN trim/tpad arguments).
assert.ok(typeof VOICE_HOLD_EDGE === "number" && VOICE_HOLD_EDGE > 0 &&
    VOICE_HOLD_EDGE < 5, "VOICE_HOLD_EDGE must be a positive, small constant");

// --- 2. reelVoiceWindows ---------------------------------------------------

assert.deepStrictEqual(reelVoiceWindows([], [], 0.8), [],
    "empty chain yields no windows");
assert.deepStrictEqual(reelVoiceWindows([4, 3, 10], [], 0.8), [],
    "no voiced cards yields no windows");

// The reel: [intro(4), slide(3), clip(10), slide(3), clip(10), outro(4)],
// voiced intro + slides + outro at indexes 0,1,5, cross-fade 0.8.
const reel = reelVoiceWindows([4, 3, 10, 3, 10, 4], [0, 1, 5], 0.8);
near(reel.length, 3);
near(reel[0][0], 0); near(reel[0][1], 4);
// Slide 1 becomes audible at durs[0]-fade = 3.2.
near(reel[1][0], 3.2); near(reel[1][1], 6.2);
// Outro: cumulative start 26.0, ends exactly at the reel's total length.
near(reel[2][0], 26.0); near(reel[2][1], 30.0);

// exportIndividual chain: intro, slide, clip, outro (voiced 0,1,3), fade=0.6.
const ind = reelVoiceWindows([4, 9, 60, 4], [0, 1, 3], 0.6);
near(ind.length, 3);
near(ind[0][0], 0); near(ind[0][1], 4);
near(ind[1][0], 3.4); near(ind[1][1], 12.4);
near(ind[2][0], 71.2); near(ind[2][1], 75.2);

// A voiced index outside the chain is ignored instead of crashing.
assert.deepStrictEqual(reelVoiceWindows([4], [7], 0.8), []);

// speechDuckWindows: music is ducked only while a card actually speaks, so a
// leading beat stays at the normal level ("music starts as before"). Reel
// [4(intro) ...], intro pre=3.0/dur=8, slide1 pre=0.7/dur=3, outro pre=0.7.
const sw = speechDuckWindows([4, 3, 10, 3, 10, 4],
    [{ idx: 0, pre: VOICE_PRE_INTRO, dur: 8 },
        { idx: 1, pre: VOICE_PRE, dur: 3 },
        { idx: 5, pre: VOICE_PRE, dur: 4 }], 0.8);
near(sw.length, 3);
// Intro window starts AFTER its lead-in, never at t=0.
near(sw[0][0], VOICE_PRE_INTRO); near(sw[0][1], VOICE_PRE_INTRO + 8 + REVERB_TAIL);
// Slide 1 segment starts at 3.2 on the timeline; speech starts at 3.9.
near(sw[1][0], 3.2 + VOICE_PRE); near(sw[1][1], 3.2 + VOICE_PRE + 3 + REVERB_TAIL);
// Outro.
near(sw[2][0], 26.0 + VOICE_PRE); near(sw[2][1], 26.0 + VOICE_PRE + 4 + REVERB_TAIL);

// --- 3. musicDuckFilters ---------------------------------------------------

assert.deepStrictEqual(musicDuckFilters([]),
    ["volume=" + DUCK_BASE],
    "no windows -> plain base volume (pre-existing behaviour)");
assert.deepStrictEqual(musicDuckFilters([[3.2, 6.2]]), [
    "volume=" + DUCK_BASE,
    "volume=" + DUCK_LEVEL + ":enable='between(t,3.200,6.200)'"
], "one window adds one ducking volume filter");

const chain = musicDuckFilters([[3.2, 6.2], [26, 30]]);
assert.strictEqual(chain.join(","),
    "volume=" + DUCK_BASE + "," +
    "volume=" + DUCK_LEVEL + ":enable='between(t,3.200,6.200)'," +
    "volume=" + DUCK_LEVEL + ":enable='between(t,26.000,30.000)'");

// Custom levels (assemble-video uses defaults; overridable for tuning).
const custom = musicDuckFilters([[0, 4]], { base: 0.05, duck: 0.5 });
assert.strictEqual(custom[0], "volume=0.05");
assert.strictEqual(custom[1], "volume=0.5:enable='between(t,0.000,4.000)'");

// Degenerate (empty/inverted) windows must not emit a volume filter.
assert.deepStrictEqual(musicDuckFilters([[5, 5]]).length, 1);

// --- 4. voiceSignature -----------------------------------------------------

// A narration cache hit is only trusted when the (text, engine) fingerprint
// matches the sidecar .sig — so editing the script or switching engines must
// produce a different signature (forcing a regenerate) while identical input
// stays stable (allowing cache reuse).
const s1 = voiceSignature("Welcome to yaPDP.", "kokoro");
assert.strictEqual(voiceSignature("Welcome to yaPDP.", "kokoro"), s1,
    "same text+engine must produce a stable signature");
assert.notStrictEqual(voiceSignature("Welcome back to yaPDP.", "kokoro"), s1,
    "a changed script must invalidate the cache");
assert.notStrictEqual(voiceSignature("Welcome to yaPDP.", "auto"), s1,
    "a changed engine must invalidate the cache");
assert.strictEqual(voiceSignature("x", undefined), voiceSignature("x", null),
    "a missing engine must normalise to the same signature as null/auto");
assert.strictEqual(JSON.parse(voiceSignature("x", "auto")).v, 1,
    "the signature must carry a version field for future format bumps");

process.stdout.write("All reel-voice tests passed.\n");
