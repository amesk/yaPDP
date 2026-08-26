## Unreleased — changes since v0.1.0-alpha2

The next release is still in the works; these notes are kept up to date as
the project develops. The highlights since alpha2:

- **Full machine-state snapshots (L2/L3).** Save/restore now captures the
  whole machine: CPU, RAM, MMU, mounted images, the registers of all nine
  I/O-page devices (including the punch buffer), the punched paper tape,
  the LP11 printed paper and ON LINE state, the VT52 terminals and the VT11
  vector display with its CRT image. Restoring also re-creates the hardware
  device set.
- **Machine-state dialog.** The STATE floating button opens a snapshot
  manager (save/load/rename/delete) with styled dialogs, replacing the old
  snapshot section on the Storage page.
- **Persistent disk write-back cache (DiskStore).** Guest-OS writes survive
  reloads and are overlaid on the base image, with per-image or full reset.
- **Linux desktop builds**: new deb and AppImage bundle targets.
- **Storage page tabs.** Images and Paper Tapes now live in separate tabs;
  the Paper Tapes tab has its own `.ptap` drop zone, and the full-window
  drop target appears only on the Storage page.
- **About block**: version marker in the sidebar and an About section on
  the Info page.
- **Smaller UX wins**: Quick boot button in the welcome dialog, Auto-boot
  shortcut in the power-off dialog, floating REBOOT/STATE buttons on the
  VT52 console page.
- **Fixes**: `trap()` halts on runaway recursion instead of crashing,
  config-changing restores no longer trigger the browser's "Reload site?"
  prompt, and the quick boot types `BOOT PR` / `BOOT RK1` in the historical
  upper case for the upper-case-only DEC guests (the *nix family keeps its
  lower-case commands).
- **Docs**: user manual cross-links, cropped CONFIG screenshots, rewritten
  Storage section with per-tab screenshots.

---

# yaPDP v0.1.0-alpha2 — Release Notes

