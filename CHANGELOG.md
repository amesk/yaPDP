# Changelog

All notable changes to **yaPDP — Yet Another PDP-11/70 web emulator** are
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-alpha2] - 2026-08-24

Changes since [v0.1.0-alpha1] (2026-08-19). 53 commits, 52 of them
non-merge — the bulk of the work went into authentic peripherals (Model 33
ASR teletype, DECscope VT52, DEC LP11 printer) and front-panel/machine
controls.

### Added

#### Peripherals — Model 33 ASR
- Redraw the console teletype as an authentic Model 33 ASR ([`d9ccd78`](https://gitverse.ru/amesk/yaPDP/commit/d9ccd78)).
- Authentic ASR-33 paper tape with punch controls ([`70ddb41`](https://gitverse.ru/amesk/yaPDP/commit/70ddb41)).
- Four-position TAPE READER switch and latching REL ([`0ceb537`](https://gitverse.ru/amesk/yaPDP/commit/0ceb537)).
- Authentic Model 33 ASR keyboard with special keys and BREAK support ([`1229e29`](https://gitverse.ru/amesk/yaPDP/commit/1229e29)).
- Rotary CCU switch replacing the LOCAL/LINE buttons ([`4e3e072`](https://gitverse.ru/amesk/yaPDP/commit/4e3e072)).
- Sticky CTRL/SHIFT latch, dual-legend keys and echo punch for dropped control codes ([`f0d51d5`](https://gitverse.ru/amesk/yaPDP/commit/f0d51d5)).
- Teletype Corporation logo on the console front panel ([`31fd8ab`](https://gitverse.ru/amesk/yaPDP/commit/31fd8ab)).

#### Peripherals — LP11 line printer
- DEC-style LP11 printer cabinet with rising paper ([`a1376c7`](https://gitverse.ru/amesk/yaPDP/commit/a1376c7)).
- LP11 cabinet hood, indicator panel and working ON LINE key ([`798c9a6`](https://gitverse.ru/amesk/yaPDP/commit/798c9a6)).
- Sidebar output-activity lamps and historical LP11 DONE/ERROR semantics ([`6af0ab3`](https://gitverse.ru/amesk/yaPDP/commit/6af0ab3)).

#### Peripherals — DECscope VT52
- Authentic VT52 cabinet: slanted beige monoblock, dark side panel, dark grey-green glass, scanline tuning and proportional window scaling ([`d21646a`](https://gitverse.ru/amesk/yaPDP/commit/d21646a)).
- Authentic fritzm/vt52 bitmap display font ([`adbf6e2`](https://gitverse.ru/amesk/yaPDP/commit/adbf6e2)).
- IRM insert mode, ESC L/M and previously missing escape sequences ([`f7a5860`](https://gitverse.ru/amesk/yaPDP/commit/f7a5860)).
- DEC 'digital' wordmark on the cabinet side panels ([`2879fe7`](https://gitverse.ru/amesk/yaPDP/commit/2879fe7)).
- VT52 text mode option and shared PasteUtil paste helper ([`98d72b2`](https://gitverse.ru/amesk/yaPDP/commit/98d72b2)).

#### Front panel & machine controls
- Machine power/auto-boot config options, power lamp on the Panel nav button and auto-boot-aware reboot ([`16a2c40`](https://gitverse.ru/amesk/yaPDP/commit/16a2c40)).
- Bootstrap sticky note with "Help Me!"/"Bootstrap now!" controls and a power-off guard ([`27c2c05`](https://gitverse.ru/amesk/yaPDP/commit/27c2c05)).
- Control OFF/POWER/LOCK by clicking position labels instead of cycling the switch ([`8186471`](https://gitverse.ru/amesk/yaPDP/commit/8186471)).
- Global reboot and quick-boot buttons; panel controls reset on reboot ([`f481344`](https://gitverse.ru/amesk/yaPDP/commit/f481344)).

#### UI, config & misc
- Global mute button for all sounds ([`d9fe637`](https://gitverse.ru/amesk/yaPDP/commit/d9fe637)).
- CONFIG: retitle the Visual tab to "Look and sound", add a Development tab for VT52 text mode ([`fb536c3`](https://gitverse.ru/amesk/yaPDP/commit/fb536c3)).
- CONFIG Equipment: group each device with its parameters, hide inapplicable fields without layout shift ([`af06612`](https://gitverse.ru/amesk/yaPDP/commit/af06612)).
- Storage: mounted image count indicator next to Unmount ([`59959a4`](https://gitverse.ru/amesk/yaPDP/commit/59959a4)).
- Info page: animated front-panel GIF instead of the static large panel ([`01240b1`](https://gitverse.ru/amesk/yaPDP/commit/01240b1)).
- Quick Boot: always show terminal type and printer state; BSD 2.11 waits for the boot prompt ([`4ec1d6b`](https://gitverse.ru/amesk/yaPDP/commit/4ec1d6b)).
- Project Page link on the landing page hero CTA buttons ([`ebb3f71`](https://gitverse.ru/amesk/yaPDP/commit/ebb3f71)).

### Changed

- Model 33 ASR: restyle the teletype cabinet and flat-top keycaps ([`a5d76f0`](https://gitverse.ru/amesk/yaPDP/commit/a5d76f0)).
- Model 33 ASR: polish controls and printer body styling ([`d1b74e4`](https://gitverse.ru/amesk/yaPDP/commit/d1b74e4)).
- Model 33 ASR: slim the printer and keyboard and reposition keys ([`0e8bd3c`](https://gitverse.ru/amesk/yaPDP/commit/0e8bd3c)).
- Model 33 ASR: sans-serif grotesk for keycap legends ([`665923e`](https://gitverse.ru/amesk/yaPDP/commit/665923e)).
- Model 33 ASR: stack the punch above the reader with the historical 2x2 button layout ([`dc2ceac`](https://gitverse.ru/amesk/yaPDP/commit/dc2ceac)).
- Model 33 ASR: refine punch tongue, button alignment and punch block height ([`149fc61`](https://gitverse.ru/amesk/yaPDP/commit/149fc61)).
- Model 33 ASR: align the tape unit bottom with the keyboard deck bottom ([`5c43e86`](https://gitverse.ru/amesk/yaPDP/commit/5c43e86)).
- Model 33 ASR: console paper grows to the top of the window like the LP11 printer page ([`1163675`](https://gitverse.ru/amesk/yaPDP/commit/1163675)).
- Scale the LP11 printer cabinet to fit the window like the VT52 console ([`e22f721`](https://gitverse.ru/amesk/yaPDP/commit/e22f721)).
- Move the autoloading balloon to the top of the window ([`6b76eb1`](https://gitverse.ru/amesk/yaPDP/commit/6b76eb1)).
- Center the teletype tear/save buttons on screen like the PANEL actions ([`11b7bdc`](https://gitverse.ru/amesk/yaPDP/commit/11b7bdc)).
- Config page: clarify which settings require Apply and which apply immediately ([`f4cf32e`](https://gitverse.ru/amesk/yaPDP/commit/f4cf32e)).
- Remove the DIGITAL logo from the bottom of the navigation sidebar ([`ba858c6`](https://gitverse.ru/amesk/yaPDP/commit/ba858c6)).
- Remove the external link from the 'Open the PDP-11/70 emulator' walkthrough step ([`02cc040`](https://gitverse.ru/amesk/yaPDP/commit/02cc040)).

### Fixed

- VT52 bell (BEL): let 0x07 reach the terminal and always ring/flash ([`08cc77e`](https://gitverse.ru/amesk/yaPDP/commit/08cc77e)).
- VT52: do not render bold/underline attributes in VT52 mode ([`6e98ae5`](https://gitverse.ru/amesk/yaPDP/commit/6e98ae5)).
- VT52: restore the authentic 4:3 aspect ratio on the tube ([`ae0c294`](https://gitverse.ru/amesk/yaPDP/commit/ae0c294)).
- VT52 cabinet side panel overflowing the case on Windows 10 ([`334940c`](https://gitverse.ru/amesk/yaPDP/commit/334940c)).
- Tear sound plays only when paper/tape is actually torn off ([`72d914b`](https://gitverse.ru/amesk/yaPDP/commit/72d914b)).
- Restore the cycling POWER LOCK key click alongside the position labels ([`8f20c55`](https://gitverse.ru/amesk/yaPDP/commit/8f20c55)).
- POWER LOCK: clicking the LOCK label keeps the key pointing at LOCK instead of leaving it on POWER (ON) — the front-panel switches are now properly disabled while the panel is locked.

### Documentation

- User manual page linked from the landing page ([`8bca590`](https://gitverse.ru/amesk/yaPDP/commit/8bca590)).
- Screenshot generator; user manual illustrated with emulator screenshots ([`f4ce4a5`](https://gitverse.ru/amesk/yaPDP/commit/f4ce4a5)).
- Per-tab config, dialog and Lunar Lander illustrations for the user manual ([`3812fa4`](https://gitverse.ru/amesk/yaPDP/commit/3812fa4)).
- Remove the ExampleBoots link and add author contact on the instructions page ([`16b08c1`](https://gitverse.ru/amesk/yaPDP/commit/16b08c1)).
- README: toolchain installation section for the desktop build ([`a47159b`](https://gitverse.ru/amesk/yaPDP/commit/a47159b)).

### Chore

- Remove OS/editor junk entries from `.gitignore` ([`ba26696`](https://gitverse.ru/amesk/yaPDP/commit/ba26696)).

## [0.1.0-alpha1] - 2026-08-19

Initial public alpha release.

[0.1.0-alpha2]: https://gitverse.ru/amesk/yaPDP/compare/releases/v0.1.0-alpha1...releases/v0.1.0-alpha2
[0.1.0-alpha1]: https://gitverse.ru/amesk/yaPDP/releases/tag/releases/v0.1.0-alpha1
