# yaPDP Architecture

A high-level map of the codebase. The emulator runs a PDP‑11/70 in the
browser **and** headlessly (pure Node, no DOM). The CPU (`src/pdp11.js`)
executes against a machine that exists in two parallel stacks:

- **Core stack (default)** — the refactored machine layer: core base
  classes (`src/core/`) + one module per device (`src/devices/`), assembled
  by an adapter. `pdp11.html` boots into it unless `?core=0` asks for the
  legacy stack. The same machine assembles in Node via
  `tools/headless-machine.js`.
- **Legacy stack (`?core=0`)** — the monolithic `src/iopage.js`, which owns
  its own copies of every device plus the I/O plumbing, exactly as it did
  before the refactor. Kept as the reference/rollback implementation; the
  e2e parity gate runs every guest on both stacks.

Both stacks expose the same global `iopage` contract (access/poll/reset/
register/scheduleCallback/...), so `src/pdp11-app.js`, the front panel and
every other UI module are stack-agnostic.

## The machine layer (core stack)

The refactor mirrors the hardware it emulates: devices are *cards* on a
*backplane*, not solder blobs on the CPU. See the
[machine layer deep-dive](machine-layer.md) for the full design, the device
contract, the bridge and the write-back storage split.

| Directory | Purpose |
|-----------|---------|
| [`src/core/bus.js`](../src/core/bus.js) | The Unibus: `register(address, count, device)` maps device regions onto the I/O page; `access`/`poll`/`reset`/`snapshotDevices`/`restoreDevices` delegate to the registered cards |
| [`src/core/device.js`](../src/core/device.js) | Base `Device` class — regions, install, power/reset/snapshot hooks |
| [`src/core/machine.js`](../src/core/machine.js) | The chassis: owns the bus, the disk service and the device registry; `mountDrive(url, provider)` attaches byte sources |
| [`src/core/io.js`](../src/core/io.js) | I/O adapters (`BrowserIO`, `NodeIO`, `Machine.printf`) |
| [`src/devices/*.js`](../src/devices/) | One card per peripheral — 1:1 ports of the legacy iopage closures: `dl11` (console/terminals), `kw11` (clock), `rk11`, `rl11`, `rp11`, `tm11`, `uda50` (MSCP), `ptr11` (paper tape reader + punch), `lp11` (printer), `mmu-regs`, `cpu-regs`, plus the shared `disk-service.js` |
| [`src/diskstore.js`](../src/diskstore.js) | The persistent write-back overlay (IndexedDB in the browser, memory in Node) — a shared layer, not a device: `markDirty`/`flush`/`getBlock` |
| [`src/browser-machine.js`](../src/browser-machine.js) | Browser adapter — assembles core + devices, exposes the `iopage` contract, the console DL11 bridge (`__yapdpBridge`, `?bridge=1`-gated legacy surface) and the Storage-page tape/punch hooks; drives DataLoader + DiskStore providers |
| [`tools/headless-machine.js`](../tools/headless-machine.js) | Node adapter — the same machine with file-backed disk providers; boots RT‑11/Unix V5/BSD/RSTS/RSX/... in pure Node |
| [`tools/headless-term.js`](../tools/headless-term.js) | The CLI tool of record — interactive/batch console on the headless machine (`:mount`/`:export`/`:wait`/`:raw`, Ctrl+E command mode) |
| [`tools/rt11-term.js`](../tools/rt11-term.js) | **Deprecated** (legacy puppeteer) predecessor of `headless-term.js` — kept for reference |

## File map (UI and shared modules)

