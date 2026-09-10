#!/usr/bin/env node
/**
 * yaPDP — batch YouTube publisher.
 *
 * Uploads the MP4s assembled by tools/assemble-video.js (video/*.mp4) to the
 * project's YouTube playlist in one command, each with its description, its
 * generated chapters (the *.chapters.txt timestamps go into the description,
 * which is where YouTube reads chapter markers from) and its SRT subtitles
 * (captions.insert).
 *
 *   npm run youtube:auth                       one-time OAuth consent
 *   npm run youtube:publish -- --whoami        verify channel + playlist
 *   npm run youtube:publish -- --list-playlists  find the playlist id
 *   npm run youtube:publish                    publish the featured whitelist
 *   npm run youtube:publish -- --all           publish every clip in the manifest
 *   npm run youtube:publish -- rt11 xxdp       publish a hand-picked list
 *   npm run youtube:publish -- video/          publish everything in a directory
 *   npm run youtube:publish -- --dry-run --all preview the plan (no API calls)
 *
 * Publishing is deliberately idempotent: what has already been uploaded is
 * recorded in video/youtube-state.json, so re-running skips finished videos and
 * only completes the missing steps. The YouTube Data API grants 10 000 quota
 * units per day, while one upload with captions and a playlist entry costs
 * 2 050 — so a run plans a batch (`--limit`, `--budget`) and prints what is
 * left for the next day (`--resume` continues right where it stopped).
 *
 * Configuration (no secrets in git):
 *   * tools/youtube-meta.json — playlist id, default privacy, links, hashtags,
 *     the `featured` whitelist published by default, per-clip `overrides`;
 *   * .youtube-client.json or YT_CLIENT_ID/YT_CLIENT_SECRET — the OAuth
 *     desktop-app client (gitignored);
 *   * .youtube-token.json — refresh token written by `--auth` (gitignored);
 *   * YT_ACCESS_TOKEN — a ready token, used by tests/CI to skip OAuth;
 *   * YT_API_BASE / YT_UPLOAD_BASE / YT_OAUTH_BASE / YT_AUTH_BASE — endpoint
 *     overrides (the integration test points them at a fake server).
 *
 * HTTP goes through node:http/https (see httpRequest below), not fetch():
 * undici's keep-alive pool tears down asynchronously and aborts libuv on Windows
 * when this short-lived CLI calls process.exit() right after a request.
 *
 * All decision logic lives in tools/youtube-util.js (unit-tested); this file is
 * the thin network/CLI shell around it.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const readline = require("readline");
const util = require("./youtube-util.js");

const ROOT = path.resolve(__dirname, "..");
// Every workspace path is overridable through a YT_* environment variable so
// the integration test (tests/youtube-publish.test.js) can drive the publisher
// against a temp workspace and a fake API endpoint: the real video/ artefacts
// are never touched by a test run.
const envPath = (name, fallback) =>
    (process.env[name] ? path.resolve(process.env[name]) : fallback);
const VIDEO_DIR = envPath("YT_VIDEO_DIR", path.join(ROOT, "video"));
const META_FILE = envPath("YT_META_FILE", path.join(__dirname, "youtube-meta.json"));
const CLIENT_FILE = path.join(ROOT, ".youtube-client.json");
const TOKEN_FILE = path.join(ROOT, ".youtube-token.json");
const STATE_FILE = envPath("YT_STATE_FILE", path.join(VIDEO_DIR, "youtube-state.json"));
const MANIFEST_FILE = envPath("YT_MANIFEST_FILE", path.join(VIDEO_DIR, "youtube-manifest.json"));

const API_BASE = (process.env.YT_API_BASE || "https://www.googleapis.com/youtube/v3").replace(/\/+$/, "");
const UPLOAD_BASE = (process.env.YT_UPLOAD_BASE || "https://www.googleapis.com/upload/youtube/v3").replace(/\/+$/, "");
const OAUTH_BASE = (process.env.YT_OAUTH_BASE || "https://oauth2.googleapis.com").replace(/\/+$/, "");
const AUTH_BASE = (process.env.YT_AUTH_BASE || "https://accounts.google.com/o/oauth2/v2/auth").replace(/\/+$/, "");

// Resumable upload chunk: small enough for a bounded memory footprint, large
// enough to keep the request count sane.
const CHUNK = 8 * 1024 * 1024;

// --- logging ----------------------------------------------------------------

function log(msg) { console.log(msg); }
function warn(msg) { console.warn("warning: " + msg); }
function die(msg, code) {
    console.error("error: " + msg);
    process.exit(code === undefined ? 1 : code);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- config / credentials ---------------------------------------------------

function loadMeta() {
    try {
        return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    } catch (e) {
        warn("cannot read tools/youtube-meta.json (" + e.message + ") — using built-in defaults");
        return {};
    }
}

// OAuth client: environment first (CI), then .youtube-client.json — accepting
// both the flat shape and Google's downloaded {"installed":{...}} shape.
function loadClient() {
    if (process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET) {
        return { clientId: process.env.YT_CLIENT_ID, clientSecret: process.env.YT_CLIENT_SECRET };
    }
    try {
        const json = JSON.parse(fs.readFileSync(CLIENT_FILE, "utf8"));
        const node = json.installed || json.web || json;
        const clientId = node.client_id || node.clientId;
        const clientSecret = node.client_secret || node.clientSecret;
        if (clientId && clientSecret) return { clientId: clientId, clientSecret: clientSecret };
    } catch (e) { /* not configured yet — reported by the caller */ }
    return null;
}

