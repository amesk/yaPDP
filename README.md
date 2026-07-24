# PDP‑11 Web Emulator — with Authentic Front Panel & ASR 33 Teletype

![PDP‑11/70 Front Panel](assets/pdp1170-large.png)

---

## Foreword: A Personal Note

I first saw DEC minicomputers as a child at my parents' workplace. The blinking lights, the whir of disk drives, the smell of ozone and paper — it left an impression that never faded.

My real hands‑on encounter came later, when I found myself in front of the Soviet clones of DEC hardware — the **SM‑4** and **SM‑1420** — running **RSX‑11M**. And with them came C. The language that lets you feel the machine. It was love at first sight.

That was forty years ago.

I went on to become a professional programmer, eventually leading large projects. But the feeling of powering up an SM‑4 with my own hands, watching the console lights dance, then walking to the next room to sit at a terminal — that stayed with me. I've been trying to bring it back ever since.

I never got to run **real UNIX** on those machines. The Soviet replicas lived under RSX‑11M, and by the time I understood what UNIX V5 or 2.11 BSD truly meant, the world had already moved to x86 PCs. But decades later, thanks to the incredible work of Paul Nankervis, I can finally open a browser and boot Unix V5, BSD 2.11, Ultrix‑11, RSX‑11M, RSTS/E, RT‑11 — each one a time capsule of computing history.

This repository is the result. A fully fledged PDP‑11/70 (and /45) emulator that runs right in your browser, with an authentic front panel and a connected **ASR 33 teletype** — the operator's console I always dreamed of having next to my desk.

Welcome to the machine.

---

## About This Project

This is a **PDP‑11/70** emulator written entirely in JavaScript. It runs in any modern browser — no plugins, no downloads, no configuration. Just open the page and you're standing in front of a DEC minicomputer.

### What makes it special

| Feature | Description |
|---------|-------------|
| **Authentic Front Panel** | Every switch, LED, and rotary knob faithfully recreated. Toggle in a bootstrap loader the way DEC engineers did in the 1970s. |
| **ASR 33 Teletype** | A fully animated Google60-style teletype connected as the operator console — complete with paper printing, keypunch sounds, and line-feed whirs. |
| **VT52 Terminal** | A DECscope VT52 terminal (TT1:) rendered on canvas, for guest OSes that prefer video terminals. |
| **16 Guest Operating Systems** | Boot Unix V5, 2.11 BSD, Ultrix‑11, RSX‑11M (3.2 & 4.6), RSTS/E (4B‑17 through 10.1), RT‑11, XXDP diagnostics, and more. |
| **Persistent Disk Images** | All disk and tape images are preloaded. Changes to disk contents persist in browser storage across sessions. |
| **Paper Tape Reader** | Load BASIC‑11, ODT‑11, ED‑11, or Lunar Lander from simulated paper tape. |

### Live Demo

