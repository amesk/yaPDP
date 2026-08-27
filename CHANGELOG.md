# Changelog

All notable changes to **yaPDP — Yet Another PDP-11/70 web emulator** are
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Working ASR paper-tape reader.** The TAPE READER on the Model 33 ASR
  console now actually reads: **Load tape** opens a file dialog for a
  `.ptap`, `.ptap.zst` or `.txt` tape, which hangs from the reader slot down
  to the window edge (same 8-track rows and ragged free end as the punched
  tape). **START** feeds the tape at the console speed; **AUTO** sends one
  byte and then one per DL11 "input drained" signal (paused by DC3/X-OFF,
  resumed by DC1/X-ON); **STOP** and **FREE** show the **Remove tape**
  button (hidden while START or AUTO is running); loading a tape forces
  the reader to **STOP** so a fresh tape never starts feeding on its own.
  The ASR tape unit is cast from the SAME plastic as the teletype cover —
  the keyboard deck's sand gradient with the same subtle grain and inner
  top shadow, no contrasting frame (the punch/reader areas are transparent
  parts of the one body). The grain texture is shared with the printer
  face, the deck and the ASR unit, so the whole console reads as one
  moulded cabinet. The punch and reader contours are raised plastic
  plates (relief): a lighter sand tone than the body with the same grain,
  a top highlight and a drop shadow; both plates are the same width
  (144px) and the TAPE PUNCH / TAPE READER labels centre on them. The
  decorative corner screws were removed.
  The CCU routes every read byte
  exactly like the keyboard: **LOCAL** prints the tape on paper only
  (tape-to-paper copy), **LINE** sends it to the machine and the guest's
  echo prints it (a local print would double every character on echoing
  guests like BASIC); with the punch engaged every read byte is also
  punched onto the output tape — the classic ASR tape-to-tape duplication
  trick. Removing a tape from the reader is silent (no rip sound). The
  punched tape hangs one step above the reader tape (z-index), so it
  always passes in front of the reader mechanism — as on the real ASR-33.
  The tape visibly moves up and shortens as it is read, and the reader
  tape joins the machine-state snapshots (L2) alongside the punched tape.

