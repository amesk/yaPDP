# Machine layer (core stack) — design deep-dive

The core stack is the refactored machine layer of yaPDP. It mirrors the
hardware it emulates: peripherals are *cards* that register address regions
on a *bus*, the CPU is just another bus participant, and the "I/O page" is a
routing table rather than a pile of closures. The UI (front panel, consoles,
Storage page) is an adapter on top and knows nothing about device internals.

This document is the serious companion to the code: why the layer is split
the way it is, the contracts every card must honour, how bytes reach the
devices, and how to add a new device without breaking the guest zoo.

## Why the refactor happened

`src/iopage.js` started as the emulator's I/O page and grew into a monolith
where device logic, disk fetching, IndexedDB persistence and DOM rendering
were welded together. Consequences:

- **No machine without a browser.** Tooling (`rt11-term.js`) had to drive a
  full Chromium and reach through `window` hooks to talk to the guest.
- **Instrumentation lived in production.** `window.__consoleOutputHook` &
  friends were unconditional globals.
- **No reuse.** A controller was a closure inside the monolith; nothing could
  be unit-tested or shared.

The refactor applied the PDP‑11's own answer — Unibus (1969): one shared bus,
devices as cards with fixed address regions, the CPU as a peer. The legacy
monolith remains as the `?core=0` reference implementation; the parity gate
keeps both honest.

## Layer map

```
                    +-------------------------------------------+
                    | UI: pdp11.html, pdp11-app.js, quickboot…  |
                    | (stack-agnostic: talks to the `iopage`    |
                    |  contract and the window bridge)          |
                    +---------------------+---------------------+
                                          | global `iopage` adapter
                    +---------------------v---------------------+
   browser          | browser-machine.js   (core + devices +    |
   (pdp11.html)     |  DataLoader/DiskStore providers)          |
                    +-------------------------------------------+
   Node (tools)     | headless-machine.js  (core + devices +    |
                    |  file providers, bootHeadless())          |
                    +---------------------+---------------------+
                                          |
                    +---------------------v---------------------+
                    | Machine (core/machine.js)                 |
                    |  bus  — device registry + I/O-page access |
                    |  disk — DiskService (block I/O + cache)   |
                    +-----+-------------------+-----------------+
                          |                   |
              +-----------v----------+  +-----v------------------+
              | devices/*.js (cards) |  | diskstore.js (shared    |
              | DL11 KW11 RK11 RL11  |  | write-back overlay)     |
              | RP11 TM11 UDA50      |  |                         |
              | PTR/PTP LP11 MMU CPU |  |                         |
              +----------------------+  +-------------------------+
```

## The bus contract (`src/core/bus.js`)

A device registers one or more **regions** — `{ address, count }` in the I/O
page (e.g. the RK11 at `017777400`, 8 bytes). The bus routes every CPU I/O
access to the card that owns the address:

```js
machine.bus.register(0o17777400, 4, device);   // count in bytes
machine.addDevice(device);
device.install();
```

The CPU side never sees devices, only the bus — exactly like real Unibus
programming, where software pokes fixed addresses and the bus figures out
who answers.

### Card interface (`src/core/device.js`)

A card is a `Device` subclass implementing any of:

| Method | Role |
|--------|------|
| `access(pa, data, byteFlag)` | Read (`data < 0`) / write (`data >= 0`) a register. Returns the register value on read. `pa` is the full I/O-page address; mask the low bits for the register offset |
| `poll(takeInterrupt)` | Interrupt arbitration. `poll(false)` returns `priority << 5 | pending`; `poll(true)` returns the vector when the CPU takes the interrupt |
| `reset()` | Bus reset / INIT — restore the card to power-on state |
| `snapshot()` / `restore(state)` | L2 machine-state capture/restore (registers only — see *snapshots* below) |
| `powerOn()` / `powerOff()` | Machine power hooks (optional) |

Two rules the refactor learned the hard way:

1. **Cards are DOM-free.** No `document`, no `window` — only the machine and
   its host seams. DOM wiring belongs to the adapter (e.g.
   `browser-machine.js` wires the `#ptr` select to the PTR card).
2. **Debug code must not assume Node.** Any `process.*` reference in a card
   has to be guarded: `typeof process !== "undefined" && process.env.DEBUG_X`.
   An unguarded check crashed the browser CPU loop the first time RSTS/E 9.6
   autoconfigured the UDA50 (the guest probes controllers it does not even
   boot from).

## The machine (`src/core/machine.js`)

The chassis owns the bus, the device registry and the disk service:

- `machine.bus` — I/O-page routing (above)
- `machine.disk` — the `DiskService` (below)
- `machine.mountDrive(url, provider)` — attach a byte source for an image
- `machine.findDevice(id)` / `machine.addDevice(device)` / `powerOn()` /
  `powerOff()`

### Disk service + providers

The storage split has two layers:

1. **"Getting the bytes"** is the environment's job (UI/OS). The browser
   uses `DataLoader` (bundled/dragged images) + network fetch; Node uses the
   file system. Neither the cards nor the service care which one it is.