function loadToken() {
    try {
        return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    } catch (e) {
        return null;
    }
}

// A usable bearer token: YT_ACCESS_TOKEN wins (tests/CI), then a cached access
// token, then a refresh against the stored refresh token.
async function accessToken(ctx) {
    if (process.env.YT_ACCESS_TOKEN) return process.env.YT_ACCESS_TOKEN;
    if (!ctx.client) throw new Error("No OAuth client configured — set YT_CLIENT_ID/YT_CLIENT_SECRET or create .youtube-client.json");
    const tok = ctx.token;
    if (!tok || !tok.refreshToken) {
        throw new Error("Not authorised — run `npm run youtube:auth` first");
    }
    if (tok.accessToken && tok.expiresAt > Date.now() + 60000) return tok.accessToken;
    const body = new URLSearchParams({
        client_id: ctx.client.clientId,
        client_secret: ctx.client.clientSecret,
        refresh_token: tok.refreshToken,
        grant_type: "refresh_token"
    });
    const res = await httpRequest({
        url: OAUTH_BASE + "/token",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
    });
    let json = null;
    try { json = res.text ? JSON.parse(res.text) : null; } catch (e) { /* non-JSON */ }
    if (res.status < 200 || res.status > 299) {
        throw new Error("Token refresh failed: " +
            ((json && (json.error_description || json.error)) || ("HTTP " + res.status)));
    }
    tok.accessToken = json.access_token;
    tok.expiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
    return tok.accessToken;
}

// --- HTTP -------------------------------------------------------------------

function apiError(status, json, text) {
    const err = json && json.error;
    const first = err && err.errors && err.errors[0];
    const reason = (first && first.reason) || (err && err.status) || "";
    const msg = (err && err.message) || text || ("HTTP " + status);
    const e = new Error("YouTube API " + status + (reason ? " (" + reason + ")" : "") + ": " +
        String(msg).replace(/\s+/g, " ").slice(0, 400));
    e.status = status;
    e.reason = reason;
    // Quota exhaustion must never be retried: the rest of the batch is simply
    // deferred to the next day.
    e.quota = /quota/i.test(reason) || /quota/i.test(String(msg));
    return e;
}

// A single request over node:http/https. `agent: false` keeps the socket out of
// any pool, so nothing can outlive the CLI: with fetch()/undici the process
// aborts in libuv ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
// src\win\async.c") when process.exit() races the pool teardown on Windows.
function httpRequest(opts) {
    return new Promise((resolve, reject) => {
        const url = new URL(opts.url);
        const mod = url.protocol === "https:" ? https : http;
        const req = mod.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined,
            path: url.pathname + url.search,
            method: opts.method || "GET",
            headers: opts.headers || {},
            agent: false
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({
                status: res.statusCode,
                headers: res.headers,
                text: Buffer.concat(chunks).toString("utf8")
            }));
        });
        req.on("error", reject);
        req.setTimeout(180000, () => req.destroy(new Error("request timed out: " + opts.url)));
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

