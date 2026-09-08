"use strict";
/**
 * yaPDP — Pure helpers shared by the demo-reel assembler and its tests.
 *
 * tools/assemble-video.js speaks a TTS narration (tools/voicer.js) over its
 * title cards. All the timing maths that does not touch ffmpeg/disk lives
 * here so it can be unit-tested without a browser or even an ffmpeg binary:
 *   1. target lengths: how long a card must be so the speech (plus a little
 *      reverb tail) fits entirely;
 *   2. ducking windows: the [start,end] time spans, on the FINAL timeline,
 *      where the background music must be turned down because narration is
 *      audible there;
 *   3. the music ducking filter chain built from those windows.
 *
 * The reel and the per-clip exports both glue their segments with the same
 * xfade/acrossfade chain, so one window function covers both cases — the
 * caller just passes the actual segment durations and the cross-fade length
 * it used (FADE=0.8 for the reel, fade=0.6 inside exportIndividual).
 */

// --- Voice placement inside a voiced card --------------------------------

// Silent lead-in before the narration starts (so the card fade-in and the
// slide's own fade never cut the first syllable).
const VOICE_PRE = 0.7;
// Longer lead-in used specifically for the INTRO card: it gives the viewer a
// beat to take in the fully-faded-in title before the voice begins, instead
// of starting to talk while the card is still fading in.
const VOICE_PRE_INTRO = 3.0;
// Silence kept AFTER the narration; sized so the audio fade-out and the
// reverb tail both land inside the card instead of spilling into the clip.
const VOICE_POST = 0.8;
// Extra span reserved for the narration reverb tail when ducking (the tail
// is softer than VOICE_POST, but a bit of margin keeps the music down while
// the echo still decays).
const REVERB_TAIL = 0.6;
// How long BEFORE its end a generated card starts fading out (our cards:
// genSlide/genUrlCard fade over the last ~0.6 s, the make-intro canvas card
// over the last 1 s). mixSpeech freezes the last fully visible frame at
// (duration - VOICE_HOLD_EDGE) when it has to stretch a card, so the held
// picture is bright instead of the post-fade black frame.
const VOICE_HOLD_EDGE = 1.2;

// Light "room" preset for the (mono, dry) TTS voice. Deliberately TINY:
// sub-echo-length taps (20/30 ms — early reflections, not audible echoes)
// with very low decays, so the voice gains a little width/warmth without
// hurting intelligibility (longer/louder taps made it hard to follow).
// Kept as a plain aecho filter string; assembled only when reverb is on.
// The "|"-separated per-channel values are single-quoted so ffmpeg's
// filtergraph parser does not treat "|" as a chain separator.
const REVERB_AECHO = "aecho=0.8:0.9:'20|30':'0.08|0.06'";

// --- Background music levels (ducking) -----------------------------------

// Normal background music gain (linear), applied to the whole reel.
const DUCK_BASE = 0.08;
// Multiplier applied to the music while a voiced card is on screen, so the
// music drops to ~DUCK_BASE*DUCK_LEVEL during narration.
const DUCK_LEVEL = 0.3;

// --- Pure helpers --------------------------------------------------------

// How long a voiced card must last for `speechDur` seconds of narration to
// fit with the pre-roll, the post-roll and the reverb tail still inside.
// `pre` overrides the lead-in (the intro card uses a longer one, see
// VOICE_PRE_INTRO).
function speechTargetDuration(baseDur, speechDur, pre) {
    const lead = (pre != null ? pre : VOICE_PRE);
    return Math.max(baseDur, lead + speechDur + VOICE_POST);
}

// The narration's audible span inside its own card (start offset .. end of
// the reverb tail). Useful as a self-check / for tests.
function voicedSpan(speechDur) {
    return VOICE_PRE + speechDur + Math.max(VOICE_POST, REVERB_TAIL);
}

