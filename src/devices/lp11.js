/*
 * devices/lp11.js — LP11 line printer as a core Device (no DOM required).
 *
 * Refactor stage 3e: the LP11 closure of iopage.js (17777510, vector 0200,
 * priority 4) moves onto the Device base 1:1. Register behaviour (LPCS/
 * LPDB with the DONE-throttling + sticky ERROR semantics), the plain-text
 * job copy (lp11TextPut state machine) and the operator keys (ON LINE,
 * paper feed, top of form, tear) are here; the animated G60 printer is an
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

    /**
     * lp11PutChar — overstrike-aware character insertion (1:1 from
     * iopage.js; also covered by tests/lp11-text.test.js against the
     * iopage copy until that test moves over).
     */
    function lp11PutChar(state, ch) {
        if (state.col < state.line.length) {
            state.line = state.line.slice(0, state.col) + ch +
                state.line.slice(state.col + 1);
        } else {
            state.line += ch;
        }
        state.col++;
    }

    /**
     * lp11TextPut — plain-text accumulation state machine (1:1 from
     * iopage.js). BS/TAB/LF/CR/printable; FF records a "\f" page marker.
     */
    function lp11TextPut(state, ch) {
        if (ch === 0o12) {                 // LF: end of line
            state.buffer.push(state.line);
            state.line = "";
            state.col = 0;
        } else if (ch === 0o15) {          // CR: carriage return
            state.col = 0;
        } else if (ch === 0o14) {          // FF: form feed (page break)
            state.buffer.push(state.line + "\\f");
            state.line = "";
            state.col = 0;
        } else if (ch === 0o10) {          // BS: backspace
            if (state.col > 0) state.col--;
        } else if (ch === 0o11) {          // TAB: next 8-column stop
            state.col = (state.col + 8) & ~7;
        } else if (ch >= 0x20 && ch < 0x7F) { // printable ASCII
            lp11PutChar(state, String.fromCharCode(ch));
        }
        return state;
    }

    class Lp11 extends Device {
        constructor(machine, id, config = {}) {
            super(machine, id, config);
            this.printerWidth = config.printerWidth || 132;
            this.lpcs = LP_LPCS_DONE;
            this.lpdb = 0;
            this.iMask = 0;
            this.lp11Online = true;
            this.lp11Buffer = [];
            this.lp11CurrentLine = "";
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
            this.lp11CurrentLine = "";
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
            return this.lp11Buffer.concat([this.lp11CurrentLine]).join("\n");
        }

        print() {
            const text = this.getText();
            if (!text.trim() || typeof document === "undefined") return;
            const iframe = document.createElement("iframe");
            iframe.setAttribute("style",
                "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;");
            document.body.appendChild(iframe);
            const doc = iframe.contentWindow.document;
            doc.open();
            doc.write(
                "<!DOCTYPE html><html><head><title>LP11 output</title>" +
                "<style>body{font-family:'Courier New',monospace;font-size:12px;white-space:pre;}pre{margin:0;}</style>" +
                "</head><body><pre>" +
                text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
                "</pre></body></html>"
            );
            doc.close();
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
            setTimeout(function () {
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            }, 1000);
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
                            const st = lp11TextPut(
                                { buffer: this.lp11Buffer, line: this.lp11CurrentLine, col: this.lp11Col },
                                this.lpdb
                            );
                            this.lp11CurrentLine = st.line;
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
                lp11CurrentLine: this.lp11CurrentLine,
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
            if (typeof state.lp11CurrentLine === "string") this.lp11CurrentLine = state.lp11CurrentLine;
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
