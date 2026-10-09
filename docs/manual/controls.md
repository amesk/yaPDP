## Buttons, Shortcuts & Indicators

### Switching pages

Use the sidebar to switch between:

- **[Panel](#front-panel)** — the front panel with switches and LEDs.
- **[Console](#console)** — the operator console: a Model 33 ASR teletype, or a DECscope VT52 / DEC VT100 when the console terminal is a video terminal.
- **[TTY 1 / TTY 2](#user-terminals)** — user video terminals (VT52 or VT100), shown only when configured.
- **[Printer](#printer)** — the LP11 line printer page, shown only when configured.
- **[Display](#vt11)** — the VT11 vector-graphics CRT page, shown only when configured.
- **[Storage](#storage)** — storage media in two tabs: Images (drop zone, mounted images) and Paper Tapes (reader, punch export).
- **[Config](#config)** — configure the emulated peripherals (persisted between sessions).
- **Info** — detailed instructions, OS reference and the About block (version, website, author and license; the version marker at the bottom of the sidebar opens this page).

### Floating controls

| Control | Where | What it does |
|---|---|---|
| {.disk .control-cell} ![Magic wand](assets/images/manual/btn-magicwand.png){.control-btn} Magic wand{.control-name} | Top-right corner (every page except Info) | Quick-boot picker — chooses a guest OS, reconfigures, reboots and types the boot/login. See [Quick Start](#quick-start). |
| {.disk .control-cell} ![Reboot](assets/images/manual/btn-reboot.png){.control-btn} Reboot{.control-name} | Top-left corner, just right of the sidebar (Panel, Console and TTY pages) | Round button with a restart icon. Restarts the machine; when a Boot device is configured (see CONFIG) it also boots. By default a confirmation dialog asks first, with a "Don't show this warning anymore" option. The dialog also carries a Boot device shortcut — pick None, Interactive loader (@) or Last medium: it is the CONFIG Boot device option itself, persists, and stays in sync with the CONFIG page. With None the machine halts after the reboot. The confirmation dialog is shown below. |
| {.disk .control-cell} ![Mute](assets/images/manual/btn-mute.png){.control-btn} Mute{.control-name} | Bottom-left corner, just right of the sidebar | Round button that toggles *all* sounds at once — hum, teletype/LP11, paper feed/tear, key clicks and the bell. State is persisted with the rest of the configuration. |
| {.disk .control-cell} ![Screenshot](assets/images/manual/btn-screenshot.png){.control-btn} Screenshot{.control-name} | Bottom-left corner, next to Mute | Round camera-icon button. Left-click saves a PNG of the active page (cabinet, bezel, screen and panel); right-click opens a menu: Save image, Copy to clipboard, Share… |
| {.disk .control-cell} ![Fullscreen](assets/images/manual/btn-fullscreen.png){.control-btn} Fullscreen{.control-name} | Bottom-right corner of the window | Floating button that hides the browser/system chrome (address bar, OS window frame, taskbar) while leaving the emulator UI untouched. Press again or Esc to return. |
| {.disk .control-cell} ![Terminal zoom](assets/images/manual/btn-zoom.png){.control-btn} Terminal zoom{.control-name} | Bottom-right corner, left of the fullscreen button | Floating button that hides the terminal cabinet and grows the tube to the largest 4:3 box the window allows. The state is remembered per terminal. |

![Reboot confirmation dialog](assets/images/manual/dialog-reboot.png){.shot}

The REBOOT button asks for confirmation by default: the dialog carries the
[Boot device](#config) shortcut (None / Interactive loader / Last medium) and the
"Don't show this warning anymore" option.{.shot-caption}

### Sidebar activity lamps

Each output sidebar button has a small blinking green LED in its top-right corner: it pulses while the
PDP-11 writes output to that console/terminal (and blinks for the whole print job on the [Printer](#printer)
button), then switches off about half a second after the output stops.