2. **Block I/O** is the machine's job. A **provider** implements
   `readBlock(n) -> Uint8Array` (and optionally `writeBlock(n, bytes)` and
   `length()`). The service caches blocks (128 KiB `Uint16Array` words, same
   layout as legacy iopage) and serves the cards:

| Op | Meaning |
|----|---------|
| `OP_READ` / `OP_WRITE` | Sector read/write for disk controllers |
| `OP_CHECK` | Status probe |
| `OP_ACCUM` | Tape controllers (accumulate buffer, e.g. TM11) |
| `OP_BYTE` | PTR paper-tape reader (one byte at the current position) |

Cards drive I/O with a control block (`{ url, cache, position, ... }`) and a
completion callback through `machine.disk.io(...)`; the host seam
`scheduleCallback` delivers completions between instructions, preserving the
asynchronous behaviour guests expect.

### Write-back (persistence)

Guest writes land in the service's cache and are reported dirty; the
**provider** decides where they go:

- **Headless** (`tools/headless-machine.js`): providers write into the raw
  image bytes (`bootHeadless({ imageBytes })` continues from the written
  image; `r.imageBytes` hands it on).
- **Browser** (`browser-machine.js`): providers overlay the base image with
  the shared `DiskStore` (`src/diskstore.js`) — the IndexedDB-backed
  persistent overlay (in-memory in Node test contexts). `readBlock` consults
  session cache → `DiskStore.getBlock` → base image, so a saved block always
  wins. Blocks are tagged with `IMAGE_VERSION`; bump it when bundled media
  changes so stale saved blocks are not overlaid onto a different disk.

## The bridge (tooling seam)

External tooling (headless-term, e2e suites, video recorder) talks to the
machine through a console bridge:

- `__yapdpBridge.dlReceiveQueue(unit, bytes)` — deliver console input
  (bytes is an **array** of char codes)
- `__yapdpBridge.dlConsoleBreak()` — console BREAK
- `__yapdpBridge.setOutputHook(fn)` — chainable console-output hook
  (returns the previous hook)
- `window.onConsoleInputDrained` — fired when the console typeahead drains
  (drives the reader's AUTO mode)

The internal bridge is always exposed; the legacy `window.dlReceiveQueue` /
`window.__consoleOutputHook` surface is gated behind `?bridge=1` so
production pages stay clean.

## Snapshots and the paper tape

L2 snapshots (`snapshotDevices`/`restoreDevices`) capture card **registers**,
not card *state* such as a mounted tape. The PTR card forgets its tape on
reset and on restore — exactly like the legacy card, which healed itself by
lazily rebuilding its control block from the Storage-page `<select>` on the
next GO. The DOM-free PTR card cannot, so the **adapter** re-applies the
currently selected tape after `iopage.reset()` and after
`restoreDevices()` (`browser-machine.js`). Keep this in mind when wiring new
UI-driven devices: anything the operator "loads" is adapter state, not card
state.

## Adding a new device

1. **Port the logic 1:1** from the legacy iopage closure (or write fresh) as
   a `Device` subclass in `src/devices/`. Keep it DOM-free.
2. **Registers**: declare `regions` and implement `access()` with the same
   register semantics — the legacy closure is the behavioural reference.
   Watch `insertData()` semantics for byte accesses.
3. **Interrupts**: implement `poll()`; request via the host CPU
   (`cpu.interruptRequested`) when a completion raises IE.
4. **Disk/tape images**: drive `machine.disk.io()` with a control block; in
   the adapters, mount lazy providers so big images are only decompressed on
   first access.
5. **Wire the adapters**: register the card in `browser-machine.js` (and any
   Storage-page DOM hooks there) and in `tools/headless-machine.js`.
6. **Tests**: unit tests on the headless base + a guest-boot e2e where a
   real OS exercises the card (the guest zoo is the strictest reviewer).
7. **Debug aids**: follow the existing `DEBUG_*` env pattern — and guard
   every `process` access for the browser.

## Debug aids

| Env / knob | What it logs |
|------------|--------------|
| `DEBUG_BUS=1/2` | NXM accesses / every I/O write (bus.js) |
| `DEBUG_RP`, `DEBUG_MMU`, `DEBUG_UDA` | RP11 register ops, MMU map writes, UDA50 activity |
| `opts.trapTrace` | Headless trap depth/events |
| `window.__tracePC` | Instruction-window PC trace (browser) |

## Parity gate

`tests/e2e-osboot.js` boots ten guests (Unix V5, RT‑11 ×2, RSX‑11M 3.2/4.6,
RSTS V06C/V7.0/E 9.6/10.1, XXDP, BSD 2.9/2.11, BASIC‑11) through the wizard
path and asserts each ready marker. The default run exercises the core
stack; `E2E_LEGACY=1` runs the same matrix on `?core=0`. Both must pass —
that gate is what lets the legacy monolith retire with confidence.

## Known limitations

- ULTRIX‑11 V3.1 boots to single-user but panics entering multi-user — an
  open emulator bug (see [known-issues.md](known-issues.md)), unrelated to
  the stack split (reproduced on the legacy stack and on v0.1.0-alpha2).
- The legacy `?core=0` stack remains for comparison/rollback; retiring it is
  a deliberate follow-up once the core stack has soaked.
