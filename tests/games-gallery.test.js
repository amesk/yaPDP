#!/usr/bin/env node
/**
 * Games gallery — the "Play!" carousel on the React landing page.
 *
 * landing/src/data.ts declares GAME_SLIDES: one tile per game, each carrying a
 * saved machine state (states/<name>.state.zst) with the game ALREADY RUNNING,
 * a screenshot and a caption. GamesCarousel turns every slide into a card with
 * a "Play!" button; the emulator opens pdp11.html?state=<stateUrl> and applies
 * the state. A tile whose stateUrl file does not exist opens the emulator on a
 * fetch that 404s, and a tile whose screenshot is missing renders a broken
 * thumbnail. Neither shows up in code review, so both are pinned here.
 *
 * What is pinned, and why each failure is worth catching:
 *
 *   1. every slide declares the fields the carousel consumes (id, stateUrl,
 *      image, title, caption) — a slide WITHOUT a stateUrl is silently dropped
 *      by GamesCarousel's filter, so a half-filled tile is an invisible game;
 *   2. every stateUrl points at a file that exists in the repository,
 *      states/<name>.state.zst — the button would otherwise open a dead link;
 *   3. every screenshot exists in BOTH places the build reads it from —
 *      assets/images/games/ (the committed game artwork) and
 *      landing/public/assets/images/games/ (the Vite public dir the SPA ships);
 *   4. ids and state URLs are unique — two tiles playing the same state, or two
 *      tiles sharing an id, is a copy-paste that no review catches.
 *
 * No browser and no TypeScript compiler: landing/src/data.ts is read as text
 * and each slide object is parsed out of the GAME_SLIDES array — the same
 * "read the source, drive nothing" approach tests/os-gallery-run.test.js takes
 * for the guest-OS gallery. Comments are stripped first, because a comment on
 * the Adventure tile carries an apostrophe that a naive quote scanner would
 * mistake for a string.
 *
 * Run with:  node tests/games-gallery.test.js
 *
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA_PATH = path.join(ROOT, "landing", "src", "data.ts");
const GAMES_IMAGE_DIR = "assets/images/games";

// Remove //-line and /* */-block comments, respecting string literals so a
// slash inside a description is not mistaken for a comment. Line structure is
// preserved (a comment becomes its newline) so braces stay on their lines.
function stripComments(src) {
    let out = "";
    let quote = null;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            out += c;
            if (c === "\\") { if (i + 1 < src.length) out += src[++i]; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"' || c === "`") { quote = c; out += c; continue; }
        if (c === "/" && src[i + 1] === "/") {
            while (i < src.length && src[i] !== "\n") i++;
            out += "\n";
            continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            i += 2;
            while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
            i++;
            continue;
        }
        out += c;
    }
    return out;
}

// The body of a top-level `export const NAME: ... = [ ... ];` array literal,
// with string literals respected so a brace inside a description cannot end the
// scan early. Returns the text between the outermost brackets.
function arrayBody(src, name) {
    const at = src.indexOf("export const " + name);
    assert.ok(at !== -1, "landing/src/data.ts has no " + name);
    // The declaration is `... : SlideItem[] = [ ... ]`: the first "[" belongs to
    // the type annotation, so the literal begins at the "= [" instead.
    const assign = /=\s*\[/.exec(src.slice(at));
    assert.ok(assign, name + " is not an array literal");
    const open = at + assign.index + assign[0].length - 1;
    let depth = 0;
    let quote = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === "\\") { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
        if (c === "[") depth++;
        else if (c === "]") {
            depth--;
            if (depth === 0) return src.slice(open + 1, i);
        }
    }
    assert.fail(name + " is not a terminated array literal");
}

// Split an array body into its top-level { ... } object literals, again with
// strings respected. Comment-stripped input means only real code braces remain.
function objectEntries(body) {
    const entries = [];
    let depth = 0;
    let quote = null;
    let start = -1;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (quote) {
            if (c === "\\") { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
        if (c === "{") { if (depth === 0) start = i; depth++; }
        else if (c === "}") {
            depth--;
            if (depth === 0 && start !== -1) {
                entries.push(body.slice(start, i + 1));
                start = -1;
            }
        }
    }
    return entries;
}

// A field value in either quote style, the shapes data.ts uses. Absent means
// the key is missing; the caller decides whether that is an error.
function field(entry, key) {
    const single = new RegExp("\\b" + key + ":\\s*'((?:\\\\.|[^'\\\\])*)'").exec(entry);
    if (single) return single[1];
    const dbl = new RegExp("\\b" + key + ':\\s*"((?:\\\\.|[^"\\\\])*)"').exec(entry);
    return dbl ? dbl[1] : null;
}

function run() {
    const src = stripComments(fs.readFileSync(DATA_PATH, "utf8"));
    const entries = objectEntries(arrayBody(src, "GAME_SLIDES"));
    assert.ok(entries.length > 0, "GAME_SLIDES declares no tiles");

    const ids = new Set();
    const stateUrls = new Set();
    const games = [];

    for (const entry of entries) {
        const id = field(entry, "id");
        const stateUrl = field(entry, "stateUrl");
        const image = field(entry, "image");
        const title = field(entry, "title");
        const caption = field(entry, "caption");

        // --- 1. the fields the carousel consumes ---------------------------
        assert.ok(id, "a GAME_SLIDES tile has no id: " + entry);
        assert.ok(title, "GAME_SLIDES tile '" + id + "' has no title");
        assert.ok(caption, "GAME_SLIDES tile '" + id + "' has no caption");
        // GamesCarousel filters slides by !!stateUrl: a tile without one simply
        // vanishes from the gallery instead of failing, which is worse than a
        // crash — the game is on the page in the source and nowhere for the
        // visitor.
        assert.ok(stateUrl,
            "GAME_SLIDES tile '" + id + "' has no stateUrl — it would be " +
            "silently dropped by GamesCarousel's filter");
        assert.ok(image, "GAME_SLIDES tile '" + id + "' has no image");

        // --- 2. the saved state exists on disk -----------------------------
        assert.ok(stateUrl.startsWith("states/") && stateUrl.endsWith(".state.zst"),
            "GAME_SLIDES tile '" + id + "': stateUrl must be " +
            "states/<name>.state.zst, got " + stateUrl);
        assert.ok(fs.existsSync(path.join(ROOT, stateUrl)),
            "GAME_SLIDES tile '" + id + "': the state " + stateUrl +
            " does not exist — its Play button would open a dead link");

        // --- 3. the screenshot exists where the build reads it -------------
        assert.ok(image.startsWith(GAMES_IMAGE_DIR + "/"),
            "GAME_SLIDES tile '" + id + "': image must live under " +
            GAMES_IMAGE_DIR + "/, got " + image);
        assert.ok(fs.existsSync(path.join(ROOT, image)),
            "GAME_SLIDES tile '" + id + "': screenshot " + image +
            " is missing from the repository");
        const publicImage = path.join("landing", "public", image);
        assert.ok(fs.existsSync(path.join(ROOT, publicImage)),
            "GAME_SLIDES tile '" + id + "': screenshot " + image +
            " is missing from landing/public — the Vite build would render a " +
            "broken card");

        // --- 4. no two tiles play the same state ---------------------------
        assert.ok(!ids.has(id), "two GAME_SLIDES tiles share the id '" + id + "'");
        assert.ok(!stateUrls.has(stateUrl),
            "two GAME_SLIDES tiles play the same state: " + stateUrl);
        ids.add(id);
        stateUrls.add(stateUrl);
        games.push(id);
    }

    console.log("games-gallery: all tests passed (" + games.length +
        " tile(s): " + games.join(", ") + ")");
}

run();
