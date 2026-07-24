// Javascript PDP 11/70 Emulator v4.0
// written by Paul Nankervis
// Please send suggestions, fixes and feedback to paulnank@hotmail.com
//
// This code may be used freely provided the original author name is acknowledged in any modified source code
//
//
// ====================================================================
// IOPAGE Module — PDP‑11 Unibus I/O Page Dispatcher
// ====================================================================
// Central registry for all Unibus‑mapped devices. Each device registers
// an access handler, optional interrupt poll handler, and optional reset.
// The I/O page is divided into 8‑byte slots; devices map one or more
// slots depending on register count.

var iopage = (function() {
    "use strict";

    // Registered device handlers
    var deviceReset = [];                 // reset() handlers
    var devicePoll  = [];                 // poll() handlers (sorted by priority)
    var deviceAccess = new Array(0o17777 >>> 3); // access() handlers by slot

    return {

        // ------------------------------------------------------------
        // access() — dispatch Unibus I/O reads/writes
        // ------------------------------------------------------------
        access: function(physicalAddress, data, byteFlag) {
            let index = (physicalAddress & 0o17777) >>> 3;
            let access = deviceAccess[index];

            if (access === undefined) {
                return trap(0o4, 0x10);   // Unibus timeout
            }

            let result = access(physicalAddress, data, byteFlag);

            // Apply byte extraction on successful reads
            if (result >= 0 && byteFlag) {
                result = (physicalAddress & 1) ? (result >>> 8) : (result & 0xFF);
            }

            // Log NXM except for PSW
            if (result < 0 && physicalAddress !== PSW_ADDRESS) {
                console.log(
                    "IOPAGE nxm " +
                    physicalAddress.toString(8) + " " +
                    data.toString(8) + " @" +
                    CPU.registerVal[7].toString(8)
                );
            }

            return result;
        },

        // ------------------------------------------------------------
        // poll() — check devices for pending interrupts
        // ------------------------------------------------------------
        poll: function() {
            let priority = CPU.PSW & PSW_PRIORITY_MASK;

            // PIR may have priority
            if ((CPU.PIR & PSW_PRIORITY_MASK) > priority) {
                priority = CPU.PIR & PSW_PRIORITY_MASK;
            }

            // Devices are sorted highest‑priority last → scan backwards
            for (let i = devicePoll.length - 1; i >= 0; i--) {
                let devPri = devicePoll[i](0);   // poll(0) → priority + pending flag

                if ((devPri & PSW_PRIORITY_MASK) <= priority) {
                    break;
                }
                if (devPri & 1) {
                    trap(devicePoll[i](1), 0x00); // take device interrupt
                    return true;
                }
            }

            // PIR interrupt
            if (priority > (CPU.PSW & PSW_PRIORITY_MASK)) {
                trap(0o240, 0x00);
                return true;
            }

            return false;
        },

        // ------------------------------------------------------------
        // register() — install a device into the I/O page
        // ------------------------------------------------------------
        register: function(address, count, device) {

            // Must be in I/O page
            if ((address & 0o17760000) !== 0o17760000) {
                console.log("iopage.register invalid address:" + address.toString(8));
                return;
            }

            if (typeof device.access !== "function") {
                console.log("iopage.register missing access handler at " + address.toString(8));
                return;
            }

            // Map access handlers into 8‑byte slots
            for (let index = (address & 0o17777) >>> 3; count > 0; count -= 4, index++) {
                if (deviceAccess[index] !== undefined) {
                    console.log("iopage.register overlap at " + address.toString(8));
                }
                deviceAccess[index] = device.access;
            }

            // Optional interrupt poll handler
            if (typeof device.poll === "function") {
                let pri = device.poll(0) & PSW_PRIORITY_MASK;
                if (!pri) {
                    console.log("iopage.register device with no priority at " + address.toString(8));
                    return;
                }

                // Insert sorted by priority (lowest first)
                let insert = devicePoll.length - 1;
                while (insert >= 0 &&
                       (devicePoll[insert](0) & PSW_PRIORITY_MASK) > pri) {
                    insert--;
                }
                devicePoll.splice(insert + 1, 0, device.poll);
            }

            // Optional reset handler
            if (typeof device.reset === "function") {
                deviceReset.push(device.reset);
            }
        },

        // ------------------------------------------------------------
        // reset() — reset all registered devices
        // ------------------------------------------------------------
        reset: function() {
            for (let i = deviceReset.length - 1; i >= 0; i--) {
                deviceReset[i]();
            }
        }
    };
})();


// --------------------------------------------------------------------
// insertData — merge a byte/word write into an existing word
// --------------------------------------------------------------------
// • Byte write: update high/low byte depending on address bit 0
// • Word write: requires even address; replaces full word
// • Reads (data < 0) return the original unchanged
function insertData(currentWord, physicalAddress, data, isByteAccess) {
    if (isByteAccess) {
        if (data < 0) return currentWord;          // read
        return (physicalAddress & 1)
            ? ((data << 8) & 0xFF00) | (currentWord & 0x00FF)   // high byte
            : (currentWord & 0xFF00) | (data & 0x00FF);         // low byte
    }

    if (physicalAddress & 1) {
        return trap(0o4, 0x40);                    // odd word address
    }
    return (data < 0) ? currentWord : data;        // read or full write
}


// --------------------------------------------------------------------
// requestInterrupt — flag pending interrupt and wake CPU from WAIT
// --------------------------------------------------------------------
function requestInterrupt() {
    CPU.interruptRequested = 1;
    if (CPU.runState === STATE_WAIT) {
        CPU.runState = STATE_RUN;
    }
}


// --------------------------------------------------------------------
// Core CPU control registers (17777770–17777776)
// --------------------------------------------------------------------
// • 17777770  Microbreak (debug aid)
// • 17777772  PIR – Programmable Interrupt Register
// • 17777774  Stack limit register
// • 17777776  PSW – Processor Status Word
//
// These registers are always present on 11/45 and 11/70.
// --------------------------------------------------------------------

iopage.register(0o17777770, 4, (function() {
    let microBreak = 0;

    function initREG() {
        CPU.PIR = 0;
        CPU.stackLimit = 0xff;
        CPU.CPU_Error = 0;
        CPU.MMR0 = 0;
        CPU.MMR3 = 0;
        CPU.mmuEnable = 0;
        setMMUmode(0);
        CPU.mmuLastPage = 0;
    }

    initREG();

    return {
        access: function(pa, data, byteFlag) {
            let result;

            switch (pa & 0o17777776) {

                // --------------------------------------------------------
                // 17777770 — Microbreak (8‑bit)
                // --------------------------------------------------------
                case 0o17777770:
                    result = insertData(microBreak, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        microBreak = result & 0xff;
                    }
                    break;

                // --------------------------------------------------------
                // 17777772 — PIR (Programmable Interrupt Register)
                // --------------------------------------------------------
                case 0o17777772:
                    result = insertData(CPU.PIR, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        // Mask to priority bits only
                        result &= 0xfe00;

                        // Convert mask → encoded priority
                        if (result) {
                            let idx = result >>> 9;
                            do { result += 0x22; } while (idx >>= 1);
                        }

                        CPU.PIR = result;

                        // Raise interrupt if PIR priority exceeds current CPU priority
                        if ((result & PSW_PRIORITY_MASK) >
                            (CPU.PSW & PSW_PRIORITY_MASK)) {
                            requestInterrupt();
                        }
                    }
                    break;

                // --------------------------------------------------------
                // 17777774 — Stack limit (low byte always forced to 0xFF)
                // --------------------------------------------------------
                case 0o17777774:
                    result = insertData(CPU.stackLimit, pa, data, byteFlag);
                    if (result >= 0) {
                        if (data >= 0) {
                            CPU.stackLimit = result | 0xff;
                        }
                        result &= 0xff00;
                    }
                    break;

                // --------------------------------------------------------
                // 17777776 — PSW (Processor Status Word)
                // --------------------------------------------------------
                case PSW_ADDRESS:
                    result = insertData(readPSW(), pa, data, byteFlag);
                    if (data >= 0 && result >= 0) {
                        writePSW(result);
                        return -1;   // Caller must not overwrite PSW again
                    }
                    break;
            }

            return result;
        },

        reset: initREG
    };
})());


// === Miscellaneous 11/70 Registers ===
// Only present on PDP-11/70 (not 11/45).
//   • 17777760 Lower size register: reports configured memory size (low half).
//   • 17777762 Upper size register: reserved, always returns 0.
//   • 17777764 System I/D register: identifies system type (returns 1).
//   • 17777766 CPU error register: reports CPU error flags; writes always clears to 0.

if (CPU_TYPE === 70) { // 11/45 doesn't have these
    iopage.register(0o17777760, 4, {
        access: function(physicalAddress, data, byteFlag) {
            "use strict";
            let result;
            switch (physicalAddress & 0o17777776) {
                case 0o17777760: // Lower size
                    result = insertData((MAX_MEMORY >>> 6) - 1, physicalAddress, data, byteFlag);
                    break;
                case 0o17777762: // Upper size
                    result = insertData(0, physicalAddress, data, byteFlag);
                    break;
                case 0o17777764: // System I/D
                    result = insertData(1, physicalAddress, data, byteFlag);
                    break;
                case 0o17777766: // CPU error
                    result = insertData(CPU.CPU_Error, physicalAddress, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        CPU.CPU_Error = 0; // always writes as zero
                    }
                    break;
            }
            return result;
        }
    });
}

// === 11/70 Maintenance Registers ===
// Only present on PDP-11/70 (not 11/45).
//   • 17777750 Maintenance register
//   • 17777752 Hit/miss register
//   • 17777754 Reserved (unused)
//   • 17777756 Reserved (unused)
//
// These registers are not actively emulated; access always returns 0.
// Writes are ignored.


if (CPU_TYPE === 70) { // 11/45 doesn't have these
    iopage.register(0o17777750, 4, {
        access: function(physicalAddress, data, byteFlag) {
            "use strict";
            let result;
            switch (physicalAddress & 0o17777776) {
                case 0o17777750: // Maintenance
                case 0o17777752: // Hit/miss
                case 0o17777754: //
                case 0o17777756: //
                    result = insertData(0, physicalAddress, data, byteFlag);
                    break;
            }
            return result;
        }
    });
}

// === 11/70 Memory Control Registers ===
// Only present on PDP-11/70 (not 11/45).
//   • 17777740 Low error address
//   • 17777742 High error address
//   • 17777744 Memory system error
//   • 17777746 Cache control
//
// Stub implementation: returns fixed values, ignores writes.

if (CPU_TYPE === 70) { // 11/45 doesn't have these
    iopage.register(0o17777740, 4, {
        access: function(physicalAddress, data, byteFlag) {
            "use strict";
            let result;
            switch (physicalAddress & 0o17777776) {
                case 0o17777740: // Low error address
                    result = insertData(0o177740, physicalAddress, data, byteFlag);
                    break;
                case 0o17777742: // High error address
                    result = insertData(0o3, physicalAddress, data, byteFlag);
                    break;
                case 0o17777744: // Memory system error
                    result = insertData(0, physicalAddress, data, byteFlag);
                    break;
                case 0o17777746: // Cache control
                    result = insertData(0o17, physicalAddress, data, byteFlag);
                    break;
            }
            return result;
        }
    });
}

// === Register Set Access ===
// Maps CPU registers onto the I/O page.
//   • Register set 0 (R0–R5, kernel SP, kernel PC) at 17777700.
//   • Register set 1 (R0–R5, super SP, user SP) at 17777710.
//
// Notes:
//   - No byte handling is performed (word access only).
//   - Register set selection depends on PSW bit 11 (0x800).
//   - Stack pointer mapping depends on current MMU mode:
//       • Kernel mode → R6
//       • Super mode → stackPointer[1]
//       • User mode  → stackPointer[3]

// === Register Set 0 (R0–R5, Kernel SP, Kernel PC) ===

iopage.register(0o17777700, 4, {
    access: function(physicalAddress, data, byteFlag) {
        "use strict";
        let result;
        let index = physicalAddress & 7;
        switch (index) {
            default: // register set 0 (R0 - R5)
                if (CPU.PSW & PSW_REGISTER_SET_BIT) { // PSW bit 11 selects alternate set
                    if (data >= 0) {
                        CPU.registerAlt[index] = data;
                    }
                    result = CPU.registerAlt[index];
                } else {
                    if (data >= 0) {
                        CPU.registerVal[index] = data;
                    }
                    result = CPU.registerVal[index];
                }
                break;
            case 0o6: // 17777706 Kernel SP (R6)
                if (CPU.mmuMode === 0) { // Kernel Mode
                    if (data >= 0) {
                        CPU.registerVal[6] = data;
                    }
                    result = CPU.registerVal[6];
                } else {
                    if (data >= 0) {
                        CPU.stackPointer[0] = data;
                    }
                    result = CPU.stackPointer[0];
                }
                break;
            case 0o7: // 17777707 Kernel PC (R7)
                if (data >= 0) {
                    CPU.registerVal[7] = data;
                }
                result = CPU.registerVal[7];
                break;
        }
        return result; // word access only, no byte handling
    }
});

// === Register Set 1 (R0–R5, Super SP, User SP) ===

iopage.register(0o17777710, 4, {
    access: function(physicalAddress, data, byteFlag) {
        "use strict";
        let result;
        let index = physicalAddress & 7;
        switch (index) {
            default: // register set 1 (R0 - R5)
                if (CPU.PSW & PSW_REGISTER_SET_BIT) { // PSW bit 11 selects alternate set
                    if (data >= 0) {
                        CPU.registerVal[index] = data;
                    }
                    result = CPU.registerVal[index];
                } else {
                    if (data >= 0) {
                        CPU.registerAlt[index] = data;
                    }
                    result = CPU.registerAlt[index];
                }
                break;
            case 0o6: // 17777716 Super SP (R6)
                if (CPU.mmuMode === 1) { // Super mode
                    if (data >= 0) {
                        CPU.registerVal[6] = data;
                    }
                    result = CPU.registerVal[6];
                } else {
                    if (data >= 0) {
                        CPU.stackPointer[1] = data;
                    }
                    result = CPU.stackPointer[1];
                }
                break;
            case 0o7: // 17777717 User SP (R6)
                if (CPU.mmuMode === 3) { // User mode
                    if (data >= 0) {
                        CPU.registerVal[6] = data;
                    }
                    result = CPU.registerVal[6];
                } else {
                    if (data >= 0) {
                        CPU.stackPointer[3] = data;
                    }
                    result = CPU.stackPointer[3];
                }
                break;
        }
        return result; // word access only, no byte handling
    }
});

// === Console & MMR Registers ===
// Maps console panel switches/lights and MMU maintenance registers onto the I/O page.
//   • 17777570 Console panel display/switch register
//   • 17777572 MMR0 (MMU control/status)
//   • 17777574 MMR1 (MMU register auto-increment status)
//   • 17777576 MMR2 (MMU instruction address)
//
// Notes:
//   - Console register updates CPU.displayRegister when written.
//   - MMR0 controls MMU enable state and last page accessed.
//   - MMR1 is byte‑swapped if high byte is non‑zero.
//   - MMR2 is directly readable/writable.


