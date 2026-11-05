#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { IdleManager } = require("../src/idle-manager.js");

// The URL carries seconds; parseOptions hands the timer milliseconds.
assert.deepStrictEqual(
    IdleManager.parseOptions("?idle-timeout=90&idle-redirect=/attract.html"),
    { timeout: 90000, redirect: "/attract.html" }
);
assert.deepStrictEqual(
    IdleManager.parseOptions("?idle-timeout=30&idle-redirect=/manual.html"),
    { timeout: 30000, redirect: "/manual.html" },
    "30 seconds must stay 30 seconds, not 30 milliseconds"
);
assert.strictEqual(
    IdleManager.parseOptions("?idle-timeout=9999999&idle-redirect=/a").timeout,
    2147483647,
    "an enormous idle-timeout is capped, never handed to setTimeout as-is"
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
    IdleManager.resolveRedirect("D:\\Museum\\Attract Page\\index.html", "file:///C:/yaPDP/pdp11.html"),
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

function makeHarness(options, envOptions) {
    const opts = options || { timeout: 1000, redirect: "https://museum.example/attract.html" };
    const extra = envOptions || {};
    const listeners = {};
    let nextId = 1;
    const timers = new Map();
    const navigations = [];
    const toastLog = [];
    // The idle warning is raised through the Toasts subsystem; the stub records
    // what it was asked to do. envOptions.toasts === null models a page where
    // the subsystem is absent (src/idle-manager.js is loaded before it).
    const toasts = extra.toasts === null ? null : {
        show: (payload) => toastLog.push({
            action: "show",
            text: payload.text,
            category: payload.category,
            key: payload.key,
            duration: payload.duration
        }),
        hide: (key) => toastLog.push({ action: "hide", key: key })
    };
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
        opts,
        {
            document: doc, window: win, toasts: toasts,
            setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
            clearTimeout: (id) => timers.delete(id),
            now: () => 1000
        }
    );
    const byDelay = () => Array.from(timers.entries()).sort((a, b) => a[1].ms - b[1].ms);
    const fireTimer = (entry) => { timers.delete(entry[0]); entry[1].fn(); };
    return {
        manager, doc, listeners, timers, navigations, toastLog,
        fire(name, event) { (listeners[name] || []).slice().forEach((fn) => fn(event || { type: name })); },
        timerDelays() { return byDelay().map((entry) => entry[1].ms); },
        // Fire the soonest timer: the warning that precedes the hand-off.
        fireWarning() {
            const entry = byDelay()[0];
            assert(entry, "expected an active idle warning timer");
            fireTimer(entry);
        },
        // Fire the latest timer: the idle expiry itself.
        expire() {
            const entry = byDelay().pop();
            assert(entry, "expected an active idle timer");
            fireTimer(entry);
        }
    };
}

{
    const h = makeHarness();
    assert.strictEqual(h.manager.active, true);
    assert.strictEqual(h.timers.size, 2, "one warning timer and one expiry timer");
    h.fire("keydown");
    assert.strictEqual(h.timers.size, 2, "activity re-arms exactly two timers");
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

{
    // Regression: ?idle-timeout=30 arms a 30 s timer and navigates nowhere
    // while the page is fresh — the operator gets the whole idle window.
    const h = makeHarness(IdleManager.parseOptions("?idle-timeout=30&idle-redirect=/manual.html"));
    assert.strictEqual(h.manager.active, true);
    assert.deepStrictEqual(h.timerDelays(), [25000, 30000],
        "30 in the URL is 30000 ms on the timer, announced 5 s earlier");
    assert.deepStrictEqual(h.navigations, [], "a fresh page must not redirect");
    h.fire("pointerdown");
    assert.deepStrictEqual(h.timerDelays(), [25000, 30000],
        "activity re-arms the full idle window");
    h.expire();
    assert.deepStrictEqual(h.navigations, ["https://amesk.github.io/manual.html"]);
}

{
    // The hand-off is announced 5 s ahead, and any activity withdraws the
    // warning and restarts the whole window.
    const h = makeHarness(IdleManager.parseOptions("?idle-timeout=60&idle-redirect=/attract.html"));
    assert.deepStrictEqual(h.timerDelays(), [55000, 60000],
        "the warning timer precedes the hand-off timer by exactly 5 s");
    assert.deepStrictEqual(h.toastLog, [], "a fresh page warns nothing");

    h.fireWarning();
    assert.strictEqual(h.toastLog.length, 1, "one warning toast, no duplicates");
    assert.strictEqual(h.toastLog[0].action, "show");
    assert.strictEqual(h.toastLog[0].text, IdleManager.WARNING_TEXT);
    assert.strictEqual(h.toastLog[0].category, "warning");
    assert.strictEqual(h.toastLog[0].duration, 5000, "the warning spans exactly the lead");
    assert.deepStrictEqual(h.navigations, [], "the warning alone must not hand the session over");

    h.fire("keydown");
    assert.deepStrictEqual(h.toastLog[1], { action: "hide", key: IdleManager.WARNING_KEY },
        "activity withdraws the warning");
    assert.deepStrictEqual(h.timerDelays(), [55000, 60000],
        "activity re-arms both the warning and the hand-off");

    h.fireWarning();
    assert.strictEqual(h.toastLog.length, 3, "the warning returns for the new idle window");
    h.expire();
    assert.deepStrictEqual(h.navigations, ["https://amesk.github.io/attract.html"],
        "the hand-off still happens at the full timeout");
}

{
    // idle-timeout <= 5 s: the warning point is already past, so the warning is
    // due at once and stays for the whole short window — still one toast, never
    // a stack, and no crash.
    const h = makeHarness(IdleManager.parseOptions("?idle-timeout=4&idle-redirect=/attract.html"));
    assert.deepStrictEqual(h.timerDelays(), [0, 4000],
        "a short window arms the warning immediately");

    h.fireWarning();
    assert.strictEqual(h.toastLog.length, 1);
    assert.strictEqual(h.toastLog[0].duration, 4000, "short windows keep the warning up throughout");

    h.fire("wheel");
    assert.deepStrictEqual(h.toastLog[1], { action: "hide", key: IdleManager.WARNING_KEY });
    assert.deepStrictEqual(h.timerDelays(), [0, 4000], "no extra timers pile up on activity");
    h.fireWarning();
    assert.strictEqual(h.toastLog.length, 3, "one warning per idle window, never a stack");
}

{
    // Without the Toasts subsystem (this module is loaded before src/toasts.js)
    // raising and withdrawing the warning must stay a silent no-op.
    const h = makeHarness(IdleManager.parseOptions("?idle-timeout=10&idle-redirect=/a"), { toasts: null });
    assert.doesNotThrow(() => h.fireWarning());
    assert.deepStrictEqual(h.toastLog, []);
    assert.doesNotThrow(() => h.fire("keydown"));
    assert.doesNotThrow(() => h.expire());
    assert.deepStrictEqual(h.navigations, ["https://amesk.github.io/a"]);
}

console.log("idle-manager: all checks passed");
