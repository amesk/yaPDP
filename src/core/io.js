/*
 * core/io.js — environment I/O adapter (the WebIO analogue).
 *
 * The single seam between the headless machine and its environment:
 * devices and the Machine never touch process/DOM/fs directly — they talk
 * to an IO adapter. Two implementations ship with the core:
 *
 *   NodeIO     — stdout/stderr + readline stdin + fs.promises + timers.
 *                Used by headless tools (headless-term) and by Node
 *                tests.
 *   BrowserIO  — console + window.prompt (fallback) + fetch + timers.
 *                The browser build will grow DOM bindings (teletype
 *                paper, LP11 fanfold) as devices move over; until then
 *                print() goes to the console.
 *
 * The Machine constructor already accepts an `io` object; this module
 * just defines the contract and the two stock implementations.
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests).
 */
(function (global) {
    "use strict";

    /**
     * IO — abstract base. Methods are the contract; subclasses implement.
     */
    class IO {
        /** print(text) — emit one line of machine output. */
        print(text) { /* abstract */ }

        /** error(text) — emit one line of diagnostics. */
        error(text) { /* abstract */ }

        /**
         * input(prompt) — read one line of operator input.
         * @returns {Promise<string|null>} resolved line, or null on EOF.
         */
        input(prompt) { return Promise.resolve(null); }

        /** setTimer(fn, ms) — schedule fn after ms; returns a handle. */
        setTimer(fn, ms) { return setTimeout(fn, ms); }

        /** clearTimer(handle) — cancel a scheduled timer. */
        clearTimer(handle) { clearTimeout(handle); }

        /** setInterval(fn, ms) — periodic timer; returns a handle. */
        setInterval(fn, ms) { return setInterval(fn, ms); }

        /** clearInterval(handle) — cancel a periodic timer. */
        clearInterval(handle) { clearInterval(handle); }

        /**
         * readFile(path) — read a file/URL as bytes.
         * @returns {Promise<Uint8Array>}
         */
        readFile(path) { return Promise.reject(new Error("readFile not implemented")); }

        /** now() — monotonic-ish timestamp in ms (Date.now()). */
        now() { return Date.now(); }
    }

    /**
     * NodeIO — process.stdout/stderr, readline stdin, fs.promises.
     */
    class NodeIO extends IO {
        constructor({ stdout = process.stdout, stderr = process.stderr,
                      stdin = process.stdin, fs = null } = {}) {
            super();
            this.stdout = stdout;
            this.stderr = stderr;
            this.stdin = stdin;
            this._fs = fs; // lazily required in readFile
            this._rl = null;
        }

        print(text) {
            this.stdout.write(String(text) + "\n");
        }

        error(text) {
            this.stderr.write(String(text) + "\n");
        }

        input(prompt) {
            if (prompt) this.stdout.write(String(prompt));
            if (!this.stdin || typeof this.stdin.on !== "function") {
                return Promise.resolve(null);
            }
            const readline = require("readline");
            if (!this._rl) {
                this._rl = readline.createInterface({
                    input: this.stdin,
                    output: this.stdout,
                    terminal: false,
                });
            }
            return new Promise((resolve) => {
                this._rl.once("line", (line) => resolve(line));
                this._rl.once("close", () => resolve(null));
            });
        }

        readFile(path) {
            if (!this._fs) this._fs = require("fs");
            return this._fs.promises.readFile(path)
                .then((buf) => new Uint8Array(buf));
        }
    }

    /**
     * BrowserIO — console + window.prompt + fetch + timers.
     * The `win`/`console` arguments allow injection in tests.
     */
    class BrowserIO extends IO {
        constructor({ win = global, console: cons = global.console } = {}) {
            super();
            this.win = win;
            this.cons = cons;
        }

        print(text) {
            if (this.cons && typeof this.cons.log === "function") {
                this.cons.log(String(text));
            }
        }

        error(text) {
            if (this.cons && typeof this.cons.error === "function") {
                this.cons.error(String(text));
            } else {
                this.print(text);
            }
        }

        input(prompt) {
            const w = this.win;
            if (w && typeof w.prompt === "function") {
                return Promise.resolve(w.prompt(String(prompt || "")));
            }
            return Promise.resolve(null);
        }

        readFile(path) {
            const w = this.win;
            if (w && typeof w.fetch === "function") {
                return w.fetch(path).then((resp) => {
                    if (!resp.ok) throw new Error("fetch failed: " + path);
                    return resp.arrayBuffer().then((ab) => new Uint8Array(ab));
                });
            }
            return Promise.reject(new Error("readFile not available"));
        }
    }

    const api = { IO, NodeIO, BrowserIO };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.IO = IO;
        window.yapdpCore.NodeIO = NodeIO;
        window.yapdpCore.BrowserIO = BrowserIO;
    }
})(typeof window !== "undefined" ? window : globalThis);
