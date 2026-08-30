/*
 * devices/dl11.js — console/user-terminal DL11 as a core Device (no DOM).
 *
 * Refactor stage 2, first device: the register/queue/interrupt logic of
 * the DL11 closure in iopage.js is moved onto the headless base classes
 * 1:1, with every environment touch routed through seams:
 *
 *   - output channel:  config.onOutput(ch)  — browser: g60ConsoleWrite /
 *                       vt52Write; headless: output collector.
 *   - output hook:     installOutputHook(fn) — the __consoleOutputHook
 *                       analogue (chaining + fire-and-forget per the
 *                       machine bridge contract).
 *   - drained signal:  config.onDrained() — the onConsoleInputDrained
 *                       analogue (ASR tape AUTO mode).
 *   - flush hook:      config.onFlush() — runaway-output flush on ^C /
 *                       BREAK (browser: flushG60Console; headless: no-op).
 *   - interrupts:      machine.host CPU (interruptRequested / runState),
 *                       taken via poll() like every iopage device.
 *   - timers:          machine.io.setTimer/clearTimer.
 *
 * The browser iopage.js DL11 stays in place for now; this class is the
 * headless twin, unit-tested here and wired into the browser build once
 * the disk devices have moved over (regression net: e2e-teletype*).
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests).
 */
