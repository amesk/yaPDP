// ============================================================================
// DEC terminal core
// ----------------------------------------------------------------------------
// The dialect-independent half of the yaPDP terminal emulator: sparse screen
// buffer, cursor physics, scroll regions, destructive operations, character
// output with overstrike handling, SGR attributes, the three rendering paths
// (LA36 hardcopy / textarea screen / canvas screen), and the artwork
// projection that publishes the cabinet's Screen marker as CSS variables.
//
// This module is ENGINE ONLY — it ships no dialect of its own. A dialect
// supplies the escape grammar and the keymap, and decides whether the terminal
// boots into LA36 hardcopy or straight into screen mode. Everything that
// differs between a VT52 and a VT100 belongs in a dialect; everything that
// makes a DEC terminal feel like a DEC terminal lives here.
//
// Loaded AFTER config.js and BEFORE any dialect module.
// ============================================================================

(() => {
    'use strict';
    // =========================================================================
    // Terminal Constants
    // -------------------------------------------------------------------------
    // These values define the default geometry, control characters, rendering
    // parameters, and attribute bitmasks used throughout the emulator.
    //
    // The goal is to keep all “magic numbers” in one place so that behaviour is
    // easy to audit and modify without hunting through the code.
    // =========================================================================

    // Default terminal geometry
    const DEFAULT_ROWS = 24;
    const DEFAULT_COLS = 80;
    const MAX_COLS_132 = 132;     // DECCOLM 80/132 column mode
    const MAX_BUFFER   = 20000;   // Hardcopy scrollback limit

    // Authentic DEC VT52 tube aspect ratio (width / height): the 80x24 grid is
    // drawn on a 4:3 CRT, so character cells are taller than they are wide.
    const CRT_ASPECT = 4 / 3;

    // Control characters (7‑bit ASCII)
    const BS  = 8;    // Backspace
    const TAB = 9;    // Horizontal tab
    const LF  = 10;   // Line feed (no carriage return)
    const FF  = 12;   // Form feed (VT52/VT100: clear screen + cursor home)
    const CR  = 13;   // Carriage return (no line feed)
    const ESC = 27;   // Escape introducer
    const SO  = 0x0E; // Shift Out  → select G1
    const SI  = 0x0F; // Shift In   → select G0
    const DEL = 127;  // Delete

    // Printable ASCII range
    const ASCII_PRINTABLE_MIN = 32;
    const ASCII_PRINTABLE_MAX = 126;

    // CSI private prefix ('?')
    const CSI_PRIVATE = 63;

    // Canvas rendering parameters (defaults — overridden by instance properties)
    // A real DECscope VT52 uses a white (P4) phosphor, not green: the text is
    // a light-grey / cold-white (#E0E0E0 / #F0F8FF) on a very dark grey-green
    // glass tube (the actual VT52 faceplate, not pure black).
    const BG_COLOR    = "#141914";  // Dark grey-green CRT glass background
    const FG_COLOR    = "#E0E0E0";  // Light-grey P4 phosphor writing

    // Attribute bitmask flags (SGR)
    const ATTR_BOLD       = 1;
    const ATTR_UNDERSCORE = 2;
    const ATTR_BLINK      = 4;
    const ATTR_REVERSE    = 8;

    // =========================================================================
    // Terminal Registry
    // -------------------------------------------------------------------------
    // Multiple terminal instances may exist (e.g., DL11 multiplexing). Each
    // instance is keyed by a “unit” number and stored here.
    // =========================================================================
    // Dialect hooks. The engine never inspects the dialect's own state (its
    // VT52/VT100 mode flag, its keymaps, its graphics tables): it asks the
    // dialect. A dialect that predates the seam — or one loaded without calling
    // registerDialect() — falls back to the plain DEC default, so the engine is
    // always safe to run on its own.
    function attrMask(machine) {
        const inst = machine && machine.attrMask;
        if (typeof inst === "function") return inst.call(machine);
        const fn = Dialect && Dialect.attrMask;
        return (typeof fn === "function") ? fn.call(Dialect) : -1;   // -1 = draw every attribute
    }

    function cursorIsBlock(machine) {
        const inst = machine && machine.cursorIsBlock;
        if (typeof inst === "function") return !!inst.call(machine);
        const fn = Dialect && Dialect.cursorIsBlock;
        return (typeof fn === "function") ? !!fn.call(Dialect) : true;  // DEC default: block
    }

    function graphicsChar(machine, ch) {
        const inst = machine && machine.graphicsChar;
        if (typeof inst === "function") return inst.call(machine, ch);
        const fn = Dialect && Dialect.graphicsChar;
        return (typeof fn === "function") ? fn.call(Dialect, machine, ch) : ch;
    }

    // The dialect class currently bound to this engine (see registerDialect).
    // The VT52/VT100 static tables live on the dialect, so the inherited
    // methods reach them through this reference rather than a bare class name.
    let Dialect = null;

    const VT = new Map();

    // =========================================================================
    // Terminal Core
    // =========================================================================
    class Core {

        // Constructor / Reset
        // ----------------------------------------------------------------------------
        // Each Terminal instance represents a single VT52/VT100 hybrid terminal.
        // The constructor initialises:
        //   • core state (cursor, margins, modes, parser)
        //   • the sparse screen buffer
        //   • optional canvas rendering pipeline
        //   • event bindings for keyboard input
        //
        // The emulator supports three rendering modes:
        //
        //   1) Hardcopy mode (LA36‑style):
        //        - Output scrolls indefinitely in a <textarea>
        //        - No screen buffer, no cursor addressing
        //
        //   2) Textarea screen mode:
        //        - Uses the screen buffer but renders via <textarea>
        //        - No bold/blink/reverse attributes
        //
        //   3) Canvas screen mode:
        //        - Attribute rendering (bold, underline, blink, reverse)
        //        - Pixel‑accurate cursor and cell‑level redraws
        //
        // The terminal begins in LA36-style hardcopy mode. Screen mode is entered
        // lazily when cursor addressing or screen semantics are first required.
        // ============================================================================

        constructor({ unit, receiveRoutine, textArea, screenCanvas,
                      rows = DEFAULT_ROWS, cols = DEFAULT_COLS,
                      allowCanvas = false, noHardcopyFallback = false,
                      fontSize = 16, screenPadding = 12,
                      fontFamily = 'monospace' }) {

            // External wiring
            this.unit = unit;
            this.receiveRoutine = receiveRoutine;
            this.textArea = textArea;
            this.screenCanvas = screenCanvas;

            // Geometry
            this.rows = rows;
            this.cols = cols;

            // Mode flags
            this.modes = {
                screen: false,   // false = hardcopy mode
                dialect: false,  // the dialect's own mode flag (VT52 vs VT100)
                origin: false,   // DECOM (origin mode)
                insert: false,   // IRM (insert/replace mode, CSI 4 h/l)
                wrap: true,      // DECAWM (auto-wrap at the right margin)
                appCursor: false,// DECCKM (application cursor keys)
                cursorVisible: true, // DECTCEM (cursor on/off)
                keypad: false    // Application keypad mode
            };

            // Character set + SGR attributes
            this.graphics = {
                vt52: false,          // VT52 graphics mode
                activeSet: 0,         // 0 = G0, 1 = G1
                enabled: [false, false], // G0/G1 graphics enabled flags
                sgr: 0                // Attribute bitmask (bold/underline/blink/reverse)
            };

            // Scroll region (DECSTBM)
            this.margin = {
                top: 0,
                bottom: this.rows     // Exclusive bottom margin
            };

            // Cursor state
            this.cursorRow = 0;
            this.cursorCol = 0;

            // DECSC/DECRC (ESC 7 / ESC 8) saved cursor position + attributes
            this.savedCursor = { row: 0, col: 0, sgr: 0 };

            // DECAWM pending wrap: armed when a printable lands on the last
            // column; the next printable wraps to the start of the next line.
            this.wrapPending = false;

            // Hardcopy overhang:
            // Number of characters after the cursor in the textarea (bumped by CR/BS)
            this.overHang = 0;

            // Font metrics (may be overridden via fontSize / fontFamily options)
            // fontFamily is a full CSS font stack; 'monospace' is the built-in
            // fallback used until the authentic VT52 webfont finishes loading.
            this.fontSize   = fontSize;
            this.fontFamily = fontFamily;
            this.fontHeight = this.fontSize;
            this.textFont   = this.fontSize + "px " + fontFamily;
            this.boldFont   = "bold " + this.fontSize + "px " + fontFamily;
            this.underlineHeight = Math.max(1, Math.floor(this.fontSize / 8));
            // Vertical centring offset for glyphs (see computeGlyphBaselineOffset).
            this.glyphBaselineOffset = 0;

            // Inner margin (px) around the cell grid so glyphs don't touch the
            // CRT bezel edge. The canvas is widened by 2*screenPadding and the
            // margin is painted with the background colour (renderCanvas).
            this.screenPadding = screenPadding;

            // Phosphor colours: normal mode is white/grey (P4) text on black.
            // The historical DECscope reverse-video mode swaps them (black text
            // on white/grey) and is enabled via setReverseVideo().
            this.reverseVideo = false;
            this.fgColor = FG_COLOR;
            this.bgColor = BG_COLOR;

            // Sparse screen buffer:
            // Each row is an array of { c: charCode, a: attributes }.
            // Rows and columns are allocated lazily.
            this.screen = [];

            // Escape sequence parser state
            this.parser = {
                buffer: [],   // Accumulated bytes for ESC / CSI sequences
                state: 0      // 0 = initial, -n = waiting for n chars, +n = CSI parameter at n
            };

            this.allowCanvas = allowCanvas;   // canvas mode now configurable via options
            this.noHardcopyFallback = noHardcopyFallback;  // set true to disable auto-switch to textarea (VT52 CRT)
            this.debug = false;

            // -------------------------------------------------------------------------
            // Canvas rendering pipeline (optional)
            // -------------------------------------------------------------------------
            if (this.screenCanvas) {
                const ctx = this.screenCanvas.getContext("2d");
                this.resetCanvasContext(ctx);

                const metrics = ctx.measureText("M");
                this.canvas = {
                    ctx: ctx,
                    charWidth: metrics.width,
                    blinkCycle: false,
                    lastCursor: { row: -1, col: -1 }
                };
                this.computeGlyphBaselineOffset();

                // Bind keyboard events for canvas mode
                this.bindEvents(this.screenCanvas);

                // Classic VT100 blink rate (500ms)
                setInterval(() => {
                    this.canvas.blinkCycle = !this.canvas.blinkCycle;
                    if (this.modes.screen) this.blinkCells();
                }, 500);
            } else {
                this.allowCanvas = false;
            }

            // Bind keyboard events for textarea mode
            this.bindEvents(this.textArea);
        }

        // ============================================================================
        // Reset terminal to power‑on state
        // ============================================================================
        reset() {
            this.modes    = { screen: false, dialect: false, origin: false, insert: false,
                              wrap: true, appCursor: false, cursorVisible: true, keypad: false };
            this.graphics = { vt52: false, activeSet: 0, enabled: [false, false], sgr: 0 };
            this.margin   = { top: 0, bottom: this.rows };

            this.cursorRow = 0;
            this.cursorCol = 0;
            this.overHang  = 0;
            this.savedCursor = { row: 0, col: 0, sgr: 0 };
            this.wrapPending = false;

            this.parser = { buffer: [], state: 0 };

            this.clearScreen();

            if (this.noHardcopyFallback) {
                // VT52 CRT (RIS / ESC c): stay on the canvas screen. Falling
                // back to the hardcopy <textarea> would swap the authentic
                // P4 phosphor for the browser's default monospace rendering.
                this.modes.screen = true;
                if (this.allowCanvas) {
                    this.textArea.style.display = "none";
                    this.screenCanvas.style.display = "block";
                    this.renderCanvas();
                }
            } else {
                this.enterHardcopyMode();
            }
        }

        // ============================================================================
        // Enter hardcopy mode (LA36‑style scrolling output)
        // ============================================================================
        enterHardcopyMode() {
            if (this.modes.screen) {
                if (this.allowCanvas) {
                    if (this.noHardcopyFallback) {
                        // VT52 CRT: never reveal the hardcopy <textarea> in
                        // place of the authentic white/grey canvas phosphor.
                        this.textArea.style.display = "none";
                        this.screenCanvas.style.display = "block";
                    } else {
                        this.textArea.style.display = "block";
                        this.screenCanvas.style.display = "none";
                    }
                }

                // If switching from screen mode, dump the screen buffer into the textarea
                this.textArea.value = this.screen
                    .map(line => line.map(cell => String.fromCharCode(cell.c)).join(""))
                    .join("\n") + "\n";

                this.textArea.focus();
            }

            this.cursorCol = 0;
            this.overHang = 0;
            this.modes.screen = false;
            this.textArea.scrollTop = this.textArea.scrollHeight;
        }

        // ============================================================================
        // Enter screen mode (textarea or canvas)
        // ----------------------------------------------------------------------------
        // Convert textarea content into a screen buffer
        // ============================================================================
        enterScreenMode() {
            // Take the last N rows of textArea, trim trailing spaces, clamp to terminal width
            this.screen = this.textArea.value
                .split("\n")
                .slice(-this.rows)
                .map(line =>
                    line.trimEnd()
                        .slice(0, this.cols)
                        .split("")
                        .map(ch => ({ c: ch.charCodeAt(0), a: 0 }))
                );

            this.cursorRow = 0;
            this.cursorCol = 0;
            if (this.screen.length > 0) {
                this.cursorRow = this.screen.length - 1;
                this.cursorCol = Math.max(0, this.screen[this.cursorRow].length - 1 - this.overHang);
            }

            if (this.allowCanvas) {
                this.textArea.style.display = "none";
                this.screenCanvas.style.display = "block";
                this.screenCanvas.focus();
            }

            this.modes.screen = true;
        }

        // ============================================================================
        // Canvas Rendering Pipeline
        // ----------------------------------------------------------------------------
        // When a <canvas> element is provided, the terminal renders using a pixel-
        // accurate cell grid. This enables historically correct VT100 attributes:
        //   • bold (SGR 1)
        //   • underline (SGR 4)
        //   • blink (SGR 5)
        //   • reverse video (SGR 7)
        //
        // The canvas renderer draws only the cells that change, and uses a 500ms
        // blink timer to toggle both blinking text and the block cursor.
        //
        // The rendering model is cell-based:
        //   - Each character cell is FONT_HEIGHT pixels tall
        //   - Each cell is canvas.charWidth pixels wide (measured from "M")
        //   - The screen buffer stores charCode + attribute bitmask
        //
        // This subsystem is intentionally simple and predictable so contributors can
        // extend it (e.g., phosphor decay, CRT scanlines, colour support).
        // ============================================================================

        resetCanvasContext(ctx) {
            // Reset all canvas drawing state after a resize or mode switch.
            // Canvas resets wipe font, fillStyle, and baseline, so we restore them.
            // "middle" lets renderText vertically centre each glyph via the
            // measured glyphBaselineOffset, keeping it aligned with the cursor.
            ctx.textBaseline = "middle";
            ctx.fillStyle = this.bgColor;
            ctx.font = this.textFont;

            // Horizontal squeeze to fill the authentic 4:3 tube: cells and glyphs
            // are drawn in logical grid units and mapped onto the physical canvas
            // by setTransform. setTransform replaces (not compounds) the previous
            // transform, so repeated resizes never accumulate a scale.
            const sx = (this.canvas && this.canvas.scaleX) || 1;
            ctx.setTransform(sx, 0, 0, 1, 0, 0);

            // Track current drawing modes so we can avoid redundant state changes.
            this.fgMode = false;   // false = background colour, true = foreground colour
            this.boldMode = false; // false = normal font, true = bold font
        }

        // ---------------------------------------------------------------------------
        // Foreground / background colour switching
        // ---------------------------------------------------------------------------
        // fg = true  → draw using the foreground phosphor colour
        // fg = false → draw using the background phosphor colour
        // The active colours depend on the reverse-video mode (setReverseVideo).
        setForeground(fg) {
            if (fg) {
                if (!this.fgMode) this.canvas.ctx.fillStyle = this.fgColor;
            } else {
                if (this.fgMode) this.canvas.ctx.fillStyle = this.bgColor;
            }
            this.fgMode = fg;
        }

        // ---------------------------------------------------------------------------
        // Historical reverse-video mode (DECscope VT52)
        // ---------------------------------------------------------------------------
        // With reverse video the whole screen swaps its phosphor colours: black
        // text on the white/grey tube instead of the normal white/grey text on
        // black. Enabled from the CONFIG page; repaints the canvas immediately.
        setReverseVideo(reverse) {
            this.reverseVideo = !!reverse;
            this.fgColor = this.reverseVideo ? BG_COLOR : FG_COLOR;
            this.bgColor = this.reverseVideo ? FG_COLOR : BG_COLOR;

            if (this.allowCanvas) {
                this.resetCanvasContext(this.canvas.ctx);
                this.renderCanvas();
            }
        }

        // ---------------------------------------------------------------------------
        // Bold font switching
        // ---------------------------------------------------------------------------
        setBold(bold) {
            if (bold) {
                if (!this.boldMode) this.canvas.ctx.font = this.boldFont;
            } else {
                if (this.boldMode) this.canvas.ctx.font = this.textFont;
            }
            this.boldMode = bold;
        }

        // ---------------------------------------------------------------------------
        // Cell-to-pixel helpers
        // ---------------------------------------------------------------------------
        // Every cell is offset by the inner margin (screenPadding) so that glyphs
        // sit clear of the CRT bezel edge on all four sides.
        cellX(col) {
            return this.screenPadding + col * this.canvas.charWidth;
        }
        cellY(row) {
            return this.screenPadding + row * this.fontHeight;
        }

        // ---------------------------------------------------------------------------
        // Authentic 4:3 tube geometry for the current grid
        // ---------------------------------------------------------------------------
        // A real DEC VT52 drew its 80x24 grid on a 4:3 CRT, so the natural
        // monospace grid (cols x charWidth by rows x fontHeight) is wider than
        // the tube. The canvas path squeezes it horizontally via
        // ctx.setTransform(scaleX); the text-mode <textarea> mirrors the same
        // scaleX as a CSS transform. Single source of truth for both the canvas
        // (resizeCanvas) and the host (pdp11-app.js).
        gridMetrics() {
            if (!this.canvas) {
                return { logicalW: 0, logicalH: 0, width: 0, height: 0, scaleX: 1 };
            }
            const logicalW = this.screenPadding * 2 + this.cols * this.canvas.charWidth;
            const logicalH = this.screenPadding * 2 + this.rows * this.fontHeight;
            const width    = Math.round(logicalH * CRT_ASPECT);
            const scaleX   = logicalW > 0 ? width / logicalW : 1;
            return { logicalW, logicalH, width, height: logicalH, scaleX };
        }

        // ---------------------------------------------------------------------------
        // Size the canvas to the current grid plus the inner margin
        // ---------------------------------------------------------------------------
        // Resizing a canvas wipes its drawing state (font/fillStyle), so the
        // context is restored afterwards. Single source of truth for the size,
        // used on startup (host) and on DECCOLM 80/132 switching.
        resizeCanvas() {
            if (!this.allowCanvas || !this.screenCanvas) return;
            const m = this.gridMetrics();
            this.canvas.scaleX = m.scaleX;
            this.screenCanvas.width  = m.width;
            this.screenCanvas.height = m.height;
            this.resetCanvasContext(this.canvas.ctx);
        }

        // ---------------------------------------------------------------------------
        // Vertical glyph centring within the cell
        // ---------------------------------------------------------------------------
        // Raster terminal fonts (e.g. vt52.otf) often carry internal padding above
        // and below the visible glyph inside their em box. Anchoring text at the
        // em-box top ("top" baseline) then leaves the glyph shifted low inside the
        // cell, so the block cursor (a full-height rectangle starting at cellY)
        // visibly pokes out above the character. Centring on the measured glyph
        // bounding box keeps glyphs aligned with the cursor for any font, while a
        // single constant offset (not per-glyph) preserves a fixed baseline across
        // a whole row. Falls back to 0 (cell-middle anchor) when metrics are
        // unavailable.
        computeGlyphBaselineOffset() {
            this.glyphBaselineOffset = 0;
            if (!this.canvas) return;
            try {
                const m = this.canvas.ctx.measureText("M");
                const ascent  = m.actualBoundingBoxAscent  || 0;
                const descent = m.actualBoundingBoxDescent || 0;
                this.glyphBaselineOffset = this.fontHeight / 2 + (ascent - descent) / 2;
            } catch (err) {
                this.glyphBaselineOffset = 0;
            }
        }

        // ---------------------------------------------------------------------------
        // Switch the canvas font after the webfont finishes loading
        // ---------------------------------------------------------------------------
        // The terminal is constructed with the monospace fallback so the page never
        // blocks on the font fetch; once the authentic VT52 webfont is ready, the
        // host (pdp11-app.js) calls this to re-measure the cell width from "M",
        // re-size the canvas to the new grid and repaint the CRT.
        setFont(fontFamily) {
            if (!fontFamily) return;
            this.fontFamily = fontFamily;
            this.textFont   = this.fontSize + "px " + fontFamily;
            this.boldFont   = "bold " + this.fontSize + "px " + fontFamily;
            if (this.canvas) {
                this.canvas.ctx.font = this.textFont;
                this.canvas.charWidth = this.canvas.ctx.measureText("M").width;
                this.computeGlyphBaselineOffset();
                this.resizeCanvas();   // re-applies ctx.font and re-sizes the grid
                this.render(true);     // full repaint with the new metrics
            }
        }

        // ---------------------------------------------------------------------------
        // Render a run of text with like attributes
        // ---------------------------------------------------------------------------
        // This draws:
        //   • background (or reverse video)
        //   • foreground text
        //   • underline (if enabled)
        renderText(row, col, attr, string) {
            const ctx = this.canvas.ctx;
            const h = this.fontHeight;
            const x = this.cellX(col);
            const y = this.cellY(row);

            // The dialect decides which attributes its hardware can actually
            // draw: a DECscope VT52 has no SGR emphasis, so bold and underline
            // must never reach the tube no matter how they landed in the cell
            // (overstrike or SGR). See Dialect.attrMask.
            attr &= attrMask(this);

            // Glyphs are drawn at the computed baseline so their visual centre
            // lines up with the cell centre (and the block cursor) for any font.
            const ty = y + (this.glyphBaselineOffset || 0);
            const w = string.length * this.canvas.charWidth;

            // Background (reverse video swaps fg/bg)
            this.setForeground(attr & ATTR_REVERSE);
            ctx.fillRect(x, y, w, h);

            // Foreground text. Bold is rendered as a double strike: the glyph
            // is drawn twice with a 1px horizontal offset. This stays visibly
            // heavier even when the browser ignores the "bold" weight of the
            // monospace font (some systems resolve "monospace" without a bold
            // face), and it matches how nroff overstrike produces bold.
            this.setForeground(!(attr & ATTR_REVERSE));
            this.setBold(attr & ATTR_BOLD);
            ctx.fillText(string, x, ty);
            if (attr & ATTR_BOLD) {
                ctx.fillText(string, x + 1, ty);
            }

            // Underline (drawn as a solid bar at bottom of cell)
            if (attr & ATTR_UNDERSCORE) {
                ctx.fillRect(x, y + h - this.underlineHeight, w, this.underlineHeight);
            }
        }

        // ---------------------------------------------------------------------------
        // Clear a rectangular region of a row
        // ---------------------------------------------------------------------------
        renderClear(row, col, end) {
            const ctx = this.canvas.ctx;
            const h = this.fontHeight;
            const x = this.cellX(col);
            const y = this.cellY(row);
            const w = (end - col) * this.canvas.charWidth;

            this.setForeground(false); // background colour
            ctx.fillRect(x, y, w, h);
        }

        // ---------------------------------------------------------------------------
        // Render a single cell (or clear if outside buffer)
        // ---------------------------------------------------------------------------
        renderCell(row, col) {
            if (row < this.screen.length && col < this.screen[row].length) {
                const cell = this.screen[row][col];
                this.renderText(row, col, cell.a, String.fromCharCode(cell.c));
            } else {
                // Cursor may be positioned beyond end of line
                this.renderClear(row, col, col + 1);
            }
        }

        // ---------------------------------------------------------------------------
        // Render a row by grouping runs of like attributes
        // ---------------------------------------------------------------------------
        // This reduces draw calls and matches how real terminals treat attributes:
        // attributes apply to a run of characters, not per‑character.
        renderRow(row, pos, end, blink) {
            for (let col = pos; col < end; col++) {
                let attr = this.screen[row][col].a;
                let string = String.fromCharCode(this.screen[row][col].c);

                // Find the longest run of identical attributes
                let idx;
                for (idx = col + 1;
                     idx < end && this.screen[row][idx].a === attr;
                     idx++) {
                    string += String.fromCharCode(this.screen[row][idx].c);
                }

                // Handle blinking text
                if (blink && (attr & ATTR_BLINK)) {
                    if (this.canvas.blinkCycle) {
                        // Off
                        this.renderClear(row, col, idx);
                    } else {
                        // On
                        this.renderText(row, col, attr, string);
                    }
                } else {
                    // Non-blinking
                    this.renderText(row, col, attr, string);
                }

                col = idx - 1; // Skip to end of run
            }
        }

        // ---------------------------------------------------------------------------
        // Block cursor rendering
        // ---------------------------------------------------------------------------
        // The cursor is drawn as a full block when blinkCycle = true.
        // When blinkCycle = false, the underlying cell is redrawn.
        drawCursor() {
            // DECTCEM (CSI ? 25 l) hides the cursor: erase any previously
            // drawn block cursor and do not repaint it.
            if (!this.modes.cursorVisible) {
                const lr = this.canvas.lastCursor.row;
                const lc = this.canvas.lastCursor.col;
                if (lr >= 0) {
                    this.renderCell(lr, lc);
                    this.canvas.lastCursor = { row: -1, col: -1 };
                }
                return;
            }

            const row = this.cursorRow;
            const col = this.cursorCol;

            // Erase old cursor if it has moved
            const lr = this.canvas.lastCursor.row;
            const lc = this.canvas.lastCursor.col;
            if (lr >= 0 && (lr !== row || lc !== col)) {
                this.renderCell(lr, lc);
            }

            const ctx = this.canvas.ctx;
            const h = this.fontHeight;
            const x = this.cellX(col);
            const y = this.cellY(row);

            if (this.canvas.blinkCycle) {
                // Cursor ON
                this.setForeground(true);
                if (cursorIsBlock(this)) {
                    // VT100-style full block cursor
                    ctx.fillRect(x, y, this.canvas.charWidth, h);
                } else {
                    // VT52-style underline cursor
                    ctx.fillRect(x, y + h - this.underlineHeight, this.canvas.charWidth, this.underlineHeight);
                }
                this.canvas.lastCursor = { row, col };
            } else {
                // Cursor OFF
                this.renderCell(row, col);
                this.canvas.lastCursor.row = -1;
            }
        }

        // ---------------------------------------------------------------------------
        // Blink timer: redraw blinking cells + cursor
        // ---------------------------------------------------------------------------
        blinkCells() {
            for (let row = 0; row < this.screen.length; row++) {
                this.renderRow(row, 0, this.screen[row].length, true);
            }
            this.drawCursor();
        }

        // ---------------------------------------------------------------------------
        // Full canvas redraw (e.g., after resize or clear)
        // ---------------------------------------------------------------------------
        renderCanvas() {
            const ctx = this.canvas.ctx;

            // Clear the whole physical canvas in device pixels first (identity
            // transform), then restore the horizontal squeeze for cell drawing —
            // otherwise the squeezed fillRect would only cover scaleX of the
            // width, leaving a stale band on the right edge.
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            this.setForeground(false);
            ctx.fillRect(0, 0, this.screenCanvas.width, this.screenCanvas.height);
            ctx.setTransform((this.canvas.scaleX || 1), 0, 0, 1, 0, 0);

            // Redraw all rows
            for (let row = 0; row < this.screen.length; row++) {
                this.renderRow(row, 0, this.screen[row].length, false);
            }
        }
        // ============================================================================
        // Screen / Buffer Helpers
        // ----------------------------------------------------------------------------
        // The screen buffer is a sparse 2D array of rows, where each row is an array of
        // { c: charCode, a: attributes }. Rows and columns are allocated lazily.
        //
        // Hardcopy mode does not use the screen buffer at all; output is appended to
        // the <textarea> directly. Screen mode (textarea or canvas) uses the buffer
        // and requires cursor addressing.
        // ============================================================================

        // Clear the entire screen buffer and reset cursor + attributes
        clearScreen() {
            this.screen = [];
            this.cursorRow = 0;
            this.cursorCol = 0;
            this.graphics.sgr = 0;
            this.overHang = 0;
            this.render(true); // force full redraw
        }

        // ============================================================================
        // Create a blank cell (space + no attributes)
        // ============================================================================
        emptyCell() {
            return { c: 32, a: 0 };
        }

        // ============================================================================
        // Rendering Dispatcher
        // ----------------------------------------------------------------------------
        // render(reDraw) is the central rendering entry point. It:
        //
        //   • Ensures the screen buffer contains the cursor position
        //   • Chooses between canvas rendering and textarea rendering
        //   • Maintains the caret position in both modes
        //   • Handles hardcopy mode separately
        //
        // reDraw = true forces a full redraw (e.g., after clearScreen or resize).
        // ============================================================================

        render(reDraw) {
            let caret = 0;

            // ------------------------------------------------------------------------
            // Screen Mode (textarea or canvas)
            // ------------------------------------------------------------------------
            if (this.modes.screen) {
                const row = this.cursorRow;
                const col = this.cursorCol;

                // Ensure the buffer has enough rows to contain the cursor
                while (this.screen.length <= row) {
                    this.screen.push([]);
                    reDraw = true;
                }

                // Ensure the row has enough columns to contain the cursor
                while (this.screen[row].length <= col) {
                    this.screen[row].push(this.emptyCell());
                    reDraw = true;
                }

                // --------------------------------------------------------------------
                // Canvas Rendering
                // --------------------------------------------------------------------
                if (this.allowCanvas) {
                    if (reDraw) {
                        this.renderCanvas();
                    }
                }

                // --------------------------------------------------------------------
                // Textarea Rendering
                // --------------------------------------------------------------------
                else {
                    if (reDraw) {
                        // Convert buffer back into text
                        this.textArea.value = this.screen
                            .map(line => line.map(cell => String.fromCharCode(cell.c)).join(""))
                            .join("\n");
                    }

                    // Compute caret position by summing row lengths
                    for (let r = 0; r < this.cursorRow; r++) {
                        caret += this.screen[r].length + 1; // +1 for newline
                    }
                    caret += this.cursorCol;

                    this.textArea.setSelectionRange(caret, caret);
                }
            }

            // ------------------------------------------------------------------------
            // Hardcopy Mode (LA36‑style)
            // ------------------------------------------------------------------------
            else {
                // Caret is always at end minus any overhang from backspace/return
                caret = this.textArea.value.length - this.overHang;
                this.textArea.setSelectionRange(caret, caret);
            }
        }
        // ============================================================================
        // Cursor Movement & Scrolling Primitives
        // ----------------------------------------------------------------------------
        // These routines implement the core “terminal physics” of a VT52/VT100-class
        // device. They operate directly on the sparse screen buffer and enforce DEC
        // rules for cursor clamping, origin mode, and scroll regions.
        // ============================================================================

        // ---------------------------------------------------------------------------
        // Move cursor to (row, col), respecting origin mode and scroll region
        // ---------------------------------------------------------------------------
        moveCursor(row, col) {
            // Any absolute/relative cursor motion ends a pending overstrike
            // run (started by BS/CR) and a pending auto-wrap. Only
            // carriageReturn re-arms the overstrike afterwards.
            this.overHang = 0;
            this.wrapPending = false;

            if (this.modes.origin) {
                // Origin mode clamps cursor to the active scroll region
                this.cursorRow = Math.max(
                    this.margin.top,
                    Math.min(this.margin.bottom - 1, row)
                );
            } else {
                // Absolute addressing across full screen
                this.cursorRow = Math.max(0, Math.min(this.rows - 1, row));
            }

            this.cursorCol = Math.max(0, Math.min(this.cols - 1, col));
            this.render(false);
        }

        // ---------------------------------------------------------------------------
        // Scroll region upward by n lines (DECSTBM)
        // ---------------------------------------------------------------------------
        scrollUp(n = 1) {
            this.wrapPending = false;
            for (let i = 0; i < n; i++) {
                // Remove top line of region
                this.screen.splice(this.margin.top, 1);
                // Insert blank line at bottom of region
                this.screen.splice(this.margin.bottom - 1, 0, []);
            }
            this.render(true);
        }

        // ---------------------------------------------------------------------------
        // Scroll region downward by n lines (DECSTBM)
        // ---------------------------------------------------------------------------
        scrollDown(n = 1) {
            this.wrapPending = false;
            for (let i = 0; i < n; i++) {
                // Insert blank line at top of region
                this.screen.splice(this.margin.top, 0, []);
                // Remove bottom line of region
                this.screen.splice(this.margin.bottom, 1);
            }
            this.render(true);
        }

        // ============================================================================
        // Insert / Delete Operations (VT100)
        // ----------------------------------------------------------------------------
        // These destructive operations modify the screen buffer in-place. They follow
        // VT100 semantics: characters shift left/right, and blank cells inherit the
        // current SGR attributes.
        // ============================================================================

        // ---------------------------------------------------------------------------
        // Insert n blank characters at cursor (ICH)
        // ---------------------------------------------------------------------------
        insertChars(n = 1) {
            const row = this.cursorRow;
            const col = this.cursorCol;

            if (!this.screen[row]) return;

            // Insert blank cells with current attributes
            for (let i = 0; i < n; i++) {
                this.screen[row].splice(col, 0, { c: 32, a: this.graphics.sgr });
            }

            // Trim to terminal width
            if (this.screen[row].length > this.cols) {
                this.screen[row].length = this.cols;
            }

            this.render(true);
        }

        // ---------------------------------------------------------------------------
        // Delete n characters at cursor (DCH)
        // ---------------------------------------------------------------------------
        deleteChars(n = 1) {
            const row = this.cursorRow;
            const col = this.cursorCol;

            if (!this.screen[row]) return;

            this.screen[row].splice(col, n);
            this.render(true);
        }

        // ---------------------------------------------------------------------------
        // Insert n blank lines at cursor row (IL)
        // ---------------------------------------------------------------------------
        insertLines(n = 1) {
            // Only valid inside scroll region
            if (this.cursorRow < this.margin.top ||
                this.cursorRow >= this.margin.bottom) return;

            for (let i = 0; i < n; i++) {
                this.screen.splice(this.cursorRow, 0, []);
                this.screen.splice(this.margin.bottom, 1);
            }

            this.render(true);
        }

        // ---------------------------------------------------------------------------
        // Delete n lines at cursor row (DL)
        // ---------------------------------------------------------------------------
        deleteLines(n = 1) {
            // Only valid inside scroll region
            if (this.cursorRow < this.margin.top ||
                this.cursorRow >= this.margin.bottom) return;

            for (let i = 0; i < n; i++) {
                this.screen.splice(this.cursorRow, 1);
                this.screen.splice(this.margin.bottom - 1, 0, []);
            }

            this.render(true);
        }

        // ============================================================================
        // Erase Operations (VT52 + VT100)
        // ----------------------------------------------------------------------------
        // Implements:
        //   • ESC J / ESC [ J   (erase in display)
        //   • ESC K / ESC [ K   (erase in line)
        //
        // DEC semantics:
        //   mode 0 → erase to end of line
        //   mode 1 → erase from start of line
        //   mode 2 → erase entire line
        //   mode 4 → erase to end of screen (VT52)
        //   mode 5 → erase from start of screen (VT52)
        //   mode 6 → erase entire screen (VT52)
        // ============================================================================

        erase(mode) {
            let reRender = false;

            switch (mode) {

                // --------------------------------------------------------------------
                // Erase to end of screen (VT52)
                // --------------------------------------------------------------------
                case 4:
                    if (this.screen.length > this.cursorRow) {
                        this.screen.length = this.cursorRow + 1;
                        reRender = true;
                    }
                    // fall through to erase to end of line

                // --------------------------------------------------------------------
                // Erase to end of line
                // --------------------------------------------------------------------
                case 0:
                    if (this.screen.length > this.cursorRow) {
                        if (this.screen[this.cursorRow].length > this.cursorCol) {
                            this.screen[this.cursorRow] =
                                this.screen[this.cursorRow].slice(0, this.cursorCol);
                            reRender = true;
                        }
                    }
                    break;

                // --------------------------------------------------------------------
                // Erase from start of screen (VT52)
                // --------------------------------------------------------------------
                case 5:
                    for (let r = 0; r < this.cursorRow; r++) {
                        if (this.screen[r].length > 0) {
                            this.screen[r].length = 0;
                            reRender = true;
                        }
                    }
                    // fall through to erase from start of line

                // --------------------------------------------------------------------
                // Erase from start of line
                // --------------------------------------------------------------------
                case 1:
                    if (this.cursorCol > 0) {
                        for (let c = 0; c < this.cursorCol; c++) {
                            this.screen[this.cursorRow][c] = this.emptyCell();
                        }
                        this.cursorCol = 0;
                        reRender = true;
                    }
                    break;

                // --------------------------------------------------------------------
                // Erase entire line
                // --------------------------------------------------------------------
                case 2:
                    if (this.screen[this.cursorRow].length > 0) {
                        this.screen[this.cursorRow].length = 0;
                        reRender = true;
                    }
                    break;

                // --------------------------------------------------------------------
                // Erase entire screen (VT52)
                // --------------------------------------------------------------------
                case 6:
                    this.clearScreen();
                    return;
            }

            this.render(reRender);
        }

        // ============================================================================
        // Character Output
        // ----------------------------------------------------------------------------
        // addChar() adds a printable character to the screen.
        // It applies:
        //   • VT52 graphics mode
        //   • VT100 G0/G1 DEC Special Graphics
        //   • SGR attributes (bold/underline/blink/reverse)
        //   • Hardcopy vs screen mode behaviour
        //
        // In screen mode, characters are written into the sparse screen buffer.
        // In hardcopy mode, characters are appended directly to the html textarea.
        // ============================================================================

        addChar(ch) {
            // ------------------------------------------------------------------------
            // Character set translation (the dialect owns the tables)
            // ------------------------------------------------------------------------
            ch = graphicsChar(this, ch);

            // ------------------------------------------------------------------------
            // Screen Mode (textarea or canvas)
            // ------------------------------------------------------------------------
            if (this.modes.screen) {
                // DECAWM: a pending wrap (a printable landed on the right
                // margin) advances to the start of the next line, scrolling
                // when already on the bottom line.
                if (this.wrapPending) {
                    this.wrapPending = false;
                    if (this.cursorRow >= this.margin.bottom - 1) {
                        this.scrollUp(1);
                    } else {
                        this.cursorRow++;
                    }
                    this.cursorCol = 0;
                }

                const row = this.cursorRow;
                const col = this.cursorCol;

                // Sparse buffer: ensure the target row exists. The wrap path
                // (DECAWM) may advance to a row that has not been allocated
                // yet, and direct cursor addressing can land beyond the rows
                // that have content.
                if (!this.screen[row]) {
                    this.screen[row] = [];
                }

                if (this.debug) {
                    console.log(
                        `addChar (${row},${col}) [${this.graphics.sgr}] '${String.fromCharCode(ch)}'`
                    );
                }

                // Insert/replace mode (IRM, CSI 4 h): shift the remainder of the
                // line right so the new character is inserted instead of
                // overwriting the existing text. Full-screen editors such as vi
                // rely on this when their termcap advertises insert mode
                // (im/mi), i.e. they print characters and expect the terminal
                // to make room for them.
                if (this.modes.insert) {
                    this.insertChars(1);
                }

                // Ensure cell exists
                if (this.screen[row].length <= col) {
                    this.screen[row].push({ c: ch, a: this.graphics.sgr });
                } else {
                    const cell = this.screen[row][col];
                    if (this.overHang > 0) {
                        // Overstrike after BS/CR: nroff/man renders bold as
                        // "X\bX" (or "X\rX") and underline as "_\bX". A space
                        // only moves the carriage; the existing glyph is kept
                        // so the canvas can show the emphasis.
                        const prevC = cell.c;
                        if (ch === 32) {
                            // Space overstrike: pure carriage motion.
                        } else if (ch === prevC && ch !== 95) {
                            // Same glyph overstruck → bold.
                            cell.a |= ATTR_BOLD;
                        } else if (ch !== 95 && prevC === 95) {
                            // Letter over an underscore → underline.
                            cell.c = ch;
                            cell.a |= ATTR_UNDERSCORE;
                        } else if (ch === 95 && prevC !== 32 && prevC !== 95) {
                            // Underscore over a letter → underline
                            // ("NAME\r_____" form); the letter stays visible.
                            cell.a |= ATTR_UNDERSCORE;
                        } else {
                            cell.c = ch;
                            cell.a = this.graphics.sgr;
                        }

                    } else {
                        cell.c = ch;
                        cell.a = this.graphics.sgr;
                    }
                 }

                // Consume one pending overstrike position (the column was
                // written, whether the cell existed or was freshly appended).
                if (this.overHang > 0) this.overHang--;

                // Cursor advance. With DECAWM (auto-wrap) on, a character on
                // the last column arms a pending wrap so the next printable
                // lands on the following line; with auto-wrap off the last
                // column is simply overwritten.
                if (col < this.cols - 1) {
                    this.cursorCol++;
                    this.wrapPending = false;
                } else if (this.modes.wrap) {
                    this.wrapPending = true;
                } else {
                    this.wrapPending = false;
                }

                // Canvas: redraw only the changed cell
                if (this.allowCanvas) {
                    this.renderCell(row, col);
                } else {
                    // Textarea: must redraw entire buffer
                    this.render(true);
                }
            }

            // ------------------------------------------------------------------------
            // Hardcopy Mode (LA36‑style)
            // ------------------------------------------------------------------------
            else {
                const s = String.fromCharCode(ch);

                if (this.overHang > 0) {
                    // Overwrite characters after cursor
                    const str = this.textArea.value;
                    const index = str.length - this.overHang;
                    this.textArea.value =
                        str.slice(0, index) + s + str.slice(index + 1);
                    this.overHang--;
                } else {
                    // Append normally
                    this.textArea.value += s;
                }

                this.cursorCol++;
                this.render(false);
            }
        }

        // ============================================================================
        // Control Characters
        // ----------------------------------------------------------------------------
        // Implements:
        //   • BS  (backspace)
        //   • TAB (horizontal tab, 8‑column stops)
        //   • LF  (line feed, scroll if needed)
        //   • CR  (carriage return)
        //   • RI  (reverse index, VT100)
        // ============================================================================

        // ---------------------------------------------------------------------------
        // Backspace (BS)
        // ---------------------------------------------------------------------------
        backSpace() {
            if (this.cursorCol > 0) {
                this.cursorCol--;
                // Both hardcopy and screen mode: backspace marks the position
                // for an overstrike (nroff/man bold/underline).
                this.overHang++;
                this.render(false);
            }
        }

        // ---------------------------------------------------------------------------
        // Horizontal Tab (TAB) — 8‑column tab stops
        // ---------------------------------------------------------------------------
        tab() {
            const spaces = 8 - (this.cursorCol & 7);

            if (this.modes.screen) {
                this.moveCursor(this.cursorRow, this.cursorCol + spaces);
            } else {
                this.textArea.value += " ".repeat(spaces);
                this.cursorCol += spaces;
                this.overHang = Math.max(0, this.overHang - spaces);
            }
        }

        // ---------------------------------------------------------------------------
        // Line Feed (LF)
        // ---------------------------------------------------------------------------
        lineFeed() {
            if (this.modes.screen) {
                // A new line ends any pending overstrike run.
                this.overHang = 0;

                // Within scroll region
                if (this.cursorRow < this.margin.bottom - 1) {
                    this.moveCursor(this.cursorRow + 1, this.cursorCol);
                } else {
                    // Scroll region upward
                    this.scrollUp(1);

                    // Optional: auto‑hardcopy fallback when bottom of screen scrolls
                    // Disabled when noHardcopyFallback is set (e.g., for VT52 CRT terminal)
                    if (!this.noHardcopyFallback && !this.modes.keypad && this.cursorRow === this.rows - 1) {
                        this.enterHardcopyMode();
                    }
                }
            } else {
                // Hardcopy mode
                this.textArea.value += "\n";
                this.cursorCol = 0;
                this.overHang = 0;
                this.textArea.scrollTop = this.textArea.scrollHeight;
            }
        }

        // ---------------------------------------------------------------------------
        // Carriage Return (CR)
        // ---------------------------------------------------------------------------
        carriageReturn() {
            if (this.modes.screen) {
                // CR is the overstrike operator used by nroff/man: return the
                // cursor to column 0 so the following characters overstrike
                // the current line. moveCursor resets overHang, so re-arm it
                // with the number of columns that will be overstruck.
                const n = this.cursorCol;
                this.moveCursor(this.cursorRow, 0);
                this.overHang = n;
            } else {
                // Hardcopy mode: trim buffer if too large
                if (this.textArea.value.length > MAX_BUFFER) {
                    this.textArea.value =
                        this.textArea.value.slice(-MAX_BUFFER);
                }
                this.overHang += this.cursorCol;
                this.cursorCol = 0;
                this.render(false);
            }
        }

        // ---------------------------------------------------------------------------
        // Form Feed (FF)
        // ---------------------------------------------------------------------------
        // On VT52/VT100 hardware, form feed (^L, 0x0C) clears the screen and
        // returns the cursor to home. 2.11 BSD nroff/man separate pages with
        // ^L, so each page starts at the top of a fresh screen instead of
        // printing below the previous one.
        // ---------------------------------------------------------------------------
        formFeed() {
            this.clearScreen();
        }

        // ---------------------------------------------------------------------------
        // Bell (BEL, 0x07)
        // ---------------------------------------------------------------------------
        // BEL is emitted by programs to grab the operator's attention. If the
        // application installs a window.playBell hook (mirroring playKeyClick)
        // it is used for audio; otherwise the visual bell below is the only
        // feedback. The visual bell ALWAYS runs, so a muted or blocked audio
        // context still gives the operator a flash on the glass.
        //
        // Canvas CRT: the whole screen briefly flashes in reverse colours.
        // Plain textarea mode: there is no canvas to invert, so the textarea
        // flashes through the .vt52-bell-flash CSS class (css/pdp11.css).
        // ---------------------------------------------------------------------------
        bell() {
            if (typeof window.playBell === "function") {
                window.playBell();
            }

            if (this.allowCanvas) {
                const oldFg = this.fgColor;
                const oldBg = this.bgColor;
                this.fgColor = oldBg;
                this.bgColor = oldFg;
                this.resetCanvasContext(this.canvas.ctx);
                this.renderCanvas();
                setTimeout(() => {
                    this.fgColor = oldFg;
                    this.bgColor = oldBg;
                    this.resetCanvasContext(this.canvas.ctx);
                    this.renderCanvas();
                }, 120);
            } else if (this.textArea && this.textArea.classList) {
                // One-shot reverse-video blink driven by a CSS animation. The
                // class is removed on animationend so consecutive bells restart
                // the animation (a reflow forces the restart to apply).
                const ta = this.textArea;
                ta.classList.remove("vt52-bell-flash");
                void ta.offsetWidth;
                ta.classList.add("vt52-bell-flash");
                const done = () => {
                    ta.classList.remove("vt52-bell-flash");
                    ta.removeEventListener("animationend", done);
                };
                ta.addEventListener("animationend", done);
            }
        }

        // ---------------------------------------------------------------------------
        // Reverse Index (RI) — VT100
        // ---------------------------------------------------------------------------
        // Moves cursor up, scrolling region downward if at top margin.
        reverseIndex() {
            if (this.cursorRow > this.margin.top) {
                this.moveCursor(this.cursorRow - 1, this.cursorCol);
            } else {
                this.scrollDown(1);
            }
        }


        // ============================================================================
        // SGR — Select Graphic Rendition (CSI m)
        // ----------------------------------------------------------------------------
        // Only the classic VT100 attributes are implemented:
        //   0   reset
        //   1   bold
        //   4   underline
        //   5   blink
        //   7   reverse video
        //
        // And their corresponding “off” codes:
        //   22  bold off
        //   24  underline off
        //   25  blink off
        //   27  reverse off
        //
        // Unknown SGR parameters are logged for debugging.
        // ============================================================================
        setRendition(c) {
            const params = String.fromCharCode(
                ...this.parser.buffer.slice(this.parser.state, -1)
            ).split(';');

            for (const p of params) {
                switch (p) {
                    case '':
                    case '0':  this.graphics.sgr = 0; break;
                    case '1':  this.graphics.sgr |= ATTR_BOLD; break;
                    case '4':  this.graphics.sgr |= ATTR_UNDERSCORE; break;
                    case '5':  this.graphics.sgr |= ATTR_BLINK; break;
                    case '7':  this.graphics.sgr |= ATTR_REVERSE; break;

                    case '22': this.graphics.sgr &= ~ATTR_BOLD; break;
                    case '24': this.graphics.sgr &= ~ATTR_UNDERSCORE; break;
                    case '25': this.graphics.sgr &= ~ATTR_BLINK; break;
                    case '27': this.graphics.sgr &= ~ATTR_REVERSE; break;

                    default:
                        console.log(
                            "Unknown SGR:",
                            this.parser.buffer,
                            `'${c}'`,
                            this.parser.state
                        );
                }
            }
        }

        // ============================================================================
        parameterValue(index, def) {
            const hasPrivate = (this.parser.buffer[this.parser.state] === CSI_PRIVATE);

            const params = String.fromCharCode(
                ...this.parser.buffer.slice(
                    this.parser.state + (hasPrivate ? 1 : 0),
                    -1
                )
            ).split(';');

            if (index >= params.length || params[index] === '') return def;

            const v = parseInt(params[index], 10);
            return isNaN(v) ? def : v;
        }

        // ============================================================================
        // Escape Reset
        // ----------------------------------------------------------------------------
        // Called after any escape/CSI/extended sequence completes.
        // Clears parser state and ensures screen mode is active.
        //
        // In debug mode report any sequence before it is dismissed.
        // ============================================================================
        escapeReset() {
            if (this.debug) {
                console.log(
                    `DEBUG escape: ${this.parser.buffer.join(', ')} ` +
                    `(row=${this.cursorRow}, col=${this.cursorCol}) ` +
                    `[margin=${this.margin.top}:${this.margin.bottom}] ` +
                    `modes=${this.modes.screen}/${this.modes.origin}/${this.modes.insert}/${this.modes.wrap} ` +
                    `bufferLines=${this.screen.length}`
                );
            }

            // Reset parser state
            this.parser.buffer = [];
            this.parser.state = 0;

            // Any escape sequence forces entry into screen mode
            if (!this.modes.screen) {
                this.enterScreenMode()
            }
        }

        // ============================================================================
        // Input Handling
        // ----------------------------------------------------------------------------
        // Keyboard events are translated into terminal input bytes and
        // delivered to the emulator’s receiveRoutine callback.
        //
        // Keyboard mapping:
        //   • the dialect's keymap (see Dialect.translateKey)
        //   • Application keypad mode (DECKPAM / DECKPNM)
        //   • Ctrl‑key combinations (Ctrl+A → 0x01, etc.)
        //   • Printable ASCII
        //
        // Paste events are handled elsewhere!
        // ============================================================================
        handleKey(ev) {
            // The dialect owns the keymap (its own tables, its own view of the
            // application-cursor-key mode). The engine only consumes the result.
            // Prefer an instance-level hook (a dialect may override per terminal),
            // then the bound dialect class, then the engine owns the fallback.
            const translate = (typeof this.translateKey === "function")
                ? this.translateKey.bind(this)
                : (Dialect && typeof Dialect.translateKey === "function"
                    ? Dialect.translateKey.bind(Dialect)
                    : null);
            let bytes = translate ? translate(ev, this.modes, ESC) : null;

            // Printable characters or Ctrl+key combinations
            if (!bytes && ev.key.length === 1) {
                if (ev.ctrlKey) {
                    const c = ev.key.toUpperCase().charCodeAt(0) - 64;
                    if (c >= 1 && c <= 26) {
                        bytes = [c]; // Ctrl+A → 1, etc.
                    }
                } else {
                    bytes = [ev.key.charCodeAt(0) & 0x7F]; // 7‑bit clean
                }
            }

            // Any result is sent to the emulator receive routine
            if (bytes) {
                // Optional audible key click (VT100-style feedback). The hook
                // is installed by pdp11-app.js and honours the CONFIG
                // "keyClick" setting; it is optional so this module stays
                // decoupled from the application configuration.
                if (typeof window.playKeyClick === "function") {
                    window.playKeyClick();
                }
                this.receiveRoutine(this.unit, bytes);
                ev.preventDefault();
            }
        }

        // ---------------------------------------------------------------------------
        // Event Binding
        // ---------------------------------------------------------------------------
        // Each terminal element (textarea or canvas) receives:
        //   • keydown events
        //   • focus events (to redraw cursor)
        // ---------------------------------------------------------------------------
        bindEvents(element) {
            if (element.tabIndex < 0) {
                element.tabIndex = 0; // Ensure element can receive focus
            }

            element.addEventListener("keydown", e => this.handleKey(e));
            element.addEventListener("focus",  () => this.render(false));
        }

        // ---------------------------------------------------------------------------
        // Machine-state persistence (L3): snapshot() / restore()
        // ---------------------------------------------------------------------------
        // Captures everything needed to resume a terminal exactly as it was:
        // the sparse screen buffer (char + attribute per cell), the hardcopy
        // textarea scrollback, cursor + saved cursor, DEC modes, character
        // set selection, SGR attributes, scroll margins, reverse video and
        // the wrap/overhang flags. The escape-sequence parser is deliberately
        // NOT captured — a half-received sequence dies with the snapshot, like
        // a cable being unplugged mid-escape. Pure data, no DOM access.
        snapshot() {
            return {
                screen: this.screen.map(row => row.map(cell => ({ c: cell.c, a: cell.a }))),
                hardcopy: this.textArea ? this.textArea.value : "",
                hardcopyScrollTop: this.textArea ? this.textArea.scrollTop : 0,
                modes: Object.assign({}, this.modes),
                graphics: {
                    vt52: this.graphics.vt52,
                    activeSet: this.graphics.activeSet,
                    enabled: this.graphics.enabled.slice(),
                    sgr: this.graphics.sgr
                },
                margin: { top: this.margin.top, bottom: this.margin.bottom },
                cursorRow: this.cursorRow,
                cursorCol: this.cursorCol,
                savedCursor: Object.assign({}, this.savedCursor),
                wrapPending: this.wrapPending,
                overHang: this.overHang,
                reverseVideo: this.reverseVideo,
                rows: this.rows,
                cols: this.cols
            };
        }

        // Rebuild terminal state from a snapshot. The screen buffer and the
        // hardcopy scrollback are restored verbatim, then the visible surface
        // (canvas or textarea) is repainted to match, including scroll
        // position and cursor. The parser is reset (a half-received escape
        // sequence does not survive). Safe to call on a live terminal.
        restore(state) {
            if (!state) return;

            // Screen buffer (sparse): rows of { c, a } cells.
            if (Array.isArray(state.screen)) {
                this.screen = state.screen.map(row => (Array.isArray(row)
                    ? row.map(cell => ({ c: cell.c | 0, a: cell.a | 0 }))
                    : []));
            }

            // Hardcopy scrollback + scroll position.
            if (this.textArea) {
                if (typeof state.hardcopy === "string") {
                    this.textArea.value = state.hardcopy;
                }
                if (typeof state.hardcopyScrollTop === "number") {
                    this.textArea.scrollTop = state.hardcopyScrollTop;
                }
            }

            // Modes (only known keys — never trust a foreign snapshot).
            if (state.modes && typeof state.modes === "object") {
                ["screen", "dialect", "origin", "insert", "wrap",
                 "appCursor", "cursorVisible", "keypad"].forEach(k => {
                    if (typeof state.modes[k] === "boolean") {
                        this.modes[k] = state.modes[k];
                    }
                });
            }

            // Character sets + SGR.
            if (state.graphics && typeof state.graphics === "object") {
                if (typeof state.graphics.vt52 === "boolean") this.graphics.vt52 = state.graphics.vt52;
                if (state.graphics.activeSet === 0 || state.graphics.activeSet === 1) {
                    this.graphics.activeSet = state.graphics.activeSet;
                }
                if (Array.isArray(state.graphics.enabled)) {
                    this.graphics.enabled = [
                        !!state.graphics.enabled[0],
                        !!state.graphics.enabled[1]
                    ];
                }
                if (typeof state.graphics.sgr === "number") this.graphics.sgr = state.graphics.sgr;
            }

            // Scroll margins (DECSTBM).
            if (state.margin && typeof state.margin === "object") {
                if (typeof state.margin.top === "number") this.margin.top = state.margin.top;
                if (typeof state.margin.bottom === "number") this.margin.bottom = state.margin.bottom;
            }

            // Cursor + saved cursor.
            if (typeof state.cursorRow === "number") this.cursorRow = state.cursorRow;
            if (typeof state.cursorCol === "number") this.cursorCol = state.cursorCol;
            if (state.savedCursor && typeof state.savedCursor === "object") {
                if (typeof state.savedCursor.row === "number") this.savedCursor.row = state.savedCursor.row;
                if (typeof state.savedCursor.col === "number") this.savedCursor.col = state.savedCursor.col;
                if (typeof state.savedCursor.sgr === "number") this.savedCursor.sgr = state.savedCursor.sgr;
            }

            if (typeof state.wrapPending === "boolean") this.wrapPending = state.wrapPending;
            if (typeof state.overHang === "number") this.overHang = state.overHang;
            if (typeof state.reverseVideo === "boolean") this.reverseVideo = state.reverseVideo;
            if (typeof state.rows === "number") this.rows = state.rows;
            if (typeof state.cols === "number") this.cols = state.cols;

            // Repaint the visible surface and reset the parser.
            this.parser.buffer = [];
            this.parser.state = 0;
            if (this.modes.screen && this.allowCanvas && this.screenCanvas) {
                this.screenCanvas.style.display = "block";
                if (this.textArea) this.textArea.style.display = "none";
                this.renderCanvas();
            } else if (this.textArea) {
                this.textArea.style.display = "block";
                if (this.screenCanvas) this.screenCanvas.style.display = "none";
                this.textArea.scrollTop = this.textArea.scrollHeight;
            }
        }
    }

    // ============================================================================
    // Artwork projection
    // ----------------------------------------------------------------------------
    // The VT52 cabinet is drawn by assets/vt52.svg. The artwork's Screen marker
    // is read AT RUNTIME and published on the rig as --vt52-screen-* variables,
    // so moving the marker in Inkscape moves the canvas: the numbers in
    // css/pdp11.css are only the fallback for builds where the artwork cannot be
    // fetched (strict file:// origin). Same contract as the Model 33 artwork
    // (see TTY_MARKER_VARS in src/pdp11-app.js).
    var VT52_ART_URL = 'assets/vt52.svg';

    // Pure: SVG text -> { '--vt52-screen-x': '4.418643', ... } (the Screen
    // marker's x/y/w/h plus the viewBox). Returns null when there is no marker
    // to publish, so the stylesheet fallback keeps whatever is absent.
    function vt52MarkerVars(svgText) {
        if (!svgText) return null;
        var out = {};
        var viewBox = /viewBox="0 0 ([-0-9.eE]+) ([-0-9.eE]+)"/.exec(svgText);
        if (viewBox) {
            out['--vt52-vb-w'] = viewBox[1];
            out['--vt52-vb-h'] = viewBox[2];
        }
        // The marker is a plain <rect> with inkscape:label="Screen"; it carries
        // no id contract, so the label is the anchor (a rect moved in Inkscape
        // keeps its label).
        var element = /<rect[^>]*inkscape:label="Screen"[^>]*\/>/.exec(svgText);
        if (!element) return out;
        var rect = element[0];
        function value(attr) {
            var m = new RegExp(attr + '="([-0-9.eE]+)"').exec(rect);
            return m ? m[1] : null;
        }
        var x = value('x'), y = value('y'), w = value('width'), h = value('height');
        if (x === null || y === null || w === null || h === null) return out;
        out['--vt52-screen-x'] = x;
        out['--vt52-screen-y'] = y;
        out['--vt52-screen-w'] = w;
        out['--vt52-screen-h'] = h;
        return out;
    }

    // Publish the marker numbers on every VT52 rig in the document. Each rig
    // owns its own copy of the artwork (variant A), so the variables are set per
    // rig rather than on a shared ancestor.
    function applyVt52MarkerVars(svgText) {
        if (typeof document === 'undefined') return;
        var vars = vt52MarkerVars(svgText);
        if (!vars) return;
        var rigs = document.querySelectorAll('.vt52-rig');
        for (var i = 0; i < rigs.length; i++) {
            for (var name in vars) {
                if (Object.prototype.hasOwnProperty.call(vars, name)) {
                    rigs[i].style.setProperty(name, vars[name]);
                }
            }
        }
        syncVt52Unit();
    }

    // --vt52-u is the px size of one SVG unit. The tube keeps its native
    // bitmap (672 px wide, the <canvas> width attribute), so the unit is
    // derived from the ARTWORK: 672 / Screen-marker width. That makes the unit
    // independent of layout — it is right even while the page is hidden — and
    // the whole cabinet is then laid out at its natural size, with
    // installVT52Scaling() shrinking it as one piece (exactly like the Model 33
    // rig, whose --tty-u-num is likewise a constant of the artwork).
    function syncVt52Unit() {
        if (typeof document === 'undefined') return;
        var rigs = document.querySelectorAll('.vt52-rig');
        for (var i = 0; i < rigs.length; i++) {
            var rig = rigs[i];
            var cs = getComputedStyle(rig);
            var markerW = parseFloat(cs.getPropertyValue('--vt52-screen-w'));
            var vbw = parseFloat(cs.getPropertyValue('--vt52-vb-w'));
            var native = 672; // the <canvas width="672"> the artwork must frame
            if (!isFinite(markerW) || markerW <= 0 || !isFinite(vbw) || vbw <= 0) continue;
            var u = native / markerW;
            if (!isFinite(u) || u <= 0) continue;
            rig.style.setProperty('--vt52-u', u.toFixed(6));
        }
    }

    // Inline the artwork into every .vt52-backdrop. The backdrop used to be a
    // background-image, which the page can see but cannot STYLE: a rule could
    // not hide or recolour anything inside the drawing (that is why the glass
    // could not follow the reverse-video mode). Inlined, the artwork becomes
    // part of the document and the stylesheet reaches its elements. Same trick
    // the Model 33 rig uses for its front layers (installTtyLayer), and the
    // reason each rig owns its own copy (variant A): an <svg> can only be in
    // one place, so every .vt52-backdrop gets its own.
    //
    // The scale is pinned with width/height 100% + preserveAspectRatio="none",
    // exactly matching the old background-size: 100% 100%, so the drawing still
    // fills the box and the marker arithmetic is unchanged.
    function inlineVt52Artwork(svgText) {
        if (typeof document === 'undefined' || typeof DOMParser === 'undefined') return;
        var hosts = document.querySelectorAll('.vt52-backdrop');
        if (!hosts.length) return;
        var parsed = new DOMParser().parseFromString(String(svgText), 'image/svg+xml');
        var root = parsed && parsed.documentElement;
        if (!root || root.localName !== 'svg') return; // malformed artwork
        var viewBox = root.getAttribute('viewBox');
        if (!viewBox) return;
        for (var i = 0; i < hosts.length; i++) {
            var host = hosts[i];
            host.textContent = '';
            var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', viewBox);
            svg.setAttribute('preserveAspectRatio', 'none');
            svg.setAttribute('width', '100%');
            svg.setAttribute('height', '100%');
            svg.setAttribute('style', 'display:block');
            // Carry the artwork's namespace declarations onto the wrapper.
            // importNode copies the nodes but not the in-scope prefixes, so
            // without these the imported "inkscape:label" attributes lose their
            // namespace and a stylesheet selector for [inkscape\:label=...]
            // never matches (the Glass / GlassInverted switch depends on it).
            for (var a = 0; a < root.attributes.length; a++) {
                var attr = root.attributes[a];
                if (attr.name === 'xmlns' || attr.name.indexOf('xmlns:') === 0) {
                    svg.setAttribute(attr.name, attr.value);
                }
            }
            // Import the artwork's CHILDREN, not the <svg> root itself. The
            // root carries width="284.22635mm" and its own viewBox; nesting it
            // applied the millimetre scale TWICE (once on the nested root, once
            // on this wrapper) and the drawing rendered 1.68x too large, shifted
            // down-right. Moving the children keeps exactly one viewBox — this
            // wrapper's — so the fit matches the old background-size: 100% 100%.
            for (var c = 0; c < root.childNodes.length; c++) {
                svg.appendChild(document.importNode(root.childNodes[c], true));
            }
            // Strip the inline 'display:inline' Inkscape stamps on the layers we
            // switch from CSS (see the Glass / GlassInverted rules): an inline
            // style beats any stylesheet rule and silently defeated the switch.
            // Only 'inline' is removed — never 'none'. Hiding is a deliberate
            // authoring decision (the tracing raster is display:none while the
            // artist works, and the Screen marker is hidden in the shipped art),
            // and clearing it would make those objects appear.
            var nodes = svg.getElementsByTagName('*');
            for (var d = 0; d < nodes.length; d++) {
                var el = nodes[d];
                if (!el.style || !el.style.display) continue;
                if (el.style.display === 'inline') el.style.removeProperty('display');
            }
            // Publish the artwork's layer labels as PLAIN CLASSES. A stylesheet
            // selector for [inkscape\:label="..."] is useless here twice over:
            // inside an inlined <svg> the escaped colon is read as a pseudo-class
            // (measured: the elements are in the DOM, the selector matches none),
            // and writing that selector in JS throws outright
            // ("'[inkscape:label]' is not a valid selector"). Walking the tree and
            // reading the attribute by namespace avoids both problems.
            var NS_INKSCAPE = 'http://www.inkscape.org/namespaces/inkscape';
            var all = svg.getElementsByTagName('*');
            for (var l = 0; l < all.length; l++) {
                var label = all[l].getAttributeNS
                    ? all[l].getAttributeNS(NS_INKSCAPE, 'label')
                    : null;
                if (!label) continue;
                // classList rejects any whitespace in a token, and the artwork's
                // labels legitimately carry spaces ("Keyboard top", "Keyboard
                // hull", …). A thrown InvalidCharacterError used to abort the
                // whole inliner before the <svg> was appended. Slugify instead:
                // .vt52-layer-Keyboard-top.
                all[l].classList.add('vt52-layer-' +
                    String(label).replace(/[^A-Za-z0-9_-]+/g, '-'));
            }
            host.appendChild(svg);
        }
    }

    // Fetch the artwork once, inline it and publish its Screen marker. A failure
    // (offline, file:// origin) is silent: the stylesheet fallback holds the
    // layout and the backdrop keeps its (empty) box.
    function loadVt52Artwork() {
        if (typeof fetch !== 'function') return;
        fetch(VT52_ART_URL)
            .then(function (response) { return response.text(); })
            .then(function (text) {
                inlineVt52Artwork(text);
                applyVt52MarkerVars(text);
            })
            .catch(function () { /* keep the stylesheet fallback */ });
    }

    // ============================================================================
    // Public API
    // ----------------------------------------------------------------------------
    // vt52Initialize(unit, receiveRoutine, textArea, screenCanvas)
    //     Creates a new terminal instance and registers it.
    //
    // vt52Write(unit, data)
    //     Feeds characters into the terminal (string or numeric byte).
    //
    // These functions are attached to window for easy integration with
    // emulators, PDP‑11 simulators, or browser‑based DEC tools.
    // ============================================================================
    function vt52Initialize(unit, receiveRoutine, textArea, screenCanvas, options) {
        VT.set(unit, new Terminal(Object.assign({
            unit,
            receiveRoutine,
            textArea,
            screenCanvas
        }, options || {})));
    }

    function vt52Get(unit) {
        return VT.get(unit);
    }

    // Machine-state persistence (L3): snapshot every live terminal as an
    // array keyed by unit. Terminals that exist but have no snapshot support
    // (older code) are skipped. Returns [] when nothing is registered.
    function vt52SnapshotAll() {
        const out = [];
        VT.forEach(function (term, unit) {
            if (term && typeof term.snapshot === "function") {
                out.push({ unit: unit, state: term.snapshot() });
            }
        });
        return out;
    }

    // Restore every terminal captured by vt52SnapshotAll(). Unknown units
    // (e.g. terminals that no longer exist) are ignored; a missing snapshot
    // for a live unit leaves that unit untouched.
    function vt52RestoreAll(snapshots) {
        if (!Array.isArray(snapshots)) return;
        snapshots.forEach(function (entry) {
            if (!entry || typeof entry.unit !== "number") return;
            const term = VT.get(entry.unit);
            if (term && typeof term.restore === "function") {
                term.restore(entry.state);
            }
        });
    }

    function vt52Write(unit, data) {
        const term = VT.get(unit);
        if (!term) return;

        if (typeof data === "string") {
            for (let i = 0; i < data.length; i++) {
                term.putChar(data.charCodeAt(i));
            }
        } else if (typeof data === "number") {
            term.putChar(data);
        }
    }

    // Called by a dialect module before it is instantiated, so the engine can
    // reach that dialect's static tables.
    function registerDialect(cls) { Dialect = cls; }

    // Publish the engine class for dialect modules (mirrors src/core/*.js, which
    // all hang their exports off window.yapdpCore).
    window.yapdpCore = window.yapdpCore || {};
    window.yapdpCore.Core = Core;
    window.yapdpCore.registerDialect = registerDialect;
    // The dialect modules run in their own IIFE scope, so the control-character
    // and attribute constants they share with the engine travel with it.
    Object.assign(window.yapdpCore, {
        Core,
        DEFAULT_ROWS, DEFAULT_COLS, MAX_COLS_132, MAX_BUFFER, CRT_ASPECT,
        BS, TAB, LF, FF, CR, ESC, SO, SI, DEL,
        ASCII_PRINTABLE_MIN, ASCII_PRINTABLE_MAX, CSI_PRIVATE,
        BG_COLOR, FG_COLOR,
        ATTR_BOLD, ATTR_UNDERSCORE, ATTR_BLINK, ATTR_REVERSE
    });

    window.vt52Initialize = vt52Initialize;
    window.vt52Get        = vt52Get;
    window.vt52Write      = vt52Write;
    window.vt52SnapshotAll  = vt52SnapshotAll;
    window.vt52RestoreAll   = vt52RestoreAll;
    // Pure marker parser (unit-tested) plus the runtime artwork loader.
    window.vt52MarkerVars   = vt52MarkerVars;
    window.vt52LoadArtwork  = loadVt52Artwork;
    window.vt52InlineArtwork = inlineVt52Artwork;
    window.vt52SyncUnit     = syncVt52Unit;
})();
