/*
 * devices/tm11.js — TM11 magtape controller as a core Device (no DOM).
 *
 * Refactor stage 3 (tapes): the TM11 closure of iopage.js (17772520,
 * TU10 drives, vector 0224) moves onto the headless base 1:1. Register
 * behaviour (MTS/MTC/MTBRC/MTCMA/MTD/MTRD, function dispatch tmGo,
 * completion callback mtCallback, interrupt handling) is unchanged; the
 * environment seams are:
 *
 *   - memory access: host.busReadWord/busWriteWord (mapUnibus applied,
 *     exactly like iopage.js busReadWord/busWriteWord).
 *   - tape I/O:      machine.disk.io(controlBlock, op, position, address,
 *                    count, options) — the DiskService (OP_ACCUM reads a
 *                    record-length word, OP_READ copies record data).
 *   - CPU glue:      machine.host.{trap, cpu} — Unibus timeout traps and
 *                    interrupt wake-ups.
 *
 * Drives are attached through the machine:
 *
 *   machine.mountDrive("tm0.tap", { readBlock, writeBlock });
 *
 * Per-drive position/command state lives in the control block (as in
 * iopage.js), so snapshotting the registers alone is not enough for L2 —
 * the control blocks are rebuilt lazily and repositioned on demand.
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests and the headless machine).
 */
