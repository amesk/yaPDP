/*
 * devices/cpu-regs.js — core CPU control registers as a Device (no DOM).
 *
 * Refactor stage 3b: the "Core CPU control registers" (17777770–76:
 * microbreak, PIR, stack limit, PSW) and the 11/70 size/system registers
 * (17777760–66) move out of iopage.js 1:1. Without these the boot ROM
 * cannot read the PSW through the I/O page (MFPI 177776) — the CPU would
 * take a Unibus-timeout trap into an empty vector and halt.
 *
 * CPU-side state (PIR, stackLimit, CPU_Error, readPSW/writePSW) lives on
 * the host CPU; this device only shuttles register accesses to it.
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests and the headless machine).
 */
(function (global) {
    "use strict";

    const { Device } = (typeof module !== "undefined" && module.exports)
        ? require("../core/device.js")
        : (global.yapdpCore || {});

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

    class CpuRegs extends Device {
        /**
         * @param {Machine} machine  owning machine (host: cpu, readPSW,
         *                           writePSW, priorityMask, maxMemory)
         * @param {string} id
         * @param {object} config    { cpuType: 70 }
         */
        constructor(machine, id, config = {}) {
            super(machine, id, config);
            this.cpuType = config.cpuType || 70;
            this.microBreak = 0;
            this.pswAddress = 0o17777776;
        }

        /** install() — register all CPU control register regions. */
        install() {
            if (!this.bus) return;
            // 17777770–76: microbreak, PIR, stack limit, PSW.
            this.bus.register(0o17777770, 4, this);
            // 17777700–17: register sets (R0–R5 + kernel/super/user SP/PC).
            this.bus.register(0o17777700, 4, this);
            this.bus.register(0o17777710, 4, this);
            // 17777570–76: console panel display/switch + MMR0/MMR1/MMR2.
            this.bus.register(0o17777570, 4, this);
            // 17772516: MMR3 (UB / 22-bit / K-S-U mode).
            this.bus.register(0o17772510, 1, this);
            // 17777760–66: 11/70 size / system-ID / CPU-error registers.
            if (this.cpuType === 70) {
                this.bus.register(0o17777760, 4, this);
                // 17777740–46: 11/70 error-address / cache-control stubs.
                this.bus.register(0o17777740, 4, this);
            }
        }

        reset() {
            const cpu = this._cpu();
            if (cpu) {
                cpu.PIR = 0;
                cpu.stackLimit = 0xff;
                cpu.CPU_Error = 0;
            }
            this.microBreak = 0;
        }

        _cpu() {
            return this.machine && this.machine.host
                ? this.machine.host.cpu : null;
        }

        _requestInterrupt() {
            const cpu = this._cpu();
            if (cpu) {
                cpu.interruptRequested = 1;
                if (cpu.runState === 2) cpu.runState = 0; // STATE_WAIT(2) → STATE_RUN
            }
        }

        access(physicalAddress, data, byteFlag) {
            const cpu = this._cpu();
            const host = this.machine ? this.machine.host : {};
            const pswMask = host.priorityMask !== undefined
                ? host.priorityMask : 0o340;
            const pswAddress = this.pswAddress;
            const RS_BIT = 0x0800;   // PSW bit 11 — alternate register set
            const MMU_READ = 16;     // pdp11.js constants (consts are not
            const MMU_WRITE = 32;    // vm-sandbox properties, so inline)
            let result;

            switch (physicalAddress & 0o17777776) {
                // --------------------------------------------------------
                // 17777760 — Lower size (11/70)
                // --------------------------------------------------------
                case 0o17777760:
                    if (this.cpuType !== 70) break;
                    result = insertData(
                        ((host.maxMemory || 0) >>> 6) - 1, physicalAddress, data, byteFlag);
                    break;

                // 17777762 — Upper size (reserved, always 0)
                case 0o17777762:
                    if (this.cpuType !== 70) break;
                    result = insertData(0, physicalAddress, data, byteFlag);
                    break;

                // 17777764 — System I/D (identifies system type, returns 1)
                case 0o17777764:
                    if (this.cpuType !== 70) break;
                    result = insertData(1, physicalAddress, data, byteFlag);
                    break;

                // 17777766 — CPU error register (writes clear)
                case 0o17777766:
                    if (this.cpuType !== 70) break;
                    result = insertData(cpu ? cpu.CPU_Error : 0, physicalAddress, data, byteFlag);
                    if (result >= 0 && data >= 0 && cpu) {
                        cpu.CPU_Error = 0;
                    }
                    break;

                // --------------------------------------------------------
                // 17777770 — Microbreak (8-bit)
                // --------------------------------------------------------
                case 0o17777770:
                    result = insertData(this.microBreak, physicalAddress, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        this.microBreak = result & 0xff;
                    }
                    break;

                // --------------------------------------------------------
                // 17777772 — PIR (Programmable Interrupt Register)
                // --------------------------------------------------------
                case 0o17777772:
                    result = insertData(cpu ? cpu.PIR : 0, physicalAddress, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        result &= 0xfe00;
                        if (result) {
                            let idx = result >>> 9;
                            do { result += 0x22; } while (idx >>= 1);
                        }
                        if (cpu) cpu.PIR = result;
                        if (cpu && (result & pswMask) > (cpu.PSW & pswMask)) {
                            this._requestInterrupt();
                        }
                    }
                    break;

                // --------------------------------------------------------
                // 17777774 — Stack limit (low byte always forced to 0xFF)
                // --------------------------------------------------------
                case 0o17777774:
                    result = insertData(cpu ? cpu.stackLimit : 0, physicalAddress, data, byteFlag);
                    if (result >= 0) {
                        if (data >= 0 && cpu) {
                            cpu.stackLimit = result | 0xff;
                        }
                        result &= 0xff00;
                    }
                    break;

                // --------------------------------------------------------
                // 17777740–46 — 11/70 error address + cache control stubs
                // (iopage.js returns fixed values, ignores writes)
                // --------------------------------------------------------
                case 0o17777740: // Low error address
                    if (this.cpuType !== 70) break;
                    result = insertData(0o177740, physicalAddress, data, byteFlag);
                    break;
                case 0o17777742: // High error address
                    if (this.cpuType !== 70) break;
                    result = insertData(0o3, physicalAddress, data, byteFlag);
                    break;
                case 0o17777744: // Memory system error
                    if (this.cpuType !== 70) break;
                    result = insertData(0, physicalAddress, data, byteFlag);
                    break;
                case 0o17777746: // Cache control
                    if (this.cpuType !== 70) break;
                    result = insertData(0o17, physicalAddress, data, byteFlag);
                    break;

                // --------------------------------------------------------
                // 17777776 — PSW (Processor Status Word)
                // --------------------------------------------------------
                case pswAddress:
                    result = insertData(
                        host.readPSW ? host.readPSW() : 0, physicalAddress, data, byteFlag);
                    if (data >= 0 && result >= 0 && host.writePSW) {
                        host.writePSW(result);
                        return -1; // Caller must not overwrite PSW again
                    }
                    break;

                // --------------------------------------------------------
                // 17777700–07 — Register Set 0 (R0–R5, kernel SP, kernel PC)
                // --------------------------------------------------------
                case 0o17777700:
                case 0o17777702:
                case 0o17777704:
                case 0o17777706: {
                    const index = physicalAddress & 7;
                    if (index === 6) { // 17777706 — kernel SP (R6)
                        if (cpu.mmuMode === 0) { // kernel mode
                            if (data >= 0) cpu.registerVal[6] = data;
                            result = cpu.registerVal[6];
                        } else {
                            if (data >= 0) cpu.stackPointer[0] = data;
                            result = cpu.stackPointer[0];
                        }
                    } else { // R0–R5
                        if (cpu.PSW & RS_BIT) {
                            if (data >= 0) cpu.registerAlt[index] = data;
                            result = cpu.registerAlt[index];
                        } else {
                            if (data >= 0) cpu.registerVal[index] = data;
                            result = cpu.registerVal[index];
                        }
                    }
                    break;
                }
                // 17777707 — kernel PC (R7)
                case 0o17777707:
                    if (data >= 0) cpu.registerVal[7] = data;
                    result = cpu.registerVal[7];
                    break;

                // --------------------------------------------------------
                // 17777710–17 — Register Set 1 (R0–R5, super SP, user SP)
                // --------------------------------------------------------
                case 0o17777710:
                case 0o17777712:
                case 0o17777714:
                case 0o17777716: {
                    const index = physicalAddress & 7;
                    if (index === 6) { // 17777716 — super SP (R6)
                        if (cpu.mmuMode === 1) { // super mode
                            if (data >= 0) cpu.registerVal[6] = data;
                            result = cpu.registerVal[6];
                        } else {
                            if (data >= 0) cpu.stackPointer[1] = data;
                            result = cpu.stackPointer[1];
                        }
                    } else { // R0–R5 (alternate set)
                        if (cpu.PSW & RS_BIT) {
                            if (data >= 0) cpu.registerVal[index] = data;
                            result = cpu.registerVal[index];
                        } else {
                            if (data >= 0) cpu.registerAlt[index] = data;
                            result = cpu.registerAlt[index];
                        }
                    }
                    break;
                }
                // 17777717 — user SP (R6)
                case 0o17777717:
                    if (cpu.mmuMode === 3) { // user mode
                        if (data >= 0) cpu.registerVal[6] = data;
                        result = cpu.registerVal[6];
                    } else {
                        if (data >= 0) cpu.stackPointer[3] = data;
                        result = cpu.stackPointer[3];
                    }
                    break;

                // --------------------------------------------------------
                // 17777570 — console panel display/switch register
                // --------------------------------------------------------
                case 0o17777570:
                    result = insertData(cpu.switchRegister & 0xffff,
                        physicalAddress, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        cpu.displayRegister = result;
                    }
                    break;

                // --------------------------------------------------------
                // 17777572 — MMR0 (MMU control/status)
                // --------------------------------------------------------
                case 0o17777572:
                    if (!(cpu.MMR0 & 0xe000)) {
                        cpu.MMR0 = (cpu.MMR0 & 0xf381) | (cpu.mmuLastPage << 1);
                    }
                    result = insertData(cpu.MMR0, physicalAddress, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        cpu.MMR0 = result &= 0xf381;
                        cpu.mmuLastPage = (result >>> 1) & 0x3f;
                        if (result & 0x101) {
                            if (result & 0x1) {
                                cpu.mmuEnable = MMU_READ | MMU_WRITE;
                            } else {
                                cpu.mmuEnable = MMU_WRITE;
                            }
                        } else {
                            cpu.mmuEnable = 0;
                            cpu.mmuLastPage = 0;
                        }
                    }
                    break;

                // --------------------------------------------------------
                // 17777574 — MMR1 (byte-swapped if high byte non-zero)
                // --------------------------------------------------------
                case 0o17777574:
                    result = cpu.MMR1;
                    if (result & 0xff00) {
                        result = ((result << 8) | (result >>> 8)) & 0xffff;
                    }
                    break;

                // --------------------------------------------------------
                // 17777576 — MMR2
                // --------------------------------------------------------
                case 0o17777576:
                    result = insertData(cpu.MMR2, physicalAddress, data, byteFlag);
                    if (result >= 0) {
                        cpu.MMR2 = result;
                    }
                    break;

                // --------------------------------------------------------
                // 17772516 — MMR3 (UB / 22-bit / K-S-U mode)
                // --------------------------------------------------------
                case 0o17772516:
                    result = insertData(cpu.MMR3, physicalAddress, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        if (this.cpuType !== 70) {
                            result &= ~0x30; // no 22-bit/Unibus map on 11/45
                        }
                        cpu.MMR3 = result;
                        if (host.setMMUmode) {
                            host.setMMUmode(cpu.mmuMode); // re-apply MMU mode
                        }
                    }
                    break;

                default:
                    return -1; // not ours (other region slots are no-ops)
            }

            return result === undefined ? -1 : result;
        }

        snapshot() {
            return { microBreak: this.microBreak };
        }

        restore(state) {
            if (state && typeof state.microBreak === "number") {
                this.microBreak = state.microBreak & 0xff;
            }
        }
    }

    const api = { CpuRegs };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.CpuRegs = CpuRegs;
    }
})(typeof window !== "undefined" ? window : globalThis);