(function (global) {
    "use strict";

    const { Device } = (typeof module !== "undefined" && module.exports)
        ? require("../core/device.js")
        : (global.yapdpCore || {});

    // --- DL11 Interrupts ---
    const DL_PRIORITY = 4 << 5; // Interrupt priority
    const DL_IMASK_RECEIVE = 1; // Interrupt mask for receive
    const DL_IMASK_TRANSMIT = 2; // Interrupt mask for transmit

    // --- RCSR (Receive Control/Status) bits ---
    const DL_RCSR_DONE = 0x80;  // Receive done
    const DL_RCSR_IE = 0x40;    // Receive interrupt enable
    // Emulated break-detected bit (see iopage.js — keeps DONE at bit 7 of
    // the low byte for byte-oriented guest drivers; break occupies 0x20).
    const DL_RCSR_BREAK = 0x20;

    // --- XCSR (Transmit Control/Status) bits ---
    const DL_XCSR_DONE = 0x80;  // Transmit done
    const DL_XCSR_IE = 0x40;    // Transmit interrupt enable

    // Time between input characters (important for paste)
    const DL_INPUT_DELAY = 3;

    /**
     * insertData — merge a byte/word write into an existing word
     * (1:1 copy of the iopage.js helper; kept local so the device is
     * self-contained).
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

    class ConsoleDL11 extends Device {
        /**
         * @param {Machine} machine  owning machine (provides bus, io, host)
         * @param {string} id        device id ("console", "tty1", ...)
         * @param {object} config    { unit, vector, onOutput, onDrained,
         *                            onFlush, regions }
         */
        constructor(machine, id, config = {}) {
            super(machine, id, config);
            this.unit = config.unit || 0;
            this.vector = config.vector || 0o60;
            this.onOutput = typeof config.onOutput === "function" ? config.onOutput : null;
            this.onDrained = typeof config.onDrained === "function" ? config.onDrained : null;
            this.onFlush = typeof config.onFlush === "function" ? config.onFlush : null;
            this._outputHook = null;
            this._timer = null;

            // --- DL11 state ---
            this.rcsr = 0;
            this.rbuf = 0;
            this.xcsr = DL_XCSR_DONE; // ready to transmit
            this.xbuf = 0;
            this.xdelay = 0;
            this.iMask = 0;
            this.typeAhead = [];
            this.receiverBusy = false;
            this.pasteCR = true;

            this.reset();
        }

        // ------------------------------------------------------------------
        // reset() — power-on / bus reset state
        // ------------------------------------------------------------------
        reset() {
            this.rcsr = 0;
            this.rbuf = 0;
            this.xcsr = DL_XCSR_DONE;
            this.xbuf = 0;
            this.xdelay = 0;
            this.typeAhead = [];
            this.iMask = 0;
        }

        // ------------------------------------------------------------------
        // Input path (operator → guest)
        // ------------------------------------------------------------------

        /** receive(bytes) — queue console input bytes (7-bit clean). */
        receive(bytes) {
            const flush = this.onFlush;
            for (const b of bytes) {
                const ch = b & 0x7F;
                this.typeAhead.push(ch);
                // ^C (ETX) on the console is the operator's interrupt key:
                // flush any runaway output backlog so it is immediately
                // visible (see flushG60Console in pdp11-app.js).
                if (this.unit === 0 && ch === 3 && flush) {
                    try { flush(); } catch (e) { /* ignore */ }
                }
            }
            this._pump();
        }

        /** breakSignal() — operator BREAK (console only). */
        breakSignal() {
            this.rcsr |= DL_RCSR_BREAK;
            if (this.rcsr & DL_RCSR_IE) {
                this.iMask |= DL_IMASK_RECEIVE;
                this._requestInterrupt();
            }
            if (this.onFlush) {
                try { this.onFlush(); } catch (e) { /* ignore */ }
            }
            // Clear the break flag after the ~150 ms loop-open duration.
            const io = this.machine ? this.machine.io : null;
            if (io && typeof io.setTimer === "function") {
                io.setTimer(() => { this.rcsr &= ~DL_RCSR_BREAK; }, 150);
            } else {
                setTimeout(() => { this.rcsr &= ~DL_RCSR_BREAK; }, 150);
            }
        }

        /** installOutputHook(fn) — the __consoleOutputHook analogue. */
        installOutputHook(fn) {
            const prev = this._outputHook;
            this._outputHook = function (ch) {
                if (prev) { try { prev(ch); } catch (e) { /* chain */ } }
                try { fn(ch); } catch (e) { /* fire-and-forget */ }
            };
            return this._outputHook;
        }

        clearOutputHook() {
            this._outputHook = null;
        }

        // ------------------------------------------------------------------
        // Typeahead pump (one byte per DL11 timing window)
        // ------------------------------------------------------------------
        _acceptChar(ch) {
            if (this.rcsr & DL_RCSR_DONE) return false; // receiver busy
            this.rbuf = ch;
            this.rcsr |= DL_RCSR_DONE;
            if (this.rcsr & DL_RCSR_IE) {
                this.iMask |= DL_IMASK_RECEIVE;
                this._requestInterrupt();
            }
            return true;
        }

        _pump() {
            if (this.receiverBusy || this.typeAhead.length === 0) return;

            if (this._acceptChar(this.typeAhead[0])) {
                this.typeAhead.shift();
                // Drained signal (ASR tape reader AUTO mode listens for it).
                if (this.unit === 0 && this.typeAhead.length === 0 &&
                    this.onDrained) {
                    try { this.onDrained(); } catch (e) { /* ignore */ }
                }
            }

            this.receiverBusy = true;
            const io = this.machine ? this.machine.io : null;
            const clear = () => {
                this.receiverBusy = false;
                this._pump();
            };
            if (io && typeof io.setTimer === "function") {
                io.setTimer(clear, DL_INPUT_DELAY);
            } else {
                setTimeout(clear, DL_INPUT_DELAY);
            }
        }

        // ------------------------------------------------------------------
        // Output path (guest → operator)
        // ------------------------------------------------------------------
        _emit(ch) {
            if (this.onOutput) {
                try { this.onOutput(ch); } catch (e) { /* ignore */ }
            }
            if (this._outputHook) {
                try { this._outputHook(ch); } catch (e) { /* ignore */ }
            }
        }

        // ------------------------------------------------------------------
        // Bus interface
        // ------------------------------------------------------------------
        access(physicalAddress, data, byteFlag) {
            let result;
            switch (physicalAddress & 0o6) {
                case 0o0: { // RCSR
                    result = insertData(this.rcsr, physicalAddress, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        if ((result ^ this.rcsr) & DL_RCSR_IE) {
                            if (result & DL_RCSR_IE) {
                                this.rcsr |= DL_RCSR_IE;
                                if (this.rcsr & DL_RCSR_DONE) {
                                    this.iMask |= DL_IMASK_RECEIVE;
                                    this._requestInterrupt();
                                }
                            } else {
                                this.rcsr &= ~DL_RCSR_IE;
                                this.iMask &= ~DL_IMASK_RECEIVE;
                            }
                        }
                    }
                    break;
                }
                case 0o2: { // RBUF
                    result = insertData(this.rbuf, physicalAddress, data, byteFlag);
                    if (result >= 0) this.rcsr &= ~DL_RCSR_DONE;
                    break;
                }
                case 0o4: { // XCSR
                    result = insertData(this.xcsr, physicalAddress, data, byteFlag);
                    if (result >= 0) {
                        if (data >= 0) { // write
                            if ((result ^ this.xcsr) & DL_XCSR_IE) {
                                if (result & DL_XCSR_IE) {
                                    if (this.xcsr & DL_XCSR_DONE) {
                                        this.xcsr = DL_XCSR_IE | DL_XCSR_DONE;
                                        this.iMask |= DL_IMASK_TRANSMIT;
                                        this._requestInterrupt();
                                    } else {
                                        this.xcsr = DL_XCSR_IE;
                                        const dev = this;
                                        setTimeout(() => {
                                            dev.xcsr |= DL_XCSR_DONE;
                                            if (dev.xcsr & DL_XCSR_IE) {
                                                dev.iMask |= DL_IMASK_TRANSMIT;
                                                dev._requestInterrupt();
                                            }
                                        }, 1);
                                    }
                                } else {
                                    this.xcsr = DL_XCSR_DONE;
                                    this.iMask &= ~DL_IMASK_TRANSMIT;
                                }
                            }
                        } else { // read
                            if (this.xdelay > 0 && --this.xdelay <= 0) {
                                this.xcsr |= DL_XCSR_DONE;
                            }
                        }
                    }
                    break;
                }
                case 0o6: { // XBUF
                    result = insertData(this.xbuf, physicalAddress, data, byteFlag);
                    if (data >= 0 && result >= 0) {
                        this.xbuf = result & 0x7f;
                        // Route everything from BEL (0x07) up to DEL (exclusive).
                        if (this.xbuf >= 7 && this.xbuf < 127) {
                            this._emit(this.xbuf);
                        }
                        if (this.xcsr & DL_XCSR_IE) {
                            this.iMask |= DL_IMASK_TRANSMIT;
                            this._requestInterrupt();
                        } else {
                            this.xcsr &= ~DL_XCSR_DONE;
                            this.xdelay = 3;
                        }
                    }
                    break;
                }
            }
            return result;
        }

        poll(takeInterrupt) {
            if (takeInterrupt) {
                if (this.iMask & DL_IMASK_RECEIVE) {
                    this.iMask &= ~DL_IMASK_RECEIVE;
                    return this.vector;
                } else if (this.iMask & DL_IMASK_TRANSMIT) {
                    this.iMask &= ~DL_IMASK_TRANSMIT;
                    return this.vector + 4;
                } else {
                    this.iMask = 0;
                    return this.vector + 4;
                }
            } else {
                return DL_PRIORITY | (this.iMask ? 1 : 0);
            }
        }

        // ------------------------------------------------------------------
        // L2 persistence
        // ------------------------------------------------------------------
        snapshot() {
            return {
                rcsr: this.rcsr,
                rbuf: this.rbuf,
                xcsr: this.xcsr,
                xbuf: this.xbuf,
                xdelay: this.xdelay,
                iMask: this.iMask,
                typeAhead: this.typeAhead.slice(),
                receiverBusy: this.receiverBusy,
                pasteCR: this.pasteCR,
            };
        }

        restore(state) {
            if (!state) return;
            if (typeof state.rcsr === "number") this.rcsr = state.rcsr;
            if (typeof state.rbuf === "number") this.rbuf = state.rbuf;
            if (typeof state.xcsr === "number") this.xcsr = state.xcsr;
            if (typeof state.xbuf === "number") this.xbuf = state.xbuf;
            if (typeof state.xdelay === "number") this.xdelay = state.xdelay;
            if (typeof state.iMask === "number") this.iMask = state.iMask;
            if (Array.isArray(state.typeAhead)) this.typeAhead = state.typeAhead.slice();
            if (typeof state.receiverBusy === "boolean") this.receiverBusy = state.receiverBusy;
            if (typeof state.pasteCR === "boolean") this.pasteCR = state.pasteCR;
        }

        // ------------------------------------------------------------------
        // Interrupt request glue (host CPU)
        // ------------------------------------------------------------------
        _requestInterrupt() {
            const cpu = this.machine && this.machine.host
                ? this.machine.host.cpu : null;
            if (cpu) {
                cpu.interruptRequested = 1;
                if (cpu.runState === 1) cpu.runState = 0; // STATE_WAIT → STATE_RUN
            }
        }
    }

    const api = { ConsoleDL11 };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.ConsoleDL11 = ConsoleDL11;
    }
})(typeof window !== "undefined" ? window : globalThis);