async function apiFetch(url, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (opts.token) headers.Authorization = "Bearer " + opts.token;
    const res = await httpRequest({
        url: url, method: opts.method || "GET", headers: headers, body: opts.body
    });
    let json = null;
    try { json = res.text ? JSON.parse(res.text) : null; } catch (e) { /* non-JSON body */ }
    if (res.status < 200 || res.status > 299) throw apiError(res.status, json, res.text);
    if (opts.withHeaders) return { json: json || {}, headers: res.headers, status: res.status };
    return json || {};
}

// Retry transient failures (5xx, 404 while YouTube is still processing a fresh
// upload, 409), but never a quota error.
async function withRetry(fn, label) {
    const attempts = 4;
    for (let i = 1; ; i++) {
        try {
            return await fn();
        } catch (e) {
            const retryable = !e.quota && (!e.status || e.status === 404 || e.status === 409 || e.status >= 500);
            if (!retryable || i >= attempts) throw e;
            log("  " + label + " failed (" + e.message + "); retry " + i + "/" + (attempts - 1));
            await sleep(5000);
        }
    }
}

// --- OAuth (installed-app loopback flow) ------------------------------------

function cmdAuth(args) {
    const client = loadClient();
    if (!client) {
        die("No OAuth client found. Create a Google Cloud project, enable the " +
            "YouTube Data API v3, create an OAuth *Desktop app* client and either\n" +
            "  * save its JSON as " + path.relative(ROOT, CLIENT_FILE) + ", or\n" +
            "  * export YT_CLIENT_ID / YT_CLIENT_SECRET.\n" +
            "See docs/YOUTUBE.md for the step-by-step.");
    }
    const port = args.port || 8765;
    const redirectUri = "http://127.0.0.1:" + port + "/oauth2callback";
    const state = crypto.randomBytes(12).toString("hex");
    const authUrl = AUTH_BASE + "?" + new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: util.SCOPE,
        access_type: "offline",
        prompt: "consent",
        state: state
    }).toString();

    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, "http://127.0.0.1:" + port);
            if (url.pathname !== "/oauth2callback") {
                res.writeHead(404).end("not found");
                return;
            }
            const err = url.searchParams.get("error");
            const code = url.searchParams.get("code");
            const gotState = url.searchParams.get("state");
            if (err) {
                res.writeHead(400, { "Content-Type": "text/plain" }).end("Authorization failed: " + err);
                server.close();
                reject(new Error("Authorization failed: " + err));
                return;
            }
            if (gotState !== state) {
                res.writeHead(400, { "Content-Type": "text/plain" }).end("State mismatch");
                server.close();
                reject(new Error("OAuth state mismatch — repeat `npm run youtube:auth`"));
                return;
            }
            try {
                const body = new URLSearchParams({
                    code: code,
                    client_id: client.clientId,
                    client_secret: client.clientSecret,
                    redirect_uri: redirectUri,
                    grant_type: "authorization_code"
                });
                const tokenRes = await httpRequest({
                    url: OAUTH_BASE + "/token",
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: body.toString()
                });
                let json = null;
                try { json = tokenRes.text ? JSON.parse(tokenRes.text) : null; } catch (e) { /* non-JSON */ }
                if (tokenRes.status < 200 || tokenRes.status > 299 || !json) {
                    throw new Error("Token exchange failed: HTTP " + tokenRes.status + " " +
                        JSON.stringify(json || {}).slice(0, 300));
                }
                if (!json.refresh_token) {
                    throw new Error("Google returned no refresh token (consent was probably already " +
                        "granted without prompt=consent) — revoke access at " +
                        "https://myaccount.google.com/permissions and retry");
                }
                const payload = {
                    clientId: client.clientId,
                    refreshToken: json.refresh_token,
                    scope: json.scope || util.SCOPE,
                    obtainedAt: new Date().toISOString()
                };
                fs.writeFileSync(TOKEN_FILE, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
                    "<html><body style=\"font-family:sans-serif\">" +
                    "<h2>yaPDP: YouTube authorised</h2><p>You can close this tab and return to the terminal.</p>" +
                    "</body></html>");
                server.close();
                log("Authorised. Refresh token stored in " + path.relative(ROOT, TOKEN_FILE) +
                    " (gitignored). Next: npm run youtube:publish -- --whoami");
                resolve(0);
            } catch (e) {
                res.writeHead(500, { "Content-Type": "text/plain" }).end(String(e.message));
                server.close();
                reject(e);
            }
        });
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => {
            log("Open this URL in a browser and grant access:\n");
            log("  " + authUrl + "\n");
            log("Waiting for the consent redirect on " + redirectUri + " ...");
        });
        setTimeout(() => {
            server.close();
            reject(new Error("Timed out waiting for the OAuth consent"));
        }, 5 * 60 * 1000).unref();
    });
}

