# Known Issues

Open emulation bugs and long-running tasks that do not fit in a single
commit. Each entry: symptom, how to reproduce, what is already known.

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

**Status:** open (not a regression — reproduces on v0.1.0-alpha2 too).

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
1. `node tools/serve.js` (port 1170), open `pdp11.html?bridge=1`.
2. Boot → `boot rp0` → wait for single-user `#`.
3. Send Ctrl-D (`dlReceiveQueue(0, [4])`).

Or the e2e scenario: `node /tmp/ctrld-probe.js rp0` (prototype script).

**What was found.**
- On v0.1.0-alpha2 the panic is identical (same `pc=136250`, `trap type 0`) —
  the bug is in the common part of the emulator (pdp11.js / MMU / user-mode),
  not in the iopage devices and not in the refactor.
- The kernel manages to mount /usr and /user1 and writes the error log —
  it panics when returning to user mode / starting init.
- The same "class" of problems (multi-user / user-mode) was seen on BSD 2.9
  (input after `login:`), but there the cause was in the guest (getty
  TIOCFLUSH) — here, judging by `panic: trap`, the bug is in the emulator.

**Search candidates.**
- MMU translation in user mode (PAR/PDR user sets) when switching
  kernel→user.
- Interrupt/trap handling in user mode (PSW mode bits, stacks).
- Possibly related to `mapVirtualToPhysical` / `CPU.mmuMode` when
  switching process context.

**Tools:** `window.__tracePC` (instruction-trace windows),
`DEBUG_MMU`/`DEBUG_TRAP` (headless), dumps of `CPU.mmuPAR/PDR`.

---

## (History) BSD 2.9 (rl0): input after `login:` was lost

**Status:** resolved — not an emulator bug.

BSD 2.9 getty clears its input buffer (TIOCFLUSH) on startup: a login typed
immediately after `login:` is lost. The fix is a pause in the wizard
scenario: `{ send: "root", waitFor: "login:", wait: 3000 }`
(quickboot supports `wait` since commit 7dd3aa2).
