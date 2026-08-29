#!/usr/bin/env node
/**
 * Diagnostic: print stream info (resolution, fps, bitrate, codec) for the
 * raw WebM captures and the final MP4 exports, to diagnose "blurry" video.
 */
"use strict";
const { spawnSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const files = process.argv.slice(2);
if (!files.length) {
    console.error("usage: node tools/_probe-media.js <file> [file ...]");
    process.exit(1);
}

for (const f of files) {
    const r = spawnSync(ffmpegPath, ["-i", f], { encoding: "utf8" });
    const lines = (r.stderr || "").split("\n");
    console.log("=== " + f + " ===");
    for (const l of lines) {
        if (/Duration:|Stream #0|encoder|bitrate:|handler_name/.test(l)) {
            console.log(l);
        }
    }
    console.log("");
}
