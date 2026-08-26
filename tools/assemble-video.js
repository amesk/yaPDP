#!/usr/bin/env node
/**
 * yaPDP — Demo-reel assembler.
 *
 * Concatenates the per-OS demo clips from ./video/ into a single promotional
 * reel, and exports every guest-OS clip as a standalone YouTube-ready MP4:
 *   - the reel: intro card + a labelled title card before every guest-OS clip
 *     + an outro card + cross-fades (video: xfade, audio: acrossfade);
 *   - individual clips: the yapdp-intro card cross-faded into the clip;
 *   - optional background music mixed under the clip audio (--music <file>).
 *
 * The puppeteer-stream clips are live WebM streams (no Duration in the header)
 * at whatever size the headless tab capture produced. This assembler first
 * NORMALISES every segment (pad to 1280x800, fps=30, yuv420p, stereo 44.1kHz
 * audio) into a temporary file — ffmpeg writes a proper Duration header there —
 * aligns the video/audio lengths, and then chains xfade/acrossfade with exact
 * offsets. Every published file is an MP4 (H.264 + AAC); the WebM files under
 * ./video/ are the intermediate raw captures.
 *
 * Uses ffmpeg-static, so no system ffmpeg is needed.
 *
 * Usage:
 *   node tools/assemble-video.js
 *   node tools/assemble-video.js --music assets/music/loop.mp3
 *   npm run video:demo
 *
 * Output: video/yaPDP-demo.mp4 and video/<clip>.mp4 for every clip.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const ROOT = path.resolve(__dirname, "..");
// Clips live in ./video/ (gitignored) — never assets/, which is published.
const VIDEOS = path.join(ROOT, "video");
// YouTube-ready MP4 (H.264 + AAC) — the WebM clips under ./video/ are the
// intermediate raw captures; every published file is an MP4.
const OUT = path.join(VIDEOS, "yaPDP-demo.mp4");

const WIDTH = 1280;
const HEIGHT = 800;
const FPS = 30;
const FADE = 0.8; // cross-fade seconds
const SLIDE_MS = 3000; // title card duration

// DEC-style palette (matches the landing page).
const BG = "0x181511";
const FG = "0xc8b890";
const DIM = "0x8a7a50";
const FONT = "C\\\\:/Windows/Fonts/consola.ttf";
// Bold display font for the intro/outro title (a 1970s-style heavy sans).
const FONT_BOLD = "C\\\\:/Windows/Fonts/arialbd.ttf";
// The landing page's photo backdrop, shown at 30% opacity over the dark card
// background ("70% transparent") on every title card.
const BACKDROP = path.join(ROOT, "assets", "images", "pdp11-machine-room.jpg");

// --- The clips, in reel order ---------------------------------------------
const CLIPS = [
    { file: "basic.webm",        title: "DEC BASIC-11" },
    { file: "unix_v5.webm",      title: "BOOTING UNIX V5" },
    { file: "bsd.webm",          title: "2.11 BSD" },
    { file: "rt11.webm",         title: "RT-11 v4.0" },
    { file: "rt11-vt52.webm",    title: "RT-11  ·  VT52 CONSOLE" },
    { file: "xxdp.webm",         title: "XXDP DIAGNOSTICS" },
    { file: "lunar-lander.webm", title: "LUNAR LANDER  ·  VT11" }
];

// --- Utilities ------------------------------------------------------------

function run(args) {
    const res = spawnSync(ffmpegPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) {
        console.error("ffmpeg failed:\n" + (res.stderr || ""));
        throw new Error("ffmpeg exited with " + res.status);
    }
    return res;
}

function probeDuration(file) {
    const res = spawnSync(ffmpegPath, ["-i", file], { encoding: "utf8" });
    const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(res.stderr || "");
    if (!m) throw new Error("Cannot read duration of " + file);
    return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

function escFilter(s) {
    return String(s).replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/,/g, "\\,");
}

// Render a title card (video + silent stereo audio) as a short WebM clip: a
// dark DEC-colored card with the landing-page machine-room photo overlaid at
// 30% opacity ("70% transparent"), text on top, faded in/out. `opts` may carry
// { size, font, footer } for a larger/bolder title and a bottom line.
function genSlide(file, text, subtitle, duration, opts) {
    opts = opts || {};
    const font = opts.font || FONT;
    const size = opts.size || 72;
    const draw = [
        `drawtext=fontfile=${font}:text='${escFilter(text)}':fontsize=${size}:fontcolor=${FG}:` +
            `borderw=3:bordercolor=black:x=(w-text_w)/2:y=(h-text_h)/2-50`,
        `drawtext=fontfile=${font}:text='${escFilter(subtitle || "")}':fontsize=30:fontcolor=${DIM}:` +
            `x=(w-text_w)/2:y=(h)/2+40`
    ];
    if (opts.footer) {
        draw.push(`drawtext=fontfile=${FONT}:text='${escFilter(opts.footer)}':fontsize=26:fontcolor=${DIM}:` +
            `x=(w-text_w)/2:y=h-70`);
    }
    const fc =
        `[1:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
            `crop=${WIDTH}:${HEIGHT},format=rgba,colorchannelmixer=aa=0.3[ph];` +
        `[0:v][ph]overlay=0:0,` +
        draw.join(",") + `,` +
        `fade=t=in:st=0:d=0.6,` +
        `fade=t=out:st=${(duration - 0.6).toFixed(2)}:d=0.6[vout]`;
    run([
        "-y",
        "-f", "lavfi", "-i", `color=c=${BG}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${duration}`,
        "-loop", "1", "-i", BACKDROP, "-t", String(duration),
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-filter_complex", fc,
        "-map", "[vout]", "-map", "2:a",
        "-t", String(duration),
        "-af", "afade=t=in:st=0:d=0.3,afade=t=out:st=" + (duration - 0.3).toFixed(2) + ":d=0.3",
        "-c:v", "libvpx", "-b:v", "4M", "-c:a", "libopus",
        file
    ]);
}

// End-of-video URL card: pure black with the project URL centred, faded in and
// out. Used as the final outro of every clip (and the reel) so viewers know
// where to find the project.
const PROJECT_URL = "https://amesk.github.io/yaPDP/";
const OUTRO_SECONDS = 4;

// CRT scanlines: a translucent black bar every 4 rows, drawn OVER the text —
// the same phosphor-screen look the canvas intro card uses.
function scanlineVf() {
    const bars = [];
    for (let y = 0; y < HEIGHT; y += 4) {
        bars.push(`drawbox=x=0:y=${y}:w=iw:h=1:color=black@0.18:t=fill`);
    }
    return bars.join(",");
}

function genUrlCard(file, duration) {
    run([
        "-y",
        "-f", "lavfi", "-i",
        `color=c=black:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${duration}`,
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-vf",
        `drawtext=fontfile=${FONT}:text='${escFilter(PROJECT_URL)}':fontsize=34:fontcolor=${FG}:` +
            `x=(w-text_w)/2:y=(h-text_h)/2,` +
            scanlineVf() + `,` +
            `fade=t=in:st=0:d=0.6,fade=t=out:st=${(duration - 0.6).toFixed(2)}:d=0.6`,
        "-map", "0:v", "-map", "1:a",
        "-t", String(duration),
        "-af", "afade=t=in:st=0:d=0.3,afade=t=out:st=" + (duration - 0.3).toFixed(2) + ":d=0.3",
        "-c:v", "libvpx", "-b:v", "4M", "-c:a", "libopus",
        file
    ]);
}

// Normalise any video input to the reel's canvas: pad to WIDTHxHEIGHT (keep
// aspect ratio), constant fps, yuv420p, stereo 44.1kHz audio with PTS starting
// at zero. Writing a seekable WebM makes ffmpeg stamp a Duration header we can
// probe later. The output is CFR 30 fps and its audio starts at t=0 so the
// later xfade/acrossfade chains share identical timebases.
function normalise(input, out) {
    run([
        "-y",
        "-i", input,
        "-vf",
        `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
            `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,` +
            `fps=${FPS},format=yuv420p,setsar=1`,
        "-af",
        `aresample=44100:async=1:first_pts=0,` +
            `aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS`,
        "-c:v", "libvpx", "-b:v", "8M", "-c:a", "libopus",
        "-r", String(FPS), "-video_track_timescale", "30000",
        out
    ]);
}

// Probe the actual encoded duration of a single stream (video or audio) by
// decoding to null and reading the final `time=` from the progress output.
// The container duration can be the LONGER of the two streams, which would
// break the xfade offset math — so we always align on the stream that ends
// first.
function probeStream(file, mapSpec) {
    const res = spawnSync(
        ffmpegPath, ["-i", file, "-map", mapSpec, "-f", "null", "-"],
        { encoding: "utf8" });
    const matches = [...(res.stderr || "").matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)];
    if (!matches.length) return null;
    const last = matches[matches.length - 1];
    return parseInt(last[1], 10) * 3600 +
        parseInt(last[2], 10) * 60 + parseFloat(last[3]);
}

// Re-mux the normalised segment so the video and audio streams end at exactly
// the same timestamp (the shorter of the two). Without this the video xfade
// offsets (built from the container duration) drift apart from the audio
// acrossfade chain and the sound gradually falls out of sync in the reel.
function alignStreams(input, out) {
    const vd = probeStream(input, "0:v");
    const ad = probeStream(input, "0:a");
    if (vd == null || ad == null) { fs.copyFileSync(input, out); return; }
    const min = Math.min(vd, ad);
    if (Math.abs(vd - ad) < 0.05) { fs.copyFileSync(input, out); return; }
    run([
        "-y", "-i", input,
        "-t", min.toFixed(3),
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        "-video_track_timescale", "30000",
        out
    ]);
}

// Export one guest-OS clip as a standalone YouTube-ready MP4: the yapdp-intro
// title card first (cross-faded in), then the raw clip, then the quiet
// background music mixed under the clip audio. The WebM raw captures are never
// published — every uploadable file is an MP4.
function exportIndividual(clip, music, tmp, srcPath) {
    const introPath = path.join(VIDEOS, "yapdp-intro.webm");
    const clipPath = srcPath || path.join(VIDEOS, clip.file);
    if (!fs.existsSync(introPath) || !fs.existsSync(clipPath)) return;
    const base = path.basename(clip.file, ".webm");

    const nIntro = path.join(tmp, "ind_" + base + "_intro.webm");
    const nClip = path.join(tmp, "ind_" + base + "_clip.webm");
    const aIntro = path.join(tmp, "ind_" + base + "_intro_a.webm");
    const aClip = path.join(tmp, "ind_" + base + "_clip_a.webm");
    const nOutro = path.join(tmp, "ind_" + base + "_outro.webm");
    const aOutro = path.join(tmp, "ind_" + base + "_outro_a.webm");
    const outroRaw = path.join(tmp, "ind_" + base + "_outro_raw.webm");
    normalise(introPath, nIntro);
    normalise(clipPath, nClip);
    alignStreams(nIntro, aIntro);
    alignStreams(nClip, aClip);
    // Final URL card (black + project URL) fades in after the clip, so the
    // clip fades out and every upload ends on the project URL.
    genUrlCard(outroRaw, OUTRO_SECONDS);
    normalise(outroRaw, nOutro);
    alignStreams(nOutro, aOutro);

    // Cross-fade intro -> clip -> outro (video xfade + audio acrossfade).
    const dIntro = probeDuration(aIntro);
    const dClip = probeDuration(aClip);
    const fade = 0.6;
    const concatOut = path.join(tmp, "ind_" + base + "_plain.mp4");
    run([
        "-y",
        "-i", aIntro,
        "-i", aClip,
        "-i", aOutro,
        "-filter_complex",
        `[0:v]settb=AVTB[v0];[1:v]settb=AVTB[v1];[2:v]settb=AVTB[v2];` +
            `[v0][v1]xfade=transition=fade:duration=${fade}:offset=${(dIntro - fade).toFixed(3)}[x1];` +
            `[x1][v2]xfade=transition=fade:duration=${fade}:offset=${(dIntro + dClip - fade * 2).toFixed(3)}[vout];` +
            `[0:a]anull[a0];[1:a]anull[a1];[2:a]anull[a2];` +
            `[a0][a1]acrossfade=d=${fade}[x1a];` +
            `[x1a][a2]acrossfade=d=${fade}[aout]`,
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        concatOut
    ]);

    const out = path.join(VIDEOS, base + ".mp4");
    if (music) {
        const mixed = path.join(tmp, "ind_" + base + "_mixed.mp4");
        const dur = probeDuration(concatOut);
        run([
            "-y",
            // Loop the music indefinitely so it plays for the whole clip even
            // when the track is shorter than the video; the -t trims it to the
            // video length (otherwise the endless input would never finish).
            "-stream_loop", "-1",
            "-i", music,
            "-i", concatOut,
            "-filter_complex",
            `[0:a]volume=0.08[m];[1:a][m]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
            "-map", "1:v", "-map", "[aout]",
            "-t", dur.toFixed(3),
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            mixed
        ]);
        // Temp may live on a different drive — copy, don't rename (EXDEV).
        fs.copyFileSync(mixed, out);
        fs.unlinkSync(mixed);
    } else {
        fs.copyFileSync(concatOut, out);
    }
    const kb = Math.round(fs.statSync(out).size / 1024);
    console.log("  exported " + path.relative(ROOT, out) + " (" + kb + " kB)");
}

// --- Lunar Lander cut ------------------------------------------------------
// The raw Lunar Lander clip is one long run: start-up text (0..~37 s), then a
// long terrain draw, then the descent. For the demo we keep a short title
// (0..TEXT_END) and the descent (MODULE_APPEAR..LANDING), dropping the long
// wait in between with a fade-out to black / fade-in from black. The timings
// came from tools/_debug-lander.js (pixel fill curve).
const LANDER = { textEnd: 10, moduleAppear: 45, landing: 95, fade: 0.6 };

function cutLander(input, out) {
    const t = LANDER;
    const fo = (t.textEnd - t.fade).toFixed(3);
    run([
        "-y", "-i", input,
        "-filter_complex",
        `[0:v]trim=start=0:end=${t.textEnd},setpts=PTS-STARTPTS,` +
            `fade=t=out:st=${fo}:d=${t.fade}[va];` +
            `[0:v]trim=start=${t.moduleAppear}:end=${t.landing},setpts=PTS-STARTPTS,` +
            `fade=t=in:st=0:d=${t.fade}[vb];` +
            `[0:a]atrim=start=0:end=${t.textEnd},asetpts=PTS-STARTPTS,` +
            `afade=t=out:st=${fo}:d=${t.fade}[aa];` +
            `[0:a]atrim=start=${t.moduleAppear}:end=${t.landing},asetpts=PTS-STARTPTS,` +
            `afade=t=in:st=0:d=${t.fade}[ab];` +
            `[va][aa][vb][ab]concat=n=2:v=1:a=1[vout][aout]`,
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libvpx", "-b:v", "8M", "-c:a", "libopus",
        out
    ]);
}

// Resolve the effective source file for a clip: Lunar Lander gets its long
// wait trimmed out (cutLander) first; every other clip is used as recorded.
function prepareSource(clip, tmp) {
    if (clip.file === "lunar-lander.webm") {
        const out = path.join(tmp, "lander-cut.webm");
        console.log("Cutting Lunar Lander (10..45 s trimmed)...");
        cutLander(path.join(VIDEOS, clip.file), out);
        return out;
    }
    return path.join(VIDEOS, clip.file);
}

// --- Main -----------------------------------------------------------------

(async function main() {
    let tmp = null;
    try {
        const mi = process.argv.indexOf("--music");
        // Default background track (if present); --music overrides it.
        const DEFAULT_MUSIC = path.join(ROOT, "assets", "sounds",
            "Mirror Mind - Bobby Richards.mp3");
        let music = mi !== -1 ? process.argv[mi + 1] : DEFAULT_MUSIC;
        if (music && !fs.existsSync(music)) music = null;

        // Optional selector: a clip file name (without extension). When given,
        // only that individual clip is exported — no full reel is assembled.
        const selector = (process.argv.slice(2).find((a) => !a.startsWith("--")) || "")
            .toLowerCase().replace(/\.(webm|mp4)$/, "");

        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-reel-"));
        const outro = path.join(tmp, "outro.webm");
        const slides = CLIPS.map((c) =>
            path.join(tmp, "slide_" + path.basename(c.file, ".webm") + ".webm"));

        // Intro: the canvas-rendered title card from tools/make-intro.js (amber
        // glow, green phosphor typing, fade in/out); fall back to a drawtext
        // card if the intro has not been generated yet.
        const introPath = path.join(VIDEOS, "yapdp-intro.webm");
        let intro = introPath;
        if (!fs.existsSync(introPath)) {
            intro = path.join(tmp, "intro.webm");
            genSlide(intro, "yaPDP", "PDP-11/70 web emulator", 4, {
                size: 150, font: FONT_BOLD,
                footer: "-- created with love for the DEC era"
            });
        }

        console.log("Rendering title cards...");
        CLIPS.forEach((c, i) => genSlide(slides[i], c.title, "", SLIDE_MS / 1000));
        // The reel ends on the black project-URL card (fade out at the very end).
        genUrlCard(outro, OUTRO_SECONDS);

        // Resolve effective sources: Lunar Lander is cut down (the long wait
        // is trimmed out with a fade) before it enters the reel.
        const srcFor = {};
        CLIPS.forEach((c) => { srcFor[c.file] = prepareSource(c, tmp); });

        // Single-clip export mode (e.g. `node tools/assemble-video.js lander`):
        // build just that clip's MP4 (intro + clip + music) and skip the reel.
        if (selector) {
            // `lander` is the wizard device key; the clip file is lunar-lander.
            const aliases = { lander: "lunar-lander" };
            const sel = aliases[selector] || selector;
            const clip = CLIPS.find((c) =>
                c.file === sel + ".webm" ||
                path.basename(c.file, ".webm") === sel);
            if (!clip) throw new Error("Unknown clip selector: " + selector);
            console.log("Exporting individual clip: " + clip.file);
            exportIndividual(clip, music, tmp, srcFor[clip.file]);
            console.log("Done.");
            return;
        }

        // Build the ordered list of raw segments: intro, slide, clip, slide, ...
        const raw = [intro];
        CLIPS.forEach((c, i) => { raw.push(slides[i], srcFor[c.file]); });
        raw.push(outro);

        console.log("Normalising segments...");
        const inputs = raw.map((f, i) => {
            const n = path.join(tmp, "seg_" + i + ".webm");
            const a = path.join(tmp, "seg_" + i + "_aligned.webm");
            normalise(f, n);
            // Trim the longer stream so video and audio end at the same time
            // (keeps the xfade offsets and the acrossfade chain in sync).
            alignStreams(n, a);
            return a;
        });

        console.log("Probing durations...");
        const durs = inputs.map((f) => probeDuration(f));

        // --- Video chain: xfade -------------------------------------------------
        const filters = [];
        inputs.forEach((_, i) => {
            filters.push(
                `[${i}:v]settb=AVTB[v${i}]`);
        });
        let prev = "v0";
        let cum = durs[0];
        for (let k = 1; k < inputs.length; k++) {
            const offset = (cum - FADE).toFixed(3);
            const outL = (k === inputs.length - 1) ? "vout" : ("x" + k);
            filters.push(`[${prev}][v${k}]xfade=transition=fade:duration=${FADE}:offset=${offset}[${outL}]`);
            cum = cum + durs[k] - FADE;
            prev = outL;
        }

        // --- Audio chain: acrossfade --------------------------------------------
        const aFilters = [];
        inputs.forEach((_, i) => {
            aFilters.push(`[${i}:a]anull[a${i}]`);
        });
        let aPrev = "a0";
        for (let k = 1; k < inputs.length; k++) {
            const aOut = (k === inputs.length - 1) ? "aout" : ("ax" + k);
            aFilters.push(`[${aPrev}][a${k}]acrossfade=d=${FADE}[${aOut}]`);
            aPrev = aOut;
        }

        const filterComplex = filters.concat(aFilters).join(";");

        console.log("Assembling the reel (this may take a while)...");
        const args = ["-y"];
        inputs.forEach((f) => { args.push("-i", f); });
        args.push(
            "-filter_complex", filterComplex,
            "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            OUT
        );
        run(args);

        // --- Optional background music ------------------------------------------
        if (music) {
            console.log("Mixing background music (looped): " + music);
            const mixed = path.join(tmp, "mixed.mp4");
            const dur = probeDuration(OUT);
            run([
                "-y",
                // Loop the music indefinitely so it plays for the whole reel
                // even when the track is shorter than the video; -t trims it
                // to the video length (endless input never finishes on its own).
                "-stream_loop", "-1",
                "-i", music,
                "-i", OUT,
                "-filter_complex",
                `[0:a]volume=0.08[m];[1:a][m]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
                "-map", "1:v", "-map", "[aout]",
                "-t", dur.toFixed(3),
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart",
                mixed
            ]);
            // Temp dir may live on a different drive than the project, so copy
            // instead of rename (rename across devices fails with EXDEV).
            fs.copyFileSync(mixed, OUT);
            fs.unlinkSync(mixed);
        }

        // --- Individual YouTube-ready clips ------------------------------------
        console.log("Exporting individual clips...");
        CLIPS.forEach((c) => exportIndividual(c, music, tmp, srcFor[c.file]));

        const kb = Math.round(fs.statSync(OUT).size / 1024);
        console.log("Done. Reel written to " + path.relative(ROOT, OUT) + " (" + kb + " kB).");
    } finally {
        if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    }
})().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
