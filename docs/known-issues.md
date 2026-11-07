# Known Issues

Open emulation bugs and long-running tasks that do not fit in a single
commit. Each entry: symptom, how to reproduce, what is already known.

---

## Autoload locks the whole interface until it finishes (escape: "Take control!")

**Number:** none — by design, documented here for discoverability.

**Status:** intended behaviour, not a bug.

**Symptom.** While the quick-boot wizard types its boot sequence, the toast
"Autoloading in progress… [Take control!]" is up and the emulator's input is
blocked completely: the teletype and the VT52/VT100 terminals ignore the
keyboard, the front-panel switches do not move, and mouse clicks — including the
navigation tabs, the CONFIG/Storage pages and the floating corner buttons — do
not respond. The only way out before the sequence finishes is the toast's
"Take control!" button. This is easy to mistake for a frozen page.

**Why.** The wizard types into the same DL11 receive queue the keyboard uses, so
a stray keystroke during the boot would race the wizard's bytes in the console
and can derail a boot that is already half-typed. For as long as the autoload
runs, the input gate swallows every keyboard and pointer event in the capture
phase (see `gateEvent` / `setInputGate` in `src/quickboot.js`). F11 (fullscreen)
is the single exception, so the operator cannot get stuck in a mode they cannot
leave.

**Reproduction.**

1. `node tools/serve.js` (port 1170), open `pdp11.html?boot=rk1`.
2. While the "Autoloading in progress…" toast is up, try to type, click a
   navigation tab or flip a front-panel switch — nothing responds.
3. Click "Take control!" — the toast disappears, the autoload stops and the
   machine responds to input again.

**Note.** A failed image fetch aborts the autoload on its own (`imgerror.js`
calls the abort hook), so the gate cannot outlive the autoload it belongs to.

---

## XXDP cache tests (EKBCD1/EKBDE0): non-deterministic HALT at pc=10

**Number:** (no GitHub issue yet) — found while exploring the XXDP diagnostics.

**Status:** open (needs separate debugging; no active work).

**Symptom.** `EKBCD1` (banner "11/70 CACHE #1") and `EKBDE0` ("CACHE #2")
run on the headless stack, but behaviour is non-deterministic: in some runs,
after the banner and ~2.4 s of work (PC 153576→156076) the CPU emits
`HALT at 10 PSW: 0`; in others the test runs quietly longer (RUN, PC in
153xxx) without failing. It is not a stable "always halts because the cache
controller is absent" — some runs work.

**What was found.** pc=10 (octal) is in the vector area — suspicion of a
system trap (vector 4 / bad address) rather than a meaningful cache check;
not established for certain (need a reliably reproducible run + a vector
dump). A ring tracer (intercept console.log → a 300-entry ring in the VM,
`__tracePC` ranges) works and barely affects timing.

**Debugging candidate:** MMU/trap handling, or initialization timing.

---

## ULTRIX-11 (rp0): `panic: trap` when transitioning from single-user to multi-user

