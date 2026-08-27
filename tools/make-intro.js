#!/usr/bin/env node
/**
 * yaPDP — Intro title-card generator.
 *
 * Renders a promotional intro card frame-by-frame with node-canvas:
 *   - the machine-room photo as the backdrop with cinematic vignette;
 *   - a big amber-glowing "yaPDP" title (phosphor bloom, three passes);
 *   - the subtitle "YET ANOTHER PDP-11 EMULATOR";
 *   - a green phosphor line typed out character-by-character:
 *     "-- created with love for the DEC era" with a blinking terminal cursor;
 *   - CRT scanlines.
 * Then it assembles the frames with ffmpeg-static, synthesising a soft 850 Hz
 * "keypress" tick for every typed character.
 *
 * Output: assets/videos/yapdp-intro.webm (1280x800@30fps, VP8 + Opus).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { createCanvas, loadImage, registerFont } = require("canvas");
const ffmpegPath = require("ffmpeg-static");

const ROOT = path.resolve(__dirname, "..");
// Output goes to ./video/ (gitignored) — never assets/, which is published.
const OUT = path.join(ROOT, "video", "yapdp-intro.webm");

const WIDTH = 1280;
const HEIGHT = 800;
const FPS = 30;
const GREEN_TEXT = "-- created with love for the DEC era";
// Timeline: 1 s fade-in, typing starts at 2 s, 5 s hold on the final frame,
// 1 s fade-out.
const TEXT_START_FRAME = FPS * 2;
const TYPE_FRAMES = GREEN_TEXT.length * 3;
const HOLD_FRAMES = FPS * 5;
const FADE_FRAMES = FPS;
const TOTAL_FRAMES = FADE_FRAMES + TEXT_START_FRAME + TYPE_FRAMES + HOLD_FRAMES + FADE_FRAMES;
const DURATION_SEC = TOTAL_FRAMES / FPS;
const FRAME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-intro-"));

// Retro line-printer font shipped with the project (LP1 / DEC vibe).
const FONT = path.join(ROOT, "assets", "fonts", "lp1", "lp1-regular-webfont.ttf");
const BACKDROP = path.join(ROOT, "assets", "images", "pdp11-machine-room.jpg");

function run(args) {
    const res = spawnSync(ffmpegPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) {
        console.error("ffmpeg failed:\n" + (res.stderr || ""));
        throw new Error("ffmpeg exited with " + res.status);
    }
    return res;
}

(async () => {
    console.log("Loading machine-room backdrop and retro font...");
    registerFont(FONT, { family: "RetroLP" });
    const bg = await loadImage(BACKDROP);

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext("2d");

    console.log("Rendering " + TOTAL_FRAMES + " frames...");
    for (let i = 0; i < TOTAL_FRAMES; i++) {
        // Backdrop: cover the canvas with the machine-room photo.
        ctx.drawImage(bg, 0, 0, WIDTH, HEIGHT);

        // Cinematic vignette (radial darkening toward the edges).
        const vig = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, 180,
            WIDTH / 2, HEIGHT / 2, WIDTH * 0.75);
        vig.addColorStop(0, "rgba(10, 15, 12, 0.35)");
        vig.addColorStop(1, "rgba(0, 0, 0, 0.85)");
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);

        ctx.textAlign = "center";

        // --- Title: "yaPDP" with amber phosphor bloom -----------------------
        // Bold by construction: faux-bold (draw each pass with small offsets)
        // thickens the retro LP1 glyphs, a thick dark contour adds a crisp
        // outline, then the amber fill is layered on top.
        const titleText = "yaPDP";
        const ty = HEIGHT / 2 - 60;
        ctx.font = "bold 210px \"RetroLP\", monospace";
        ctx.textAlign = "center";
        ctx.lineJoin = "round";

        // 9 passes with ±2 px offsets = a heavy, chunky glyph.
        const offsets = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2],
            [2, 2], [-2, -2], [2, -2], [-2, 2]];

        // Outer dark contour (faux-bold, faint warm glow).
        ctx.lineWidth = 12;
        ctx.strokeStyle = "rgba(40, 20, 0, 0.95)";
        ctx.shadowColor = "rgba(255, 110, 0, 0.2)";
        ctx.shadowBlur = 12;
        offsets.forEach((o) => ctx.strokeText(titleText, WIDTH / 2 + o[0], ty + o[1]));

        // Main amber body (faux-bold, faint glow — no bloom halo).
        ctx.shadowBlur = 5;
        ctx.fillStyle = "#ff9900";
        offsets.forEach((o) => ctx.fillText(titleText, WIDTH / 2 + o[0], ty + o[1]));

        // Warm core — clean, no glow.
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#ffd27a";
        ctx.fillText(titleText, WIDTH / 2, ty);

        // --- Subtitle (bright fill + dark outline for contrast on any bg) ----
        const subtitle = "YET ANOTHER PDP-11 EMULATOR";
        ctx.font = "28px \"Helvetica Neue\", Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.lineWidth = 5;
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.shadowColor = "rgba(0,0,0,0.9)";
        ctx.shadowBlur = 12;
        ctx.strokeText(subtitle, WIDTH / 2, HEIGHT / 2 + 70);
        ctx.shadowBlur = 4;
        ctx.fillStyle = "#eaeaea";
        ctx.fillText(subtitle, WIDTH / 2, HEIGHT / 2 + 70);
        ctx.shadowBlur = 0;

        // --- Bottom line: green phosphor "typewriter" -------------------------
        // The whole line is laid out once (left-aligned from its centred start
        // point), so the typed text grows to the RIGHT instead of spreading
        // from the middle in both directions.
        ctx.font = "34px \"RetroLP\", monospace";
        const greenFullWidth = ctx.measureText(GREEN_TEXT).width;
        const greenStartX = (WIDTH - greenFullWidth) / 2;
        if (i >= TEXT_START_FRAME) {
            const charsToShow = Math.min(GREEN_TEXT.length,
                Math.floor((i - TEXT_START_FRAME) / 3));
            const visible = GREEN_TEXT.substring(0, charsToShow);

            ctx.shadowColor = "rgba(0, 255, 50, 0.8)";
            ctx.shadowBlur = 20;
            ctx.fillStyle = "#33ff33";
            ctx.textAlign = "left";
            ctx.fillText(visible, greenStartX, HEIGHT - 150);

            // Blinking terminal cursor after the typed text.
            if (charsToShow < GREEN_TEXT.length || Math.floor(i / 15) % 2 === 0) {
                const w = ctx.measureText(visible).width;
                ctx.fillStyle = "#33ff33";
                ctx.fillRect(greenStartX + w + 12, HEIGHT - 182, 18, 32);
            }
        }

        // --- CRT scanlines ----------------------------------------------------
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(0, 0, 0, 0.16)";
        for (let y = 0; y < HEIGHT; y += 4) {
            ctx.fillRect(0, y, WIDTH, 2);
        }

        // --- Project URL at the very bottom -----------------------------------
        const siteUrl = "https://amesk.github.io/yaPDP/";
        ctx.font = "22px \"RetroLP\", monospace";
        ctx.textAlign = "center";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.shadowColor = "rgba(0,0,0,0.9)";
        ctx.shadowBlur = 8;
        ctx.strokeText(siteUrl, WIDTH / 2, HEIGHT - 55);
        ctx.fillStyle = "rgba(220, 220, 220, 0.85)";
        ctx.fillText(siteUrl, WIDTH / 2, HEIGHT - 55);
        ctx.shadowBlur = 0;

        // --- Fade in / fade out ------------------------------------------------
        let fadeA = 0;
        if (i < FADE_FRAMES) fadeA = 1 - i / FADE_FRAMES;
        else if (i > TOTAL_FRAMES - FADE_FRAMES) {
            fadeA = (i - (TOTAL_FRAMES - FADE_FRAMES)) / FADE_FRAMES;
        }
        if (fadeA > 0) {
            ctx.fillStyle = "rgba(0,0,0," + fadeA.toFixed(3) + ")";
            ctx.fillRect(0, 0, WIDTH, HEIGHT);
        }

        const buf = canvas.toBuffer("image/jpeg", { quality: 0.95 });
        fs.writeFileSync(path.join(FRAME_DIR,
            "frame_" + String(i).padStart(4, "0") + ".jpg"), buf);
    }

    console.log("Assembling the intro video (with keypress ticks)...");
    // One soft tick per typed character, aligned to when that char appears.
    let fc = "";
    const amix = [];
    for (let c = 0; c < GREEN_TEXT.length; c++) {
        const t = (TEXT_START_FRAME + c * 3) / FPS;
        fc += `sine=frequency=850:duration=0.02:sample_rate=44100,` +
            `adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[clk${c}];`;
        amix.push(`[clk${c}]`);
    }
    fc += `${amix.join("")}amix=inputs=${amix.length},` +
        `volume=1.6[aout]`;

    run([
        "-y",
        "-framerate", String(FPS),
        "-i", path.join(FRAME_DIR, "frame_%04d.jpg"),
        "-filter_complex", fc,
        "-map", "0:v", "-map", "[aout]",
        "-t", String(DURATION_SEC),
        "-c:v", "libvpx", "-b:v", "8M",
        "-c:a", "libopus", "-b:a", "128k",
        OUT
    ]);

    fs.rmSync(FRAME_DIR, { recursive: true, force: true });
    const kb = Math.round(fs.statSync(OUT).size / 1024);
    console.log("Done. Intro written to " + path.relative(ROOT, OUT) + " (" + kb + " kB).");
})().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
