## Machine State (STATE button)

The round **STATE** button (top-left corner, right of [REBOOT](#controls)) opens the
machine-state dialog — a
full save/restore of the emulated PDP-11, not just the CPU: registers, memory, every I/O device
(console, terminals, printer, disks, tape and the paper-tape reader/punch), the paper in the teletype
and LP11, the video-terminal screen contents (VT52 and VT100 alike) and even the VT11 vector-display
picture are all captured. Think of it as a save file of the whole machine.

![The machine-state dialog](assets/images/manual/dialog-state.png){.shot}

The machine-state dialog with one freshly saved state.{.shot-caption}

- Save state — captures the machine exactly as it is right now under an auto-generated name (date and time). The hardware configuration is part of the state: restoring it re-applies the console type, user terminals, printer and VT11 display, restarting the machine to match.
- Load — restores the selected state and restarts the machine; a confirmation asks first. States saved by older versions of the emulator keep working.
- Rename / Delete — organise the list or remove states; the counter next to the list shows how many states you have.

The STATE button mirrors [REBOOT](#controls) and is available on the **Panel**, **Console** (teletype, VT52 or
VT100) and **TTY** pages. States are stored in the browser's IndexedDB and survive reloads and
sessions.
