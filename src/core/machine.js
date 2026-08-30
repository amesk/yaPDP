/*
 * core/machine.js — machine assembly from a JSON config (no DOM).
 *
 * The PCjs-style Machine: owns the Bus, the device registry and the
 * environment I/O adapter. initDevices(deviceClasses) walks the config's
 * `devices` array and instantiates each device:
 *
 *   {
 *     "devices": [
 *       { "type": "ConsoleDL11", "id": "console", "regions": [{ "address": 0177560, "count": 8 }] },
 *       { "type": "Rk11",        "id": "rk1",     "regions": [{ "address": 0177400, "count": 16 }] }
 *     ]
 *   }
 *
 * `type` is looked up in the deviceClasses map passed to initDevices, so
 * the same config drives the browser build (classes registered from the
 * UI layer) and the headless Node build (same classes, Node I/O adapter).
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests/core.test.js).
 */
(function (global) {
    "use strict";

    const { Bus } = (typeof module !== "undefined" && module.exports)
        ? require("./bus.js")
        : (global.yapdpCore || {});

    class Machine {
        /**
         * @param {object} config    machine config (devices array etc.)
         * @param {object} host      Bus host glue (trap, psw, pir, ...)
         * @param {object} io        I/O adapter { print(text), ... } — the
         *                           WebIO analogue; defaults to console.
         */
        constructor(config = {}, host = {}, io = null) {
            this.config = config;
            this.host = host;
            this.io = io || {
                print: (s) => { if (typeof console !== "undefined") console.log(s); }
            };
            this.bus = new Bus(host);
            this.devices = {};
            this.powered = false;
        }

        /** printf(format, ...args) — route through the I/O adapter. */
        printf(format, ...args) {
            let s = format;
            if (args.length) {
                try {
                    s = format.replace(/%[sd]/g, () => String(args.shift()));
                } catch (e) { /* keep raw format on failure */ }
            }
            if (this.io && typeof this.io.print === "function") this.io.print(s);
        }

        /**
         * addDevice(device) — register an already-constructed device.
         */
        addDevice(device) {
            if (!device || !device.id) return;
            device.machine = this;
            device.bus = this.bus;
            this.devices[device.id] = device;
            return device;
        }

        /**
         * initDevices(deviceClasses) — instantiate every device from
         * config.devices. deviceClasses maps config `type` strings to
         * Device subclasses. Returns this (chainable).
         */
        initDevices(deviceClasses = {}) {
            const list = this.config.devices || [];
            for (const entry of list) {
                const cls = deviceClasses[entry.type];
                if (!cls) {
                    this.printf("machine: unknown device type '%s' (id=%s)",
                        entry.type, entry.id);
                    continue;
                }
                const dev = new cls(this, entry.id || entry.type, entry);
                this.addDevice(dev);
                if (typeof dev.install === "function") dev.install();
            }
            return this;
        }

        /** findDevice(id) — get a device by id, or null. */
        findDevice(id) {
            return this.devices[id] || null;
        }

        /** powerOn() — power the machine: bus reset, then device hooks. */
        powerOn() {
            if (this.powered) return;
            this.bus.reset();
            for (const id of Object.keys(this.devices)) {
                this.devices[id].powerOn();
            }
            this.powered = true;
        }

        /** powerOff() — device hooks only (state is kept). */
        powerOff() {
            if (!this.powered) return;
            for (const id of Object.keys(this.devices)) {
                this.devices[id].powerOff();
            }
            this.powered = false;
        }
    }

    const api = { Machine };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.Machine = Machine;
    }
})(typeof window !== "undefined" ? window : globalThis);