// --- account / playlist diagnostics ----------------------------------------

async function cmdWhoami(ctx, meta) {
    const token = await accessToken(ctx);
    const ch = await apiFetch(API_BASE + "/channels?part=snippet,contentDetails&mine=true", { token: token });
    const item = (ch.items || [])[0];
    if (!item) die("This Google account has no YouTube channel");
    log("Channel: " + item.snippet.title + "  (" + item.id + ")");
    const playlistId = util.parsePlaylistUrl(meta.playlistId || "");
    if (!playlistId) {
        log("No playlistId in tools/youtube-meta.json yet — run with --list-playlists to find it.");
        return 0;
    }
    const pl = await apiFetch(API_BASE + "/playlists?part=snippet,contentDetails&id=" + encodeURIComponent(playlistId), { token: token });
    const p = (pl.items || [])[0];
    if (!p) die("Playlist " + playlistId + " was not found on this channel (check the id)");
    log("Playlist: " + p.snippet.title + "  (" + p.id + "), videos: " +
        ((p.contentDetails && p.contentDetails.itemCount) || 0));
    return 0;
}

async function cmdListPlaylists(ctx) {
    const token = await accessToken(ctx);
    const res = await apiFetch(API_BASE + "/playlists?part=snippet,contentDetails&mine=true&maxResults=50", { token: token });
    const items = res.items || [];
    if (!items.length) {
        log("No playlists on this channel.");
        return 0;
    }
    log("Playlists (id / videos / title):");
    for (const p of items) {
        const count = (p.contentDetails && p.contentDetails.itemCount) || 0;
        log("  " + p.id + "  " + String(count).padStart(4) + "  " + p.snippet.title);
    }
    log("\nPaste the wanted id into tools/youtube-meta.json -> \"playlistId\".");
    if (res.nextPageToken) {
        log("(more playlists exist: the API returns 50 per page — " + API_BASE + "/playlists?mine=true)");
    }
    return 0;
}

// --- entries (what is on disk) ---------------------------------------------

function readIfExists(file) {
    if (!file || !fs.existsSync(file)) return null;
    try { return fs.readFileSync(file, "utf8"); } catch (e) { return null; }
}

function srtPathFor(mp4) { return mp4.replace(/\.mp4$/i, ".srt"); }
function chaptersPathFor(mp4) { return mp4.replace(/\.mp4$/i, ".chapters.txt"); }

