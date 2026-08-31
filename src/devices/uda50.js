/*
 * devices/uda50.js — UDA50 MSCP disk controller as a core Device (no DOM).
 *
 * Refactor stage 3 (disks): the UDA50 closure of iopage.js (17772150,
 * RA-series MSCP drives, RA81) moves onto the headless base 1:1.
 * Register behaviour (IP/SA, four-step init handshake), MSCP command/
 * response ring handling and interrupts are unchanged; the environment
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
 *   machine.mountDrive("ra0.dsk", { readBlock, writeBlock });
 *
 * The browser UDA50 stays in iopage.js until the whole disk layer has
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

    // --- Constants ---
    const UDA_PRIORITY = 5 << 5; // IPL 5
    const MAX_UNIT = 3;          // Highest unit number we support

    const DSC_CMD_INTERRUPT = -4;
    const DSC_RSP_INTERRUPT = -2;
    const DSC_SIZE = 4;
    const DSC_OWN = 0x8000;  // OWN bit in ring descriptor high word
    const DSC_FLAG = 0x4000;

    // MSCP opcodes
    const MSCP_OP_GET_STATUS = 0o003;
    const MSCP_OP_SETCTLRC   = 0o004;
    const MSCP_OP_ONLINE     = 0o011;
    const MSCP_OP_READ       = 0o041;
    const MSCP_OP_WRITE      = 0o042;
    const MSCP_OP_END        = 0x80; // End response modifier

    // Packet offsets (byte offsets from packet base)
    const PKT_LEN      = -4;  // Word in envelope
    const PKT_CREDITS  = -2;  // Word in envelope: 4 bits + ?
    const PKT_CMDREF   = 0;   // Long
    const PKT_UNIT     = 4;   // Word
    const PKT_OPCODE   = 8;   // Long: byte + flags + sts
    const PKT_BYTECOUNT = 12; // Long
    const PKT_BUFFER   = 16;  // Long x 3
    const PKT_LBN      = 28;  // Long

    // Status codes
    const STS_OK         = 0;     // All is well
    const STS_AVAILABLE  = 4;     // Unit is available
    const STS_UNAVAILABLE = 0x23; // Unit is not available

    const UNIBUS_MASK = 0x3fffe; // 18-bit even addresses

    const OP_WRITE = 1;
    const OP_READ = 2;

    class Uda50 extends Device {
        /**
         * @param {Machine} machine  owning machine (provides disk service)
         * @param {string} id        device id ("ra0", ...)
         * @param {object} config    { regions }
         */
        constructor(machine, id, config = {}) {
            super(machine, id, config);
            this.rqControlBlock = [];
            this.unitOnline = [];
            this.reset();
        }

        /** reset() — resetUDA(): most init happens via the four-step
         *  initialization process; this only clears the handshake state. */
        reset() {
            this.initState = 0;
            this.initWord = 0;
            this.sa = 0;
            this.irqEnabled = 0;
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

        // Memory access helpers — 1:1 with iopage.js busReadWord/busWriteWord
        // /busReadLong/busWriteLong (host versions already apply mapUnibus).
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

        _readLong(ba) {
            const lo = this._readWord(ba);
            if (lo < 0) return lo;
            const hi = this._readWord(ba + 2);
            if (hi < 0) return hi;
            return ((hi << 16) | lo) >>> 0;
        }

        _writeLong(ba, data) {
            let v = this._writeWord(ba, data & 0xFFFF);
            if (v < 0) return v;
            v = this._writeWord(ba + 2, data >>> 16);
            return v;
        }

        // ------------------------------------------------------------------
        // rqCallback — disk I/O completion callback.
        // ------------------------------------------------------------------
        rqCallback(controlBlock, code, position, address, count, options) {
            let sts;

            switch (code) {
                case 0: // Success
                    sts = STS_OK;
                    break;
                case 1: // Write check error
                    sts = 0x08; // Data error
                    break;
                case 2: // Non-existent memory
                    sts = 0x09; // Host buffer access error
                    break;
                case 3: // Data mismatch (check failure)
                    sts = 0x07; // Compare error
                    break;
                default: // Generic seek error
                    sts = 0x0b; // Drive error
                    break;
            }

            this.makeResponse(sts, options.cmdRef, options.opcode,
                controlBlock.unit, options.byteCount);
        }

        // ------------------------------------------------------------------
        // makeResponse — build a response packet in the response ring.
        // ------------------------------------------------------------------
        makeResponse(sts, cmdRef, opcode, unit, byteCount) {
            const rspDesc = this.rspRingBase + this.rspIdx * DSC_SIZE;
            const descHi = this._readWord(rspDesc + 2);

            if (descHi & DSC_OWN) {
                const descLo = this._readWord(rspDesc);
                const rspPkt = ((descHi << 16) | descLo) & UNIBUS_MASK;
                let response;

                switch (opcode & 0xff) {
                    case MSCP_OP_READ:
                    case MSCP_OP_WRITE:
                        response = [cmdRef, unit, opcode, byteCount, 0, 0, 0, 0];
                        break;

                    case MSCP_OP_SETCTLRC:
                        sts = STS_OK;
                        response = [
                            cmdRef,
                            0,
                            opcode,
                            0x80000000,
                            0x1030078,
                            0,
                            0x1020000, // Lowly uda50
                            0,
                            0
                        ];
                        break;

                    case MSCP_OP_ONLINE:
                        if (unit <= MAX_UNIT) {
                            sts = this.unitOnline[unit] = STS_OK;
                        } else {
                            sts = STS_UNAVAILABLE;
                        }
                        response = [
                            cmdRef,
                            unit,
                            opcode,
                            0x80000000,
                            0,
                            unit,
                            0x02050000,
                            0x25641051,     // ra81
                            0,
                            891072,
                            0o1234 + unit
                        ];
                        break;

                    case MSCP_OP_GET_STATUS:
                        if (unit <= MAX_UNIT) {
                            sts = this.unitOnline[unit];
                        } else {
                            sts = STS_UNAVAILABLE;
                            if (opcode & 0x10000) { // Next Unit modifier
                                unit = 0; // Flag no more units
                            }
                        }
                        response = [
                            cmdRef,
                            unit,
                            opcode,
                            0x80000000,
                            0,
                            unit,
                            0x02050000,
                            0x25641051,     // ra81
                            unit,
                            0x00e0033,
                            1,
                            0x1010B28
                        ];
                        break;

                    default:
                        if (process.env && process.env.DEBUG_UDA) {
                            console.log("Unknown MSCP opcode:" + opcode.toString(16) +
                                " unit:" + unit + " idx:" + this.rspIdx +
                                " buff:" + rspPkt.toString(8) +
                                " cmdRef:" + cmdRef.toString(16) +
                                " bytes:" + byteCount);
                        }
                        sts = 0;
                        response = [cmdRef, unit, opcode, 0];
                        break;
                }

                if (process.env && process.env.DEBUG_UDA) {
                    console.log("RES:" + opcode.toString(16) + " unit:" + unit +
                        " idx:" + this.rspIdx + " buff:" + rspPkt.toString(8) +
                        " bytes:" + byteCount + " sts:" + sts.toString(8));
                }

                // Cap credits at 14 to avoid runaway accumulation
                const sendCredit = Math.min(14, this.credits);
                this.credits -= sendCredit;

                // Insert status into opcode word
                response[2] = (sts << 16) | (opcode & 0xff) | MSCP_OP_END;

                this._writeWord(rspPkt + PKT_LEN, response.length * 4);
                this._writeWord(rspPkt + PKT_CREDITS, sendCredit);
                for (let lw = 0; lw < response.length; lw++) {
                    this._writeLong(rspPkt + lw * 4, response[lw]);
                }

                // Release response descriptor to host
                this._writeWord(rspDesc + 2, (descHi | DSC_FLAG) & ~DSC_OWN);

                // Interrupt on transition from empty to non-empty response ring
                let wasEmpty = true;

                if (this.rspRingSize > 1) { // Ring size one MUST have been empty
                    const prevAdd = (this.rspIdx !== 0)
                        ? rspDesc - DSC_SIZE
                        : this.rspRingBase + (this.rspRingSize - 1) * DSC_SIZE;
                    const prevHi = this._readWord(prevAdd + 2);
                    wasEmpty = (prevHi & DSC_OWN) !== 0; // Was previous response empty?
                }

                if (wasEmpty) {
                    // Reason for interrupt is response ring no longer empty
                    this._writeWord(this.rspRingBase + DSC_RSP_INTERRUPT, 1);

                    if (this.irqEnabled) {
                        this._requestInterrupt();
                        this.iMask = 1;
                    }
                }

                this.rspIdx = (this.rspIdx + 1) % this.rspRingSize;
                return;
            }

            // Not all host code is ready for an instant response; retry shortly
            setTimeout(() => this.makeResponse(sts, cmdRef, opcode, unit, byteCount), 1);
        }

        // ------------------------------------------------------------------
        // executeCmd — run an MSCP command (read/write → disk I/O).
        // ------------------------------------------------------------------
        executeCmd(cmdPkt) {
            const cmdRef = this._readLong(cmdPkt + PKT_CMDREF);
            const unit = this._readWord(cmdPkt + PKT_UNIT);
            const opcode = this._readLong(cmdPkt + PKT_OPCODE);

            if (process.env && process.env.DEBUG_UDA) {
                console.log("CMD:" + opcode.toString(16) + " unit:" + unit +
                    " idx:" + this.cmdIdx + " buff:" + cmdPkt.toString(8));
            }

            const opFunc = opcode & 0xff; // Opcode function without modifiers

            if (unit <= MAX_UNIT && (opFunc === MSCP_OP_READ || opFunc === MSCP_OP_WRITE)) {
                const byteCount = this._readLong(cmdPkt + PKT_BYTECOUNT);
                const bufAddr = this._readLong(cmdPkt + PKT_BUFFER) & UNIBUS_MASK;
                const lbn = this._readLong(cmdPkt + PKT_LBN);

                // Lazy init control block
                if (!this.rqControlBlock[unit]) {
                    this.rqControlBlock[unit] = {
                        cache: [],
                        callback: (cb, code, position, address, count, options) =>
                            this.rqCallback(cb, code, position, address, count, options),
                        url: `ra${unit}.dsk`,
                        compressed: true, // Bundled disk images ship as .zst
                        unit,
                    };
                }

                // Issue read/write
                const disk = this.machine && this.machine.disk;
                if (!disk || typeof disk.io !== "function") {
                    // No disk service: fail like a transfer error.
                    this.rqCallback(this.rqControlBlock[unit], 4, lbn * 512, bufAddr, byteCount,
                        { cmdRef, byteCount, opcode });
                    return;
                }
                disk.io(
                    this.rqControlBlock[unit],
                    (opFunc === MSCP_OP_READ) ? OP_READ : OP_WRITE,
                    lbn * 512,
                    bufAddr,
                    byteCount,
                    { cmdRef, byteCount, opcode } // Things to remember for end of I/O
                );
            } else {
                this.makeResponse(0, cmdRef, opcode, unit, 0);
            }
        }

        // ------------------------------------------------------------------
        // cmdPoll — pull commands from the command ring (called on IP read).
        // ------------------------------------------------------------------
        cmdPoll() {
            let cmdCount = 0;

            while (true) {
                const cmdDesc = this.cmdRingBase + this.cmdIdx * DSC_SIZE;
                const descHi = this._readWord(cmdDesc + 2);

                if (!(descHi & DSC_OWN)) { // Done on empty command descriptor
                    break;
                }

                const descLo = this._readWord(cmdDesc);
                const cmdPkt = ((descHi << 16) | descLo) & UNIBUS_MASK;

                // Release command descriptor to host and go process packet
                this._writeWord(cmdDesc + 2, (descHi | DSC_FLAG) & ~DSC_OWN);
                this.credits++;

                this.executeCmd(cmdPkt);

                // Move around ring
                this.cmdIdx = (this.cmdIdx + 1) % this.cmdRingSize;
                cmdCount++;
            }

            if (cmdCount === this.cmdRingSize) { // If the ring was full
                // Flag interrupt as a command ring no longer full
                this._writeWord(this.rspRingBase + DSC_CMD_INTERRUPT, 1);

                if (this.irqEnabled) { // Interrupt on transition from cmd full to not full
                    this._requestInterrupt();
                    this.iMask = 1;
                }
            }
        }

        // ------------------------------------------------------------------
        // Bus interface
        // ------------------------------------------------------------------
        access(pa, data, byteFlag) {
            switch (pa & 0o06) {
                case 0o00: // IP
                    if (data < 0) { // Read
                        if (this.initState > 4) {
                            // IP read with controller initialized starts a POLL.
                            // RSTS reboot code cannot handle an instant response,
                            // so we defer slightly.
                            setTimeout(() => this.cmdPoll(), 1);
                        }
                    } else { // Write
                        this.initState = 1;
                        this.sa = 0o4000; // Ready for step 1
                    }
                    return 0;

                case 0o02: // SA
                    if (data >= 0) {
                        switch (this.initState) {
                            case 1:
                                this.initWord = data;
                                this.vector = (this.initWord & 0x7f) << 2;
                                this.irqEnabled = (this.initWord >> 7) & 1;
                                this.rspRingSize = 1 << ((this.initWord >> 8) & 7);
                                this.cmdRingSize = 1 << ((this.initWord >> 11) & 7);
                                // Echo ring initWord in low half + ready for step 2
                                this.sa = 0o10000 | (this.initWord >>> 8);
                                break;

                            case 2:
                                this.rspRingBase = data;
                                // Echo IE + vector + go for step 3
                                this.sa = 0o20000 | (this.initWord & 0xff);
                                break;

                            case 3:
                                this.rspRingBase = ((data << 16) | this.rspRingBase) & UNIBUS_MASK;
                                this.cmdRingBase = this.rspRingBase + this.rspRingSize * 4;
                                // Clear comms area header + rsp/cmd descriptors
                                // BEFORE doing step 4
                                for (let off = -1; off < this.rspRingSize + this.cmdRingSize; off++) {
                                    this._writeLong(this.rspRingBase + off * 4, 0);
                                }
                                // Echo version info + go for step 4
                                this.sa = 0x4143; // Lowly uda50
                                break;

                            case 4:
                                this.rspIdx = 0;
                                this.cmdIdx = 0;
                                this.credits = 14;
                                for (let unit = 0; unit <= MAX_UNIT; unit++) {
                                    this.unitOnline[unit] = STS_AVAILABLE; // Unit available - not online
                                }
                                this.sa = 0; // Echo ready!
                                if (process.env && process.env.DEBUG_UDA) {
                                    console.log("INIT base:" + this.rspRingBase.toString(16) +
                                        " rspSize:" + this.rspRingSize +
                                        " cmdSize:" + this.cmdRingSize +
                                        " irq:" + this.irqEnabled +
                                        " vector:" + this.vector.toString(8));
                                }
                                break;

                            default:
                                // Ignore writes and don't interrupt
                                return 0;
                        }

                        // Next initialization step
                        this.initState++;

                        // Interrupt only in intermediate initialization steps
                        if (this.initState < 5 && this.irqEnabled) {
                            this._requestInterrupt();
                            this.iMask = 1;
                        }
                    }
                    return this.sa;

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
                return this.vector;
            }
            return UDA_PRIORITY | (this.iMask ? 1 : 0);
        }

        // ------------------------------------------------------------------
        // L2 persistence
        // ------------------------------------------------------------------
        snapshot() {
            return {
                sa: this.sa,
                initState: this.initState,
                initWord: this.initWord,
                vector: this.vector,
                irqEnabled: this.irqEnabled,
                rspRingBase: this.rspRingBase,
                rspRingSize: this.rspRingSize,
                cmdRingBase: this.cmdRingBase,
                cmdRingSize: this.cmdRingSize,
                rspIdx: this.rspIdx,
                cmdIdx: this.cmdIdx,
                credits: this.credits,
                iMask: this.iMask,
            };
        }

        restore(state) {
            if (!state) return;
            if (typeof state.sa === "number") this.sa = state.sa;
            if (typeof state.initState === "number") this.initState = state.initState;
            if (typeof state.initWord === "number") this.initWord = state.initWord;
            if (typeof state.vector === "number") this.vector = state.vector;
            if (typeof state.irqEnabled === "number") this.irqEnabled = state.irqEnabled;
            if (typeof state.rspRingBase === "number") this.rspRingBase = state.rspRingBase;
            if (typeof state.rspRingSize === "number") this.rspRingSize = state.rspRingSize;
            if (typeof state.cmdRingBase === "number") this.cmdRingBase = state.cmdRingBase;
            if (typeof state.cmdRingSize === "number") this.cmdRingSize = state.cmdRingSize;
            if (typeof state.rspIdx === "number") this.rspIdx = state.rspIdx;
            if (typeof state.cmdIdx === "number") this.cmdIdx = state.cmdIdx;
            if (typeof state.credits === "number") this.credits = state.credits;
            if (typeof state.iMask === "number") this.iMask = state.iMask;
        }
    }

    const api = { Uda50 };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.Uda50 = Uda50;
    }
})(typeof window !== "undefined" ? window : globalThis);
