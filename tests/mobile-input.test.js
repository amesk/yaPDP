#!/usr/bin/env node
/**
 * MobileInput modular tests.
 *
 * Loads the real production module (src/mobile-input.js) in an isolated VM
 * context and exercises the DOM-free helpers that bridge the system on-screen
 * keyboard into the VT52/VT100 terminals and the Model 33 teletype:
 *   • isCoarse()          — coarse-pointer / touch detection (window injectable)
 *   • translateKeydown()  — Enter/Backspace/Tab/Escape and Ctrl+letter -> bytes
 *   • translateInputData()— character stream -> 7-bit bytes (CRLF folded to CR)
 *   • create()            — returns a harmless no-op object without a DOM
 *
 * Run with:  node tests/mobile-input.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "mobile-input.js");

function loadModule(nowFn) {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = { console };
    // The module only calls Date.now(). Injecting a controllable clock lets a
    // test drive the Enter dedupe window deterministically.
    if (nowFn) sandbox.Date = { now: nowFn };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    // `var MobileInput = ...` at top level becomes a property of the sandbox.
    return sandbox.MobileInput;
}

// Arrays produced inside the VM context belong to a different realm, so
// deepStrictEqual on them fails on prototype identity. JSON round-trip gives
// plain main-realm values that compare reliably.
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

// A minimal fake document/element pair: enough for create() to build and wire
// its invisible textarea, plus a dispatch() to fire the input/beforeinput/
// keydown events an on-screen keyboard would raise.
function fakeDoc() {
    const el = {
        className: "",
        style: {},
        value: "",
        tabIndex: 0,
        parentNode: null,
        _listeners: {},
        setAttribute: function () { },
        focus: function () { },
        blur: function () { },
        addEventListener: function (type, fn) {
            (this._listeners[type] = this._listeners[type] || []).push(fn);
        },
        removeEventListener: function (type, fn) {
            const arr = this._listeners[type];
            if (!arr) return;
            const i = arr.indexOf(fn);
            if (i >= 0) arr.splice(i, 1);
        },
        dispatch: function (type, ev) {
            const arr = this._listeners[type] || [];
            for (let i = 0; i < arr.length; i++) arr[i](ev);
        }
    };
    return {
        _el: el,
        createElement: function () { return el; },
        body: {
            appendChild: function (child) { child.parentNode = this; },
            removeChild: function (child) { child.parentNode = null; }
        }
    };
}

// A fake window with the two signals isCoarse() looks at.
function fakeWin(coarse, touchPoints) {
    return {
        matchMedia: function (query) { return { matches: !!coarse, media: query }; },
        navigator: { maxTouchPoints: touchPoints || 0 }
    };
}

function run() {
    const M = loadModule();
    assert.ok(M, "module should expose MobileInput");
    assert.strictEqual(typeof M.isCoarse, "function", "isCoarse must be exported");
    assert.strictEqual(typeof M.translateKeydown, "function", "translateKeydown must be exported");
    assert.strictEqual(typeof M.translateInputData, "function", "translateInputData must be exported");
    assert.strictEqual(typeof M.create, "function", "create must be exported");
    assert.strictEqual(typeof M.controlCode, "function", "controlCode must be exported");
    assert.strictEqual(typeof M.applyCtrlLatch, "function", "applyCtrlLatch must be exported");
    assert.strictEqual(typeof M.setCtrlLatch, "function", "setCtrlLatch must be exported");
    assert.strictEqual(typeof M.onLatchChange, "function", "onLatchChange must be exported");
    assert.strictEqual(typeof M.registerTarget, "function", "registerTarget must be exported");
    assert.strictEqual(typeof M.findTarget, "function", "findTarget must be exported");
    assert.strictEqual(typeof M.sendToActive, "function", "sendToActive must be exported");
    assert.strictEqual(typeof M.focusActive, "function", "focusActive must be exported");

    // ---- isCoarse: coarse pointer, touch points, neither ----------------
    {
        assert.strictEqual(M.isCoarse(fakeWin(true, 0)), true,
            "a coarse pointer device is mobile");
        assert.strictEqual(M.isCoarse(fakeWin(false, 5)), true,
            "touch points imply a touch device");
        assert.strictEqual(M.isCoarse(fakeWin(false, 0)), false,
            "a fine pointer with no touch points is a desktop");
        assert.strictEqual(M.isCoarse({}), false,
            "an object without matchMedia/navigator is not mobile");
        assert.strictEqual(M.isCoarse(null), false,
            "a missing window is not mobile");
    }

    // ---- translateInputData: characters, 7-bit masking, line breaks -----
    {
        assert.deepStrictEqual(plain(M.translateInputData("abc")), [97, 98, 99],
            "printable characters pass through as ASCII");
        assert.deepStrictEqual(plain(M.translateInputData("A\r\nB")), [65, 13, 66],
            "CRLF folds to a single CR");
        assert.deepStrictEqual(plain(M.translateInputData("a\nb")), [97, 13, 98],
            "a lone LF becomes CR");
        assert.deepStrictEqual(plain(M.translateInputData("a\rb")), [97, 13, 98],
            "a lone CR is already CR");
        assert.deepStrictEqual(plain(M.translateInputData("\u00e9")), [0x69],
            "a high character is masked to 7 bits");
        assert.deepStrictEqual(plain(M.translateInputData("")), [],
            "an empty string yields no bytes");
        assert.deepStrictEqual(plain(M.translateInputData(null)), [],
            "null yields no bytes");
    }

    // ---- translateKeydown: special keys ---------------------------------
    {
        assert.deepStrictEqual(plain(M.translateKeydown({ key: "Enter" })), [13],
            "Enter -> CR");
        assert.deepStrictEqual(plain(M.translateKeydown({ key: "Backspace" })), [8],
            "Backspace -> BS");
        assert.deepStrictEqual(plain(M.translateKeydown({ key: "Tab" })), [9],
            "Tab -> HT");
        assert.deepStrictEqual(plain(M.translateKeydown({ key: "Escape" })), [27],
            "Escape -> ESC");
        assert.deepStrictEqual(plain(M.translateKeydown({ keyCode: 13 })), [13],
            "a bare keyCode 13 still maps to CR");
        assert.deepStrictEqual(plain(M.translateKeydown({ keyCode: 8 })), [8],
            "a bare keyCode 8 still maps to BS");

        assert.deepStrictEqual(plain(M.translateKeydown({ key: "a", ctrlKey: true })), [1],
            "Ctrl+A -> 0x01");
        assert.deepStrictEqual(plain(M.translateKeydown({ key: "z", ctrlKey: true })), [26],
            "Ctrl+Z -> 0x1A");

        assert.strictEqual(M.translateKeydown({ key: "a" }), null,
            "a printable key is left to the input path");
        assert.strictEqual(M.translateKeydown({ key: "ArrowUp" }), null,
            "arrow keys carry no terminal byte here");
        assert.strictEqual(M.translateKeydown(null), null,
            "a null event is ignored");
    }

    // ---- composing (IME) input ------------------------------------------
    // An Android keyboard composes the word in the backing store and commits it
    // as a whole, so the composed text has to be delivered keystroke by
    // keystroke — held back, typing was invisible until Enter.
    {
        assert.strictEqual(M.isPlainAscii("dir"), true, "plain ASCII is typeable");
        assert.strictEqual(M.isPlainAscii(""), false, "an empty payload is not");
        assert.strictEqual(M.isPlainAscii("\u4f60"), false, "a CJK character is not");
        assert.strictEqual(M.isPlainAscii(null), false, "null is not");

        assert.strictEqual(M.composingDelta("", "d"), "d", "the first character of a composition");
        assert.strictEqual(M.composingDelta("d", "di"), "i", "the appended character");
        assert.strictEqual(M.composingDelta("di", "di"), "", "nothing new to send");
        assert.strictEqual(M.composingDelta("teh", "the"), "",
            "a rewrite (autocorrect) appends nothing");

        assert.strictEqual(M.pendingComposition("di", ""), "di",
            "an undelivered composition is sent whole at the commit");
        assert.strictEqual(M.pendingComposition("di", "d"), "i",
            "the commit owes only the tail");
        assert.strictEqual(M.pendingComposition("di", "di"), "",
            "nothing is sent twice");
        assert.strictEqual(M.pendingComposition("the", "teh"), "",
            "a rewritten composition is not duplicated into the operator's line");
    }

    // ---- controlCode / applyCtrlLatch: the Ctrl latch --------------------
    // An on-screen keyboard never sets ctrlKey, so the bar latches CTRL instead
    // and the byte arithmetic must be the one a hardware Ctrl+key performs.
    {
        assert.strictEqual(M.controlCode("c"), 3, "Ctrl+C -> 0x03");
        assert.strictEqual(M.controlCode("C"), 3, "case does not matter");
        assert.strictEqual(M.controlCode("["), 27, "Ctrl+[ -> ESC");
        assert.strictEqual(M.controlCode(" "), 0, "Ctrl+Space -> NUL");
        assert.strictEqual(M.controlCode("4"), 20, "Ctrl+4 -> 0x14 (X-OFF is ^S, ^4 is FS)");
        assert.strictEqual(M.controlCode("~"), 30, "the top of the printable range");
        assert.strictEqual(M.controlCode("ab"), null, "a whole word has no control code");
        assert.strictEqual(M.controlCode(""), null, "an empty payload has none");
        assert.strictEqual(M.controlCode("\u00e9"), null, "a non-ASCII character has none");
        assert.strictEqual(M.controlCode(null), null, "null has none");

        assert.deepStrictEqual(plain(M.applyCtrlLatch("c", true)), { bytes: [3], latch: false },
            "a latched character becomes its control code and clears the latch");
        assert.deepStrictEqual(plain(M.applyCtrlLatch("ab", true)), { bytes: [97, 98], latch: true },
            "a payload without a control code passes through and keeps the latch");
        assert.deepStrictEqual(plain(M.applyCtrlLatch("c", false)), { bytes: [99], latch: false },
            "without the latch a character is itself");
        assert.deepStrictEqual(plain(M.applyCtrlLatch("\r", true)), { bytes: [13], latch: true },
            "Enter is not a latched character (the bar sends CR itself)");
    }

    // ---- the latch announces its state (the bar lights CTRL) -------------
    {
        const seen = [];
        M.onLatchChange(function (on) { seen.push(on); });
        M.setCtrlLatch(true);
        M.setCtrlLatch(true);           // no change: no second notification
        assert.strictEqual(M.isCtrlLatched(), true, "the latch is on");
        M.setCtrlLatch(false);
        assert.strictEqual(M.isCtrlLatched(), false, "the latch is off again");
        assert.deepStrictEqual(plain(seen), [true, false],
            "only a real change is announced");
    }

    // ---- the input target registry (what the special-key bar types into) --
    {
        const sentA = [];
        const sentB = [];
        const a = M.registerTarget({
            id: "vt52:0", pageId: "page-vt52-console", unit: 0,
            send: function (bytes) { sentA.push(bytes.slice()); }
        });
        const b = M.registerTarget({
            id: "tty0", pageId: "page-teletype", unit: 0,
            send: function (bytes) { sentB.push(bytes.slice()); }
        });

        assert.strictEqual(M.findTarget("page-teletype"), b,
            "a page resolves to its own target");
        assert.strictEqual(M.findTarget("page-config"), null,
            "a page without a terminal has no target");
        assert.strictEqual(M.sendToActive([13]), false,
            "there is nothing to send to before a terminal is active");

        M.setActive(a);
        assert.strictEqual(M.getActiveTarget(), a, "the active target is kept");
        assert.strictEqual(M.sendToActive([13]), true, "the bytes are delivered");
        assert.deepStrictEqual(plain(sentA), [[13]], "…to the active terminal");
        assert.deepStrictEqual(plain(sentB), [], "…and to no one else");

        a.destroy();
        assert.strictEqual(M.findTarget("page-vt52-console"), null,
            "a destroyed target is unregistered");
        assert.strictEqual(M.getActiveTarget(), null,
            "a destroyed target stops being active");
        assert.deepStrictEqual(plain(M.findTarget("page-teletype") === b), true,
            "the other target is untouched");
    }

    // ---- create: harmless no-op without a DOM ---------------------------
    {
        const noop = M.create({ onBytes: function () { } });
        assert.ok(noop && typeof noop.focus === "function", "create always returns a bridge object");
        assert.strictEqual(noop.element, null, "the no-DOM bridge has no element");
        noop.focus();
        noop.blur();
        noop.destroy();
    }

    // ---- create: Enter via input/beforeinput, with dedupe ---------------
    {
        let clock = 1000;
        const Md = loadModule(function () { return clock; });
        const doc = fakeDoc();
        const sent = [];
        const bridge = Md.create({
            onBytes: function (bytes) { sent.push(bytes.slice()); },
            document: doc
        });
        assert.ok(bridge.element, "create wires a textarea when a DOM is provided");
        const el = doc._el;

        // Enter as a line break with an EMPTY data string must still send CR:
        // this is the case that silently did nothing before.
        el.dispatch("input", { inputType: "insertLineBreak", data: "" });
        assert.deepStrictEqual(plain(sent), [[13]],
            "insertLineBreak with empty data -> CR");

        // The same press reported again (or a null-data variant) within the
        // dedupe window must NOT send a second CR.
        clock = 1010;
        el.dispatch("input", { inputType: "insertLineBreak", data: null });
        assert.deepStrictEqual(plain(sent), [[13]],
            "a burst of Enter events collapses to one CR");

        // A later Enter (past the window) sends a fresh CR, including the
        // beforeinput path used by IMEs that never emit keydown.
        clock = 1100;
        el.dispatch("beforeinput", { inputType: "insertParagraph", preventDefault: function () { } });
        assert.deepStrictEqual(plain(sent), [[13], [13]],
            "insertParagraph via beforeinput -> a new CR");

        // Ordinary typing is unaffected.
        el.dispatch("input", { inputType: "insertText", data: "a" });
        assert.deepStrictEqual(plain(sent[sent.length - 1]), [97],
            "insertText 'a' -> 0x61");

        // With the latch on (the bar's CTRL key), one typed character is sent as
        // its control code — and the latch clears with it.
        Md.setCtrlLatch(true);
        el.dispatch("input", { inputType: "insertText", data: "c" });
        assert.deepStrictEqual(plain(sent[sent.length - 1]), [3],
            "a latched 'c' reaches the terminal as 0x03");
        assert.strictEqual(Md.isCtrlLatched(), false,
            "the character consumed the latch");
        el.dispatch("input", { inputType: "insertText", data: "c" });
        assert.deepStrictEqual(plain(sent[sent.length - 1]), [99],
            "the next 'c' is an ordinary letter again");

        bridge.destroy();
    }

    // ---- create: an IME composition is typed through keystroke by keystroke --
    {
        const doc = fakeDoc();
        const sent = [];
        const bridge = M.create({
            onBytes: function (bytes) { sent.push(bytes.slice()); },
            document: doc
        });
        const el = doc._el;

        el.dispatch("compositionstart", {});
        el.value = "d";
        el.dispatch("input", { isComposing: true, inputType: "insertCompositionText", data: "d" });
        assert.deepStrictEqual(plain(sent), [[100]],
            "the first composed character goes out as it is typed");

        el.value = "di";
        el.dispatch("input", { isComposing: true, inputType: "insertCompositionText", data: "di" });
        assert.deepStrictEqual(plain(sent), [[100], [105]],
            "…and so does the next one");

        el.dispatch("compositionend", { data: "di" });
        assert.deepStrictEqual(plain(sent), [[100], [105]],
            "the commit sends nothing a second time");
        assert.strictEqual(el.value, "", "the commit clears the backing store");

        // A non-ASCII composition (a romanised CJK result) waits for the commit:
        // its characters are not what the operator means.
        el.dispatch("compositionstart", {});
        el.value = "\u4f60";
        el.dispatch("input", { isComposing: true, inputType: "insertCompositionText", data: "\u4f60" });
        assert.deepStrictEqual(plain(sent), [[100], [105]],
            "a non-ASCII composition is held back");
        el.dispatch("compositionend", { data: "\u4f60" });
        assert.deepStrictEqual(plain(sent[sent.length - 1]), [0x60],
            "the committed character is sent, masked to 7 bits");

        bridge.destroy();
    }

    console.log("mobile-input.test.js: all tests passed");
}

run();