// Build the publishable entries from video/youtube-manifest.json (written by
// tools/assemble-video.js) or, when it is missing, straight from the *.mp4 files
// on disk. tools/youtube-meta.json supplies titles/descriptions/tags overrides;
// chapters and subtitles are read from the sidecars next to the MP4.
function collectEntries(meta) {
    const overrides = (meta && meta.overrides) || {};
    const videos = [];

    let manifest = null;
    try {
        manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
    } catch (e) { /* fall back to a directory scan */ }

    if (manifest && Array.isArray(manifest.videos) && manifest.videos.length) {
        for (const v of manifest.videos) {
            const file = path.resolve(ROOT, v.relFile || v.file || "");
            videos.push({
                slug: v.slug || path.basename(file, ".mp4"),
                file: file,
                relFile: path.relative(ROOT, file).replace(/\\/g, "/"),
                title: v.title || "",
                summary: v.description || "",
                tags: v.tags || [],
                chapters: v.chapters ? path.resolve(ROOT, v.chapters) : null,
                srt: v.srt ? path.resolve(ROOT, v.srt) : null,
                durationSec: v.durationSec || null
            });
        }
    } else {
        warn("no video/youtube-manifest.json — scanning " + path.relative(ROOT, VIDEO_DIR) +
            " for *.mp4 (run `npm run video:demo` to generate the manifest)");
        let names = [];
        try { names = fs.readdirSync(VIDEO_DIR); } catch (e) { names = []; }
        for (const n of names.filter((f) => /\.mp4$/i.test(f)).sort()) {
            const file = path.join(VIDEO_DIR, n);
            videos.push({
                slug: path.basename(n, ".mp4"),
                file: file,
                relFile: path.relative(ROOT, file).replace(/\\/g, "/"),
                title: "", summary: "", tags: [],
                chapters: chaptersPathFor(file),
                srt: srtPathFor(file),
                durationSec: null
            });
        }
    }

    // Drop entries whose MP4 is gone, then apply the config overrides and the
    // placeholders used by meta.defaults.description.
    return videos.filter((v) => {
        if (fs.existsSync(v.file)) return true;
        warn("skipping " + v.relFile + " — file not found");
        return false;
    }).map((v) => {
        const o = overrides[v.slug] || {};
        // The reel carries no title/description in the manifest: those live in
        // tools/youtube-meta.json (meta.reel), which stays authoritative.
        const reel = (meta.reel && String(meta.reel.slug) === v.slug) ? meta.reel : {};
        const title = o.title || v.title || reel.title || ("yaPDP — " + v.slug);
        const summary = o.description || v.summary || reel.description ||
            String((meta.defaults && meta.defaults.description) || "")
                .replace(/\{slug\}/g, v.slug).replace(/\{title\}/g, title);
        const entry = Object.assign({}, v, {
            title: title,
            summary: summary,
            tags: o.tags || v.tags || [],
            chapters: o.chapters ? path.resolve(ROOT, o.chapters) : v.chapters,
            srt: o.srt ? path.resolve(ROOT, o.srt) : v.srt
        });
        if (entry.chapters && !fs.existsSync(entry.chapters)) entry.chapters = null;
        if (entry.srt && !fs.existsSync(entry.srt)) entry.srt = null;
        return entry;
    });
}

// --- publish ----------------------------------------------------------------

// Turn a positional argument into either a slug or a directory: a token that
// exists on disk is resolved as a path, everything else is treated as a slug.
function resolvePositionals(tokens) {
    const select = [];
    const dirs = [];
    for (const t of tokens) {
        const abs = path.resolve(ROOT, t);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) dirs.push(abs);
        else if (fs.existsSync(abs)) select.push(path.relative(ROOT, abs).replace(/\\/g, "/"));
        else select.push(t);
    }
    return { select: select, dirs: dirs };
}

function describeAction(action) {
    return action === "upload" ? "upload  " : action === "captions" ? "captions" :
        action === "playlist" ? "playlist" : "skip    ";
}

