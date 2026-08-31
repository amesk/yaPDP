/*
 * browser-machine.js — the refactored machine layer in the browser.
 *
 * Loaded INSTEAD of iopage.js when the page is opened with ?core=1:
 * builds the machine from the core base classes and devices, and exposes
 * the same global contract the rest of the UI expects:
 *
 *   - a global `iopage` ADAPTER (access/poll/reset/register/
 *     scheduleCallback/processPendingCallbacks/snapshotDevices/
 *     restoreDevices) delegating to the machine's Bus — the CPU (pdp11.js)
 *     and snapshots.js keep working unchanged;
 *   - the window bridge (dlReceiveQueue/dlReceiveQueueN/dlConsoleBreak/
 *     __consoleOutputHook/onConsoleInputDrained) wired to the ConsoleDL11
 *     device — quickboot, pasteutil, pdp11-app keyboard and reader.js
 *     keep working unchanged;
 *   - Storage-page punch hooks (downloadPunchTape/clearPunchTape/
 *     ptrRewindTape) and the tape-state/punch-size DOM indicators wired
 *     to the PtrPtp device.
 *
 * Disk/tape bytes come from DataLoader (in-memory images, drag & drop,
 * fetch) exactly like the iopage path; guest writes are accepted but not
 * yet persisted (write-back to IndexedDB lands in a later step).
 *
 * The browser build has top-level const/let visible across scripts, so
 * CPU/MAX_MEMORY/readPSW/writePSW/trap/readWordByPhysical are reachable
 * here without any changes to pdp11.js.
 */
