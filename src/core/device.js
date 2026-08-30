/*
 * core/device.js — base class for headless machine devices (no DOM).
 *
 * The PCjs-style Device base: a device knows its id, its config slice and
 * its machine; it logs through machine.printf() (which routes to the
 * environment's I/O adapter — console in Node, DOM/console in the
 * browser). Device classes implement access(pa, data, byteFlag) and
 * optionally poll(0|1), reset(), snapshot()/restore() — the same contract
 * iopage.register() expects today, so a device can be moved out of
 * iopage.js without changing its handler shape.
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests/core.test.js).
 */
(function (global) {
    "use strict";

    class Device {
        /**
         * @param {Machine} machine  owning machine (may be null in tests)
         * @param {string} id        device id, unique within the machine
         * @param {object} config    config slice for this device
         */
        constructor(machine = null, id = "device", config = {}) {
            this.machine = machine;
            this.id = id;
            this.config = config;
            this.bus = machine ? machine.bus : null;
            this.ready = false;
        }

        /** printf(format, ...args) — log through the machine's I/O adapter. */
        printf(format, ...args) {
            if (this.machine && typeof this.machine.printf === "function") {
                this.machine.printf(format, ...args);
            } else if (typeof console !== "undefined" && console.log) {
                console.log(format, ...args);
            }
        }

        /**
         * install() — connect this device to the machine bus. Called by the
         * Machine during initDevices(); default implementation registers the
         * device's region(s) declared in config.regions:
         *   [{ address: 0177770, count: 8 }, ...]
         * Devices with custom wiring override install().
         */
        install() {
            if (!this.bus) return;
            const regions = this.config.regions;
            if (!regions) return;
            for (const r of regions) {
                this.bus.register(r.address, r.count || 4, this);
            }
        }

        /** powerOn()/powerOff() — lifecycle hooks, optional to implement. */
        powerOn() {}
        powerOff() {}
    }

    const api = { Device };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.Device = Device;
    }
})(typeof window !== "undefined" ? window : globalThis);
