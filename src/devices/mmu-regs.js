/*
 * devices/mmu-regs.js — PDP-11 MMU registers as a Device (no DOM).
 *
 * Refactor stage 3f: the MMU register file of iopage.js moves onto the
 * headless base — PDR/PAR (Page Descriptor/Address Registers) for the
 * kernel/super/user modes plus the 11/70 Unibus map. Without these the
 * I/O page answers NXM to MMU setup and any MMU-using guest (Unix V5,
 * BSD) traps on its first PAR write; RT-11 never touches them, which is
 * why it booted while V5 stalled at PC=400 with PSW=0340 (trap 4).
 *
 * The register file itself lives on the CPU (CPU.mmuPDR/mmuPAR/
 * unibusMap, pdp11.js) — this device only shuttles I/O page accesses to
 * it, exactly like iopage.js:
 *
 *   • PDR (16 entries per mode, word = flags + page length):
 *       - Kernel (0): 17772300–17772337
 *       - Super  (1): 17772200–17772237
 *       - User   (3): 17777600–17777637
 *   • PAR (16 entries per mode):
 *       - Kernel (0): 17772340–17772377
 *       - Super  (1): 17772240–17772277
 *       - User   (3): 17777640–17777677
 *   • Unibus map (11/70 only): 17770200–17770277, 32 double words.
 *
 * Index calculation (same as iopage.js):
 *   (((pa & 0o0600) >>> 3) ^ ((pa & 0o0100) >>> 2)) | ((pa >>> 1) & 0o17)
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

    class MmuRegs extends Device {
        /**
         * @param {Machine} machine  owning machine (host: cpu with
         *                           mmuPDR/mmuPAR/unibusMap)
         * @param {string} id
         * @param {object} config    { cpuType: 70 }
         */
        constructor(machine, id, config = {}) {
            super(machine, id, config);
            this.cpuType = config.cpuType || 70;
        }

        _cpu() {
            return this.machine && this.machine.host
                ? this.machine.host.cpu : null;
        }

        /** install() — register all MMU regions (kernel/super/user PDR+PAR,
         *  plus the 11/70 Unibus map). */
        install() {
            if (!this.bus) return;
            this.bus.register(0o17772300, 16, this); // Kernel PDR
            this.bus.register(0o17772340, 16, this); // Kernel PAR
            this.bus.register(0o17772200, 16, this); // Super PDR
            this.bus.register(0o17772240, 16, this); // Super PAR
            this.bus.register(0o17777600, 16, this); // User PDR
            this.bus.register(0o17777640, 16, this); // User PAR
            if (this.cpuType === 70) {
                // 32 double words = 128 bytes (0o17770200–0o17770377).
                // iopage.js registers only 64 bytes here — the second half
                // (map regs 16–31) answers NXM, which breaks guests whose
                // DMA buffers live above 0x20000 (BSD 2.11 re-reads its
                // disklabel through map[26]).
                this.bus.register(0o17770200, 128, this); // Unibus Map
            }
        }

        access(physicalAddress, data, byteFlag) {
            const cpu = this._cpu();
            if (!cpu) return -1;
            // Bus passes full 22-bit addresses (0o1777xxxx); compare against
            // full addresses. The index formula below only touches bits
            // 0–9, so it is unaffected by the 0o100000/0o200000 top bits.
            const a = physicalAddress;
            let result;

            // ------------------------------------------------------------
            // 17770200–17770277 — Unibus map (11/70 only): 32 double words
            // ------------------------------------------------------------
            if (a >= 0o17770200 && a < 0o17770300) {
                if (this.cpuType !== 70) return -1;
                if (data >= 0 && typeof process !== "undefined" && process.env && process.env.DEBUG_MMU) {
                    process.stderr.write("MMU MAP " + physicalAddress.toString(8) + "=" +
                        data.toString(8) + "\n");
                }
                const index = (physicalAddress >>> 2) & 0x1f;
                if (physicalAddress & 0o2) { // high word (control + upper addr)
                    result = insertData(cpu.unibusMap[index] >>> 16,
                        physicalAddress, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        cpu.unibusMap[index] = ((result & 0x803f) << 16) |
                            (cpu.unibusMap[index] & 0xffff);
                    }
                } else { // low word (base address bits 0–15)
                    result = insertData(cpu.unibusMap[index] & 0xffff,
                        physicalAddress, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        cpu.unibusMap[index] = (cpu.unibusMap[index] & 0x803f0000) |
                            (result & 0xfffe);
                    }
                }
                return result;
            }

            // ------------------------------------------------------------
            // PDR / PAR regions
            // ------------------------------------------------------------
            const isPar = (a >= 0o17772340 && a < 0o17772400) ||
                (a >= 0o17772240 && a < 0o17772300) ||
                (a >= 0o17777640 && a < 0o17777700);
            const isPdr = (a >= 0o17772300 && a < 0o17772340) ||
                (a >= 0o17772200 && a < 0o17772240) ||
                (a >= 0o17777600 && a < 0o17777640);
            if (!isPar && !isPdr) return -1; // not ours (other slots)

            const index = (((a & 0o0600) >>> 3) ^ ((a & 0o0100) >>> 2)) |
                ((a >>> 1) & 0o17);

            if (isPar) {
                result = insertData(cpu.mmuPAR[index], physicalAddress,
                    data, byteFlag);
                if (result >= 0) {
                    if (data >= 0 && typeof process !== "undefined" && process.env.DEBUG_MMU) {
                        console.log("MMU PAR[" + index + "]=" + result.toString(8) +
                            " @" + (cpu.registerVal ? cpu.registerVal[7].toString(8) : "?"));
                    }
                    cpu.mmuPAR[index] = result;
                    cpu.mmuPDR[index] &= 0xff0f; // PAR write clears PDR flags
                }
            } else {
                result = insertData(cpu.mmuPDR[index], physicalAddress,
                    data, byteFlag);
                if (result >= 0) {
                    if (data >= 0 && typeof process !== "undefined" && process.env.DEBUG_MMU) {
                        console.log("MMU PDR[" + index + "]=" + (result & 0xff0f).toString(8) +
                            " @" + (cpu.registerVal ? cpu.registerVal[7].toString(8) : "?"));
                    }
                    cpu.mmuPDR[index] = result & 0xff0f;
                }
            }
            return result;
        }
    }

    const api = { MmuRegs };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.MmuRegs = MmuRegs;
    }
})(typeof window !== "undefined" ? window : globalThis);
