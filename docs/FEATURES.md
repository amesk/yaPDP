# yaPDP Features — Deep Dive

The README gives the two-minute tour. This document is the full walkthrough of
every feature: the Model 33 ASR teletype, the LP11 line printer, the VT52 and
VT11 terminals, the quick-boot wizard and the UI pages.

## Feature overview

| Feature | Description |
|---------|-------------|
| **Authentic Front Panel** | Every switch, LED, and rotary knob faithfully recreated. Toggle in a bootstrap loader the way DEC engineers did in the 1970s. |
| **Model 33 ASR Teletype** | A fully animated teletype drawn as an authentic Model 33 ASR — see [below](#model-33-asr-teletype). |
| **Authentic LP11 Line Printer** | A faithful recreation of the DEC line printer that stood beside real PDP‑11s — beige/grey cabinet, fanfold paper, ON LINE lamp and TOP OF FORM / PAPER FEED controls, printing at a near‑authentic ~300 lines/min. The accumulated job can be handed to your real printer via the system dialog (**Print**) or exported as a **.txt** file — hardcopy, just as it left the machine room. |
| **VT52 Terminal** | A DECscope VT52 terminal (TT1:) rendered on canvas with its authentic white/grey (P4) phosphor on a black tube — an optional reverse-video mode swaps it to black text on white — for guest OSes that prefer video terminals. See [below](#vt52-terminal). |
| **VT11 Display** | An optional DEC VT11 vector-graphics display processor on its own green-phosphor CRT page (1024x768 logical resolution, auto-scaled to fit the window), enabled from the CONFIG page. |
| **16 Guest Operating Systems** | Boot Unix V5, 2.11 BSD, Ultrix‑11, RSX‑11M (3.2 & 4.6), RSTS/E (4B‑17 through 10.1), RT‑11, XXDP diagnostics, and more. |
| **Persistent Disk Images** | All disk and tape images are preloaded. Changes to disk contents persist in browser storage across sessions. |
| **Paper Tape Reader** | Load BASIC‑11, ODT‑11, ED‑11, or Lunar Lander from simulated paper tape. |

## Model 33 ASR Teletype

A fully animated teletype drawn as an authentic Model 33 ASR — a light
cream/beige cabinet with a paper roll (behind the rising sheet), a glass
carriage window and a stamped Teletype Corporation logo on the lower face
plate — connected as the operator console with a faithful Model 33 ASR
keyboard: round dark keycaps with light two-line legends (the base glyph
centred, the CTRL-code name or shift symbol above), and the historical special
keys ESC, LINE FEED, RETURN, DELETE (RUB OUT — with the punch engaged it
punches the all-holes DEL row on the tape), HERE IS (answerback), REPT
(auto-repeat) and BREAK (asserts the console DL11 break condition). Upper Case
Only: the on-screen keycaps send only upper-case letters; the physical
keyboard folds a-z to A-Z when the **Upper Case Only** CONFIG option is enabled
(off by default, so 2.11 BSD receives lower case) — complete with paper
printing, keypunch sounds, line-feed whirs, and authentic nroff/man overstrike
(^H) rendering: re-printing the same glyph gives bold, underscores give
underline, and striking a *different* glyph (e.g. a 2.11 BSD boot countdown)
leaves the real dark overstrike blot a hard-copy terminal makes. Long lines
faithfully jam the carriage at the right margin (72 or 80 columns; characters
overstrike the last column instead of wrapping, no horizontal scrollbar), and
the paper width follows the selected width so a full line reaches the paper
edge. Like the LP11 page, the console paper is anchored to the carriage and
**grows upward**: it rises out of the top of the machine body until its edge
reaches the top of the window, at which point the paper's own scrollbar
appears and the view follows the freshly printed line.

Beside the machine sits the ASR tape **reader/punch** unit: every byte echoed
to the console punches a matching row of holes on an 8-track paper tape
(tracks 1–7 = ASCII, track 8 = parity, feed holes between tracks 3/4), which
grows downwards and gains a scrollbar once it fills the window. As on a real
ASR-33 the punch is **OFF by default**: it engages via the **ON** button on
the TAPE PUNCH cabinet (or when the machine sends **DC2 / 0x12**) and
disengages via **OFF** (**DC4 / 0x14**); **BSP** pulls the tape back one step —
the hanging tail visibly shortens as the last punched row disappears into the
punch unit — and the next punch overpunches the row now under the punch head,
the holes OR-ing together exactly like real hardware: **DELETE** (RUB OUT)
punches all holes and turns the byte into DEL, any other key corrupts it the
same way it would on a real ASR-33. **REL** releases it. The receive path
records machine output too: a **NUL** (0x00) from the machine punches a blank
row with only the feed hole — the classic tape leader/trailer that threads the
reader — and a received **DEL** punches an all-holes RUB OUT row, exactly as a
real ASR-33 receive punch would. The keyboard can make a NULL too — the
bit-paired combination **CTRL+SHIFT+P** (P's shifted symbol is **@**; with both
code bars the base 0x50 ends up with bits 4 and 6 flipped, i.e. 0x00), which
with the punch engaged punches the same blank leader row; on a PC keyboard
**Ctrl+@** does the same.

The TAPE READER reads a loaded tape into the machine: **Load tape** opens a
file dialog for a raw `.ptap`, a compressed `.ptap.zst`, or a `.txt` (its
characters become 7-bit tape codes), and the full tape hangs from the reader
slot down to the window edge, its ragged free end torn like the punched
tape's. The four-position switch (**START / STOP / FREE / AUTO**, **STOP by
default**) governs reading: START runs the reader continuously at the console
speed; AUTO sends one byte and feeds the next only when the machine's DL11 has
accepted the previous one, pausing on **DC3 / X-OFF (0x13)** and resuming on
**DC1 / X-ON (0x11)**; STOP pauses; **STOP** and **FREE** both show the
**Remove tape** button (hidden while the reader is START or AUTO, so a tape is
never pulled out mid-run; FREE is now a purely decorative switch position).
**Load tape** always switches the reader to **STOP** first, so a freshly
loaded tape never starts feeding on its own. The CCU routes every read byte
exactly like the keyboard: in **LOCAL** the tape prints on paper only
(tape-to-paper copy), in **LINE** it is sent to the machine and printed by the
machine's echo. With the punch engaged, every read byte is also punched onto
the output tape — the classic ASR trick for duplicating tapes. As the tape is
read it moves up through the slot and shortens; when the last byte is read the
tape has gone into the machine and a new one can be loaded. Mode is chosen
with the **Call Control Unit (CCU)** rotary knob on the apron right of the
keyboard — **LINE / OFF / LOCAL** (LINE connects to the machine, OFF powers the
whole unit down — teletype, punch and reader — and LOCAL prints the keyboard
locally while ignoring the machine line). Operator controls below the machine
switch **Tear tape** / **Tear paper** (tear off the punched tape / printed
paper) and **Save tape** (download the punched bytes as a `.ptap`). The
console echo speed is selectable in the CONFIG page: **authentic 110 baud
(~10 chars/sec)** or a fast development pace (~33 chars/sec).

## VT52 Terminal

A DECscope VT52 terminal (TT1:) rendered on canvas with its authentic
white/grey (P4) phosphor on a black tube — an optional reverse-video mode
swaps it to black text on white — for guest OSes that prefer video terminals.
The terminal is drawn as an authentic slanted DECscope monoblock: an off-white
moulded-plastic cabinet with a vent grille, a recessed screen in a deep bezel
and a plain plastic side panel with a raised ridge; input comes from the
physical keyboard, as on the original DECscope. Text is rendered in the
authentic `fritzm/vt52` bitmap display font (`monospace` is the fallback until
the webfont loads). The cabinet scales down proportionally to fit the window.
Clear screen (ESC E) and form feed (^L) both wipe the display and home the
cursor, so `clear` and multi-page nroff/man output start each page from the
top row. An optional pure-CSS CRT simulation adds brightness flicker,
scanline shimmer and a vertical-hold roll band. An optional **text mode**
renders the terminal as a plain text field instead of the canvas, enabling
native text selection and Windows Clipboard (Ctrl+C / Ctrl+V / right-click
paste) for fast source-code entry — at the cost of the SGR emphasis rendering.

## Quick boot (magic wand)

A magic-wand button in the top-right corner of the window (visible on every
page except the **Info** page) opens a picker for every guest OS. The
first-run welcome dialog also has a **Quick boot** button that opens the same
picker directly. Choosing one
switches to the operator console,
reboots the machine and types `boot <dev>` — and where the credentials are
known, the login too (e.g. Unix V5: `boot rk0` → `unix` → `root`). The boot
sequences live in [`src/osboot.js`](../src/osboot.js) (a hand-curated
machine-readable config, so the picker never has to parse the free-text Info
table); the flow itself is implemented in [`src/quickboot.js`](../src/quickboot.js)
and feeds the console through the same input queue the physical keyboard uses.

The picker shows only the guest OSes whose image this deployment actually
ships: the build manifest ([`media/manifest.json`](../media/manifest.json),
generated by `node tools/gen-media-manifest.js`) lists the shipped images,
and images mounted at runtime (desktop bundle, drag & drop) are added on top.
Paper tapes always stay in the picker — they are tiny, so even a minimal
build keeps the demo bootable. When a deployment has no manifest and nothing
is mounted (ad-hoc hosts, `file://`), the picker shows every scenario, exactly
as before. The Info page's guest-OS table is annotated the same way: rows
whose image is not in the build are dimmed with an "image not in this build"
note.

Login steps are prompt-aware: instead of firing on a timer, the wizard watches
the console output and types only when the guest prints `login:` (with a
timeout fallback), so slow boots with lots of output (e.g. 2.11 BSD) still
reach the login prompt reliably.

Each OS also declares the machine profile it wants (`hardware` in
`src/osboot.js`): e.g. Unix V5 / BSD / RT-11 / ULTRIX force a teletype
console, and RT-11 / RSX / RSTS enable the LP11 line printer. If the current
configuration differs, the wizard applies the profile (like the CONFIG Apply
button), reloads, and resumes the boot automatically.

Paper tapes (BASIC-11, ODT-11, ED-11, Lunar Lander) live in the same picker:
the wizard selects the tape in the Storage `#ptr` select and boots it via
`BOOT PR`. Lunar Lander additionally enables the VT11 vector display and
switches to the **Display** page so the landing module is visible.

Each wizard boot starts "on a fresh page": the teletype and LP11 paper, the
ASR paper tape and the VT52 screens are cleared before the machine reboots,
so the boot banner lands on clean output. While the sequence is being typed
a small toast warns
"Autoloading in progress — don't touch the teletype/keyboard"; it disappears
when the boot finishes, as soon as the operator presses any key, or the moment
an image fails to load (the wizard stops typing and the "Image load
interrupted" dialog takes over).

## The UI pages

Use the sidebar to switch between:
- **Panel** — the front panel with switches and LEDs
- **Console** — the operator console: a Model 33 ASR teletype (when the console terminal is a teletype)
- **Console** — the operator console: a DECscope VT52 (when the console terminal is a VT52)
- **TTY 1 / TTY 2** — user VT52 terminals, shown only when configured
- **Printer** — the LP11 line printer page, shown only when configured
- **Display** — the VT11 vector-graphics CRT page, shown only when configured
- **Storage** — storage media in two tabs: Images (drop zone, mounted images) and Paper Tapes (reader, punch export)
- **Config** — configure the emulated peripherals (persisted between sessions)
- **Info** — detailed instructions, OS reference and the About block
  (version, website, author and license). A "yaPDP vX.Y.Z" marker at the
  bottom of the sidebar opens this page

A floating **fullscreen** button (bottom-right of the window) hides the browser/
system chrome — the address bar in the browser, the OS window frame and the
taskbar in the Tauri desktop app — while leaving the emulator UI untouched.
Press it again (or Esc) to return.

The **Config** page controls the console terminal type (teletype or VT52), the
number of user terminals (0–2), the presence of the LP11 line printer and the
VT11 graphics display, the teletype print width (72/80 — a Model 33 ASR is at
most 80 columns), the printer print width (72/80/100/132), optional VT100-style
key-click sound for VT52 terminals, the historical VT52 reverse-video mode
(black text on white), a pure-CSS CRT simulation (brightness flicker, scanline
shimmer and a vertical-hold roll band), an optional VT52 **text mode** (plain
text field with native Windows Clipboard — Ctrl+C/Ctrl+V/right-click paste — for
fast source-code entry), the ambient PDP-11 power-supply hum and fan noise while
the machine is on, and the PDP-11 machine-room photo backdrop behind the pages.
The LP11 line printer defaults to the authentic 132-column width.
The form is split into four tabs — **Equipment** (console terminal, user
terminals, LP11 printer, VT11 display, print widths, teletype speed and the
Upper Case Only keyboard flag),
**Look & sound** (key click, reverse video, CRT effects, machine hum, photo
backdrop), **Behaviour** (reboot confirmation) and **Development** (VT52 text
mode) — with the **Apply** and **Restore defaults** actions in a bar below the
tabs.
Structural changes (console type, terminals, printer, VT11 display) are
committed with the **Apply** button, which restarts the machine so the emulated
hardware matches the configuration; print widths, the teletype speed, the Upper
Case Only flag, the key click, the reverse video, the CRT effects, the VT52 text
mode, the machine hum and the photo backdrop apply immediately. A **Restore defaults** button fills the
form with factory values (committed by **Apply**).
The hum is synthesized with Web Audio on its own audio channel, so it never
cuts off the teletype/printer or the VT52 key-click sounds.
A round **mute** button pinned to the bottom-left corner (just right of the
navigation sidebar) toggles *all* sounds at once — hum, teletype/LP11, paper
feed/tear, VT52 key clicks, the bell and the mechanical click of every
switch, button and teletype key — like a checkbox; its state is persisted
with the rest of the configuration.
The Model 33 ASR tape unit is audible too, synthesized with Web Audio like the
switch clicks: the reader rattles (a ratchet "стрёкот") for every byte it
reads off the tape, the punch clicks crisply when its solenoids fire a data
byte, and punching an empty byte (NUL — only the feed hole) gives the same
quiet ratchet with no solenoid strike.

The **Storage** page manages the storage media in two tabs: **Images** (the
drag & drop disk/tape image drop zone, the mounted-images/Unmount list and
the disk export) and **Paper Tapes** (the paper-tape reader file selector, a
small `.ptap` drop zone and the punch-tape export). Images dropped there are
mounted into DataLoader and persist in IndexedDB across sessions. The drop
target (including the full-window one) appears only while the Storage page
is active.

The **REBOOT** button is a round button with a restart icon, pinned to the
top-left corner of the window just right of the navigation sidebar (mirroring
the sound-mute button in the bottom-left corner; a tooltip describes it).
Pressing it restarts the machine; when Auto-boot is enabled it also boots the
built-in default loader. By default a confirmation dialog asks first, with a
"Don't show this warning
anymore" option. The warning can be restored at any time from the Config
page's **Behaviour** tab.

Next to REBOOT sits the round **STATE** button — the machine-state dialog. It
saves and restores the whole emulated PDP-11, not just the CPU: registers,
memory, every I/O device (console, terminals, printer, disks, tape and the
paper-tape reader/punch), the paper in the teletype and LP11, the VT52 screen
contents and the VT11 vector picture. **Save state** captures the machine as
it is now under an auto-generated name; **Load** restores a state (re-applying
its hardware configuration and restarting the machine, with a confirmation
first), and **Rename / Delete** organise the list. States live in the
browser's IndexedDB, survive reloads and sessions, and states saved by older
emulator versions keep working. Both buttons appear on the Panel, Console
(teletype or VT52) and TTY pages.

The **Printer** page renders the LP11 output on an animated paper machine (no
keyboard) and offers **Print** (send the accumulated jobs to the real OS printer
via the system dialog) and **Save .txt** buttons. Like the real LP11, it echoes
characters far faster than the Model 33 ASR console teletype (the console keeps its
authentic ~33 cps pacing) and prints on a wide 132-column paper at close to the
original's ~300 lines/min. The LP11 also honours the historical DONE handshake: writing LPDB clears DONE and re-asserts it as each character is actually consumed by the mechanism, so a guest print job is throttled at printer speed instead of being dumped into the buffer ahead of the paper. When the printer is OFF LINE (or powered off) the controller latches a sticky ERROR flag in LPCS while keeping DONE set, so a guest OS driver reports an error (e.g. `?LP0: I/O error`) instead of silently discarding the job. Both the teletype and the printer size their paper
to the configured print width (centred in the machine body), so a full line
always reaches the paper edge. Both also advance the carriage to the next
8-column tab stop on TAB, matching real Model 33 ASR / LP11 behaviour. Like the
VT52 console, the LP11 cabinet auto-scales down proportionally to fit the
window when it gets too small (transform: scale, driven by a ResizeObserver),
so the full-width machine is never clipped on narrow screens — and the rising
fanfold paper still climbs the same fraction of the window after scaling. The
front panel uses the same trick: on narrow windows (or at a high UI zoom) the
panel and its "Help Me!" bootstrap sticker shrink together — the fit reserves
the sticker's measured, rotated bounding box — so the note never slides under
the navigation sidebar. The Model 33 ASR teletype rig scales the same way: on
short windows it shrinks to stay inside the window top and above the operator
buttons (its viewport-driven paper and hanging tape divide their max-heights
by the scale, so they still reach the window edges).

Both also honour form feed (FF, 0x0C): the 2.11BSD spooler (`lpr`/`lpd`) sends
FF between print jobs so each starts on a fresh page. The LP11 ejects to the
top of the next fanfold page — it fills the rest of the sheet (66 lines at
6 LPI for an 11″ page) and closes it with a dashed fold/perforation marker;
the Model 33 ASR console teletype (which also supported FF via its FORM key) simply
advances its smooth paper roll. The **Save .txt** export keeps a `\f` marker so
the real page breaks survive in the file.

## Panel tricks

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