- **Full machine-state snapshots.** The snapshot feature now captures the
  whole machine, not just the CPU: RAM, MMU and mounted images ([`d292244`](https://github.com/amesk/yaPDP/commit/d292244)); the registers of all nine I/O-page devices — KW11, DL11×3, LP11, PTR11/PTP11 (including the punch buffer), TM11, RK11, RL11, RP11, UDA50 — through clean `snapshot()`/`restore()` hooks that never read registers with hardware side effects ([`f0b866a`](https://github.com/amesk/yaPDP/commit/f0b866a)); the punched paper tape ([`d06f564`](https://github.com/amesk/yaPDP/commit/d06f564)); the LP11 printed paper ([`27a95a1`](https://github.com/amesk/yaPDP/commit/27a95a1)); the LP11 ON LINE state ([`142b2c9`](https://github.com/amesk/yaPDP/commit/142b2c9)); the VT52 terminals with their screen buffers ([`3940ebb`](https://github.com/amesk/yaPDP/commit/3940ebb)); and the VT11 vector display — registers and the CRT image itself ([`21d420f`](https://github.com/amesk/yaPDP/commit/21d420f)).
- **Machine-state dialog.** The STATE floating button opens a snapshot
  manager (save/load/rename/delete) that replaces the old snapshot section
  on the Storage page ([`0c4289b`](https://github.com/amesk/yaPDP/commit/0c4289b)). Restoring a snapshot also restores the hardware device set, with styled confirm modals ([`24d3772`](https://github.com/amesk/yaPDP/commit/24d3772)) and a styled rename dialog instead of the native `window.prompt` ([`8e42159`](https://github.com/amesk/yaPDP/commit/8e42159)).
- **Persistent disk write-back cache (DiskStore).** Guest-OS writes are
  saved to browser storage and overlaid on the base image on the next
  launch, with per-image or full reset on the Storage page ([`49f379b`](https://github.com/amesk/yaPDP/commit/49f379b)).
- **Linux desktop builds**: deb and AppImage bundle targets for the Tauri
  app ([`14c14a7`](https://github.com/amesk/yaPDP/commit/14c14a7)).
- **About block**: version marker in the navigation sidebar and an About
  section on the Info page ([`e091062`](https://github.com/amesk/yaPDP/commit/e091062)).
- **Storage page tabs** (Images / Paper Tapes): the two storage workflows
  are now separated; the Paper Tapes tab gets its own `.ptap` drop zone,
  and the full-window drop target appears only while the Storage page is
  active (previously it showed on every page, where a drop mounted the
  image with no visible feedback) ([`faae411`](https://github.com/amesk/yaPDP/commit/faae411)).
- **Quick boot button** in the welcome dialog and an **Auto-boot shortcut**
  in the power-off dialog ([`d2e8a72`](https://github.com/amesk/yaPDP/commit/d2e8a72)).
- Floating **REBOOT and STATE buttons on the VT52 console page** too
  ([`820def1`](https://github.com/amesk/yaPDP/commit/820def1)).

### Changed

- Repository moved from GitVerse to GitHub — the canonical home is now
  [`github.com/amesk/yaPDP`](https://github.com/amesk/yaPDP). The git remote,
  all landing-page links and the `repository` fields in `package.json` and
  `Cargo.toml` now point at GitHub; every commit/release URL in this changelog
  has been updated accordingly ([`2e13a61`](https://github.com/amesk/yaPDP/commit/2e13a61)).
- Snapshot UI hint updated to reflect the full L2/L3 state capture
  ([`1c3f208`](https://github.com/amesk/yaPDP/commit/1c3f208)).

### Fixed

- ASR punch **BSP** no longer erases the last byte by itself — it pulls the
  tape back one step, so the hanging tail visibly shortens as the row
  disappears into the punch unit, and the next punch overpunches the row now
  under the punch head, holes OR-ing together like a real overpunch. The
  erasure is the **DELETE / RUB OUT** key's job: it punches all holes over
  the byte, turning it into DEL — the authentic two-step ASR-33 correction
  ([`92e10c5`](https://github.com/amesk/yaPDP/commit/92e10c5)).
- ASR receive punch now records machine output too: a **NUL** from the
  machine punches a blank row with only the feed hole — the classic tape
  leader/trailer that threads the reader — and a received **DEL** punches an
  all-holes RUB OUT row, exactly like a real ASR-33 receive punch. The LOCAL
  echo no longer punches a second row for bytes the keyboard punch already
  recorded ([`1671979`](https://github.com/amesk/yaPDP/commit/1671979)).
- CONFIG|Equipment: teletype-only parameters and the LP11 printer width are
  now **disabled and dimmed** (opacity .45) instead of hidden when they do
  not apply to the current selection — the form reads as a stable list where
  greyed-out options explain their dependency, and their values survive the
  switch back ([`ea570ba`](https://github.com/amesk/yaPDP/commit/ea570ba)).
- `trap()`: runaway trap recursion on a corrupted stack (e.g. from an e2e
  test mutating PC/SP/RAM while the CPU is running) now halts the machine
  like real PDP-11 hardware instead of crashing with a `RangeError`
  ([`7d85b61`](https://github.com/amesk/yaPDP/commit/7d85b61)).
- Restoring a snapshot that changes the hardware config no longer triggers
  the browser's "Reload site?" beforeunload prompt ([`6c6d420`](https://github.com/amesk/yaPDP/commit/6c6d420)).
- Quick boot typed boot commands in lower case for the upper-case-only DEC
  guests (BASIC-11, ODT-11, ED-11, RT-11, RSTS, XXDP, RSX-11M) — a real
  ASR-33 teletype cannot produce lower case, and those systems do not
  understand it. The wizard now types `BOOT PR` / `BOOT RK1` etc.; the
  case-sensitive *nix guests (Unix V5, BSD 2.9/2.11, ULTRIX-11) keep their
  lower-case commands ([`1f999ab`](https://github.com/amesk/yaPDP/commit/1f999ab)).

### Documentation

- **Info page**: the "What makes it special" table gains an **Authentic LP11
  Line Printer** row (faithful DEC line printer — cabinet, fanfold paper,
  ON LINE / TOP OF FORM / PAPER FEED — printing at ~300 lines/min, with the
  finished job exportable to a real printer via the system dialog or as a
  `.txt`); table headers on the Info page are now left-aligned. The README
  "What makes it special" table mirrors the new row, and the landing page
  (index.html) mentions the printout export.

- README and user manual: machine-state section, the STATE button in the
  floating-controls table, refreshed screenshots ([`9fdd8bf`](https://github.com/amesk/yaPDP/commit/9fdd8bf)).
- User manual: internal cross-links between sections ([`906c274`](https://github.com/amesk/yaPDP/commit/906c274)).
- User manual: CONFIG screenshots cropped to the page's content column
  ([`43c992d`](https://github.com/amesk/yaPDP/commit/43c992d)).
- User manual and README: Storage section rewritten for the two tabs, with
  new per-tab screenshots ([`faae411`](https://github.com/amesk/yaPDP/commit/faae411)).

### Chore

- **Sidebar version marker** now reads `yaPDP v0.1.0`: the marker was
  rendering as `YAPDP` because `.sidebar-version-name` had
  `text-transform: uppercase` in the CSS. The name is displayed as written
  now. (The stylised all-caps `YAPDP` on the promo-video intro title card
  is intentional and unchanged.)
### Chore

- Demo video pipeline: teletype human-input capture, VT52 pacing, MP4
  montage and YouTube-ready exports ([`18549e7`](https://github.com/amesk/yaPDP/commit/18549e7)).

## [0.1.0-alpha2] - 2026-08-24

Changes since [v0.1.0-alpha1] (2026-08-19). 70 commits, 69 of them
non-merge — the bulk of the work went into authentic peripherals (Model 33
ASR teletype, DECscope VT52, DEC LP11 printer) and front-panel/machine
controls.

### Added

#### Peripherals — Model 33 ASR
- Redraw the console teletype as an authentic Model 33 ASR ([`d9ccd78`](https://github.com/amesk/yaPDP/commit/d9ccd78)).
- Authentic ASR-33 paper tape with punch controls ([`70ddb41`](https://github.com/amesk/yaPDP/commit/70ddb41)).
- Four-position TAPE READER switch and latching REL ([`0ceb537`](https://github.com/amesk/yaPDP/commit/0ceb537)).
- Authentic Model 33 ASR keyboard with special keys and BREAK support ([`1229e29`](https://github.com/amesk/yaPDP/commit/1229e29)).
- Rotary CCU switch replacing the LOCAL/LINE buttons ([`4e3e072`](https://github.com/amesk/yaPDP/commit/4e3e072)).
- Sticky CTRL/SHIFT latch, dual-legend keys and echo punch for dropped control codes ([`f0d51d5`](https://github.com/amesk/yaPDP/commit/f0d51d5)).
- Teletype Corporation logo on the console front panel ([`31fd8ab`](https://github.com/amesk/yaPDP/commit/31fd8ab)).

#### Peripherals — LP11 line printer
- DEC-style LP11 printer cabinet with rising paper ([`a1376c7`](https://github.com/amesk/yaPDP/commit/a1376c7)).
- LP11 cabinet hood, indicator panel and working ON LINE key ([`798c9a6`](https://github.com/amesk/yaPDP/commit/798c9a6)).
- Sidebar output-activity lamps and historical LP11 DONE/ERROR semantics ([`6af0ab3`](https://github.com/amesk/yaPDP/commit/6af0ab3)).

#### Peripherals — DECscope VT52
- Authentic VT52 cabinet: slanted beige monoblock, dark side panel, dark grey-green glass, scanline tuning and proportional window scaling ([`d21646a`](https://github.com/amesk/yaPDP/commit/d21646a)).
- Authentic fritzm/vt52 bitmap display font ([`adbf6e2`](https://github.com/amesk/yaPDP/commit/adbf6e2)).
- IRM insert mode, ESC L/M and previously missing escape sequences ([`f7a5860`](https://github.com/amesk/yaPDP/commit/f7a5860)).
- DEC 'digital' wordmark on the cabinet side panels ([`2879fe7`](https://github.com/amesk/yaPDP/commit/2879fe7)).
- VT52 text mode option and shared PasteUtil paste helper ([`98d72b2`](https://github.com/amesk/yaPDP/commit/98d72b2)).

#### Front panel & machine controls
- Machine power/auto-boot config options, power lamp on the Panel nav button and auto-boot-aware reboot ([`16a2c40`](https://github.com/amesk/yaPDP/commit/16a2c40)).
- Bootstrap sticky note with "Help Me!"/"Bootstrap now!" controls and a power-off guard ([`27c2c05`](https://github.com/amesk/yaPDP/commit/27c2c05)).
- Control OFF/POWER/LOCK by clicking position labels instead of cycling the switch ([`8186471`](https://github.com/amesk/yaPDP/commit/8186471)).
- Global reboot and quick-boot buttons; panel controls reset on reboot ([`f481344`](https://github.com/amesk/yaPDP/commit/f481344)).
- PANEL nav-button status indicators: power lamp and run-state pause/play icon ([`9c1d642`](https://github.com/amesk/yaPDP/commit/9c1d642)).
- "Power on & Bootstrap" and "Apply & Leave" dialog buttons ([`33b9958`](https://github.com/amesk/yaPDP/commit/33b9958)).

#### UI, config & misc
- Global mute button for all sounds ([`d9fe637`](https://github.com/amesk/yaPDP/commit/d9fe637)).
- CONFIG: retitle the Visual tab to "Look and sound", add a Development tab for VT52 text mode ([`fb536c3`](https://github.com/amesk/yaPDP/commit/fb536c3)).
- CONFIG Equipment: group each device with its parameters, hide inapplicable fields without layout shift ([`af06612`](https://github.com/amesk/yaPDP/commit/af06612)).
- Storage: mounted image count indicator next to Unmount ([`59959a4`](https://github.com/amesk/yaPDP/commit/59959a4)).
- Info page: animated front-panel GIF instead of the static large panel ([`01240b1`](https://github.com/amesk/yaPDP/commit/01240b1)).
- Quick Boot: always show terminal type and printer state; BSD 2.11 waits for the boot prompt ([`4ec1d6b`](https://github.com/amesk/yaPDP/commit/4ec1d6b)).
- Project Page link on the landing page hero CTA buttons ([`ebb3f71`](https://github.com/amesk/yaPDP/commit/ebb3f71)).
- Tooltips on all navigation sidebar buttons ([`99ba26d`](https://github.com/amesk/yaPDP/commit/99ba26d)).
- Click sounds for panel switches, punch buttons and teletype keys ([`ecc53f4`](https://github.com/amesk/yaPDP/commit/ecc53f4)).

### Changed

- Model 33 ASR: restyle the teletype cabinet and flat-top keycaps ([`a5d76f0`](https://github.com/amesk/yaPDP/commit/a5d76f0)).
- Model 33 ASR: polish controls and printer body styling ([`d1b74e4`](https://github.com/amesk/yaPDP/commit/d1b74e4)).
- Model 33 ASR: slim the printer and keyboard and reposition keys ([`0e8bd3c`](https://github.com/amesk/yaPDP/commit/0e8bd3c)).
- Model 33 ASR: sans-serif grotesk for keycap legends ([`665923e`](https://github.com/amesk/yaPDP/commit/665923e)).
- Model 33 ASR: stack the punch above the reader with the historical 2x2 button layout ([`dc2ceac`](https://github.com/amesk/yaPDP/commit/dc2ceac)).
- Model 33 ASR: refine punch tongue, button alignment and punch block height ([`149fc61`](https://github.com/amesk/yaPDP/commit/149fc61)).
- Model 33 ASR: align the tape unit bottom with the keyboard deck bottom ([`5c43e86`](https://github.com/amesk/yaPDP/commit/5c43e86)).
- Model 33 ASR: console paper grows to the top of the window like the LP11 printer page ([`1163675`](https://github.com/amesk/yaPDP/commit/1163675)).
- Scale the LP11 printer cabinet to fit the window like the VT52 console ([`e22f721`](https://github.com/amesk/yaPDP/commit/e22f721)).
- Move the autoloading balloon to the top of the window ([`6b76eb1`](https://github.com/amesk/yaPDP/commit/6b76eb1)).
- Center the teletype tear/save buttons on screen like the PANEL actions ([`11b7bdc`](https://github.com/amesk/yaPDP/commit/11b7bdc)).
- Config page: clarify which settings require Apply and which apply immediately ([`f4cf32e`](https://github.com/amesk/yaPDP/commit/f4cf32e)).
- Remove the DIGITAL logo from the bottom of the navigation sidebar ([`ba858c6`](https://github.com/amesk/yaPDP/commit/ba858c6)).
- Remove the external link from the 'Open the PDP-11/70 emulator' walkthrough step ([`02cc040`](https://github.com/amesk/yaPDP/commit/02cc040)).
- Order the Image load interrupted dialog buttons: "Got it" before "Open Storage" ([`f971c52`](https://github.com/amesk/yaPDP/commit/f971c52)).
- Teletype: proportionally scale the Model 33 ASR rig to fit the window; divide paper/tape max-heights by the scale and fix subpixel punchtape seams ([`d0a0d25`](https://github.com/amesk/yaPDP/commit/d0a0d25)).
- Panel: proportionally scale the front panel with the Help Me! sticker to fit narrow windows ([`cbd80e5`](https://github.com/amesk/yaPDP/commit/cbd80e5)).

### Fixed

- VT52 bell (BEL): let 0x07 reach the terminal and always ring/flash ([`08cc77e`](https://github.com/amesk/yaPDP/commit/08cc77e)).
- VT52: do not render bold/underline attributes in VT52 mode ([`6e98ae5`](https://github.com/amesk/yaPDP/commit/6e98ae5)).
- VT52: restore the authentic 4:3 aspect ratio on the tube ([`ae0c294`](https://github.com/amesk/yaPDP/commit/ae0c294)).
- VT52 cabinet side panel overflowing the case on Windows 10 ([`334940c`](https://github.com/amesk/yaPDP/commit/334940c)).
- Tear sound plays only when paper/tape is actually torn off ([`72d914b`](https://github.com/amesk/yaPDP/commit/72d914b)).
- Restore the cycling POWER LOCK key click alongside the position labels ([`8f20c55`](https://github.com/amesk/yaPDP/commit/8f20c55)).
- POWER LOCK: clicking the LOCK label keeps the key pointing at LOCK instead of leaving it on POWER (ON) — the front-panel switches are now properly disabled while the panel is locked.
- LP11 whirr sound no longer aborted by a play/pause race in the renderer ([`60bbc70`](https://github.com/amesk/yaPDP/commit/60bbc70)).
- REBOOT description: the default loader boots only when Auto-boot is enabled ([`92b1bf3`](https://github.com/amesk/yaPDP/commit/92b1bf3)).

### Documentation

- User manual page linked from the landing page ([`8bca590`](https://github.com/amesk/yaPDP/commit/8bca590)).
- Screenshot generator; user manual illustrated with emulator screenshots ([`f4ce4a5`](https://github.com/amesk/yaPDP/commit/f4ce4a5)).
- Per-tab config, dialog and Lunar Lander illustrations for the user manual ([`3812fa4`](https://github.com/amesk/yaPDP/commit/3812fa4)).
- Remove the ExampleBoots link and add author contact on the instructions page ([`16b08c1`](https://github.com/amesk/yaPDP/commit/16b08c1)).
- README: toolchain installation section for the desktop build ([`a47159b`](https://github.com/amesk/yaPDP/commit/a47159b)).
- Document every Config page option in the user manual ([`3524994`](https://github.com/amesk/yaPDP/commit/3524994)).
- Guest-OS screenshot generator and landing-page OS carousel ([`553058e`](https://github.com/amesk/yaPDP/commit/553058e)).
- XXDP+ diagnostics screenshot added to the guest-OS carousel ([`7ea4706`](https://github.com/amesk/yaPDP/commit/7ea4706)).
- Document the fast teletype speed used for guest-OS screenshots ([`af0d6f9`](https://github.com/amesk/yaPDP/commit/af0d6f9)).
- Fix onboarding screenshot capture in the manual generator ([`0f568a2`](https://github.com/amesk/yaPDP/commit/0f568a2)).
- Regenerate user-manual screenshots ([`460137e`](https://github.com/amesk/yaPDP/commit/460137e)).
- Regenerate landing-page carousel screenshots ([`dfcb1cd`](https://github.com/amesk/yaPDP/commit/dfcb1cd)).

### Chore

- Remove OS/editor junk entries from `.gitignore` ([`ba26696`](https://github.com/amesk/yaPDP/commit/ba26696)).

## [0.1.0-alpha1] - 2026-08-19

Initial public alpha release.

[0.1.0-alpha2]: https://github.com/amesk/yaPDP/compare/releases/v0.1.0-alpha1...v0.1.0-alpha2
[0.1.0-alpha1]: https://github.com/amesk/yaPDP/releases/tag/releases/v0.1.0-alpha1
