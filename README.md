# yaPDP — Yet Another PDP‑11/70 Web Emulator, with Authentic Front Panel & Model 33 ASR Teletype

![CI](https://github.com/amesk/yaPDP/actions/workflows/ci.yml/badge.svg)

![PDP‑11/70 Front Panel](assets/pdp1170-large.png)

---

## Foreword: A Personal Note

I first saw DEC minicomputers as a child, and later worked hands‑on with their Soviet clones — the **SM‑4** and **SM‑1420** running **RSX‑11M**. Decades later, thanks to the incredible work of Paul Nankervis, it is possible to boot Unix V5, BSD 2.11, Ultrix‑11, RSX‑11M, RSTS/E and RT‑11 in a browser.

This repository is the result: **yaPDP**. Welcome to the machine.

---

## About This Project

This is **yaPDP**, a **PDP‑11/70** emulator written entirely in JavaScript. It runs in any modern browser — no plugins, no downloads, no configuration. Just run the emulator and you're standing in front of a DEC minicomputer.

### What makes it special

| Feature | Description |
|---------|-------------|
| **Authentic Front Panel** | Every switch, LED, and rotary knob faithfully recreated. Toggle in a bootstrap loader the way DEC engineers did in the 1970s. |
| **Model 33 ASR Teletype** | The operator console: a fully animated, authentic Model 33 ASR — faithful keyboard with the historical special keys, paper printing with true nroff/man overstrike, carriage jamming at the margin, and an 8-track paper-tape reader/punch unit with the real START/STOP/FREE/AUTO switch and CCU. |
| **Authentic LP11 Line Printer** | Beige/grey cabinet, fanfold paper, ON LINE lamp, ~300 lines/min, DONE handshake and sticky ERROR latching; **Print** to a real printer or **Save .txt**. |
| **VT52 Terminal** | A DECscope VT52 on canvas with authentic P4 phosphor, optional reverse video, CRT simulation and a text mode with native clipboard. |
| **VT11 Display** | Optional vector-graphics display processor on its own green-phosphor CRT page — Lunar Lander included. |
| **Quick boot (magic wand)** | One click boots any guest OS: applies the right machine profile, types `boot <dev>` and the login, prompt-aware. |
| **16 Guest Operating Systems** | Unix V5, 2.11 BSD, Ultrix‑11, RSX‑11M (3.2 & 4.6), RSTS/E (4B‑17 through 10.1), RT‑11, XXDP diagnostics, and more. |
| **Persistent Disk Images** | All disk and tape images are preloaded. Changes to disk contents persist in browser storage across sessions. |
| **Paper Tape Reader** | Load BASIC‑11, ODT‑11, ED‑11, or Lunar Lander from simulated paper tape. |

The full walkthrough of every feature lives in
[`docs/FEATURES.md`](docs/FEATURES.md).

### Live Demo

- [**yaPDP**](https://paulnank.github.io/pdp11-js/pdp11.html)

The repository root also contains [`index.html`](index.html) — a landing page in the
same DEC style as the emulator itself — and [`manual.html`](manual.html), a
step-by-step user manual with live screenshots.

## User Manual

[`manual.html`](manual.html) is a step-by-step user guide in the same DEC style
as the landing page: quick boot (magic wand), the front panel, the Model 33 ASR
operator console, VT52 terminals, the LP11 line printer, storage, configuration
and every guest OS boot command. Its page illustrations are live screenshots of
the emulator, regenerated with `npm run screenshots:manual`
([`tools/screenshots-manual.js`](tools/screenshots-manual.js)).

## Desktop App (Tauri)

The same emulator is packaged as a native desktop application with [Tauri v2](https://tauri.app/),
running fully offline. Two installer variants are published: **Minimal** (~3 MB,
`rk0`/`rk1`/`bootcode` bundled, everything else drag & dropped at runtime) and
**Full** (every disk/tape image, all 16 guest OSes boot offline). Installers for
Windows x64 (MSI/NSIS/portable) and Linux x64 (deb/rpm/AppImage). Toolchain
installation and build commands: [`docs/BUILDING.md`](docs/BUILDING.md). The
step-by-step release procedure: [`docs/RELEASING.md`](docs/RELEASING.md).

## Guest Operating Systems

The emulator ships with ready-to-boot disk and tape images. Just type `boot <device>` at the `@` prompt.

| Disk | Operating System | How to Boot |
|------|-----------------|-------------|
| **RK0** | Unix V5 | `boot rk0` → `unix` → login as `root` |
| **RK1** | RT‑11 v4.0 | `BOOT RK1` |
| **RK2** | RSTS V06C‑03 | `BOOT RK2` — login `11,70` password `PDP` |
| **RK3** | XXDP (diagnostics) | `BOOT RK3` |
| **RK4** | RT‑11 3B Distribution | `BOOT RK4` |
| **TM0** | RSTS 4B‑17 (tape) | `BOOT TM0` — follow ROLLIN restore procedure |
| **RL0** | BSD 2.9 | `boot rl0` → `rl(0,0)rlunix` → CTRL/D → login `root` |
| **RL1** | RSX‑11M v3.2 | `BOOT RL1` — login `1,2` password `SYSTEM` |
| **RL2** | RSTS/E v7.0 | `BOOT RL2` — login `11,70` password `PDP` |
| **RL3** | XXDP (extended) | `BOOT RL3` |
| **RP0** | ULTRIX‑11 V3.1 | `boot rp0` → CTRL/D → login `root` |
| **RP1** | BSD 2.11 | `boot rp1` — autoboots to multiuser, login `root` |
| **RP2** | RSTS/E v9.6 | `BOOT RP2` — answer prompts, login `11,70` |
| **RP3** | RSX‑11M v4.6 | `BOOT RP3` — auto-logs `1,2` SYSTEM |
| **RP4** | RSTS/E v10.1 | `BOOT RP4` — answer prompts, login `11,70` |

> Full boot session logs for every OS can be found in [`docs/ExampleBoots.md`](docs/ExampleBoots.md).

## Quick Start

1. Open the [yaPDP emulator](https://paulnank.github.io/pdp11-js/pdp11.html).
2. At the `@` prompt, type `boot rp1` and press ENTER.
3. BSD 2.11 will autoboot into multiuser mode. Login as `root` (no password).
4. Try `ls`, `ps -aux`, `df` — or compile a C program with `cc`.

A detailed walkthrough of every page (Panel, Console, TTY, Printer, Display,
Storage, Config, Info, REBOOT/STATE buttons, fullscreen, mute) and the classic
panel tricks (light chaser, bootloader restart) is in
[`docs/FEATURES.md`](docs/FEATURES.md).

## Project Architecture

At a glance: the CPU ([`src/pdp11.js`](src/pdp11.js)) executes against an I/O
page ([`src/iopage.js`](src/iopage.js)) that owns the peripherals;
[`src/pdp11-app.js`](src/pdp11-app.js) glues the machine to the UI and honours
the user configuration ([`src/config.js`](src/config.js)); the custom bootstrap
loader is [`src/bootcode.js`](src/bootcode.js); guest-OS boot scenarios and the
quick-boot wizard live in [`src/osboot.js`](src/osboot.js) and
[`src/quickboot.js`](src/quickboot.js). Modular tests live in `tests/` and are
driven by `tools/run-tests.js` (`npm test`).

The complete file map (every `src/`, `tests/`, `css/`, `tools/` module with its
purpose) and the media-file layout: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## License

This project is released under the [MIT License](LICENSE).

Copyright (c) 2026 Alexei Eskenazi

---

## Acknowledgments

This project stands on the shoulders of giants.

### Paul Nankervis — Original PDP‑11 Emulator

Paul wrote the original [pdp11-js](https://github.com/paulnank/pdp11-js) emulator, which this repository is forked from. His meticulous work — cycle‑accurate CPU emulation, beautifully rendered front panels, and a meticulously curated collection of vintage operating systems — made this project possible. His story about chasing the RSTS/E console light pattern is legendary among DEC enthusiasts.

> *"I met my core objective — I can now see the RSTS/E console light pattern that I was looking for."*
> — Paul Nankervis

### Norbert Landsteiner (mass:werk) — Google60 Teletype

The Model 33 ASR teletype emulation is adapted from [**Google60**](https://www.masswerk.at/google60/) by **Norbert Landsteiner** of [mass:werk](https://www.masswerk.at/). Google60 is a brilliant simulation of the Google search interface as it would have appeared on a Model 33 ASR Teletype in the 1960s/1970s. Norbert's meticulous implementation — from the 3D keycaps to the paper advance animation and authentic sound effects — brings the teletype to life. This project repurposes his engine as the operator console for the PDP‑11.

His work is a masterclass in retro‑UI simulation. Thank you, Norbert.

### Additional Sources

- [**Bitsavers**](http://bitsavers.org/pdf/dec/pdp11/) — DEC PDP‑11 documentation archive
- [**Bitsavers Software**](http://bitsavers.org/bits/DEC/pdp11/) — PDP‑11 software and disk images
- [**The Unix Heritage Society (TUHS)**](https://www.tuhs.org/) — Preserving UNIX history
- [**RSTS.ORG**](http://www.rsts.org/) — RSTS/E community and software preservation

---

## Links

| Resource | URL |
|----------|-----|
| Original pdp11-js | <https://github.com/paulnank/pdp11-js/> |
| Google60 (mass:werk) | <https://www.masswerk.at/google60/> |
| mass:werk | <https://www.masswerk.at/> |
| Bitsavers (docs) | <http://bitsavers.org/pdf/dec/pdp11/> |
| Bitsavers (software) | <http://bitsavers.org/bits/DEC/pdp11/> |
| TUHS | <https://www.tuhs.org/> |

---

*Happy emulating!*

— Paul Nankervis (*original author*)  
— *Fork maintained with love for the DEC era*