(function () {
    "use strict";

    if (!window.__coreMode) return; // only in ?core=1 mode

    // Global helper iopage.js used to provide; external device modules
    // (vt11.js) call it from their access handlers.
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
    window.insertData = insertData;

    // ------------------------------------------------------------------
    // Host glue (CPU side) — mirrors tools/headless-machine.js
    // ------------------------------------------------------------------
    var IOBASE_22BIT = 0o17760000;

    function mapUnibus(ba) {
        var index = (ba >>> 13) & 0x1f;
        if (index < 31) {
            if (CPU.MMR3 & 0x20) {
                ba = (CPU.unibusMap[index] + (ba & 0x1fff)) & 0x3fffff;
            }
        } else {
            ba |= IOBASE_22BIT;
        }
        return ba;
    }

    var pendingCallbacks = [];

    var host = {
        cpu: CPU,
        get psw() { return CPU.PSW; },
        get pir() { return CPU.PIR; },
        priorityMask: 0o340,
        pswAddress: 0o17777776,
        // MAX_MEMORY is a const in pdp11.js; derive it from the memory
        // array (words) so CpuRegs can report the size register.
        maxMemory: CPU.memory.length << 1,
        readPSW: function () { return readPSW(); },
        writePSW: function (v) { writePSW(v); },
        trap: function (v, e) { return trap(v, e); },
        // MMR3 writes re-apply the MMU mode through the CPU's own setMMUmode.
        setMMUmode: function (m) { setMMUmode(m); },
        busReadWord: function (ba) { return readWordByPhysical(mapUnibus(ba)); },
        busWriteWord: function (ba, data) { return writeWordByPhysical(mapUnibus(ba), data & 0xFFFF); },
        writeByteByPhysical: function (a, d) { return writeByteByPhysical(a, d); },
        mapUnibus: function (ba) { return mapUnibus(ba); },
        scheduleCallback: function (fn) {
            pendingCallbacks.push({ fn: fn, args: Array.prototype.slice.call(arguments, 1) });
        },
    };

    var core = window.yapdpCore;
    var machine = new core.Machine({}, host);

    // ------------------------------------------------------------------
    // Console DL11 (tty0) + user terminals (tty1/tty2)
    // ------------------------------------------------------------------
    function consoleOutput(unit, cfg, ch) {
        if (unit === 0) {
            if (cfg && cfg.consoleType === 'vt52') {
                vt52Write(0, ch);
            } else if (typeof g60ConsoleWrite !== 'undefined') {
                g60ConsoleWrite(ch);
            }
            if (window.__consoleOutputHook) {
                try { window.__consoleOutputHook(ch); } catch (e) { /* fire-and-forget */ }
            }
            if (typeof NavActivity !== 'undefined') {
                NavActivity.pulseConsole(cfg && cfg.consoleType);
            }
        } else {
            vt52Write(unit, ch);
            if (typeof NavActivity !== 'undefined') {
                NavActivity.pulseTerminal(unit);
            }
        }
    }

    var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
    var userTerminals = cfg && cfg.userTerminals ? cfg.userTerminals : 0;

    function makeConsole(unit, vector, address) {
        var dev = new core.ConsoleDL11(machine, unit === 0 ? "console" : "tty" + unit, {
            unit: unit,
            vector: vector,
            regions: [{ address: address, count: 4 }],
            onOutput: function (ch) { consoleOutput(unit, cfg, ch); },
            onDrained: function () {
                if (unit === 0 && window.onConsoleInputDrained) {
                    try { window.onConsoleInputDrained(); } catch (e) { /* ignore */ }
                }
            },
            onFlush: function () {
                if (typeof flushG60Console === 'function') flushG60Console();
            },
        });
        machine.addDevice(dev);
        dev.install();
        return dev;
    }

    var consoleDev = makeConsole(0, 0o60, 0o17777560);
    window.dlReceiveQueue = function (unit, bytes) {
        var dev = unit === 0 ? consoleDev : machine.findDevice("tty" + unit);
        if (dev) dev.receive(bytes);
    };
    window.dlConsoleBreak = function () { consoleDev.breakSignal(); };
    if (userTerminals >= 1) {
        var tty1 = makeConsole(1, 0o310, 0o17776500);
        window["dlReceiveQueue1"] = function (unit, bytes) { tty1.receive(bytes); };
    }
    if (userTerminals >= 2) {
        var tty2 = makeConsole(2, 0o320, 0o17776510);
        window["dlReceiveQueue2"] = function (unit, bytes) { tty2.receive(bytes); };
    }

    // ------------------------------------------------------------------
    // KW11 line clock + core CPU registers
    // ------------------------------------------------------------------
    var kw = new core.Kw11(machine, "kw11", {
        regions: [{ address: 0o17777546, count: 4 }],
    });
    machine.addDevice(kw);
    kw.install();

    var cpuRegs = new core.CpuRegs(machine, "cpu-regs", {
        cpuType: 70,
        regions: [
            { address: 0o17777770, count: 4 },
            { address: 0o17777760, count: 4 },
        ],
    });
    machine.addDevice(cpuRegs);
    cpuRegs.install();

    // MMU registers (PDR/PAR kernel/super/user + 11/70 Unibus map) — the
    // iopage.js MMU register file; required by MMU-using guests (V5/BSD).
    var mmuRegs = new core.MmuRegs(machine, "mmu-regs", { cpuType: 70 });
    machine.addDevice(mmuRegs);
    mmuRegs.install();

    // ------------------------------------------------------------------
    // RK11 disks — bytes from DataLoader (in-memory images)
    // ------------------------------------------------------------------
    var rk = new core.Rk11(machine, "rk0", {
        regions: [{ address: 0o17777400, count: 8 }],
    });
    machine.addDevice(rk);
    rk.install();

    // --- RP11 (RP04/RP06) — BSD 2.11, RSTS/E, RSX-11M on rp0-rp4 ---
    var rp = new core.Rp11(machine, "rp1", {
        regions: [{ address: 0o17776700, count: 20 }],
    });
    machine.addDevice(rp);
    rp.install();

    function dataLoaderProvider(url) {
        // LAZY provider: DataLoader is filled by dragdrop.js / quickboot
        // / tauri-bundled.js at various times, so every readBlock re-reads
        // the current mounted bytes instead of closing over a snapshot.
        // If the image is not mounted yet, fall back to the network path
        // (media/<url>.zst) exactly like iopage.js fetchBlock() does.
        var fetched = false;

        async function bytes() {
            if (typeof DataLoader === 'undefined') return undefined;
            var local = DataLoader.get(url);
            if (local !== undefined) return local;
            if (fetched || typeof fetch !== 'function' || typeof fzstd === 'undefined') {
                return undefined;
            }
            fetched = true;
            try {
                var resp = await fetch('media/' + url + '.zst');
                if (!resp.ok) return undefined;
                var buf = await resp.arrayBuffer();
                var raw = fzstd.decompress(new Uint8Array(buf));
                DataLoader.mount(url, raw);
                return raw;
            } catch (e) {
                return undefined;
            }
        }

        return {
            readBlock: async function (n) {
                var local = await bytes();
                if (local === undefined) return new Uint8Array(0);
                var start = n * 131072;
                if (start >= local.length) return new Uint8Array(0);
                return local.subarray(start, Math.min(start + 131072, local.length));
            },
            writeBlock: async function () { /* write-back to IDB: later step */ },
            length: function () {
                if (typeof DataLoader === 'undefined') return undefined;
                var local = DataLoader.get(url);
                return local ? local.length : undefined;
            },
        };
    }

    // Mount every possible RK drive up front; the lazy provider resolves
    // the bytes from DataLoader whenever the guest actually reads them.
    function mountDrives() {
        for (var d = 0; d < 8; d++) {
            machine.mountDrive("rk" + d + ".dsk", dataLoaderProvider("rk" + d + ".dsk"));
        }
        for (var p = 0; p < 5; p++) {
            machine.mountDrive("rp" + p + ".dsk", dataLoaderProvider("rp" + p + ".dsk"));
        }
    }
    mountDrives();

    // ------------------------------------------------------------------
    // PTR11/PTP11 paper tape — bytes from DataLoader; punch hooks
    // ------------------------------------------------------------------
    var ptr = new core.PtrPtp(machine, "ptr", {
        regions: [{ address: 0o17777550, count: 4 }],
        onTapeState: function (state) {
            var el = document.getElementById("ptr-state");
            if (!el) return;
            var label = {
                "none": "No tape", "at-start": "At start",
                "ready": "Reading", "consumed": "Consumed (end)"
            };
            el.textContent = label[state] || state;
            el.className = "tape-state " + state;
        },
        onPunchSize: function (n) {
            var el = document.getElementById("punch-size");
            if (el) el.textContent = n + " bytes";
        },
    });
    machine.addDevice(ptr);
    ptr.install();

    function ptrUrlFor(name) {
        return /\.ptap$/i.test(name) ? name : name + ".ptap";
    }
    function mountSelectedTape() {
        var sel = document.getElementById("ptr");
        var name = sel ? sel.value : "";
        if (name === "") { ptr.rewind(); return; }
        var url = ptrUrlFor(name);
        machine.mountDrive(url, dataLoaderProvider(url));
        ptr.loadTape(url);
    }
    window.ptrRewindTape = function () { ptr.rewind(); };
    window.downloadPunchTape = function () {
        var out = ptr.punchBytes();
        if (!out.length) return;
        var blob = new Blob([new Uint8Array(out)], { type: "application/octet-stream" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "punch.ptap";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };
    window.clearPunchTape = function () { ptr.clearPunch(); };
    var ptrSelect = document.getElementById("ptr");
    if (ptrSelect) {
        ptrSelect.addEventListener("change", mountSelectedTape);
    }

    // DataLoader (dragdrop.js) loads after this script: mount drives and
    // the initially selected tape once the DOM is ready.
    function initDataSources() {
        mountDrives();
        if (ptrSelect) mountSelectedTape();
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initDataSources);
    } else {
        initDataSources();
    }

    // ------------------------------------------------------------------
    // LP11 line printer (only when the CONFIG enables it)
    // ------------------------------------------------------------------
    var lp11 = null;
    if (cfg && cfg.printer) {
        lp11 = new core.Lp11(machine, "lp11", {
            regions: [{ address: 0o17777510, count: 2 }],
            printerWidth: (typeof Config !== 'undefined') ? Config.get().printerWidth : 132,
        });
        machine.addDevice(lp11);
        lp11.install();
        window.lp11Print = function () { lp11.print(); };
        window.lp11Save = function () { lp11.save(); };
        window.lp11GetText = function () { return lp11.getText(); };
        window.lp11PaperFeed = function () { lp11.paperFeed(); };
        window.lp11TopOfForm = function () { lp11.topOfForm(); };
        window.lp11TearPaper = function () { lp11.tearPaper(); };
        window.lp11OnLine = function () { lp11.onLine(); };
    }

    // ------------------------------------------------------------------
    // The global iopage adapter — the CPU's only view of the I/O page
    // ------------------------------------------------------------------
    window.iopage = {
        access: function (pa, d, b) { return machine.bus.access(pa, d, b); },
        poll: function () { return machine.bus.poll(); },
        reset: function () { return machine.bus.reset(); },
        register: function (address, count, device) {
            // External modules (vt11.js) register their devices through the
            // same iopage.register contract — delegate to the bus.
            return machine.bus.register(address, count, device);
        },
        scheduleCallback: function (fn) {
            pendingCallbacks.push({ fn: fn, args: Array.prototype.slice.call(arguments, 1) });
        },
        processPendingCallbacks: function () {
            while (pendingCallbacks.length) {
                var item = pendingCallbacks.shift();
                item.fn.apply(null, item.args);
            }
        },
        snapshotDevices: function () { return machine.bus.snapshotDevices(); },
        restoreDevices: function (state) { return machine.bus.restoreDevices(state); },
    };

    window.__coreMachine = machine; // diagnostics / future tools
})();
