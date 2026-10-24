/*
 * devices/lp11.js — LP11 line printer as a core Device (no DOM required).
 *
 * Refactor stage 3e: the LP11 closure of iopage.js (17777510, vector 0200,
 * priority 4) moves onto the Device base 1:1. Register behaviour (LPCS/
 * LPDB with the DONE-throttling + sticky ERROR semantics) and the operator
 * keys (ON LINE, paper feed, top of form, tear) are here. The paper copy —
 * the text state machine and the printable document — lives in
 * src/lp11paper.js, shared with the legacy iopage.js closure so the two
 * printer paths cannot drift apart again. The animated G60 printer is an
 * optional UI seam created lazily when the browser provides G60Printer —
 * in headless Node the class simply never prints.
 *
 * The window bridge (lp11G60Printer, lp11Print/lp11Save/lp11GetText/
 * lp11PaperFeed/lp11TopOfForm/lp11TearPaper/lp11OnLine) is wired by
 * browser-machine.js.
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests and the headless machine).
 */
(function (global) {
    "use strict";

    const { Device } = (typeof module !== "undefined" && module.exports)
        ? require("../core/device.js")
        : (global.yapdpCore || {});

    // The paper copy (text model + printable document) is shared with the
    // legacy iopage.js closure through src/lp11paper.js, so the two printer
    // paths cannot drift apart again.
    const Lp11Paper = (typeof module !== "undefined" && module.exports)
        ? require("../lp11paper.js")
        : global.Lp11Paper;
    if (!Lp11Paper) {
        throw new Error("src/lp11paper.js must be loaded before src/devices/lp11.js");
    }

    const LP_VECTOR = 0o200;
    const LP_PRIORITY = 4 << 5;

    const LP_LPCS_DONE = 0x80;
    const LP_LPCS_IE = 0x40;
    const LP_LPCS_ERR = 0x20;

    /**
     * insertData — merge a byte/word write into an existing word (local
     * copy of the iopage.js helper).
     */
    function insertData(currentWord, physicalAddress, data, byteFlag) {
        if (data < 0) return currentWord; // read
        if (byteFlag) {
            if (physicalAddress & 1) {
                return (currentWord & 0xFF) | ((data & 0xFF) << 8);
            }
            return (currentWord & 0xFF00) | (data & 0xFF);
        }
        return data & 0xFFFF;
    }

    // The text state machine (putChar/textPut) lives in src/lp11paper.js.
    const textPut = Lp11Paper.textPut;

    class Lp11 extends Device {
        constructor(machine, id, config = {}) {
            super(machine, id, config);
            this.printerWidth = config.printerWidth || 132;
            this.lpcs = LP_LPCS_DONE;
            this.lpdb = 0;
            this.iMask = 0;
            this.lp11Online = true;
            this.lp11Buffer = [];
            this.lp11BufferRuns = [];   // style runs per buffered line
            this.lp11CurrentLine = "";
            this.lp11LineRuns = [];     // style runs of the line in progress
            this.lp11Col = 0;
            this.lp11Console = undefined; // G60 console adapter (UI seam)
            this.lp11Printer = undefined; // G60Printer instance (UI seam)
            this._readyTimer = null;
            this.reset();
            this.ensureUI();
            this._startReadyTick();
        }

        _requestInterrupt() {
            const cpu = this.machine && this.machine.host
                ? this.machine.host.cpu : null;
            if (cpu) {
                cpu.interruptRequested = 1;
                if (cpu.runState === 2) cpu.runState = 0; // STATE_WAIT → STATE_RUN
            }
        }

        reset() {
            this.lpcs = LP_LPCS_DONE;
            this.lpdb = 0;
            this.iMask = 0;
            // The printer instance and its paper are kept across resets.
        }

        /** ensureUI() — lazily create the animated G60 printer (browser only). */
        ensureUI() {
            if (this.lp11Console !== undefined) return;
            if (typeof document === "undefined" || typeof window === "undefined" ||
                typeof window.G60Printer === "undefined") {
                this.lp11Console = null;
                return;
            }
            const container = document.getElementById("lp11_printer");
            if (!container) {
                this.lp11Console = null;
                return;
            }
            const dev = this;
            this.lp11Printer = new window.G60Printer("lp11_printer", {
                idPrefix: "lp11g60",
                maxCols: this.printerWidth,
                // 10 pitch x 6 LPI on the page's 7px advance: the sheet keeps
                // the real fanfold aspect instead of stretching 1.37x.
                lineHeight: window.G60Printer.LP11_CELL_HEIGHT || 11.6667,
                charPrintDelay: 3,
                charSound: false,
                charsPerTick: 3,
                printWhirr: true,
                onChar: function () {
                    dev.lpcs |= LP_LPCS_DONE;
                    if (dev.lpcs & LP_LPCS_IE) {
                        dev.iMask = 1;
                        dev._requestInterrupt();
                    }
                }
            });
            this.lp11Console = window.createG60Console(this.lp11Printer);
            window.lp11G60Printer = this.lp11Printer;
        }

        _startReadyTick() {
            if (this._readyTimer || typeof document === "undefined") return;
            const io = this.machine ? this.machine.io : null;
            const tick = () => this.readyTick();
            if (io && typeof io.setInterval === "function") {
                this._readyTimer = io.setInterval(tick, 120);
            } else if (typeof setInterval === "function") {
                this._readyTimer = setInterval(tick, 120);
            }
        }

        /** readyTick() — keep the READY LED in sync with the mechanism. */
        readyTick() {
            if (typeof document === "undefined") return;
            const led = document.getElementById("lp11-ready-led");
            if (led) {
                const busy = !!(this.lp11Printer &&
                    typeof this.lp11Printer.isBusy === "function" &&
                    this.lp11Printer.isBusy());
                if (led.classList.contains("busy") !== busy) {
                    led.classList.toggle("busy", busy);
                }
            }
            if (typeof NavActivity !== "undefined" && NavActivity.set) {
                const busy = !!(this.lp11Printer &&
                    typeof this.lp11Printer.isBusy === "function" &&
                    this.lp11Printer.isBusy());
                NavActivity.set("printer", busy);
            }
        }

        // ------------------------------------------------------------------
        // Operator keys
        // ------------------------------------------------------------------
        _audioMuted() {
            try {
                return (typeof Config !== "undefined") && !!Config.get().mute;
            } catch (e) { return false; }
        }

        _playFeedSound() {
            if (this._audioMuted() || typeof Audio === "undefined") return;
            try {
                const a = new Audio("assets/sounds/teletype33-print.mp3");
                a.preload = "auto";
                a.currentTime = 0;
                a.play().catch(function () {});
                setTimeout(function () { try { a.pause(); } catch (e) {} }, 400);
            } catch (e) { /* ignore */ }
        }

        _playTearSound() {
            if (this._audioMuted() || typeof Audio === "undefined") return;
            try {
                const a = new Audio("assets/sounds/paper-rip-sound-effect.mp3");
                a.preload = "auto";
                a.currentTime = 0;
                a.play().catch(function () {});
            } catch (e) { /* ignore */ }
        }

        paperFeed() {
            this.ensureUI();
            this._playFeedSound();
            if (this.lp11Printer && typeof this.lp11Printer.println === "function") {
                this.lp11Printer.println();
            }
        }

        topOfForm() {
            this.ensureUI();
            this._playFeedSound();
            if (this.lp11Printer && typeof this.lp11Printer.formFeed === "function") {
                this.lp11Printer.formFeed();
            }
        }

        tearPaper() {
            this.ensureUI();
            let torn = (this.lp11Buffer.length > 0 || this.lp11CurrentLine.length > 0);
            if (this.lp11Printer && typeof this.lp11Printer.reset === "function") {
                if (this.lp11Printer.reset()) torn = true;
            }
            if (torn) this._playTearSound();
            this.lp11Buffer = [];
            this.lp11BufferRuns = [];
            this.lp11CurrentLine = "";
            this.lp11LineRuns = [];
            this.lp11Col = 0;
        }

        /** onLine() — toggle the ON LINE operator key. */
        onLine() {
            const wasOnline = this.lp11Online;
            this.lp11Online = !this.lp11Online;
            if (wasOnline && !this.lp11Online && this.lp11Printer &&
                typeof this.lp11Printer.stop === "function") {
                this.lp11Printer.stop();
            }
            if (!this.lp11Online) {
                this.lpcs |= LP_LPCS_DONE;
                if (this.lpcs & LP_LPCS_IE) {
                    this.iMask = 1;
                    this._requestInterrupt();
                }
            } else {
                this.lpcs &= ~LP_LPCS_ERR;
            }
            if (typeof document !== "undefined") {
                const led = document.getElementById("lp11-online-led");
                if (led) led.classList.toggle("off", !this.lp11Online);
                const key = document.getElementById("lp11-online-key");
                if (key) key.classList.toggle("off", !this.lp11Online);
            }
        }

        // ------------------------------------------------------------------
        // Print / Save .txt (real output of the accumulated job)
        // ------------------------------------------------------------------
        getText() {
            // The plain-text job: real 0x0C page sentinels, no styling.
            return Lp11Paper.joinText(this.lp11Buffer, this.lp11CurrentLine);
        }

        /**
         * print() — hand the paper copy to the system print dialog. The document
         * paginates on FF and every 66 lines, prints double-struck glyphs bold
         * and underscored ones underlined, and sizes the font so the configured
         * column count spans the printable width of the paper the operator picks
         * in the dialog (see buildPrintDocument in src/lp11paper.js).
         */
        print() {
            if (typeof document === "undefined") return;
            // The CONFIG width is live: the operator may have changed it since
            // the device was built, and the printed sheet must follow it.
            var live = (typeof Config !== "undefined") ? Config.get() : null;
            Lp11Paper.printDocument(
                this.lp11Buffer,
                this.lp11CurrentLine,
                this.lp11BufferRuns,
                {
                    columns: (live && live.printerWidth) || this.printerWidth ||
                        Lp11Paper.DEFAULT_COLUMNS,
                    linesPerPage: Lp11Paper.DEFAULT_LINES_PER_PAGE,
                }
            );
        }

        save() {
            const text = this.getText();
            if (!text.trim() || typeof document === "undefined") return;
            const blob = new Blob([text], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "lp11_output.txt";
            a.click();
            URL.revokeObjectURL(url);
        }

        // ------------------------------------------------------------------
        // Bus interface
        // ------------------------------------------------------------------
        access(pa, data, byteFlag) {
            let result;
            switch (pa & 0o6) {
                case 0o4: // LPCS
                    result = insertData(this.lpcs, pa, data, byteFlag);
                    if (result >= 0 && data < 0) {
                        this.lpcs &= ~LP_LPCS_ERR;
                    }
                    if (result >= 0 && data >= 0) {
                        if ((result ^ this.lpcs) & LP_LPCS_IE) {
                            if (result & LP_LPCS_IE) {
                                this.iMask = 1;
                                this._requestInterrupt();
                            } else {
                                this.iMask = 0;
                            }
                        }
                        this.lpcs = (this.lpcs & (LP_LPCS_DONE | LP_LPCS_ERR)) |
                            (result & LP_LPCS_IE);
                    }
                    break;

                case 0o6: // LPDB
                    result = insertData(this.lpdb, pa, data, byteFlag);
                    if (data >= 0 && result >= 0) {
                        this.ensureUI();
                        this.lpdb = result & 0x7F;
                        if (this.lp11Online) {
                            const isBackspace = (this.lpdb === 0o10);
                            const isTab = (this.lpdb === 0o11);
                            const isLf = (this.lpdb === 0o12);
                            const isFormFeed = (this.lpdb === 0o14);
                            const isCr = (this.lpdb === 0o15);
                            const isPrintable = (this.lpdb >= 0x20 && this.lpdb < 0x7F);
                            const fed = (isBackspace || isTab || isLf || isCr ||
                                isPrintable || isFormFeed);
                            if (this.lp11Console && fed) {
                                this.lp11Console.writeChar(this.lpdb);
                                this.lpcs &= ~LP_LPCS_DONE;
                            } else {
                                this.lpcs |= LP_LPCS_DONE;
                            }
                            const st = textPut({
                                buffer: this.lp11Buffer,
                                bufferRuns: this.lp11BufferRuns,
                                line: this.lp11CurrentLine,
                                lineRuns: this.lp11LineRuns,
                                col: this.lp11Col,
                            }, this.lpdb);
                            this.lp11Buffer = st.buffer;
                            this.lp11BufferRuns = st.bufferRuns;
                            this.lp11CurrentLine = st.line;
                            this.lp11LineRuns = st.lineRuns;
                            this.lp11Col = st.col;
                        } else {
                            this.lpcs |= LP_LPCS_DONE | LP_LPCS_ERR;
                        }
                        if ((this.lpcs & LP_LPCS_IE) && (this.lpcs & LP_LPCS_DONE)) {
                            this.iMask = 1;
                            this._requestInterrupt();
                        }
                    }
                    break;

                default:
                    return this.machine && this.machine.host &&
                        typeof this.machine.host.trap === "function"
                        ? this.machine.host.trap(0o4, 0x10)
                        : -1; // Unibus timeout
            }
            return result;
        }

        poll(takeInterrupt) {
            if (takeInterrupt) {
                this.iMask = 0;
                return LP_VECTOR;
            } else {
                if (!(this.lpcs & LP_LPCS_IE)) this.iMask = 0;
                return LP_PRIORITY | (this.iMask ? 1 : 0);
            }
        }

        snapshot() {
            let paper = null;
            if (this.lp11Printer && typeof this.lp11Printer.snapshot === "function") {
                paper = this.lp11Printer.snapshot();
            }
            return {
                lpcs: this.lpcs,
                lpdb: this.lpdb,
                iMask: this.iMask,
                lp11Buffer: this.lp11Buffer.slice(),
                // Optional: states written before the print fix carry no runs,
                // and restore() treats a missing stream as "plain text".
                lp11BufferRuns: this.lp11BufferRuns.map(function (runs) {
                    return runs ? runs.map(function (r) {
                        return { at: r.at, len: r.len, kind: r.kind };
                    }) : [];
                }),
                lp11CurrentLine: this.lp11CurrentLine,
                lp11LineRuns: this.lp11LineRuns.map(function (r) {
                    return { at: r.at, len: r.len, kind: r.kind };
                }),
                lp11Col: this.lp11Col,
                lp11Online: this.lp11Online,
                paper: paper,
            };
        }

        restore(state) {
            if (!state) return;
            if (typeof state.lpcs === "number") this.lpcs = state.lpcs;
            if (typeof state.lpdb === "number") this.lpdb = state.lpdb;
            if (typeof state.iMask === "number") this.iMask = state.iMask;
            if (Array.isArray(state.lp11Buffer)) this.lp11Buffer = state.lp11Buffer.slice();
            // Old states have no style runs: keep an aligned, empty stream so
            // indexes still match the buffer instead of shifting every line.
            if (Array.isArray(state.lp11BufferRuns)) {
                this.lp11BufferRuns = state.lp11BufferRuns.map(function (runs) {
                    return Lp11Paper.normalizeRuns(Array.isArray(runs) ? runs : []);
                });
            } else if (Array.isArray(state.lp11Buffer)) {
                this.lp11BufferRuns = state.lp11Buffer.map(function () { return []; });
            }
            if (typeof state.lp11CurrentLine === "string") this.lp11CurrentLine = state.lp11CurrentLine;
            if (Array.isArray(state.lp11LineRuns)) {
                this.lp11LineRuns = Lp11Paper.normalizeRuns(state.lp11LineRuns);
            }
            if (typeof state.lp11Col === "number") this.lp11Col = state.lp11Col;
            if (typeof state.lp11Online === "boolean") {
                this.lp11Online = state.lp11Online;
                if (typeof document !== "undefined") {
                    const led = document.getElementById("lp11-online-led");
                    if (led) led.classList.toggle("off", !this.lp11Online);
                    const key = document.getElementById("lp11-online-key");
                    if (key) key.classList.toggle("off", !this.lp11Online);
                }
            }
            if (state.paper) {
                this.ensureUI();
                if (this.lp11Printer && typeof this.lp11Printer.restore === "function") {
                    this.lp11Printer.restore(state.paper);
                }
            }
        }
    }

    const api = { Lp11 };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.Lp11 = Lp11;
    }
})(typeof window !== "undefined" ? window : globalThis);
