#!/usr/bin/env node
/**
 * yaPDP — temporary WebM diagnostic (EBML parser).
 * Prints duration, track types and stream sizes for a .webm file without
 * requiring ffmpeg. Not part of the build; used only to verify recordings.
 *
 * Usage: node tools/_diag-webm.js assets/videos/<file>.webm
 */
"use strict";

const fs = require("fs");

function readVint(buf, pos) {
    const first = buf[pos];
    if (first === undefined) return null;
    let mask = 0x80;
    let len = 1;
    while (len <= 8 && !(first & mask)) {
        mask >>= 1;
        len++;
    }
    if (len > 8) return null;
    let value = first & (mask - 1);
    for (let i = 1; i < len; i++) {
        value = value * 256 + buf[pos + i];
    }
    return { len, value };
}

// Element ID: canonical value = data bits ORed with the length-marker bit.
function canonicalId(id) {
    return id.value | (1 << (7 * id.len));
}

// VINT "unknown size" marker: all data bits set to 1.
function isUnknownSize(size) {
    return size.value === (Math.pow(2, 7 * size.len) - 1);
}

const KNOWN = {
    0x1a45dfa3: "EBML",
    0x18538067: "Segment",
    0x1549a966: "Info",
    0x2ad7b1: "TimecodeScale",
    0x4489: "Duration",
    0x1654ae6b: "Tracks",
    0xae: "TrackEntry",
    0x83: "TrackType",
    0x1f43b675: "Cluster",
    0xe7: "ClusterTimecode",
};

function parse(buf) {
    const info = { scale: 1e6, duration: null, tracks: [], lastClusterTc: -1 };

    const walk = (start, end) => {
        let p = start;
        while (p < end) {
            const id = readVint(buf, p);
            if (!id) break;
            const cid = canonicalId(id);
            const size = readVint(buf, p + id.len);
            if (!size) break;
            const hdr = p + id.len + size.len;
            const dataEnd = isUnknownSize(size) ? end : hdr + size.value;
            if (dataEnd > end || dataEnd > buf.length) break;

            if (cid === 0x18538067 || cid === 0x1549a966 || cid === 0x1654ae6b ||
                cid === 0x1f43b675) {
                // Container: recurse. TrackEntry is handled inline below.
                walk(hdr, dataEnd);
            } else if (cid === 0x2ad7b1 && size.value >= 4) { // TimecodeScale
                let v = 0;
                for (let i = 0; i < size.value; i++) v = v * 256 + buf[hdr + i];
                info.scale = v;
            } else if (cid === 0x4489 && size.value >= 4) { // Duration (float)
                info.duration = buf.readFloatBE(hdr);
            } else if (cid === 0xae) { // TrackEntry
                let type = null;
                const sub = (s, e) => {
                    let q = s;
                    while (q < e) {
                        const sid = readVint(buf, q);
                        if (!sid) break;
                        const scid = canonicalId(sid);
                        const ssize = readVint(buf, q + sid.len);
                        if (!ssize) break;
                        const sh = q + sid.len + ssize.len;
                        const se = isUnknownSize(ssize) ? e : sh + ssize.value;
                        if (se > e) break;
                        if (scid === 0x83 && ssize.value === 1) type = buf[sh]; // TrackType
                        q = se;
                    }
                };
                sub(hdr, dataEnd);
                info.tracks.push(type);
            } else if (cid === 0xe7) { // Cluster Timecode (uint, 1-8 bytes)
                let v = 0;
                for (let i = 0; i < size.value; i++) v = v * 256 + buf[hdr + i];
                if (v > info.lastClusterTc) info.lastClusterTc = v;
            }
            p = dataEnd;
        }
    };

    // Start right after the EBML header at the top-level Segment.
    const seg = readVint(buf, 0);
    if (!seg) return info;
    const segSize = readVint(buf, seg.len);
    if (!segSize) return info;
    walk(seg.len + segSize.len, buf.length);
    return info;
}

const file = process.argv[2];
if (!file) {
    console.error("Usage: node tools/_diag-webm.js <file.webm>");
    process.exit(1);
}
const buf = fs.readFileSync(file);
const info = parse(buf);

// Estimate duration: Info.Duration (in TimecodeScale units) if present, else
// last cluster timecode + one frame.
let seconds = null;
if (info.duration != null) {
    seconds = (info.duration * info.scale) / 1e9;
} else if (info.lastClusterTc >= 0) {
    seconds = (info.lastClusterTc * info.scale) / 1e9 + 0.1;
}

console.log(`file      : ${file}`);
console.log(`size      : ${(buf.length / 1024).toFixed(1)} kB`);
console.log(`scale     : ${info.scale} ns/tick`);
console.log(`duration  : ${seconds != null ? seconds.toFixed(1) + " s" : "unknown"}`);
console.log(`tracks    : ${info.tracks.length} -> ${info.tracks.map((t) =>
    t === 1 ? "video" : t === 2 ? "audio" : t === null ? "unknown" : "type?" + t).join(", ") || "none"}`);
