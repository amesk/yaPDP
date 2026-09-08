"use strict";
/**
 * yaPDP — Pure helpers for timed "reel events".
 *
 * While a guest-OS demo clip is being recorded (tools/record-video.js) the
 * scenario code can stamp timed events on the media timeline — a chapter
 * marker for the YouTube description, a big banner "title", a spoken phrase
 * (which also produces a bottom subtitle), or an explicit subtitle line. The
 * events are accumulated and written next to the raw clip as
 * video/<base>.events.json, then consumed by tools/assemble-video.js, which
 * maps each event's clip-relative time onto the FINAL reel/clip timeline,
 * synthesises the spoken phrases through tools/voicer.js, mixes them into the
 * audio at the right moment, burns the banner/subtitle overlays and writes the
 * chapter + subtitle sidecar files.
 *
 * All the pure maths lives here so it can be unit-tested without a browser,
 * ffmpeg or disk: event validation, the clip-time -> absolute-time mapping,
 * reading-speed subtitle-duration heuristics, MM:SS chapter and SRT formatting,
 * and the content-addressed phrase cache key.
 *
 * Clip-relative times map 1:1 to the clip timeline for now (no trimming);
 * remapping through cut clips (e.g. the Lunar Lander 10-45 s trim) is a later
 * phase. Events must therefore be placed on spans that survive into the reel.
 */

const crypto = require("crypto");

// Event types understood by the record/assemble pipeline.
const EVENT_TYPES = ["chapter", "title", "speak", "subtitle"];
// Title overlay modes. "banner" burns a top heading over the running clip;
// "card" (a separate full-frame card segment) is reserved for a later phase.
const TITLE_MODES = ["banner"];

// --- Event validation ------------------------------------------------------

// Normalise a raw event list: every entry must carry a known type, a finite
// non-negative t (media seconds from the clip start) and non-empty text.
// Title/subtitle/speak may carry an explicit dur; title may carry a mode
// (defaults to "banner"). Returns a fresh, plain list. Pure and testable.
function validateEvents(raw) {
    if (!Array.isArray(raw)) {
        throw new Error("reel events must be an array");
    }
    const out = [];
    for (const e of raw) {
        if (!e || typeof e !== "object") {
            throw new Error("each reel event must be an object");
        }
        if (!EVENT_TYPES.includes(e.type)) {
            throw new Error("unknown reel event type '" + e.type +
                "' (expected one of: " + EVENT_TYPES.join(", ") + ")");
        }
        const t = Number(e.t);
        if (!Number.isFinite(t) || t < 0) {
            throw new Error("reel event '" + e.type + "' needs a non-negative t");
        }
        const text = String(e.text == null ? "" : e.text).trim();
        if (!text) {
            throw new Error("reel event '" + e.type + "' needs non-empty text");
        }
        const item = { type: e.type, t: t, text: text };
        if (e.type === "title") {
            item.mode = TITLE_MODES.includes(e.mode) ? e.mode : "banner";
        }
        if (e.dur != null) {
            const dur = Number(e.dur);
            if (!Number.isFinite(dur) || dur < 0) {
                throw new Error("reel event '" + e.type + "' has a bad dur");
            }
            item.dur = dur;
        }
        out.push(item);
    }
    return out;
}

// Parse a full sidecar object ({ clip, events }) into { clip, events } with a
// validated event list. Pure and testable.
function parseSidecar(json) {
    const clip = String(json && json.clip != null ? json.clip : "").trim();
    return {
        clip: clip,
        events: validateEvents(json && json.events)
    };
}

// --- Timeline mapping ------------------------------------------------------

// Map clip-relative events onto the final timeline. `clipStart` is the
// absolute second at which the clip's own t=0 lands on the assembled output
// (segmentStarts()-style arithmetic in assemble-video.js). Each returned item
// carries `abs = clipStart + t`. Pure and testable.
function resolveEvents(events, clipStart) {
    const base = Number(clipStart) || 0;
    return events.map((e) => Object.assign({}, e, { abs: base + e.t }));
}

