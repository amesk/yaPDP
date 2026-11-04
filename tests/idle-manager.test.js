#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { IdleManager } = require("../src/idle-manager.js");

assert.deepStrictEqual(
    IdleManager.parseOptions("?idle-timeout=90000&idle-redirect=/attract.html"),
    { timeout: 90000, redirect: "/attract.html" }
);
assert.strictEqual(IdleManager.parseOptions("?idle-timeout=0&idle-redirect=/a"), null);
assert.strictEqual(IdleManager.parseOptions("?idle-timeout=abc&idle-redirect=/a"), null);
assert.strictEqual(IdleManager.parseOptions("?idle-timeout=100"), null);
assert.strictEqual(IdleManager.parseOptions("?idle-redirect=/a"), null);
assert.strictEqual(
    IdleManager.resolveRedirect("attract.html", "https://museum.example/yapdp/pdp11.html"),
    "https://museum.example/yapdp/attract.html"
);
assert.strictEqual(
    IdleManager.resolveRedirect("https://museum.example/attract.html", "https://amesk.github.io/yaPDP/pdp11.html"),
    "https://museum.example/attract.html"
);
assert.throws(
    () => IdleManager.resolveRedirect("javascript:alert(1)", "https://example.com/pdp11.html"),
    /Unsupported idle redirect protocol/
);
assert.throws(
    () => IdleManager.resolveRedirect("file:///D:/Museum/attract.html", "https://example.com/pdp11.html"),
    /Unsupported idle redirect protocol/
);
assert.strictEqual(
    IdleManager.resolveRedirect("file:///D:/Museum/attract.html", "file:///C:/yaPDP/pdp11.html"),
    "file:///D:/Museum/attract.html"
);
assert.strictEqual(
    IdleManager.resolveRedirect("D:\\\\Museum\\\\Attract Page\\\\index.html", "file:///C:/yaPDP/pdp11.html"),
    "file:///D:/Museum/Attract%20Page/index.html"
);
assert.strictEqual(
    IdleManager.resolveRedirect("file:///D:/Museum/attract.html", "http://tauri.localhost/pdp11.html"),
    "file:///D:/Museum/attract.html"
);
assert.strictEqual(
    IdleManager.resolveRedirect("file:///D:/Museum/attract.html", "tauri://localhost/pdp11.html"),
    "file:///D:/Museum/attract.html"
);
assert.strictEqual(
    IdleManager.resolveRedirect("https://museum.example/attract.html", "file:///C:/yaPDP/pdp11.html"),
    "https://museum.example/attract.html"
);
assert.throws(
    () => IdleManager.resolveRedirect("ftp://museum.example/attract.html", "https://example.com/pdp11.html"),
    /Unsupported idle redirect protocol/
);

function makeHarness() {
    const listeners = {};
    let nextId = 1;
    const timers = new Map();
    const navigations = [];
    const doc = {
        hidden: false,
        addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
        removeEventListener: (name, fn) => {
            listeners[name] = (listeners[name] || []).filter((entry) => entry !== fn);
        }
    };
    const win = {
        location: { href: "https://amesk.github.io/yaPDP/pdp11.html", replace: (url) => navigations.push(url) }
    };
    const manager = IdleManager.create(
        { timeout: 1000, redirect: "https://museum.example/attract.html" },
        {
            document: doc, window: win,
            setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
            clearTimeout: (id) => timers.delete(id),
            now: () => 1000
        }
    );
    return {
        manager, doc, listeners, timers, navigations,
        fire(name, event) { (listeners[name] || []).slice().forEach((fn) => fn(event || { type: name })); },
        expire() {
            const entry = Array.from(timers.entries())[0];
            assert(entry, "expected an active idle timer");
            timers.delete(entry[0]);
            entry[1].fn();
        }
    };
}

{
    const h = makeHarness();
    assert.strictEqual(h.manager.active, true);
    assert.strictEqual(h.timers.size, 1);
    h.fire("keydown");
    assert.strictEqual(h.timers.size, 1, "activity re-arms one timer");
    h.expire();
    assert.deepStrictEqual(h.navigations, ["https://museum.example/attract.html"]);
    assert.strictEqual(h.manager.active, false);
    assert.strictEqual(h.timers.size, 0);
    assert.strictEqual(h.listeners.keydown.length, 0, "expiry removes activity listeners");
}

{
    const h = makeHarness();
    h.manager.stop();
    assert.strictEqual(h.manager.active, false);
    assert.strictEqual(h.timers.size, 0);
    h.fire("pointerdown");
    assert.strictEqual(h.timers.size, 0, "stopped manager cannot be re-armed");
    assert.deepStrictEqual(h.navigations, []);
}

console.log("idle-manager: all checks passed");
