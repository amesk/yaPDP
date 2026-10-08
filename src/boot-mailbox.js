/**
 * yaPDP — the Boot ROM's "booted device" mailbox (a one-register I/O device).
 *
 * A device-specific Boot ROM knows which medium it booted; the emulator needs
 * that to remember a MANUAL "BOOT <dev>" typed at the '@' prompt for the CONFIG
 * 'last' boot device. A RAM cell cannot be used — the guest overwrites low
 * memory before the next boot() reads it. So the ROM writes the device into
 * this tiny read/write register in the I/O page instead: it is a real (small)
 * device, and it survives the guest entirely.
 *
 * Register, word-addressable — physical 0o17777520, the ROM's 16-bit I/O alias
 * 0o177520 (MMU off maps 0o160000..0o177777 to physical +0o17600000):
 *   0o177520  two-char device code, little-endian ("RK" = 'R' | 'K'<<8)
 *   0o177522  unit number
 * boot.mac writes both right before it dispatches a boot; boot() reads take()
 * once per start and clears it.
 *
 * Self-registers through the shared `iopage.register(addr, count, device)`
 * contract every machine stack exposes (browser-machine.js core bus,
 * iopage.js legacy, or a headless harness's own adapter). EVERY stack that
 * boots the ROM must therefore load this file — the ROM's write would otherwise
 * hit an unmapped I/O address and trap.
 */
"use strict";

var BootMailbox = (function () {
    var ADDR = 0o17777520;   // physical base (22-bit)
    var VADDR = 0o177520;    // 16-bit I/O alias the ROM uses
    var words = [0, 0];

    function access(physicalAddress, data, byteFlag) {
        var idx = (physicalAddress >> 1) & 1;
        if (data < 0) return words[idx];           // read
        if (byteFlag) {
            if (physicalAddress & 1) {
                words[idx] = (words[idx] & 0xff) | ((data & 0xff) << 8);
            } else {
                words[idx] = (words[idx] & 0xff00) | (data & 0xff);
            }
        } else {
            words[idx] = data & 0xffff;
        }
        return words[idx];
    }

    // Register the device (idempotent). Returns true when wired.
    function register() {
        if (typeof iopage === "undefined" || typeof iopage.register !== "function") {
            return false;
        }
        iopage.register(ADDR, 4, { access: access });
        return true;
    }

    // The device key the ROM booted last ("rk1", "tm0", "pr0"), or null; the
    // mailbox is cleared so an idle power cycle reports no stale boot.
    function take() {
        if (!words[0]) return null;
        var code = String.fromCharCode(words[0] & 0xff, (words[0] >> 8) & 0xff);
        var unit = words[1] & 7;
        words[0] = 0;
        words[1] = 0;
        return (code + unit).toLowerCase();
    }

    // Raw view, for tests: { code, unit }.
    function peek() {
        return { code: words[0], unit: words[1] };
    }

    var api = {
        ADDR: ADDR,
        VADDR: VADDR,
        register: register,
        take: take,
        peek: peek,
        access: access
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    return api;
})();

// Auto-register as soon as the I/O page exists (this file loads after the
// machine layer). A stack that sets up its `iopage` adapter later calls
// BootMailbox.register() itself.
if (typeof iopage !== "undefined" && typeof iopage.register === "function") {
    BootMailbox.register();
}
