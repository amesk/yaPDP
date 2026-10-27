#!/usr/bin/env node
/**
 * Storage lists — the page geometry must not follow the data.
 *
 * A dropped disk image keeps its file name, and a file name can be up to 255
 * characters long. It used to reach a native <select> verbatim, and a select is
 * as wide as its longest <option>, so mounting such an image stretched the whole
 * STORAGE page and pushed Unmount / Delete image / Bind off the right edge.
 *
 * Three seams are pinned here:
 *
 *   1. every Storage list shows at most NAME_LIMIT characters of a name
 *      (shortImageName), keeping the extension tail AND every marker the label
 *      appends — those markers are what the line means, not decoration;
 *   2. the untruncated label is still reachable: option.title and the
 *      #mounted-full line printed under the list;
 *   3. the CSS guards that stop a value from sizing its own column are present.
 *
 * src/dragdrop.js is a page script with no exports, so it is loaded into a VM
 * whose document is already "complete" — init() runs, but every DOM lookup
 * except the mounted-image <select>, its counter and its caption returns null.
 *
 * Run with:  node tests/storage-label-width.test.js
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "dragdrop.js");
const CSS = path.join(__dirname, "..", "css", "pdp11.css");

const ELLIPSIS = "\u2026";
const DOT = "\u00b7";
const ARROW = "\u2192";

function makeSelect() {
    const options = [];
    const select = {
        value: "",
        disabled: false,
        options: options,
        appendChild(opt) {
            options.push(opt);
            if (options.length === 1) select.value = opt.value; // the DOM does this
        },
        removeChild() {}
    };
    Object.defineProperty(select, "innerHTML", {
        get() { return ""; },
        set(v) { if (v === "") { options.length = 0; select.value = ""; } }
    });
    return select;
}

/**
 * makePage(mounted, bindings) — one copy of the page script, DOM stubs captured.
 * `mounted` is the live array DataLoader.list() reports; `bindings` is the
 * drive → url map MountMap.list() returns ({ rp1: "rp1.dsk" }).
 */
function makePage(mounted, bindings) {
    const select = makeSelect();
    const count = { textContent: "" };
    const full = { textContent: "", hidden: true };
    const document = {
        readyState: "complete",        // init() runs
        getElementById(id) {
            if (id === "mounted-select") return select;
            if (id === "mounted-count") return count;
            if (id === "mounted-full") return full;
            return null;
        },
        createElement() {
            return {
                value: "", textContent: "", title: "", hidden: false,
                setAttribute() {}, getAttribute() { return null; }
            };
        },
        addEventListener() {}
    };
    const window = { addEventListener() {} };
    window.window = window;
    window.document = document;

    const sandbox = {
        window: window,
        document: document,
        console: console,
        DataLoader: { list: () => mounted.slice() },
        MountMap: { list: () => bindings || {} },
        setInterval: () => 0,          // must not keep the process alive
        clearInterval: () => {},
        Promise: Promise, Uint8Array: Uint8Array,
        Object: Object, Array: Array, JSON: JSON, String: String, Number: Number,
        Math: Math, Error: Error
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox,
        { filename: "src/dragdrop.js" });

    return {
        select: select,
        options: select.options,
        count: count,
        full: full,
        api: sandbox.window.yapdpExportList
    };
}

// init() rebuilds the list from IndexedDB on a microtask; give it a turn.
function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

// The page announces page changes as an event; only Storage rebuilds the list.
function openStorage(page) {
    page.api.refreshMountedList();
}

function longName(chars, ext) {
    return "x".repeat(chars) + (ext || ".dsk");
}

