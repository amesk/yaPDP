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
 *   node tools/assemble-video.js --voice-engine kokoro --voice-regen
 *   npm run video:demo
 *
 * --voice-engine selects the narration engine for tools/voicer.js: auto
 * (default; Kokoro-82M, falling back to Windows SAPI) | kokoro | sapi.
 * --voice-regen regenerates every cached narration WAV.
 *
 * Timed reel events recorded by tools/record-video.js into video/<base>.events.json
 * (chapters, spoken phrases, banner titles, bottom subtitles) are voiced into
 * the clip audio at their media offsets and emitted as video/*.chapters.txt +
 * video/*.srt sidecars next to each MP4; banner titles are burned into the
 * video, and --burn-subtitles also burns the bottom subtitle lines.
 *
 * Output: video/yaPDP-demo.mp4 and video/<clip>.mp4 for every clip.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const ffmpegStatic = require("ffmpeg-static");

// ffmpeg-static is convenient but some of its builds ship WITHOUT the drawtext
// filter (no libfreetype), and the promo reel burns all its title/banner text
// with drawtext. When the chosen ffmpeg lacks drawtext we fall back to a
// system ffmpeg (which normally has it built in) or an explicit FFMPEG_PATH.
function resolveFfmpegPath() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    const hasDrawtext = (p) => {
        try {
            const r = spawnSync(p, ["-hide_banner", "-filters"], { encoding: "utf8" });
            return /^.* drawtext /m.test((r.stdout || "") + (r.stderr || ""));
        } catch (e) {
            return false;
        }
    };
    if (ffmpegStatic && hasDrawtext(ffmpegStatic)) return ffmpegStatic;
    const systemCandidates = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"];
    for (const cand of systemCandidates) {
        if (hasDrawtext(cand)) return cand;
    }
    return ffmpegStatic; // best-effort last resort; drawtext will fail loudly
}
const ffmpegPath = resolveFfmpegPath();
const vutil = require("./reel-voice-util.js");
const timeline = require("./reel-timeline-util.js");
const fonts = require("./reel-font-util.js");

const ROOT = path.resolve(__dirname, "..");
// Clips live in ./video/ (gitignored) — never assets/, which is published.
const VIDEOS = path.join(ROOT, "video");
// YouTube-ready MP4 (H.264 + AAC) — the WebM clips under ./video/ are the
// intermediate raw captures; every published file is an MP4.
const OUT = path.join(VIDEOS, "yaPDP-demo.mp4");
// Narration WAV cache (also under the gitignored video/ tree).
const VOICE_DIR = path.join(VIDEOS, "voice");

const WIDTH = 1280;
const HEIGHT = 800;
const FPS = 30;
const FADE = 0.8; // cross-fade seconds
const SLIDE_MS = 3000; // title card duration (reel)
// The standalone clips hold their "what this demo shows" title card about 3x
// longer than the reel's quick cards, so the description is readable.
const CLIP_SLIDE_MS = SLIDE_MS * 3;

// DEC-style palette (matches the landing page).
const BG = "0x181511";
const FG = "0xc8b890";
const DIM = "0x8a7a50";
// drawtext fonts: Consolas (mono body) + Arial Bold (display) on Windows, with
// a fallback to the repo-committed Courier Prime / Michroma faces on Linux/mac
// so the reel also assembles on a bare CI runner (see tools/reel-font-util.js).
const { FONT, FONT_BOLD } = fonts.resolveFontPaths();
// The landing page's photo backdrop, shown at 30% opacity over the dark card
// background ("70% transparent") on every title card.
const BACKDROP = path.join(ROOT, "assets", "images", "pdp11-machine-room.jpg");

// --- Narration for the reel's own cards -----------------------------------
// Intro and outro voice-overs: the intro card opens every reel/clip, the
// outro (black project-URL card) closes it. Individual clip cards use the
// `voice` field of each CLIPS entry below. When speech is longer than the
// card's visual duration the card is stretched to fit it (see mixSpeech).
const INTRO_VOICE = "Welcome to y-a-PDP, a faithful PDP-11-70 emulator. Step " +
    "into the era in one click — no disks, no setup, nothing to configure. " +
    "Let's boot some classic DECK software.";
const OUTRO_VOICE = "Thanks for watching. y-a-PDP brings the PDP-11 back to " +
    "life: instant, immersive, always ready to run.";

// --- The clips, in reel order ---------------------------------------------
const CLIPS = [
    { file: "basic.webm",        title: "DEC BASIC-11",
      voice: "This demo boots DEC BASIC-11 from an RK05 disk. Type a few " +
        "lines, and the PDP-11 answers in classic BASIC." },
    { file: "basic-tape.webm",   title: "DEC BASIC-11 (ASR TAPE)",
      voice: "BASIC-11, this time loading from punched tape on the " +
        "Model 33 teletype. Watch the paper tape reader spin." },
    { file: "unix_v5.webm",      title: "BOOTING UNIX V5",
      voice: "Now we boot UNIX Version 5 — an early UNIX from 1975, running " +
        "on the PDP-11 slash 70." },
    { file: "bsd.webm",          title: "2.11 BSD",
      voice: "This is 2.11 BSD, the last and most polished UNIX for the " +
        "PDP-11. Log in and explore." },
    { file: "rt11.webm",         title: "RT-11 v4.0",
      voice: "RT-11, Digital's single-user real-time operating system, " +
        "booting from disk. A workhorse of the PDP-11 era." },
    { file: "rt11-vt52.webm",    title: "RT-11 v4.0 (VT52)",
      voice: "RT-11, this time on a VT52 terminal. Green phosphor, " +
        "command lines, and an interactive monitor." },
    { file: "rt11-panel-boot.webm", title: "MANUAL BOOTSTRAP",
      voice: "A manual bootstrap: loading a tiny boot program with the " +
        "front-panel switches, the way operators did it back in 1977." },
    { file: "xxdp.webm",         title: "XXDP DIAGNOSTICS",
      voice: "XXDP diagnostics test every board in the machine. A serious " +
        "tool from Digital's own field service." },
    { file: "lunar-lander.webm", title: "LUNAR LANDER  ·  VT11",
      voice: "A favourite: Lunar Lander, running on the VT11 " +
        "vector graphics terminal. Try to set her down gently." }
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
    // Escape filtergraph specials that would otherwise break the parsed graph
    // when a fixed drawtext string is spliced into a -vf / filter_complex
    // string:
    //   :  -> \:   (option separator)
    //   ,  -> \,   (filter separator inside values)
    return String(s)
        .replace(/:/g, "\\:")
        .replace(/,/g, "\\,");
}

// Apostrophes (and any other character) cannot survive inside drawtext's
// text='...': every escaping tried (\\', \\u0027, raw quote) either drops the
// apostrophe or breaks the option parse, and the result never matches a
// textfile= control render. Dynamic text is therefore always burned through
// textfile= — the file content bypasses filtergraph escaping entirely, so it
// renders exactly as written on every ffmpeg build (static and distro alike).
const _textFiles = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-text-"));
process.on("exit", () => {
    try { fs.rmSync(_textFiles, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
});
let _textSeq = 0;
function textfileFilter(text) {
    // Forward slashes + escaped drive colon: the exact pattern verified to be
    // read back correctly on Windows; on Linux/macOS no escaping is needed.
    const f = path.join(_textFiles, "txt-" + String(++_textSeq) + ".txt");
    fs.writeFileSync(f, String(text));
    return "textfile='" + f.replace(/\\/g, "/").replace(/:/g, "\\:") + "'";
}

// Render a title card (video + silent stereo audio) as a short WebM clip: a
// dark DEC-colored card with the landing-page machine-room photo overlaid at
// 30% opacity ("70% transparent"), text on top, faded in/out. `opts` may carry
// { size, font, footer } for a larger/bolder title and a bottom line; `sans`
// renders the main text in the intro's subtitle style — a bold sans-serif
// (Arial) in light with a dark outline — which reads much better than the
// monospace DEC look for a "what this demo shows" line; `scanlines` overlays
// the same CRT scanlines the intro card uses.
function genSlide(file, text, subtitle, duration, opts) {
    opts = opts || {};
    const font = opts.font || FONT;
    const size = opts.size || 64;
    const textFont = opts.sans ? FONT_BOLD : font;
    const textColor = (opts.sans ? "0xeaeaea" : FG) + "@0.85";
    const draw = [
        `drawtext=fontfile=${textFont}:${textfileFilter(text)}:fontsize=${size}:fontcolor=${textColor}:` +
            `borderw=3:bordercolor=black:x=(w-text_w)/2:y=(h-text_h)/2-50`,
        `drawtext=fontfile=${font}:${textfileFilter(subtitle || "")}:fontsize=30:fontcolor=${DIM}:` +
            `x=(w-text_w)/2:y=(h)/2+40`
    ];
    if (opts.footer) {
        draw.push(`drawtext=fontfile=${FONT}:${textfileFilter(opts.footer)}:fontsize=26:fontcolor=${DIM}:` +
            `x=(w-text_w)/2:y=h-70`);
    }
    const fc =
        `[1:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
            `crop=${WIDTH}:${HEIGHT},format=rgba,colorchannelmixer=aa=0.3[ph];` +
        `[0:v][ph]overlay=0:0,` +
        draw.join(",") + `,` +
        (opts.scanlines ? scanlineVf() + `,` : "") +
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
        "-c:v", "libvpx", "-b:v", "12M", "-c:a", "libopus",
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
// title card first (cross-faded in), then a labelled title card describing
// what the demo shows (the same slide the reel uses), then the raw clip, then
// the quiet background music mixed under the clip audio. The WebM raw captures
// are never published — every uploadable file is an MP4.
function exportIndividual(clip, music, tmp, srcPath, ctx) {
    const introPath = path.join(VIDEOS, "yapdp-intro.webm");
    const clipPath = srcPath || path.join(VIDEOS, clip.file);
    if (!fs.existsSync(introPath) || !fs.existsSync(clipPath)) return;
    const base = path.basename(clip.file, ".webm");
    // ctx = { voices, reverb, clipEvents, burnSubtitles } (see main).
    const voices = (ctx && ctx.voices) || null;
    const reverb = !ctx || ctx.reverb !== false;
    const clipEv = (ctx && ctx.clipEvents && ctx.clipEvents[base]) || [];
    const burnSubtitles = !!(ctx && ctx.burnSubtitles);
    const slideKey = "slide-" + base;

    const nIntro = path.join(tmp, "ind_" + base + "_intro.webm");
    const nSlide = path.join(tmp, "ind_" + base + "_slide.webm");
    const nClip = path.join(tmp, "ind_" + base + "_clip.webm");
    const aIntro = path.join(tmp, "ind_" + base + "_intro_a.webm");
    const aSlide = path.join(tmp, "ind_" + base + "_slide_a.webm");
    const aClip = path.join(tmp, "ind_" + base + "_clip_a.webm");
    const nOutro = path.join(tmp, "ind_" + base + "_outro.webm");
    const aOutro = path.join(tmp, "ind_" + base + "_outro_a.webm");
    const outroRaw = path.join(tmp, "ind_" + base + "_outro_raw.webm");
    // A labelled title card (the same slide the reel uses) telling the viewer
    // what this demo shows, right after the product intro card. The text uses
    // the intro's subtitle style (bold sans-serif, light with an outline) and
    // is sized up so it reads clearly; it is held ~3x longer than the reel's
    // quick title cards so the description is readable.
    genSlide(nSlide, clip.title, "",
        voicedCardDuration(voices && voices[slideKey], CLIP_SLIDE_MS / 1000), {
            sans: true,
            size: 68,
            scanlines: true
        });
    normalise(introPath, nIntro);
    normalise(clipPath, nClip);
    alignStreams(nIntro, aIntro);
    alignStreams(nSlide, aSlide);
    alignStreams(nClip, aClip);
    // Mix any spoken phrases recorded inside this clip into its audio at their
    // media offsets (no stretch — the clip keeps its own length).
    const clipPhrasesNow = clipPhrases(clipEv);
    const aClipSeg = clipPhrasesNow.length
        ? mixClipPhrases(aClip, clipPhrasesNow,
            path.join(tmp, "ind_" + base + "_clip_phr.webm"))
        : aClip;
    // Final URL card (black + project URL) fades in after the clip, so the
    // clip fades out and every upload ends on the project URL.
    genUrlCard(outroRaw,
        voicedCardDuration(voices && voices["outro"], OUTRO_SECONDS));
    normalise(outroRaw, nOutro);
    alignStreams(nOutro, aOutro);

    // Lay the voice-overs onto the voiced cards AFTER they are normalised and
    // aligned (mixSpeech expects an aligned stereo segment): the intro, the
    // labelled slide and the outro. A card without narration (no WAV) is
    // passed through untouched.
    // The intro gets the longer lead-in (VOICE_PRE_INTRO): its title is fully
    // on screen before the narration starts. Slides/outro talk sooner.
    const vIntro = voicedOr(aIntro, voices && voices["intro"], tmp,
        "ind_" + base + "_intro_vd", reverb, vutil.VOICE_PRE_INTRO);
    const vSlide = voicedOr(aSlide, voices && voices[slideKey], tmp,
        "ind_" + base + "_slide_vd", reverb);
    const vOutro = voicedOr(aOutro, voices && voices["outro"], tmp,
        "ind_" + base + "_outro_vd", reverb);

    // Cross-fade intro -> slide -> clip -> outro (video xfade + acrossfade).
    // Durations are read from the VOICED variants, so the cards that were
    // stretched to fit their narration shift the offsets correctly.
    const dIntro = probeDuration(vIntro);
    const dSlide = probeDuration(vSlide);
    const dClip = probeDuration(aClipSeg);
    const dOutro = probeDuration(vOutro);
    const fade = 0.6;
    const concatOut = path.join(tmp, "ind_" + base + "_plain.mp4");
    run([
        "-y",
        "-i", vIntro,
        "-i", vSlide,
        "-i", aClipSeg,
        "-i", vOutro,
        "-filter_complex",
        `[0:v]settb=AVTB[v0];[1:v]settb=AVTB[v1];[2:v]settb=AVTB[v2];[3:v]settb=AVTB[v3];` +
            `[v0][v1]xfade=transition=fade:duration=${fade}:offset=${(dIntro - fade).toFixed(3)}[x1];` +
            `[x1][v2]xfade=transition=fade:duration=${fade}:offset=${(dIntro + dSlide - fade * 2).toFixed(3)}[x2];` +
            `[x2][v3]xfade=transition=fade:duration=${fade}:offset=${(dIntro + dSlide + dClip - fade * 3).toFixed(3)}[vout];` +
            `[0:a]anull[a0];[1:a]anull[a1];[2:a]anull[a2];[3:a]anull[a3];` +
            `[a0][a1]acrossfade=d=${fade}[x1a];` +
            `[x1a][a2]acrossfade=d=${fade}[x2a];` +
            `[x2a][a3]acrossfade=d=${fade}[aout]`,
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        concatOut
    ]);

    const out = path.join(VIDEOS, base + ".mp4");
    if (music) {
        const mixed = path.join(tmp, "ind_" + base + "_mixed.mp4");
        const dur = probeDuration(concatOut);
        // Duck the music only while each voiced card's narration is actually
        // audible (after its lead-in, until its reverb tail), so the track
        // starts/continues at its normal level otherwise.
        const voicedMeta = [];
        if (voices && voices["intro"]) {
            voicedMeta.push({ idx: 0, pre: vutil.VOICE_PRE_INTRO,
                dur: probeDuration(voices["intro"]) });
        }
        if (voices && voices[slideKey]) {
            voicedMeta.push({ idx: 1, pre: vutil.VOICE_PRE,
                dur: probeDuration(voices[slideKey]) });
        }
        if (voices && voices["outro"]) {
            voicedMeta.push({ idx: 3, pre: vutil.VOICE_PRE,
                dur: probeDuration(voices["outro"]) });
        }
        const duckChain = vutil.musicDuckFilters(
            vutil.speechDuckWindows([dIntro, dSlide, dClip, dOutro], voicedMeta, fade)
        ).join(",");
        run([
            "-y",
            // Loop the music indefinitely so it plays for the whole clip even
            // when the track is shorter than the video; the -t trims it to the
            // video length (otherwise the endless input would never finish).
            "-stream_loop", "-1",
            "-i", music,
            "-i", concatOut,
            "-filter_complex",
            `[0:a]${duckChain}[m];[1:a][m]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
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
    // Chapters / subtitles / banner overlays from this clip's timed events,
    // mapped onto the standalone-clip timeline (the clip is segment 2, so its
    // own t=0 sits at segmentStarts(...)[2] on the final MP4).
    if (clipEv.length) {
        const starts = vutil.segmentStarts([dIntro, dSlide, dClip, dOutro], fade);
        const art = timeline.planArtifacts(clipEv, starts[2]);
        writeMediaSidecars(out, art.chapters, art.srt);
        if (art.banners.length || (burnSubtitles && art.srt.length)) {
            const burned = path.join(tmp, "ind_" + base + "_burn.mp4");
            burnOverlays(out, burned, art.banners, art.srt, burnSubtitles);
            fs.copyFileSync(burned, out);
            fs.unlinkSync(burned);
        }
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

// --- Voice-over (tools/voicer.js TTS + mixSpeech) --------------------------

// Run an arbitrary child process to completion; resolves on exit code 0.
function runChild(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(args[0], args.slice(1), { cwd: ROOT, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error("process exited with code " + code +
                (signal ? " (signal " + signal + ")" : "")));
        });
    });
}

// Speak `text` through tools/voicer.js into `outWav`. The voicer itself picks
// the engine from --engine; `engine` here is the --voice-engine the caller
// chose (auto -> Kokoro-82M, falling back to Windows SAPI; kokoro/sapi -> that
// single engine). Not passing it keeps auto.
async function speakToWav(text, outWav, engine) {
    const voicer = path.join(__dirname, "voicer.js");
    const args = [process.execPath, voicer, "--text", text, "--out", outWav];
    if (engine && engine !== "auto") args.push("--engine", engine);
    await runChild(args);
}

// Make sure `name` has a narration WAV in video/voice/, generating it through
// voicer.js only when the cached file is stale. The cache is content-addressed:
// every WAV has a <name>.sig sidecar holding voiceSignature(text, engine), so
// editing the narration script or switching --voice-engine regenerates the
// voice automatically (no forgotten --voice-regen), while unchanged cards are
// reused without re-synthesizing. --voice-regen still forces a full rebuild.
// TTS may be unavailable on a machine — in that case the caller gets null and
// the card is simply assembled without narration.
async function ensureVoiceWav(name, text, force, engine) {
    fs.mkdirSync(VOICE_DIR, { recursive: true });
    const file = path.join(VOICE_DIR, name + ".wav");
    const sigFile = path.join(VOICE_DIR, name + ".sig");
    const sig = vutil.voiceSignature(text, engine);
    const cached = fs.existsSync(file) && fs.statSync(file).size > 0;
    const fresh = cached && fs.existsSync(sigFile) &&
        fs.readFileSync(sigFile, "utf8").trim() === sig;
    if (!force && fresh) return file;
    if (cached) {
        // Stale WAV (text/engine changed, or --voice-regen): drop both the
        // audio and its signature, so a failed synth never leaves a mismatched
        // cache entry behind.
        try { fs.unlinkSync(file); } catch (err) { /* best effort */ }
        try { fs.unlinkSync(sigFile); } catch (err) { /* best effort */ }
    }
    process.stdout.write("Voicing card '" + name + "' (TTS" +
        (engine && engine !== "auto" ? ", engine " + engine : "") + ")...\n");
    try {
        await speakToWav(text, file, engine);
        if (!fs.existsSync(file)) throw new Error("voicer produced no WAV");
        fs.writeFileSync(sigFile, sig);
        return file;
    } catch (err) {
        process.stdout.write("note: narration for '" + name + "' unavailable (" +
            err.message + "); the card stays silent.\n");
        return null;
    }
}