iopage.register(0o17777570, 4, {
    access: function(physicalAddress, data, byteFlag) {
        "use strict";
        let result;
        switch (physicalAddress & 0o17777776) {
            case 0o17777570: // 17777570 console panel display/switch;
                result = insertData(CPU.switchRegister & 0xffff, physicalAddress, data, byteFlag);
                if (result >= 0 && data >= 0) {
                    CPU.displayRegister = result;
                }
                break;
            case 0o17777572: // 17777572 MMR0
                if (!(CPU.MMR0 & 0xe000)) {
                    CPU.MMR0 = (CPU.MMR0 & 0xf381) | (CPU.mmuLastPage << 1);
                }
                result = insertData(CPU.MMR0, physicalAddress, data, byteFlag);
                if (result >= 0 && data >= 0) {
                    CPU.MMR0 = result &= 0xf381;
                    CPU.mmuLastPage = (result >>> 1) & 0x3f;
                    if (result & 0x101) {
                        if (result & 0x1) {
                            CPU.mmuEnable = MMU_READ | MMU_WRITE;
                        } else {
                            CPU.mmuEnable = MMU_WRITE;
                        }
                    } else {
                        CPU.mmuEnable = 0;
                        CPU.mmuLastPage = 0; // Data light off
                    }
                }
                break;
            case 0o17777574: // 17777574 MMR1 - note byte swap
                result = CPU.MMR1;
                if (result & 0xff00) {
                    result = ((result << 8) | (result >>> 8)) & 0xffff;
                }
                break;
            case 0o17777576: // 17777576 MMR2
                result = insertData(CPU.MMR2, physicalAddress, data, byteFlag);
                if (result >= 0) {
                    CPU.MMR2 = result;
                }
                break;
        }
        return result;
    }
});

// === MMR3 Register ===
// Maps MMR3 onto the I/O page (standalone).
//   • 17772516 MMR3 - UB, 22-bit, K/S/U mode bits
//
// Notes:
//   - Controls Unibus map enable and 22-bit addressing.
//   - On 11/45, bits 0x30 are masked out (no 22-bit or Unibus map).
//   - Updates CPU.MMR3 and re-applies MMU mode via setMMUmode().


iopage.register(0o17772510, 1, {
    access: function(physicalAddress, data, byteFlag) {
        "use strict";
        let result;
        switch (physicalAddress & 0o17777776) {
            case 0o17772516: // 17772516 MMR3 - UB 22 x K S U
                result = insertData(CPU.MMR3, physicalAddress, data, byteFlag);
                if (result >= 0 && data >= 0) {
                    if (CPU_TYPE !== 70) {
                        result &= ~0x30; // mask out 22-bit/Unibus map on 11/45
                    }
                    CPU.MMR3 = result;
                    setMMUmode(CPU.mmuMode); // re-apply MMU mode
                }
                break;
            default:
                return trap(0o4, 0x10); // Trap 4 - 0x10 Unibus time-out
        }
        return result;
    }
});

// === MMU Register Access ===
// Provides access to PDP-11 MMU registers via the I/O page.
//   • PDR (Page Descriptor Registers): 16 entries per mode.
//       - Kernel (0): 17772300–17772337
//       - Super  (1): 17772200–17772237
//       - User   (3): 17777600–17777637
//   • PAR (Page Address Registers): 16 entries per mode.
//       - Kernel (0): 17772340–17772377
//       - Super  (1): 17772240–17772277
//       - User   (3): 17777640–17777677
//
// Index calculation:
//   Combines bits from physical address to yield 0–15 (kernel),
//   16–31 (super), 48–63 (user).


var mmuRegisterPDR = {
    access: function(physicalAddress, data, byteFlag) {
        "use strict";
        let index = (((physicalAddress & 0o0600) >>> 3) ^ ((physicalAddress & 0o0100) >>> 2)) | ((physicalAddress >>> 1) & 0o17);
        let result = insertData(CPU.mmuPDR[index], physicalAddress, data, byteFlag);
        if (result >= 0) {
            CPU.mmuPDR[index] = result & 0xff0f;
        }
        return result;
    }
};

var mmuRegisterPAR = {
    access: function(physicalAddress, data, byteFlag) {
        "use strict";
        let index = (((physicalAddress & 0o0600) >>> 3) ^ ((physicalAddress & 0o0100) >>> 2)) | ((physicalAddress >>> 1) & 0o17);
        let result = insertData(CPU.mmuPAR[index], physicalAddress, data, byteFlag);
        if (result >= 0) {
            CPU.mmuPAR[index] = result;
            CPU.mmuPDR[index] &= 0xff0f; // PAR write clears PDR flags
        }
        return result;
    }
};

// Register kernel, super, and user PDR/PAR maps
iopage.register(0o17772300, 16, mmuRegisterPDR); // Kernel PDR
iopage.register(0o17772340, 16, mmuRegisterPAR); // Kernel PAR
iopage.register(0o17772200, 16, mmuRegisterPDR); // Super PDR
iopage.register(0o17772240, 16, mmuRegisterPAR); // Super PAR
iopage.register(0o17777600, 16, mmuRegisterPDR); // User PDR
iopage.register(0o17777640, 16, mmuRegisterPAR); // User PAR

// === PDP-11/70 Unibus Mapping ===
// Provides access to the Unibus map registers via the I/O page.
//   • 17770200–17770277: 32 double-word mapping registers.
//     - Each register maps an 18-bit Unibus address block into 22-bit memory.
//     - Low word: base address (bits 0–15).
//     - High word: control bits + upper address (bits 16–31).
//

if (CPU_TYPE === 70) { // 11/45 doesn't have a unibus map
    iopage.register(0o17770200, 64, { // 17770200 - 17770277 Unibus Map (32 double words!)
        access: function(physicalAddress, data, byteFlag) {
            "use strict";
            let result;
            let index = (physicalAddress >>> 2) & 0x1f; // 32 double words
            if (physicalAddress & 0o2) { // High word access
                result = insertData(CPU.unibusMap[index] >>> 16, physicalAddress, data, byteFlag);
                if (result >= 0 && data >= 0) {
                    CPU.unibusMap[index] = ((result & 0x803f) << 16) | (CPU.unibusMap[index] & 0xffff);
                }
            } else { // Low word access
                result = insertData(CPU.unibusMap[index] & 0xffff, physicalAddress, data, byteFlag);
                if (result >= 0 && data >= 0) {
                    CPU.unibusMap[index] = (CPU.unibusMap[index] & 0x803f0000) | (result & 0xfffe);
                }
            }
            return result;
        }
    });
}

// function to map an 18 bit unibus address to a 22 bit memory address via the unibus map (if active)

function mapUnibus(ba) {
    "use strict";
    var index = (ba >>> 13) & 0x1f; // top 5 bits select mapping register
    if (index < 31) {
        if (CPU.MMR3 & 0x20) { // Unibus map enabled
            ba = (CPU.unibusMap[index] + (ba & 0x1fff)) & 0x3fffff; // 13 low bits become offset
        }
    } else {
        ba |= IOBASE_22BIT; // Top page always maps to Unibus I/O page
    }
    return ba;
}

function busReadWord(ba) {
    const v = readWordByPhysical(mapUnibus(ba));
    return v;
}

function busWriteWord(ba, data) {
    const v = writeWordByPhysical(mapUnibus(ba), data & 0xFFFF);
    return v;
}

function busReadLong(ba) {
    const lo = readWordByPhysical(mapUnibus(ba));
    if (lo < 0) {
        return lo;
    }
    const hi = readWordByPhysical(mapUnibus(ba + 2));
    if (hi < 0) {
        return hi;
    }
    return ((hi << 16) | lo) >>> 0;
}

function busWriteLong(ba, data) {
    let v= writeWordByPhysical(mapUnibus(ba), data & 0xFFFF);
    if (v < 0) {
        return v;
    }
    v = writeWordByPhysical(mapUnibus(ba + 2), data >>> 16);
    return v;
}




// ================================================================
// KW11‑L Line Time Clock (17777546)
// ================================================================
// Provides periodic tick interrupts for OS scheduling.
// Fixed‑rate line clock (default 50 Hz). MON set on each tick;
// writing CSR clears MON. IE enables interrupts.
//
// Registers:
//   00: CSR – Control/Status
//       bit 7 (MON) – set on tick, cleared on write
//       bit 6 (IE)  – interrupt enable
//
// Interrupts:
//   Vector: 0100
//   Priority: IPL 6
//
// Notes:
//   - Tick interval defined by KW_TICK_MS (20 ms for 50 Hz).
//   - No UI or runtime frequency switching.
// ================================================================

iopage.register(0o17777546, 1, (function() {
    "use strict";

    const KW_VECTOR   = 0o100;
    const KW_PRIORITY = 6 << 5;

    const KW_CSR_MON  = 0x80;
    const KW_CSR_IE   = 0x40;

    const KW_TICK_MS  = 20;   // 50 Hz; change to ~17 for 60 Hz

    let csr;
    let iMask;
    let tickTimer;

    function initKW() {
        csr = KW_CSR_MON;   // MON set, IE clear
        iMask = 0;
        startTimer();
    }

    function startTimer() {
        if (tickTimer) clearInterval(tickTimer);
        tickTimer = setInterval(() => {
            csr |= KW_CSR_MON;
            if (csr & KW_CSR_IE) {
                iMask = 1;
                requestInterrupt();
            }
        }, KW_TICK_MS);
    }

    return {
        access: function(pa, data, byteFlag) {
            let result;
            switch (pa & 0o6) {
                case 0o6: { // CSR
                    result = insertData(csr, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        // IE edge
                        if ((result ^ csr) & KW_CSR_IE) {
                            if (result & KW_CSR_IE) {
                                iMask = 1;
                                requestInterrupt();
                            } else {
                                iMask = 0;
                            }
                        }
                        // Write clears MON, preserves IE
                        csr = result & KW_CSR_IE;
                    }
                    return result;
                }
                default:
                    return trap(0o4, 0x10);
            }
        },

        poll: function(takeInterrupt) {
            if (takeInterrupt) {
                iMask = 0;
                return KW_VECTOR;
            } else {
                if (!(csr & KW_CSR_IE)) iMask = 0;
                return KW_PRIORITY | (iMask ? 1 : 0);
            }
        },

        reset: initKW
    };
})());



// ================================================================
// === DL11 Terminal Interface ====================================
//
// Emulates PDP-11 DL11 terminal (console or additional TTYs).
//
// Registers:
// 17777560 RCSR (Receive Control/Status)
// 17777562 RBUF (Receive Buffer)
// 17777564 XCSR (Transmit Control/Status)
// 17777566 XBUF (Transmit Buffer)
//
// Interrupts:
// • Vector: deviceVector (per unit)
// • Priority: 4 << 5
// • iMask bit 0 = receive, bit 1 = transmit
//
// ================================================================

