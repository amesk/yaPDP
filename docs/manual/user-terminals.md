## User Terminals (TTY 1 / TTY 2)

Up to two user video terminals (shown only when configured on the CONFIG
page) let guest OSes
that prefer video terminals run side by side. Each is a **DECscope VT52** or a **DEC VT100**,
chosen independently (`None | VT52 | VT100`), and each is drawn in the cabinet of the
terminal you picked — the DECscope's slanted monoblock (an off-white moulded-plastic cabinet with a vent
grille, a recessed screen in a deep bezel and a plain side panel with a raised ridge) or the VT100's own
enclosure. Input comes from the physical keyboard, as on the original machines.

![A user VT52 terminal](assets/images/manual/terminal-vt52.png)

A user VT52 terminal (TTY 1) running an interactive session.

![A user VT100 terminal](assets/images/manual/terminal-vt100.png)

A user VT100 terminal (TTY 2) — same page, same behaviour, its own cabinet.

- Font. Text is rendered in the authentic fritzm/vt52 bitmap display font ( monospace is the fallback until the webfont loads).
- Clear screen. Clear screen (ESC E) and form feed ( ^L ) both wipe the display and home the cursor, so clear and multi-page nroff/man output start each page from the top row.
- CRT simulation (optional). A pure-CSS effect adds brightness flicker, scanline shimmer and a vertical-hold roll band.
- Text mode (optional). Renders the terminal as a plain text field instead of the canvas, enabling native text selection and Windows Clipboard ( Ctrl+C / Ctrl+V / right-click paste) for fast source-code entry — at the cost of the SGR emphasis rendering.