// Lay `wav` narration over an already-normalised/aligned card segment `input`
// and write the result to `out`. The audio is stretched by mixing the
// narration in, and the card's video — when the speech is longer than the
// card — by FREEZING the last fully visible frame (the one just before the
// card's fade-out begins), NOT the final already-faded frame; otherwise the
// narration would run on a black screen. The (mono, dry) TTS voice is
// optionally warmed by a light aecho reverb / pseudo-stereo.
// `preSec` overrides the silent lead-in before the speech (the intro card
// starts talking later so its title is fully on screen first).
function mixSpeech(input, wav, out, reverb, preSec) {
    const pre = (preSec != null ? preSec : vutil.VOICE_PRE);
    const speechDur = probeDuration(wav);
    const inputDur = probeDuration(input);
    const target = vutil.speechTargetDuration(inputDur, speechDur, pre);
    const padDur = Math.max(0, target - inputDur);
    const preMs = Math.round(pre * 1000);
    // Narration chain: resample to the reel's stereo/44.1k/fltp, delay to the
    // pre-roll, optionally a tiny room reverb, then a limiter so mixing it
    // over clip/music audio cannot clip. No apad: the tail must stay finite
    // for amix=duration=longest.
    let voiceChain = "aresample=44100," +
        "aformat=sample_fmts=fltp:channel_layouts=stereo," +
        "adelay=" + preMs + ":all=1";
    if (reverb) voiceChain += "," + vutil.REVERB_AECHO;
    voiceChain += ",alimiter=limit=0.97[sp]";
    // When the card must be stretched, cut it just before its fade-out and
    // clone THAT (bright) frame up to the target length.
    let vidPad;
    if (padDur > 0.001) {
        const holdAt = Math.max(0.2, inputDur - vutil.VOICE_HOLD_EDGE);
        const stop = Math.max(0, target - holdAt);
        vidPad = "[0:v]trim=start=0:end=" + holdAt.toFixed(3) +
            ",setpts=PTS-STARTPTS," +
            "tpad=stop_mode=clone:stop_duration=" + stop.toFixed(3) + "[v0];";
    } else {
        vidPad = "[0:v]null[v0];";
    }
    const fc = vidPad +
        "[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];" +
        "[1:a]" + voiceChain + ";" +
        "[a0][sp]amix=inputs=2:duration=longest:dropout_transition=0[aout]";
    run([
        "-y",
        "-i", input,
        "-i", wav,
        "-filter_complex", fc,
        "-map", "[v0]", "-map", "[aout]",
        "-t", target.toFixed(3),
        "-c:v", "libvpx", "-b:v", "12M", "-c:a", "libopus",
        "-r", String(FPS), "-video_track_timescale", "30000",
        out
    ]);
    return out;
}

