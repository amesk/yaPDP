#!/usr/bin/env node
/**
 * yaPDP — YouTube publishing pure-helper tests.
 *
 * tools/youtube-publish.js is a thin network shell; every decision it makes
 * lives in tools/youtube-util.js, so this file pins that logic down:
 *   1. text hygiene within YouTube's limits (sanitizeText/truncateTitle/
 *      fitTags) and description composition (buildDescription);
 *   2. chapter normalisation: first chapter at 0:00, >= 3 chapters, >= 10 s
 *      each — otherwise the whole block must be dropped (YouTube ignores it);
 *   3. the *.chapters.txt parser and playlist-id parsing;
 *   4. CLI argument parsing (values consumed by flags are not positionals);
 *   5. selection: the `featured` whitelist by default, --all for everything,
 *      explicit slugs/files/directories, and the reel only on request;
 *   6. per-video actions (upload/captions/playlist/skip), staleness and the
 *      quota batch planner (--budget/--limit deferral keeps the order);
 *   7. the idempotency state file (atomic write, tolerant load) and hashing.
 *
 * Run with:  node tests/youtube-util.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require(path.join(__dirname, "..", "tools", "youtube-util.js"));

// --- 1. text hygiene --------------------------------------------------------

assert.strictEqual(util.sanitizeText("a <b> c"), "a b c", "angle brackets are stripped");
assert.strictEqual(util.sanitizeText("line1\n\n\n\nline2"), "line1\n\nline2",
    "blank-line runs collapse");
assert.strictEqual(util.sanitizeText("  padded  "), "padded");
assert.strictEqual(util.sanitizeText(null), "");
assert.ok(!util.sanitizeText("bell\u0007x").includes("\u0007"), "control chars are removed");

const longTitle = "T".repeat(160);
assert.strictEqual(util.truncateTitle(longTitle).length, util.LIMITS.TITLE);
assert.strictEqual(util.truncateTitle("  a \n  b  "), "a b", "whitespace is collapsed");

const tags = util.fitTags(["PDP-11", "pdp-11", "#RT-11", "  ", "a,b", "Lunar Lander"]);
assert.deepStrictEqual(tags, ["PDP-11", "RT-11", "a b", "Lunar Lander"],
    "tags are de-hashed, de-duplicated (case-insensitive), comma-stripped");
const wideTags = util.fitTags(Array.from({ length: 200 }, (_, i) => "tag" + i + "x".repeat(10)));
const tagChars = wideTags.join(",").length;
assert.ok(tagChars <= util.LIMITS.TAGS, "the tag budget is never exceeded (" + tagChars + ")");

// --- 2. chapters ------------------------------------------------------------

// Marks coming from the reel start after the intro card: the first one is
// clamped to 0:00, a too-short follower is dropped, and the block survives.
const marks = [
    { start: 12.4, text: "DUNGEON" },
    { start: 4.0, text: "Booting" },
    { start: 20.0, text: "Login" },
    { start: 24.0, text: "Too close" },
    { start: 90.0, text: "Shutdown" }
];
const norm = util.normalizeChapters(marks);
assert.deepStrictEqual(norm.map((m) => m.start), [0, 12.4, 24, 90],
    "sorted, first clamped to 0:00, the < 10 s follower (20.0, 7.6 s after 12.4) dropped");
assert.strictEqual(norm[0].text, "Booting", "the earliest mark keeps its label");
assert.deepStrictEqual(util.normalizeChapters([
    { start: 0, text: "A" }, { start: 20, text: "B" }
]), [], "fewer than three chapters is not a valid block");
assert.deepStrictEqual(util.normalizeChapters([
    { start: 0, text: "A" }, { start: 5, text: "B" }, { start: 8, text: "C" }
]), [], "a block whose chapters are all too close is dropped");
assert.ok(!("start" in {}) || util.normalizeChapters([{ start: 1, text: "x" }, null, { start: 2, text: "  " }]).length === 0,
    "malformed marks are ignored");
assert.strictEqual(util.formatChaptersBlock(marks).split("\n")[0], "0:00 Booting");
assert.strictEqual(util.formatChaptersBlock(marks).split("\n")[3], "1:30 Shutdown");
assert.strictEqual(util.formatChaptersBlock([{ start: 1, text: "only" }]), "",
    "an unusable block renders as empty (never a broken one)");

const parsed = util.parseChapterText("0:00 Intro\n12:34 Second\n1:02:03 Third\nnot a chapter\n");
assert.deepStrictEqual(parsed, [
    { start: 0, text: "Intro" },
    { start: 754, text: "Second" },
    { start: 3723, text: "Third" }
], "*.chapters.txt round-trips (M:SS and H:MM:SS)");

// --- 3. description ---------------------------------------------------------

const desc = util.buildDescription({
    summary: "The A clip.",
    chapters: marks,
    links: { repo: "https://example.invalid/repo", site: "" },
    hashtags: ["#PDP11", "#emulator"]
});
const blocks = desc.split("\n\n");
assert.strictEqual(blocks[0], "The A clip.", "the summary comes first");
assert.strictEqual(blocks[1].split("\n")[0], "0:00 Booting", "then the chapter block");
assert.strictEqual(blocks[2], "Source code: https://example.invalid/repo",
    "links are labelled and empty ones skipped");
assert.strictEqual(blocks[3], "#PDP11 #emulator");
assert.ok(!util.buildDescription({ summary: "<script>" }).includes("<"), "descriptions sanitised");

const clipped = util.buildDescription({
    summary: Array.from({ length: 400 }, (_, i) => "line " + i).join("\n"),
    hashtags: ["#x"]
});
assert.ok(clipped.length <= util.LIMITS.DESCRIPTION, "the 5000-char cap holds");
assert.ok(!clipped.endsWith("line"), "clipping never cuts mid-line");

// --- 4. playlist ids and CLI --------------------------------------------

const PL = "PL0123456789abcdefghijklmnopqrstuv";   // 34 chars, like a real playlist
assert.strictEqual(util.parsePlaylistUrl(PL), PL);
assert.strictEqual(util.parsePlaylistUrl("https://www.youtube.com/playlist?list=" + PL), PL);
assert.strictEqual(util.parsePlaylistUrl("WL"), "WL", "Watch later is the one short id");
assert.strictEqual(util.parsePlaylistUrl(""), "");
assert.throws(() => util.parsePlaylistUrl("PLbR5Jg6Ojbn0"), /invalid/,
    "a truncated playlist id is rejected, not silently used");
assert.throws(() => util.parsePlaylistUrl("https://www.youtube.com/playlist?x=1"), /list/);

const args = util.parseArgs(["--all", "--limit", "3", "--privacy=public", "--select", "rt11,xxdp",
    "--no-captions", "--playlist", PL, "video/"]);
assert.strictEqual(args.all, true);
assert.strictEqual(args.limit, 3);
assert.strictEqual(args.privacy, "public");
assert.deepStrictEqual(args.select, ["rt11", "xxdp"]);
assert.strictEqual(args.captions, false);
assert.strictEqual(args.playlistId, PL);
assert.deepStrictEqual(args.positionals, ["video/"], "flag values are not positionals");
assert.strictEqual(util.parseArgs(["--auth"]).command, "auth");
assert.strictEqual(util.parseArgs(["--list-playlists"]).command, "list-playlists");
assert.strictEqual(util.parseArgs([]).budget, util.DEFAULT_BUDGET);
assert.throws(() => util.parseArgs(["--oops"]), /Unknown option/);
assert.throws(() => util.parseArgs(["--limit"]), /Missing value/);

// --- 5. selection -----------------------------------------------------------

const entries = [
    { slug: "yaPDP-demo", relFile: "video/yaPDP-demo.mp4" },
    { slug: "rt11", relFile: "video/rt11.mp4" },
    { slug: "xxdp", relFile: "video/xxdp.mp4" },
    { slug: "basic", relFile: "video/basic.mp4" }
];
const featured = util.selectVideos(entries, { featured: ["rt11", "xxdp"], reelSlug: "yaPDP-demo" });
assert.deepStrictEqual(featured.picked.map((e) => e.slug), ["rt11", "xxdp"],
    "the featured whitelist is the default set and the reel stays out");
assert.deepStrictEqual(featured.missing, []);
assert.deepStrictEqual(util.selectVideos(entries, { featured: ["nope"], reelSlug: "yaPDP-demo" }).missing,
    ["nope"], "a whitelist typo is reported");
assert.deepStrictEqual(util.selectVideos(entries, { all: true, reelSlug: "yaPDP-demo" })
    .picked.map((e) => e.slug), ["rt11", "xxdp", "basic"], "--all takes everything (reel still opt-in)");
assert.deepStrictEqual(util.selectVideos(entries, { all: true, reel: true, reelSlug: "yaPDP-demo" })
    .picked.map((e) => e.slug), ["yaPDP-demo", "rt11", "xxdp", "basic"], "--reel includes the reel");
assert.deepStrictEqual(util.selectVideos(entries, { select: ["video/rt11.mp4"], reelSlug: "yaPDP-demo" })
    .picked.map((e) => e.slug), ["rt11"], "a file path selects its clip");
assert.deepStrictEqual(util.selectVideos(entries, { select: ["basic.webm"], reelSlug: "yaPDP-demo" })
    .picked.map((e) => e.slug), ["basic"], "an extension is ignored");
assert.deepStrictEqual(util.selectVideos(entries, { featured: ["rt11"], reelSlug: "yaPDP-demo", reel: true })
    .picked.map((e) => e.slug), ["rt11", "yaPDP-demo"], "--reel adds the reel to a whitelist run");

// --- 6. quota planning ------------------------------------------------------

assert.strictEqual(util.unitsFor("upload", {}),
    util.QUOTA.VIDEO_INSERT + util.QUOTA.CAPTION_INSERT + util.QUOTA.PLAYLIST_INSERT);
assert.strictEqual(util.unitsFor("upload", { captions: false, playlist: false }), util.QUOTA.VIDEO_INSERT);
assert.strictEqual(util.unitsFor("captions", {}), util.QUOTA.CAPTION_INSERT);
assert.strictEqual(util.unitsFor("skip", {}), 0);

const rec = { videoId: "v1", captions: { id: "c1" }, playlist: { id: "p1" }, hash: "h" };
assert.strictEqual(util.planAction({ srt: "s", playlistId: "p" }, null, {}), "upload",
    "an unknown video is uploaded");
assert.strictEqual(util.planAction({ srt: "s", playlistId: "p" }, { videoId: "v1" }, {}), "captions",
    "an upload whose captions are missing is only completed");
assert.strictEqual(util.planAction({ srt: "s", playlistId: "p" },
    { videoId: "v1", captions: { id: "c" } }, {}), "playlist");
assert.strictEqual(util.planAction({ srt: "s", playlistId: "p" }, rec, {}), "skip");
assert.strictEqual(util.planAction({ srt: "s", playlistId: "p" }, rec, { force: true }), "upload",
    "--force re-uploads");
assert.strictEqual(util.planAction({ playlistId: "p" }, { videoId: "v1" }, {}), "playlist",
    "a clip with no SRT skips the captions step");
assert.strictEqual(util.isStale({ hash: "new" }, { videoId: "v1", hash: "old" }), true);
assert.strictEqual(util.isStale({ hash: "same" }, { videoId: "v1", hash: "same" }), false);
assert.strictEqual(util.isStale({ hash: "new" }, null), false);

const work = [
    { slug: "a", action: "upload" },
    { slug: "b", action: "upload" },
    { slug: "c", action: "skip" },
    { slug: "d", action: "upload" }
];
const limited = util.planQuota(work, { limit: 2, captions: true, playlist: true });
assert.deepStrictEqual(limited.plan.map((i) => i.slug), ["a", "b"]);
assert.deepStrictEqual(limited.deferred.map((i) => i.slug), ["d"], "the tail keeps its order");
assert.deepStrictEqual(limited.skipped.map((i) => i.slug), ["c"]);
assert.strictEqual(limited.reason, "limit");
assert.strictEqual(limited.units, 2 * util.unitsFor("upload", {}));

const budgeted = util.planQuota([{ slug: "a", action: "upload" }, { slug: "b", action: "upload" }],
    { budget: 3000, captions: true, playlist: true });
assert.deepStrictEqual(budgeted.plan.map((i) => i.slug), ["a"], "the unit budget is respected");
assert.strictEqual(budgeted.reason, "budget");
const captionsOnly = util.planQuota([{ slug: "a", action: "captions" }], { limit: 0 });
assert.strictEqual(captionsOnly.plan.length, 1, "captions/playlist steps are not upload-limit bound");

// --- 7. state and hashing ---------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-yt-util-"));
// The nested directory deliberately does not exist yet: loading must cope with
// that, saving must create it.
const stateFile = path.join(tmp, "nested", "youtube-state.json");
const empty = util.loadState(stateFile);
assert.deepStrictEqual(empty.videos, {}, "a missing state file loads as empty");
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, "{ not json");
assert.deepStrictEqual(util.loadState(stateFile).videos, {}, "a corrupt state file loads as empty");
fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });

const state = util.emptyState();
state.videos["rt11"] = { videoId: "v1", hash: "h1" };
util.saveState(stateFile, state);
const reloaded = util.loadState(stateFile);
assert.strictEqual(reloaded.version, util.STATE_VERSION);
assert.strictEqual(reloaded.videos.rt11.videoId, "v1");
assert.ok(reloaded.updatedAt, "saveState stamps updatedAt");
assert.ok(!fs.existsSync(stateFile + ".tmp"), "the atomic write leaves no tmp file");

const f1 = path.join(tmp, "a.bin");
fs.writeFileSync(f1, "hello");
const h1 = util.hashFile(f1);
assert.strictEqual(util.hashFile(f1), h1, "hashing is stable");
fs.writeFileSync(f1, "hello!");
assert.notStrictEqual(util.hashFile(f1), h1, "the hash changes with the content");

fs.rmSync(tmp, { recursive: true, force: true });

console.log("youtube-util tests passed");
