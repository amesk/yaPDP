/*
 * devices/rk11.js — RK11 disk controller as a core Device (no DOM).
 *
 * Refactor stage 3 (disks): the RK11 closure of iopage.js moves onto the
 * headless base 1:1. Register behaviour (RKDS/RKER/RKCS/RKWK/RKBA/RKDA),
 * command dispatch (rkGo), completion callback (rkCallback) and interrupt
 * handling are unchanged; the two environment seams are:
 *
 *   - disk I/O:     machine.disk.io(controlBlock, op, position, address,
 *                   count, options) — the DiskService (block cache +
 *                   readBlock/writeBlock providers), replacing the global
 *                   diskIO/fetchBlock/DiskStore path.
 *   - CPU glue:     machine.host.{trap, cpu} — Unibus timeout traps and
 *                   interrupt wake-ups.
 *
 * Drives are attached through the machine:
 *
 *   machine.mountDrive("rk0.dsk", { readBlock, writeBlock });
 *
 * The browser RK11 stays in iopage.js until the whole disk layer has moved
 * over (regression net: disk-path.test.js, e2e-osboot, e2e-snapshots).
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests).
 */
(function (global) {
    "use strict";

    const { Device } = (typeof module !== "undefined" && module.exports)
        ? require("../core/device.js")
        : (global.yapdpCore || {});

    // --- Interrupts ---
    const RK_VECTOR = 0o220;   // Interrupt vector
    const RK_PRIORITY = 5 << 5; // Interrupt priority

    // --- Geometry ---
    const RK_SECTOR_SIZE = 512; // Bytes per sector (RK05)

    // --- CSR bits ---
    const RKCS_ERR = 0x8000;
    const RKCS_HARD = 0x4000;
    const RKCS_RDY = 0x0080;
    const RKCS_IE = 0x0040;
    const RKCS_MEX = 0x0030;
    const RKCS_FUN = 0x000E;
    const RKCS_GO = 0x0001;

    // --- Drive Status bits ---
    const RKDS_ID = 0xE000;
    const RKDS_RK05 = 0x0800;
    const RKDS_SOK = 0x0100;
    const RKDS_DRY = 0x0080;
    const RKDS_RDY = 0x0040;
    const RKDS_SECT = 0x000F;

    // --- Error Register bits ---
    const RKER_WCE = 0x8000;
    const RKER_SKE = 0x4000;
    const RKER_NXM = 0x0400;
    const RKER_NXS = 0x0020;
    const RKER_NXC = 0x0040;
    const RKER_NXD = 0x0080;

    // --- Local interrupt masks ---
    const IMASK_COMMAND = 0x0100;
    const IMASK_DRIVE = 0x0001;

    // --- Drive geometries ---
    const idleDrive = { sectors: 0, tracks: 0 };
    const rk05Drive = { sectors: 12, tracks: 406 };

    const geometry = [
        rk05Drive, rk05Drive, rk05Drive, rk05Drive,
        rk05Drive, rk05Drive, idleDrive, idleDrive
    ];

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

    class Rk11 extends Device {
        /**
         * @param {Machine} machine  owning machine (provides disk service)
         * @param {string} id        device id ("rk1", ...)
         * @param {object} config    { regions, drives: [url,...] }
         */
        constructor(machine, id, config = {}) {
            super(machine, id, config);
            this.rkControlBlock = [];
            this._commandTimers = [];
            this.reset();
        }

        /** reset() — controller + drive state (initRK). */
        reset() {
            this.rkds = RKDS_RK05 | RKDS_SOK | RKDS_DRY | RKDS_RDY;
            this.rker = 0;
            this.rkcs = RKCS_RDY;
            this.rkwc = 0;
            this.rkba = 0;
            this.rkda = 0;
            this.iMask = 0;
        }

        /** _controlBlockFor(drive) — lazy per-drive control block. */
        _controlBlockFor(drive) {
            if (!this.rkControlBlock[drive]) {
                this.rkControlBlock[drive] = {
                    cache: [],
                    callback: (cb, code, position, address, count, options) =>
                        this.rkCallback(cb, code, position, address, count, options),
                    url: `rk${drive}.dsk`,
                    compressed: true,
                    drive,
                };
            }
            return this.rkControlBlock[drive];
        }

        /** _requestInterrupt() — wake the host CPU. */
        _requestInterrupt() {
            const cpu = this.machine && this.machine.host
                ? this.machine.host.cpu : null;
            if (cpu) {
                cpu.interruptRequested = 1;
                if (cpu.runState === 2) cpu.runState = 0; // STATE_WAIT(2) → STATE_RUN
            }
        }

        // ------------------------------------------------------------------
        // rkCallback — completion callback for disk I/O operations.
        // ------------------------------------------------------------------
        rkCallback(controlBlock, code, position, address, count, options) {
            if (process.env.DEBUG_DISK) console.log("RK.callback code=" + code + " pos=" + position + " addr=" + address + " count=" + count);
            this.rkba = address & 0xFFFF;
            this.rkcs = (this.rkcs & ~RKCS_MEX) | ((address >>> 12) & RKCS_MEX);
            this.rkwc = (0x10000 - (count >>> 1)) & 0xFFFF;
            position = ~~(position / RK_SECTOR_SIZE);
            const geom = geometry[controlBlock.drive];
            this.rkda = (this.rkda & 0xE000) |
                ((~~(position / geom.sectors)) << 4) |
                (position % geom.sectors);

            switch (code) {
                case 0: this.rkcs |= RKCS_RDY; break;
                case 1: this.rker |= RKER_WCE; this.rkcs |= RKCS_ERR | RKCS_HARD; break;
                case 2: this.rker |= RKER_NXM; this.rkcs |= RKCS_ERR | RKCS_HARD; break;
                case 3: this.rker |= RKER_WCE; this.rkcs |= RKCS_ERR; break;
                default: this.rker |= RKER_SKE; this.rkcs |= RKCS_ERR | RKCS_HARD; break;
            }

            this.rkds = (controlBlock.drive << 13) | (this.rkds & 0x1FF0);
            this.rkcs |= RKCS_RDY;
            if (this.rkcs & RKCS_IE) {
                this.iMask |= IMASK_COMMAND;
                this._requestInterrupt();
            }
        }

        // ------------------------------------------------------------------
        // rkGo — execute the command in the CSR.
        // ------------------------------------------------------------------
        rkGo() {
            const drive = (this.rkda >>> 13) & 7;
            this.rkcs &= ~(RKCS_ERR | RKCS_GO | RKCS_RDY);
            this.rker &= ~0x03;

            switch ((this.rkcs & RKCS_FUN) >>> 1) {
                case 0: // Controller reset
                    this.reset();
                    break;

                case 1: // Write
                case 2: // Read
                case 3: // Check
                    if (geometry[drive].tracks === 0) {
                        this.rker |= RKER_NXD;
                        break;
                    }
                    if (((this.rkda >>> 4) & 0x1FF) >= geometry[drive].tracks) {
                        this.rker |= RKER_NXC;
                        break;
                    }
                    if ((this.rkda & 0xF) >= geometry[drive].sectors) {
                        this.rker |= RKER_NXS;
                        break;
                    }

                    const cb = this._controlBlockFor(drive);
                    const sector = (((this.rkda >>> 4) & 0x1FF) * geometry[drive].sectors) +
                        (this.rkda & 0xF);
                    const address = ((this.rkcs & RKCS_MEX) << 12) | this.rkba;
                    const count = (0x10000 - this.rkwc) & 0xFFFF;
                    const disk = this.machine && this.machine.disk;

                    if (!disk || typeof disk.io !== "function") {
                        // No disk service: fail with a network-style error.
                        this.rkCallback(cb, 9, sector * RK_SECTOR_SIZE, address, count, null);
                        return;
                    }
                    // count is in WORDS; disk.io transfers BYTES.
                    disk.io(cb, (this.rkcs >>> 1) & 7, sector * RK_SECTOR_SIZE, address, count << 1, null);
                    return;

                case 4: // Seek
                case 6: // Drive reset
                    this.rkds = (drive << 13) | (this.rkds & 0x1FF0);
                    if (this.rkcs & RKCS_IE) {
                        this.iMask |= IMASK_COMMAND | (IMASK_DRIVE << drive);
                        this._requestInterrupt();
                    } else {
                        this.rkcs |= 0x2000;
                    }
                    this.rkcs |= RKCS_RDY;
                    return;

                default:
                    this.rker |= RKER_SKE;
                    this.rkcs |= RKCS_ERR | RKCS_HARD;
                    break;
            }

            this.rkds = (drive << 13) | (this.rkds & 0x1FF0);
            this.rkcs |= RKCS_RDY;
            if (this.rkcs & RKCS_IE) {
                this.iMask |= IMASK_COMMAND;
                this._requestInterrupt();
            }
        }

        // ------------------------------------------------------------------
        // Bus interface
        // ------------------------------------------------------------------
        access(pa, data, byteFlag) {
            let result;
            switch (pa & 0o16) {
                case 0o00: // RKDS
                    result = insertData(this.rkds, pa, data, byteFlag);
                    break;

                case 0o02: // RKER
                    result = insertData(this.rker, pa, data, byteFlag);
                    break;

                case 0o04: // RKCS
                    result = insertData(this.rkcs, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        this.rkcs = (result & ~0xF080) | (this.rkcs & 0xF080);
                        if (!(this.rkcs & RKCS_IE)) this.iMask = 0;
                        if ((this.rkcs & (RKCS_RDY | RKCS_GO)) === (RKCS_RDY | RKCS_GO)) {
                            this.rkGo();
                        }
                    }
                    break;

                case 0o06: // RKWK
                    result = insertData(this.rkwc, pa, data, byteFlag);
                    if (result >= 0) this.rkwc = result;
                    break;

                case 0o10: // RKBA
                    result = insertData(this.rkba, pa, data, byteFlag);
                    if (result >= 0) this.rkba = result & 0xFFFE;
                    break;

                case 0o12: // RKDA
                    result = insertData(this.rkda, pa, data, byteFlag);
                    if (result >= 0) this.rkda = result;
                    break;

                case 0o14: // RKDB (unused)
                case 0o16:
                    result = 0;
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
                if (this.iMask & IMASK_COMMAND) {
                    this.iMask &= ~IMASK_COMMAND;
                } else {
                    for (let drive = 0; drive < 8; drive++) {
                        if (this.iMask & (IMASK_DRIVE << drive)) {
                            this.rkcs |= 0x2000;
                            this.rkds = (drive << 13) | (this.rkds & 0x1FF0);
                            this.iMask &= ~(IMASK_DRIVE << drive);
                            break;
                        }
                    }
                }
                return RK_VECTOR;
            } else {
                if (!(this.rkcs & RKCS_IE)) this.iMask = 0;
                return RK_PRIORITY | (this.iMask ? 1 : 0);
            }
        }

        // ------------------------------------------------------------------
        // L2 persistence
        // ------------------------------------------------------------------
        snapshot() {
            return {
                rkds: this.rkds,
                rker: this.rker,
                rkcs: this.rkcs,
                rkwc: this.rkwc,
                rkba: this.rkba,
                rkda: this.rkda,
                iMask: this.iMask,
            };
        }

        restore(state) {
            if (!state) return;
            if (typeof state.rkds === "number") this.rkds = state.rkds;
            if (typeof state.rker === "number") this.rker = state.rker;
            if (typeof state.rkcs === "number") this.rkcs = state.rkcs;
            if (typeof state.rkwc === "number") this.rkwc = state.rkwc;
            if (typeof state.rkba === "number") this.rkba = state.rkba;
            if (typeof state.rkda === "number") this.rkda = state.rkda;
            if (typeof state.iMask === "number") this.iMask = state.iMask;
        }
    }

    const api = { Rk11 };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.Rk11 = Rk11;
    }
})(typeof window !== "undefined" ? window : globalThis);