// Return the voiced variant of a card segment when its narration WAV exists,
// otherwise pass the input through untouched (no speech, no re-encode).
function voicedOr(input, wav, tmp, tag, reverb, preSec) {
    if (!wav) return input;
    const out = path.join(tmp, tag + ".webm");
    return mixSpeech(input, wav, out, reverb, preSec);
}

// Card duration that fits its narration: when a WAV exists the card is
// rendered at the target length straight away (see genSlide/genUrlCard), so
// the card's own fade-out lands AFTER the speech and the picture never goes
// dark under the voice. Without a WAV the plain base duration is kept.
// `preSec` mirrors mixSpeech's optional lead-in override for the intro card.
function voicedCardDuration(wav, baseDur, preSec) {
    if (!wav) return baseDur;
    return vutil.speechTargetDuration(baseDur, probeDuration(wav), preSec);
}

// --- Timed reel events (chapters / subtitles / phrases / banners) ----------
// Each recorded clip may carry a video/<base>.events.json sidecar (written by
// tools/record-video.js) with timed reel events — chapters, spoken phrases,
// banner titles and bottom subtitles. The assembler synthesises the phrases
// through tools/voicer.js and mixes them into the clip audio at their media
// offsets, then turns the chapters + subtitles + banner titles into YouTube
// sidecars (.chapters.txt / .srt) and burned overlays on the final MP4.
// Event media time maps 1:1 onto the (un-cut) clip timeline; events must sit
// on spans that survive any clip cut (Lunar Lander) — remapping is future work.

