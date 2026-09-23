## Configuration (Config page)

The Config page controls the emulated peripherals and is persisted between sessions. The form is split
into four tabs, with the **Apply** and **Restore defaults** actions in a bar below the tabs:

:::config-item
![CONFIG - Equipment tab](assets/images/manual/config-equipment.png){.config-item-img}
:::config-item-text
### Equipment
- Console terminal — the [operator console](#console) (tty0): a Model 33 ASR teletype, a DECscope VT52 or a DEC VT100.
- User terminals — the two [user terminals (TTY 1 / TTY 2)](#user-terminals), each `None | VT52 | VT100` and each with its own sidebar page; the number of terminals is read off the two selects, and TT2 can only be filled once TT1 is.
- Line printer (LP11) — install the animated LP11 line printer on its own [Printer page](#printer).
- VT11 graphics display — install the DEC VT11 vector-graphics terminal on its own [Display page](#vt11).
- Teletype print width — 72 or 80 columns for the Model 33 ASR console (a teletype is at most an 80-column machine).
- Printer width — 72/80/100/132 columns for the LP11 printer page.
- Teletype speed — authentic (real 110-baud Model 33 ASR, ~10 chars/sec) or fast development pace.
- Upper Case Only — send letters from the physical keyboard in upper case (authentic Model 33 ASR); off by default so lower-case (e.g. 2.11 BSD file names) passes through.
- Force PDP Output Uppercase — print machine output in upper case (authentic Model 33 ASR, which cannot print lower case); on by default. The paper tape keeps the raw code, and a video terminal (VT52 or VT100) is not affected at all — both print lower case.
:::

:::config-item
![CONFIG - Look & sound tab](assets/images/manual/config-visual.png){.config-item-img}
:::config-item-text
### Look & sound
- VT100 key click — audible key-click feedback on VT100 terminals; the DECscope keyboard was mechanical and has no click to make, so the field dims when no VT100 is installed.
- VT100 phosphor — the VT100 tube: P4 white (the phosphor it was introduced on) or P1 green. The DECscope is pinned to P4 — it was never sold with another.
- VT52 reverse video — the historical DECscope reverse-video mode: black text on white. It is the DECscope’s own switch; a VT100 shows inverse text only when the software asks for it with the SGR 7 attribute.
- CRT effects — pure-CSS CRT simulation: brightness flicker, phosphor shimmer and a vertical-hold roll band.
- Machine hum — ambient power-supply hum and fan noise while the machine is on.
- Photo backdrop — show the PDP-11 machine-room photo behind the pages.
:::

:::config-item
![CONFIG - Behaviour tab](assets/images/manual/config-behaviour.png){.config-item-img}
:::config-item-text
### Behaviour
- Reboot confirmation — ask before rebooting the machine; the "Don't show this warning anymore" option can be restored here at any time.
- Help Me! sticker — show the operator's hand-written bootstrap sticky note on the Panel page.
- Machine power — the machine is powered on; switching it off powers down the PDP-11 (POWER LOCK in the off position).
- Auto-boot — start the default bootstrap automatically when the machine is powered on or rebooted. The reboot confirmation dialog offers a shortcut to this option (its "Start the default bootstrap automatically after reboot" checkbox).
- First-run hint — replay the first-run welcome overlay with quick-start boot suggestions on the next launch.
:::

:::config-item
![CONFIG - Development tab](assets/images/manual/config-development.png){.config-item-img}
:::config-item-text
### Development
- Plain text input instead of the canvas CRT — render the terminal as a text field instead of the canvas CRT, giving native text selection and Windows Clipboard (Ctrl+C / Ctrl+V / right-click paste) for fast source-code entry; loses SGR attributes (bold/underline/reverse). It acts on the page, so a VT52 and a VT100 terminal are both rendered this way.
:::

Leaving the Config page with uncommitted changes asks for confirmation, so nothing is lost silently:

![Unapplied configuration warning](assets/images/manual/dialog-config-leave.png){.shot}
The emulator warns before leaving Config with uncommitted changes.{.shot-caption}

**Structural changes** (console type, terminals, printer, VT11 display) are committed with
**Apply**, which restarts the machine so the emulated hardware matches the configuration. Print
widths, teletype speed, the Upper Case Only and Force PDP Output Uppercase flags, key click, reverse
video, CRT effects, VT52 text mode, machine hum and the photo backdrop apply immediately.
**Restore defaults** fills the form with
factory values (committed by **Apply**); the four live BEHAVIOUR options — **Reboot
confirmation**, **Help Me! sticker**, **Machine power** and **Auto-boot** — are reset
to their factory values immediately, without waiting for Apply (the machine powers down, since the
factory state is off).

The hum is synthesized with Web Audio on its own audio channel, so it never cuts off the
teletype/printer or the VT100 key-click sounds.