// Turn a validated event list (already voiced — speak events carry their
// measured .dur) into the sidecar/burn inputs for one output, with every
// clip-relative t mapped onto the absolute timeline that starts `clipStart`
// seconds before the clip's own t=0:
//   chapters — [{ start, text }] from chapter events (YouTube markers);
//   srt      — [{ start, end, text }] from spoken phrases (measured dur + a
//              small tail) and explicit subtitle lines (their dur or an
//              estimate) — these are the bottom subtitles;
//   banners  — [{ start, end, text }] from title events (dur or an estimate) —
//              the big headings burned over the running clip.
// Pure and testable. Banners are NOT added to the subtitles (titles and bottom
// subtitles are different layers).
function planArtifacts(events, clipStart) {
    const chapters = [];
    const srt = [];
    const banners = [];
    const resolved = resolveEvents(events, clipStart);
    for (const e of resolved) {
        if (e.type === "chapter") {
            chapters.push({ start: e.abs, text: e.text });
        } else if (e.type === "title") {
            const dur = e.dur != null ? e.dur : estimateDur(e.text);
            if (dur > 0) banners.push({ start: e.abs, end: e.abs + dur, text: e.text });
        } else if (e.type === "speak") {
            // A phrase with no synthesised WAV has no duration — skip it.
            if (!e.dur || e.dur <= 0) continue;
            srt.push({ start: e.abs, end: e.abs + e.dur + 0.25, text: e.text });
        } else if (e.type === "subtitle") {
            const dur = e.dur != null ? e.dur : estimateDur(e.text);
            if (dur > 0) srt.push({ start: e.abs, end: e.abs + dur, text: e.text });
        }
    }
    return { chapters: chapters, srt: srt, banners: banners };
}

// --- Duration heuristics ---------------------------------------------------

// Reading-speed fallback for a subtitle/banner when the event has no explicit
// dur: roughly READING_RATE chars per second, floored to a MIN so a short
// phrase is still readable, capped at MAX so a long text never dominates.
const SUB_MIN = 1.5;
const SUB_MAX = 12;
const SUB_RATE = 15; // chars/second, slow enough for a voice-over caption

function estimateDur(text, opts) {
    opts = opts || {};
    const min = opts.min != null ? opts.min : SUB_MIN;
    const max = opts.max != null ? opts.max : SUB_MAX;
    const rate = opts.rate != null ? opts.rate : SUB_RATE;
    const dur = String(text == null ? "" : text).length / rate;
    return Math.max(min, Math.min(max, dur));
}

// --- Formatters ------------------------------------------------------------

// "0:00" / "12:34" / "1:02:03" — YouTube chapter timestamps.
function fmtMmss(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) {
        return h + ":" + String(m).padStart(2, "0") + ":" +
            String(r).padStart(2, "0");
    }
    return m + ":" + String(r).padStart(2, "0");
}

// "00:00:01,000" — SRT timestamp (fractions of a second kept).
function fmtSrtTs(sec) {
    const ms = Math.max(0, Number(sec) || 0);
    const h = Math.floor(ms / 3600);
    const m = Math.floor((ms % 3600) / 60);
    const s = Math.floor(ms % 60);
    const f = Math.floor((ms - Math.floor(ms)) * 1000);
    return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":") +
        "," + String(f).padStart(3, "0");
}

// Render a YouTube chapter block: one "MM:SS Title" line per mark, ordered by
// start. `marks` = [{ start, text }]. Pure and testable.
function formatChapters(marks) {
    const sorted = (marks || []).slice()
        .filter((m) => m && m.text)
        .sort((a, b) => (a.start || 0) - (b.start || 0));
    const seen = [];
    const out = [];
    for (const m of sorted) {
        const line = fmtMmss(m.start) + " " + String(m.text).trim();
        if (!seen.includes(line)) {
            seen.push(line);
            out.push(line);
        }
    }
    return out.join("\n");
}

// Render an SRT document. `blocks` = [{ start, end, text }] with start/end in
// seconds; blocks with end <= start are dropped. Returns the full SRT text
// (index + "HH:MM:SS,mmm --> HH:MM:SS,mmm" + text + blank line). Pure.
function formatSrt(blocks) {
    const sorted = (blocks || []).slice()
        .filter((b) => b && b.text && Number(b.end) > Number(b.start))
        .sort((a, b) => (a.start || 0) - (b.start || 0));
    const chunks = [];
    for (let i = 0; i < sorted.length; i++) {
        const b = sorted[i];
        chunks.push(
            String(i + 1) + "\n" +
            fmtSrtTs(b.start) + " --> " + fmtSrtTs(b.end) + "\n" +
            String(b.text).trim() + "\n"
        );
    }
    return chunks.join("\n");
}

// --- Phrase cache key ------------------------------------------------------

// Content-addressed cache key for a spoken phrase WAV: a short hex digest of
// (text, engine). assemble-video.js stores the synthesised phrase under
// video/voice/phr-<key>.wav next to a <name>.sig of the same fingerprint, so
// editing a phrase or switching --voice-engine regenerates it automatically.
function phraseCacheKey(text, engine) {
    const digest = crypto.createHash("sha1");
    digest.update(String(text));
    digest.update("\u0000" + String(engine == null ? "auto" : engine));
    return digest.digest("hex").slice(0, 16);
}

module.exports = {
    EVENT_TYPES,
    TITLE_MODES,
    SUB_MIN,
    SUB_MAX,
    SUB_RATE,
    validateEvents,
    parseSidecar,
    resolveEvents,
    planArtifacts,
    estimateDur,
    fmtMmss,
    fmtSrtTs,
    formatChapters,
    formatSrt,
    phraseCacheKey
};