- **Release date:** 2026-08-24
- **Baseline:** [v0.1.0-alpha1](https://github.com/amesk/yaPDP/releases/tag/releases/v0.1.0-alpha1) (2026-08-19)
- **Full diff:** [releases/v0.1.0-alpha1...v0.1.0-alpha2](https://github.com/amesk/yaPDP/compare/releases/v0.1.0-alpha1...v0.1.0-alpha2)

**yaPDP — Yet Another PDP-11/70 web emulator** with an authentic front panel,
a Model 33 ASR teletype, DECscope VT52 terminals and a DEC LP11 line printer.
This alpha focuses on making the peripherals look and behave like the real
DEC hardware.

## Repository

The yaPDP project has moved to GitHub:
[`github.com/amesk/yaPDP`](https://github.com/amesk/yaPDP).

## Highlights

- The console teletype is now an **authentic Model 33 ASR**: redrawn cabinet,
  flat-top keycaps, paper tape punch/reader, rotary CCU switch, sticky
  CTRL/SHIFT latch and BREAK support.
- The **DEC LP11 line printer** gets a full DEC-style cabinet with a rising
  paper page, a hood, an indicator panel and a working ON LINE key.
- The **DECscope VT52** gets a faithful cabinet (slanted beige monoblock,
  dark grey-green glass, scanline tuning), the authentic fritzm/vt52 bitmap
  font and the missing escape sequences (IRM insert mode, ESC L/M).
- The **front panel** is now controllable by clicking the OFF/POWER/LOCK
  position labels, and a bootstrap sticky note adds "Help Me!"/"Bootstrap
  now!" assistance with a power-off guard.
- The Model 33 ASR and the front panel **scale proportionally** to fit the
  window, so the machine stays usable on narrow screens.
- New **click sounds** for panel switches, punch buttons and teletype keys.
- Every navigation sidebar button gets a **tooltip**, and the PANEL button
  shows live machine state (power lamp and a pause/play run indicator).

## What's New

### Model 33 ASR console
- Authentic redraw of the console teletype and cabinet.
- Real ASR-33 paper tape with punch controls, four-position TAPE READER
  switch and latching REL.
- Full keyboard with special keys, BREAK support, sticky CTRL/SHIFT latch,
  dual-legend keys and echo punch for dropped control codes.
- Rotary CCU switch (replaces the LOCAL/LINE buttons) and the Teletype
  Corporation logo on the front panel.

### DEC LP11 printer
- DEC-style cabinet with rising paper that grows to the top of the window.
- Hood, indicator panel and a working ON LINE key.
- Sidebar output-activity lamps with historical DONE/ERROR semantics.

### DECscope VT52
- Authentic cabinet with proportional window scaling and scanline tuning.
- Real fritzm/vt52 bitmap display font and the DEC 'digital' wordmark.
- IRM insert mode, ESC L/M and other previously missing escape sequences.
- New VT52 text mode option (with the shared PasteUtil paste helper).

### Front panel & machine
- Machine power/auto-boot configuration options and a power lamp on the
  Panel nav button.
- Bootstrap sticky note with "Help Me!"/"Bootstrap now!" controls and a
  power-off guard.
- Click OFF/POWER/LOCK position labels to control the switch.
- Global reboot and quick-boot buttons; panel controls reset on reboot.
- New "Power on & Bootstrap" and "Apply & Leave" dialog buttons.
- PANEL nav button shows live status indicators: a power lamp and a
  pause/play icon reflecting the machine run state.

### Scale & layout
- The Model 33 ASR rig scales proportionally to fit the window; paper and
  tape max-heights are divided by the scale and subpixel punchtape seams
  are fixed.
- The front panel (with the Help Me! sticker) scales proportionally to fit
  narrow windows.

### UI & configuration
- Global mute button for all sounds.
- Click sounds for panel switches, punch buttons and teletype keys.
- Tooltips for every navigation sidebar button.
- CONFIG: "Look and sound" and new "Development" tabs; Equipment devices
  grouped with their parameters (no layout shift for inapplicable fields).
- Storage: mounted image count indicator next to Unmount.
- Quick Boot now always shows the terminal type and printer state; BSD 2.11
  waits for the boot prompt.
- Info page uses the animated front-panel GIF.

## Improvements & Polish

- Model 33 ASR: cabinet restyle, flat-top keycaps, slimmer printer/keyboard,
  sans-serif grotesk keycap legends, punch-above-reader 2x2 layout and
  finer punch geometry.
- LP11 cabinet scaled to fit the window like the VT52 console.
- Autoloading balloon moved to the top of the window; teletype tear/save
  buttons centered on screen.
- Config page clarifies which settings require Apply and which take effect
  immediately.
- Landing page: Project Page CTA link; DIGITAL logo removed from the sidebar.
- Image load interrupted dialog: the "Got it" button now comes before
  "Open Storage".

## Bug Fixes

- VT52 bell (BEL) now reaches the terminal and always rings/flashes.
- VT52 no longer renders bold/underline attributes in VT52 mode.
- Authentic 4:3 aspect ratio restored on the VT52 tube.
- VT52 cabinet side panel no longer overflows on Windows 10.
- Tear sound only plays when paper/tape is actually torn off.
- POWER LOCK key click restored alongside the position labels.
- POWER LOCK key stays pointing at the selected LOCK position.
- LP11 whirr sound is no longer aborted by a play/pause race in the
  renderer.
- REBOOT description fixed: the default loader boots only when Auto-boot is
  enabled.

## Documentation

- New user manual page linked from the landing page, illustrated with
  emulator screenshots (config tabs, dialogs, Lunar Lander boot).
- Every Config page option documented in the user manual.
- Guest-OS screenshot generator and a landing-page OS carousel, including a
  new XXDP+ diagnostics screenshot.
- Instructions page cleanup (author contact added).
- README toolchain installation section for the desktop build.

## Installation & Usage

Follow the standard workflow from the repository root:

```sh
npm install
npm test          # run the test suite
npm run serve     # run the web emulator locally
npm run stage     # stage the frontend for the desktop build
npm run desktop:full   # build the full Tauri desktop app
```

## Feedback

This is an alpha release — expect rough edges. Report issues and suggestions
via the [yaPDP repository](https://github.com/amesk/yaPDP).
