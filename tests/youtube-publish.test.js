#!/usr/bin/env node
/**
 * yaPDP — YouTube publisher integration test.
 *
 * Runs tools/youtube-publish.js as a child process against a fake YouTube
 * endpoint (YT_API_BASE/YT_UPLOAD_BASE) on 127.0.0.1 and asserts the wire
 * behaviour that matters:
 *   1. --dry-run sends nothing at all (not even a token refresh);
 *   2. the default run publishes the `featured` whitelist only, and the
 *      metadata carries the description built from the *.chapters.txt block,
 *      the links and the hashtags;
 *   3. --all publishes every manifest entry, attaching the SRT via
 *      captions.insert and appending the video to the playlist;
 *   4. a second run is idempotent: nothing is sent again;
 *   5. a quotaExceeded error stops the batch cleanly (exit code 0) and the
 *      state file lets --resume finish the remaining videos the next day.
 *
 * The manifest/meta/state/video paths are redirected into a temp directory via
 * the YT_* environment overrides, so the real video/ artefacts are untouched.
 * The child is launched with the ASYNCHRONOUS spawn (never spawnSync): the stub
 * server lives in this process, so blocking the event loop here would deadlock
 * the child against a server that can no longer answer. Every step prints a
 * progress line and the whole test has a watchdog, so a hang is reported with
 * the step it happened in instead of spinning forever.
 *
 * Run with:  node tests/youtube-publish.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PUBLISHER = path.join(ROOT, "tools", "youtube-publish.js");
const PLAYLIST = "PL0123456789abcdefghijklmnopqrstuv";   // 34 chars, like a real playlist
const CHILD_TIMEOUT_MS = 60000;

let currentStep = "startup";
function step(name) {
    currentStep = name;
    console.log("[step] " + name);
}

// A hung child (or a stub that never answers) must fail loudly: the watchdog
// names the step it was stuck in.
const watchdog = setTimeout(() => {
    console.error("HUNG in step: " + currentStep);
    process.exit(2);
}, 180000);
watchdog.unref();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-ytpub-"));
const videoDir = path.join(tmp, "video");
fs.mkdirSync(videoDir, { recursive: true });
const stateFile = path.join(videoDir, "youtube-state.json");
const manifestFile = path.join(videoDir, "youtube-manifest.json");
const metaFile = path.join(tmp, "youtube-meta.json");

// Minimal artefacts: the publisher only reads their bytes, so a 64 KB blob per
// "MP4" exercises the resumable-upload path without real videos.
function makeClip(slug) {
    const mp4 = path.join(videoDir, slug + ".mp4");
    fs.writeFileSync(mp4, Buffer.alloc(64 * 1024, 7));
    const srt = path.join(videoDir, slug + ".srt");
    fs.writeFileSync(srt, "1\n00:00:00,000 --> 00:00:02,000\nHello from " + slug + "\n");
    const chapters = path.join(videoDir, slug + ".chapters.txt");
    fs.writeFileSync(chapters, "0:00 Intro\n0:20 Booting\n0:45 Done\n");
    return { slug: slug, mp4: mp4, srt: srt, chapters: chapters };
}

function manifestEntry(clip, title) {
    return {
        slug: clip.slug,
        relFile: clip.mp4,
        title: title,
        description: "Clip " + clip.slug + " on yaPDP.",
        tags: ["PDP-11", "emulator"],
        chapters: clip.chapters,
        srt: clip.srt,
        durationSec: 60
    };
}

const clipA = makeClip("clip-a");
const clipB = makeClip("clip-b");
const reel = makeClip("yaPDP-demo");
fs.writeFileSync(manifestFile, JSON.stringify({
    generated: new Date().toISOString(),
    videos: [
        // The reel carries no title/description on purpose: meta.reel supplies them.
        { slug: "yaPDP-demo", relFile: reel.mp4, title: "", description: "", tags: [],
          chapters: reel.chapters, srt: reel.srt, durationSec: 120 },
        manifestEntry(clipA, "Clip A — yaPDP PDP-11/70 emulator"),
        manifestEntry(clipB, "Clip B — yaPDP PDP-11/70 emulator")
    ]
}, null, 2) + "\n");

fs.writeFileSync(metaFile, JSON.stringify({
    playlistId: PLAYLIST,
    defaults: { privacy: "unlisted", captions: true, captionLanguage: "en", categoryId: "28", addToPlaylist: true },
    links: { repo: "https://example.invalid/repo", site: "" },
    hashtags: ["#PDP11"],
    featured: ["clip-a"],
    reel: { slug: "yaPDP-demo", title: "yaPDP reel", description: "Everything in one reel." },
    overrides: {}
}, null, 2) + "\n");

// --- fake YouTube -----------------------------------------------------------

const requests = [];
let uploads = 0;           // videos.insert metadata calls seen
let quotaAfter = Infinity; // fail videos.insert once this many were accepted
let base = "";

function startServer() {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            requests.push({ method: req.method, url: req.url, headers: req.headers, body: body.toString("utf8") });
            const send = (code, obj, headers) => {
                res.writeHead(code, Object.assign({ "Content-Type": "application/json" }, headers || {}));
                res.end(obj === null ? "" : JSON.stringify(obj));
            };
            if (req.method === "POST" && req.url.startsWith("/upload/youtube/v3/videos")) {
                uploads++;
                if (uploads > quotaAfter) {
                    send(403, { error: { code: 403, message: "Quota exceeded.", errors: [{ reason: "quotaExceeded" }] } });
                    return;
                }
                send(200, {}, { Location: base + "/upload-session/" + uploads });
                return;
            }
            if (req.method === "PUT" && req.url.startsWith("/upload-session/")) {
                send(200, { id: "vid-" + req.url.split("/").pop(), snippet: {}, status: { privacyStatus: "unlisted" } });
                return;
            }
            if (req.url.startsWith("/upload/youtube/v3/captions")) { send(200, { id: "cap-1" }); return; }
            if (req.url.startsWith("/youtube/v3/playlistItems")) { send(200, { id: "pli-1" }); return; }
            if (req.url.startsWith("/youtube/v3/playlists")) {
                send(200, { items: [{ id: PLAYLIST, snippet: { title: "yaPDP demos" }, contentDetails: { itemCount: 3 } }] });
                return;
            }
            if (req.url.startsWith("/youtube/v3/channels")) {
                send(200, { items: [{ id: "chan-1", snippet: { title: "yaPDP" } }] });
                return;
            }
            send(404, { error: { code: 404, message: "not found: " + req.url } });
        });
    });
    server.on("error", (e) => {
        console.error("stub server error: " + e.message);
        process.exit(1);
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function runPublisher(args) {
    requests.length = 0;
    const env = Object.assign({}, process.env, {
        YT_API_BASE: base + "/youtube/v3",
        YT_UPLOAD_BASE: base + "/upload/youtube/v3",
        YT_OAUTH_BASE: base,
        YT_AUTH_BASE: base + "/auth",
        YT_ACCESS_TOKEN: "test-token",
        YT_VIDEO_DIR: videoDir,
        YT_META_FILE: metaFile,
        YT_STATE_FILE: stateFile,
        YT_MANIFEST_FILE: manifestFile
    });
    delete env.YT_CLIENT_ID;
    delete env.YT_CLIENT_SECRET;
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [PUBLISHER].concat(args), { cwd: ROOT, env: env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });
        const killer = setTimeout(() => {
            stderr += "[test] killed after " + CHILD_TIMEOUT_MS + " ms";

            child.kill();
        }, CHILD_TIMEOUT_MS);
        child.on("exit", (code) => {
            clearTimeout(killer);
            resolve({ status: code, stdout: stdout, stderr: stderr });
        });
    });
}

function posts(kind) {
    return requests.filter((r) => r.method === "POST" && r.url.startsWith(kind));
}

function state() {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function resetState() {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
}

// --- tests ------------------------------------------------------------------

startServer().then(async (server) => {
    base = "http://127.0.0.1:" + server.address().port;
    console.log("stub YouTube at " + base);

    // 1. --dry-run must not touch the network.
    step("dry-run sends nothing");
    let res = await runPublisher(["--all", "--dry-run"]);
    assert.strictEqual(res.status, 0, "--dry-run exits cleanly: " + res.stderr);
    assert.strictEqual(requests.length, 0, "--dry-run sends no request at all");
    assert.ok(/Dry run/.test(res.stdout), "--dry-run says so");

    // 2. Default run = the featured whitelist (clip-a), with the full metadata.
    step("default run publishes the featured clip");
    res = await runPublisher(["--yes"]);
    assert.strictEqual(res.status, 0, "publish exits cleanly: " + res.stderr);
    assert.strictEqual(posts("/upload/youtube/v3/videos").length, 1, "only the featured clip is uploaded");
    const meta = JSON.parse(posts("/upload/youtube/v3/videos")[0].body);
    assert.strictEqual(meta.snippet.title, "Clip A — yaPDP PDP-11/70 emulator");
    assert.ok(meta.snippet.description.includes("Clip clip-a on yaPDP."), "the summary is in the description");
    assert.ok(meta.snippet.description.includes("0:00 Intro"), "the chapter block is in the description");
    assert.ok(meta.snippet.description.includes("Source code: https://example.invalid/repo"), "links are appended");
    assert.ok(meta.snippet.description.includes("#PDP11"), "hashtags are appended");
    assert.deepStrictEqual(meta.snippet.tags, ["PDP-11", "emulator"]);
    assert.strictEqual(meta.status.privacyStatus, "unlisted");
    assert.strictEqual(posts("/upload/youtube/v3/captions").length, 1, "the SRT is attached");
    assert.ok(posts("/upload/youtube/v3/captions")[0].body.includes("Hello from clip-a"),
        "the SRT content is sent to captions.insert");
    assert.strictEqual(posts("/youtube/v3/playlistItems").length, 1, "the video joins the playlist");
    assert.ok(posts("/youtube/v3/playlistItems")[0].body.includes(PLAYLIST));
    assert.strictEqual(state().videos["clip-a"].videoId, "vid-1");
    assert.ok(state().videos["clip-a"].captions && state().videos["clip-a"].playlist,
        "both sidecar steps are recorded in the state");

    // 3. Re-running is idempotent: no request at all.
    step("a second run is a no-op");
    res = await runPublisher(["--yes"]);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(requests.length, 0, "a second run sends nothing");
    assert.ok(/Nothing to do/.test(res.stdout), "and reports that nothing is left");

    // 4. --all publishes every clip; the long reel stays opt-in (--reel), so a
    //    routine "publish everything" never re-uploads the 10-minute cut.
    step("--all publishes every clip, the reel needs --reel");
    resetState();
    res = await runPublisher(["--all"]);
    assert.strictEqual(res.status, 0, "--all exits cleanly: " + res.stderr);
    assert.strictEqual(posts("/upload/youtube/v3/videos").length, 2, "--all publishes the clips only");
    assert.strictEqual(posts("/upload/youtube/v3/captions").length, 2);
    assert.strictEqual(posts("/youtube/v3/playlistItems").length, 2);
    assert.strictEqual(Object.keys(state().videos).length, 2);

    step("--all --reel adds the reel");
    resetState();
    res = await runPublisher(["--all", "--reel"]);
    assert.strictEqual(res.status, 0, "--all --reel exits cleanly: " + res.stderr);
    assert.strictEqual(posts("/upload/youtube/v3/videos").length, 3, "every manifest entry is uploaded");
    assert.strictEqual(posts("/upload/youtube/v3/captions").length, 3);
    assert.strictEqual(posts("/youtube/v3/playlistItems").length, 3);
    const reelMeta = JSON.parse(posts("/upload/youtube/v3/videos")[0].body);
    assert.strictEqual(reelMeta.snippet.title, "yaPDP reel", "meta.reel titles the reel");
    assert.ok(reelMeta.snippet.description.startsWith("Everything in one reel."),
        "meta.reel describes the reel");
    assert.strictEqual(Object.keys(state().videos).length, 3);

    // 5. Quota exhaustion stops cleanly and --resume finishes the batch.
    step("a quota stop is graceful");
    resetState();
    uploads = 0;
    quotaAfter = 1;
    res = await runPublisher(["--all", "--reel", "--resume"]);
    assert.strictEqual(res.status, 0, "a quota stop is not a failure exit code");
    assert.ok(/Quota exhausted/.test(res.stdout), "the quota stop is reported");
    assert.strictEqual(Object.keys(state().videos).length, 1, "the accepted upload is recorded");

    step("--resume finishes the batch");
    uploads = 0;
    quotaAfter = Infinity;
    res = await runPublisher(["--all", "--reel", "--resume"]);
    assert.strictEqual(res.status, 0, "the resumed batch exits cleanly: " + res.stderr);
    assert.strictEqual(posts("/upload/youtube/v3/videos").length, 2,
        "the resumed run only uploads what is missing");
    assert.strictEqual(Object.keys(state().videos).length, 3, "the batch is complete after the resume");

    // 6. --whoami resolves the channel and the configured playlist.
    step("--whoami resolves the channel and playlist");
    res = await runPublisher(["--whoami"]);
    assert.strictEqual(res.status, 0, "--whoami exits cleanly: " + res.stderr);
    assert.ok(/yaPDP demos/.test(res.stdout), "--whoami reports the playlist");

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log("youtube-publish integration tests passed");
    // Explicit exit: the stub server and the child's stdio must never be able to
    // hold the test runner open.
    process.exit(0);
}).catch((err) => {
    console.error("failed in step: " + currentStep);
    console.error((err && err.stack) || err);
    process.exit(1);
});