async function cmdPublish(args, ctx, meta) {
    const defaults = meta.defaults || {};
    const privacy = args.privacy || defaults.privacy || "unlisted";
    if (!util.DISPOSITIONS.includes(privacy)) {
        die("--privacy must be one of " + util.DISPOSITIONS.join(", ") + " (got '" + privacy + "')");
    }
    const playlistId = util.parsePlaylistUrl(args.playlistId || meta.playlistId || "");
    const wantCaptions = args.captions && defaults.captions !== false;
    const wantPlaylist = args.playlist && defaults.addToPlaylist !== false && !!playlistId;
    const captionLanguage = args.captionLanguage || defaults.captionLanguage || "en";

    if (!playlistId && wantPlaylist) {
        warn("no playlistId in tools/youtube-meta.json — videos will be uploaded but not added to a playlist");
    }

    const entries = collectEntries(meta);
    if (!entries.length) die("nothing to publish — no *.mp4 in " + path.relative(ROOT, VIDEO_DIR));

    const reelSlug = String((meta.reel && meta.reel.slug) || "yaPDP-demo");
    const pos = resolvePositionals(args.positionals);
    const sel = util.selectVideos(entries, {
        all: args.all,
        select: args.select.concat(pos.select),
        dirs: pos.dirs,
        featured: util.featuredSlugs(meta),
        reel: args.reel && !args.noReel,
        reelSlug: reelSlug
    });
    for (const miss of sel.missing) warn("'" + miss + "' matched no clip (not in the manifest and not on disk)");
    if (!sel.picked.length) {
        die("nothing selected. " + (util.featuredSlugs(meta).length
            ? "Check the `featured` list in tools/youtube-meta.json."
            : "Fill in `featured` in tools/youtube-meta.json, or pass --all / clip names.") +
            "\nAvailable: " + entries.map((e) => e.slug).join(", "));
    }

    // Give every entry its privacy/playlist so the planner and the state file
    // can decide what is still missing. The content hash is only computed for
    // entries that were already published (staleness check) or that are about
    // to be uploaded — hashing every MP4 on every run would read the whole
    // (possibly large) reel for nothing.
    for (const e of sel.picked) {
        e.privacy = privacy;
        e.playlistId = wantPlaylist ? playlistId : "";
    }

    const state = util.loadState(STATE_FILE);
    if (args.resume && !Object.keys(state.videos).length) {
        warn("--resume requested but " + path.relative(ROOT, STATE_FILE) +
            " is empty — running a normal batch");
    }

    const items = sel.picked.map((e) => {
        const record = state.videos[e.slug];
        let stale = false;
        if (record && record.videoId) {
            e.hash = util.hashFile(e.file);
            stale = util.isStale(e, record);
        }
        const action = util.planAction(e, record, {
            captions: wantCaptions,
            playlist: wantPlaylist,
            force: args.force
        });
        return { entry: e, action: action, record: record || {}, stale: stale };
    });

    const planner = util.planQuota(items, {
        budget: args.budget,
        limit: args.limit,
        captions: wantCaptions,
        playlist: wantPlaylist
    });

    const planned = new Set(planner.plan.map((p) => p.entry.slug));
    log("Publishing plan (privacy: " + privacy + (wantCaptions ? ", captions: " + captionLanguage : ", no captions") +
        (wantPlaylist ? ", playlist: " + playlistId : ", no playlist") + "):");
    for (const it of items) {
        const cost = util.unitsFor(it.action, { captions: wantCaptions, playlist: wantPlaylist });
        const inPlan = (it.action === "skip" || planned.has(it.entry.slug)) ? "" : "  [deferred]";
        log("  " + describeAction(it.action) + " " + it.entry.slug.padEnd(18) +
            String(cost).padStart(5) + " units  " + util.truncateTitle(it.entry.title) + inPlan);
        if (it.stale) {
            warn("  " + it.entry.slug + " changed on disk since it was published " +
                "(the published video is out of date; use --force to upload it again)");
        }
    }
    log("  " + "-".repeat(60));
    log("  " + planner.plan.length + " to do, " + planner.skipped.length + " already done, " +
        planner.deferred.length + " deferred; " + planner.units + " units of a " +
        planner.budget + "-unit budget");
    if (planner.deferred.length) {
        log("  Deferred until the quota resets (UTC midnight): " +
            planner.deferred.map((d) => d.entry.slug).join(", "));
        log("  Continue tomorrow with: npm run youtube:publish -- --resume");
    }

    if (args.dryRun) {
        log("\nDry run — nothing was sent to YouTube.");
        return 0;
    }
    if (!planner.plan.length) {
        log("\nNothing to do — every selected video is already published.");
        return 0;
    }
    if (privacy === "public" && !args.yes && !args.resume) {
        if (!process.stdin.isTTY) die("refusing to publish publicly without confirmation (pass --yes)");
        const ok = await ask("Publish " + planner.plan.length + " video(s) PUBLICLY to the channel?");
        if (!ok) {
            log("Aborted.");
            return 0;
        }
    }

    const token = await accessToken(ctx);
    const links = Object.assign({
        repo: (() => {
            try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).repository.url; }
            catch (e) { return ""; }
        })().replace(/^git\+/, "").replace(/\.git$/, ""),
        site: ""
    }, meta.links || {});
    const hashtags = meta.hashtags || [];

    let done = 0;
    const failed = [];
    for (const it of planner.plan) {
        const entry = it.entry;
        try {
            log("\n[" + (done + 1) + "/" + planner.plan.length + "] " + entry.slug + " — " + util.truncateTitle(entry.title));
            const record = state.videos[entry.slug] || {};
            const description = util.buildDescription({
                summary: entry.summary,
                chapters: util.parseChapterText(readIfExists(entry.chapters)),
                links: links,
                hashtags: hashtags
            });
            const snippetMeta = {
                title: util.truncateTitle(entry.title),
                description: description,
                tags: util.fitTags(entry.tags),
                categoryId: String(defaults.categoryId || "28")
            };

            if (it.action === "upload") {
                log("  uploading " + (fs.statSync(entry.file).size / 1048576).toFixed(1) + " MB ...");
                const res = await withRetry(() => insertVideo(entry, snippetMeta, token), "videos.insert");
                record.videoId = res.id;
                record.title = snippetMeta.title;
                record.privacy = privacy;
                record.hash = entry.hash || util.hashFile(entry.file);
                record.size = fs.statSync(entry.file).size;
                record.uploadedAt = new Date().toISOString();
                delete record.captions;
                delete record.playlist;
                state.videos[entry.slug] = record;
                util.saveState(STATE_FILE, state);
                log("  uploaded: https://youtu.be/" + res.id);
            }

            if (wantCaptions && entry.srt && !record.captions) {
                const cap = await withRetry(() => insertCaptions(entry, record.videoId, token, captionLanguage),
                    "captions.insert");
                record.captions = { id: cap.id || "", language: captionLanguage, uploadedAt: new Date().toISOString() };
                state.videos[entry.slug] = record;
                util.saveState(STATE_FILE, state);
                log("  captions attached (" + captionLanguage + ")");
            }

            if (wantPlaylist && !record.playlist) {
                await withRetry(() => addToPlaylist(playlistId, record.videoId, token), "playlistItems.insert");
                record.playlist = { id: playlistId, addedAt: new Date().toISOString() };
                state.videos[entry.slug] = record;
                util.saveState(STATE_FILE, state);
                log("  added to playlist " + playlistId);
            }

            done++;
        } catch (e) {
            if (e.quota) {
                warn(e.message);
                log("\nQuota exhausted after " + done + " video(s). The rest stays deferred in " +
                    path.relative(ROOT, STATE_FILE) + " — re-run with --resume after the quota resets.");
                failed.push({ slug: entry.slug, quota: true });
                break;
            }
            failed.push({ slug: entry.slug, error: e.message });
            warn(entry.slug + ": " + e.message);
        }
    }

    log("\nDone: " + done + " of " + planner.plan.length + " processed" +
        (failed.length ? ", " + failed.length + " failed" : "") + ".");
    for (const f of failed) {
        if (!f.quota) log("  failed: " + f.slug + " — " + f.error);
    }
    log("State: " + path.relative(ROOT, STATE_FILE));
    return 0;
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question + " [y/N] ", (answer) => {
            rl.close();
            resolve(/^y(es)?$/i.test(answer.trim()));
        });
    });
}