(function (global) {
    "use strict";

    const { Device } = (typeof module !== "undefined" && module.exports)
        ? require("../core/device.js")
        : (global.yapdpCore || {});

    // --- Interrupts ---
    const TM_VECTOR   = 0o224;   // Interrupt vector
    const TM_PRIORITY = 5 << 5;  // Interrupt priority

    // --- MTS (Status) bits ---
    const MTS_ILC = 0x8000; // Illegal command
    const MTS_EOF = 0x4000; // End-of-file (tape mark)
    const MTS_EOT = 0x0400; // End-of-tape
    const MTS_RLE = 0x0200; // Record length error
    const MTS_SEL = 0x0040; // Unit selected
    const MTS_BOT = 0x0020; // Beginning of tape
    const MTS_WRL = 0x0004; // Write locked
    const MTS_REW = 0x0002; // Rewinding
    const MTS_RDY = 0x0001; // Ready

    // --- MTC (Command) bits ---
    const MTC_ERR  = 0x8000; // Error summary
    const MTC_DEN  = 0x6000; // Density mask (preserved)
    const MTC_UNIT = 0x0700; // Unit select
    const MTC_INIT = 0x1000; // Initialize (controller reset)
    const MTC_RDY  = 0x0080; // Controller ready
    const MTC_IE   = 0x0040; // Interrupt enable
    const MTC_FUN  = 0x000E; // Function code
    const MTC_GO   = 0x0001; // Start command

    // --- Function codes (decoded from MTC_FUN >> 1) ---
    const TM_FUN_OFFLINE   = 0; // Offline / no-op
    const TM_FUN_READ      = 1; // Read record
    const TM_FUN_WRITE     = 2; // Write (not implemented)
    const TM_FUN_WEOF      = 3; // Write EOF (not implemented)
    const TM_FUN_SPACE_F   = 4; // Space forward (skip record)
    const TM_FUN_SPACE_R   = 5; // Space reverse (skip record)
    const TM_FUN_WRITE_X   = 6; // Write with extended IRG (error)
    const TM_FUN_REWIND    = 7; // Rewind

    const MAXDRIVE = 3;

    const OP_ACCUM = 4;
    const OP_READ = 2;

    /**
     * insertData — merge a byte/word write into an existing word (local
     * copy of the iopage.js helper; keeps the device self-contained).
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

    class Tm11 extends Device {
        /**
         * @param {Machine} machine  owning machine (provides disk service)
         * @param {string} id        device id ("tm0", ...)
         * @param {object} config    { regions }
         */
        constructor(machine, id, config = {}) {
            super(machine, id, config);
            this.mtControlBlock = [];
            this.reset();
        }

        /** reset() — initTM(): controller + per-drive state. */
        reset() {
            // Default status: unit selected, BOT set, write locked, ready
            this.mts = MTS_SEL | MTS_BOT | MTS_WRL | MTS_RDY;
            // Command register: density preserved, controller RDY set, IE clear
            this.mtc = 0x6080;
            this.mtbrc = 0;
            this.mtcma = 0;
            this.mtrd = 0;
            this.iMask = 0;
        }

        _cpu() {
            return this.machine && this.machine.host
                ? this.machine.host.cpu : null;
        }

        /** _requestInterrupt() — wake the host CPU. */
        _requestInterrupt() {
            const cpu = this._cpu();
            if (cpu) {
                cpu.interruptRequested = 1;
                if (cpu.runState === 2) cpu.runState = 0; // STATE_WAIT(2) → STATE_RUN
            }
        }

        _readWord(ba) {
            return this.machine && this.machine.host &&
                typeof this.machine.host.busReadWord === "function"
                ? this.machine.host.busReadWord(ba) : -1;
        }

        _writeWord(ba, data) {
            return this.machine && this.machine.host &&
                typeof this.machine.host.busWriteWord === "function"
                ? this.machine.host.busWriteWord(ba, data) : -1;
        }

        // ------------------------------------------------------------------
        // mtCallback — completion callback for TM11 tape I/O operations.
        // ------------------------------------------------------------------
        mtCallback(controlBlock, code, position, address, count, options) {
            // --- Record boundary handling ---
            if (code === 0 && controlBlock.command > 0) {
                if (address === 0 || address > 0x80000000) {
                    // Tape mark (EOF)
                    controlBlock.position = (position + 1) & ~1;
                    this.mtc |= MTC_ERR;
                    this.mts |= MTS_EOF;
                } else {
                    switch (controlBlock.command) {
                        case TM_FUN_READ: {
                            // Record read: address holds length; follow-up copies data
                            controlBlock.position = (position + 4 + address + 1) & ~1;
                            controlBlock.command = 0;

                            // Compute bytes to transfer
                            let bytesToTransfer = (0x10000 - this.mtbrc) & 0xFFFF;
                            if (bytesToTransfer >= address || bytesToTransfer === 0) {
                                bytesToTransfer = address;
                                this.mtbrc = (this.mtbrc + bytesToTransfer) & 0xFFFF;
                            } else {
                                this.mts |= MTS_RLE; // Partial transfer due to word count
                                this.mtbrc = 0;
                            }

                            // Issue diskIO to copy data into memory
                            const busAddr = ((this.mtc & 0x30) << 12) | this.mtcma;
                            const disk = this.machine && this.machine.disk;
                            if (!disk || typeof disk.io !== "function") {
                                // No disk service: treat as a tape error.
                                this.mts |= 0x100;
                                this.mts |= MTS_RDY;
                                this.mtc |= MTC_RDY;
                                if (this.mtc & MTC_IE) {
                                    this.iMask |= 1;
                                    this._requestInterrupt();
                                }
                                return;
                            }
                            disk.io(controlBlock, OP_READ, position, busAddr,
                                bytesToTransfer, null);
                            return;
                        }
                        case TM_FUN_SPACE_F: {
                            // Space forward over record
                            controlBlock.position = (position + 4 + address + 1) & ~1;
                            this.mtbrc = (this.mtbrc + 1) & 0xFFFF;
                            if (this.mtbrc) {
                                const disk = this.machine && this.machine.disk;
                                if (disk && typeof disk.io === "function") {
                                    disk.io(controlBlock, OP_ACCUM,
                                        controlBlock.position, 0, 4, null);
                                    return;
                                }
                            }
                            break;
                        }
                        case TM_FUN_SPACE_R: {
                            // Space reverse over record
                            controlBlock.position = (position - 8 - address + 1) & ~1;
                            this.mtbrc = (this.mtbrc + 1) & 0xFFFF;
                            if (this.mtbrc && controlBlock.position > 0) {
                                const disk = this.machine && this.machine.disk;
                                if (disk && typeof disk.io === "function") {
                                    disk.io(controlBlock, OP_ACCUM,
                                        controlBlock.position - 4, 0, 4, null);
                                    return;
                                }
                            }
                            break;
                        }
                        default:
                            // Unexpected command — bail out like iopage.js
                            // panic(): complete with a tape error instead of
                            // crashing the host.
                            this.mts |= 0x100;
                            break;
                    }
                }
            }

            // --- Common completion bookkeeping ---
            if (controlBlock.command === 0) {
                this.mtbrc = (this.mtbrc - count) & 0xFFFF;
                this.mtcma = address & 0xFFFF;
                this.mtc = (this.mtc & ~0x30) | ((address >>> 12) & 0x30); // Preserve density/page bits
            }

            // --- Error mapping ---
            switch (code) {
                case 0: break;              // Success
                case 1: this.mts |= 0x100; break; // Bad tape error
                case 2: this.mts |= 0x80;  break; // NXM
                default: this.mts |= 0x100; break; // Generic tape error
            }

            // --- Ready + interrupt handling ---
            if (this.mtc & MTC_IE) {
                this.iMask |= 1; // Command/data completion
                this._requestInterrupt();
            }
            this.mts |= MTS_RDY;
            this.mtc |= MTC_RDY;
        }

        // ------------------------------------------------------------------
        // tmGo — execute the command in the MTC.
        // ------------------------------------------------------------------
        tmGo() {
            const drive = (this.mtc >>> 8) & 3; // Extract drive number (bits 8–10)

            // Clear controller ready, GO, ERR before command
            this.mtc &= ~(MTC_ERR | MTC_RDY | MTC_GO);
            this.mts &= ~0xFF80; // Clear high error/status cluster (EOF/EOT/RLE/ILC, etc.)

            // Validate unit
            if (drive > MAXDRIVE) {
                this.mtc |= MTC_ERR;
                this.mts |= MTS_ILC; // Illegal command
                this.mts &= ~(MTS_SEL | MTS_RDY);
                return;
            }

            // Select unit
            this.mts |= MTS_SEL;

            // Lazy init control block
            if (!this.mtControlBlock[drive]) {
                this.mtControlBlock[drive] = {
                    cache: [],
                    callback: (cb, code, position, address, count, options) =>
                        this.mtCallback(cb, code, position, address, count, options),
                    url: `tm${drive}.tap`,
                    compressed: true, // Bundled tape images ship as .zst
                    drive,
                    position: 0,
                    command: 0,
                };
            }

            // Decode function code
            const fun = (this.mtc & MTC_FUN) >>> 1;
            this.mtControlBlock[drive].command = fun;

            const disk = this.machine && this.machine.disk;
            const hasDisk = disk && typeof disk.io === "function";

            switch (fun) {
                case TM_FUN_OFFLINE: // No-op
                    break;

                case TM_FUN_READ: // Read record
                    // Fetch next record length
                    if (hasDisk) {
                        disk.io(this.mtControlBlock[drive], OP_ACCUM,
                            this.mtControlBlock[drive].position, 0, 4, null);
                        return;
                    }
                    break;

                case TM_FUN_WRITE: // Write (not supported)
                case TM_FUN_WEOF:  // Write EOF (not supported)
                case TM_FUN_WRITE_X: // Extended write (not supported)
                    this.mtc |= MTC_ERR;
                    this.mts |= MTS_WRL | MTS_ILC; // Write locked + illegal command
                    break;

                case TM_FUN_SPACE_F: // Space forward
                    if (hasDisk) {
                        disk.io(this.mtControlBlock[drive], OP_ACCUM,
                            this.mtControlBlock[drive].position, 0, 4, null);
                        return;
                    }
                    break;

                case TM_FUN_SPACE_R: // Space reverse
                    if (this.mtControlBlock[drive].position > 0 && hasDisk) {
                        disk.io(this.mtControlBlock[drive], OP_ACCUM,
                            this.mtControlBlock[drive].position - 4, 0, 4, null);
                        return;
                    }
                    break;

                case TM_FUN_REWIND: // Rewind
                    if (this.mtControlBlock[drive].position !== 0) {
                        this.mtControlBlock[drive].position = 0;
                        if (this.mtc & MTC_IE) {
                            this.iMask |= 2; // Rewind completion interrupt
                        }
                    }
                    this.mts &= ~MTS_REW;
                    this.mts |= MTS_BOT | MTS_RDY;
                    break;

                default:
                    this.mts |= MTS_ILC; // Illegal command
                    break;
            }

            // --- Command complete interrupt ---
            if (this.mtc & MTC_IE) {
                this.iMask |= 1; // Command/data completion
                this._requestInterrupt();
            }

            // Controller ready after command
            this.mtc |= MTC_RDY;
        }

        // ------------------------------------------------------------------
        // Bus interface
        // ------------------------------------------------------------------
        access(pa, data, byteFlag) {
            let result;

            switch (pa & 0o16) {
                case 0o00: // MTS – Status Register
                    // BOT is volatile based on position; recompute dynamically
                    this.mts &= ~MTS_BOT;
                    {
                        const drive = (this.mtc >>> 8) & 3;
                        const cb = this.mtControlBlock[drive];
                        if (cb && cb.position === 0) this.mts |= MTS_BOT;
                    }
                    result = this.mts;
                    break;

                case 0o02: // MTC – Command Register
                    result = insertData(this.mtc, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        if (result & MTC_INIT) {
                            // Controller reset
                            this.reset();
                        } else {
                            // Interrupt enable edge behavior
                            if ((result ^ this.mtc) & MTC_IE) {
                                if (result & MTC_IE) {
                                    // If RDY set and GO clear, raise idle interrupt
                                    if ((this.mtc & MTC_RDY) && !(result & MTC_GO)) {
                                        this.iMask |= 1;
                                        this._requestInterrupt();
                                    }
                                } else {
                                    this.iMask = 0;
                                }
                            }

                            // Preserve RDY, mask writable bits
                            this.mtc = (this.mtc & MTC_RDY) | (result & 0x7F7F);

                            // If RDY + GO set, start command
                            if ((this.mtc & (MTC_RDY | MTC_GO)) === (MTC_RDY | MTC_GO)) {
                                this.tmGo();
                            }
                        }
                    }
                    break;

                case 0o04: // MTBRC – Byte Record Counter
                    result = insertData(this.mtbrc, pa, data, byteFlag);
                    if (result >= 0) this.mtbrc = result;
                    break;

                case 0o06: // MTCMA – Current Memory Address
                    result = insertData(this.mtcma, pa, data, byteFlag);
                    if (result >= 0) this.mtcma = result;
                    break;

                case 0o10: // MTD – Data Buffer (unused)
                    result = 0;
                    break;

                case 0o12: // MTRD – Read Lines (timing hack)
                    this.mtrd ^= 0x80FF; // Preserve timing behavior used by RSTS
                    result = this.mtrd;
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
                if (this.iMask & 1) {
                    // Service command/data completion
                    this.iMask &= ~1;
                } else {
                    // Service rewind completion
                    this.iMask = 0;
                }
                return TM_VECTOR; // Interrupt vector
            } else {
                // If interrupts disabled, clear mask
                if (!(this.mtc & MTC_IE)) this.iMask = 0;
                // Return priority level + pending flag
                return TM_PRIORITY | (this.iMask ? 1 : 0);
            }
        }

        // ------------------------------------------------------------------
        // L2 persistence
        // ------------------------------------------------------------------
        snapshot() {
            return {
                mts: this.mts,
                mtc: this.mtc,
                mtbrc: this.mtbrc,
                mtcma: this.mtcma,
                mtrd: this.mtrd,
                iMask: this.iMask,
            };
        }

        restore(state) {
            if (!state) return;
            if (typeof state.mts === "number") this.mts = state.mts;
            if (typeof state.mtc === "number") this.mtc = state.mtc;
            if (typeof state.mtbrc === "number") this.mtbrc = state.mtbrc;
            if (typeof state.mtcma === "number") this.mtcma = state.mtcma;
            if (typeof state.mtrd === "number") this.mtrd = state.mtrd;
            if (typeof state.iMask === "number") this.iMask = state.iMask;
        }
    }

    const api = { Tm11 };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.Tm11 = Tm11;
    }
})(typeof window !== "undefined" ? window : globalThis);
