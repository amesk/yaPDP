/*
 * devices/kw11.js — KW11-P line clock as a core Device (no DOM).
 *
 * Refactor stage 3c: the KW11-P closure of iopage.js (17777546, vector
 * 0100, priority 6, 50 Hz tick) as a DOM-free Device. The boot ROM waits
 * in WAIT for the clock tickle — without this device a headless machine
 * never wakes from WAIT.
 *
 * The periodic tick uses machine.io.setInterval (Node and browser both
 * provide it); the interrupt is taken through the normal bus poll path.
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests and the headless machine).
 */
(function (global) {
    "use strict";

    const { Device } = (typeof module !== "undefined" && module.exports)
        ? require("../core/device.js")
        : (global.yapdpCore || {});

    const KW_VECTOR = 0o100;
    const KW_PRIORITY = 6 << 5;

    const KW_CSR_MON = 0x80;
    const KW_CSR_IE = 0x40;

    const KW_TICK_MS = 20; // 50 Hz

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

    class Kw11 extends Device {
        constructor(machine, id, config = {}) {
            super(machine, id, config);
            this.tickMs = config.tickMs || KW_TICK_MS;
            this.csr = KW_CSR_MON; // MON set, IE clear
            this.iMask = 0;
            this.tickTimer = null;
            this._startTimer();
        }

        _startTimer() {
            this._stopTimer();
            const io = this.machine ? this.machine.io : null;
            const tick = () => {
                this.csr |= KW_CSR_MON;
                if (this.csr & KW_CSR_IE) {
                    this.iMask = 1;
                    this._requestInterrupt();
                }
            };
            if (io && typeof io.setInterval === "function") {
                this.tickTimer = io.setInterval(tick, this.tickMs);
            } else if (typeof setInterval === "function") {
                this.tickTimer = setInterval(tick, this.tickMs);
            }
        }

        _stopTimer() {
            if (this.tickTimer !== null) {
                const io = this.machine ? this.machine.io : null;
                if (io && typeof io.clearInterval === "function") {
                    io.clearInterval(this.tickTimer);
                } else if (typeof clearInterval === "function") {
                    clearInterval(this.tickTimer);
                }
                this.tickTimer = null;
            }
        }

        reset() {
            this.csr = KW_CSR_MON;
            this.iMask = 0;
            this._startTimer();
        }

        _requestInterrupt() {
            const cpu = this.machine && this.machine.host
                ? this.machine.host.cpu : null;
            if (cpu) {
                cpu.interruptRequested = 1;
                if (cpu.runState === 2) cpu.runState = 0; // STATE_WAIT(2) → STATE_RUN
            }
        }

        access(pa, data, byteFlag) {
            let result;
            switch (pa & 0o6) {
                case 0o6: { // CSR (17777546)
                    result = insertData(this.csr, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        if ((result ^ this.csr) & KW_CSR_IE) {
                            if (result & KW_CSR_IE) {
                                this.iMask = 1;
                                this._requestInterrupt();
                            } else {
                                this.iMask = 0;
                            }
                        }
                        this.csr = result & KW_CSR_IE;
                    }
                    return result;
                }
                default:
                    return this.machine && this.machine.host &&
                        typeof this.machine.host.trap === "function"
                        ? this.machine.host.trap(0o4, 0x10)
                        : -1; // Unibus timeout
            }
        }

        poll(takeInterrupt) {
            if (takeInterrupt) {
                this.iMask = 0;
                return KW_VECTOR;
            } else {
                if (!(this.csr & KW_CSR_IE)) this.iMask = 0;
                return KW_PRIORITY | (this.iMask ? 1 : 0);
            }
        }

        snapshot() {
            return { csr: this.csr, iMask: this.iMask };
        }

        restore(state) {
            if (!state) return;
            if (typeof state.csr === "number") this.csr = state.csr;
            if (typeof state.iMask === "number") this.iMask = state.iMask;
            // Timer keeps running; MON will be re-set by the next tick.
        }
    }

    const api = { Kw11 };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.Kw11 = Kw11;
    }
})(typeof window !== "undefined" ? window : globalThis);