| File | Purpose |
|------|---------|
| [`src/pdp11.js`](../src/pdp11.js) | Core CPU emulation (PDP‑11/70 instruction set, MMU, interrupts) — clean of any DOM, shared by both stacks |
| [`src/fpp.js`](../src/fpp.js) | Floating‑Point Processor (FP11) emulation |
| [`src/iopage.js`](../src/iopage.js) | Legacy monolithic I/O page — devices + I/O plumbing inline; used only with `?core=0` |
| [`src/pdp11-panel.js`](../src/pdp11-panel.js) | Front panel rendering and switch interaction |
| [`src/pdp11-app.js`](../src/pdp11-app.js) | Application glue — boots the emulator, wires the configured teletype/VT52 console, user terminals, printer and the CONFIG page |
| [`src/config.js`](../src/config.js) | User configuration (CONFIG page) — validated, persisted in localStorage |
| [`src/hum.js`](../src/hum.js) | Ambient PDP-11 power-supply hum + fan noise — synthesized on a dedicated Web Audio context, follows power/run state |
| [`src/vt52.js`](../src/vt52.js) | DECscope VT52 terminal emulation (canvas‑based); renders nroff/man overstrike as bold/underline only in ANSI/VT100 mode — a historical VT52 draws no SGR emphasis |
| [`src/g60printer.js`](../src/g60printer.js) | Google60-style teletype printer (Model 33 ASR / LP11) |
| [`src/punchtape.js`](../src/punchtape.js) | Visual ASR paper-tape punch — punches an 8-track row per console byte, scrolls the tape window |
| [`src/vt11.js`](../src/vt11.js) | Vector graphics VT11 display |
| [`src/bootcode.js`](../src/bootcode.js) | The custom bootstrap loader program |
| [`src/dragdrop.js`](../src/dragdrop.js) | Drag & drop disk/tape image import — mounts files into DataLoader, persists them in IndexedDB |
| [`src/tauri-bundled.js`](../src/tauri-bundled.js) | Tauri desktop: loads the bundled boot images via the Rust `load_bundled_image` command |
| [`src/imgerror.js`](../src/imgerror.js) | Shared modal dialog shown when a disk/tape image fails to load (dropped connection, truncated or corrupt `.zst`) — explains the failure and links to the Storage page |
| [`src/osboot.js`](../src/osboot.js) | Guest OS boot scenarios for the quick-boot wizard — hand-curated `boot` commands and auto-login steps per device |
| [`src/quickboot.js`](../src/quickboot.js) | Quick-boot magic-wand button — floating in the top-right corner (every page except Info), OS picker dialog, reboot + typed boot/login sequence via the console input queue |
| [`src/fullscreen.js`](../src/fullscreen.js) | Floating fullscreen toggle — browser Fullscreen API in the web build, native window fullscreen in the Tauri app |
| [`src/pasteutil.js`](../src/pasteutil.js) | Shared clipboard paste helper — CR/LF normalization + 7-bit byte mapping + DL11 receive-queue routing, used by every terminal paste path |
| [`src/navactivity.js`](../src/navactivity.js) | Sidebar activity lamps — `pulse()` lights a blinking green LED in the top-right corner of the matching sidebar button while the PDP-11 writes output to a console / terminal (auto-off 0.5s after the output stops); `set()` drives the Printer lamp from the LP11 busy ticker so it blinks for the whole print job |
| [`src/panel-led.js`](../src/panel-led.js) | Panel nav-button status indicators — polls the machine power + CPU run state; the green power lamp lights while powered on, and a pause/play glyph in the button's top-left corner shows whether the CPU is halted or running (hidden while the machine is off) |
| [`css/pdp11.css`](../css/pdp11.css) | Front panel and application styles |
| [`css/landing.css`](../css/landing.css) | Landing-page (index.html) styles |
| [`css/g60printer.css`](../css/g60printer.css) | Teletype printer styles |

## Tests

| File | Purpose |
|------|---------|
| [`tests/core.test.js`](../tests/core.test.js) | Bus/device/machine core contracts — install, region access, reset, snapshots |
| [`tests/diskstore.test.js`](../tests/diskstore.test.js) | DiskStore write-back overlay (extracted from the real source) |
| [`tests/writeback.test.js`](../tests/writeback.test.js) | Headless write-back: guest writes → flush → image survives reboot |
| [`tests/headless-boot.test.js`](../tests/headless-boot.test.js) | RT‑11 boots headlessly on the core stack |
| [`tests/bsd-boot.test.js`](../tests/bsd-boot.test.js) | BSD 2.11 boots headlessly to `login:` (Unibus-map regression anchor) |
| [`tests/bsd29-boot.test.js`](../tests/bsd29-boot.test.js) | BSD 2.9 headless to a root shell |
| [`tests/tm11.test.js`](../tests/tm11.test.js) | TM11 magtape controller on the headless base |
| [`tests/e2e-osboot.js`](../tests/e2e-osboot.js) | **Stack-parity gate** — 10 guest OSes booted through the wizard path on the core stack; `E2E_LEGACY=1` runs the same matrix on `?core=0` |
| [`tests/e2e-core-bsd.js`](../tests/e2e-core-bsd.js) | BSD 2.11 boot on `?core=1` in the browser |
| [`tests/e2e-teletype.js`](../tests/e2e-teletype.js) / [`tests/e2e-teletype-tape.js`](../tests/e2e-teletype-tape.js) | Model 33 ASR keyboard/CCU and paper-tape e2e (`E2E_CORE=1` exercises the core stack) |

Run everything with `npm test` (unit + headless) and the e2e suites listed in
`package.json` (`npm run e2e:*`).

## Media files

Disk (`.dsk`), tape (`.tap`), and paper tape (`.ptap`) images live in the [`media/`](../media/) directory. Many are ZST‑compressed to stay within GitHub size limits. Disk and tape images ship as `.zst` and are fetched and decompressed in the browser via the bundled fzstd library (no raw `.dsk`/`.tap` copy is required). See [`media/README.md`](../media/README.md) for the naming convention.

## Related documentation

- [Machine layer deep-dive](machine-layer.md) — the refactored core stack: device contract, bridge, storage split, adding a device
- [Building the desktop app](BUILDING.md) — toolchain, artifacts, npm scripts
- [Feature deep-dive](FEATURES.md) — the Model 33 ASR teletype, LP11, VT52, quick boot and the UI pages in detail
- [Known issues](known-issues.md) — open emulator bugs (e.g. ULTRIX‑11 multi-user panic)
- [Example boot sessions](ExampleBoots.md) — full boot logs for every guest OS
- [User manual](../manual.html) — step-by-step guide with live screenshots