**GitHub issue:** [#15](https://github.com/amesk/yaPDP/issues/15)

**Status:** root-caused and fixed for the quick-boot scenario; booting the
image by hand still needs two user terminals (see "Fix / workaround" below).

**Symptom.** ULTRIX-11 V3.1 boots to single-user (`#`), but Ctrl-D
(transition to multi-user) panics the kernel:

```
# ^D
Restricted rights: ...
Mounted /dev/hp01 on /usr
Mounted /dev/hp04 on /user1
Sat Oct 31 09:11:15 PDT 1981
ERROR LOG has - 2 of 200 blocks used
ka6 = 7574
aps = 142602
pc = 136250 ps = 30011
ovno = 1
trap type 0
panic: trap
```

**Reproduction.**

1. `node tools/serve.js` (port 1170), open `pdp11.html?bridge=1` with **no**
   user terminals configured (CONFIG: 0 terminals).
2. Boot → `boot rp0` → wait for single-user `#`.
3. Send Ctrl-D (`dlReceiveQueue(0, [4])`).

**Root cause.** Not the MMU and not user mode. Entering multi-user runs the
`getty` lines from the image's `/etc/ttys`, which open **two extra DL11
consoles** — 0o176500 (vector 0o310) and 0o176510 (vector 0o320). The emulator
registers those cards only when `Config.userTerminals` is 1 or 2
(`src/iopage.js`), so with the default 0 the CSR read at physical 0o17776500 /
0o17776510 lands in an empty I/O slot; `iopage.access()` raises a
Unibus-timeout trap (vector 4, error 0x10) and the kernel's unexpected-trap
path reports `trap type 0` and panics. The reported `pc = 136250` is the kernel
console routine: the trapping instruction starts at 0o136244
(`BIS @#addr,(R4)`, `R4 = 0o176500`) and the saved PC is the value after its
operand fetch. The MMU state at the trap was consistent (`MMR3 = 0o65`, kernel
PAR/PDR as expected, `ka6 = 7574`), so translation itself is fine.

**Evidence.**

- A trap wrapper around `trap()` logged exactly one CPU trap:
  `vector 4`, `errorMask 0x10`, `pc 0o136250`, `MMR2 0o136244`, kernel PSW.
- A wrapper around `iopage.access()` logged exactly one unmapped I/O access:
  `pa 0o17776500`, read, `pc 0o136250`, `R4 0o176500`.
- With `userTerminals = 1` the fatal access moves to 0o17776510 (TTY2); with
  `userTerminals = 2` the machine reaches `ULTRIX-11 System V3.1 (vixen)` and
  `login:` — no panic.

**Fix / workaround.**

- The rp0 quick-boot scenario declares `userTerminals: 2` and
  `userTerminalTypes: ["vt100", "vt100"]`; QuickBoot applies both Config
  fields as hardware keys (`mergeHardware`/`hardwareDirty`), so the two extra
  cards are present before the boot and Ctrl-D reaches `login:`.
- Booting rp0 by hand: set **2** user terminals on the CONFIG page first, or
  disable tty1/tty2 in `/etc/ttys` while in single-user.

**Tools:** `window.__tracePC` (instruction-trace windows),
`DEBUG_MMU`/`DEBUG_TRAP` (headless), dumps of `CPU.mmuPAR/PDR`.

---

## e2e-osboot: the RSX-11M v4.6 (rp3) guest is disabled

**Number:** none — documented here for discoverability.

**Status:** open — RSX-11M v4.6 stays commented out until it passes.

**Symptom.** [`tests/e2e-osboot.js`](../tests/e2e-osboot.js) declares nine guest
OSes and boots nine; only RSX-11M v4.6 (rp3) is still COMMENTED OUT because it
does not reach "PLEASE ENTER TIME AND DATE" within the scenario budget (cause
not yet isolated).

**Note.** ULTRIX-11 (rp0) is enabled again: its Ctrl-D transition to multi-user
works once the two extra DL11 terminals are configured — see the entry above.
The rp3 entry is kept commented in place (not deleted) so the intent, the
console type and the exact config survive; uncomment it once it passes.

---

## BSD 2.11 (rp1) runs on a video terminal, not a teletype

**Status:** accepted limitation, not a bug.

The quick-boot scenario for BSD 2.11 declares `console: "vt100"` even though the
guest historically ran on a Model 33 ASR. Unlike Unix V5 and the other DEC
guests, the 2.11 BSD loader does not detect a teletype console: it prints lower
case, which a real Model 33 ASR cannot print. Booting it on the emulated
teletype therefore means every lower-case byte reaches the paper folded to A-Z
by **Force PDP Output Uppercase** (`Config.forceUpperCaseOut`), while the guest
still believes it is writing lower case — the console output and the guest's own
idea of it drift apart.

The scenario sidesteps this by keeping a video terminal (which prints both
cases) and leaving `forceUpperCaseOut` untouched, so the emulator shows exactly
what the loader wrote. It is the only guest with that exception in
[`src/osboot.js`](../src/osboot.js); the console is a VT100 because 2.11 BSD is
a 1981 system and the VT100 (1978) is the terminal of that period, like the rest
of the 1980s guests in the same table.

---

## A VT52-only program (RT-11 `TIME52`) garbles on a VT100 console

**Status:** accepted limitation, not a bug.

**Symptom.** RT-11's `TIME52` clock draws correctly on a VT52 (DECscope)
console, but on a VT100 operator console the large digits break up into stray
asterisks and control-character frays instead of a readable clock.

**Reproduction.**

1. `node tools/serve.js` (port 1170), open `pdp11.html?boot=rk1`.
2. In CONFIG set the operator console to VT100, boot RT-11 and run `R TIME52`.
3. Repeat with the console set to VT52 — the clock draws.

**Why.** `TIME52` is a DECscope VT52 program: it positions the cursor with
`ESC Y <row+32> <col+32>` and clears with `ESC H` / `ESC J` / `ESC K`. A VT100
in its default ANSI mode has none of those — its grammar starts with `CSI`
(`ESC [`), so `ESC Y` is undefined there and `ESC H`/`ESC J`/`ESC K` are not
CUP/ED/EL without the `[`. The bytes therefore fall through to the screen as
characters, which is exactly what a real VT100 would do unless software switched
it into VT52 compatibility mode (`ESC [ ? 2 h`, DECANM — `TIME52` does not).

**Note.** The VT52/VT100 split is authentic, so this is not an emulator bug: run
VT52-only guests and utilities on a VT52 console. The per-machine dialect is
chosen in CONFIG (`Config.consoleType`); the compatibility sub-mode a VT100
*can* be put into is implemented in
[`src/dialect/vt100.js`](../src/dialect/vt100.js).

---

## (History) BSD 2.9 (rl0): input after `login:` was lost

**Status:** resolved — not an emulator bug.

BSD 2.9 getty clears its input buffer (TIOCFLUSH) on startup: a login typed
immediately after `login:` is lost. The fix is a pause in the wizard
scenario: `{ send: "root", waitFor: "login:", wait: 3000 }`
(quickboot supports `wait` since commit 7dd3aa2).

---

## `media/bootcode.ptap` is the pre-rebuild bootstrap

**Status:** known, cosmetic — the built-in bootstrap is the one that matters.

`media/bootcode.ptap` is the bootstrap on paper tape, for the reader path, and
it has not been repunched since the 2026-08-29 rebuild: it still carries the
historic loader, banner and `Boot>` prompt, while every other way into the
machine prints `@`. Nothing in the emulator loads it by itself — it sits in the
Storage paper-tape list and in the desktop bundle.

Replacing it means punching the current module (`node tools/headless-term.js`
builds it from `macro-asm/boot.mac` through RT-11SJ and DEC MACRO inside the
emulator, as `tools/rebuild-bootcode.js` does for `src/bootcode.js`) and
copying the punch export over the file.
