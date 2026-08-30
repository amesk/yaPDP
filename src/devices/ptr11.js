/*
 * devices/ptr11.js — PTR11 paper-tape reader + PTP11 punch as a Device.
 *
 * Refactor stage 3d: the PTR11/PTP11 closure of iopage.js (17777550-56,
 * reader vector 0070, punch vector 0074, priority 4) moves onto the
 * headless base. The reader pulls bytes through the shared DiskService
 * (OP_BYTE) with a control block per mounted tape; the punch collects
 * bytes into a buffer for export.
 *
 * Environment seams:
 *   - tape bytes:     machine.disk (mountDrive with a readBlock provider;
 *                     provider.length gives the tape size for the
 *                     end-of-tape condition).
 *   - UI hooks:       config.onTapeState("none|at-start|ready|consumed")
 *                     and config.onPunchSize(bytes) — the Storage page
 *                     indicator; optional, no-op in headless.
 *   - interrupts:     machine.host.cpu, taken via bus poll (as iopage).
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests and the headless machine).
 */
(function (global) {
    "use strict";

    const { Device } = (typeof module !== "undefined" && module.exports)
        ? require("../core/device.js")
        : (global.yapdpCore || {});

    // --- PTR11 (reader) ---
    const PTR_VECTOR = 0o070;
    const PTR_PRIORITY = 4 << 5;
    const PTR_ERR = 0x8000;
    const PTR_BUSY = 0x0800;
    const PTR_DONE = 0x0080;
    const PTR_IE = 0x0040;
    const PTR_GO = 0x0001;

    // --- PTP11 (punch) ---
    const PTP_VECTOR = 0o074;
    const PTP_PRIORITY = 4 << 5;
    const PTP_ERR = 0x8000;
    const PTP_BUSY = 0x0800;
    const PTP_DONE = 0x0080;
    const PTP_IE = 0x0040;
    const PTP_GO = 0x0001;

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

    class PtrPtp extends Device {
        constructor(machine, id, config = {}) {
            super(machine, id, config);
            this.onTapeState = typeof config.onTapeState === "function" ? config.onTapeState : null;
            this.onPunchSize = typeof config.onPunchSize === "function" ? config.onPunchSize : null;
            this.tapeState = "none";
            this.ptControlblock = undefined;
            this.punchBuffer = [];
            this.reset();
        }

        _requestInterrupt() {
            const cpu = this.machine && this.machine.host
                ? this.machine.host.cpu : null;
            if (cpu) {
                cpu.interruptRequested = 1;
                if (cpu.runState === 2) cpu.runState = 0; // STATE_WAIT → STATE_RUN
            }
        }

        _disk() {
            return this.machine ? this.machine.disk : null;
        }

        _setTapeState(state) {
            if (this.tapeState === state) return;
            this.tapeState = state;
            if (this.onTapeState) {
                try { this.onTapeState(state); } catch (e) { /* ignore */ }
            }
        }

        _punchSizeChanged() {
            if (this.onPunchSize) {
                try { this.onPunchSize(this.punchBuffer.length); } catch (e) { /* ignore */ }
            }
        }

        /** reset() — initPTR: all flags cleared, tape forgotten. */
        reset() {
            this.ptrcs = 0;
            this.ptrdb = 0;
            this.iMask = 0;
            this.ptControlblock = undefined;
            this.ptpcs = PTP_DONE;
            this.ptpdb = 0;
            this.ptpIMask = 0;
            this.dbwWritten = false;
            this._setTapeState("none");
        }

        /**
         * loadTape(url) — mount a paper tape (replaces rewindTape()'s
         * forget-and-recreate). Callers: UI (Storage select) and tools.
         */
        loadTape(url) {
            this.ptControlblock = {
                cache: [],
                callback: (cb, code, position, address, count, options) =>
                    this.ptCallback(cb, code, position, address, count, options),
                url: url,
                compressed: true, // bundled tapes ship as .zst
                position: 0,
            };
            this.ptrcs &= ~(PTR_ERR | PTR_BUSY | PTR_GO);
            this.iMask = 0;
            this._setTapeState("at-start");
            return this.ptControlblock;
        }

        /** rewind() — forget the current tape (position resets on next load). */
        rewind() {
            this.ptControlblock = undefined;
            this.ptrcs &= ~(PTR_ERR | PTR_BUSY | PTR_GO);
            this.iMask = 0;
            this.ptpcs &= ~(PTP_ERR | PTP_BUSY | PTP_GO);
            this.ptpIMask = 0;
            this._setTapeState("none");
        }

        /** clearPunch() — discard the punched output buffer. */
        clearPunch() {
            this.punchBuffer = [];
            this._punchSizeChanged();
        }

        /** punchBytes() — copy of the punched output (for export). */
        punchBytes() {
            return this.punchBuffer.slice();
        }

        // ------------------------------------------------------------------
        // PTP punch
        // ------------------------------------------------------------------
        punchByte() {
            this.punchBuffer.push(this.ptpdb & 0xFF);
            this._punchSizeChanged();
            this.ptpcs = (this.ptpcs | PTP_DONE) & ~PTP_BUSY;
            if (this.ptpcs & PTP_IE) {
                this.ptpIMask = 1;
                this._requestInterrupt();
            }
        }

        // ------------------------------------------------------------------
        // PTR completion
        // ------------------------------------------------------------------
        ptCallback(controlBlock, code, position, address, count, options) {
            controlBlock.position = position;
            this.ptrdb = address & 0xFF;
            if (code) {
                this.ptrcs |= PTR_ERR;
            }
            if (this.ptrcs & PTR_IE) {
                this.iMask = 1;
                this._requestInterrupt();
            }
            this.ptrcs = (this.ptrcs | PTR_DONE) & ~PTR_BUSY;
        }

        // ------------------------------------------------------------------
        // Bus interface
        // ------------------------------------------------------------------
        access(pa, data, byteFlag) {
            let result;
            switch (pa & 0o6) {
                case 0o0: // PTRCS
                    result = insertData(this.ptrcs, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        if ((result ^ this.ptrcs) & PTR_IE) {
                            if (result & PTR_IE) {
                                this.iMask = 1;
                                this._requestInterrupt();
                            } else {
                                this.iMask = 0;
                            }
                        }
                        this.ptrcs = (this.ptrcs & ~(PTR_IE | PTR_GO)) | (result & (PTR_IE | PTR_GO));

                        if (this.ptControlblock === undefined) {
                            this.ptrcs = (this.ptrcs & ~PTR_GO) | PTR_ERR;
                        }

                        if ((this.ptrcs & (PTR_ERR | PTR_BUSY | PTR_GO)) === PTR_GO) {
                            this.ptrcs = (this.ptrcs & ~PTR_GO) | PTR_BUSY;
                            const disk = this._disk();
                            const url = this.ptControlblock.url;
                            const len = disk && typeof disk.tapeLength === "function"
                                ? disk.tapeLength(url) : undefined;
                            if (len !== undefined && this.ptControlblock.position >= len) {
                                // End of a mounted tape: signal end-of-tape (ERR)
                                // so the guest driver finishes the transfer.
                                this.ptrcs = (this.ptrcs & ~PTR_BUSY) | PTR_ERR | PTR_DONE;
                                this._setTapeState("consumed");
                                if (this.ptrcs & PTR_IE) {
                                    this.iMask = 1;
                                    this._requestInterrupt();
                                }
                            } else {
                                this._setTapeState("ready");
                                if (disk && typeof disk.io === "function") {
                                    disk.io(this.ptControlblock, 5 /* OP_BYTE */,
                                        this.ptControlblock.position, 0o17777552, 1, null);
                                } else {
                                    this.ptrcs = (this.ptrcs & ~PTR_BUSY) | PTR_ERR | PTR_DONE;
                                }
                            }
                        }
                    }
                    break;

                case 0o2: // PTRDB
                    result = insertData(this.ptrdb, pa, data, byteFlag);
                    if (result >= 0) {
                        this.ptrcs &= ~PTR_DONE;
                    }
                    break;

                case 0o4: // PTPCS
                    result = insertData(this.ptpcs, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        if ((result ^ this.ptpcs) & PTP_IE) {
                            if (result & PTP_IE) {
                                this.ptpIMask = 1;
                                this._requestInterrupt();
                            } else {
                                this.ptpIMask = 0;
                            }
                            this.ptpcs = (this.ptpcs & ~PTP_IE) | (result & PTP_IE);
                        }
                        if (result & PTP_GO) {
                            this.ptpcs = (this.ptpcs & ~(PTP_GO | PTP_DONE)) | PTP_BUSY;
                            if (this.dbwWritten) {
                                this.ptpcs = (this.ptpcs & ~PTP_BUSY) | PTP_DONE;
                                if (this.ptpcs & PTP_IE) {
                                    this.ptpIMask = 1;
                                    this._requestInterrupt();
                                }
                            } else {
                                this.punchByte();
                            }
                            this.dbwWritten = false;
                        }
                    }
                    break;

                case 0o6: // PTPDB
                    result = insertData(this.ptpdb, pa, data, byteFlag);
                    if (data >= 0) {
                        this.ptpdb = result & 0xFF;
                        this.dbwWritten = true;
                        if (!(this.ptpcs & PTP_BUSY)) {
                            this.ptpcs = (this.ptpcs & ~PTP_DONE) | PTP_BUSY;
                            this.punchByte();
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
                if (this.iMask) {
                    this.iMask = 0;
                    return PTR_VECTOR;
                }
                this.ptpIMask = 0;
                return PTP_VECTOR;
            } else {
                if (!(this.ptrcs & PTR_IE)) this.iMask = 0;
                if (!(this.ptpcs & PTP_IE)) this.ptpIMask = 0;
                return PTR_PRIORITY | ((this.iMask || this.ptpIMask) ? 1 : 0);
            }
        }

        snapshot() {
            return {
                ptrcs: this.ptrcs,
                ptrdb: this.ptrdb,
                iMask: this.iMask,
                ptpcs: this.ptpcs,
                ptpdb: this.ptpdb,
                ptpIMask: this.ptpIMask,
                punchBuffer: this.punchBuffer.slice(),
            };
        }

        restore(state) {
            if (!state) return;
            if (typeof state.ptrcs === "number") this.ptrcs = state.ptrcs;
            if (typeof state.ptrdb === "number") this.ptrdb = state.ptrdb;
            if (typeof state.iMask === "number") this.iMask = state.iMask;
            if (typeof state.ptpcs === "number") this.ptpcs = state.ptpcs;
            if (typeof state.ptpdb === "number") this.ptpdb = state.ptpdb;
            if (typeof state.ptpIMask === "number") this.ptpIMask = state.ptpIMask;
            if (Array.isArray(state.punchBuffer)) this.punchBuffer = state.punchBuffer.slice();
        }
    }

    const api = { PtrPtp };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.PtrPtp = PtrPtp;
    }
})(typeof window !== "undefined" ? window : globalThis);
