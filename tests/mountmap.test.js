#!/usr/bin/env node
/**
 * MountMap modular tests.
 *
 * Loads the real src/mountmap.js in an isolated VM context (the same pattern
 * the other storage-layer tests use) and exercises the drive → image-url
 * registry: template fallback, overrides, case-insensitive keys, unmount
 * cleanup and persistence round-trips.
 *
 * Run with:  node tests/mountmap.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SRC = path.join(__dirname, "..", "src", "mountmap.js");

// Load the production module in a clean context (no window / no module), so
// `var MountMap` becomes a property of the sandbox — exactly like the browser
// global the controller code reads.
function loadMountMap() {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);
    return sandbox.MountMap;
}

// Minimal localStorage stand-in (getItem/setItem/removeItem).
function fakeStorage(initial) {
    const map = new Map(Object.entries(initial || {}));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
        _dump: () => Object.fromEntries(map)
    };
}

// Normalize a value built inside the VM context to a plain object of THIS
// realm — assert.deepStrictEqual compares prototypes, and the sandbox has its
// own Object prototype.
function plain(v) {
    return JSON.parse(JSON.stringify(v));
}

let passed = 0;
let failures = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log("  ok  " + name);
    } catch (err) {
        failures++;
        console.error("FAIL  " + name);
        console.error("      " + (err && err.message));
    }
}

const MountMap = loadMountMap();

test("urlFor falls back to the historical template", () => {
    MountMap.clear();
    assert.strictEqual(MountMap.urlFor("rk", 2, ".dsk"), "rk2.dsk");
    assert.strictEqual(MountMap.urlFor("tm", 0, ".tap"), "tm0.tap");
    // Missing suffix defaults to .dsk (disk controllers).
    assert.strictEqual(MountMap.urlFor("rl", 3), "rl3.dsk");
});

test("set overrides the template for one drive only", () => {
    MountMap.clear();
    MountMap.set("rl0", "mybsd.dsk");
    assert.strictEqual(MountMap.urlFor("rl", 0, ".dsk"), "mybsd.dsk");
    assert.strictEqual(MountMap.urlFor("rl", 1, ".dsk"), "rl1.dsk");
});

test("get / has / remove", () => {
    MountMap.clear();
    MountMap.set("rk1", "foo.dsk");
    assert.ok(MountMap.has("rk1"));
    assert.strictEqual(MountMap.get("rk1"), "foo.dsk");
    assert.strictEqual(MountMap.remove("rk1"), true);
    assert.ok(!MountMap.has("rk1"));
    assert.strictEqual(MountMap.urlFor("rk", 1, ".dsk"), "rk1.dsk");
});

test("keys are case-insensitive", () => {
    MountMap.clear();
    MountMap.set("RL2", "bar.dsk");
    assert.strictEqual(MountMap.get("rl2"), "bar.dsk");
    assert.strictEqual(MountMap.urlFor("RL", 2, ".dsk"), "bar.dsk");
});

test("removeByUrl drops every drive bound to an image", () => {
    MountMap.clear();
    MountMap.set("rl0", "shared.dsk");
    MountMap.set("rl1", "shared.dsk");
    MountMap.set("rk0", "other.dsk");
    MountMap.removeByUrl("shared.dsk");
    assert.deepStrictEqual(plain(MountMap.list()), { rk0: "other.dsk" });
});

test("load / save / reset round-trip through storage", () => {
    MountMap.clear();
    const storage = fakeStorage();
    MountMap.set("rp1", "bsd211.dsk");
    MountMap.save(storage);
    MountMap.clear();
    assert.strictEqual(MountMap.get("rp1"), undefined);
    MountMap.load(storage);
    assert.strictEqual(MountMap.get("rp1"), "bsd211.dsk");
    MountMap.reset(storage);
    assert.strictEqual(MountMap.get("rp1"), undefined);
    assert.deepStrictEqual(storage._dump(), {});
});

test("load clears first and ignores corrupt JSON", () => {
    MountMap.clear();
    MountMap.set("rk0", "keep.dsk");
    const storage = fakeStorage({ [MountMap.STORAGE_KEY]: "{not json" });
    MountMap.load(storage);
    assert.deepStrictEqual(plain(MountMap.list()), {});
});

test("set ignores empty keys and urls", () => {
    MountMap.clear();
    MountMap.set("", "x.dsk");
    MountMap.set("rk0", "");
    assert.deepStrictEqual(plain(MountMap.list()), {});
});

MountMap.clear();
console.log("\n" + passed + " passed, " + failures + " failed");
process.exit(failures ? 1 : 0);