async function run() {
    // ---- 1. the shortening rule itself ---------------------------------
    {
        const page = makePage([]);
        await settle();
        const short = page.api.shortImageName;

        assert.strictEqual(typeof short, "function",
            "shortImageName must be published on window.yapdpExportList: " +
            "it is the one place a data-dependent name length is cut to size");

        assert.strictEqual(short("rk5.dsk"), "rk5.dsk",
            "a name that fits the budget is left alone — no cosmetic churn");
        assert.strictEqual(short(null), "", "a missing url does not print null");

        const long = longName(120);
        const s = short(long);
        assert.strictEqual(s.length, 32,
            "a 127-character name renders exactly as long as the budget");
        assert.ok(s.indexOf(ELLIPSIS) !== -1, "the cut is visible as an ellipsis");
        assert.ok(s.endsWith(".dsk"),
            "the tail survives, because it carries the extension the operator " +
            "recognises (here: " + s + ")");
        assert.ok(!s.startsWith("x".repeat(32)),
            "the name is elided in the MIDDLE, not simply cut at the right edge");

        assert.strictEqual(short(longName(100, ".tap.zst"), 20).endsWith(".tap.zst"),
            true, "a two-part extension survives a tighter budget as well");
        assert.strictEqual(short(long, 20).length, 20,
            "the budget is honoured when a caller asks for its own");
        assert.strictEqual(short(long, 9).length, 9,
            "a budget below the tail length still yields an exact-width string");

        // Length must stop mattering: every name renders within the budget.
        [33, 40, 64, 128, 255].forEach((n) => {
            assert.ok(short(longName(n)).length <= 32,
                "a " + n + "-character name must not render longer than 32");
        });
    }

    // ---- 2. the mounted list: shortened text, full title, full caption --
    {
        const long = longName(150);
        const mounted = [long];
        const page = makePage(mounted);
        await settle();
        openStorage(page);

        const opt = page.options[0];
        assert.strictEqual(opt.value, long,
            "the option VALUE stays the full url: shortening is display only, " +
            "so mounting, binding and export keep working on the real image");
        assert.strictEqual(opt.textContent,
            page.api.shortImageName(long) + "  " + DOT + " nothing to export",
            "the visible label is the shortened name plus the markers, " +
            "unlike before where the whole name went into the list");
        assert.strictEqual(opt.title, long + "  " + DOT + " nothing to export",
            "the untruncated label lives in the option title (tooltip)");

        assert.strictEqual(page.full.textContent, long,
            "the full name of the selected image is printed under the list");
        assert.strictEqual(page.full.hidden, false,
            "the caption is visible while an image is selected");

        assert.ok(String(opt.textContent).length < 60,
            "no storage label may ever approach the width of the page");
    }

    // ---- 3. markers survive the shortening -----------------------------
    {
        const long = longName(150);
        const page = makePage([long], { rp1: long });
        await settle();
        openStorage(page);

        const opt = page.options[0];
        const expected = page.api.shortImageName(long) + "  " + ARROW + "  RP1" +
            "  " + DOT + " nothing to export";
        assert.strictEqual(opt.textContent, expected,
            "the drive binding marker is appended AFTER the shortened name — " +
            "shortening must never swallow it");
        assert.strictEqual(opt.title, long + "  " + ARROW + "  RP1" +
            "  " + DOT + " nothing to export",
            "and the title carries the same markers around the full name");
    }

    // ---- 4. nothing selected: the caption takes no space -----------------
    {
        const page = makePage([]);
        await settle();
        openStorage(page);

        assert.deepStrictEqual(page.options.map((o) => String(o.textContent)),
            ["--mounted images--"],
            "an empty loader still renders the empty option");
        assert.strictEqual(page.full.textContent, "",
            "with no image selected the caption is empty");
        assert.strictEqual(page.full.hidden, true,
            "and collapsed, so the form does not gain a blank line");
    }

    // ---- 5. the CSS guards that make a value unable to size its column ---
    {
        const css = fs.readFileSync(CSS, "utf8");

        assert.ok(/\.config-control\s*\{[^}]*min-width:\s*0/.test(css),
            ".config-control needs min-width: 0 — otherwise a flex item's " +
            "automatic minimum size is the widest <option> in the column");
        assert.ok(/\.config-inline\s*\{[^}]*min-width:\s*0/.test(css),
            ".config-inline needs the same guard for the control row");
        assert.ok(/\.config-tabs\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css),
            "the tab track must be minmax(0, 1fr), or the 1fr minimum is the " +
            "min-content of the widest control inside it");
        assert.ok(/#mounted-select,\s*\n#downLoadSelect\s*\{[^}]*max-width:\s*100%/.test(css),
            "the image lists need an explicit footprint capped at their column");
    }

    console.log("storage-label-width: all checks passed");
}

run().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
});
