## The Operator Console

The operator console is what the PDP-11 uses as its `TT0:` — the machine's own typewriter.
Depending on the [CONFIG page](#config), it is a **Model 33 ASR teletype** or one of the
two video terminals: a **DECscope VT52** (see below) or a **DEC VT100**.

### Model 33 ASR teletype

The console is rendered as an authentic light-cream/beige Model 33 ASR: a paper roll behind the rising
sheet, a glass carriage window, and a stamped Teletype Corporation logo on the lower face plate.

![The Model 33 ASR operator console](assets/images/manual/console-teletype.png){.shot}

The Model 33 ASR operator console at the @ prompt.{.shot-caption}

- Keyboard. Round dark keycaps with light two-line legends — the base glyph centred, the CTRL-code name or shift symbol above — plus the historical special keys: ESC, LINE FEED, RETURN, DELETE, HERE IS (answerback), REPT (auto-repeat) and BREAK (asserts the console DL11 break condition).
- Upper Case Only. The on-screen keycaps always send upper-case letters. The physical keyboard folds a – z to A – Z only when the Upper Case Only [CONFIG](#config) option is enabled (off by default, so 2.11 BSD receives lower case).
- Force PDP Output Uppercase. A real Model 33 ASR print mechanism has no lower-case type, so machine output is printed in upper case (on by default) and a loader that writes lower case cannot put those letters on the paper. The punched tape still records the *raw* byte — reading such a tape in LOCAL prints upper case, while in LINE the original lower case reaches the machine.
- Paper printing. Authentic nroff/man overstrike (^H) rendering: re-printing the same glyph gives bold, underscores give underline, and striking a *different* glyph leaves the real dark overstrike blot a hard-copy terminal makes.
- Margins. Long lines faithfully jam the carriage at the right margin (72 or 80 columns); characters overstrike the last column instead of wrapping. The paper width follows the selected width so a full line reaches the paper edge. The paper is anchored to the carriage and grows upward out of the top of the machine body; once its edge reaches the top of the window, a scrollbar appears and the view follows the freshly printed line.
- ASR reader/punch. Beside the machine sits the ASR tape reader/punch unit. Every byte echoed to the console punches a matching row of holes on an 8-track paper tape (tracks 1–7 = ASCII, track 8 = parity). As on a real ASR-33 the punch is OFF by default — enable it from the [CONFIG page](#config) or its own control. Both hanging tapes swing briefly on every step of the mechanism; once a tape reaches the bottom of the window it is scrolled with the mouse wheel (neither tape draws a scrollbar).
- Paper-tape reader. The Load tape button below the machine opens a file dialog and inserts a paper tape into the reader — a raw.ptap (as saved by the punch or the Storage page), a compressed.ptap.zst, or a plain.txt whose characters become 7-bit tape codes. The full tape hangs from the reader slot down to the bottom of the window, its ragged free end torn like the punched tape's — once it reaches the bottom it is scrolled with the mouse wheel (like the punched tape, it draws no scrollbar). As the tape is read it visibly moves up through the slot and shortens, swinging on every byte; when the last byte is read the tape has gone into the machine and a new one can be loaded.
- Reader switch. The four-position switch on the TAPE READER cabinet governs reading: START — runs the reader continuously, sending the tape to the machine at the console speed (authentic ~10 chars/sec or the fast [CONFIG](#config) pace);
- AUTO — sends one byte and then feeds the next only when the machine's DL11 has accepted the previous one (paused by DC3 / X-OFF, resumed by DC1 / X-ON);
- STOP — pauses;
- FREE — releases the tape and shows the Remove tape from reader button (hidden in every other mode) to pull it out.

Clicking a position label jumps straight to it; clicking the round switch disc itself turns it
one detent clockwise (**START → STOP → FREE → AUTO**), like rotating the real switch.

- CCU knob. The LINE / OFF / LOCAL knob on the apron works the same way: click a label to jump, or click the knob itself to turn it one detent clockwise (LINE → OFF → LOCAL). The CCU routes every read byte exactly like the keyboard: in LOCAL the tape prints on the paper only (a tape-to-paper copy, nothing reaches the machine); in LINE it is sent to the machine and printed by the machine's echo — printing locally too would double every character on echoing guests.
- Duplicating tapes. With the punch engaged (ON), every read byte is also punched onto the output tape — the classic ASR trick for copying tapes (reader in, fresh tape out).

### VT52 as the console

When the console terminal is set to a VT52, the operator console becomes a DECscope with its authentic
white/grey (P4) phosphor on a black tube — see [User Terminals](#user-terminals) below for
the full behaviour, which is shared.

![A DECscope VT52 as the operator console](assets/images/manual/console-vt52.png){.shot}

A DECscope VT52 as the operator console, showing the @ prompt.{.shot-caption}

### VT100 as the console

Set the console terminal to **VT100** and the console becomes a **DEC VT100** — the ANSI terminal
that succeeded the DECscope. It is drawn in its own cabinet, at its own proportions (the artwork is the
terminal's, not a restyled DECscope), and it shares everything that is not the tube itself: the page
layout, the zoom button and double-click zoom, the STATE/REBOOT placement and the keyboard handling.

![A DEC VT100 as the operator console](assets/images/manual/console-vt100.png){.shot}

A DEC VT100 as the operator console, showing the @ prompt.{.shot-caption}

A VT100 is a **superset of the VT52**, exactly as the hardware was: the DECscope sequences still work
and the terminal adds the ANSI grammar (CSI sequences, DEC private modes, scrolling regions, G0/G1
character sets), which it speaks from power-on — a VT100 is a CRT-only machine and has no hardcopy mode
to enter first. What never existed on the hardware is refused rather than faked: `ESC Y`
direct addressing, `ESC F`/`ESC G` graphics on/off, the VT52 keypad modes and the
VT52 identification reply. Asked who it is (`CSI c`) the VT100 answers
`VT100 with AVO`, and `CSI ? 2 h` (DECANM) drops it into VT52 compatibility mode,
as the real machine did.

Two CONFIG options belong to this terminal alone: the **tube phosphor** — P4
white, the phosphor the VT100 was introduced on, or P1 green — and the **key click** (the DECscope's
keyboard was mechanical and has no click to make). The **VT52 reverse video** switch is the
DECscope's own and never touches a VT100: there, inverse text comes from the SGR 7 attribute the
software sends.
