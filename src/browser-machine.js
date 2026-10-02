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

    // VT11 (src/vt11.js) is not yet refactored into a Device class and
    // still calls the global requestInterrupt() from iopage.js.  Provide
    // the same contract here so the VT11 works in ?core=1 mode.
    window.requestInterrupt = function () {
        CPU.interruptRequested = 1;
        if (CPU.runState === 2) CPU.runState = 0; // STATE_WAIT → STATE_RUN
    };

    var core = window.yapdpCore;
    var machine = new core.Machine({}, host);

    // ------------------------------------------------------------------
    // Console DL11 (tty0) + user terminals (tty1/tty2)
    // ------------------------------------------------------------------
    function consoleOutput(unit, cfg, ch) {
        if (unit === 0) {
            // Both graphical consoles take the byte through their own writer;
            // a teletype prints it on the Model 33 paper instead.
            if (cfg && (cfg.consoleType === 'vt52' || cfg.consoleType === 'vt100')) {
                vt52Write(0, ch);
            } else if (typeof g60ConsoleWrite !== 'undefined') {
                g60ConsoleWrite(ch);
            }
            if (outputHook) {
                try { outputHook(ch); } catch (e) { /* fire-and-forget */ }
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

    // Internal console-output hook slot — same contract as iopage.js:
    // set through __yapdpBridge.setOutputHook (in-page features) or the
    // legacy window.__consoleOutputHook shim (?bridge=1 mode).
    var outputHook = null;

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

    // Internal bridge — always exposed, same contract as iopage.js
    // (__yapdpBridge.dlReceiveQueue / dlConsoleBreak / setOutputHook).
    // The legacy window.dlReceiveQueue / dlConsoleBreak /
    // __consoleOutputHook surface is ?bridge=1-gated (external tooling).
    var bridgeEnabled = /[?&]bridge=1/.test(location.search);
    function bridgeReceive(unit, bytes) {
        var dev = unit === 0 ? consoleDev : machine.findDevice("tty" + unit);
        if (dev) dev.receive(bytes);
    }
    window.__yapdpBridge = {
        dlReceiveQueue: bridgeReceive,
        dlConsoleBreak: function () { consoleDev.breakSignal(); },
        setOutputHook: function (fn) {
            var prev = outputHook;
            outputHook = fn;
            return prev; // chain: caller can re-install the old hook
        },
    };
    if (bridgeEnabled) {
        window.dlReceiveQueue = bridgeReceive;
        window.dlConsoleBreak = function () { consoleDev.breakSignal(); };
        Object.defineProperty(window, "__consoleOutputHook", {
            get: function () { return outputHook; },
            set: function (fn) { outputHook = fn; },
            configurable: true,
        });
        if (userTerminals >= 1) {
            window["dlReceiveQueue1"] = function (unit, bytes) { machine.findDevice("tty1").receive(bytes); };
        }
        if (userTerminals >= 2) {
            window["dlReceiveQueue2"] = function (unit, bytes) { machine.findDevice("tty2").receive(bytes); };
        }
    }
    if (userTerminals >= 1) {
        var tty1 = makeConsole(1, 0o310, 0o17776500);
    }
    if (userTerminals >= 2) {
        var tty2 = makeConsole(2, 0o320, 0o17776510);
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

    // --- RL11 (RL01/RL02) — BSD 2.9, RSX-11M, RSTS/E, XXDP on rl0-rl3 ---
    var rl = new core.Rl11(machine, "rl0", {
        regions: [{ address: 0o17774400, count: 4 }],
    });
    machine.addDevice(rl);
    rl.install();

    // --- TM11 (TU10) — RSTS/E rollin tapes on tm0-tm2 ---
    var tm = new core.Tm11(machine, "tm0", {
        regions: [{ address: 0o17772520, count: 6 }],
    });
    machine.addDevice(tm);
    tm.install();

    // --- UDA50 (MSCP, RA81) — BSD 2.11/RSTS "ra" drives on ra0-ra2 ---
    var uda = new core.Uda50(machine, "ra0", {
        regions: [{ address: 0o17772150, count: 2 }],
    });
    machine.addDevice(uda);
    uda.install();

    // loadBaseBytes(url) — the pristine image bytes: DataLoader when mounted,
    // otherwise the network (media/<url>.zst, then the raw file). On success
    // the bytes are mounted into DataLoader, so the disk provider and the
    // exporter share ONE fetch path. Resolves undefined when unavailable.
    async function loadBaseBytes(url) {
        if (typeof DataLoader === "undefined") return undefined;
        var local = DataLoader.get(url);
        if (local !== undefined) return local;
        // Desktop bundle: images are mounted asynchronously by
        // tauri-bundled.js. Do NOT fall through to a network fetch (the desktop
        // build ships media/ as Tauri resources, not as static files, so
        // 'media/<url>' would 404). Wait for the bundle, then re-check.
        if (window.__yapdpBundledReady && typeof window.__yapdpBundledReady.then === "function") {
            try { await window.__yapdpBundledReady; } catch (e) { /* keep going */ }
            var afterBundle = DataLoader.get(url);
            if (afterBundle !== undefined) return afterBundle;
        }
        if (typeof fetch !== "function" || typeof fzstd === "undefined") return undefined;
        var progress = (typeof window !== "undefined" && window.__yapdpMediaProgress &&
                        typeof window.__yapdpMediaProgress.fetchBytes === "function")
            ? window.__yapdpMediaProgress.fetchBytes
            : function (u) {
                return fetch(u).then(function (r) {
                    return r.arrayBuffer().then(function (b) {
                        return { bytes: new Uint8Array(b), response: r };
                    });
                });
            };
        try {
            var got = await progress("media/" + url + ".zst");
            if (got.response.ok) {
                // Record the identity of the bytes just received, so a block
                // saved from a different build of this disk can be told apart
                // (see DiskStore.registerImage). Unknown module or unknown
                // bytes simply leave it unset, which never invalidates.
                if (typeof DiskStore !== "undefined" &&
                    typeof DiskStore.registerImage === "function" &&
                    typeof ImageFingerprint !== "undefined" &&
                    typeof ImageFingerprint.ofBytes === "function") {
                    try {
                        DiskStore.registerImage(url, ImageFingerprint.ofBytes(got.bytes));
                    } catch (e) { /* identity unknown: stay permissive */ }
                }
                var raw = fzstd.decompress(got.bytes);
                DataLoader.mount(url, raw);
                return raw;
            }
        } catch (e) {
            // Paper tapes may ship compressed (.ptap.zst) or raw (.ptap), so a
            // failed .zst probe is not fatal — fall through to the raw file.
        }
        try {
            var rawGot = await progress("media/" + url);
            if (!rawGot.response.ok) return undefined;
            DataLoader.mount(url, rawGot.bytes);
            return rawGot.bytes;
        } catch (e) {
            return undefined;
        }
    }

    function dataLoaderProvider(url) {
        // LAZY provider: DataLoader is filled by dragdrop.js / quickboot
        // / tauri-bundled.js at various times, so every readBlock re-reads
        // the current mounted bytes instead of closing over a snapshot.
        // If the image is not mounted yet, fall back to the network path
        // (media/<url>.zst) exactly like iopage.js fetchBlock() does.
        //
        // Write-back: DiskStore (src/diskstore.js) is the shared
        // persistent overlay — the same IndexedDB layer iopage.js uses.
        // Guest writes land in the provider's control-block cache and are
        // reported via markDirty(); flush() (periodic + pagehide) persists
        // them to IDB, and readBlock() consults DiskStore BEFORE the
        // base-image path so a saved block always wins. Snapshot
        // capture/restore (snapshots.js) works through the same overlay.
        var fetched = false;
        // controlBlock mirrors the iopage.js contract DiskStore expects:
        // { url, cache: [Uint16Array words] }.
        var controlBlock = { url: url, cache: [] };

        function packWords(bytes) {
            var u16 = new Uint16Array(bytes.length >>> 1);
            for (var i = 0; i < u16.length; i++) {
                u16[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
            }
            return u16;
        }

        function unpackBytes(u16) {
            var bytes = new Uint8Array(u16.length * 2);
            for (var i = 0; i < u16.length; i++) {
                bytes[i * 2] = u16[i] & 0xFF;
                bytes[i * 2 + 1] = (u16[i] >>> 8) & 0xFF;
            }
            return bytes;
        }

        async function baseBytes() {
            var local = (typeof DataLoader !== "undefined") ? DataLoader.get(url) : undefined;
            if (local !== undefined) return local;
            // One network attempt per provider: an unreachable image must not
            // make every cache miss re-fetch. loadBaseBytes() is shared with
            // the exporter (window.exportDiskImage).
            if (fetched) return undefined;
            fetched = true;
            return loadBaseBytes(url);
        }

        return {
            readBlock: async function (n) {
                // 1. Session write-back cache (written this run, not yet
                //    necessarily flushed to IDB).
                if (controlBlock.cache[n] !== undefined) {
                    return unpackBytes(controlBlock.cache[n]);
                }
                // 2. Persistent overlay: saved blocks win over the base.
                if (typeof DiskStore !== 'undefined' && DiskStore.getBlock) {
                    var saved = await DiskStore.getBlock(url, n);
                    if (saved !== undefined) return saved;
                }
                // 3. Base image (DataLoader or network).
                var local = await baseBytes();
                if (local === undefined) return new Uint8Array(0);
                var start = n * 131072;
                if (start >= local.length) return new Uint8Array(0);
                return local.subarray(start, Math.min(start + 131072, local.length));
            },
            writeBlock: async function (n, bytes) {
                controlBlock.cache[n] = packWords(bytes);
                if (typeof DiskStore !== 'undefined' && DiskStore.markDirty) {
                    DiskStore.markDirty(controlBlock, n);
                }
            },
            length: function () {
                if (typeof DataLoader === 'undefined') return undefined;
                var local = DataLoader.get(url);
                return local ? local.length : undefined;
            },
        };
    }

    // ensureProvider(url) — attach (or replace) the lazy DataLoader provider
    // of one image url. Exposed as window.__yapdpMountProvider so the UI
    // layer (dragdrop.js) can register a provider for a user image whose url
    // is not one of the well-known defaults below — required when a MountMap
    // override points a drive at that url.
    function ensureProvider(url) {
        if (!url) return;
        machine.mountDrive(url, dataLoaderProvider(url));
    }
    window.__yapdpMountProvider = ensureProvider;

    // Mount every well-known drive up front; the lazy provider resolves the
    // bytes from DataLoader whenever the guest actually reads them. Any url
    // referenced by a MountMap override is mounted too, so a remapped drive
    // (e.g. rl0 -> mybsd.dsk) reads its image instead of implicit zeros.
    function mountDrives() {
        for (var d = 0; d < 8; d++) {
            ensureProvider("rk" + d + ".dsk");
        }
        for (var p = 0; p < 5; p++) {
            ensureProvider("rp" + p + ".dsk");
        }
        for (var l = 0; l < 4; l++) {
            ensureProvider("rl" + l + ".dsk");
        }
        for (var a = 0; a < 4; a++) {
            ensureProvider("ra" + a + ".dsk");
        }
        for (var t = 0; t < 3; t++) {
            ensureProvider("tm" + t + ".tap");
        }
        if (typeof MountMap !== "undefined" && MountMap &&
            typeof MountMap.list === "function") {
            var overrides = MountMap.list();
            Object.keys(overrides).forEach(function (key) {
                ensureProvider(overrides[key]);
            });
        }
    }
    mountDrives();

    // Persist guest writes (refactor): DiskService keeps written blocks in its
    // per-drive cache and marks them dirty, but nothing pushed them to the
    // provider on its own — so DiskStore/IndexedDB never saw a guest write in
    // the core stack (the legacy diskIO path called DiskStore.markDirty
    // directly). Drain the dirty drives into the provider (dataLoaderProvider
    // -> DiskStore) on a short timer and on page hide, the "flush on a cadence
    // + pagehide" contract the legacy path already used. Cheap: flushDrive()
    // returns immediately for a drive with no dirty blocks.
    function flushDirtyDrives() {
        var drives = machine.disk.drives || {};
        Object.keys(drives).forEach(function (url) {
            var d = drives[url];
            if (d && d.dirty && d.dirty.size > 0) {
                try { machine.disk.flushDrive(url); } catch (e) { /* keep going */ }
            }
        });
    }
    setInterval(flushDirtyDrives, 1000);
    if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("pagehide", flushDirtyDrives);
    }

    // flushAndResetDisks() — the Reboot sequence for disk state.
    //
    // A controller reset clears the device registers but used to keep serving
    // blocks cached by the PREVIOUS boot, so a kernel that reads and validates
    // many blocks (2.11 BSD, Unix V5) stalled silently after a Reboot while
    // RT-11 — one block and go — never noticed. Two steps, in this order:
    //
    //   1. flushDirtyDrives() — push the guest's writes into the provider
    //      (DiskStore/IndexedDB) BEFORE anything is dropped. Skipping this, or
    //      flushing afterwards, loses writes the real hardware would have kept.
    //   2. resetAllDrives() — drop the caches so the next read comes from the
    //      image again.
    //
    // Returns a promise so the Reboot path can await it; the periodic timer
    // keeps using the bare flushDirtyDrives() above.
    function flushAndResetDisks() {
        var drives = machine.disk.drives || {};
        var pending = [];
        Object.keys(drives).forEach(function (url) {
            var d = drives[url];
            if (d && d.dirty && d.dirty.size > 0) {
                try { pending.push(machine.disk.flushDrive(url)); } catch (e) { /* keep going */ }
            }
        });
        return Promise.all(pending).then(function () {
            machine.disk.resetAllDrives();
        }, function () {
            // A failed write must still not leave the stale cache in place:
            // the next boot has to read the image, not yesterday's blocks.
            machine.disk.resetAllDrives();
        });
    }
    window.__yapdpFlushAndResetDisks = flushAndResetDisks;

    // exportDiskImage(url) -> Promise<Uint8Array|null> — assemble the CURRENT
    // image for download: the pristine base bytes (DataLoader) overlaid with
    // the guest's writes — the session cache (freshest) first, then the blocks
    // persisted in DiskStore (from an earlier session). Returns null when the
    // image is not mounted. The legacy stack had no exporter at all, so the
    // Storage "Export image" control was dead in the core mode; this is its
    // core-stack implementation.
    async function diskImageBytes(url) {
        // The base may be missing when the image is not mounted (an exportable
        // image with saved changes but no live mount): fetch it the same way
        // the disk provider would. Export is cancelled (null) when unavailable.
        var base = await loadBaseBytes(url);
        if (!base) return null;
        var BLOCK = 131072; // IO_BLOCKSIZE
        var out = base.slice();

        // 1. Session overlay — blocks in DiskService's per-drive cache.
        var drive = machine.disk.drives[url];
        var cache = drive ? drive.cache : null;
        if (cache) {
            for (var b = 0; b < cache.length; b++) {
                var block = cache[b];
                if (!block) continue;
                var off = b * BLOCK;
                if (off >= out.length) continue;
                for (var w = 0; w < block.length; w++) {
                    var o = off + w * 2;
                    if (o + 1 >= out.length) break;
                    out[o] = block[w] & 0xFF;
                    out[o + 1] = (block[w] >>> 8) & 0xFF;
                }
            }
        }

        // 2. Persisted overlay — write-back blocks saved by DiskStore.
        if (typeof DiskStore !== "undefined" && typeof DiskStore.blocksFor === "function") {
            var saved = DiskStore.blocksFor(url);
            for (var i = 0; i < saved.length; i++) {
                var bytes = await DiskStore.getBlock(url, saved[i]);
                if (!bytes) continue;
                var off2 = saved[i] * BLOCK;
                if (off2 >= out.length) continue;
                out.set(bytes.subarray(0, Math.min(bytes.length, out.length - off2)), off2);
            }
        }
        return out;
    }
    window.exportDiskImage = diskImageBytes;

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
                "partially-read": "Partially read", "consumed": "Consumed (end)"
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
        // Choosing None is the operator pulling the tape OUT; it is not a
        // rewind. The two were the same call before, which is why REWIND TAPE
        // left the reader empty ("No tape") instead of back at the first frame.
        if (name === "") { ptr.eject(); return; }
        var url = ptrUrlFor(name);
        machine.mountDrive(url, dataLoaderProvider(url));
        ptr.loadTape(url);
    }
    // REWIND TAPE: back to the first frame, the tape stays in the reader.
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
        reset: function () {
            var result = machine.bus.reset();
            // The PTR tape is NOT re-mounted here any more. It used to be,
            // because the device's reset() cleared ptControlblock and only the
            // Storage select knew which tape was loaded — so the next PTR GO
            // hit ERR and a paper-tape boot hung (BASIC-11). That is fixed at
            // the source now: reset() clears the REGISTERS only, and the tape a
            // machine reset does not eject stays where it is, position and all
            // — which is what the real PTR11 does. Re-mounting here would
            // rewind the tape to frame 0 on every Reboot, undoing the fix.
            // QuickBoot may set select.value programmatically (no change
            // event) and then boot(): that path is unaffected, because the
            // device already holds the tape the select names. When the operator
            // changes the select, the change event calls mountSelectedTape().
            // Disks: an explicit Reboot must not keep serving blocks cached
            // by the previous boot (2.11 BSD / Unix V5 read a kernel in many
            // blocks and stall silently; RT-11 never noticed). The Reboot
            // path awaits flushAndResetDisks() BEFORE calling this reset, so
            // the dirty blocks are already in the image by now; drop the
            // caches here so the next read comes from the image again. When
            // reset() is reached from anywhere else (panel reset, guest HALT
            // recovery) the flush is still safe because flushDirtyDrives()
            // only QUEUES the writes before the caches are dropped — see
            // window.__yapdpFlushAndResetDisks for the awaited variant.
            machine.disk.resetAllDrives();
            return result;
        },
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
        restoreDevices: function (state) {
            var result = machine.bus.restoreDevices(state);
            // Device state does not include the PTR tape control block, so a
            // RESTORED snapshot has no tape in the reader while the Storage
            // select may still name one. Re-apply the selected tape so the
            // next PTR GO reads it from the start instead of raising ERR —
            // this is a restore, not a reset, so a fresh mount is right here.
            if (ptrSelect) mountSelectedTape();
            return result;
        },
    };

    window.__coreMachine = machine; // diagnostics / future tools
})();