function dl11(vt52Unit, deviceVector) {
    "use strict"

    // --- DL11 Interrupts ---
    const DL_PRIORITY = 4 << 5; // Interrupt priority
    const DL_IMASK_RECEIVE = 1; // Interrupt mask for receive
    const DL_IMASK_TRANSMIT = 2; // Interrupt mask for transmit

    // --- RCSR (Receive Control/Status) bits ---
    const DL_RCSR_DONE = 0x80; // Receive done
    const DL_RCSR_IE = 0x40; // Receive interrupt enable

    // --- XCSR (Transmit Control/Status) bits ---
    const DL_XCSR_DONE = 0x80; // Transmit done
    const DL_XCSR_IE = 0x40; // Transmit interrupt enable

    // Time between input characters (important for paste)
    const DL_INPUT_DELAY = 3;

    let rcsr, rbuf;
    let xcsr, xbuf;
    let xdelay;
    let iMask;
    let textArea;
    let screenCanvas;
    let typeAhead = [];
    let receiverBusy = false;
    let pasteCR = true;
    const unit = vt52Unit;
    const vector = deviceVector;

    // --- Initialization ---
    function initDL() {
        rcsr = 0;
        rbuf = 0;
        xcsr = DL_XCSR_DONE; // ready to transmit
        xbuf = 0;
        xdelay = 0;
        typeAhead = [];
        iMask = 0;
    }
    // --- Input handler ---
    // Accepts a single byte and attempts to deliver it to the DL11.
    // Returns true if accepted, false if receiver still busy.
    function dlReceiveChar(ttyUnit, ch) {
        if (rcsr & DL_RCSR_DONE) return false; // reject if DONE still set

        rbuf = ch;
        rcsr |= DL_RCSR_DONE;

        if (rcsr & DL_RCSR_IE) {
            iMask |= DL_IMASK_RECEIVE;
            requestInterrupt();
        }

        return true;
    }

    // --- Queue characters for input handler ---
    // Now accepts an ARRAY of bytes.
    function dlReceiveQueue(unit, bytes) {
        for (const b of bytes) {
            typeAhead.push(b & 0x7F); // DL11 is 7-bit clean
        }
        dlPump(unit);
    }

    // Expose globally for the visual punch-keyboard (and inline handlers)
    // Unit 0 → global dlReceiveQueue (console, used by Teletype page)
    // Unit 1 → global dlReceiveQueue1 (VT52 page)
    if (unit === 0) {
        window.dlReceiveQueue = dlReceiveQueue;
    } else if (unit === 1) {
        window.dlReceiveQueue1 = dlReceiveQueue;
    }

    // --- Typeahead queue service routine ---
    // Feeds one byte at a time into dlReceiveChar(), respecting DL11 timing.
    function dlPump(unit) {
        if (receiverBusy || typeAhead.length === 0) return;

        // Try to deliver the next byte
        if (dlReceiveChar(unit, typeAhead[0])) {
            typeAhead.shift();
        }

        // DL11 receiver busy timing
        receiverBusy = true;
        setTimeout(() => {
            receiverBusy = false;
            dlPump(unit);
        }, DL_INPUT_DELAY);
    }

    // paste handler
    function handlePasteText(unit, text) {
        // Apply CR/LF normalization if enabled
        if (pasteCR) {
            text = text.replace(/\r\n/g, "\r");
            text = text.replace(/\n/g, "\r");
        }
        const bytes = [];
        for (const ch of text) {
            bytes.push(ch.charCodeAt(0) & 0x7F);
        }
        dlReceiveQueue(unit, bytes);
    }

    function paste(ev) {
        ev.preventDefault();
        const text = ev.clipboardData.getData("text");
        handlePasteText(unit, text);
    }

    // --- Lazy UI creation on first output ---
    // Expose the receive queue globally for console (tty0) input
    function ensureTtyUI(unit) {
        // For unit 0 (console): output goes to Google60 printer,
        // input is handled by the visual punch-keyboard in the HTML.
        // Physical keyboard input is captured globally by g60Keyboard.init().
        if (unit === 0) {
            return null; // no textarea needed
        }

        // If VT52 terminal is already initialized (e.g., on VT52 page with canvas),
        // do NOT create a duplicate UI. The global vt52Get() checks the VT map.
        if (typeof window.vt52Get === 'function' && window.vt52Get(unit)) {
            return document.getElementById(`tty${unit}_textarea`);
        }

        // Original behavior for tty1, tty2, etc.
        const textareaId = `tty${unit}_textarea`;
        const canvasId = `tty${unit}_screen`;
        const container = document.getElementById(`tty${unit}_div`);

        if (!container) return null;

        // Label: tty0 named "Console", others "TTYn"
        const label = (unit === 0) ? "Console (tty0)" : `tty${unit}`;

        // Build inner HTML with textarea + empty button row

        container.innerHTML = `
        <p>${label}<br />

        <canvas id="${canvasId}" width="1056" height="384"
                style="display:none; border:1px solid #ccc"></canvas>

        <textarea id="${textareaId}" cols="132" rows="24"
            style="font-family:monospace"
            autocomplete="off" autocorrect="off"
            autocapitalize="off" spellcheck="false"></textarea><br />

        <span id="tty${unit}_buttons"></span>
        </p>
        `;

        const screenCanvas = document.getElementById(canvasId);
        const textArea     = document.getElementById(textareaId);

        textArea.addEventListener("paste", (e) => paste(e));
        screenCanvas.addEventListener("paste", (e) => paste(e));

        // --- Build buttons programmatically ---
        const btnRow = document.getElementById(`tty${unit}_buttons`);
        // --- Build buttons programmatically (array‑driven) ---

        // Declarative button definitions
        const dl11Buttons = [
          { label: "Clear", action: (ctx) => ctx.textArea.value = "" },
          { label: "Paste", action: async (ctx) => {
              try {
                const text = await navigator.clipboard.readText();
                if (text) ctx.handlePaste(text);
              } catch (err) {
                console.log("Paste failed:", err);
              }
              ctx.textArea.focus();
            }
          },
          { label: "Paste CR: ON", toggle: true, stateKey: "pasteCR",
            action: (ctx) => ctx.pasteCR = !ctx.pasteCR,
            updateLabel: (btn, ctx) =>
              btn.textContent = ctx.pasteCR ? "Paste CR: ON" : "Paste CR: OFF"
          },

          // Control characters
          { label: "^C",  send: [3] },
          { label: "^D",  send: [4] },
          { label: "^H",  send: [8] },
          { label: "LF",  send: [10] },
          { label: "^Q",  send: [17] },
          { label: "^S",  send: [19] },
          { label: "^T",  send: [20] },
          { label: "^Z",  send: [26] },
          { label: "ESC", send: [27] },
          { label: "TAB", send: [9] },
          { label: "Break", send: [0] }
        ];

        // Factory to build all buttons
        function buildButtons(btnRow, ctx) {
          dl11Buttons.forEach(def => {
            const b = document.createElement("button");
            b.textContent = def.label;

            if (def.send) {
              b.addEventListener("click", () => {
                dlReceiveQueue(ctx.unit, def.send);
                ctx.textArea.focus();
              });

            } else if (def.toggle) {
              b.addEventListener("click", () => {
                def.action(ctx);
                def.updateLabel(b, ctx);
                ctx.textArea.focus();
              });
              def.updateLabel(b, ctx);

            } else {
              b.addEventListener("click", () => def.action(ctx));
            }

            btnRow.appendChild(b);
          });
        }

        // Build the row
        buildButtons(btnRow, {
          unit,
          textArea,
          pasteCR,
          handlePaste: (text) => handlePasteText(unit, text)
        });

        // Initialize VT52 emulation
        vt52Initialize(unit, dlReceiveQueue, textArea, screenCanvas, {});

        return textArea;
    }

    initDL();

    // Proactively initialize console UI for tty0 so keyboard input works immediately
    if (unit === 0) {
        setTimeout(function() { ensureTtyUI(0); }, 0);
    }

    // --- Device interface ---
    return {
        access: function(physicalAddress, data, byteFlag) {
            let result;
            switch (physicalAddress & 0o6) {
                case 0o0: { // RCSR
                    result = insertData(rcsr, physicalAddress, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        if ((result ^ rcsr) & DL_RCSR_IE) {
                            if (result & DL_RCSR_IE) {
                                rcsr |= DL_RCSR_IE;
                                if (rcsr & DL_RCSR_DONE) {
                                    iMask |= DL_IMASK_RECEIVE;
                                    requestInterrupt();
                                }
                            } else {
                                rcsr &= ~DL_RCSR_IE;
                                iMask &= ~DL_IMASK_RECEIVE;
                            }
                        }
                    }
                    break;
                }
                case 0o2: { // RBUF
                    result = insertData(rbuf, physicalAddress, data, byteFlag);
                    if (result >= 0) rcsr &= ~DL_RCSR_DONE;
                    break;
                }
                case 0o4: { // XCSR
                    result = insertData(xcsr, physicalAddress, data, byteFlag);
                    if (result >= 0) {
                        if (data >= 0) { // write
                            if ((result ^ xcsr) & DL_XCSR_IE) {
                                if (result & DL_XCSR_IE) {
                                    if (xcsr & DL_XCSR_DONE) {
                                        xcsr = DL_XCSR_IE | DL_XCSR_DONE;
                                        iMask |= DL_IMASK_TRANSMIT;
                                        requestInterrupt();
                                    } else {
                                        xcsr = DL_XCSR_IE;
                                        setTimeout(() => {
                                            xcsr |= DL_XCSR_DONE;
                                            if (xcsr & DL_XCSR_IE) {
                                                iMask |= DL_IMASK_TRANSMIT;
                                                requestInterrupt();
                                            }
                                        }, 1);
                                    }
                                } else {
                                    xcsr = DL_XCSR_DONE;
                                    iMask &= ~DL_IMASK_TRANSMIT;
                                }
                            }
                        } else { // read
                            if (xdelay > 0 && --xdelay <= 0) {
                                xcsr |= DL_XCSR_DONE;
                            }
                        }
                    }
                    break;
                }
                case 0o6: { // XBUF
                    result = insertData(xbuf, physicalAddress, data, byteFlag);
                    if (data >= 0 && result >= 0) {
                        if (!textArea) {
                            textArea = ensureTtyUI(unit); // lazy creation
                        }
                        xbuf = result & 0x7f;
                        if (xbuf >= 8 && xbuf < 127) {
                            // Route console (tty0) to Google60 Printer, others use VT52
                            if (unit === 0 && typeof g60ConsoleWrite !== 'undefined') {
                                g60ConsoleWrite(xbuf);
                            } else {
                                vt52Write(unit, xbuf);
                            }
                        }
                        if (xcsr & DL_XCSR_IE) {
                            iMask |= DL_IMASK_TRANSMIT;
                            requestInterrupt();
                        } else {
                            xcsr &= ~DL_XCSR_DONE;
                            xdelay = 3;
                        }
                    }
                    break;
                }
            }
            return result;
        },
        poll: function(takeInterrupt) {
            if (takeInterrupt) {
                if (iMask & DL_IMASK_RECEIVE) {
                    iMask &= ~DL_IMASK_RECEIVE;
                    return vector;
                } else {
                    iMask = 0;
                    return vector + 4;
                }
            } else {
                return DL_PRIORITY | (iMask ? 1 : 0);
            }
        },
        reset: initDL
    };
}

// --- Register console and additional terminals ---
iopage.register(0o17777560, 4, dl11(0, 0o60));   // Console
iopage.register(0o17776500, 4, dl11(1, 0o310));  // TTY1
iopage.register(0o17776510, 4, dl11(2, 0o320));  // TTY2



// ================================================================
// LP11 Line Printer Controller Emulator
// ================================================================
//
// Overview:
// Emulates PDP‑11 LP11 line printer interface.
// Provides register‑level behavior for OS drivers and diagnostics.
//
// Registers (base 17777510):
// - 00: LPCS – Line Printer Control/Status
// - 02: LPDB – Line Printer Data Buffer
//
// Interrupts:
// - Vector   = 0200
// - Priority = 4 << 5
// - Command completion only (DONE always set)
//
// Notes:
// - DONE bit is never cleared (printer always ready).
// - Writing LPCS toggles interrupt enable.
// - Writing LPDB appends ASCII characters to printer output buffer.
//
// ================================================================