// Compute the [start,end] ducking windows on the final timeline for a chain
// glued with xfade/acrossfade of `fade` seconds.
//   durs      — actual durations of every glued segment, in chain order;
//   voicedIdxs— indexes into durs whose segment carries narration;
//   fade      — the cross-fade duration used by that chain.
// Segment k becomes audible at `(sum durs[0..k-1]) - k*fade`, exactly the
// offset arithmetic assemble-video.js uses for its xfade/acrossfade chain.
function reelVoiceWindows(durs, voicedIdxs, fade) {
    const out = [];
    if (!Array.isArray(durs) || !durs.length) return out;
    const startOf = [0];
    let cum = durs[0];
    for (let k = 1; k < durs.length; k++) {
        startOf.push(cum - fade);
        cum = cum + durs[k] - fade;
    }
    for (const k of voicedIdxs) {
        if (k < 0 || k >= durs.length) continue;
        const s = startOf[k];
        out.push([s, s + durs[k]]);
    }
    return out;
}

// Same start arithmetic, exposed for speechDuckWindows below / tests.
function segmentStarts(durs, fade) {
    const startOf = [0];
    let cum = durs[0];
    for (let k = 1; k < durs.length; k++) {
        startOf.push(cum - fade);
        cum = cum + durs[k] - fade;
    }
    return startOf;
}

// Compute ducking windows that cover ONLY the actual narration of each voiced
// card — from where the voice starts (its pre-roll) to where it ends plus the
// reverb tail — instead of the whole card. This keeps the music at its normal
// level before the voice starts (e.g. the intro's 3 s beat) and after it ends.
//   durs — durations of every glued segment (chain order);
//   spec — array of { idx, pre, dur } for each voiced card (idx into durs);
//   fade — the chain's cross-fade length.
function speechDuckWindows(durs, spec, fade, opts) {
    opts = opts || {};
    const tail = opts.tail != null ? opts.tail : REVERB_TAIL;
    if (!Array.isArray(durs) || !durs.length) return [];
    const startOf = segmentStarts(durs, fade);
    const out = [];
    for (const s of spec || []) {
        if (s.idx < 0 || s.idx >= durs.length) continue;
        const pre = (s.pre != null ? s.pre : VOICE_PRE);
        const st = startOf[s.idx] + pre;
        const en = st + s.dur + tail;
        if (en > st) out.push([st, en]);
    }
    return out;
}

// Build the ffmpeg filter list that ducks the (already looped) music stream:
// a base `volume=` plus one `volume=duck:enable='between(t,S,E)'` per window.
// Join the returned list with "," to form `[0:a]<chain>[m]`. With no windows
// it degenerates to a plain `volume=<base>`, i.e. the pre-existing behaviour.
function musicDuckFilters(windows, opts) {
    opts = opts || {};
    const base = opts.base != null ? opts.base : DUCK_BASE;
    const duck = opts.duck != null ? opts.duck : DUCK_LEVEL;
    const f = ["volume=" + base];
    for (const win of windows || []) {
        const s = win[0];
        const e = win[1];
        if (!(e > s)) continue;
        f.push("volume=" + duck + ":enable='between(t," +
            s.toFixed(3) + "," + e.toFixed(3) + ")'");
    }
    return f;
}

// Stable fingerprint of what a card's narration was rendered from: the script
// text plus the voicer engine. assemble-video.js only trusts a cached WAV when
// this signature matches the sidecar <name>.sig it wrote next to it, so
// editing the narration script or switching engines regenerates the voice
// automatically instead of silently reusing a stale WAV.
function voiceSignature(text, engine) {
    return JSON.stringify({
        v: 1,
        engine: engine || "auto",
        text: String(text)
    });
}

module.exports = {
    VOICE_PRE,
    VOICE_PRE_INTRO,
    VOICE_POST,
    REVERB_TAIL,
    VOICE_HOLD_EDGE,
    REVERB_AECHO,
    DUCK_BASE,
    DUCK_LEVEL,
    speechTargetDuration,
    voicedSpan,
    reelVoiceWindows,
    speechDuckWindows,
    segmentStarts,
    musicDuckFilters,
    voiceSignature
};
