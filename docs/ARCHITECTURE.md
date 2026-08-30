# yaPDP Architecture

A high-level map of the codebase. The emulator is a single-page JavaScript
application: the CPU (`src/pdp11.js`) executes against an I/O page
(`src/iopage.js`) that owns the peripherals; `src/pdp11-app.js` glues the
machine to the UI (front panel, consoles, terminals, printer) and honours the
user configuration (`src/config.js`). Guest OS boot sequences are driven by
`src/osboot.js` + `src/quickboot.js`.

## File map

| File | Purpose |
|------|---------|
| [`src/pdp11.js`](../src/pdp11.js) | Core CPU emulation (PDP‑11/70 instruction set, MMU, interrupts) |
| [`src/fpp.js`](../src/fpp.js) | Floating‑Point Processor (FP11) emulation |
| [`src/iopage.js`](../src/iopage.js) | I/O page — disk controllers, terminal interfaces, paper tape reader, line printer |
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
| [`tests/config.test.js`](../tests/config.test.js) | Config validation/persistence modular tests — run with `node tests/config.test.js` |
| [`tests/pasteutil.test.js`](../tests/pasteutil.test.js) | PasteUtil clipboard normalization/routing modular tests — run with `node tests/pasteutil.test.js` |
| [`tests/dataloader.test.js`](../tests/dataloader.test.js) | DataLoader/`fetchBlock` modular tests — run with `node tests/dataloader.test.js` |
| [`tests/vt52.test.js`](../tests/vt52.test.js) | VT52 terminal modular tests (overstrike/SGR bold/underline — VT52 mode must not draw them, ANSI mode still does; ESC L/M, IRM insert mode, DECSC/DECRC, DECAWM, CPR, DECCKM, DECANM, BEL) — run with `node tests/vt52.test.js` |
| [`tests/g60printer-flush.test.js`](../tests/g60printer-flush.test.js) | G60Printer `flushCharBuffer()` backlog-flush modular tests — run with `node tests/g60printer-flush.test.js` |
| [`tests/lp11-scaling.test.js`](../tests/lp11-scaling.test.js) | LP11 printer-cabinet `lp11FitScale()` proportional-scaling modular tests — run with `node tests/lp11-scaling.test.js` |
| [`tests/teletype-paper-css.test.js`](../tests/teletype-paper-css.test.js) | Model 33 ASR console paper CSS contract tests (paper anchored to the carriage, growing upward to `--tty-paper-max`, its own scrollbar, top spacer/overlays hidden — guarding against a regression back to the fixed 400px sheet) — run with `node tests/teletype-paper-css.test.js` |
| [`tests/teletype-paper-growth.test.js`](../tests/teletype-paper-growth.test.js) | Model 33 ASR console paper `teletypePaperMaxHeight()` helper modular tests — run with `node tests/teletype-paper-growth.test.js` |
| [`tests/teletype-cabinet-css.test.js`](../tests/teletype-cabinet-css.test.js) | Model 33 ASR cabinet + keycaps CSS contract tests (sand-beige `#d1b48c` body/deck/ASR cabinet, flat-top cylindrical keycaps with a solid `0 4px 0 #241f1a` side wall collapsing on `translateY(4px)` press) — run with `node tests/teletype-cabinet-css.test.js` |
| [`tests/model33-keyboard.test.js`](../tests/model33-keyboard.test.js) | Model 33 ASR keyboard `model33KeyCode()`/`model33UpperOnly()` helper modular tests (base/SHIFT/CTRL codes, special-key tokens, Upper Case Only normalisation) — run with `node tests/model33-keyboard.test.js` |
| [`tests/vt52-cabinet-css.test.js`](../tests/vt52-cabinet-css.test.js) | VT52 cabinet CSS sizing contract tests (case must keep CRT + dark side panel inside — absolute side panel with width reserved in the bezel padding, guarding the Windows 10 WebView2 flexbox `max-content` overflow regression) — run with `node tests/vt52-cabinet-css.test.js` |
| [`tests/dl11-recv.test.js`](../tests/dl11-recv.test.js) | DL11 console receive-path modular tests (^C delivery, RBUF/DONE, vector 60 interrupt) — run with `node tests/dl11-recv.test.js` |
| [`tests/vt11.test.js`](../tests/vt11.test.js) | VT11 display register/gating modular tests — run with `node tests/vt11.test.js` |
| [`tests/fullscreen.test.js`](../tests/fullscreen.test.js) | Fullscreen toggle runtime-detection modular tests — run with `node tests/fullscreen.test.js` |
| [`tests/hum.test.js`](../tests/hum.test.js) | Machine-hum state-to-gain mapping modular tests — run with `node tests/hum.test.js` |
| [`tests/imgerror.test.js`](../tests/imgerror.test.js) | ImageError `messageFor()` modular tests (network/truncated/decompress wording) — run with `node tests/imgerror.test.js` |
| [`tests/osboot.test.js`](../tests/osboot.test.js) | OSBoot scenarios + QuickBoot pure-helper modular tests (bytes, console page, step delay, mounted filter) — run with `node tests/osboot.test.js` |
| [`tests/navactivity.test.js`](../tests/navactivity.test.js) | NavActivity `pulse()`/page-mapping modular tests (`pageForConsole`/`pageForTerminal`, lamp on/off timing, re-arm on continuous output) — run with `node tests/navactivity.test.js` |
| [`tests/nav-led-css.test.js`](../tests/nav-led-css.test.js) | Sidebar activity-lamp CSS/HTML contract tests (`.nav-led` in every output button, `position:relative` anchor, blinking `nav-led-blink` keyframe, `navactivity.js` loaded before `iopage.js`) — run with `node tests/nav-led-css.test.js` |
| [`tests/nav-tooltip.test.js`](../tests/nav-tooltip.test.js) | Sidebar navigation-button tooltip HTML contract tests (every `.nav-btn` carries a non-empty `title`; Panel explains its power-lamp + run/halt glyph split across lines; console/user-terminal/printer buttons explain the blinking activity lamp) — run with `node tests/nav-tooltip.test.js` |
| [`tests/panel-led.test.js`](../tests/panel-led.test.js) | Panel nav-button status modular tests (`ledState()`/`runIcon()` mapping, `update()` applying `.power-on`/`.off`/`.run`, idempotent `start()`) — run with `node tests/panel-led.test.js` |
| [`css/pdp11.css`](../css/pdp11.css) | Front panel and application styles |
| [`css/g60printer.css`](../css/g60printer.css) | Teletype printer styles |
| [`tools/build-desktop.js`](../tools/build-desktop.js) | Stages the lightweight Tauri frontend into `desktop/`; `--variant minimal\|full` selects which bundled media images to ship |
| [`tools/serve.js`](../tools/serve.js) | Minimal static file server for the browser emulator (port 1170, HTTP Range support) |
| [`package.json`](../package.json) | npm build scripts — `test`, `stage`, `desktop`/`desktop:minimal`/`desktop:full`, `serve`, `clean` |
| [`src-tauri/`](../src-tauri/) | Tauri v2 desktop shell — Rust commands, `tauri.conf.minimal.json` / `tauri.conf.full.json`, bundled resources, app icons |
| [`assets/vendor/fzstd.js`](../assets/vendor/fzstd.js) | Bundled fzstd (ZSTD decompression) — served locally instead of an external CDN so disk/tape images decompress reliably on any network |

## Media files

Disk (`.dsk`), tape (`.tap`), and paper tape (`.ptap`) images live in the [`media/`](../media/) directory. Many are ZST‑compressed to stay within GitHub size limits. Disk and tape images ship as `.zst` and are fetched and decompressed in the browser via the bundled fzstd library (no raw `.dsk`/`.tap` copy is required). See [`media/README.md`](../media/README.md) for the naming convention.

## Related documentation

- [Building the desktop app](BUILDING.md) — toolchain, artifacts, npm scripts
- [Feature deep-dive](FEATURES.md) — the Model 33 ASR teletype, LP11, VT52, quick boot and the UI pages in detail
- [Example boot sessions](ExampleBoots.md) — full boot logs for every guest OS
- [User manual](../manual.html) — step-by-step guide with live screenshots