iopage.register(0o17777510, 2, (function() {
    "use strict";

    // --- Interrupts ---
    const LP_VECTOR   = 0o200;   // Interrupt vector
    const LP_PRIORITY = 4 << 5;  // Interrupt priority

    // --- LPCS (Control/Status Register) bits ---
    const LP_LPCS_DONE = 0x80; // DONE (always set, printer ready)
    const LP_LPCS_IE   = 0x40; // Interrupt enable

    // --- LP11 State ---
    let lpcs;          // Control/Status register
    let lpdb;          // Data buffer
    let iMask;         // Interrupt pending mask
    let lp11Element;   // UI element for printer output

    // --- initLP() ---
    // Initialize LP11 controller state.
    // - Sets LPCS DONE (printer always ready, IE clear)
    // - Clears data buffer and interrupt mask
    // - Resets UI element reference
    function initLP() {
        // Control/Status: DONE set, IE clear
        lpcs = LP_LPCS_DONE;

        // Clear data buffer
        lpdb = 0;

        // Clear interrupt mask
        iMask = 0;

        // Reset printer output UI element
        lp11Element = undefined;
    }

    // --- ensureUI() ---
    // Lazy UI creation for LP11 printer output.
    // - Creates textarea + Clear/Save buttons if not already present
    // - Attaches savePrinterOutput() helper to export contents
    function ensureUI() {
        if (lp11Element === undefined) {
            // Inject printer UI into lp11_div container
            document.getElementById("lp11_div").innerHTML =
                '<p>Printer<br />' +
                '<textarea id="lp11_id" cols="132" rows="24" spellcheck="false" ' +
                'style="font-family:monospace"></textarea><br />' +
                '<button onclick="document.getElementById(\'lp11_id\').value=\'\';">Clear</button> ' +
                '<button onclick="savePrinterOutput()">Save</button></p>';

            // Cache textarea element reference
            lp11Element = document.getElementById("lp11_id");

            // Attach save helper
            window.savePrinterOutput = function() {
                const text = lp11Element.value;
                const blob = new Blob([text], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "lp11_output.txt";
                a.click();
                URL.revokeObjectURL(url);
            };
        }
    }

    initLP();

    // --- Device interface ---
    return {
        // --- access() ---
        // Register access handler for LP11.
        // - Decodes register offset (pa & 0o6)
        // - Performs read/write depending on data >= 0
        // - Preserves DONE semantics (always set)
        // - Handles LPCS (control/status) and LPDB (data buffer)
        // - Returns register value or trap on invalid access
        access: function(pa, data, byteFlag) {
            let result;

            switch (pa & 0o6) {
                case 0o4: // LPCS – Line Printer Control/Status
                    result = insertData(lpcs, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        // Interrupt enable edge behavior
                        if ((result ^ lpcs) & LP_LPCS_IE) {
                            if (result & LP_LPCS_IE) {
                                iMask = 1;
                                requestInterrupt();
                            } else {
                                iMask = 0;
                            }
                        }
                        // DONE always set, IE preserved
                        lpcs = LP_LPCS_DONE | (result & LP_LPCS_IE);
                    }
                    break;

                case 0o6: // LPDB – Line Printer Data Buffer
                    result = insertData(lpdb, pa, data, byteFlag);
                    if (data >= 0 && result >= 0) {
                        // Ensure UI element exists
                        ensureUI();
                        lpdb = result & 0x7F; // 7‑bit ASCII

                        // Append printable characters (ignore CR, accept LF + printable)
                        if (lpdb >= 0o12 && lpdb !== 0o15) {
                            lp11Element.value += String.fromCharCode(lpdb);
                            if (lpdb === 0o12) {
                                lp11Element.scrollTop = lp11Element.scrollHeight;
                            }
                        }

                        // Raise interrupt if IE set
                        if (lpcs & LP_LPCS_IE) {
                            iMask = 1;
                            requestInterrupt();
                        }
                    }
                    break;

                default:
                    return trap(0o4, 0x10); // Unibus time‑out
            }

            return result;
        },
        // --- poll() ---
        // Interrupt poll handler for LP11.
        // - If takeInterrupt=true: delivers pending interrupt vector
        //   • Command completion only (DONE always set)
        // - If takeInterrupt=false: reports priority level + pending flag
        //   • Drops any pending interrupts if IE cleared
        poll: function(takeInterrupt) {
            if (takeInterrupt) {
                // Service command completion interrupt
                iMask = 0; // Clear mask after servicing
                return LP_VECTOR; // Interrupt vector
            } else {
                // If interrupts disabled, clear mask
                if (!(lpcs & LP_LPCS_IE)) iMask = 0;
                // Return priority level + pending flag
                return LP_PRIORITY | (iMask ? 1 : 0);
            }
        },

        // --- reset() ---
        // Controller reset handler.
        // - Reinitializes LP11 state (DONE set, IE clear)
        // - Clears buffer and interrupt mask
        // - Equivalent to power‑on reset
        reset: initLP
    };
})());


// ================================================================
// Disk / Tape I/O Support Routines
// ================================================================
//
// Overview:
// Provides unified cache‑based mechanism for block device I/O.
// Used by disk, magtape, and paper tape emulation layers.
//
// Cache:
// - Block size: 131072 bytes (IO_BLOCKSIZE)
// - Stored as Uint16Array (16‑bit words)
//
// Operations (diskIO):
// - OP_WRITE (1): Write memory → cache
// - OP_READ  (2): Read cache → memory
// - OP_CHECK (3): Compare memory with cache
// - OP_ACCUM (4): Tape record count accumulation
// - OP_BYTE  (5): PTR single‑byte read
//
// Callback status codes:
// - 0 → Success (I/O complete)
// - 2 → NXM (Nonexistent Memory)
// - 3 → Data mismatch (check failed)
// - 9 → Network / fetch error
//
// Notes:
// - DONE/IE semantics handled at device level.
// - Fallback to .zst compressed images via fzstd if block fetch fails.
// - Designed for extensibility: additional device types can reuse cache logic.
//
// ================================================================

// --- Cache constants ---
const IO_BLOCKSIZE = 131072; // Cache block size (bytes)

// --- Operation codes ---
const OP_WRITE = 1;
const OP_READ  = 2;
const OP_CHECK = 3;
const OP_ACCUM = 4;
const OP_BYTE  = 5;


// Download support
let downLoadList = [];

// --- downLoadDisk() ---
// Trigger download of a disk image from registered caches.
// - Creates temporary link to export selected cache as text file
// - Uses <select> element with options populated by downLoadAdd()
// - Invoked when user selects an entry from dropdown
function downLoadDisk() {
    const select = document.getElementById("downLoadSelect");

    if (select && select.value !== "") {
        // Create blob from selected cache
        const blob = new Blob(downLoadList[select.value], { type: "text/plain" });

        // Create temporary link for download
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = select.options[select.selectedIndex].text;

        // Trigger download and clean up
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    }
}

// --- downLoadAdd() ---
// Register a new disk cache for export.
// - Adds option to <select> element for user to choose
// - Stores cache in downLoadList for later download
// - Enables dropdown once populated
function downLoadAdd(name, cache) {
    const select = document.getElementById("downLoadSelect");

    if (select) {
        // Create new option for dropdown
        const option = document.createElement("option");
        option.text = name;
        option.value = downLoadList.length;

        // Store cache and update dropdown
        downLoadList.push(cache);
        select.appendChild(option);

        // Attach onchange handler to trigger download
        select.onchange = downLoadDisk;
        select.disabled = false;
    }
}


// --- createCache() ---
// Fill cache blocks with 16‑bit words from a byte array.
// - Iterates over dataView (byte array) and packs into Uint16Array
// - Each cache block = IO_BLOCKSIZE bytes (IO_BLOCKSIZE >>> 1 words)
// - If cache block already exists, skips ahead by block size
//
// Parameters:
// - cache: array of Uint16Array blocks
// - block: starting block index
// - dataView: byte array containing raw data
function createCache(cache, block, dataView) {
    "use strict";
    const dataLength = dataView.length;

    for (let index = 0; index < dataLength; block++) {
        if (cache[block] === undefined) {
            // Allocate new cache block
            cache[block] = new Uint16Array(IO_BLOCKSIZE >>> 1);

            // Fill block with words from byte array
            for (let word = 0; word < (IO_BLOCKSIZE >>> 1) && index < dataLength; word++) {
                let data = dataView[index++];
                if (index < dataLength) {
                    data |= dataView[index++] << 8; // Pack high byte
                }
                cache[block][word] = data;
            }
        } else {
            // Skip ahead if block already exists
            index += IO_BLOCKSIZE;
        }
    }
}

// --- fetchBlock() ---
// Fetch a cache block from disk/tape image.
// - Uses HTTP Range headers to request block slice from raw .dsk file
// - On success: fills cache via createCache()
// - On 416 (range error): creates empty cache block
// - On network error or non‑OK status: falls back to .zst compressed image
// - Returns HTTP status code on success/fallback
//
// Parameters:
// - controlBlock: device control block (cache, url, etc.)
// - block: block index to fetch
//
// Notes:
// - Fallback requires fzstd decompression library
// - Adds cache to download list for export after .zst fallback
async function fetchBlock(controlBlock, block) {
    const rangeHeader = `bytes=${block * IO_BLOCKSIZE}-${(block + 1) * IO_BLOCKSIZE - 1}`;

    try {
        // --- Primary path: fetch raw .dsk file slice ---
        const response = await fetch(`media/${controlBlock.url}`, {
            headers: { "Range": rangeHeader }
        });

        if (response.ok || response.status === 206) {
            const buffer = await response.arrayBuffer();
            createCache(controlBlock.cache, block, new Uint8Array(buffer));
            return response.status;
        } else if (response.status === 416) {
            // Range error: create empty cache block
            createCache(controlBlock.cache, block, "");
            return response.status;
        }
        // If other error status, fall through to .zst fallback
    } catch (err) {
        // Network error on .dsk → fall through to .zst fallback
    }

    // --- Fallback path: fetch compressed .zst file ---
    const zstResponse = await fetch(`media/${controlBlock.url}.zst`);
    if (!zstResponse.ok) {
        throw new Error(`Network error fetching .zst for ${controlBlock.url}`);
    }

    const buffer = await zstResponse.arrayBuffer();
    if (typeof fzstd === "undefined" || typeof fzstd.decompress !== "function") {
        throw new Error("fzstd decompression library not loaded");
    }

    // Decompress and fill cache
    const decompressed = fzstd.decompress(new Uint8Array(buffer));
    createCache(controlBlock.cache, block, decompressed);

    // Register cache for download/export
    downLoadAdd(controlBlock.url, controlBlock.cache);

    return zstResponse.status;
}

/// --- diskIO() ---
// Perform disk/tape I/O using cached blocks.
// - Convention: data < 0 → read/no write or error
// - Supports multiple operations (WRITE, READ, CHECK, ACCUM, BYTE)
// - Handles cache hits directly; fetches blocks if missing
// - Invokes callback with status code on completion or error
//
// Parameters:
// - controlBlock: device control block (cache, callback, url, position)
// - operation: OP_WRITE, OP_READ, OP_CHECK, OP_ACCUM, OP_BYTE
// - position: byte offset within device image
// - address: target memory address (unibus address)
// - count: number of bytes to transfer
//
// Callback status codes:
// - 0 → Success
// - 2 → NXM (Nonexistent Memory)
// - 3 → Data mismatch (check failed)
// - 9 → Network/fetch error
async function diskIO(controlBlock, operation, position, address, count, options) {
    "use strict";

    let block = ~~(position / IO_BLOCKSIZE);

    // --- Cache hit path ---
    if (controlBlock.cache[block] !== undefined) {
        while (count > 0) {
            let data;
            let offset = position - block * IO_BLOCKSIZE;

            // Advance to next block if offset exceeds block size
            if (offset >= IO_BLOCKSIZE) {
                block++;
                if (controlBlock.cache[block] === undefined) break;
                offset = 0;
            }

            switch (operation) {
                case OP_WRITE: // Write memory → cache
                case OP_CHECK: // Compare memory with cache
                    data = busReadWord(address);
                    if (data < 0) {
                        controlBlock.callback(controlBlock, 2, position, address, count, options);
                        return;
                    }
                    if (operation === OP_WRITE) {
                        controlBlock.cache[block][offset >>> 1] = data;
                    } else if (data !== controlBlock.cache[block][offset >>> 1]) {
                        controlBlock.callback(controlBlock, 3, position, address, count, options);
                        return;
                    }
                    address += 2; position += 2; count -= 2;
                    break;

                case OP_READ: // Read cache → memory
                    data = controlBlock.cache[block][offset >>> 1];
                    if (count > 1) {
                        if (busWriteWord(address, data) < 0) {
                            controlBlock.callback(controlBlock, 2, position, address, count, options);
                            return;
                        }
                        address += 2; position += 2; count -= 2;
                    } else {
                        if (writeByteByPhysical(mapUnibus(address), data & 0xFF) < 0) {
                            controlBlock.callback(controlBlock, 2, position, address, count, options);
                            return;
                        }
                        address += 1; position += 2; count--;
                    }
                    break;

                case OP_ACCUM: // Tape record count accumulation
                    address = (controlBlock.cache[block][offset >>> 1] << 16) | (address >>> 16);
                    position += 2; count -= 2;
                    break;

                case OP_BYTE: // PTR single‑byte read
                    data = controlBlock.cache[block][offset >> 1];
                    address = (offset & 1 ? data >>> 8 : data & 0xFF);
                    position++; count = 0;
                    break;

                default:
                    panic(); // Unknown operation
            }
        }
    }

    // --- Cache miss path ---
    if (count > 0) {
        try {
            await fetchBlock(controlBlock, block);
            await diskIO(controlBlock, operation, position, address, count, options); // Resume after fetch
        } catch (err) {
            controlBlock.callback(controlBlock, 9, position, address, count, options); // Network/fetch error
        }
        return;
    }

    // --- Completion ---
    controlBlock.callback(controlBlock, 0, position, address, count, options); // Success
}



// ================================================================
// PTR11 Paper Tape Reader Emulator
// ================================================================
//
// Overview:
// Emulates PDP‑11 PTR11 paper tape reader device.
// Provides register‑level behavior for OS drivers and diagnostics.
//
// Registers (base 17777550):
// - 00: PTRCS – Control/Status Register
// - 02: PTRDB – Data Buffer Register
//
// PTRCS bits:
// - ERR (0x8000) – Error
// - BUSY (0x0800) – Busy
// - DONE (0x0080) – Operation complete
// - IE   (0x0040) – Interrupt enable
// - GO   (0x0001) – Start operation
//
// Interrupts:
// - Vector   = 0070
// - Priority = 4 << 5
//
// Notes:
// - Uses diskIO OP_BYTE to fetch one byte from tape.
// - Tape file expected as "<name>.ptap".
// - Reset clears registers and forgets tape.
// - DONE set when operation completes, BUSY cleared.
//
// ================================================================

iopage.register(0o17777550, 2, (function() {
    "use strict";

    // --- Interrupts ---
    const PTR_VECTOR   = 0o070;   // Interrupt vector
    const PTR_PRIORITY = 4 << 5;  // Interrupt priority

    // --- PTRCS (Control/Status Register) bits ---
    const PTR_ERR  = 0x8000; // Error
    const PTR_BUSY = 0x0800; // Busy
    const PTR_DONE = 0x0080; // Operation complete
    const PTR_IE   = 0x0040; // Interrupt enable
    const PTR_GO   = 0x0001; // Start operation

    // --- PTR11 State ---
    let ptrcs;           // Control/Status register
    let ptrdb;           // Data buffer
    let iMask;           // Interrupt pending mask
    let ptControlblock;  // Disk I/O control block

    // --- initPTR() ---
    // Initialize PTR11 paper tape reader state.
    // - Clears control/status register (ERR, BUSY, DONE, IE, GO all reset)
    // - Clears data buffer
    // - Clears interrupt mask
    // - Forgets any existing tape control block (no tape loaded)
    function initPTR() {
        // Control/Status: all flags cleared
        ptrcs = 0;

        // Clear data buffer
        ptrdb = 0;

        // Clear interrupt mask
        iMask = 0;

        // Forget any existing tape control block
        ptControlblock = undefined;
    }

    // --- ptCallback() ---
    // Completion callback for PTR11 tape I/O operations.
    // - Updates PTRCS flags (ERR, DONE, BUSY)
    // - Stores fetched byte into PTRDB
    // - Raises interrupt if IE set
    // - Advances tape position for next read
    function ptCallback(controlBlock, code, position, address, count, options) {
        // Update tape position
        controlBlock.position = position;

        // Store fetched byte into PTRDB (diskIO OP_BYTE writes into address)
        ptrdb = address & 0xFF;

        // Error handling
        if (code) {
            ptrcs |= PTR_ERR; // Set error flag if non‑zero status
        }

        // Interrupt request if IE set
        if (ptrcs & PTR_IE) {
            iMask = 1;
            requestInterrupt();
        }

        // Set DONE, clear BUSY
        ptrcs = (ptrcs | PTR_DONE) & ~PTR_BUSY;
    }

    initPTR();

    // --- Device interface ---
    return {
        // --- access() ---
        // Register access handler for PTR11.
        // - Decodes register offset (pa & 0o6)
        // - Performs read/write depending on data >= 0
        // - Handles PTRCS (control/status) and PTRDB (data buffer)
        // - Preserves IE edge behavior and GO semantics
        // - Returns register value or trap on invalid access
        access: function(pa, data, byteFlag) {
            let result;

            switch (pa & 0o6) {
                case 0o0: // PTRCS – Control/Status Register
                    result = insertData(ptrcs, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        // Interrupt enable edge behavior
                        if ((result ^ ptrcs) & PTR_IE) {
                            if (result & PTR_IE) {
                                iMask = 1;
                                requestInterrupt();
                            } else {
                                iMask = 0;
                            }
                        }

                        // Update IE + GO bits only
                        ptrcs = (ptrcs & ~(PTR_IE | PTR_GO)) | (result & (PTR_IE | PTR_GO));

                        // If no tape loaded, set ERR
                        if (ptControlblock === undefined) {
                            const ptrName = document.getElementById("ptr").value;
                            if (ptrName === "") {
                                ptrcs = (ptrcs & ~PTR_GO) | PTR_ERR;
                            } else {
                                ptControlblock = {
                                    cache: [],
                                    callback: ptCallback,
                                    url: `${ptrName}.ptap`,
                                    position: 0
                                };
                            }
                        }

                        // If GO set, not ERR, not BUSY → start read
                        if ((ptrcs & (PTR_ERR | PTR_BUSY | PTR_GO)) === PTR_GO) {
                            ptrcs = (ptrcs & ~PTR_GO) | PTR_BUSY;
                            diskIO(ptControlblock, OP_BYTE, ptControlblock.position, 0o17777552, 1, null);
                        }
                    }
                    break;

                case 0o2: // PTRDB – Data Buffer Register
                    result = insertData(ptrdb, pa, data, byteFlag);
                    if (result >= 0) {
                        // Clear DONE on read
                        ptrcs &= ~PTR_DONE;
                    }
                    break;

                default:
                    return trap(0o4, 0x10); // Unibus time‑out
            }

            return result;
        },

        // --- poll() ---
        // Interrupt poll handler for PTR11.
        // - If takeInterrupt=true: delivers pending interrupt vector
        //   • Services command completion interrupt (DONE set)
        // - If takeInterrupt=false: reports priority level + pending flag
        //   • Drops any pending interrupts if IE cleared
        poll: function(takeInterrupt) {
            if (takeInterrupt) {
                // Service command completion interrupt
                iMask = 0; // Clear mask after servicing
                return PTR_VECTOR; // Interrupt vector
            } else {
                // If interrupts disabled, clear mask
                if (!(ptrcs & PTR_IE)) iMask = 0;
                // Return priority level + pending flag
                return PTR_PRIORITY | (iMask ? 1 : 0);
            }
        },

        // --- reset() ---
        // Controller reset handler.
        // - Reinitializes PTR11 state (all flags cleared)
        // - Clears buffer and interrupt mask
        // - Forgets any loaded tape
        reset: initPTR
    };
})());



// ================================================================
// TM11 Tape Controller Emulator
// ================================================================
//
// Overview:
// Emulates PDP‑11 TM11 magtape controller with attached TU10 drives.
// Provides register‑level behavior for OS drivers and diagnostics.
//
// Installed drives:
// - Up to 3 TU10 units (default configuration)
// - Control blocks created on demand when accessed
//
// Registers (base 17772520):
// - 00: MTS   – Status Register
// - 02: MTC   – Command Register
// - 04: MTBRC – Byte Record Counter
// - 06: MTCMA – Current Memory Address
// - 10: MTD   – Data Buffer (unused)
// - 12: MTRD  – Read Lines (timing hack)
//
// Interrupts:
// - Vector   = 0224
// - Priority = 5 << 5
// - Distinguishes command/data completion vs rewind completion
//
// ================================================================

iopage.register(0o17772520, 6, (function() {
    "use strict";

    // --- Interrupts ---
    const TM_VECTOR   = 0o224;   // Interrupt vector
    const TM_PRIORITY = 5 << 5;  // Interrupt priority

    // --- MTS (Status) bits ---
    const MTS_ILC = 0x8000; // Illegal command
    const MTS_EOF = 0x4000; // End‑of‑file (tape mark)
    const MTS_EOT = 0x0400; // End‑of‑tape
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
    const TM_FUN_OFFLINE   = 0; // Offline / no‑op
    const TM_FUN_READ      = 1; // Read record
    const TM_FUN_WRITE     = 2; // Write (not implemented)
    const TM_FUN_WEOF      = 3; // Write EOF (not implemented)
    const TM_FUN_SPACE_F   = 4; // Space forward (skip record)
    const TM_FUN_SPACE_R   = 5; // Space reverse (skip record)
    const TM_FUN_WRITE_X   = 6; // Write with extended IRG (error)
    const TM_FUN_REWIND    = 7; // Rewind

    // --- TM11 State ---
    let mts, mtc, mtbrc, mtcma, mtrd, iMask;
    const MAXDRIVE = 3;
    const mtControlBlock = [];

    // --- initTM() ---
    // Initialize TM11 controller and per‑drive state.
    // - Sets default MTS status (unit selected, BOT, write‑locked, ready)
    // - Clears MTC command register (RDY set, IE clear, density preserved)
    // - Resets byte record counter, memory address, and read lines
    // - Clears interrupt mask
    function initTM() {
        // Default status: unit selected, BOT set, write locked, ready
        mts = MTS_SEL | MTS_BOT | MTS_WRL | MTS_RDY;

        // Command register: density preserved, controller RDY set, IE clear
        mtc = 0x6080;

        // Reset counters and memory address
        mtbrc = 0;
        mtcma = 0;
        mtrd  = 0;

        // Clear interrupt mask
        iMask = 0;
    }

    // --- mtCallback() ---
    // Completion callback for TM11 tape I/O operations.
    // Updates controller registers after record boundary or data transfer.
    // - Advances tape position depending on command
    // - Updates MTBRC (byte record counter) and MTCMA (memory address)
    // - Sets error flags (EOF, RLE, NXM, generic tape error)
    // - Marks controller ready and raises interrupt if IE set
    function mtCallback(controlBlock, code, position, address, count, options) {
        // --- Record boundary handling ---
        if (code === 0 && controlBlock.command > 0) {
            if (address === 0 || address > 0x80000000) {
                // Tape mark (EOF)
                controlBlock.position = (position + 1) & ~1;
                mtc |= MTC_ERR;
                mts |= MTS_EOF;
            } else {
                switch (controlBlock.command) {
                    case TM_FUN_READ: {
                        // Record read: address holds length; follow‑up copies data
                        controlBlock.position = (position + 4 + address + 1) & ~1;
                        controlBlock.command = 0;

                        // Compute bytes to transfer
                        let bytesToTransfer = (0x10000 - mtbrc) & 0xFFFF;
                        if (bytesToTransfer >= address || bytesToTransfer === 0) {
                            bytesToTransfer = address;
                            mtbrc = (mtbrc + bytesToTransfer) & 0xFFFF;
                        } else {
                            mts |= MTS_RLE; // Partial transfer due to word count
                            mtbrc = 0;
                        }

                        // Issue diskIO to copy data into memory
                        const busAddr = ((mtc & 0x30) << 12) | mtcma;
                        diskIO(controlBlock, OP_READ, position, busAddr, bytesToTransfer, null);
                        return;
                    }
                    case TM_FUN_SPACE_F: {
                        // Space forward over record
                        controlBlock.position = (position + 4 + address + 1) & ~1;
                        mtbrc = (mtbrc + 1) & 0xFFFF;
                        if (mtbrc) {
                            diskIO(controlBlock, OP_ACCUM, controlBlock.position, 0, 4, null);
                            return;
                        }
                        break;
                    }
                    case TM_FUN_SPACE_R: {
                        // Space reverse over record
                        controlBlock.position = (position - 8 - address + 1) & ~1;
                        mtbrc = (mtbrc + 1) & 0xFFFF;
                        if (mtbrc && controlBlock.position > 0) {
                            diskIO(controlBlock, OP_ACCUM, controlBlock.position - 4, 0, 4, null);
                            return;
                        }
                        break;
                    }
                    default:
                        panic(); // Unexpected command
                }
            }
        }

        // --- Common completion bookkeeping ---
        if (controlBlock.command === 0) {
            mtbrc = (mtbrc - count) & 0xFFFF;
            mtcma = address & 0xFFFF;
            mtc = (mtc & ~0x30) | ((address >>> 12) & 0x30); // Preserve density/page bits
        }

        // --- Error mapping ---
        switch (code) {
            case 0: break;              // Success
            case 1: mts |= 0x100; break; // Bad tape error
            case 2: mts |= 0x80;  break; // NXM
            default: mts |= 0x100; break; // Generic tape error
        }

        // --- Ready + interrupt handling ---
        if (mtc & MTC_IE) {
            iMask |= 1; // Command/data completion
            requestInterrupt();
        }
        mts |= MTS_RDY;
        mtc |= MTC_RDY;
    }

    // --- tmGo() ---
    // Execute command for the selected TU10 tape drive.
    // - Clears ERR/GO/RDY before dispatch
    // - Decodes function code (FUN field)
    // - Handles offline, read, space forward/reverse, rewind
    // - Issues diskIO for data commands
    // - Updates control block position and command state
    function tmGo() {
        const drive = (mtc >>> 8) & 3; // Extract drive number (bits 8–10)

        // Clear controller ready, GO, ERR before command
        mtc &= ~(MTC_ERR | MTC_RDY | MTC_GO);
        mts &= ~0xFF80; // Clear high error/status cluster (EOF/EOT/RLE/ILC, etc.)

        // Validate unit
        if (drive > MAXDRIVE) {
            mtc |= MTC_ERR;
            mts |= MTS_ILC; // Illegal command
            mts &= ~(MTS_SEL | MTS_RDY);
            return;
        }

        // Select unit
        mts |= MTS_SEL;

        // Lazy init control block
        if (!mtControlBlock[drive]) {
            mtControlBlock[drive] = {
                cache: [],
                callback: mtCallback,
                url: `tm${drive}.tap`,
                drive,
                position: 0,
                command: 0
            };
        }

        // Decode function code
        const fun = (mtc & MTC_FUN) >>> 1;
        mtControlBlock[drive].command = fun;

        switch (fun) {
            case TM_FUN_OFFLINE: // No‑op
                break;

            case TM_FUN_READ: // Read record
                // Fetch next record length
                diskIO(mtControlBlock[drive], OP_ACCUM, mtControlBlock[drive].position, 0, 4, null);
                return;

            case TM_FUN_WRITE: // Write (not supported)
            case TM_FUN_WEOF:  // Write EOF (not supported)
            case TM_FUN_WRITE_X: // Extended write (not supported)
                mtc |= MTC_ERR;
                mts |= MTS_WRL | MTS_ILC; // Write locked + illegal command
                break;

            case TM_FUN_SPACE_F: // Space forward
                diskIO(mtControlBlock[drive], OP_ACCUM, mtControlBlock[drive].position, 0, 4, null);
                return;

            case TM_FUN_SPACE_R: // Space reverse
                if (mtControlBlock[drive].position > 0) {
                    diskIO(mtControlBlock[drive], OP_ACCUM, mtControlBlock[drive].position - 4, 0, 4, null);
                    return;
                }
                break;

            case TM_FUN_REWIND: // Rewind
                if (mtControlBlock[drive].position !== 0) {
                    mtControlBlock[drive].position = 0;
                    if (mtc & MTC_IE) {
                        iMask |= 2; // Rewind completion interrupt
                    }
                }
                mts &= ~MTS_REW;
                mts |= MTS_BOT | MTS_RDY;
                break;

            default:
                mts |= MTS_ILC; // Illegal command
                break;
        }

        // --- Command complete interrupt ---
        if (mtc & MTC_IE) {
            iMask |= 1; // Command/data completion
            requestInterrupt();
        }

        // Controller ready after command
        mtc |= MTC_RDY;
    }

    initTM();

    // --- Device interface ---
    return {
        // --- access() ---
        // Register access handler for TM11.
        // - Decodes register offset (pa & 0o16)
        // - Performs read/write depending on data >= 0
        // - Preserves quirks (INIT edge behavior, IE edge behavior, RDY/GO execution)
        // - Returns register value or trap on invalid access
        access: function(pa, data, byteFlag) {
            let result;

            switch (pa & 0o16) {
                case 0o00: // MTS – Status Register
                    // BOT is volatile based on position; recompute dynamically
                    mts &= ~MTS_BOT;
                    {
                        const drive = (mtc >>> 8) & 3;
                        const cb = mtControlBlock[drive];
                        if (cb && cb.position === 0) mts |= MTS_BOT;
                    }
                    result = mts;
                    break;

                case 0o02: // MTC – Command Register
                    result = insertData(mtc, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        if (result & MTC_INIT) {
                            // Controller reset
                            initTM();
                        } else {
                            // Interrupt enable edge behavior
                            if ((result ^ mtc) & MTC_IE) {
                                if (result & MTC_IE) {
                                    // If RDY set and GO clear, raise idle interrupt
                                    if ((mtc & MTC_RDY) && !(result & MTC_GO)) {
                                        iMask |= 1;
                                        requestInterrupt();
                                    }
                                } else {
                                    iMask = 0;
                                }
                            }

                            // Preserve RDY, mask writable bits
                            mtc = (mtc & MTC_RDY) | (result & 0x7F7F);

                            // If RDY + GO set, start command
                            if ((mtc & (MTC_RDY | MTC_GO)) === (MTC_RDY | MTC_GO)) {
                                tmGo();
                            }
                        }
                    }
                    break;

                case 0o04: // MTBRC – Byte Record Counter
                    result = insertData(mtbrc, pa, data, byteFlag);
                    if (result >= 0) mtbrc = result;
                    break;

                case 0o06: // MTCMA – Current Memory Address
                    result = insertData(mtcma, pa, data, byteFlag);
                    if (result >= 0) mtcma = result;
                    break;

                case 0o10: // MTD – Data Buffer (unused)
                    result = 0;
                    break;

                case 0o12: // MTRD – Read Lines (timing hack)
                    mtrd ^= 0x80FF; // Preserve timing behavior used by RSTS
                    result = mtrd;
                    break;

                default:
                    return trap(0o4, 0x10); // Unibus time‑out
            }

            return result;
        },

        // --- poll() ---
        // Interrupt poll handler for TM11.
        // - If takeInterrupt=true: delivers pending interrupt vector
        //   • Command/data completion serviced first (IMASK bit 1)
        //   • Rewind completion serviced second (IMASK bit 2)
        // - If takeInterrupt=false: reports priority level + pending flag
        //   • Drops any pending interrupts if IE cleared
        poll: function(takeInterrupt) {
            if (takeInterrupt) {
                if (iMask & 1) {
                    // Service command/data completion
                    iMask &= ~1;
                } else {
                    // Service rewind completion
                    iMask = 0;
                }
                return TM_VECTOR; // Interrupt vector
            } else {
                // If interrupts disabled, clear mask
                if (!(mtc & MTC_IE)) iMask = 0;
                // Return priority level + pending flag
                return TM_PRIORITY | (iMask ? 1 : 0);
            }
        },

        // --- reset() ---
        // Controller reset handler.
        // - Reinitializes controller and per-drive state
        // - Equivalent to MTC INIT command
        reset: initTM
    };
})());




// ================================================================
// RK11 Disk Controller Emulator
// ================================================================
//
// Overview:
// Emulates PDP‑11 RK11 disk controller with attached RK05 drives.
// Provides register‑level behavior for OS drivers and diagnostics.
//
// Installed drives:
// - Up to 8 RK05 units (tracks/sectors defined per drive)
// - Geometry: 12 sectors per track, 406 tracks per drive
//
// Registers (base 17777400):
// - 00: RKDS – Drive Status
// - 02: RKER – Error Register
// - 04: RKCS – Control/Status Register
// - 06: RKWK – Word Count
// - 10: RKBA – Bus Address
// - 12: RKDA – Disk Address
// - 16: RKDB – Data Buffer
//
// Interrupts:
// - Vector = 0220
// - Priority = 5 << 5
// - Distinguishes command completion vs seek completion
//
// ================================================================

iopage.register(0o17777400, 8, (function() {
    "use strict";

    // --- Interrupts ---
    const RK_VECTOR   = 0o220;   // Interrupt vector
    const RK_PRIORITY = 5 << 5;  // Interrupt priority

    // --- Geometry ---
    const RK_SECTOR_SIZE = 512;  // Bytes per sector (RK05)

    // --- CSR (Control/Status Register) bits ---
    const RKCS_ERR  = 0x8000; // Error summary
    const RKCS_HARD = 0x4000; // Hard error
    const RKCS_RDY  = 0x0080; // Controller ready
    const RKCS_IE   = 0x0040; // Interrupt enable
    const RKCS_MEX  = 0x0030; // Memory extension
    const RKCS_FUN  = 0x000E; // Function code
    const RKCS_GO   = 0x0001; // Go (start command)

    // --- Drive Status bits ---
    const RKDS_ID   = 0xE000; // Drive ID
    const RKDS_RK05 = 0x0800; // RK05 present
    const RKDS_SOK  = 0x0100; // Sector OK
    const RKDS_DRY  = 0x0080; // Drive ready
    const RKDS_RDY  = 0x0040; // Controller ready
    const RKDS_SECT = 0x000F; // Sector number

    // --- Error Register bits ---
    const RKER_WCE = 0x8000; // Write check error
    const RKER_SKE = 0x4000; // Seek error
    const RKER_NXM = 0x0400; // Non-existent memory
    const RKER_NXS = 0x0020; // Non-existent sector
    const RKER_NXC = 0x0040; // Non-existent cylinder
    const RKER_NXD = 0x0080; // Non-existent drive

    // --- Local interrupt masks ---
    const IMASK_COMMAND = 0x0100; // Controller interrupt
    const IMASK_DRIVE   = 0x0001; // Drive interrupt base (per-drive bits)

    // --- Drive geometries ---
    const idleDrive = { sectors: 0, tracks: 0 };
    const rk05Drive = { sectors: 12, tracks: 406 };

    const geometry = [
        rk05Drive, rk05Drive, rk05Drive, rk05Drive,
        rk05Drive, rk05Drive, idleDrive, idleDrive
    ];

    // --- RK11 State ---
    var rkds, rker, rkcs, rkwc, rkba, rkda, iMask;
    const rkControlBlock = [];

    // --- initRK() ---
    // Initialize RK11 controller and per-drive state.
    // - Sets default Drive Status (RK05 present, sector OK, drive ready)
    // - Clears Error Register and Control/Status Register
    // - Resets word count, bus address, and disk address
    // - Clears interrupt mask
    function initRK() {
        // Default drive status: RK05 present, sector OK, drive ready, controller ready
        rkds = RKDS_RK05 | RKDS_SOK | RKDS_DRY | RKDS_RDY;

        // Clear error register
        rker = 0;

        // Controller ready, IE clear
        rkcs = RKCS_RDY;

        // Reset word count, bus address, disk address
        rkwc = 0;
        rkba = 0;
        rkda = 0;

        // Clear interrupt mask
        iMask = 0;
    }

    // --- rkCallback() ---
    // Completion callback for disk I/O operations.
    // Updates controller and drive registers to reflect transfer state.
    // - Updates bus address, word count, and disk address (CHS)
    // - Handles error codes (write check, NXM, seek errors)
    // - Marks drive/controller ready and raises interrupt if IE set
    function rkCallback(controlBlock, code, position, address, count, options) {
        // Update bus address and memory extension
        rkba = address & 0xFFFF;
        rkcs = (rkcs & ~RKCS_MEX) | ((address >>> 12) & RKCS_MEX);

        // Update word count (remaining words)
        rkwc = (0x10000 - (count >>> 1)) & 0xFFFF;

        // Compute disk address (cylinder/sector) from position
        position = ~~(position / RK_SECTOR_SIZE);
        rkda = (rkda & 0xE000) |
               ((~~(position / geometry[controlBlock.drive].sectors)) << 4) |
               (position % geometry[controlBlock.drive].sectors);

        // --- Error handling ---
        switch (code) {
            case 0: // Success
                rkcs |= RKCS_RDY;
                break;
            case 1: // Write check error
                rker |= RKER_WCE;
                rkcs |= RKCS_ERR | RKCS_HARD;
                break;
            case 2: // Non-existent memory
                rker |= RKER_NXM;
                rkcs |= RKCS_ERR | RKCS_HARD;
                break;
            case 3: // Data mismatch (check failure)
                rker |= RKER_WCE;
                rkcs |= RKCS_ERR;
                break;
            default: // Generic seek error
                rker |= RKER_SKE;
                rkcs |= RKCS_ERR | RKCS_HARD;
                break;
        }

        // --- Ready + interrupt handling ---
        rkds = (controlBlock.drive << 13) | (rkds & 0x1FF0); // Update drive ID
        rkcs |= RKCS_RDY; // Controller ready

        if (rkcs & RKCS_IE) {
            iMask |= IMASK_COMMAND; // Command completion interrupt
            requestInterrupt();
        }
    }

    // --- rkGo() ---
    // Execute command for the selected drive.
    // - Clears ERR/GO/RDY before dispatch
    // - Decodes function code (FUN field)
    // - Handles reset, read/write/check, seek, and drive reset
    // - Issues diskIO for data commands
    // - Marks drive attention for non-data commands
    function rkGo() {
        const drive = (rkda >>> 13) & 7; // Extract drive number (bits 13–15)

        // Clear ERR, GO, RDY before command
        rkcs &= ~(RKCS_ERR | RKCS_GO | RKCS_RDY);
        rker &= ~0x03; // Clear low error flags

        switch ((rkcs & RKCS_FUN) >>> 1) {
            case 0: // Controller reset
                for (let d = 0; d < 8; d++) {
                    if (rkControlBlock[d]?.xhr) rkControlBlock[d].xhr.abort();
                }
                initRK();
                break;

            case 1: // Write
            case 2: // Read
            case 3: // Check
                // --- Read/Write/Check path ---
                if (geometry[drive].tracks === 0) {
                    rker |= RKER_NXD; // Non-existent drive
                    break;
                }
                if (((rkda >>> 4) & 0x1FF) >= geometry[drive].tracks) {
                    rker |= RKER_NXC; // Non-existent cylinder
                    break;
                }
                if ((rkda & 0xF) >= geometry[drive].sectors) {
                    rker |= RKER_NXS; // Non-existent sector
                    break;
                }

                // Lazy init control block
                if (!rkControlBlock[drive]) {
                    rkControlBlock[drive] = {
                        cache: [],
                        callback: rkCallback,
                        url: `rk${drive}.dsk`,
                        drive
                    };
                }

                // Compute sector and bus address
                const sector = (((rkda >>> 4) & 0x1FF) * geometry[drive].sectors) +
                               (rkda & 0xF);
                const address = ((rkcs & RKCS_MEX) << 12) | rkba;
                const count   = (0x10000 - rkwc) & 0xFFFF;

                // Issue diskIO
                diskIO(
                    rkControlBlock[drive],
                    (rkcs >>> 1) & 7, // Function code (write/read/check)
                    sector * RK_SECTOR_SIZE,
                    address,
                    count << 1,
                    null
                );
                return;

            case 4: // Seek
            case 6: // Drive reset
                rkds = (drive << 13) | (rkds & 0x1FF0); // Update drive ID
                if (rkcs & RKCS_IE) {
                    iMask |= IMASK_COMMAND | (IMASK_DRIVE << drive); // Command + seek complete
                    requestInterrupt();
                } else {
                    rkcs |= 0x2000; // Search complete (no interrupt)
                }
                rkcs |= RKCS_RDY;
                return;

            default:
                // Unknown function code
                rker |= RKER_SKE;
                rkcs |= RKCS_ERR | RKCS_HARD;
                break;
        }

        // --- Common non-data completion ---
        rkds = (drive << 13) | (rkds & 0x1FF0); // Update drive ID
        rkcs |= RKCS_RDY; // Controller ready
        if (rkcs & RKCS_IE) {
            iMask |= IMASK_COMMAND; // Command completion interrupt
            requestInterrupt();
        }
    }

    initRK();

    // --- Device interface ---
    return {
        // --- access() ---
        // Register access handler for RK11.
        // - Decodes register offset (pa & 0o16)
        // - Performs read/write depending on data >= 0
        // - Preserves hardware quirks (masking, clearing, attention bits)
        // - Returns register value or trap on invalid access
        access: function(pa, data, byteFlag) {
            let result;

            switch (pa & 0o16) {
                case 0o00: // RKDS – Drive Status
                    result = insertData(rkds, pa, data, byteFlag);
                    break;

                case 0o02: // RKER – Error Register
                    result = insertData(rker, pa, data, byteFlag);
                    break;

                case 0o04: // RKCS – Control/Status Register
                    result = insertData(rkcs, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        // Preserve ERR/HARD bits, update rest
                        rkcs = (result & ~0xF080) | (rkcs & 0xF080);

                        // Drop interrupts if IE cleared
                        if (!(rkcs & RKCS_IE)) iMask = 0;

                        // If RDY+GO set, execute command
                        if ((rkcs & (RKCS_RDY | RKCS_GO)) === (RKCS_RDY | RKCS_GO)) {
                            rkGo();
                        }
                    }
                    break;

                case 0o06: // RKWK – Word Count
                    result = insertData(rkwc, pa, data, byteFlag);
                    if (result >= 0) rkwc = result;
                    break;

                case 0o10: // RKBA – Bus Address
                    result = insertData(rkba, pa, data, byteFlag);
                    if (result >= 0) rkba = result & 0xFFFE; // Word aligned
                    break;

                case 0o12: // RKDA – Disk Address
                    result = insertData(rkda, pa, data, byteFlag);
                    if (result >= 0) rkda = result;
                    break;

                case 0o14: // RKDB – Data Buffer (unused)
                case 0o16: // RKDB (unused alias)
                    result = 0;
                    break;

                default:
                    return trap(0o4, 0x10); // Unibus time-out
            }

            return result;
        },

        // --- poll() ---
        // Interrupt poll handler for RK11.
        // - If takeInterrupt=true: delivers pending interrupt vector
        //   • Command completion → IMASK_COMMAND
        //   • Seek completion → per-drive bit (1 << drive)
        // - If takeInterrupt=false: reports priority level + pending flag
        //   • Drops any pending interrupts if IE cleared
        poll: function(takeInterrupt) {
            if (takeInterrupt) {
                if (iMask & IMASK_COMMAND) {
                    // Command complete interrupt
                    iMask &= ~IMASK_COMMAND;
                } else {
                    // Seek complete interrupt for one of the drives
                    for (let drive = 0; drive < 8; drive++) {
                        if (iMask & (IMASK_DRIVE << drive)) {
                            rkcs |= 0x2000; // Search complete
                            rkds = (drive << 13) | (rkds & 0x1FF0); // Update drive ID
                            iMask &= ~(IMASK_DRIVE << drive);
                            break;
                        }
                    }
                }
                return RK_VECTOR; // Interrupt vector
            } else {
                // If interrupts disabled, clear mask
                if (!(rkcs & RKCS_IE)) iMask = 0;
                // Return priority level + pending flag
                return RK_PRIORITY | (iMask ? 1 : 0);
            }
        },

        // --- reset() ---
        // Controller reset handler.
        // - Reinitializes controller and per-drive state
        // - Equivalent to controller reset command (FUN=0)
        reset: initRK
    };
})());


// ================================================================
// RL11 Disk Controller Emulator
// ================================================================
//
// Overview:
// Emulates PDP‑11 RL11 disk controller with attached RL01/RL02 drives.
// Provides register‑level behavior for OS drivers and diagnostics.
//
// Installed drives:
// - Up to 4 units (mix of RL01 and RL02)
// - Geometry: RL01 (512 tracks, 40 sectors), RL02 (1024 tracks, 40 sectors)
//
// Registers (base 17774400):
// - 00: CSR – Control/Status Register
// - 02: BAR – Bus Address Register
// - 04: DAR – Disk Address Register
// - 06: MPR – Multi‑Purpose Register
//
// Interrupts:
// - Vector = 0160
// - Priority = 5 << 5
// - Command completion only (no seek‑complete distinction)
//
// ================================================================

iopage.register(0o17774400, 4, (function() {
    "use strict";

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
    const RLCS_NXM = 0xA000; // Non‑existent Memory
    const RLCS_RWE = 0x8400; // Read/Write Error

    // --- Geometry constants ---
    const RL_SECTOR_SIZE = 256; // Bytes per sector (RL01/RL02)

    // --- Drive geometries ---
    const rl01Drive = { status: 0o35,  sectors: 40, tracks: 512  };
    const rl02Drive = { status: 0o235, sectors: 40, tracks: 1024 };

    // Geometry array: 2 RL02 + 2 RL01
    const geometry = [ rl02Drive, rl02Drive, rl01Drive, rl01Drive ];

    // --- RL11 State ---
    let csr, bar, dar, mpr, DAR, iMask;
    let rlControlBlock = [];

    // --- initRL() ---
    // Initialize RL11 controller and per‑drive state.
    // - Sets CSR ready + drive ready
    // - Clears bus address, disk address, and multipurpose register
    // - Resets internal DAR (latched disk address)
    // - Clears interrupt mask
    function initRL() {
        // Controller ready + Drive Ready
        csr = RLCS_RDY | RLCS_DRDY;

        // Reset bus address, disk address, multipurpose register
        bar = 0;
        dar = 0;
        mpr = 0;

        // Internal DAR latch (used for seek/status ops)
        DAR = 0;

        // Clear interrupt mask
        iMask = 0;
    }

    // --- rlCallback() ---
    // Completion callback for RL11 disk I/O operations.
    // Updates controller and drive registers to reflect transfer state.
    // - Updates bus address, word count, and disk address (CHS)
    // - Handles error codes (HNF, OPI, NXM, RWE)
    // - Marks controller ready and raises interrupt if IE set
    function rlCallback(controlBlock, code, position, address, count, options) {
        // Compute sector index from byte position
        const sector = ~~(position / RL_SECTOR_SIZE);

        // Update bus address + memory extension
        bar = address & 0xFFFF;
        csr = (csr & ~RLCS_MEX) | ((address >>> 12) & RLCS_MEX);

        // Update disk address (track/sector)
        dar = ((~~(sector / geometry[controlBlock.drive].sectors)) << 6) |
              (sector % geometry[controlBlock.drive].sectors);
        DAR = dar; // Internal latch

        // Update multipurpose register (word count remaining)
        mpr = (0x10000 - (count >>> 1)) & 0xFFFF;

        // --- Error handling ---
        switch (code) {
            case 0: // Success
                break;
            case 1: // Write check error
                csr |= RLCS_RWE;
                break;
            case 2: // Non-existent memory
                csr |= RLCS_NXM;
                break;
            default: // Operation incomplete
                csr |= RLCS_OPI;
                break;
        }

        // --- Ready + interrupt handling ---
        csr |= RLCS_RDY | RLCS_DRDY; // Controller + drive ready
        if (csr & RLCS_IE) {
            iMask = 1; // Command completion interrupt
            requestInterrupt();
        }
    }

    // --- rlGo() ---
    // Execute command for the selected RL01/RL02 drive.
    // - Clears drive ready before dispatch
    // - Decodes function code (FUN field)
    // - Handles NOP, Get Status, Seek, Read Header, Read/Write
    // - Issues diskIO for data commands
    // - Updates DAR latch and MPR as needed
    function rlGo() {
        const drive = (csr >>> 8) & 3; // Extract drive number (bits 8–9)

        // Clear drive ready before command
        csr &= ~RLCS_DRDY;

        // Lazy init control block
        if (!rlControlBlock[drive]) {
            rlControlBlock[drive] = {
                cache: [],
                callback: rlCallback,
                url: `rl${drive}.dsk`,
                drive
            };
        }

        switch ((csr >>> 1) & 7) {
            case 0: // NOP
                break;

            case 1: // Write check (not implemented)
                break;

            case 2: // Get status
                if (mpr & 8) csr &= 0x3F; // Clear bits if flag set
                mpr = geometry[drive].status | (DAR & 0o100);
                break;

            case 3: // Seek
                if ((dar & 3) === 1) {
                    if (dar & 4) {
                        // Forward seek
                        DAR = ((DAR + (dar & 0xFF80)) & 0xFF80) | ((dar << 2) & 0x40);
                    } else {
                        // Reverse seek
                        DAR = ((DAR - (dar & 0xFF80)) & 0xFF80) | ((dar << 2) & 0x40);
                    }
                    dar = DAR;
                }
                break;

            case 4: // Read header
                mpr = DAR;
                break;

            case 5: { // Write
                // Bounds check: track/sector
                if ((dar >>> 6) >= geometry[drive].tracks) {
                    csr |= RLCS_HNF; // Header not found
                    break;
                }
                if ((dar & 0x3F) >= geometry[drive].sectors) {
                    csr |= RLCS_HNF;
                    break;
                }

                // Compute sector, bus address, word count
                const sectorW  = ((dar >>> 6) * geometry[drive].sectors) + (dar & 0x3F);
                const addressW = bar | ((csr & RLCS_MEX) << 12);
                const countW   = (0x10000 - mpr) & 0xFFFF;

                // Issue diskIO (write)
                diskIO(rlControlBlock[drive], OP_WRITE, sectorW * RL_SECTOR_SIZE, addressW, countW << 1, null);
                return;
            }

            case 6: // Read
            case 7: { // Read (alternate)
                // Bounds check: track/sector
                if ((dar >>> 6) >= geometry[drive].tracks) {
                    csr |= RLCS_HNF;
                    break;
                }
                if ((dar & 0x3F) >= geometry[drive].sectors) {
                    csr |= RLCS_HNF;
                    break;
                }

                // Compute sector, bus address, word count
                const sectorR  = ((dar >>> 6) * geometry[drive].sectors) + (dar & 0x3F);
                const addressR = ((csr & RLCS_MEX) << 12) | bar;
                const countR   = (0x10000 - mpr) & 0xFFFF;

                // Issue diskIO (read)
                diskIO(rlControlBlock[drive], OP_READ, sectorR * RL_SECTOR_SIZE, addressR, countR << 1, null);
                return;
            }
        }

        // --- Common completion path ---
        csr |= RLCS_RDY | RLCS_DRDY; // Controller + drive ready
        if (csr & RLCS_IE) {
            iMask = 1; // Command completion interrupt
            requestInterrupt();
        }
    }

    initRL();

    // --- Device interface ---
    return {
        // --- access() ---
        // Register access handler for RL11.
        // - Decodes register offset (pa & 0o6)
        // - Performs read/write depending on data >= 0
        // - Preserves quirks (IE edge behavior, DRDY clearing, MEX masking)
        // - Returns register value or trap on invalid access
        access: function(pa, data, byteFlag) {
            let result;

            switch (pa & 0o6) {
                case 0o0: // CSR – Control/Status Register
                    result = insertData(csr, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        // Interrupt enable edge behavior
                        if ((result ^ csr) & RLCS_IE) {
                            if (result & RLCS_IE) {
                                // If RDY set and GO clear, raise idle interrupt
                                if ((result & 0x8E) === RLCS_RDY) {
                                    iMask = 1;
                                    requestInterrupt();
                                }
                            } else {
                                iMask = 0;
                            }
                        }

                        // Preserve ERR/DE bits, update rest
                        csr = (csr & 0xFC01) | (result & 0x03FE);

                        // If DRDY + FUN set, execute command
                        if ((csr & RLCS_DRDY) && (csr & RLCS_FUN)) {
                            rlGo();
                        }
                    }
                    break;

                case 0o2: // BAR – Bus Address Register
                    result = insertData(bar, pa, data, byteFlag);
                    if (result >= 0) bar = result & 0xFFFE; // Word aligned
                    break;

                case 0o4: // DAR – Disk Address Register
                    result = insertData(dar, pa, data, byteFlag);
                    if (result >= 0) dar = result;
                    break;

                case 0o6: // MPR – Multi‑Purpose Register
                    result = insertData(mpr, pa, data, byteFlag);
                    if (result >= 0) mpr = result;
                    break;

                default:
                    return trap(0o4, 0x10); // Unibus time‑out
            }

            return result;
        },
        // --- poll() ---
        // Interrupt poll handler for RL11.
        // - If takeInterrupt=true: delivers pending interrupt vector
        //   • Command completion → IMASK bit set
        // - If takeInterrupt=false: reports priority level + pending flag
        //   • Drops any pending interrupts if IE cleared
        poll: function(takeInterrupt) {
            if (takeInterrupt) {
                // Service command completion interrupt
                iMask = 0; // Clear mask after servicing
                return RL_VECTOR; // Interrupt vector
            } else {
                // If interrupts disabled, clear mask
                if (!(csr & RLCS_IE)) iMask = 0;
                // Return priority level + pending flag
                return RL_PRIORITY | (iMask ? 1 : 0);
            }
        },

        // --- reset() ---
        // Controller reset handler.
        // - Reinitializes controller and per-drive state
        // - Equivalent to controller reset command (FUN=0)
        reset: initRL
    };
})());




// ================================================================
// RP11 Disk Controller Emulator
// ================================================================
//
// Overview:
// Emulates the RP11 controller for RP04/RP06 drives on a PDP-11.
// Provides register-level behavior for Unix/BSD drivers.
//
// Installed drives:
// - Drive 0–1: RP06 (815 cyl, 19 surf, 22 sec)
// - Drive 2–4: RP04 (411 cyl, 19 surf, 22 sec)
// - Drive 5–7: idle (not present)
//
// Notes:
// - Preserves hardware quirks (interrupt edge cases, masks).
// - NOP function can raise interrupt without GO.
// - Designed for compatibility with EKBB, RSTS/E, and Unix drivers.
//
// Registers (base 17776700, word offsets):
//   00: RPCS1 – Control/Status 1
//       Bits: 15 SC (error summary), 14 TRE (transfer error),
//             11 DVA (drive available), 7 RDY (controller ready),
//             6 IE (interrupt enable), 5–1 FUN (function code),
//             0 GO (start command)
//   02: RPWC – Word count
//   04: RPBA – Memory address (bus address)
//   06: RPDA – Disk address (sector/surface)
//   10: RPCS2 – Control/Status 2 (unit select + error flags)
//   12: RPDS – Drive status (read-only)
//   14: RPER1 – Error 1 (unused here)
//   16: RPAS – Attention summary (computed from per-drive ATA bits)
//   20: RPLA – Look ahead (unused)
//   22: RPDB – Data buffer (unused)
//   24: RPMR – Maintenance (unused)
//   26: RPDT – Drive type (read-only)
//   30: RPSN – Serial number (drive # + 1)
//   32: RPOF – Offset register (unused)
//   34: RPDC – Desired cylinder
//   36: RPCC – Current cylinder (read-only, mirrors RPDC)
//   40: RPER2 – Error 2 (unused)
//   42: RPER3 – Error 3 (unused)
//   44: RPEC1 – Error correction 1 (unused)
//   46: RPEC2 – Error correction 2 (unused)
//
// ================================================================

iopage.register(0o17776700, 20, (function() {
    "use strict";

    // --- Constants ---
    const RP_VECTOR   = 0o254;     // Interrupt vector
    const RP_PRIORITY = 5 << 5;    // Base priority level

    // --- Geometry constants ---
    const RP_SECTOR_SIZE = 512;    // Bytes per sector

    // --- RPCS1 (Control/Status 1) bits ---
    const CS1_GO        = 0x0001;  // bit 0: GO (start command)
    const CS1_FUN_MASK  = 0x003E;  // bits 1–5: Function code
    const CS1_IE        = 0x0040;  // bit 6: Interrupt Enable
    const CS1_RDY       = 0x0080;  // bit 7: Controller Ready
    const CS1_DVA       = 0x0800;  // bit 11: Drive Available
    const CS1_TRE       = 0x4000;  // bit 14: Transfer Error
    const CS1_SC        = 0x8000;  // bit 15: Special Condition

    // Masks (hardware-specific, do not alter)
    const CS1_KEEP      = 0x8880;  // Preserve SC, TRE, DVA, RDY
    const CS1_UPDATE    = 0x477F;  // Updateable bits
    const CS1_CLEARERR  = 0x703F;  // Clear error bits
    const CS1_CLR_ALL   = 0x7081;  // Clear errors, TRE, RDY, GO
    const CS1_SC_TRE    = 0xC000;  // SC + TRE
    const CS1_IE_RDY_FUN= 0x00FE;  // IE+RDY+FUN mask
    const CS1_IE_RDY_NOP= 0x00C0;  // IE+RDY+FUN=NOP (special case)

    // --- RPCS2 (Control/Status 2) bits ---
    const CS2_UNIT = 0x0007;   // bits 0–2: Unit select
    const CS2_CLR  = 0x0020;   // bit 5: Clear
    const CS2_MDPE = 0x0100;   // bit 8: Mass Data Parity Error
    const CS2_MXF  = 0x0200;   // bit 9: Missed Transfer
    const CS2_PGE  = 0x0400;   // bit 10: Program Error
    const CS2_NXM  = 0x0800;   // bit 11: Non-existent Memory
    const CS2_NED  = 0x1000;   // bit 12: Non-existent Drive
    const CS2_DLT  = 0x8000;   // bit 15: Data Late

    // --- RPDS (Drive Status) bits ---
    const DS_DRY = 0x0080;     // bit 7: Drive Ready
    const DS_VV  = 0x0040;     // bit 6: Volume Valid
    const DS_DPR = 0x0100;     // bit 8: Drive Present
    const DS_LST = 0x0400;     // bit 10: Last Sector
    const DS_MOL = 0x1000;     // bit 12: Medium Online
    const DS_ATA = 0x8000;     // bit 15: Attention

    // --- RPAS (Attention Summary) masks ---
    const RPAS_SC_CLR = 0x7FFF; // Clear SC bit in RPCS1

    // --- Miscellaneous field masks ---
    const BUS_ADDR_MASK = 0xFFFE; // Word-aligned bus address
    const RPDA_MASK     = 0x1F1F; // Valid bits in Disk Address (surface+sector)
    const CYL_MASK      = 0x03FF; // 10-bit cylinder field (0–1023)

    // --- Local interrupt masks ---
    const IMASK_COMMAND = 0x0100; // Controller interrupt
    const IMASK_DRIVE   = 0x0001; // Drive interrupt base (per-drive bits)

    // --- Function codes (RPCS1 FUN field) ---
    const FUN_NOP     = 0o00;
    const FUN_UNLOAD  = 0o02;
    const FUN_SEEK    = 0o04;
    const FUN_RECAL   = 0o06;
    const FUN_INIT    = 0o10;
    const FUN_RELEASE = 0o12;
    const FUN_OFFSET  = 0o14;
    const FUN_CENTER  = 0o16;
    const FUN_PRESET  = 0o20;
    const FUN_PACKACK = 0o22;
    const FUN_SEARCH  = 0o30;
    const FUN_WRITE   = 0o60;
    const FUN_READ    = 0o70;

    // --- Geometry presets ---
    const rp04Drive = { dtype: 0o20020, sectors: 22, surfaces: 19, cylinders: 411 };
    const rp06Drive = { dtype: 0o20022, sectors: 22, surfaces: 19, cylinders: 815 };
    const idleDrive = { dtype: 0, sectors: 0, surfaces: 0, cylinders: 0 };

    const geometry = [
        rp06Drive, rp06Drive, rp04Drive, rp04Drive, rp04Drive,
        idleDrive, idleDrive, idleDrive
    ];

    // --- Registers ---
    var rpcs1, rpwc, rpba, rpda, rpcs2, rpds, rpdc, iMask;
    var rpControlBlock = [];

    // --- initRP() ---
    // Initialize controller and per-drive state.
    // - Controller status: SC + TRE + DVA + RDY
    // - Drive status: MOL + DPR + DRY for installed drives
    // - Clears word count, bus address, disk address, cylinder arrays
    // - Resets interrupt mask
    function initRP() {
        rpcs1 = CS1_SC | CS1_TRE | CS1_DVA | CS1_RDY;
        rpwc  = 0;
        rpba  = 0;
        rpda  = [0,0,0,0,0,0,0,0];
        rpcs2 = 0;

        rpds = [
            DS_MOL | DS_DPR | DS_DRY, // Drive 0
            DS_MOL | DS_DPR | DS_DRY, // Drive 1
            DS_MOL | DS_DPR | DS_DRY, // Drive 2
            DS_MOL | DS_DPR | DS_DRY, // Drive 3
            DS_MOL | DS_DPR | DS_DRY, // Drive 4
            0, 0, 0                    // Drives 5–7 (idle)
        ];

        rpdc = [0,0,0,0,0,0,0,0];
        iMask = 0;
    }

    // --- rpCallback() ---
    // Completion callback for disk I/O operations.
    // Updates controller and drive registers to reflect transfer state.
    // - Computes block number from byte position
    // - Updates bus address, word count, and CHS fields
    // - Handles end-of-disk and error conditions
    // - Marks drive/controller ready and raises interrupt if IE set
    function rpCallback(controlBlock, code, position, address, count, options) {
        // Compute block number from byte position
        var block = ~~((position + (RP_SECTOR_SIZE - 1)) / RP_SECTOR_SIZE);

        // Update controller registers to reflect transfer state
        rpcs1 = (rpcs1 & 0xFCFF) | ((address >>> 8) & 0x300);
        rpba  = address & BUS_ADDR_MASK;
        rpwc  = (0x10000 - (count >>> 1)) & 0xFFFF;

        // Compute CHS (Cylinder/Head/Sector) from block
        var sector = ~~(block / geometry[controlBlock.drive].sectors);
        rpda[controlBlock.drive] =
            ((sector % geometry[controlBlock.drive].surfaces) << 8) |
            (block % geometry[controlBlock.drive].sectors);
        rpdc[controlBlock.drive] = ~~(sector / geometry[controlBlock.drive].surfaces);

        // End-of-disk check
        if (block >= controlBlock.maxblock) {
            rpds[controlBlock.drive] |= DS_LST; // Last sector flag
        }

        // Error handling
        if (code) {
            rpds[controlBlock.drive] |= DS_ATA;   // Set Attention
            rpcs1 |= CS1_SC_TRE;                  // Set SC + TRE
            switch (code) {
                case 1:  rpcs2 |= CS2_MXF; break; // Missed transfer
                case 2:  rpcs2 |= CS2_NXM; break; // Non-existent memory
                default: rpcs2 |= CS2_DLT; break; // Data late
            }
        }

        // Mark drive/controller ready
        rpds[controlBlock.drive] |= DS_DRY; // Drive Ready
        rpcs1 |= CS1_RDY;                   // Controller Ready

        // Interrupt if IE is set
        if (rpcs1 & CS1_IE) {
            iMask |= IMASK_COMMAND;         // Data transfer interrupt request
            requestInterrupt();
        }
    }

    // --- rpGo() ---
    // Execute command for the selected drive.
    // - Clears GO bit before dispatch
    // - Handles non-existent drive (sets NED + TRE)
    // - Decodes function code (FUN field)
    // - Issues read/write via diskIO()
    // - Marks drive attention for non-data commands
    // - Special case: FUN_NOP does not require GO to raise interrupt
    function rpGo() {
        var address, sector;
        var drive = rpcs2 & CS2_UNIT;

        // Clear GO (always done at command start)
        rpcs1 &= ~CS1_GO;

        // --- Drive present check ---
        if (geometry[drive].dtype == 0) {
            rpcs2 |= CS2_NED;       // Non-existent drive
            rpcs1 |= CS1_SC_TRE;    // SC + TRE
        } else {
            // Clear drive ATA bit (attention reset)
            rpds[drive] &= ~DS_ATA;

            // Lazy init control block
            if (rpControlBlock[drive] === undefined) {
                rpControlBlock[drive] = {
                    cache: [],
                    callback: rpCallback,
                    url: `rp${drive}.dsk`,
                    drive
                };
            }

            // --- Decode function code ---
            switch (rpcs1 & CS1_FUN_MASK) {
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
                    rpds[drive] = DS_MOL | DS_DPR | DS_DRY | DS_VV;
                    rpcs1 &= ~CS1_CLEARERR;
                    rpda[drive] = rpdc[drive] = 0;
                    if (rpcs1 & CS1_IE) {
                        iMask |= IMASK_COMMAND;
                        requestInterrupt();
                    }
                    return;

                case FUN_RELEASE:
                    return;

                case FUN_PRESET:
                    // Reset cylinder/sector, mark volume valid
                    rpdc[drive] = rpda[drive] = 0;
                    rpds[drive] = DS_MOL | DS_DPR | DS_DRY | DS_VV;
                    return;

                case FUN_PACKACK:
                    // Mark volume valid
                    rpds[drive] |= DS_VV;
                    return;

                case FUN_WRITE:
                case FUN_READ:
                    // --- Read/Write path ---
                    if (!(rpds[drive] & DS_DRY)) {
                        // Drive not ready
                        rpcs2 |= CS2_PGE;
                        rpcs1 |= CS1_SC_TRE;
                    } else {
                        // Bounds check (CHS)
                        if (rpdc[drive] >= geometry[drive].cylinders ||
                            (rpda[drive] >>> 8) >= geometry[drive].surfaces ||
                            (rpda[drive] & 0xFF) >= geometry[drive].sectors) {
                            rpcs1 |= CS1_SC_TRE;
                            break;
                        }

                        // Clear errors, TRE, RDY, GO
                        rpcs1 &= ~CS1_CLR_ALL;

                        // Clear CS2 error summary (keep unit select)
                        rpcs2 &= CS2_UNIT;

                        // Clear LST & DRY
                        rpds[drive] &= ~(DS_LST | DS_DRY);

                        // Build bus address and LBA sector
                        address = ((rpcs1 & 0x300) << 8) | (rpba & BUS_ADDR_MASK);
                        sector = (rpdc[drive] * geometry[drive].surfaces +
                                  (rpda[drive] >>> 8)) * geometry[drive].sectors +
                                  (rpda[drive] & 0xFF);

                        // Issue read/write
                        diskIO(
                            rpControlBlock[drive],
                            (rpcs1 & CS1_FUN_MASK) === FUN_WRITE ? OP_WRITE : OP_READ,
                            sector * RP_SECTOR_SIZE,
                            address,
                            ((0x10000 - rpwc) & 0xFFFF) << 1,
                            null
                        );
                        return;
                    }
                    break;

                default:
                    // Unknown function code
                    rpcs2 |= CS2_PGE;
                    rpcs1 |= CS1_SC_TRE;
                    return;
            }
        }

        // --- Non-data command completion ---
        rpds[drive] |= DS_ATA; // Set drive attention
        if (rpcs1 & CS1_IE) {
            iMask |= (IMASK_DRIVE << drive);
            requestInterrupt();
        }
    }

    initRP();

    // --- Device interface ---
    return {

        // --- access() ---
        // Register access handler.
        // - Decodes register offset (pa & 0o76)
        // - Performs read/write depending on data >= 0
        // - Preserves hardware quirks (masking, clearing, attention bits)
        // - Returns register value or trap on invalid access
        access: function(pa, data, byteFlag) {
            var result;

            switch (pa & 0o76) {
                case 0o00: // RPCS1 – Control/Status 1
                    result = insertData(rpcs1, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        // Preserve SC, TRE, DVA, RDY; update rest
                        rpcs1 = (rpcs1 & CS1_KEEP) | (result & CS1_UPDATE);

                        // Special case: FUN=NOP
                        // - If IE+RDY set, interrupt raised even without GO
                        if ((result & CS1_IE_RDY_FUN) == CS1_IE_RDY_NOP) {
                            iMask |= IMASK_COMMAND;
                            requestInterrupt();
                        } else {
                            // If GO set, execute command
                            if (rpcs1 & CS1_GO) {
                                rpGo();
                            }
                        }
                    }
                    break;

                case 0o02: // RPWC – Word count
                    result = insertData(rpwc, pa, data, byteFlag);
                    if (result >= 0) rpwc = result;
                    break;

                case 0o04: // RPBA – Bus address
                    result = insertData(rpba, pa, data, byteFlag);
                    if (result >= 0) rpba = result & BUS_ADDR_MASK;
                    break;

                case 0o06: // RPDA – Disk address (sector/surface)
                    result = insertData(rpda[rpcs2 & CS2_UNIT], pa, data, byteFlag);
                    if (result >= 0) rpda[rpcs2 & CS2_UNIT] = result & RPDA_MASK;
                    break;

                case 0o10: // RPCS2 – Control/Status 2
                    result = insertData(rpcs2, pa, data, byteFlag);
                    if (result >= 0 && data >= 0) {
                        if (result & CS2_CLR) {
                            initRP(); // Clear command resets controller
                        } else {
                            rpcs2 = (result & CS2_UNIT);
                            if (geometry[rpcs2 & CS2_UNIT].dtype == 0) {
                                rpcs2 |= CS2_NED; // Non-existent drive
                                rpcs1 |= CS1_TRE;
                            }
                        }
                    }
                    break;

                case 0o12: // RPDS – Drive status (read-only)
                    result = rpds[rpcs2 & CS2_UNIT];
                    break;

                case 0o14: // RPER1 – Error 1 (unused)
                    result = 0;
                    break;

                case 0o16: // RPAS – Attention summary
                    result = 0;
                    for (let drive = 0; drive < 8; drive++) {
                        if (rpds[drive] & DS_ATA) {
                            if (data >= 0 && (data & (1 << drive))) {
                                rpds[drive] &= ~DS_ATA; // Clear ATA bit
                            } else {
                                result |= (1 << drive); // Report attention
                            }
                        }
                    }
                    if (data >= 0) {
                        rpcs1 &= RPAS_SC_CLR; // Clear SC on any write
                    }
                    break;

                case 0o20: // RPLA – Look ahead (unused)
                case 0o22: // RPDB – Data buffer (unused)
                case 0o24: // RPMR – Maintenance (unused)
                    result = 0;
                    break;

                case 0o26: // RPDT – Drive type (read-only)
                    result = geometry[rpcs2 & CS2_UNIT].dtype;
                    break;

                case 0o30: // RPSN – Serial number (drive # + 1)
                    result = (rpcs2 & CS2_UNIT) + 1;
                    break;

                case 0o32: // RPOF – Offset register (unused)
                    result = 0;
                    break;

                case 0o34: // RPDC – Desired cylinder
                    result = insertData(rpdc[rpcs2 & CS2_UNIT], pa, data, byteFlag);
                    if (result >= 0) rpdc[rpcs2 & CS2_UNIT] = result & CYL_MASK;
                    break;

                case 0o36: // RPCC – Current cylinder (read-only)
                    result = rpdc[rpcs2 & CS2_UNIT];
                    break;

                case 0o40: // RPER2 – Error 2 (unused)
                case 0o42: // RPER3 – Error 3 (unused)
                case 0o44: // RPEC1 – Error correction 1 (unused)
                case 0o46: // RPEC2 – Error correction 2 (unused)
                    result = 0;
                    break;

                default:
                    return trap(0o4, 0x10); // Unibus time-out
            }

            return result;
        },
        // --- poll() ---
        // Interrupt poll handler.
        // - If takeInterrupt=true: delivers pending interrupt vector
        //   • Data transfer completion → IMASK_COMMAND
        //   • Non-data command completion → IMASK_DRIVE (per-drive)
        // - If takeInterrupt=false: reports priority level + pending flag
        //   • Drops any pending interrupts if IE cleared
        poll: function(takeInterrupt) {
            if (takeInterrupt) {
                // Data transfer interrupt?
                if (iMask & IMASK_COMMAND) {
                    iMask &= ~IMASK_COMMAND;
                } else {
                    // Find drive that completed a non-I/O command
                    for (let drive = 0; drive < 8; drive++) {
                        if (iMask & (IMASK_DRIVE << drive)) {
                            iMask &= ~(IMASK_DRIVE << drive);
                            break;
                        }
                    }
                }
                return RP_VECTOR; // Return interrupt vector
            } else {
                // If IE cleared, drop any pending interrupts
                if (!(rpcs1 & CS1_IE)) {
                    iMask = 0;
                }
                // Return priority level plus pending flag
                return RP_PRIORITY | (iMask ? 1 : 0);
            }
        },

        // --- reset() ---
        // Controller reset handler.
        // - Reinitializes controller and per-drive state
        // - Equivalent to Clear command in RPCS2
        reset: initRP
    };
})());



// ================================================================
// UDA50 MSCP Disk Controller
// ================================================================
//
// Implements the UDA50 register interface and MSCP command/response
// ring protocol. Supports RA‑series (RA81) disk images via diskIO.
//
// Registers (base 172150):
//   00: IP – Initialization & Poll
//   02: SA – Status & Initialization Steps
//
// Features:
//   • Full 4‑step initialization handshake
//   • Command/response ring handling
//   • Interrupt vector + enable
//   • Works with Ultrix‑11, 2.11BSD, RSTS/E
//
// Notes:
//   • SA reports step progress (4000 → 10000 → 20000 → 40000 → 0)
//   • Ring base and lengths loaded during steps 2–4
//   • Interrupts raised on response entry availability
//   • No controller microcode emulation — MSCP messages handled directly
//
// ================================================================


iopage.register(0o17772150, 2, (function() {
    "use strict";

    const DEBUG_UDA = false;

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

    // Visible registers
    let sa = 0;

    // INIT state
    let initState = 0;
    let initWord = 0;

    // Decoded config
    let vector = 0;
    let irqEnabled = 0;

    // Ring configuration
    let rspRingBase = 0;
    let rspRingSize = 0;
    let cmdRingBase = 0;
    let cmdRingSize = 0;
    let rspIdx = 0;
    let cmdIdx = 0;

    // Flow control
    let credits = 14;

    const rqControlBlock = [];
    const unitOnline = [];

    // Interrupt mask (pending)
    let iMask = 0;

    // ----------------------------------------------------------------
    // Reset controller
    // ----------------------------------------------------------------
    function resetUDA() {
        // Most initialization is through the four-step initialization process
        initState = 0;
        initWord = 0;
        sa = 0;
        irqEnabled = 0;
        iMask = 0;
    }

    resetUDA();

    // ----------------------------------------------------------------
    // Disk I/O completion callback
    // ----------------------------------------------------------------
    function rqCallback(controlBlock, code, position, address, count, options) {
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

        makeResponse(sts, options.cmdRef, options.opcode, controlBlock.unit, options.byteCount);
        // cmdPoll(); // Check for another command (not needed; host will poll)
    }

    // ----------------------------------------------------------------
    // Build a response packet
    // ----------------------------------------------------------------
    //
    // If the response packet in the ring at rspIdx is free then use it
    // to make a command response. If it is not free, retry shortly.
    //
    function makeResponse(sts, cmdRef, opcode, unit, byteCount) {
        const rspDesc = rspRingBase + rspIdx * DSC_SIZE;
        const descHi = busReadWord(rspDesc + 2);

        if (descHi & DSC_OWN) {
            const descLo = busReadWord(rspDesc);
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
                        sts = unitOnline[unit] = STS_OK;
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
                        sts = unitOnline[unit];
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
                    console.log(
                        CPU.MMR2.toString(8) +
                        " Unknown MSCP opcode:" + opcode.toString(16) +
                        " unit:" + unit +
                        " idx:" + rspIdx +
                        " buff:" + rspPkt.toString(8) +
                        "(p:" + mapUnibus(rspPkt).toString(8) + ")" +
                        " cmdRef:" + cmdRef.toString(16) +
                        " bytes:" + byteCount
                    );
                    sts = 0;
                    response = [cmdRef, unit, opcode, 0];
                    break;
            }

            if (DEBUG_UDA) {
                console.log(
                    CPU.MMR2.toString(8) +
                    " RES:" + opcode.toString(16) +
                    " unit:" + unit +
                    " idx:" + rspIdx +
                    " buff:" + rspPkt.toString(8) +
                    "(p:" + mapUnibus(rspPkt).toString(8) + ")" +
                    " bytes:" + byteCount +
                    " sts:" + sts.toString(8)
                );
            }

            // Cap credits at 14 to avoid runaway accumulation
            const sendCredit = Math.min(14, credits);
            credits -= sendCredit;

            // Insert status into opcode word
            response[2] = (sts << 16) | (opcode & 0xff) | MSCP_OP_END;

            busWriteWord(rspPkt + PKT_LEN, response.length * 4);
            busWriteWord(rspPkt + PKT_CREDITS, sendCredit);
            for (let lw = 0; lw < response.length; lw++) {
                busWriteLong(rspPkt + lw * 4, response[lw]);
            }

            // Release response descriptor to host
            busWriteWord(rspDesc + 2, (descHi | DSC_FLAG) & ~DSC_OWN);

            // Interrupt on transition from empty to non-empty response ring
            let wasEmpty = true;

            if (rspRingSize > 1) { // Ring size one MUST have been empty
                const prevAdd = (rspIdx !== 0)
                    ? rspDesc - DSC_SIZE
                    : rspRingBase + (rspRingSize - 1) * DSC_SIZE;
                const prevHi = busReadWord(prevAdd + 2);
                wasEmpty = (prevHi & DSC_OWN) !== 0; // Was previous response empty?
            }

            if (wasEmpty) {
                // Reason for interrupt is response ring no longer empty
                busWriteWord(rspRingBase + DSC_RSP_INTERRUPT, 1);

                if (irqEnabled) {
                    requestInterrupt();
                    iMask = 1;
                }
            }

            rspIdx = (rspIdx + 1) % rspRingSize;
            return;
        }

        // Not all host code is ready for an instant response; retry shortly
        setTimeout(makeResponse, 1, sts, cmdRef, opcode, unit, byteCount);
    }

    // ----------------------------------------------------------------
    // Execute an MSCP command
    // ----------------------------------------------------------------
    //
    // Either kick off a read/write I/O or make a response to the command.
    //
    function executeCmd(cmdPkt) {
        const cmdRef = busReadLong(cmdPkt + PKT_CMDREF);
        const unit = busReadWord(cmdPkt + PKT_UNIT);
        const opcode = busReadLong(cmdPkt + PKT_OPCODE);

        if (DEBUG_UDA) {
            console.log(
                CPU.MMR2.toString(8) +
                " CMD:" + opcode.toString(16) +
                " unit:" + unit +
                " idx:" + cmdIdx +
                " buff:" + cmdPkt.toString(8) +
                "(p:" + mapUnibus(cmdPkt).toString(8) + ")"
            );
        }

        const opFunc = opcode & 0xff; // Opcode function without modifiers

        if (unit <= MAX_UNIT && (opFunc === MSCP_OP_READ || opFunc === MSCP_OP_WRITE)) {
            const byteCount = busReadLong(cmdPkt + PKT_BYTECOUNT);
            const bufAddr = busReadLong(cmdPkt + PKT_BUFFER) & UNIBUS_MASK;
            const lbn = busReadLong(cmdPkt + PKT_LBN);

            // Lazy init control block
            if (!rqControlBlock[unit]) {
                rqControlBlock[unit] = {
                    cache: [],
                    callback: rqCallback,
                    url: `ra${unit}.dsk`,
                    unit
                };
            }

            // Issue read/write
            diskIO(
                rqControlBlock[unit],
                (opFunc === MSCP_OP_READ) ? OP_READ : OP_WRITE,
                lbn * 512,
                bufAddr,
                byteCount,
                { cmdRef, byteCount, opcode } // Things to remember for end of I/O
            );
        } else {
            makeResponse(0, cmdRef, opcode, unit, 0);
        }
    }

    // ----------------------------------------------------------------
    // Poll routine (called on IP read)
    // ----------------------------------------------------------------
    //
    // Check if there is a command in the ring at cmdIdx and keep pulling
    // commands from there.
    //
    function cmdPoll() {
        let cmdCount = 0;

        while (true) {
            const cmdDesc = cmdRingBase + cmdIdx * DSC_SIZE;
            const descHi = busReadWord(cmdDesc + 2);

            if (!(descHi & DSC_OWN)) { // Done on empty command descriptor
                break;
            }

            const descLo = busReadWord(cmdDesc);
            const cmdPkt = ((descHi << 16) | descLo) & UNIBUS_MASK;

            // Release command descriptor to host and go process packet
            busWriteWord(cmdDesc + 2, (descHi | DSC_FLAG) & ~DSC_OWN);
            credits++;

            executeCmd(cmdPkt);

            // Move around ring
            cmdIdx = (cmdIdx + 1) % cmdRingSize;
            cmdCount++;
        }

        if (cmdCount === cmdRingSize) { // If the ring was full
            // Flag interrupt as a command ring no longer full
            busWriteWord(rspRingBase + DSC_CMD_INTERRUPT, 1);

            if (irqEnabled) { // Interrupt on transition from cmd full to not full
                requestInterrupt();
                iMask = 1;
            }
        }
    }

    // ----------------------------------------------------------------
    // Register access
    // ----------------------------------------------------------------
    return {
        access: function(pa, data, byteFlag) {
            switch (pa & 0o06) {
                case 0o00: // IP
                    if (data < 0) { // Read
                        if (initState > 4) {
                            // IP read with controller initialized starts a POLL.
                            // RSTS reboot code cannot handle an instant response,
                            // so we defer slightly.
                            if (1) {
                                setTimeout(cmdPoll, 1);
                            } else {
                                cmdPoll();
                            }
                        }
                    } else { // Write
                        initState = 1;
                        sa = 0o4000; // Ready for step 1
                    }
                    return 0;

                case 0o02: // SA
                    if (data >= 0) {
                        switch (initState) {
                            case 1:
                                initWord = data;
                                vector = (initWord & 0x7f) << 2;
                                irqEnabled = (initWord >> 7) & 1;
                                rspRingSize = 1 << ((initWord >> 8) & 7);
                                cmdRingSize = 1 << ((initWord >> 11) & 7);
                                // Echo ring initWord in low half + ready for step 2
                                sa = 0o10000 | (initWord >>> 8);
                                break;

                            case 2:
                                rspRingBase = data;
                                // Echo IE + vector + go for step 3
                                sa = 0o20000 | (initWord & 0xff);
                                break;

                            case 3:
                                rspRingBase = ((data << 16) | rspRingBase) & UNIBUS_MASK;
                                cmdRingBase = rspRingBase + rspRingSize * 4;
                                // Clear comms area header + rsp/cmd descriptors
                                // BEFORE doing step 4
                                for (let off = -1; off < rspRingSize + cmdRingSize; off++) {
                                    busWriteLong(rspRingBase + off * 4, 0);
                                }
                                // Echo version info + go for step 4
                                sa = 0x4143; // Lowly uda50
                                break;

                            case 4:
                                rspIdx = 0;
                                cmdIdx = 0;
                                credits = 14;
                                for (let unit = 0; unit <= MAX_UNIT; unit++) {
                                    unitOnline[unit] = STS_AVAILABLE; // Unit available - not online
                                }
                                sa = 0; // Echo ready!
                                if (DEBUG_UDA) {
                                    console.log(
                                        CPU.MMR2.toString(8) +
                                        " INIT base:" + rspRingBase.toString(16) +
                                        "(p:" + mapUnibus(rspRingBase).toString(16) + ")" +
                                        " rspSize:" + rspRingSize +
                                        " cmdSize:" + cmdRingSize +
                                        " irq:" + irqEnabled +
                                        " vector:" + vector.toString(8)
                                    );
                                }
                                break;

                            default:
                                // Ignore writes and don't interrupt
                                return 0;
                        }

                        // Next initialization step
                        initState++;

                        // Interrupt only in intermediate initialization steps
                        if (initState < 5 && irqEnabled) {
                            requestInterrupt();
                            iMask = 1;
                        }
                    }
                    return sa;

                default:
                    return trap(0o4, 0x10); // Unibus timeout
            }
        },

        // ----------------------------------------------------------------
        // Interrupt poll
        // ----------------------------------------------------------------
        poll: function(takeInterrupt) {
            if (takeInterrupt) {
                iMask = 0;
                return vector;
            }
            return UDA_PRIORITY | (iMask ? 1 : 0);
        },

        reset: resetUDA
    };
})());