- [**PDP‑11/70**](https://paulnank.github.io/pdp11-js/pdp11.html)

---

## Guest Operating Systems

The emulator ships with ready-to-boot disk and tape images. Just type `boot <device>` at the `Boot>` prompt.

| Disk | Operating System | How to Boot |
|------|-----------------|-------------|
| **RK0** | Unix V5 | `boot rk0` → `unix` → login as `root` |
| **RK1** | RT‑11 v4.0 | `boot rk1` |
| **RK2** | RSTS V06C‑03 | `boot rk2` — login `11,70` password `PDP` |
| **RK3** | XXDP (diagnostics) | `boot rk3` |
| **RK4** | RT‑11 3B Distribution | `boot rk4` |
| **TM0** | RSTS 4B‑17 (tape) | `boot tm0` — follow ROLLIN restore procedure |
| **RL0** | BSD 2.9 | `boot rl0` → `rl(0,0)rlunix` → CTRL/D → login `root` |
| **RL1** | RSX‑11M v3.2 | `boot rl1` — login `1,2` password `SYSTEM` |
| **RL2** | RSTS/E v7.0 | `boot rl2` — login `11,70` password `PDP` |
| **RL3** | XXDP (extended) | `boot rl3` |
| **RP0** | ULTRIX‑11 V3.1 | `boot rp0` → CTRL/D → login `root` |
| **RP1** | BSD 2.11 | `boot rp1` — autoboots to multiuser, login `root` |
| **RP2** | RSTS/E v9.6 | `boot rp2` — answer prompts, login `11,70` |
| **RP3** | RSX‑11M v4.6 | `boot rp3` — auto-logs `1,2` SYSTEM |
| **RP4** | RSTS/E v10.1 | `boot rp4` — answer prompts, login `11,70` |

> Full boot session logs for every OS can be found in [`ExampleBoots.md`](ExampleBoots.md).

---

## Quick Start

1. Open the [PDP‑11/70 emulator](https://paulnank.github.io/pdp11-js/pdp11.html).
2. At the `Boot>` prompt, type `boot rp1` and press ENTER.
3. BSD 2.11 will autoboot into multiuser mode. Login as `root` (no password).
4. Try `ls`, `ps -aux`, `df` — or compile a C program with `cc`.

### Switching pages

Use the sidebar to switch between:
- **Panel** — the front panel with switches and LEDs
- **Teletype** — the ASR 33 teletype console
- **VT52** — the DECscope VT52 video terminal
- **Info** — detailed instructions and OS reference

### A simple light chaser

Toggle this into the front panel to see the address and data LEDs dance:

```
Switch sequence: HALT, 001000, LOAD ADDRESS
                 012700, DEPOSIT
                 000001, DEPOSIT
                 006100, DEPOSIT
                 000005, DEPOSIT
                 000775, DEPOSIT
                 001000, LOAD ADDRESS, ENABLE, START
```

### Restart the bootloader

```
HALT, 120000, LOAD ADDRESS, ENABLE, START
```

---

## Project Architecture

| File | Purpose |
|------|---------|
| [`pdp11.js`](pdp11.js) | Core CPU emulation (PDP‑11/70 & /45 instruction set, MMU, interrupts) |
| [`fpp.js`](fpp.js) | Floating‑Point Processor (FP11) emulation |
| [`iopage.js`](iopage.js) | I/O page — disk controllers, terminal interfaces, paper tape reader, line printer |
| [`pdp11-panel.js`](pdp11-panel.js) | Front panel rendering and switch interaction |
| [`pdp11-app.js`](pdp11-app.js) | Application glue — boots the emulator, wires teletype and VT52 |
| [`vt52.js`](vt52.js) | DECscope VT52 terminal emulation (canvas‑based) |
| [`g60printer.js`](g60printer.js) | Google60-style teletype printer (ASR 33) |
| [`vt11.js`](vt11.js) | Vector graphics VT11 display |
| [`bootcode.js`](bootcode.js) | The custom bootstrap loader program |
| [`pdp11.css`](pdp11.css) | Front panel and application styles |
| [`g60printer.css`](g60printer.css) | Teletype printer styles |
| [`tools/gen-favicon.js`](tools/gen-favicon.js) | Favicon generator |

### Media files

Disk (`.dsk`), tape (`.tap`), and paper tape (`.ptap`) images live in the [`media/`](media/) directory. Many are ZST‑compressed to stay within GitHub size limits. See [`media/README.md`](media/README.md) for the naming convention.

---

## Acknowledgments

This project stands on the shoulders of giants.

### Paul Nankervis — Original PDP‑11 Emulator

Paul wrote the original [pdp11-js](https://github.com/paulnank/pdp11-js) emulator, which this repository is forked from. His meticulous work — cycle‑accurate CPU emulation, beautifully rendered front panels, and a meticulously curated collection of vintage operating systems — made this project possible. His story about chasing the RSTS/E console light pattern is legendary among DEC enthusiasts.

> *"I met my core objective — I can now see the RSTS/E console light pattern that I was looking for."*
> — Paul Nankervis

### Norbert Landsteiner (mass:werk) — Google60 Teletype

The ASR 33 teletype emulation is adapted from [**Google60**](https://www.masswerk.at/google60/) by **Norbert Landsteiner** of [mass:werk](https://www.masswerk.at/). Google60 is a brilliant simulation of the Google search interface as it would have appeared on a ASR 33 Teletype in the 1960s/1970s. Norbert's meticulous implementation — from the 3D keycaps to the paper advance animation and authentic sound effects — brings the teletype to life. This project repurposes his engine as the operator console for the PDP‑11.

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
