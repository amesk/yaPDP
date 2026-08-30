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
const { IO, NodeIO, BrowserIO } = require(path.join(__dirname, "..", "src", "core", "io.js"));
const { ConsoleDL11 } = require(path.join(__dirname, "..", "src", "devices", "dl11.js"));

// ----------------------------------------------------------------------
// Test helpers for devices
// ----------------------------------------------------------------------
function makeMachine(io) {
    const cpu = { interruptRequested: 0, runState: 0 };
    const host = { cpu, trap: () => -1, psw: 0, pir: 0, priorityMask: 0o340 };
    return new Machine({}, host, io || { setTimer: setTimeout, clearTimer: clearTimeout });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

// ----------------------------------------------------------------------
// 6. IO adapters (stage 1)
// ----------------------------------------------------------------------
const p6 = (async () => {
    // NodeIO: print/error to injected streams, readFile via fs, timers.
    const out = [];
    const err = [];
    const io = new NodeIO({
        stdout: { write: (s) => out.push(s) },
        stderr: { write: (s) => err.push(s) },
        stdin: null, // no interactive input in tests
    });
    io.print("hello");
    io.error("oops");
    assert.deepStrictEqual(out, ["hello\n"]);
    assert.deepStrictEqual(err, ["oops\n"]);
    ok("io: NodeIO print/error route to stdout/stderr");

    const buf = await io.readFile(path.join(__dirname, "..", "package.json"));
    assert.ok(buf instanceof Uint8Array && buf.length > 100);
    ok("io: NodeIO readFile returns file bytes");

    // Machine wired to a NodeIO adapter.
    const lines = [];
    const m = new Machine({}, {}, new NodeIO({
        stdout: { write: (s) => lines.push(s) },
        stderr: { write: () => {} },
        stdin: null,
    }));
    m.printf("machine says %s", "hi");
    assert.ok(lines.join("").includes("machine says hi"));
    ok("io: Machine.printf routes through the NodeIO adapter");
})();

// ----------------------------------------------------------------------
// 7. BrowserIO (injected window/console)
// ----------------------------------------------------------------------
const p7 = (async () => {
    const logs = [];
    let prompted = null;
    const io = new BrowserIO({
        win: {
            prompt: (p) => { prompted = p; return "typed"; },
            fetch: async () => ({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            }),
        },
        console: { log: (s) => logs.push(s), error: (s) => logs.push("E:" + s) },
    });
    io.print("boot");
    io.error("nxm");
    assert.deepStrictEqual(logs, ["boot", "E:nxm"]);
    ok("io: BrowserIO print/error route to console");

    const line = await io.input("login:");
    assert.strictEqual(line, "typed");
    assert.strictEqual(prompted, "login:");
    const bytes = await io.readFile("/media/rk1.dsk");
    assert.deepStrictEqual(Array.from(bytes), [1, 2, 3]);
    ok("io: BrowserIO input/readFile via window.prompt/fetch");
})();

// ----------------------------------------------------------------------
// 8. ConsoleDL11 device (refactor stage 2)
// ----------------------------------------------------------------------
const p8 = (async () => {
    const out = [];
    const drained = [];
    let flushed = 0;
    const m = makeMachine();
    const dev = new ConsoleDL11(m, "console", {
        unit: 0,
        vector: 0o60,
        regions: [{ address: 0o17775600, count: 4 }],
        onOutput: (ch) => out.push(ch),
        onDrained: () => drained.push(1),
        onFlush: () => flushed++,
    });
    m.addDevice(dev);
    dev.install();
    m.powerOn();

    // reset state: transmitter ready, receiver idle
    assert.strictEqual(dev.xcsr, 0x80); // XCSR DONE
    assert.strictEqual(dev.access(0o17775600, -1, 0), 0); // RCSR
    ok("dl11: reset leaves transmitter ready, receiver idle");

    // receive: byte → RCSR DONE + RBUF, no interrupt without IE
    dev.receive([0x41]); // 'A'
    await sleep(20); // let the pump deliver
    assert.strictEqual(dev.access(0o17775600, -1, 0) & 0x80, 0x80); // DONE
    assert.strictEqual(dev.access(0o17775602, -1, 0), 0x41); // RBUF (clears DONE)
    assert.strictEqual(dev.poll(0) & 1, 0); // no interrupt pending
    ok("dl11: received byte lands in RBUF with DONE, no IE → no interrupt");

    // enable receive interrupts; next byte requests one; poll takes vector
    dev.access(0o17775600, 0x40, 0); // RCSR IE
    dev.receive([0x42]);
    await sleep(20);
    assert.strictEqual(dev.poll(0) & 1, 1); // interrupt pending
    assert.strictEqual(dev.poll(1), 0o60); // console vector
    assert.strictEqual(m.host.cpu.interruptRequested, 1);
    assert.strictEqual(dev.access(0o17775602, -1, 0), 0x42); // RBUF (clears DONE)
    ok("dl11: receive interrupt requested and taken at the console vector");

    // output: XBUF write emits through the output channel
    dev.access(0x17775606, 0x48, 0); // 'H' → XBUF
    dev.access(0x17775606, 0x49, 0); // 'I'
    assert.deepStrictEqual(out, [0x48, 0x49]);
    assert.strictEqual(dev.xcsr & 0x80, 0); // DONE cleared, xdelay set
    ok("dl11: XBUF writes emit through the output channel");

    // output hook: chains, fire-and-forget on throw
    const hooked = [];
    dev.installOutputHook((ch) => hooked.push(ch));
    const throwing = dev.installOutputHook(() => { throw new Error("hook"); });
    dev.access(0x17775606, 0x58, 0); // 'X'
    assert.deepStrictEqual(hooked, [0x58]);
    dev.clearOutputHook();
    ok("dl11: output hook chains and a throwing hook is swallowed");

    // ^C flush + drained signal (drained fired once at 0x42, again here)
    dev.receive([3]);
    await sleep(20);
    assert.strictEqual(flushed, 1);
    assert.strictEqual(dev.access(0o17775602, -1, 0), 3); // ^C in RBUF
    dev.receive([0x43]); // 'C'
    await sleep(20);
    assert.strictEqual(dev.access(0o17775602, -1, 0), 0x43);
    assert.strictEqual(drained.length, 4); // once per emptied typeahead
    ok("dl11: ^C flushes output, drained signal fires when typeahead empties");

    // L2 snapshot/restore round-trip
    const snap = dev.snapshot();
    dev.restore({ ...snap, rbuf: 0x5A });
    assert.strictEqual(dev.rbuf, 0x5A);
    ok("dl11: snapshot/restore round-trips register state");

    // install() from config regions puts it on the bus
    assert.strictEqual(m.bus.access(0o17775600, -1, 0), dev.rcsr);
    ok("dl11: install() registers the console region on the bus");
})();

Promise.all([p6, p7, p8]).then(() => {
    console.log(passed + " core test(s) passed");
    process.exit(passed >= 11 ? 0 : 1);
}).catch((e) => {
    console.error("core test error:", e);
    process.exit(1);
});
