/*
 * core/bus.js — Unibus I/O page as a clean class (no DOM).
 *
 * The first brick of the headless machine layer (see REFACTOR plan,
 * memory 2026-08-30): this is the register/access/poll mechanism that
 * today lives inside iopage.js, extracted 1:1 into a DOM-free class so
 * devices can be moved out of iopage.js one by one and run identically
 * in the browser and in Node.
 *
 * Design notes (mirrors iopage.js behaviour exactly):
 *   - Devices register 4-byte (or wider) regions via register(addr, count, dev).
 *   - access(pa, data, byteFlag) dispatches to the region's access handler;
 *     unmapped addresses raise a Unibus timeout trap via the host.
 *   - poll() scans devices sorted by interrupt priority (highest last),
 *     exactly like iopage.poll().
 *   - reset() / snapshotDevices() / restoreDevices() mirror the L2
 *     persistence hooks of iopage.js.
 *
 * The Bus does not know about the CPU: everything it needs (trap vector
 * dispatch, PSW/PIR, priority mask) comes from the `host` object passed to
 * the constructor — in the browser that is the existing pdp11.js globals,
 * in Node a small shim.
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests/core.test.js).
 */
(function (global) {
    "use strict";

    const IOBASE = 0o17760000;

    class Bus {
        /**
         * @param {object} host  { trap(vector, errorCode), get psw(), get pir(),
         *                        priorityMask, pswAddress } — CPU-side glue.
         */
        constructor(host = {}) {
            this.host = host;
            this.deviceReset = [];                    // reset() handlers
            this.devicePoll = [];                     // poll() handlers (sorted by priority)
            this.deviceAccess = new Array(0o17777 >>> 3); // access() handlers by slot
            this.deviceSnap = [];                     // snapshot()/restore() handlers (L2)
        }

        /**
         * access(physicalAddress, data, byteFlag) — dispatch an Unibus I/O
         * read (data < 0) or write. Returns the read value, or < 0 for NXM.
         */
        access(physicalAddress, data, byteFlag) {
            const index = (physicalAddress & 0o17777) >>> 3;
            const access = this.deviceAccess[index];

            if (access === undefined) {
                return this.host.trap ? this.host.trap(0o4, 0x10) : -1; // Unibus timeout
            }

            let result = access(physicalAddress, data, byteFlag);

            // Apply byte extraction on successful reads
            if (result >= 0 && byteFlag) {
                result = (physicalAddress & 1) ? (result >>> 8) : (result & 0xFF);
            }

            // Log NXM except for PSW (opt-in: guest OSes scan the bus on
            // boot, which would spam the console; the browser iopage.js
            // stays silent, so headless does too unless DEBUG_BUS=1).
            if (result < 0 && this.host.pswAddress &&
                physicalAddress !== this.host.pswAddress &&
                typeof process !== "undefined" && process.env.DEBUG_BUS) {
                const pc = this.host.pc !== undefined ? this.host.pc : "?";
                console.log(
                    "bus nxm " + physicalAddress.toString(8) + " " +
                    data.toString(8) + " @" + pc.toString(8)
                );
            }

            return result;
        }

        /**
         * poll() — check devices for pending interrupts (highest priority
         * first). Returns true if an interrupt was taken.
         */
        poll() {
            const psw = this.host.psw !== undefined ? this.host.psw : 0;
            const mask = this.host.priorityMask !== undefined
                ? this.host.priorityMask : 0o340;
            let priority = psw & mask;

            // PIR may have priority
            const pir = this.host.pir !== undefined ? this.host.pir : 0;
            if ((pir & mask) > priority) {
                priority = pir & mask;
            }

            // Devices are sorted highest-priority last → scan backwards
            for (let i = this.devicePoll.length - 1; i >= 0; i--) {
                const devPri = this.devicePoll[i](0); // poll(0) → priority + pending flag

                if ((devPri & mask) <= priority) {
                    break;
                }
                if (devPri & 1) {
                    if (this.host.trap) this.host.trap(this.devicePoll[i](1), 0x00);
                    return true;
                }
            }

            // PIR interrupt
            if (priority > (psw & mask)) {
                if (this.host.trap) this.host.trap(0o240, 0x00);
                return true;
            }

            return false;
        }

        /**
         * register(address, count, device) — install a device into the I/O
         * page. `device` needs an access(pa, data, byteFlag) handler and may
         * provide poll(0)/poll(1), reset() and snapshot()/restore() hooks.
         */
        register(address, count, device) {
            // Must be in I/O page
            if ((address & IOBASE) !== IOBASE) {
                console.log("bus.register invalid address:" + address.toString(8));
                return;
            }

            if (typeof device.access !== "function") {
                console.log("bus.register missing access handler at " + address.toString(8));
                return;
            }

            // Map access handlers into 8-byte slots. Handlers are bound to
            // the device so class-based devices (methods using `this`) work
            // identically to the closure-style devices of iopage.js (for
            // which bind() is a harmless no-op).
            for (let index = (address & 0o17777) >>> 3; count > 0; count -= 4, index++) {
                if (this.deviceAccess[index] !== undefined) {
                    console.log("bus.register overlap at " + address.toString(8));
                }
                this.deviceAccess[index] = device.access.bind(device);
            }

            // Optional interrupt poll handler
            if (typeof device.poll === "function") {
                const mask = this.host.priorityMask !== undefined
                    ? this.host.priorityMask : 0o340;
                const poll = device.poll.bind(device);
                const pri = poll(0) & mask;
                if (!pri) {
                    console.log("bus.register device with no priority at " + address.toString(8));
                    return;
                }

                // Insert sorted by priority (lowest first)
                let insert = this.devicePoll.length - 1;
                while (insert >= 0 &&
                       (this.devicePoll[insert](0) & mask) > pri) {
                    insert--;
                }
                this.devicePoll.splice(insert + 1, 0, poll);
            }

            // Optional reset handler
            if (typeof device.reset === "function") {
                this.deviceReset.push(device.reset.bind(device));
            }

            // Optional snapshot/restore handlers (machine-state persistence, L2)
            if (typeof device.snapshot === "function" &&
                typeof device.restore === "function") {
                this.deviceSnap.push({
                    address: address,
                    snapshot: device.snapshot.bind(device),
                    restore: device.restore.bind(device)
                });
            }
        }

        /** snapshotDevices() — capture all device register state (L2). */
        snapshotDevices() {
            const out = {};
            for (let i = 0; i < this.deviceSnap.length; i++) {
                out[this.deviceSnap[i].address.toString(8)] = this.deviceSnap[i].snapshot();
            }
            return out;
        }

        /** restoreDevices(state) — restore device register state (L2). */
        restoreDevices(state) {
            if (!state) return;
            for (let i = 0; i < this.deviceSnap.length; i++) {
                const key = this.deviceSnap[i].address.toString(8);
                if (Object.prototype.hasOwnProperty.call(state, key)) {
                    this.deviceSnap[i].restore(state[key]);
                }
            }
        }

        /** reset() — reset all registered devices. */
        reset() {
            for (let i = this.deviceReset.length - 1; i >= 0; i--) {
                this.deviceReset[i]();
            }
        }
    }

    const api = { Bus };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.Bus = Bus;
    }
})(typeof window !== "undefined" ? window : globalThis);