// Read + validate a clip's events sidecar; a missing/malformed file yields [].
function readClipEvents(base) {
    const file = path.join(VIDEOS, base + ".events.json");
    if (!fs.existsSync(file)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        return timeline.validateEvents((data && data.events) || []);
    } catch (err) {
        console.error("note: ignoring bad events sidecar " +
            path.relative(ROOT, file) + " (" + err.message + ")");
        return [];
    }
}

// Synthesise every spoken phrase through tools/voicer.js (content-addressed WAV
// cache under video/voice/) and attach each speak event's wav + measured
// duration, so the audio mixer and the subtitle planner can use them.
async function voiceClipEvents(events, force, engine) {
    for (const e of events) {
        if (e.type !== "speak") continue;
        const name = "phr-" + timeline.phraseCacheKey(e.text, engine);
        const wav = await ensureVoiceWav(name, e.text, force, engine);
        e.wav = wav || null;
        e.dur = wav ? probeDuration(wav) : 0;
    }
    return events;
}

// The spoken phrases of a clip (speak events whose WAV was synthesised).
function clipPhrases(events) {
    return (events || []).filter((e) => e.type === "speak" && e.wav);
}

// Mix spoken phrases into an aligned stereo clip segment at their media offsets
// (adelay + amix). amix duration=first keeps the original segment length, so a
// phrase that would overrun the segment end is naturally cut off there (the
// guard). Returns the input unchanged when there is nothing to mix.
function mixClipPhrases(input, phrases, out) {
    if (!phrases || !phrases.length) return input;
    const args = ["-y", "-i", input];
    const chains = [];
    const mixIns = [];
    phrases.forEach((p, i) => {
        const idx = i + 1;
        args.push("-i", p.wav);
        const offMs = Math.round(Math.max(0, p.t) * 1000);
        chains.push(`[${idx}:a]aresample=44100,` +
            `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
            `adelay=${offMs}:all=1,apad[px${idx}]`);
        mixIns.push(`[px${idx}]`);
    });
    const fc = chains.join(";") +
        `;[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a0];` +
        `[a0]${mixIns.join("")}amix=inputs=${mixIns.length + 1}:` +
        `duration=first:dropout_transition=0[aout]`;
    run([...args,
        "-filter_complex", fc,
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "libopus",
        out
    ]);
    return out;
}

// Write the chapter + subtitle sidecars next to an output MP4 (only when the
// formatted text is non-empty), e.g. video/yaPDP-demo.chapters.txt + .srt.
function writeMediaSidecars(outMp4, chapters, srt) {
    const stem = path.join(VIDEOS, path.basename(outMp4, ".mp4"));
    const c = timeline.formatChapters(chapters);
    if (c) fs.writeFileSync(stem + ".chapters.txt", c + "\n");
    const s = timeline.formatSrt(srt);
    if (s) fs.writeFileSync(stem + ".srt", s + "\n");
}

// Burn banner titles (and, with --burn-subtitles, the bottom subtitles) onto a
// finished MP4, re-encoding the video while keeping the AAC audio as-is.
// Banners use the bold display font at the top; subtitles the mono font at the
// bottom — two different layers, so they never overlap on purpose.
function burnOverlays(input, out, banners, subtitles, burnSubtitles) {
    const draws = [];
    for (const b of banners || []) {
        draws.push(`drawtext=fontfile=${FONT_BOLD}:${textfileFilter(b.text)}:` +
            `fontsize=46:fontcolor=0xeaeaea:borderw=4:bordercolor=black:` +
            `x=(w-text_w)/2:y=44:enable='between(t,${b.start.toFixed(2)},${b.end.toFixed(2)})'`);
    }
    if (burnSubtitles) {
        for (const s of subtitles || []) {
            draws.push(`drawtext=fontfile=${FONT}:${textfileFilter(s.text)}:` +
                `fontsize=26:fontcolor=white:borderw=2:bordercolor=black:` +
                `x=(w-text_w)/2:y=h-110:enable='between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})'`);
        }
    }
    if (!draws.length) return input;
    run([
        "-y", "-i", input,
        "-vf", draws.join(","),
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-movflags", "+faststart",
        out
    ]);
    return out;
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
        // Look only at positional args, ignoring values consumed by flags such
        // as --voice-engine kokoro / --music FILE (those follow their flag and
        // must not be mistaken for a clip selector).
        const argv = process.argv.slice(2);
        const valueTakingFlags = new Set(["--voice-engine", "--music"]);
        const positional = argv.filter((a, i) => {
            if (a.startsWith("--")) return false;
            const prev = argv[i - 1];
            return !valueTakingFlags.has(prev);
        });
        const selector = (positional[0] || "")
            .toLowerCase().replace(/\.(webm|mp4)$/, "");

        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-reel-"));
        const outro = path.join(tmp, "outro.webm");
        const slides = CLIPS.map((c) =>
            path.join(tmp, "slide_" + path.basename(c.file, ".webm") + ".webm"));

        // Voice-over knobs: --voice-regen forces a TTS rebuild of every WAV,
        // --no-voice-reverb turns the narration's light reverb/pseudo-stereo
        // preset off (leaving a dry, mono voice). --voice-engine selects the
        // voicer engine: auto (default, Kokoro-82M -> Windows SAPI fallback),
        // kokoro (the local neural Kokoro-82M TTS via kokoro-js) or sapi.
        const reverb = !process.argv.includes("--no-voice-reverb");
        const voiceForce = process.argv.includes("--voice-regen");
        const ve = process.argv.indexOf("--voice-engine");
        const voiceEngine = ve !== -1 ? process.argv[ve + 1] : "auto";
        // --burn-subtitles also burns the bottom subtitle lines into the video;
        // the .srt sidecar is written either way, and banner titles always burn.
        const burnSubtitles = process.argv.includes("--burn-subtitles");

        // Narration pre-pass: make sure every card that will carry voice has
        // its WAV ready (cached under video/voice/, generated via voicer.js
        // only when missing). In single-clip mode only the chosen clip's slide
        // is voiced; otherwise every clip card is.
        console.log("Preparing narration (tools/voicer.js" +
            (voiceEngine !== "auto" ? ", engine " + voiceEngine : "") + ")...");
        const voices = {};
        voices["intro"] = await ensureVoiceWav("intro", INTRO_VOICE,
            voiceForce, voiceEngine);
        voices["outro"] = await ensureVoiceWav("outro", OUTRO_VOICE,
            voiceForce, voiceEngine);
        if (selector) {
            const aliases = { lander: "lunar-lander" };
            const s = aliases[selector] || selector;
            const clip = CLIPS.find((c) =>
                c.file === s + ".webm" ||
                path.basename(c.file, ".webm") === s);
            if (clip) {
                const key = "slide-" + path.basename(clip.file, ".webm");
                voices[key] = await ensureVoiceWav(key, clip.voice,
                    voiceForce, voiceEngine);
            }
        } else {
            for (const c of CLIPS) {
                const key = "slide-" + path.basename(c.file, ".webm");
                voices[key] = await ensureVoiceWav(key, c.voice,
                    voiceForce, voiceEngine);
            }
        }
        // Timed reel events: load each clip's .events.json sidecar (written by
        // tools/record-video.js) and synthesise its spoken phrases up front so
        // the clip audio can be mixed and the sidecars/banners rendered later.
        const clipEvents = {};
        for (const c of CLIPS) {
            const base = path.basename(c.file, ".webm");
            const ev = readClipEvents(base);
            if (ev.length) {
                clipEvents[base] = await voiceClipEvents(ev, voiceForce, voiceEngine);
            }
        }
        const voiceCtx = { voices, reverb, clipEvents, burnSubtitles };

        // Intro: the canvas-rendered title card from tools/make-intro.js (amber
        // "YAPDP" glow, "YET ANOTHER PDP-11 EMULATOR" subtitle, green phosphor
        // typing, CRT scanlines). make-intro.js accepts a target length and
        // stretches only its static hold, so the card is rendered to end right
        // when the narration (with its lead-in) finishes — the fade-out lands
        // after the speech, never under it. The card is (re)generated whenever
        // it is missing or too short for the current narration; the `canvas`
        // devDependency is required (its native libraries are installed on CI
        // by the build-promo-videos workflow). There is deliberately NO
        // drawtext fallback card: silently substituting a plain card is how the
        // intro effects (glow/scanlines/typing) used to vanish, so a failed
        // intro render now fails the build with a clear message.
        const introPath = path.join(VIDEOS, "yapdp-intro.webm");
        const introVoice = voices["intro"] || null;
        // Lead-in + speech + post-roll, plus the canvas card's 1 s fade-out.
        // make-intro's fade-out occupies the LAST second of the card, so making
        // total = pre + speech + post + 1.0 means the fade begins VOICE_POST
        // (0.8 s) AFTER the voice ends — mixSpeech (preSec = VOICE_PRE_INTRO)
        // never plays under the fade and never needs to freeze a frame.
        let introTargetSec = null;
        if (introVoice) {
            const speech = probeDuration(introVoice);
            introTargetSec = vutil.VOICE_PRE_INTRO + speech +
                vutil.VOICE_POST + 1.0;
        }
        const needIntro = !fs.existsSync(introPath) ||
            (introTargetSec !== null &&
                probeDuration(introPath) < introTargetSec);
        if (needIntro) {
            console.log("Rendering canvas intro card (" +
                (introTargetSec !== null
                    ? introTargetSec.toFixed(2) + " s to fit the narration"
                    : "default length") + ")...");
            const args = [path.join(__dirname, "make-intro.js")];
            if (introTargetSec !== null) args.push(String(introTargetSec));
            const render = spawnSync(process.execPath, args, { stdio: "inherit" });
            if (render.status !== 0) {
                throw new Error("tools/make-intro.js failed (status " +
                    render.status + "). The canvas intro card is required; make " +
                    "sure the `canvas` devDependency is installed (`npm ci`). On " +
                    "CI the build-promo-videos workflow installs its native " +
                    "libraries before assembling.");
            }
        }
        const intro = introPath;

        console.log("Rendering title cards...");
        CLIPS.forEach((c, i) => {
            const key = "slide-" + path.basename(c.file, ".webm");
            genSlide(slides[i], c.title, "",
                voicedCardDuration(voices[key], SLIDE_MS / 1000));
        });
        // The reel ends on the black project-URL card (fade out at the very
        // end); stretched so the farewell speech fits before the fade.
        genUrlCard(outro, voicedCardDuration(voices["outro"], OUTRO_SECONDS));

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
            exportIndividual(clip, music, tmp, srcFor[clip.file], voiceCtx);
            console.log("Done.");
            return;
        }

        // Build the ordered list of raw segments: intro, slide, clip, slide, ...
        // Each entry carries the narration key of the voiced cards (intro,
        // slides, outro); raw clips have no voice.
        const raw = [{ file: intro, voiceKey: voices["intro"] ? "intro" : null }];
        CLIPS.forEach((c, i) => {
            const key = "slide-" + path.basename(c.file, ".webm");
            raw.push(
                { file: slides[i], voiceKey: voices[key] ? key : null },
                { file: srcFor[c.file], voiceKey: null,
                    base: path.basename(c.file, ".webm") });
        });
        raw.push({ file: outro, voiceKey: voices["outro"] ? "outro" : null });

        console.log("Normalising segments...");
        const inputs = [];
        // Metadata of every voiced card (where on the timeline its narration
        // actually plays) — used to duck the music only during the speech.
        const voicedMeta = [];
        raw.forEach((entry, i) => {
            const n = path.join(tmp, "seg_" + i + ".webm");
            const a = path.join(tmp, "seg_" + i + "_aligned.webm");
            normalise(entry.file, n);
            // Trim the longer stream so video and audio end at the same time
            // (keeps the xfade offsets and the acrossfade chain in sync).
            alignStreams(n, a);
            if (entry.voiceKey) {
                // Stretch the card to fit its narration (mixSpeech) and use
                // the voiced variant for the reel chain. The intro talks after
                // its longer lead-in (VOICE_PRE_INTRO).
                const preSec = entry.voiceKey === "intro"
                    ? vutil.VOICE_PRE_INTRO
                    : vutil.VOICE_PRE;
                const v = path.join(tmp, "seg_" + i + "_voiced.webm");
                const speechDur = probeDuration(voices[entry.voiceKey]);
                mixSpeech(a, voices[entry.voiceKey], v, reverb, preSec);
                voicedMeta.push({ idx: i, pre: preSec, dur: speechDur });
                inputs.push(v);
            } else {
                // A raw clip segment may carry spoken reel phrases — mix them
                // into its audio at their media offsets before the chain.
                const phrases = entry.base && clipEvents[entry.base]
                    ? clipPhrases(clipEvents[entry.base]) : [];
                inputs.push(phrases.length
                    ? mixClipPhrases(a, phrases,
                        path.join(tmp, "seg_" + i + "_phr.webm"))
                    : a);
            }
        });

        console.log("Probing durations...");
        const durs = inputs.map((f) => probeDuration(f));

        // Absolute start of every raw segment on the final reel timeline, plus
        // a map from clip base name -> its segment index (for reel events).
        const segStarts = vutil.segmentStarts(durs, FADE);
        const rawIndexByBase = {};
        raw.forEach((entry, i) => { if (entry.base) rawIndexByBase[entry.base] = i; });

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
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
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
            // Duck the music only while the narration of a voiced card
            // (intro/slides/outro) is actually audible; before it starts and
            // after it ends the track keeps its normal level.
            const duckChain = vutil.musicDuckFilters(
                vutil.speechDuckWindows(durs, voicedMeta, FADE)
            ).join(",");
            run([
                "-y",
                // Loop the music indefinitely so it plays for the whole reel
                // even when the track is shorter than the video; -t trims it
                // to the video length (endless input never finishes on its own).
                "-stream_loop", "-1",
                "-i", music,
                "-i", OUT,
                "-filter_complex",
                `[0:a]${duckChain}[m];[1:a][m]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
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

        // Chapters / subtitles / banner overlays from every clip's timed reel
        // events, mapped onto the final reel timeline (OUT).
        const reelChapters = [];
        const reelSrt = [];
        const reelBanners = [];
        for (const c of CLIPS) {
            const base = path.basename(c.file, ".webm");
            const evs = clipEvents[base];
            if (!evs) continue;
            const art = timeline.planArtifacts(evs, segStarts[rawIndexByBase[base]]);
            reelChapters.push(...art.chapters);
            reelSrt.push(...art.srt);
            reelBanners.push(...art.banners);
        }
        writeMediaSidecars(OUT, reelChapters, reelSrt);
        if (reelBanners.length || (burnSubtitles && reelSrt.length)) {
            const burned = path.join(tmp, "reel_burn.mp4");
            burnOverlays(OUT, burned, reelBanners, reelSrt, burnSubtitles);
            fs.copyFileSync(burned, OUT);
            fs.unlinkSync(burned);
        }

        // --- Individual YouTube-ready clips ------------------------------------
        console.log("Exporting individual clips...");
        CLIPS.forEach((c) =>
            exportIndividual(c, music, tmp, srcFor[c.file], voiceCtx));

        const kb = Math.round(fs.statSync(OUT).size / 1024);
        console.log("Done. Reel written to " + path.relative(ROOT, OUT) + " (" + kb + " kB).");
    } finally {
        if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    }
})().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
