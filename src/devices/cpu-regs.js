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

        /** install() — register both register regions. */
        install() {
            if (!this.bus) return;
            // 17777770–76: microbreak, PIR, stack limit, PSW.
            this.bus.register(0o17777770, 4, this);
            // 17777760–66: 11/70 size / system-ID / CPU-error registers.
            if (this.cpuType === 70) {
                this.bus.register(0o17777760, 4, this);
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
