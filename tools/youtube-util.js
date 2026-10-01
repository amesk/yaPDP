#!/usr/bin/env node
/**
 * yaPDP — YouTube publishing pure helpers.
 *
 * Everything that can be decided without talking to YouTube lives here, so the
 * publisher (tools/youtube-publish.js) stays a thin I/O shell around it:
 *   1. text hygiene within YouTube's hard limits
 *      (sanitizeText/truncateTitle/fitTags/buildDescription) — '<'/'>' are
 *      stripped because YouTube rejects them in titles/descriptions/tags;
 *   2. chapter normalisation (normalizeChapters/formatChaptersBlock) — YouTube
 *      only renders a chapter block when the first chapter is 0:00, there are
 *      at least three chapters and every chapter lasts >= 10 s, so the block
 *      emitted by tools/reel-timeline-util.js (whose first mark sits after the
 *      intro card) is clamped/reduced to satisfy those rules or dropped whole;
 *   3. CLI argument parsing (parseArgs) and playlist-id parsing
 *      (parsePlaylistUrl);
 *   4. batch planning: which videos to publish (selectVideos), what still has
 *      to be done for each video (planAction/isStale) and how many quota units
 *      the batch costs (unitsFor/planQuota) — the YouTube Data API grants
 *      10 000 units per day and one upload with captions + playlist costs
 *      2 050, so "publish everything" must be split into resumable batches;
 *   5. the idempotency state (loadState/saveState/hashFile) that lets a batch
 *      be re-run without uploading duplicates.
 *
 * Unit-tested by tests/youtube-util.test.js.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const timeline = require("./reel-timeline-util.js");

// --- YouTube hard limits ----------------------------------------------------

const LIMITS = {
    TITLE: 100,          // chars — snippet.title
    DESCRIPTION: 5000,   // chars — snippet.description
    TAGS: 500            // chars TOTAL across all tags, comma-joined
};

// --- YouTube Data API v3 quota costs (units) --------------------------------
// The default daily quota is 10 000 units, so a full "publish everything" run
// (~10 clips) needs several days — hence the batch planner below.
const QUOTA = {
    VIDEO_INSERT: 1600,     // videos.insert
    CAPTION_INSERT: 400,    // captions.insert
    PLAYLIST_INSERT: 50     // playlistItems.insert
};
const DEFAULT_BUDGET = 9000;    // leave headroom for the whoami/cleanup calls

// YouTube chapter rules: first chapter at 0:00, at least three chapters, every
// chapter at least 10 seconds long — otherwise the whole block is ignored and
// the timestamps render as plain description text.
const CHAPTER_MIN_COUNT = 3;
const CHAPTER_MIN_GAP = 10;

// videos.insert snippet.status.privacyStatus values.
const DISPOSITIONS = ["public", "unlisted", "private"];

// youtube.force-ssl covers videos.insert, captions.insert and
// playlistItems.insert, so a single consent grants the whole pipeline.
const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

// --- small helpers ----------------------------------------------------------

function asArray(v) {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

// YouTube rejects '<' and '>' outright, and control characters break the
// rendered description, so every text leaving this module is sanitised.
function sanitizeText(s) {
    return String(s == null ? "" : s)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
        .replace(/[<>]/g, "")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function truncateTitle(title) {
    const t = sanitizeText(title).replace(/\s+/g, " ");
    return t.length <= LIMITS.TITLE ? t : t.slice(0, LIMITS.TITLE).trim();
}

// Normalise a tag list: strip '#'/'<'/'>'/commas, drop empties and duplicates
// (case-insensitive) and stop before the 500-char total budget is exceeded.
function fitTags(tags) {
    const out = [];
    const seen = new Set();
    let total = 0;
    for (const raw of asArray(tags)) {
        const tag = sanitizeText(raw).replace(/^#/, "").replace(/,/g, " ").trim();
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        const sep = out.length ? 1 : 0;     // the comma YouTube counts too
        if (total + tag.length + sep > LIMITS.TAGS) continue;
        seen.add(key);
        out.push(tag);
        total += tag.length + sep;
    }
    return out;
}

// --- chapters ---------------------------------------------------------------

// Turn [{ start, text }] marks into a YouTube-valid chapter list, or [] when
// the block cannot be made valid (YouTube then ignores the whole block, so an
// invalid one must never be emitted). Pure and testable.
function normalizeChapters(marks, opts) {
    opts = opts || {};
    const minCount = opts.minCount != null ? opts.minCount : CHAPTER_MIN_COUNT;
    const minGap = opts.minGap != null ? opts.minGap : CHAPTER_MIN_GAP;

    const list = [];
    for (const m of asArray(marks)) {
        const text = sanitizeText(m && m.text).replace(/\s+/g, " ");
        const start = Number(m && m.start);
        if (!text || !Number.isFinite(start) || start < 0) continue;
        list.push({ start: start, text: text });
    }
    list.sort((a, b) => a.start - b.start);
    if (list.length < minCount) return [];

    // The first chapter must sit exactly at 0:00. Clamping (instead of
    // prepending an artificial "Intro" mark) keeps the label the reel already
    // gave that segment — the intro card — and shifts nothing else.
    list[0].start = 0;
    const kept = [list[0]];
    for (let i = 1; i < list.length; i++) {
        const prev = kept[kept.length - 1];
        if (list[i].start - prev.start < minGap) continue;   // too short: dropped
        kept.push(list[i]);
    }
    return kept.length >= minCount ? kept : [];
}

// Render the chapter block that goes into the description ("0:00 Intro"), or ""
// when the marks cannot form a valid block.
function formatChaptersBlock(marks, opts) {
    return normalizeChapters(marks, opts)
        .map((m) => timeline.fmtMmss(m.start) + " " + m.text)
        .join("\n");
}

// Parse a "MM:SS Title" / "H:MM:SS Title" chapter sidecar (the *.chapters.txt
// written by tools/assemble-video.js) back into marks, so the publisher can
// work from the assembled artefacts alone. Unparsable lines are ignored.
function parseChapterText(text) {
    const marks = [];
    for (const raw of String(text == null ? "" : text).split(/\r?\n/)) {
        const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(\S.*?)\s*$/.exec(raw);
        if (!m) continue;
        const hours = m[3] != null ? Number(m[1]) : 0;
        const mins = m[3] != null ? Number(m[2]) : Number(m[1]);
        const secs = m[3] != null ? Number(m[3]) : Number(m[2]);
        marks.push({ start: hours * 3600 + mins * 60 + secs, text: m[4] });
    }
    return marks;
}

// --- description ------------------------------------------------------------

// Compose a description from its blocks (summary -> chapters -> links ->
// hashtags), sanitised and clipped to 5000 chars without cutting a line.
function buildDescription(opts) {
    opts = opts || {};
    const parts = [];

    const summary = sanitizeText(opts.summary);
    if (summary) parts.push(summary);

    const chapters = formatChaptersBlock(opts.chapters);
    if (chapters) parts.push(chapters);

    // Links may be given as a map ({ repo: url }) or as ready-made lines.
    let links = [];
    if (opts.links && !Array.isArray(opts.links) && typeof opts.links === "object") {
        links = Object.keys(opts.links)
            .filter((k) => opts.links[k])
            .map((k) => (k === "repo" ? "Source code: " : k === "site" ? "Play in your browser: " : k + ": ") + opts.links[k]);
    } else {
        links = asArray(opts.links);
    }
    links = links.map(sanitizeText).filter(Boolean);
    if (links.length) parts.push(links.join("\n"));

    const hashtags = asArray(opts.hashtags).map(sanitizeText).filter(Boolean);
    if (hashtags.length) parts.push(hashtags.join(" "));

    let text = parts.join("\n\n");
    if (text.length > LIMITS.DESCRIPTION) {
        text = text.slice(0, LIMITS.DESCRIPTION);
        const cut = text.lastIndexOf("\n");
        if (cut > LIMITS.DESCRIPTION * 0.5) text = text.slice(0, cut);
        text = text.trim();
    }
    return text;
}

// --- playlist ids -----------------------------------------------------------

// Real YouTube playlist ids are 24 chars (UU/LL/FL: uploads/liked/favourites)
// or 34 chars (PL…: every user-created playlist). Requiring at least 22 catches
// the common mistake of pasting a truncated id out of the address bar (the
// share links in the project's HTML used to carry `PLbR5Jg6Ojbn0`) instead of
// silently publishing into the wrong — or no — playlist. "WL" (Watch later) is
// the one legitimate short id.
const PLAYLIST_ID_RE = /^(WL|[A-Za-z0-9_-]{22,64})$/;

// Accept a bare playlist id or any youtube.com URL carrying ?list=... and
// return the validated id. Throws on anything else (a truncated id pasted from
// the address bar is a common mistake).
function parsePlaylistUrl(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return "";
    let id = raw;
    if (/^https?:\/\//i.test(raw)) {
        let url;
        try {
            url = new URL(raw);
        } catch (e) {
            throw new Error("Not a valid playlist URL: " + raw);
        }
        id = url.searchParams.get("list") || "";
        if (!id) throw new Error("URL has no 'list' parameter: " + raw);
    }
    if (!PLAYLIST_ID_RE.test(id)) throw new Error("Playlist ID looks invalid: " + id);
    return id;
}

// --- CLI arguments ----------------------------------------------------------

const VALUE_FLAGS = new Set(["--select", "--limit", "--budget", "--privacy",
    "--playlist", "--port", "--caption-language", "--dir"]);
const BOOL_FLAGS = new Set(["--all", "--reel", "--no-reel", "--no-captions",
    "--force", "--resume", "--dry-run", "--yes", "--help", "--list-playlists",
    "--whoami", "--auth", "--no-playlist"]);

// Parse the publisher CLI into a plain object. Positional arguments are kept
// verbatim (they may be clip slugs, file paths or directories); values consumed
// by --flag value pairs are never mistaken for positionals.
function parseArgs(argv) {
    const args = {
        command: "publish", positionals: [], select: [], limit: 0, budget: DEFAULT_BUDGET,
        privacy: "", playlistId: "", port: 8765, captionLanguage: "", dir: "",
        all: false, reel: false, noReel: false, captions: true, playlist: true,
        force: false, resume: false, dryRun: false, yes: false, help: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        let flag = a;
        let value = null;
        const eq = a.indexOf("=");
        if (a.startsWith("--") && eq !== -1) {
            flag = a.slice(0, eq);
            value = a.slice(eq + 1);
        }
        const takeValue = () => {
            if (value !== null) return value;
            const next = argv[i + 1];
            if (next === undefined || next.startsWith("--")) {
                throw new Error("Missing value for " + flag);
            }
            i++;
            return next;
        };
        if (!flag.startsWith("--")) {
            args.positionals.push(a);
            continue;
        }
        if (!VALUE_FLAGS.has(flag) && !BOOL_FLAGS.has(flag)) {
            throw new Error("Unknown option: " + flag);
        }
        switch (flag) {
            case "--auth": args.command = "auth"; break;
            case "--whoami": args.command = "whoami"; break;
            case "--list-playlists": args.command = "list-playlists"; break;
            case "--help": args.help = true; break;
            case "--select": args.select.push(...takeValue().split(",").map((s) => s.trim()).filter(Boolean)); break;
            case "--limit": args.limit = Number(takeValue()) || 0; break;
            case "--budget": args.budget = Number(takeValue()) || 0; break;
            case "--privacy": args.privacy = takeValue(); break;
            case "--playlist": args.playlistId = takeValue(); break;
            case "--no-playlist": args.playlist = false; break;
            case "--port": args.port = Number(takeValue()) || 0; break;
            case "--caption-language": args.captionLanguage = takeValue(); break;
            case "--dir": args.dir = takeValue(); break;
            case "--all": args.all = true; break;
            case "--reel": args.reel = true; break;
            case "--no-reel": args.noReel = true; break;
            case "--no-captions": args.captions = false; break;
            case "--force": args.force = true; break;
            case "--resume": args.resume = true; break;
            case "--dry-run": args.dryRun = true; break;
            case "--yes": args.yes = true; break;
        }
    }
    return args;
}

// The featured whitelist (the default publishing set) as a plain slug list.
function featuredSlugs(meta) {
    return asArray(meta && meta.featured)
        .map((f) => (typeof f === "string" ? f : f && f.slug))
        .map((s) => String(s || "").trim())
        .filter(Boolean);
}

// --- selection --------------------------------------------------------------

function sameEntrySlug(entry, token) {
    // Both sides are normalised the same way (slashes, lowercase and the media
    // extension dropped), so `rt11`, `rt11.mp4`, `video/rt11.mp4` and
    // `video/rt11` all select the same clip.
    const norm = (s) => String(s == null ? "" : s)
        .replace(/\\/g, "/").replace(/\.(mp4|webm)$/i, "").toLowerCase();
    const t = norm(token);
    if (!t) return false;
    const slug = String(entry.slug || "").toLowerCase();
    const file = norm(entry.relFile || entry.file);
    return t === slug || t === file || file.endsWith("/" + t);
}

// Pick the videos a run should consider:
//   * explicit --select slugs / positional files+dirs win over everything;
//   * otherwise the featured whitelist from tools/youtube-meta.json;
//   * --all widens that to every clip in the manifest (opt-in, because the
//     daily quota only covers ~5 full uploads);
//   * the reel follows the same rules unless --reel/--no-reel overrides it.
// Returns { picked, missing } — `missing` lists requested slugs that are not in
// the manifest, so a typo is reported loudly instead of silently doing nothing.
function selectVideos(videos, opts) {
    opts = opts || {};
    const entries = asArray(videos);
    const reelSlug = String(opts.reelSlug || "").toLowerCase();
    const isReel = (e) => reelSlug && String(e.slug || "").toLowerCase() === reelSlug;
    const tokens = asArray(opts.select).concat(asArray(opts.dirs)).map((s) => String(s).trim()).filter(Boolean);

    const missing = [];
    let picked;
    if (tokens.length) {
        picked = [];
        for (const t of tokens) {
            const hits = entries.filter((e) => sameEntrySlug(e, t));
            if (!hits.length) missing.push(t);
            for (const h of hits) if (!picked.includes(h)) picked.push(h);
        }
    } else if (opts.all) {
        picked = entries.slice();
    } else {
        const featured = asArray(opts.featured).map((s) => String(s).trim().toLowerCase());
        picked = [];
        for (const slug of featured) {
            const hit = entries.find((e) => String(e.slug || "").toLowerCase() === slug.replace(/\.(mp4|webm)$/i, ""));
            if (!hit) {
                missing.push(slug);
                continue;
            }
            if (!picked.includes(hit)) picked.push(hit);
        }
    }

    // The reel (the long "everything in one video" cut) is never published by
    // accident: it is only included when asked for explicitly.
    if (opts.reel && reelSlug) {
        const r = entries.find(isReel);
        if (r && !picked.includes(r)) picked.push(r);
    } else if (!opts.reel) {
        picked = picked.filter((e) => !isReel(e));
    }
    return { picked: picked, missing: missing };
}

// --- quota / per-video planning --------------------------------------------

// Quota units for one action ("upload" | "captions" | "playlist" | "skip").
function unitsFor(action, opts) {
    opts = opts || {};
    const captions = opts.captions !== false;
    const playlist = opts.playlist !== false;
    switch (action) {
        case "upload":
            return QUOTA.VIDEO_INSERT + (captions ? QUOTA.CAPTION_INSERT : 0) +
                (playlist ? QUOTA.PLAYLIST_INSERT : 0);
        case "captions":
            return captions ? QUOTA.CAPTION_INSERT : 0;
        case "playlist":
            return playlist ? QUOTA.PLAYLIST_INSERT : 0;
        default:
            return 0;
    }
}

// What is still missing for one video, given its state record:
//   "upload"   — never uploaded (or --force): videos.insert + sidecars;
//   "captions" — the video exists, its SRT is not attached yet;
//   "playlist" — the video exists, it is not in the playlist yet;
//   "skip"     — nothing left to do (a re-run is free and idempotent).
function planAction(entry, record, opts) {
    opts = opts || {};
    const wantCaptions = opts.captions !== false && !!(entry && entry.srt);
    const wantPlaylist = opts.playlist !== false && !!(entry && entry.playlistId);
    if (opts.force || !record || !record.videoId) return "upload";
    if (wantCaptions && !record.captions) return "captions";
    if (wantPlaylist && !record.playlist) return "playlist";
    return "skip";
}

// True when the local MP4 changed after it was uploaded — the published video
// is then out of date (re-publish with --force) but must NOT be silently
// replaced, because a YouTube video id is referenced by the playlist already.
function isStale(entry, record) {
    if (!record || !record.videoId) return false;
    if (!record.hash || !entry || !entry.hash) return false;
    return record.hash !== entry.hash;
}

// Split the planned work into what fits today's quota and what to defer:
//   * `budget` — unit budget (default 9000 of the daily 10 000);
//   * `limit`  — max new uploads in this run;
// The deferred tail keeps its order, so `--limit 3` today and `--limit 3`
// tomorrow publish the clips in the intended sequence. Pure and testable.
function planQuota(items, opts) {
    opts = opts || {};
    const budget = opts.budget > 0 ? opts.budget : DEFAULT_BUDGET;
    const limit = opts.limit > 0 ? opts.limit : Infinity;
    const plan = [];
    const skipped = [];
    const deferred = [];
    let units = 0;
    let uploads = 0;
    let reason = "";

    for (const it of asArray(items)) {
        const action = it.action || "skip";
        if (action === "skip") {
            skipped.push(it);
            continue;
        }
        const cost = unitsFor(action, opts);
        const isUpload = action === "upload";
        if (units + cost > budget) {
            reason = "budget";
            deferred.push(it);
            continue;
        }
        if (isUpload && uploads >= limit) {
            reason = reason || "limit";
            deferred.push(it);
            continue;
        }
        if (reason) {      // already stopped: everything later is deferred too
            deferred.push(it);
            continue;
        }
        plan.push(Object.assign({}, it, { units: cost }));
        units += cost;
        if (isUpload) uploads++;
    }
    return {
        plan: plan, skipped: skipped, deferred: deferred,
        units: units, uploads: uploads, reason: reason,
        budget: budget, limit: limit
    };
}

// --- idempotency state ------------------------------------------------------

const STATE_VERSION = 1;

function emptyState() {
    return { version: STATE_VERSION, videos: {}, updatedAt: null };
}

function loadState(file) {
    try {
        const json = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!json || typeof json !== "object") return emptyState();
        return {
            version: STATE_VERSION,
            videos: (json.videos && typeof json.videos === "object") ? json.videos : {},
            updatedAt: json.updatedAt || null
        };
    } catch (e) {
        return emptyState();       // missing/corrupt state: start clean
    }
}

// Write the state atomically (tmp + rename) so an interrupted run can never
// leave a half-written file that would make the next run re-upload.
function saveState(file, state) {
    const dir = path.dirname(file);
    if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
    const payload = Object.assign({ version: STATE_VERSION, videos: {} },
        state, { updatedAt: new Date().toISOString() });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
    fs.renameSync(tmp, file);
    return payload;
}

function hashFile(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

module.exports = {
    LIMITS, QUOTA, DEFAULT_BUDGET, CHAPTER_MIN_COUNT, CHAPTER_MIN_GAP,
    DISPOSITIONS, SCOPE, STATE_VERSION,
    asArray, sanitizeText, truncateTitle, fitTags,
    normalizeChapters, formatChaptersBlock, parseChapterText, buildDescription,
    parsePlaylistUrl, PLAYLIST_ID_RE,
    parseArgs, featuredSlugs, selectVideos,
    unitsFor, planAction, isStale, planQuota,
    emptyState, loadState, saveState, hashFile
};