// --- YouTube calls ----------------------------------------------------------

// videos.insert, resumable: the metadata POST returns an upload URL and the
// file is then PUT in chunks, so a large reel never has to fit in memory twice.
async function insertVideo(entry, snippetMeta, token) {
    const size = fs.statSync(entry.file).size;
    const init = await apiFetch(UPLOAD_BASE + "/videos?uploadType=resumable&part=snippet,status", {
        method: "POST",
        token: token,
        headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": String(size),
            "X-Upload-Content-Type": "video/mp4"
        },
        body: JSON.stringify({
            snippet: snippetMeta,
            status: { privacyStatus: entry.privacy, selfDeclaredMadeForKids: false }
        }),
        withHeaders: true
    });
    const uploadUrl = init.headers["location"];
    if (!uploadUrl) throw new Error("YouTube returned no resumable upload URL");

    const fd = fs.openSync(entry.file, "r");
    try {
        let start = 0;
        let result = null;
        while (start < size) {
            const len = Math.min(CHUNK, size - start);
            const buf = Buffer.allocUnsafe(len);
            fs.readSync(fd, buf, 0, len, start);
            const res = await httpRequest({
                url: uploadUrl,
                method: "PUT",
                headers: {
                    "Content-Length": String(len),
                    "Content-Range": "bytes " + start + "-" + (start + len - 1) + "/" + size
                },
                body: buf
            });
            let json = null;
            try { json = res.text ? JSON.parse(res.text) : null; } catch (e) { /* 308 has no body */ }
            if (res.status === 308) {
                // Incomplete: the server tells us how much it already has.
                const range = res.headers["range"];
                start = range ? Number(range.split("-")[1]) + 1 : start + len;
                continue;
            }
            if (res.status < 200 || res.status > 299) throw apiError(res.status, json, res.text);
            result = json;
            start += len;
        }
        if (!result || !result.id) throw new Error("Upload finished without a video id");
        return result;
    } finally {
        fs.closeSync(fd);
    }
}

