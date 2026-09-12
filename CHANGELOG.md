# Changelog

All notable changes to **yaPDP — Yet Another PDP-11/70 web emulator** are
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-10

## [Unreleased]

### Added

- Demo-reel narration: the intro, each clip's title card and the outro are
  spoken (Kokoro-82M locally by default, Windows SAPI as fallback); narration
  is cached, cards stretch to fit the speech, and music ducks under it.
  (`tools/voicer.js`, `tools/assemble-video.js`, `tools/reel-voice-util.js`)
- Timed reel events recorded with each clip — chapters, banner titles, spoken
  phrases, bottom subtitles — turned into narration, burned overlays and
  `.chapters.txt`/`.srt` sidecars. (`tools/record-video.js`,
  `tools/assemble-video.js`, `tools/reel-timeline-util.js`)
- Server-side promo-video build (`build-promo-videos` workflow): records every
  guest-OS clip and assembles the reel + per-clip MP4s on CI, uploaded as an
  artifact. (`​.github/workflows/videos.yml`)
- Cross-platform drawtext fonts (`tools/reel-font-util.js`): repo-committed
  faces on Linux/macOS instead of Windows-only Consolas/Arial.
- `bootHeadless` readiness by console silence (`stableMs`), for booting an
  unknown guest image without a known prompt. (`tools/headless-machine.js`)

### Removed

- The browser (Web Speech / DirectShow loopback) voice engine — narration is
  Kokoro-82M or Windows SAPI only. (`tools/voicer.js`)

### Fixed

- Desktop builds: bundled images are mounted in parallel and consumers wait
  for the bundle, so images that used to load last (Lunar Lander's paper tape,
  the ra*/rp* disks) are no longer read empty at guest start.
  (`src/tauri-bundled.js`, `src/browser-machine.js`)
- Promo-video CI runs end to end; the verify step no longer reports the
  (present) audio as missing. (`​.github/workflows/videos.yml`,
  `tools/assemble-video.js`)
- Lunar Lander no longer hangs in `?core=1` mode; the loader accepts a raw
  `.ptap` when no `.zst` exists; headless-term keeps guest output on timeout,
  resolves `:export` from the CWD and reports `:status` truthfully after a
  rewind. (`src/browser-machine.js`, `tools/headless-term.js`)
- Manual screenshots are written to both the source and the landing mirror and
  regenerated. (`tools/screenshots-manual.js`)

## [0.1.0] - 2026-09-04

### Added

- **Machine layer rebuilt as cards on a bus.** The PDP-11/70 machine is split
  into core base classes (`src/core/`) and one module per peripheral
  (`src/devices/`: DL11, KW11, RK11, RL11, RP11, TM11, UDA50, PTR11/PTP11,
  LP11, MMU, CPU). The core stack boots by default; the legacy monolith stays
  behind `?core=0` as reference/rollback. (`src/core/`, `src/devices/`)
- **Headless machine.** The same cards assemble in pure Node — RT-11 boots to
  its prompt in ~1.6 s with no browser. (`tools/headless-machine.js`,
  `tools/headless-term.js`)
- **Full machine-state snapshots and the STATE dialog.** Save/restore covers
  CPU, RAM, MMU, mounted images, all nine I/O-page device register sets, the
  punched tape, the printed paper, the VT52 buffers and the VT11 CRT image;
  restoring also re-creates the hardware set. (`src/`, STATE dialog)
- **Working ASR paper-tape reader.** Load a `.ptap`/`.ptap.zst`/`.txt` tape,
  START / AUTO / STOP / FREE, CCU routing (LOCAL / LINE) and tape-to-tape
  duplication; the tape joins the machine-state snapshots. (`src/reader.js`,
  `src/pdp11-app.js`)
- **Persistent disk write-back cache (DiskStore).** Guest writes survive
  reloads and overlay the base image, with per-image or full reset.
- **Guests ship only when bootable.** A build manifest (`media/manifest.json`,
  generated from `media/`) drives an availability-aware quick-boot picker and
  the Info page guest table, so a Minimal build never advertises an OS it
  cannot start. (`tools/gen-media-manifest.js`, `src/pdp11-app.js`)
- **Paper-tape NUL lead-in/trailer** on a fresh tape, byte-exact in the saved
  `.ptap`. (`src/punchtape.js`)
- **Linux desktop builds** (deb, AppImage) and an **About block** with the
  version marker. (`src-tauri/`)
- **Storage page tabs** (Images / Paper Tapes) and a Quick-boot button in the
  welcome dialog, plus an Auto-boot shortcut in the power-off dialog.
