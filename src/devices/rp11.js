/*
 * devices/rp11.js — RP11 disk controller as a core Device (no DOM).
 *
 * Refactor stage 3 (disks): the RP11 closure of iopage.js (17776700,
 * RP04/RP06 drives, vector 0254) moves onto the headless base 1:1.
 * Register behaviour (RPCS1/RPWC/RPBA/RPDA/RPCS2/RPDS/RPAS/RPDT/RPSN/
 * RPDC/RPCC), function dispatch (rpGo), completion callback (rpCallback)
 * and interrupt handling are unchanged; the two environment seams are:
 *
 *   - disk I/O:     machine.disk.io(controlBlock, op, position, address,
 *                   count, options) — the DiskService (block cache +
 *                   readBlock/writeBlock providers).
 *   - CPU glue:     machine.host.{trap, cpu} — Unibus timeout traps and
 *                   interrupt wake-ups.
 *
 * Drives are attached through the machine:
 *
 *   machine.mountDrive("rp1.dsk", { readBlock, writeBlock });
 *
 * The browser RP11 stays in iopage.js until the whole disk layer has
 * moved over (regression net: e2e-osboot, e2e-snapshots).
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests).
 */
(function (global) {
    "use strict";

    const { Device } = (typeof module !== "undefined" && module.exports)
        ? require("../core/device.js")
        : (global.yapdpCore || {});

    // --- Constants ---
    const RP_VECTOR = 0o254;     // Interrupt vector
    const RP_PRIORITY = 5 << 5;  // Base priority level

    // --- Geometry constants ---
    const RP_SECTOR_SIZE = 512;  // Bytes per sector

    // --- RPCS1 (Control/Status 1) bits ---
    const CS1_GO = 0x0001;
    const CS1_FUN_MASK = 0x003E;
    const CS1_IE = 0x0040;
    const CS1_RDY = 0x0080;
    const CS1_DVA = 0x0800;
    const CS1_TRE = 0x4000;
    const CS1_SC = 0x8000;

    const CS1_KEEP = 0x8880;     // Preserve SC, TRE, DVA, RDY
    const CS1_UPDATE = 0x477F;   // Updateable bits
    const CS1_CLEARERR = 0x703F; // Clear error bits
    const CS1_CLR_ALL = 0x7081;  // Clear errors, TRE, RDY, GO
    const CS1_SC_TRE = 0xC000;
    const CS1_IE_RDY_FUN = 0x00FE;
    const CS1_IE_RDY_NOP = 0x00C0;

    // --- RPCS2 (Control/Status 2) bits ---
    const CS2_UNIT = 0x0007;
    const CS2_CLR = 0x0020;
    const CS2_MDPE = 0x0100;
    const CS2_MXF = 0x0200;
    const CS2_PGE = 0x0400;
    const CS2_NXM = 0x0800;
    const CS2_NED = 0x1000;
    const CS2_DLT = 0x8000;

    // --- RPDS (Drive Status) bits ---
    const DS_DRY = 0x0080;
    const DS_VV = 0x0040;
    const DS_DPR = 0x0100;
    const DS_LST = 0x0400;
    const DS_MOL = 0x1000;
    const DS_ATA = 0x8000;

    // --- RPAS (Attention Summary) masks ---
    const RPAS_SC_CLR = 0x7FFF;

    // --- Miscellaneous field masks ---
    const BUS_ADDR_MASK = 0xFFFE;
    const RPDA_MASK = 0x1F1F;
    const CYL_MASK = 0x03FF;

    // --- Local interrupt masks ---
    const IMASK_COMMAND = 0x0100;
    const IMASK_DRIVE = 0x0001;

    // --- Function codes (RPCS1 FUN field) ---
    const FUN_NOP = 0o00;
    const FUN_UNLOAD = 0o02;
    const FUN_SEEK = 0o04;
    const FUN_RECAL = 0o06;
    const FUN_INIT = 0o10;
    const FUN_RELEASE = 0o12;
    const FUN_OFFSET = 0o14;
    const FUN_CENTER = 0o16;
    const FUN_PRESET = 0o20;
    const FUN_PACKACK = 0o22;
    const FUN_SEARCH = 0o30;
    const FUN_WRITE = 0o60;
    const FUN_READ = 0o70;

    // --- Geometry presets ---
    const rp04Drive = { dtype: 0o20020, sectors: 22, surfaces: 19, cylinders: 411 };
    const rp06Drive = { dtype: 0o20022, sectors: 22, surfaces: 19, cylinders: 815 };
    const idleDrive = { dtype: 0, sectors: 0, surfaces: 0, cylinders: 0 };

    const geometry = [
        rp06Drive, rp06Drive, rp04Drive, rp04Drive, rp04Drive,
        idleDrive, idleDrive, idleDrive
    ];

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

    class Rp11 extends Device {
        /**
         * @param {Machine} machine  owning machine (provides disk service)
         * @param {string} id        device id ("rp1", ...)
         * @param {object} config    { regions, drives: [url,...] }
         */
        constructor(machine, id, config = {}) {
            super(machine, id, config);
            this.rpControlBlock = [];
            this.reset();
        }

        /** reset() — initRP(): controller + per-drive state. */
        reset() {
            this.rpcs1 = CS1_SC | CS1_TRE | CS1_DVA | CS1_RDY;
            this.rpwc = 0;
            this.rpba = 0;
            this.rpda = [0, 0, 0, 0, 0, 0, 0, 0];
            this.rpcs2 = 0;
            this.rpds = [
                DS_MOL | DS_DPR | DS_DRY, // Drive 0
                DS_MOL | DS_DPR | DS_DRY, // Drive 1
                DS_MOL | DS_DPR | DS_DRY, // Drive 2
                DS_MOL | DS_DPR | DS_DRY, // Drive 3
                DS_MOL | DS_DPR | DS_DRY, // Drive 4
                0, 0, 0                    // Drives 5–7 (idle)
            ];
            this.rpdc = [0, 0, 0, 0, 0, 0, 0, 0];
            this.iMask = 0;
        }

        /** _controlBlockFor(drive) — lazy per-drive control block. */
        _controlBlockFor(drive) {
            if (!this.rpControlBlock[drive]) {
                this.rpControlBlock[drive] = {
                    cache: [],
                    callback: (cb, code, position, address, count, options) =>
                        this.rpCallback(cb, code, position, address, count, options),
                    url: `rp${drive}.dsk`,
                    compressed: true,
                    drive,
                };
            }
            return this.rpControlBlock[drive];
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
        // rpCallback — completion callback for disk I/O operations.
        // ------------------------------------------------------------------
        rpCallback(controlBlock, code, position, address, count, options) {
            if (typeof process !== "undefined" && process.env && process.env.DEBUG_DISK) {
                console.log("RP.callback code=" + code + " pos=" + position +
                    " addr=" + address + " count=" + count);
            }
            // Compute block number from byte position
            const block = ~~((position + (RP_SECTOR_SIZE - 1)) / RP_SECTOR_SIZE);

            // Update controller registers to reflect transfer state
            this.rpcs1 = (this.rpcs1 & 0xFCFF) | ((address >>> 8) & 0x300);
            this.rpba = address & BUS_ADDR_MASK;
            this.rpwc = (0x10000 - (count >>> 1)) & 0xFFFF;

            // Compute CHS (Cylinder/Head/Sector) from block
            const geom = geometry[controlBlock.drive];
            const sector = ~~(block / geom.sectors);
            this.rpda[controlBlock.drive] =
                ((sector % geom.surfaces) << 8) |
                (block % geom.sectors);
            this.rpdc[controlBlock.drive] = ~~(sector / geom.surfaces);

            // End-of-disk check
            if (block >= controlBlock.maxblock) {
                this.rpds[controlBlock.drive] |= DS_LST; // Last sector flag
            }

            // Error handling
            if (code) {
                this.rpds[controlBlock.drive] |= DS_ATA;   // Set Attention
                this.rpcs1 |= CS1_SC_TRE;                  // Set SC + TRE
                switch (code) {
                    case 1: this.rpcs2 |= CS2_MXF; break; // Missed transfer
                    case 2: this.rpcs2 |= CS2_NXM; break; // Non-existent memory
                    default: this.rpcs2 |= CS2_DLT; break; // Data late
                }
            }

            // Mark drive/controller ready
            this.rpds[controlBlock.drive] |= DS_DRY; // Drive Ready
            this.rpcs1 |= CS1_RDY;                   // Controller Ready

            // Interrupt if IE is set
            if (this.rpcs1 & CS1_IE) {
                this.iMask |= IMASK_COMMAND;         // Data transfer interrupt request
                this._requestInterrupt();
            }
        }

        // ------------------------------------------------------------------
        // rpGo — execute the command in the CSR.
        // ------------------------------------------------------------------
        rpGo() {
            let address, sector;
            const drive = this.rpcs2 & CS2_UNIT;

            // Clear GO (always done at command start)
            this.rpcs1 &= ~CS1_GO;

            // --- Drive present check ---
            if (geometry[drive].dtype === 0) {
                this.rpcs2 |= CS2_NED;       // Non-existent drive
                this.rpcs1 |= CS1_SC_TRE;    // SC + TRE
            } else {
                // Clear drive ATA bit (attention reset)
                this.rpds[drive] &= ~DS_ATA;

                // Lazy init control block
                const cb = this._controlBlockFor(drive);

                // --- Decode function code ---
                switch (this.rpcs1 & CS1_FUN_MASK) {
                    case FUN_NOP:
                        return;

                    case FUN_UNLOAD:
                    case FUN_SEEK:
                    case FUN_RECAL:
                    case FUN_OFFSET:
                    case FUN_CENTER:
                    case FUN_SEARCH:
                        // Stubbed functions: set drive attention only
                        break;

                    case FUN_INIT:
                        // Drive status initialization
                        this.rpds[drive] = DS_MOL | DS_DPR | DS_DRY | DS_VV;
                        this.rpcs1 &= ~CS1_CLEARERR;
                        this.rpda[drive] = this.rpdc[drive] = 0;
                        if (this.rpcs1 & CS1_IE) {
                            this.iMask |= IMASK_COMMAND;
                            this._requestInterrupt();
                        }
                        return;

                    case FUN_RELEASE:
                        return;

                    case FUN_PRESET:
                        // Reset cylinder/sector, mark volume valid
                        this.rpdc[drive] = this.rpda[drive] = 0;
                        this.rpds[drive] = DS_MOL | DS_DPR | DS_DRY | DS_VV;
                        return;

                    case FUN_PACKACK:
                        // Mark volume valid
                        this.rpds[drive] |= DS_VV;
                        return;

                    case FUN_WRITE:
                    case FUN_READ: {
                        // --- Read/Write path ---
                        if (!(this.rpds[drive] & DS_DRY)) {
                            // Drive not ready
                            this.rpcs2 |= CS2_PGE;
                            this.rpcs1 |= CS1_SC_TRE;
                        } else {
                            // Bounds check (CHS)
                            if (this.rpdc[drive] >= geometry[drive].cylinders ||
                                (this.rpda[drive] >>> 8) >= geometry[drive].surfaces ||
                                (this.rpda[drive] & 0xFF) >= geometry[drive].sectors) {
                                this.rpcs1 |= CS1_SC_TRE;
                                break;
                            }

                            // Clear errors, TRE, RDY, GO
                            this.rpcs1 &= ~CS1_CLR_ALL;

                            // Clear CS2 error summary (keep unit select)
                            this.rpcs2 &= CS2_UNIT;

                            // Clear LST & DRY
                            this.rpds[drive] &= ~(DS_LST | DS_DRY);

                            // Build bus address and LBA sector
                            address = ((this.rpcs1 & 0x300) << 8) |
                                (this.rpba & BUS_ADDR_MASK);
                            sector = (this.rpdc[drive] * geometry[drive].surfaces +
                                (this.rpda[drive] >>> 8)) * geometry[drive].sectors +
                                (this.rpda[drive] & 0xFF);

                            // Issue read/write
                            const disk = this.machine && this.machine.disk;
                            if (!disk || typeof disk.io !== "function") {
                                // No disk service: fail like a transfer error.
                                this.rpCallback(cb, 4,
                                    sector * RP_SECTOR_SIZE, address,
                                    ((0x10000 - this.rpwc) & 0xFFFF) << 1, null);
                                return;
                            }
                            disk.io(
                                cb,
                                (this.rpcs1 & CS1_FUN_MASK) === FUN_WRITE
                                    ? OP_WRITE : OP_READ,
                                sector * RP_SECTOR_SIZE,
                                address,
                                ((0x10000 - this.rpwc) & 0xFFFF) << 1,
                                null
                            );
                            return;
                        }
                        break;
                    }

                    default:
                        // Unknown function code
                        this.rpcs2 |= CS2_PGE;
                        this.rpcs1 |= CS1_SC_TRE;
                        return;
                }
            }

            // --- Non-data command completion ---
            this.rpds[drive] |= DS_ATA; // Set drive attention
            if (this.rpcs1 & CS1_IE) {
                this.iMask |= (IMASK_DRIVE << drive);
                this._requestInterrupt();
            }
        }

        // ------------------------------------------------------------------
        // Bus interface
        // ------------------------------------------------------------------
        access(pa, data, byteFlag) {
            let result;
            if (typeof process !== "undefined" && process.env && process.env.DEBUG_RP) {
                process.stderr.write("RP " + (data >= 0 ? "wr " : "rd ") +
                    (pa & 0o177777).toString(8) +
                    (data >= 0 ? "=" + data.toString(8) : "") + "\n");
            }

            switch (pa & 0o76) {
                case 0o00: // RPCS1 – Control/Status 1
                    result = insertData(this.rpcs1, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        // Preserve SC, TRE, DVA, RDY; update rest
                        this.rpcs1 = (this.rpcs1 & CS1_KEEP) | (result & CS1_UPDATE);

                        // Special case: FUN=NOP — if IE+RDY set, interrupt
                        // is raised even without GO.
                        if ((result & CS1_IE_RDY_FUN) === CS1_IE_RDY_NOP) {
                            this.iMask |= IMASK_COMMAND;
                            this._requestInterrupt();
                        } else if (this.rpcs1 & CS1_GO) {
                            this.rpGo();
                        }
                    }
                    break;

                case 0o02: // RPWC – Word count
                    result = insertData(this.rpwc, pa, data, byteFlag);
                    if (result >= 0) this.rpwc = result;
                    break;

                case 0o04: // RPBA – Bus address
                    result = insertData(this.rpba, pa, data, byteFlag);
                    if (result >= 0) this.rpba = result & BUS_ADDR_MASK;
                    break;

                case 0o06: // RPDA – Disk address (sector/surface)
                    result = insertData(this.rpda[this.rpcs2 & CS2_UNIT], pa, data, byteFlag);
                    if (result >= 0) this.rpda[this.rpcs2 & CS2_UNIT] = result & RPDA_MASK;
                    break;

                case 0o10: // RPCS2 – Control/Status 2
                    result = insertData(this.rpcs2, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        if (result & CS2_CLR) {
                            this.reset(); // Clear command resets controller
                        } else {
                            this.rpcs2 = (result & CS2_UNIT);
                            if (geometry[this.rpcs2 & CS2_UNIT].dtype === 0) {
                                this.rpcs2 |= CS2_NED; // Non-existent drive
                                this.rpcs1 |= CS1_TRE;
                            }
                        }
                    }
                    break;

                case 0o12: // RPDS – Drive status (read-only)
                    result = this.rpds[this.rpcs2 & CS2_UNIT];
                    break;

                case 0o14: // RPER1 – Error 1 (unused)
                    result = 0;
                    break;

                case 0o16: // RPAS – Attention summary
                    result = 0;
                    for (let drive = 0; drive < 8; drive++) {
                        if (this.rpds[drive] & DS_ATA) {
                            if (data >= 0 && (data & (1 << drive))) {
                                this.rpds[drive] &= ~DS_ATA; // Clear ATA bit
                            } else {
                                result |= (1 << drive); // Report attention
                            }
                        }
                    }
                    if (data >= 0) {
                        this.rpcs1 &= RPAS_SC_CLR; // Clear SC on any write
                    }
                    break;

                case 0o20: // RPLA – Look ahead (unused)
                case 0o22: // RPDB – Data buffer (unused)
                case 0o24: // RPMR – Maintenance (unused)
                    result = 0;
                    break;

                case 0o26: // RPDT – Drive type (read-only)
                    result = geometry[this.rpcs2 & CS2_UNIT].dtype;
                    break;

                case 0o30: // RPSN – Serial number (drive # + 1)
                    result = (this.rpcs2 & CS2_UNIT) + 1;
                    break;

                case 0o32: // RPOF – Offset register (unused)
                    result = 0;
                    break;

                case 0o34: // RPDC – Desired cylinder
                    result = insertData(this.rpdc[this.rpcs2 & CS2_UNIT], pa, data, byteFlag);
                    if (result >= 0) this.rpdc[this.rpcs2 & CS2_UNIT] = result & CYL_MASK;
                    break;

                case 0o36: // RPCC – Current cylinder (read-only)
                    result = this.rpdc[this.rpcs2 & CS2_UNIT];
                    break;

                case 0o40: // RPER2 – Error 2 (unused)
                case 0o42: // RPER3 – Error 3 (unused)
                case 0o44: // RPEC1 – Error correction 1 (unused)
                case 0o46: // RPEC2 – Error correction 2 (unused)
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
                // Data transfer interrupt?
                if (this.iMask & IMASK_COMMAND) {
                    this.iMask &= ~IMASK_COMMAND;
                } else {
                    // Find drive that completed a non-I/O command
                    for (let drive = 0; drive < 8; drive++) {
                        if (this.iMask & (IMASK_DRIVE << drive)) {
                            this.iMask &= ~(IMASK_DRIVE << drive);
                            break;
                        }
                    }
                }
                return RP_VECTOR; // Return interrupt vector
            } else {
                // If IE cleared, drop any pending interrupts
                if (!(this.rpcs1 & CS1_IE)) {
                    this.iMask = 0;
                }
                // Return priority level plus pending flag
                return RP_PRIORITY | (this.iMask ? 1 : 0);
            }
        }

        // ------------------------------------------------------------------
        // L2 persistence
        // ------------------------------------------------------------------
        snapshot() {
            return {
                rpcs1: this.rpcs1,
                rpwc: this.rpwc,
                rpba: this.rpba,
                rpda: Array.from(this.rpda),
                rpcs2: this.rpcs2,
                rpds: Array.from(this.rpds),
                rpdc: Array.from(this.rpdc),
                iMask: this.iMask,
            };
        }

        restore(state) {
            if (!state) return;
            if (typeof state.rpcs1 === "number") this.rpcs1 = state.rpcs1;
            if (typeof state.rpwc === "number") this.rpwc = state.rpwc;
            if (typeof state.rpba === "number") this.rpba = state.rpba;
            if (Array.isArray(state.rpda)) this.rpda = state.rpda.slice();
            if (typeof state.rpcs2 === "number") this.rpcs2 = state.rpcs2;
            if (Array.isArray(state.rpds)) this.rpds = state.rpds.slice();
            if (Array.isArray(state.rpdc)) this.rpdc = state.rpdc.slice();
            if (typeof state.iMask === "number") this.iMask = state.iMask;
        }
    }

    const api = { Rp11 };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.Rp11 = Rp11;
    }
})(typeof window !== "undefined" ? window : globalThis);
