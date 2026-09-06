# XXDP diagnostics in yaPDP

yaPDP can run real DEC field diagnostics (XXDP) on the **headless stack** and
drive them to a clean verdict. This is the "authenticity gate" idea from
[ROADMAP.md](ROADMAP.md): the era's own test equipment certifying the
emulation, as a growing e2e suite.

This file is the map we use to pick the next diagnostic deliberately. When
you add a verification test, read this first — it saves re-deriving what the
module names mean.

## Naming convention

DEC diagnostic module identifiers are 6 characters:
`<prefix><device><test><rev>`.

- The two characters after the environment prefix are a mnemonic for the
  **device under test** (the same letters as the standard DEC device-driver
  mnemonics are NOT used — these are XXDP's own).
- A leading character carries platform/environment info (e.g. `Z` = not bound
  to a specific CPU).
- The trailing `letter + digit` is the revision/patch level (`0` = full rev,
  `1` = a second build, etc.). `.BIC` files are binary diagnostics; `.SYS`
  files are the XXDP device drivers it loads as infrastructure, not tests.

Source (authoritative mnemonic table):
<https://retrocmp.com/tools/pdp-11-diagnostic-database/201-pdp-11-diagnostics-module-names>

### Device mnemonics relevant to this emulator

| Code | Device            |
|------|-------------------|
| KB   | CPU (KB11/11-70)  |
| FP   | FP11, FPF11 (FPU) |
| MS, MK, MM, ML, MF, KM | Memory |
| KT   | Memory management |
| KK   | Cache memory      |
| RK   | RK11 / RK05       |
| RL   | RL11 / RL01-02    |
| RH, RM, RS | disk controllers |
| KL   | KL11 console      |
| Z    | not CPU-bound     |

## The rk3 image (XXDP+ DK)

`media/rk3.dsk.zst` boots to the XXDP+ DK monitor (`BOOT RK0`), answers a
`09-SEP-78` date, and reaches its `.R` command prompt.

Full catalog (entry `D` in the monitor), grouped by device under test:

### KB11 CPU diagnostics (EK* / CK*)
- `EKBBF0` — **passes** today (the 11/70 CPU #2 test; self-identifies the
  CPU as a KB11-B/C or KB11-CM). See `tests/e2e-xxdp-ekbbf0.js`.
- `EKBAD0`, `EKBCD1`, `EKBDE0`, `EKBEE1`, `EKBFD1`, `EKBGC0`
- `CKBAB0`, `CKBBB0`, `CKBCC0`, `CKBDC0`, `CKBEC0`, `CKBIB0` (+`CKBCB0.PAT`)

### FP11 / FPU diagnostics (KFP*)
- `KFPAD0`, `KFPBC0`, `KFPCD0`
- FP11 is a separate emulated module (`src/fpp.js`) that CPU tests do not
  cover — these are the natural next target after the CPU tests.

### Other / environment
- `EQKCE1` (+ `.PAT`), plus `KIT11`-style helpers.
- `.SYS` files (`HDDKB0`, `HDMSB0`, `HMDKC0`, ...) are XXDP internal driver
  images for the mass-storage/console devices, not user-runnable tests.
- `.BIN` (`SETUP`, `PATCH`, `XTECO`, `DXCL`) and `HELP.TXT` / `UPD1`/`UPD2`
  are XXDP utilities, not diagnostics.

## The rl3 image (XXDP extended) — parked

`media/rl3.dsk.zst` does **not** boot straight into the XXDP monitor the way
rk3 does: on the headless stack it stops at the boot ROM with
`VALID COMMANDS ARE BOOT OR HELP` and needs its own input protocol. It is
currently out of scope; revisit separately.

## How a diagnostic is driven on headless

First `tests/e2e-xxdp-ekbbf0.js` is the working template:

1. `bootHeadless` the image with a `stableMs` silence wait (no marker guess).
2. Answer the XXDP date prompt, then issue `R <name>??` (the `??` wildcard
   makes XXDP resolve the exact `.BIC`).
3. As the diagnostic prints its operator prompts, drive the machine the way
   an operator would, **programmatically against the machine registers**:
   - "switch 7" = bit 7 of the console switch register — set
     `CPU.switchRegister = 0200`.
   - "TYPE A CHARACTER TO CONTINUE" = feed one character when the ask appears
     (detect by console output growth), never pump it.
4. Assert the terminal verdict, e.g. `END PASS #1 TOTAL ERRORS SINCE LAST
   REPORT 0`.

The panel is the machine's own registers (`displayAddress` etc.), not the
Web UI — keeping the verification attributable to the emulation core, not
the DOM layer.
