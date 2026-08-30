#!/usr/bin/env node
/**
 * Headless machine layer — core unit tests (stage 0 of the refactor).
 *
 * Covers the DOM-free base classes that devices will move onto:
 *   1. Bus: region registration, word/byte access dispatch, Unibus timeout
 *      trap on unmapped addresses, interrupt poll ordering (highest last),
 *      reset, L2 snapshot/restore hooks.
 *   2. Device: printf routing through the machine, install() from config
 *      regions.
 *   3. Machine: initDevices() from a JSON config, device registry,
 *      powerOn/powerOff lifecycle.
 *
 * Run with:  node tests/core.test.js
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const path = require("path");

const { Bus } = require(path.join(__dirname, "..", "src", "core", "bus.js"));
const { Device } = require(path.join(__dirname, "..", "src", "core", "device.js"));
const { Machine } = require(path.join(__dirname, "..", "src", "core", "machine.js"));

// ----------------------------------------------------------------------
// Test helpers
// ----------------------------------------------------------------------
function makeHost() {
    const traps = [];
    return {
        traps,
        trap: (vector, errorCode) => { traps.push([vector, errorCode]); return -1; },
        psw: 0,
        pir: 0,
        priorityMask: 0o340,
        pswAddress: 0o177776,
        pc: 0o1000,
    };
}

// A tiny device: one register at a known address.
function makeRegDevice(addr, initial = 0) {
    let reg = initial;
    return {
        access(pa, data) {
            if (data < 0) return reg;
            reg = data & 0xFFFF;
            return reg;
        },
        get value() { return reg; },
    };
}

let passed = 0;
function ok(name) { passed++; console.log("PASS: " + name); }

// ----------------------------------------------------------------------
// 1. Bus
// ----------------------------------------------------------------------
{
    const host = makeHost();
    const bus = new Bus(host);

    const devA = makeRegDevice(0o17770000, 0x1234);
    bus.register(0o17770000, 4, devA);
    ok("bus: register installs a 4-byte region");

    // Word read
    assert.strictEqual(bus.access(0o17770000, -1, 0), 0x1234);
    ok("bus: word read returns the register value");

    // Word write
    bus.access(0o17770000, 0xABCD, 0);
    assert.strictEqual(devA.value, 0xABCD);
    ok("bus: word write updates the register");

    // Byte read — even address = low byte
    assert.strictEqual(bus.access(0o17770000, -1, 1), 0xCD);
    // Byte read — odd address = high byte
    assert.strictEqual(bus.access(0o17770001, -1, 1), 0xAB);
    ok("bus: byte reads extract low/high halves by address parity");

    // Unmapped address → Unibus timeout trap
    const r = bus.access(0o17770220, -1, 0);
    assert.strictEqual(r, -1);
    assert.deepStrictEqual(host.traps[0], [0o4, 0x10]);
    ok("bus: unmapped access raises the Unibus timeout trap (vector 4, code 0x10)");

    // 8-byte region spanning two slots
    const devB = makeRegDevice(0o17770100, 0x55);
    bus.register(0o17770100, 8, devB);
    assert.strictEqual(bus.access(0o17770104, -1, 0), 0x55);
    ok("bus: a region wider than 4 bytes maps every 4-byte slot");
}

// ----------------------------------------------------------------------
// 2. Bus interrupts (poll ordering)
// ----------------------------------------------------------------------
{
    const host = makeHost();
    const bus = new Bus(host);

    const taken = [];
    const mkDev = (name, priority, pending) => ({
        access: () => 0, // bus.register requires an access handler
        poll(which) {
            if (which === 0) return (priority & 0o340) | (pending ? 1 : 0);
            if (which === 1) return 0o300; // interrupt vector
            return 0;
        },
        name,
    });

    // Register in arbitrary order; poll must scan highest priority LAST.
    bus.register(0o17770200, 4, mkDev("low", 0o100, true));
    bus.register(0o17770210, 4, mkDev("high", 0o300, true));
    bus.register(0o17770220, 4, mkDev("mid", 0o200, false));

    // PSW priority 0 → high device (0o300) wins.
    assert.strictEqual(bus.poll(), true);
    assert.deepStrictEqual(host.traps[0], [0o300, 0x00]);
    ok("bus: poll takes the highest-priority pending interrupt");

    // With PSW priority 0o300, the high device is masked → no interrupt.
    host.psw = 0o300;
    const before = host.traps.length;
    assert.strictEqual(bus.poll(), false);
    assert.strictEqual(host.traps.length, before);
    ok("bus: poll respects the PSW priority mask");

    // PIR above PSW → PIR interrupt.
    host.pir = 0o340;
    assert.strictEqual(bus.poll(), true);
    assert.deepStrictEqual(host.traps[host.traps.length - 1], [0o240, 0x00]);
    ok("bus: PIR above PSW raises the PIR interrupt");
}

// ----------------------------------------------------------------------
// 3. Bus reset + L2 snapshot/restore
// ----------------------------------------------------------------------
{
    const bus = new Bus(makeHost());
    let resets = 0;
    const snap = { reg: 0x1111 };
    bus.register(0o17770300, 4, {
        access: () => 0,
        reset: () => { resets++; },
        snapshot: () => ({ ...snap }),
        restore: (s) => { snap.reg = s.reg; },
    });
    bus.reset();
    assert.strictEqual(resets, 1);
    ok("bus: reset() calls every device reset handler");

    const state = bus.snapshotDevices();
    assert.deepStrictEqual(state["17770300"], { reg: 0x1111 });
    bus.restoreDevices({ "17770300": { reg: 0x2222 } });
    assert.strictEqual(snap.reg, 0x2222);
    ok("bus: L2 snapshot/restore round-trips device state by address");
}

// ----------------------------------------------------------------------
// 4. Device base
// ----------------------------------------------------------------------
{
    const lines = [];
    const machine = new Machine({}, {}, { print: (s) => lines.push(s) });
    const dev = new Device(machine, "test-dev", {
        regions: [{ address: 0o17776000, count: 4 }],
    });
    dev.access = () => 0x77; // handler must exist before install() registers
    dev.install();
    assert.strictEqual(dev.bus, machine.bus);
    dev.printf("hello %s", "world");
    assert.ok(lines.some((l) => l.includes("hello world")));
    ok("device: printf routes through the machine I/O adapter");

    // install() from config regions registers the device on the bus.
    const read = machine.bus.access(0o17776000, -1, 0);
    assert.strictEqual(read, 0x77);
    ok("device: install() registers config regions on the bus");
}

// ----------------------------------------------------------------------
// 5. Machine assembly from config
// ----------------------------------------------------------------------
{
    class FakeConsole extends Device {
        access() { return 0x40; } // console receiver buffer
    }
    class FakeDisk extends Device {
        access() { return 0x41; }
    }

    const machine = new Machine({
        devices: [
            { type: "FakeConsole", id: "console", regions: [{ address: 0o17775600, count: 8 }] },
            { type: "FakeDisk", id: "rk1", regions: [{ address: 0o17774000, count: 16 }] },
        ],
    }, makeHost());
    machine.initDevices({ FakeConsole, FakeDisk });

    assert.ok(machine.findDevice("console") instanceof FakeConsole);
    assert.ok(machine.findDevice("rk1") instanceof FakeDisk);
    assert.strictEqual(machine.bus.access(0o17775600, -1, 0), 0x40);
    assert.strictEqual(machine.bus.access(0o17774000, -1, 0), 0x41);
    ok("machine: initDevices() assembles devices from a JSON config");

    let powered = 0;
    machine.findDevice("console").powerOn = () => { powered++; };
    machine.powerOn();
    assert.strictEqual(powered, 1);
    assert.strictEqual(machine.powered, true);
    machine.powerOff();
    assert.strictEqual(machine.powered, false);
    ok("machine: powerOn/powerOff lifecycle");

    // Unknown device type is tolerated (logged, skipped).
    const m2 = new Machine({ devices: [{ type: "Nope", id: "x" }] }, makeHost());
    m2.initDevices({});
    assert.strictEqual(m2.findDevice("x"), null);
    ok("machine: unknown device type is skipped without throwing");
}

console.log(passed + " core test(s) passed");
process.exit(passed >= 11 ? 0 : 1);
