/*
 * devices/rl11.js — RL11 disk controller as a core Device (no DOM).
 *
 * Refactor stage 3 (disks): the RL11 closure of iopage.js (17774400,
 * RL01/RL02 drives, vector 0160) moves onto the headless base 1:1.
 * Register behaviour (CSR/BAR/DAR/MPR, function dispatch rlGo, completion
 * callback rlCallback, interrupt handling) is unchanged; the environment
 * seams are:
 *
 *   - memory access: host.busReadWord/busWriteWord (mapUnibus applied,
 *     exactly like iopage.js busReadWord/busWriteWord).
 *   - disk I/O:      machine.disk.io(controlBlock, op, position, address,
 *                    count, options) — the DiskService.
 *   - CPU glue:      machine.host.{trap, cpu} — Unibus timeout traps and
 *                    interrupt wake-ups.
 *
 * Drives are attached through the machine:
 *
 *   machine.mountDrive("rl0.dsk", { readBlock, writeBlock });
 *
 * The browser RL11 stays in iopage.js until the whole disk layer has
 * moved over (regression net: e2e-osboot).
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
    const RL_VECTOR   = 0o160;   // Interrupt vector
    const RL_PRIORITY = 5 << 5;  // Interrupt priority

    // --- CSR (Control/Status Register) bits ---
    const RLCS_ERR  = 0x8000; // Error summary
    const RLCS_DE   = 0x4000; // Drive error
    const RLCS_RDY  = 0x0080; // Controller ready
    const RLCS_IE   = 0x0040; // Interrupt enable
    const RLCS_MEX  = 0x0030; // Memory extension
    const RLCS_FUN  = 0x000E; // Function code
    const RLCS_GO   = 0x0001; // Go (start command)
    const RLCS_DRDY = 0x0001; // Drive ready (bit 0)

    // --- Error codes (CSR values) ---
    const RLCS_HNF = 0x9400; // Header Not Found (track/sector out of range)
    const RLCS_OPI = 0x8200; // Operation Incomplete
    const RLCS_NXM = 0xA000; // Non-existent Memory
    const RLCS_RWE = 0x8400; // Read/Write Error

    // --- Geometry constants ---
    const RL_SECTOR_SIZE = 256; // Bytes per sector (RL01/RL02)

    // --- Drive geometries ---
    const rl01Drive = { status: 0o35,  sectors: 40, tracks: 512  };
    const rl02Drive = { status: 0o235, sectors: 40, tracks: 1024 };

    // Geometry array: 2 RL02 + 2 RL01
    const geometry = [ rl02Drive, rl02Drive, rl01Drive, rl01Drive ];

    const OP_WRITE = 1;
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

    class Rl11 extends Device {
        /**
         * @param {Machine} machine  owning machine (provides disk service)
         * @param {string} id        device id ("rl0", ...)
         * @param {object} config    { regions }
         */
        constructor(machine, id, config = {}) {
            super(machine, id, config);
            this.rlControlBlock = [];
            this.reset();
        }

        /** reset() — initRL(): controller + per-drive state. */
        reset() {
            // Controller ready + Drive Ready
            this.csr = RLCS_RDY | RLCS_DRDY;
            this.bar = 0;
            this.dar = 0;
            this.mpr = 0;
            this.DAR = 0; // Internal DAR latch (seek/status ops)
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
        // rlCallback — completion callback for disk I/O operations.
        // ------------------------------------------------------------------
        rlCallback(controlBlock, code, position, address, count, options) {
            // Compute sector index from byte position
            const sector = ~~(position / RL_SECTOR_SIZE);

            // Update bus address + memory extension
            this.bar = address & 0xFFFF;
            this.csr = (this.csr & ~RLCS_MEX) | ((address >>> 12) & RLCS_MEX);

            // Update disk address (track/sector)
            this.dar = ((~~(sector / geometry[controlBlock.drive].sectors)) << 6) |
                (sector % geometry[controlBlock.drive].sectors);
            this.DAR = this.dar; // Internal latch

            // Update multipurpose register (word count remaining)
            this.mpr = (0x10000 - (count >>> 1)) & 0xFFFF;

            // --- Error handling ---
            switch (code) {
                case 0: // Success
                    break;
                case 1: // Write check error
                    this.csr |= RLCS_RWE;
                    break;
                case 2: // Non-existent memory
                    this.csr |= RLCS_NXM;
                    break;
                default: // Operation incomplete
                    this.csr |= RLCS_OPI;
                    break;
            }

            // --- Ready + interrupt handling ---
            this.csr |= RLCS_RDY | RLCS_DRDY; // Controller + drive ready
            if (this.csr & RLCS_IE) {
                this.iMask = 1; // Command completion interrupt
                this._requestInterrupt();
            }
        }

        // ------------------------------------------------------------------
        // rlGo — execute the command in the CSR.
        // ------------------------------------------------------------------
        rlGo() {
            const drive = (this.csr >>> 8) & 3; // Extract drive number (bits 8–9)

            // Clear drive ready before command
            this.csr &= ~RLCS_DRDY;

            // Lazy init control block
            if (!this.rlControlBlock[drive]) {
                this.rlControlBlock[drive] = {
                    cache: [],
                    callback: (cb, code, position, address, count, options) =>
                        this.rlCallback(cb, code, position, address, count, options),
                    url: `rl${drive}.dsk`,
                    compressed: true, // Bundled disk images ship as .zst
                    drive,
                };
            }

            switch ((this.csr >>> 1) & 7) {
                case 0: // NOP
                    break;

                case 1: // Write check (not implemented)
                    break;

                case 2: // Get status
                    if (this.mpr & 8) this.csr &= 0x3F; // Clear bits if flag set
                    this.mpr = geometry[drive].status | (this.DAR & 0o100);
                    break;

                case 3: // Seek
                    if ((this.dar & 3) === 1) {
                        if (this.dar & 4) {
                            // Forward seek
                            this.DAR = ((this.DAR + (this.dar & 0xFF80)) & 0xFF80) |
                                ((this.dar << 2) & 0x40);
                        } else {
                            // Reverse seek
                            this.DAR = ((this.DAR - (this.dar & 0xFF80)) & 0xFF80) |
                                ((this.dar << 2) & 0x40);
                        }
                        this.dar = this.DAR;
                    }
                    break;

                case 4: // Read header
                    this.mpr = this.DAR;
                    break;

                case 5: { // Write
                    // Bounds check: track/sector
                    if ((this.dar >>> 6) >= geometry[drive].tracks) {
                        this.csr |= RLCS_HNF; // Header not found
                        break;
                    }
                    if ((this.dar & 0x3F) >= geometry[drive].sectors) {
                        this.csr |= RLCS_HNF;
                        break;
                    }

                    // Compute sector, bus address, word count
                    const sectorW  = ((this.dar >>> 6) * geometry[drive].sectors) +
                        (this.dar & 0x3F);
                    const addressW = this.bar | ((this.csr & RLCS_MEX) << 12);
                    const countW   = (0x10000 - this.mpr) & 0xFFFF;

                    // Issue disk I/O (write)
                    const disk = this.machine && this.machine.disk;
                    if (!disk || typeof disk.io !== "function") {
                        this.rlCallback(this.rlControlBlock[drive], 4,
                            sectorW * RL_SECTOR_SIZE, addressW, countW << 1, null);
                        return;
                    }
                    disk.io(this.rlControlBlock[drive], OP_WRITE,
                        sectorW * RL_SECTOR_SIZE, addressW, countW << 1, null);
                    return;
                }

                case 6: // Read
                case 7: { // Read (alternate)
                    // Bounds check: track/sector
                    if ((this.dar >>> 6) >= geometry[drive].tracks) {
                        this.csr |= RLCS_HNF;
                        break;
                    }
                    if ((this.dar & 0x3F) >= geometry[drive].sectors) {
                        this.csr |= RLCS_HNF;
                        break;
                    }

                    // Compute sector, bus address, word count
                    const sectorR  = ((this.dar >>> 6) * geometry[drive].sectors) +
                        (this.dar & 0x3F);
                    const addressR = ((this.csr & RLCS_MEX) << 12) | this.bar;
                    const countR   = (0x10000 - this.mpr) & 0xFFFF;

                    // Issue disk I/O (read)
                    const disk = this.machine && this.machine.disk;
                    if (!disk || typeof disk.io !== "function") {
                        this.rlCallback(this.rlControlBlock[drive], 4,
                            sectorR * RL_SECTOR_SIZE, addressR, countR << 1, null);
                        return;
                    }
                    disk.io(this.rlControlBlock[drive], OP_READ,
                        sectorR * RL_SECTOR_SIZE, addressR, countR << 1, null);
                    return;
                }
            }

            // --- Common completion path ---
            this.csr |= RLCS_RDY | RLCS_DRDY; // Controller + drive ready
            if (this.csr & RLCS_IE) {
                this.iMask = 1; // Command completion interrupt
                this._requestInterrupt();
            }
        }

        // ------------------------------------------------------------------
        // Bus interface
        // ------------------------------------------------------------------
        access(pa, data, byteFlag) {
            let result;

            switch (pa & 0o6) {
                case 0o0: // CSR – Control/Status Register
                    result = insertData(this.csr, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        // Interrupt enable edge behavior
                        if ((result ^ this.csr) & RLCS_IE) {
                            if (result & RLCS_IE) {
                                // If RDY set and GO clear, raise idle interrupt
                                if ((result & 0x8E) === RLCS_RDY) {
                                    this.iMask = 1;
                                    this._requestInterrupt();
                                }
                            } else {
                                this.iMask = 0;
                            }
                        }

                        // Preserve ERR/DE bits, update rest
                        this.csr = (this.csr & 0xFC01) | (result & 0x03FE);

                        // If DRDY + FUN set, execute command
                        if ((this.csr & RLCS_DRDY) && (this.csr & RLCS_FUN)) {
                            this.rlGo();
                        }
                    }
                    break;

                case 0o2: // BAR – Bus Address Register
                    result = insertData(this.bar, pa, data, byteFlag);
                    if (result >= 0) this.bar = result & 0xFFFE; // Word aligned
                    break;

                case 0o4: // DAR – Disk Address Register
                    result = insertData(this.dar, pa, data, byteFlag);
                    if (result >= 0) this.dar = result;
                    break;

                case 0o6: // MPR – Multi-Purpose Register
                    result = insertData(this.mpr, pa, data, byteFlag);
                    if (result >= 0) this.mpr = result;
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
                // Service command completion interrupt
                this.iMask = 0; // Clear mask after servicing
                return RL_VECTOR; // Interrupt vector
            } else {
                // If interrupts disabled, clear mask
                if (!(this.csr & RLCS_IE)) this.iMask = 0;
                // Return priority level + pending flag
                return RL_PRIORITY | (this.iMask ? 1 : 0);
            }
        }

        // ------------------------------------------------------------------
        // L2 persistence
        // ------------------------------------------------------------------
        snapshot() {
            return {
                csr: this.csr,
                bar: this.bar,
                dar: this.dar,
                mpr: this.mpr,
                DAR: this.DAR,
                iMask: this.iMask,
            };
        }

        restore(state) {
            if (!state) return;
            if (typeof state.csr === "number") this.csr = state.csr;
            if (typeof state.bar === "number") this.bar = state.bar;
            if (typeof state.dar === "number") this.dar = state.dar;
            if (typeof state.mpr === "number") this.mpr = state.mpr;
            if (typeof state.DAR === "number") this.DAR = state.DAR;
            if (typeof state.iMask === "number") this.iMask = state.iMask;
        }
    }

    const api = { Rl11 };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.Rl11 = Rl11;
    }
})(typeof window !== "undefined" ? window : globalThis);