// captions.insert, multipart/related: the JSON snippet + the SRT file bytes.
// The SRT generated by tools/assemble-video.js already carries the final
// timeline timings, which is exactly what YouTube expects.
async function insertCaptions(entry, videoId, token, language) {
    const srt = fs.readFileSync(entry.srt);
    const boundary = "yapdp" + crypto.randomBytes(12).toString("hex");
    const meta = JSON.stringify({
        snippet: {
            videoId: videoId,
            language: language,
            name: "English",
            isDraft: false
        }
    });
    const head = Buffer.from(
        "--" + boundary + "\r\n" +
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        meta + "\r\n" +
        "--" + boundary + "\r\n" +
        "Content-Type: application/octet-stream\r\n\r\n");
    const tail = Buffer.from("\r\n--" + boundary + "--\r\n");
    return await apiFetch(UPLOAD_BASE + "/captions?part=snippet&uploadType=multipart", {
        method: "POST",
        token: token,
        headers: { "Content-Type": "multipart/related; boundary=" + boundary },
        body: Buffer.concat([head, srt, tail])
    });
}

async function addToPlaylist(playlistId, videoId, token) {
    return await apiFetch(API_BASE + "/playlistItems?part=snippet", {
        method: "POST",
        token: token,
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
            snippet: {
                playlistId: playlistId,
                resourceId: { kind: "youtube#video", videoId: videoId }
            }
        })
    });
}

// --- CLI --------------------------------------------------------------------

function printHelp() {
    log([
        "yaPDP batch YouTube publisher",
        "",
        "  npm run youtube:auth                        one-time OAuth consent",
        "  npm run youtube:publish -- --whoami         show channel + playlist",
        "  npm run youtube:publish -- --list-playlists list the channel playlists",
        "  npm run youtube:publish                     publish the featured whitelist",
        "  npm run youtube:publish -- --all            publish every clip",
        "  npm run youtube:publish -- rt11 xxdp        publish selected clips",
        "  npm run youtube:publish -- video/           publish a directory of clips",
        "",
        "Options:",
        "  --privacy public|unlisted|private   override the configured privacy",
        "  --playlist <id|url>                 override the playlist",
        "  --no-captions / --no-playlist       skip the SRT or the playlist step",
        "  --caption-language <code>           caption language (default en)",
        "  --limit N                           at most N new uploads in this run",
        "  --budget N                          quota-unit budget (default " + util.DEFAULT_BUDGET + ")",
        "  --reel / --no-reel                  include or exclude the full reel",
        "  --force                             upload again even if published",
        "  --resume                            continue a batch stopped by quota",
        "  --dry-run                           print the plan, send nothing",
        "  --yes                               skip the public-publish confirmation",
        "",
        "Quota: videos.insert " + util.QUOTA.VIDEO_INSERT + " + captions " + util.QUOTA.CAPTION_INSERT +
        " + playlist " + util.QUOTA.PLAYLIST_INSERT + " units per video,",
        "10 000 units per day — a full set therefore needs several runs.",
        "See docs/YOUTUBE.md."
    ].join("\n"));
    return 0;
}

(function main() {
    let args;
    try {
        args = util.parseArgs(process.argv.slice(2));
    } catch (e) {
        die(e.message);
    }
    if (args.help || (args.command === "publish" && process.argv.length <= 2)) {
        return Promise.resolve(printHelp());
    }
    const meta = loadMeta();
    if (args.command === "auth") return cmdAuth(args);
    const ctx = { client: loadClient(), token: loadToken() };
    if (args.command === "whoami") return cmdWhoami(ctx, meta);
    if (args.command === "list-playlists") return cmdListPlaylists(ctx);
    return cmdPublish(args, ctx, meta);
})().then((code) => {
    process.exit(code || 0);
}).catch((err) => {
    die(err.message, err.quota ? 0 : 1);
});