- **Cross-platform test gates:** `tests/e2e-osboot.js` boots ten guest OSes on
  the core stack, `E2E_LEGACY=1` repeats the matrix on `?core=0`.
- **Docs:** `docs/machine-layer.md`, updated ARCHITECTURE, `docs/ROADMAP.md`.

### Changed

- Repository moved to GitHub — `github.com/amesk/yaPDP` is now the canonical
  home (remotes, landing links, `package.json`/`Cargo.toml`).

### Fixed

- **UDA50 debug guard** — an unguarded `process.env.DEBUG_UDA` crashed the
  browser CPU loop when RSTS/E 9.6/10.1 autoconfigured the controller.
- **Paper-tape re-mount after reset** — BASIC-11 boots on the core stack again.
- **RSTS/RSX quick-boot scenarios** corrected (`Option:` answers, autostart).
- **Operator chrome readable** — one shared action-button recipe, readable
  status labels, printer buttons no longer dimmed by the cabinet shadow, and
  a single typeface per machine (teletype, LP11, VT52, front panel).
- **Mute silences the LP11 whirr immediately**; **Restore defaults** really
  resets the live behaviour options; manual screenshots regenerated.
- **Demo video pipeline:** teletype human-input capture, VT52 pacing, sharper
  native-resolution capture (1280×800@30), MP4 montage and YouTube-ready
  exports with labelled title cards.

## [0.1.0-alpha2] - 2026-08-24

Changes since [v0.1.0-alpha1] (2026-08-19).

### Added

- **Authentic Model 33 ASR console** — redrawn cabinet, flat-top keycaps,
  paper-tape punch and a four-position TAPE READER switch, full keyboard with
  special keys, sticky CTRL/SHIFT latch and BREAK support, a rotary CCU switch
  in place of the LOCAL/LINE buttons, and the Teletype Corporation logo.
- **DEC LP11 line printer** — DEC-style cabinet with rising paper, hood,
  indicator panel, a working ON LINE key and sidebar DONE/ERROR activity lamps.
- **DECscope VT52** — slanted beige cabinet with dark green glass and scanline
  tuning, the authentic vt52 bitmap display font, IRM insert mode and the
  missing escape sequences, the DEC wordmark on the side panels, and a text
  mode option.
- **Front panel & machine controls** — power/auto-boot options with a panel
  power lamp, the bootstrap "Help Me!"/"Bootstrap now!" note with a power-off
  guard, OFF/POWER/LOCK by clicking the position labels, global reboot and
  quick-boot buttons, and PANEL status indicators (power, run/pause).
- **UI** — global mute, CONFIG tabs ("Look and sound", Development) with
  devices grouped by parameters, a mounted-image counter, the animated
  front-panel GIF on the Info page, Quick Boot showing terminal/printer state,
  sidebar tooltips and click sounds for switches, punch buttons and keys.
- **User manual** — illustrated with emulator screenshots (per-tab config,
  dialogs, Lunar Lander) and linked from the landing page.

### Changed

- **The whole machine scales to the window** — the Model 33 ASR rig, the LP11
  cabinet and the front panel with its Help Me! sticker all fit narrow screens
  proportionally.
- Landing page: Project Page CTA and the DIGITAL logo removed from the sidebar.

### Fixed

- VT52 bell reaches the terminal and rings/flashes; bold/underline are not
  rendered in VT52 mode; the tube keeps its 4:3 ratio; the cabinet side panel
  no longer overflows on Windows 10.
- Model 33 ASR: authentic two-step tape correction (BSP pulls the tape back,
  DELETE/RUB OUT overpunches the byte) and the receive punch records machine
  output (NUL leader, DEL rub-out).
- POWER LOCK keeps its click and stays on the selected position; the tear
  sound plays only when paper is actually torn; the LP11 whirr is no longer
  cut short by a play/pause race.

Initial public alpha release.

[0.1.0]: https://github.com/amesk/yaPDP/compare/v0.1.0-alpha2...releases/v0.1.0
[0.2.0]: https://github.com/amesk/yaPDP/compare/releases/v0.1.0...releases/v0.2.0
[Unreleased]: https://github.com/amesk/yaPDP/compare/releases/v0.2.0...HEAD
[0.1.0-alpha2]: https://github.com/amesk/yaPDP/compare/releases/v0.1.0-alpha1...v0.1.0-alpha2
[0.1.0-alpha1]: https://github.com/amesk/yaPDP/releases/tag/releases/v0.1.0-alpha1
