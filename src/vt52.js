// ============================================================================
// VT52 / VT100 Hybrid Terminal Emulator
// ----------------------------------------------------------------------------
// This module implements a historically accurate VT52 terminal with a focused
// subset of VT100/ANSI features sufficient to run classic DEC system software
// (EDT, DCL, diagnostics, and common utilities).
//
// The goal is not to emulate every ANSI escape sequence, but to reproduce the
// behaviour that real DEC software relied on: cursor motion, destructive
// operations, scroll regions, character sets, and the subtle quirks that make
// a VT terminal feel authentic.
//
// Target compatibility
// --------------------
// • Full VT52 behaviour
// • VT100/ANSI subset:
//     - Cursor addressing (CSI row;col H / f)
//     - Erase operations (CSI J / K)
//     - Insert/Delete chars and lines (ICH, DCH, IL, DL)
//     - Scroll regions (DECSTBM)
//     - Select Graphic Rendition (SGR: bold, underline, blink, reverse)
//     - 80/132 column mode switching (DECCOLM)
//     - G0/G1 character sets and DEC Special Graphics
//
// Design principles
// -----------------
// • Behavioural correctness over minimalism
//     The emulator prefers faithful reproduction of DEC behaviour—even when
//     that behaviour is surprising—over simplifying the model.
//
// • Readability for contributors unfamiliar with DEC hardware
//     The code is structured and commented so that new maintainers can follow
//     the logic without prior knowledge of VT terminals.
//
// • Historically accurate destructive operations
//     Insert/delete, scrolling, and wrap behaviour match real hardware.
//
// Behavioural notes
// -----------------
// • The terminal starts in LA36-style hardcopy mode.
//     Screen mode is entered lazily when cursor addressing or screen semantics
//     are first required.
//
// • Switching between 80 and 132 columns clears the screen.
//     This matches DECCOLM behaviour on real VT100 hardware.
//
// • Scroll regions use an exclusive bottom margin.
//     DECSTBM defines the region as [top, bottom), with the bottom row excluded.
//
// • The screen buffer is sparse.
//     Rows and columns are allocated only as needed, matching the behaviour of
//     real terminals that did not store trailing blanks.
//
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
    const VT = new Map();

    // =========================================================================
    // Terminal Class
    // =========================================================================
    class Terminal {

        // =====================================================================
        // Static Keymaps and Graphics Tables
        // ---------------------------------------------------------------------
        // These tables define:
        //   • VT52 keyboard sequences
        //   • VT100 keyboard sequences
        //   • DEC Special Graphics (VT52 and VT100)
        //
        // They are frozen to prevent accidental modification at runtime.
        // =====================================================================

        // ---------------------------------------------------------------------
        // VT52 Keymap
        // ---------------------------------------------------------------------
        static VT52_KEYMAP = Object.freeze({
            // Numeric keypad when NOT in application mode
            noKeypad: {
                NumLock: [],
                NumpadDivide:   [47], // '/'
                NumpadMultiply: [42], // '*'
                NumpadSubtract: [45], // '-'
                Numpad0: [48], Numpad1: [49], Numpad2: [50], Numpad3: [51],
                Numpad4: [52], Numpad5: [53], Numpad6: [54], Numpad7: [55],
                Numpad8: [56], Numpad9: [57],
                NumpadEnter: [CR]      // CR
            },

            // VT52 cursor keys and keypad PF1–PF4
            keyMap: {
                ArrowUp:    [ESC, 65], // ESC A
                ArrowDown:  [ESC, 66], // ESC B
                ArrowRight: [ESC, 67], // ESC C
                ArrowLeft:  [ESC, 68], // ESC D

                // PF1–PF4 (VT52 keypad)
                NumLock:        [ESC, 80], // ESC P
                NumpadDivide:   [ESC, 81], // ESC Q
                NumpadMultiply: [ESC, 82], // ESC R
                NumpadSubtract: [ESC, 83], // ESC S

                F1: [ESC, 80], F2: [ESC, 81],
                F3: [ESC, 82], F4: [ESC, 83],

                // Keypad application mode (VT52 extension)
                Numpad0: [ESC, 63, 112], // ESC ? p
                Numpad1: [ESC, 63, 113], // ESC ? q
                Numpad2: [ESC, 63, 114], // ESC ? r
                Numpad3: [ESC, 63, 115], // ESC ? s
                Numpad4: [ESC, 63, 116], // ESC ? t
                Numpad5: [ESC, 63, 117], // ESC ? u
                Numpad6: [ESC, 63, 118], // ESC ? v
                Numpad7: [ESC, 63, 119], // ESC ? w
                Numpad8: [ESC, 63, 120], // ESC ? x
                Numpad9: [ESC, 63, 121], // ESC ? y

                Enter:       [CR],
                Backspace:   [DEL], // Delete
                Tab:         [TAB],
                Escape:      [ESC],
                NumpadEnter: [ESC, 63, 77] // ESC ? M
            }
        });

        // ---------------------------------------------------------------------
        // VT100 Keymap
        // ---------------------------------------------------------------------
        static VT100_KEYMAP = Object.freeze({
            noKeypad: {
                NumLock: [],
                NumpadDivide:   [47],
                NumpadMultiply: [42],
                NumpadSubtract: [45],
                Numpad0: [48], Numpad1: [49], Numpad2: [50], Numpad3: [51],
                Numpad4: [52], Numpad5: [53], Numpad6: [54], Numpad7: [55],
                Numpad8: [56], Numpad9: [57],
                NumpadEnter: [CR]
            },

            keyMap: {
                // ANSI cursor keys (CSI)
                ArrowUp:    [ESC, 91, 65], // ESC [ A
                ArrowDown:  [ESC, 91, 66], // ESC [ B
                ArrowRight: [ESC, 91, 67], // ESC [ C
                ArrowLeft:  [ESC, 91, 68], // ESC [ D

                // PF1–PF4 (VT100)
                NumLock:        [ESC, 79, 80], // ESC O P
                NumpadDivide:   [ESC, 79, 81], // ESC O Q
                NumpadMultiply: [ESC, 79, 82], // ESC O R
                NumpadSubtract: [ESC, 79, 83], // ESC O S

                F1: [ESC, 79, 80], F2: [ESC, 79, 81],
                F3: [ESC, 79, 82], F4: [ESC, 79, 83],

                // Keypad application mode (VT100)
                Numpad0: [ESC, 79, 112], // ESC O p
                Numpad1: [ESC, 79, 113], // ESC O q
                Numpad2: [ESC, 79, 114], // ESC O r
                Numpad3: [ESC, 79, 115], // ESC O s
                Numpad4: [ESC, 79, 116], // ESC O t
                Numpad5: [ESC, 79, 117], // ESC O u
                Numpad6: [ESC, 79, 118], // ESC O v
                Numpad7: [ESC, 79, 119], // ESC O w
                Numpad8: [ESC, 79, 120], // ESC O x
                Numpad9: [ESC, 79, 121], // ESC O y

                Enter:       [CR],
                Backspace:   [DEL], // Delete
                Tab:         [TAB],
                Escape:      [ESC],
                NumpadEnter: [ESC, 63, 77] // ESC ? M
            }
        });

        // ---------------------------------------------------------------------
        // VT100 DEC Special Graphics (G0/G1)
        // ---------------------------------------------------------------------
        static VT100_GRAPHICS_MAP = Object.freeze({
            // Box drawing used by EDT and diagnostics
            0x6C: 0x250C, // 'l' → ┌
            0x6B: 0x2510, // 'k' → ┐
            0x6D: 0x2514, // 'm' → └
            0x6A: 0x2518, // 'j' → ┘

            0x71: 0x2500, // 'q' → ─
            0x78: 0x2502, // 'x' → │

            0x77: 0x252C, // 'w' → ┬
            0x76: 0x2534, // 'v' → ┴
            0x74: 0x251C, // 't' → ├
            0x75: 0x2524, // 'u' → ┤
            0x6E: 0x253C, // 'n' → ┼

            // DEC extras + quirks
            0x6F: 0x25C6, // 'o' → ◆
            0x70: 0x2592, // 'p' → ▒
            0x72: 0x2510, // 'r' → ┐ (duplicate)
            0x73: 0x2518, // 's' → ┘ (duplicate)
            0x79: 0x2514, // 'y' → └ (duplicate)
            0x7A: 0x251C  // 'z' → ├ (duplicate)
        });

        // ---------------------------------------------------------------------
        // VT52 Graphics Mode (G0 only)
        // ---------------------------------------------------------------------
        static VT52_GRAPHICS_MAP = Object.freeze({
            0x61: 0x25C6, // 'a' → ◆
            0x62: 0x2592, // 'b' → ▒
            0x63: 0x2409, // 'c' → ␉
            0x64: 0x240C, // 'd' → ␌
            0x65: 0x240D, // 'e' → ␍
            0x66: 0x240A, // 'f' → ␊
            0x67: 0x00B0, // 'g' → °
            0x68: 0x00B1, // 'h' → ±
            0x69: 0x2424, // 'i' → NL
            0x6A: 0x240B, // 'j' → ␋
            0x6B: 0x2518, // 'k' → ┘
            0x6C: 0x2510, // 'l' → ┐
            0x6D: 0x250C, // 'm' → ┌
            0x6E: 0x2514, // 'n' → └
            0x6F: 0x253C, // 'o' → ┼
            0x70: 0x23BA, // 'p' → ⎺
            0x71: 0x23BB, // 'q' → ⎻
            0x72: 0x2500, // 'r' → ─
            0x73: 0x23BC, // 's' → ⎼
            0x74: 0x23BD, // 't' → ⎽
            0x75: 0x251C, // 'u' → ├
            0x76: 0x2524, // 'v' → ┤
            0x77: 0x2534, // 'w' → ┴
            0x78: 0x252C, // 'x' → ┬
            0x79: 0x2502, // 'y' → │
            0x7A: 0x2261  // 'z' → ≡
        });
        // ============================================================================
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
                ansi:   false,   // VT100/ANSI mode vs VT52 mode
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
            this.modes    = { screen: false, ansi: false, origin: false, insert: false,
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

            // VT52 (DECscope) has no SGR emphasis: bold and underline are
            // VT100-only attributes (DECANM / modes.ansi). In VT52 mode they
            // must never be drawn, no matter how they reached the cell
            // (overstrike or SGR), so mask them out before rendering.
            if (!this.modes.ansi) {
                attr &= ~(ATTR_BOLD | ATTR_UNDERSCORE);
            }

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
                if (this.modes.ansi) { // VT100 / VT52
                    ctx.fillRect(x, y, this.canvas.charWidth, h);
                } else {
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
            // Character set translation (VT52 or VT100 graphics)
            // ------------------------------------------------------------------------
            if (this.modes.ansi) {
                // VT100: G0/G1 DEC Special Graphics
                if (this.graphics.enabled[this.graphics.activeSet]) {
                    ch = Terminal.VT100_GRAPHICS_MAP[ch] || ch;
                }
            } else if (this.graphics.vt52) {
                // VT52 graphics mode
                ch = Terminal.VT52_GRAPHICS_MAP[ch] || ch;
            }

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
        // Escape Handling (VT52 + VT100)
        // ----------------------------------------------------------------------------
        // putChar() is the top‑level dispatcher for incoming bytes. It handles:
        //   • control characters
        //   • printable characters
        //   • escape introducer (ESC)
        //   • SO/SI (G0/G1 switching)
        //   • delegating to the escape parser when inside a sequence
        // ============================================================================

        putChar(ch) {
            ch &= 0x7F; // 7‑bit clean

            // If inside an escape sequence continue parsing
            if (this.parser.buffer.length) {
                return this.checkEscape(ch);
            }

            switch (ch) {
                case BS:  return this.backSpace();
                case TAB: return this.tab();
                case LF:  return this.lineFeed();
                case FF:  return this.formFeed();
                case CR:  return this.carriageReturn();
                case 7:   return this.bell(); // BEL — audible/visual bell

                case ESC:
                    // Begin new escape sequence
                    this.parser.buffer = [ESC];
                    this.parser.state = 0; // Initial state
                    return;

                case SO: // Shift Out → G1
                    this.graphics.activeSet = 1;
                    return;

                case SI: // Shift In → G0
                    this.graphics.activeSet = 0;
                    return;

                default:
                    // Printable ASCII
                    if (ch >= ASCII_PRINTABLE_MIN && ch <= ASCII_PRINTABLE_MAX) {
                        this.addChar(ch);
                    }
            }
        }

        // ============================================================================
        // DECSTBM — Set Top/Bottom Margin (Scroll Region)
        // ----------------------------------------------------------------------------
        // DEC semantics:
        //   • top is 1‑based and inclusive
        //   • bottom is 1‑based and exclusive
        //   • bottom == rows means full screen
        //
        // If parameters are invalid, the region resets to full screen.
        // Cursor is moved to the region home (row 0, col 0), and origin mode
        // may further clamp it.
        // ============================================================================
        setMargin(top, bottom) {
            if (top >= 1 && bottom > top && bottom <= this.rows) {
                this.margin.top    = top - 1; // convert to 0‑based
                this.margin.bottom = bottom;  // exclusive
            } else {
                // Reset to full screen
                this.margin.top    = 0;
                this.margin.bottom = this.rows;
            }

            // Cursor always moves to region home after DECSTBM
            this.moveCursor(0, 0);
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
        // DECMODE — Set/Reset Terminal Modes (CSI ? Pn h / CSI ? Pn l)
        // ----------------------------------------------------------------------------
        // Only a small subset of DEC private modes are implemented, matching the
        // behaviour required by DEC system software (EDT, DCL, diagnostics).
        //
        // Supported:
        //   ?2  — VT52 mode (reset = VT100/ANSI mode)
        //   ?3  — DECCOLM (80/132 column mode)
        //   ?6  — DECOM (origin mode)
        //   ?8  — Auto‑repeat (ignored)
        //   4   — Jump scroll (ignored)
        //
        // Unknown modes are logged for debugging.
        // ============================================================================
        setMode(c) {
            const action = (c === 'h'); // h = set (true), l = reset (false)
            const hasPrivate = (this.parser.buffer[this.parser.state] === CSI_PRIVATE);

            // Extract parameter list (e.g., "6", "3", "?2")
            const params = String.fromCharCode(
                ...this.parser.buffer.slice(
                    this.parser.state + (hasPrivate ? 1 : 0),
                    -1
                )
            ).split(';');

            for (const p of params) {
                const key = hasPrivate ? '?' + p : p;

                switch (key) {

                    // ---------------------------------------------------------------
                    // DECANM — VT52 / ANSI mode toggle.
                    // Per DEC: CSI ? 2 h selects VT52 mode, CSI ? 2 l selects
                    // ANSI mode, i.e. modes.ansi = !action.
                    // ---------------------------------------------------------------
                    case "?2":
                        this.modes.ansi = !action;
                        break;

                    // ---------------------------------------------------------------
                    // DECCOLM — 80/132 column mode
                    // Clears screen (DEC behaviour) and resizes canvas if present.
                    // ---------------------------------------------------------------
                    case "?3":
                        this.cols = action ? 132 : 80;
                        this.clearScreen();

                        if (this.allowCanvas) {
                            this.resizeCanvas();
                        }
                        break;

                    // ---------------------------------------------------------------
                    // DECOM — Origin mode
                    // Cursor addressing becomes relative to scroll region.
                    // ---------------------------------------------------------------
                    case "?6":
                        this.modes.origin = action;
                        this.moveCursor(0, 0);
                        break;

                    // ---------------------------------------------------------------
                    // DECCKM — Application cursor keys (CSI ? 1 h/l).
                    // When set, the arrow keys transmit ESC O A/B/C/D instead
                    // of ESC [ A/B/C/D (handled in handleKey).
                    // ---------------------------------------------------------------
                    case "?1":
                        this.modes.appCursor = action;
                        break;

                    // ---------------------------------------------------------------
                    // DECSCNM — Reverse screen (CSI ? 5 h/l).
                    // Swaps the phosphor colours, like the CONFIG reverse-video
                    // mode (setReverseVideo repaints the canvas when present).
                    // ---------------------------------------------------------------
                    case "?5":
                        this.setReverseVideo(action);
                        break;

                    // ---------------------------------------------------------------
                    // DECAWM — Auto-wrap mode (CSI ? 7 h/l).
                    // When set (default) a printable on the last column wraps to
                    // the next line; when reset the margin column is overwritten.
                    // ---------------------------------------------------------------
                    case "?7":
                        this.modes.wrap = action;
                        break;

                    // ---------------------------------------------------------------
                    // DECTCEM — Cursor visibility (CSI ? 25 h/l).
                    // Full-screen programs hide the cursor while redrawing.
                    // ---------------------------------------------------------------
                    case "?25":
                        this.modes.cursorVisible = action;
                        break;

                    // ---------------------------------------------------------------
                    // IRM — Insert/Replace mode (CSI 4 h / CSI 4 l)
                    // Needed by vi: with the insert-capable vt100 termcap it
                    // enters insert mode via im=\E[4h and types characters,
                    // relying on the terminal to shift the rest of the line.
                    // ---------------------------------------------------------------
                    case "4":
                        this.modes.insert = action;
                        break;

                    // ---------------------------------------------------------------
                    // Ignored modes (not required by DEC software)
                    // ---------------------------------------------------------------
                    case "?8":  // Auto‑repeat
                        break;

                    // ---------------------------------------------------------------
                    // Unknown mode
                    // ---------------------------------------------------------------
                    default:
                        console.log(
                            "Unknown set mode:",
                            this.parser.buffer,
                            `'${c}'`,
                            this.parser.state
                        );
                }
            }
        }

        // ============================================================================
        // CSI Parameter Extraction Helper
        // ----------------------------------------------------------------------------
        // Returns the numeric value of the nth parameter, or a default if missing.
        // Handles private-mode prefixes (CSI ? ...).
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
        // Escape Sequence Dispatcher
        // ----------------------------------------------------------------------------
        // checkEscape() is called for every byte after ESC has been seen.
        // It routes to:
        //   • checkCSI()       — VT100 CSI sequences
        //   • checkExtended()  — VT52 multi‑char sequences (e.g., ESC Y row col)
        //
        // parser.state semantics:
        //   0   → initial state
        //  >0   → inside CSI parameter(s)
        //  <0   → inside extended VT52 escape sequence
        // ----------------------------------------------------------------------------
        // First byte after escape decides what next
        // For example:
        //   • ESC Y    is followed by fixed data (eg row & col)
        //   • ESC [    is followed by CSI parameters
        //   • ESC byte where byte is the entire sequence
        //
        // Unknown escape sequences are logged for debugging.
        // ============================================================================
        checkEscape(ch) {
            const c = String.fromCharCode(ch);
            this.parser.buffer.push(ch);

            // If not in initial state call appropriate helper
            if (this.parser.state != 0) {
                if (this.parser.state < 0) {
                    // <0 Inside VT52 extended sequence
                    this.checkExtended(c);
                } else {
                    // >0 Inside CSI sequence
                    this.checkCSI(c);
                }
                return;
            }

            // Initial state, first byte decides what follows
            switch (c) {

                // ---------------------------------------------------------------
                // VT52 cursor motion
                // ---------------------------------------------------------------
                case 'A': this.moveCursor(this.cursorRow - 1, this.cursorCol); break;
                case 'B': this.moveCursor(this.cursorRow + 1, this.cursorCol); break;
                case 'C': this.moveCursor(this.cursorRow, this.cursorCol + 1); break;
                case 'D': this.moveCursor(this.cursorRow, this.cursorCol - 1); break;

                // ---------------------------------------------------------------
                // VT52 graphics mode toggle
                // ---------------------------------------------------------------
                case 'F': this.graphics.vt52 = true;  break;
                case 'G': this.graphics.vt52 = false; break;

                // ---------------------------------------------------------------
                // Home cursor
                // ---------------------------------------------------------------
                case 'H': this.moveCursor(0, 0); break;

                // ---------------------------------------------------------------
                // Reverse line feed (VT52 ESC I): cursor up one line, scrolling
                // the screen downward when the cursor is at the top margin.
                // ---------------------------------------------------------------
                case 'I': this.reverseIndex(); break;

                // ---------------------------------------------------------------
                // VT52 Insert Line (ESC L) and Delete Line (ESC M).
                // These are required by full-screen editors such as vi, which
                // use the termcap "al"/"dl" capabilities for the o/O (open
                // line) and dd (delete line) commands. NOTE: in VT100, ESC M is
                // Reverse Index, but in VT52 ESC M is Delete Line.
                // ---------------------------------------------------------------
                case 'L': this.insertLines(1); break;
                case 'M': this.deleteLines(1); break;

                // ---------------------------------------------------------------
                // Erase in display / erase in line (VT52)
                // ---------------------------------------------------------------
                case 'J': this.erase(4); break; // erase to end of screen
                case 'K': this.erase(0); break; // erase to end of line

                // ---------------------------------------------------------------
                // ESC E — VT52 clear screen + home cursor.
                // 2.11 BSD termcap "cl" for VT52 is "\033E"; both `clear` and
                // the full-screen `more` pager emit it, so each page of nroff/
                // man output starts from the top row. In ANSI/VT100 mode ESC E
                // is NEL (next line: carriage return + line feed).
                // ---------------------------------------------------------------
                case 'E':
                    if (this.modes.ansi) {
                        this.carriageReturn();
                        this.lineFeed();
                    } else {
                        this.clearScreen();
                    }
                    break;

                // ---------------------------------------------------------------
                // ESC Y row col — VT52 direct cursor addressing
                // Need two more bytes
                // ---------------------------------------------------------------
                case 'Y':
                    this.parser.state = -2; // expect row, col
                    return;

                // ---------------------------------------------------------------
                // ESC 7 / ESC 8 — Save / Restore cursor (DECSC/DECRC).
                // Programs use these to remember the cursor position and SGR
                // attributes across a redraw or a sub-operation.
                // ---------------------------------------------------------------
                case '7':
                    this.savedCursor = {
                        row: this.cursorRow,
                        col: this.cursorCol,
                        sgr: this.graphics.sgr
                    };
                    break;

                case '8':
                    this.graphics.sgr = this.savedCursor.sgr;
                    this.moveCursor(this.savedCursor.row, this.savedCursor.col);
                    break;

                // ---------------------------------------------------------------
                // ESC Z — Identify terminal. A plain DECscope VT52 (no hardcopy
                // unit) responds ESC / K; the copier-equipped model responds
                // ESC / Z.
                // ---------------------------------------------------------------
                case 'Z':
                    this.receiveRoutine(this.unit, [ESC, 47, 75]); // ESC / K
                    this.parser.buffer = [];
                    return;

                // ---------------------------------------------------------------
                // ESC c — Reset terminal
                // ---------------------------------------------------------------
                case 'c':
                    this.reset();
                    break;

                // ---------------------------------------------------------------
                // Keypad mode (VT52)
                // ---------------------------------------------------------------
                case '=': this.modes.keypad = true;  break;
                case '>': this.modes.keypad = false; break;

                // ---------------------------------------------------------------
                // ESC < — Enter ANSI (VT100) mode
                // ---------------------------------------------------------------
                case '<': this.modes.ansi = true; break;

                // ---------------------------------------------------------------
                // ESC ( c / ESC ) c — G0/G1 character set selection
                // Needs one more byte
                // ---------------------------------------------------------------
                case '(':
                case ')':
                case '*':
                case '+':
                case '#': // Line size (ignored)
                    this.parser.state = -1; // expect one more char
                    return;

                // ---------------------------------------------------------------
                // ESC [ ... — Begin VT100 CSI
                // ESC ? ... — Begin VT100 private CSI
                // ---------------------------------------------------------------
                case '[':
                case '?':
                    this.parser.state = this.parser.buffer.length;
                    return;

                // ---------------------------------------------------------------
                // ESC \ — String terminator (ignored)
                // ---------------------------------------------------------------
                case '\\':
                    break;

                // ---------------------------------------------------------------
                // Unknown sequence
                // ---------------------------------------------------------------
                default:
                    console.log(
                        "Unknown escape:",
                        this.parser.buffer,
                        `'${c}'`,
                        this.parser.state
                    );
            }

            this.escapeReset();
        }

        // ============================================================================
        // VT52 Extended Sequences (ESC Y row col, ESC ( c, ESC ) c)
        // ----------------------------------------------------------------------------
        // parser.state < 0 means more characters are needed (count up to 0).
        //   -2 → ESC Y row col
        //   -1 → ESC ( c or ESC ) c
        //
        // Unknown extended sequences should not be possible (can't get here!)
        // ============================================================================
        checkExtended(c) {

            // Accumulate bytes until we have the whole sequence
            if (++this.parser.state < 0) {
                return;
            }

            // Sequence type is decided by lead character
            const lead = String.fromCharCode(this.parser.buffer[1]);

            switch (lead) {

                // ---------------------------------------------------------------
                // ESC Y row col — VT52 direct cursor addressing
                // ---------------------------------------------------------------
                case 'Y':
                    this.moveCursor(
                        this.parser.buffer[2] - 32,
                        this.parser.buffer[3] - 32
                    );
                    break;

                // ---------------------------------------------------------------
                // ESC ( c — Enable/disable G0 graphics
                // ESC ) c — Enable/disable G1 graphics
                // ---------------------------------------------------------------
                case '(':
                    this.graphics.enabled[0] = (c === '0');
                    break;

                case ')':
                    this.graphics.enabled[1] = (c === '0');
                    break;

                default:
                    // Other VT52 extended sequences are ignored
                    break;
            }

            this.escapeReset();
        }

        // ============================================================================
        // VT100 CSI Sequences (ESC [ ... or ESC ? ...)
        // ----------------------------------------------------------------------------
        // checkCSI() handles bytes in a CSI sequence.
        // Parameter bytes collect until a non‑parameter character is seen.
        // ----------------------------------------------------------------------------
        // parser.state > 0 is where the CSI parameter list begins.
        //
        // Supported:
        //   A B C D   — Cursor motion
        //   H f       — Direct cursor addressing
        //   J K       — Erase in display / erase in line
        //   @ P       — Insert/delete chars
        //   L M       — Insert/delete lines
        //   c         — Device Attributes
        //   h l       — Set/reset modes
        //   m         — SGR
        //   r         — Set scroll region
        //
        // Unknown CSI sequences are logged for debugging.
        // ============================================================================
        checkCSI(c) {

            // Accumulate all parameter bytes: digits, semicolon, or '?' prefix
            if ( (c >= '0' && c <= '9') || c === ';' ||
                (c === '?' && this.parser.state === this.parser.buffer.length - 1) ) {
                return; // continue to collect the parameter(s)
            }

            // End of parameter(s) reached so decode the sequence
            switch (c) {

                // ---------------------------------------------------------------
                // Cursor motion
                // ---------------------------------------------------------------
                case 'A': this.moveCursor(this.cursorRow - this.parameterValue(0, 1), this.cursorCol); break;
                case 'B': this.moveCursor(this.cursorRow + this.parameterValue(0, 1), this.cursorCol); break;
                case 'C': this.moveCursor(this.cursorRow, this.cursorCol + this.parameterValue(0, 1)); break;
                case 'D': this.moveCursor(this.cursorRow, this.cursorCol - this.parameterValue(0, 1)); break;

                // ---------------------------------------------------------------
                // Direct cursor addressing
                // ---------------------------------------------------------------
                case 'H':
                case 'f':
                    this.moveCursor(
                        this.parameterValue(0, 1) - 1,
                        this.parameterValue(1, 1) - 1
                    );
                    break;

                // ---------------------------------------------------------------
                // Erase in display / erase in line
                // ---------------------------------------------------------------
                case 'J': this.erase(4 | this.parameterValue(0, 0)); break;
                case 'K': this.erase(this.parameterValue(0, 0)); break;

                // ---------------------------------------------------------------
                // Insert/delete characters
                // ---------------------------------------------------------------
                case '@': this.insertChars(this.parameterValue(0, 1)); break;
                case 'P': this.deleteChars(this.parameterValue(0, 1)); break;

                // ---------------------------------------------------------------
                // Insert/delete lines
                // ---------------------------------------------------------------
                case 'L': this.insertLines(this.parameterValue(0, 1)); break;
                case 'M': this.deleteLines(this.parameterValue(0, 1)); break;

                // ---------------------------------------------------------------
                // Device Attributes  - Fixed response: ESC [?1;4c
                // ---------------------------------------------------------------
                case 'c': //
                    this.receiveRoutine(this.unit, [ESC, 91, 63, 49, 59, 52, 99]);
                    break;

                // ---------------------------------------------------------------
                // Mode set/reset
                // ---------------------------------------------------------------
                case 'h':
                case 'l':
                    this.setMode(c);
                    break;

                // ---------------------------------------------------------------
                // Select Graphic Rendition (SGR)
                // ---------------------------------------------------------------
                case 'm':
                    this.setRendition(c);
                    break;

                // ---------------------------------------------------------------
                // Scroll region
                // ---------------------------------------------------------------
                case 'r':
                    this.setMargin(
                        this.parameterValue(0, 1),
                        this.parameterValue(1, 1)
                    );
                    break;

                // ---------------------------------------------------------------
                // Cursor position report (CPR) — CSI 6 n
                // Responds with the 1-based cursor position as ESC [ row ; col R.
                // ---------------------------------------------------------------
                case 'n':
                    if (this.parameterValue(0, 0) === 6) {
                        const resp = `\x1b[${this.cursorRow + 1};${this.cursorCol + 1}R`;
                        this.receiveRoutine(this.unit,
                            Array.from(resp, ch => ch.charCodeAt(0)));
                    }
                    break;

                // ---------------------------------------------------------------
                // Row / column addressing variants and scrolling
                //   d — VPA (vertical position absolute)
                //   G — CHA (cursor horizontal absolute)
                //   E — CNL (cursor next line), F — CPL (cursor previous line)
                //   S — SU (scroll up), T — SD (scroll down)
                // ---------------------------------------------------------------
                case 'd':
                    this.moveCursor(this.parameterValue(0, 1) - 1, this.cursorCol);
                    break;
                case 'G':
                    this.moveCursor(this.cursorRow, this.parameterValue(0, 1) - 1);
                    break;
                case 'E':
                    this.moveCursor(this.cursorRow + this.parameterValue(0, 1), 0);
                    break;
                case 'F':
                    this.moveCursor(this.cursorRow - this.parameterValue(0, 1), 0);
                    break;
                case 'S':
                    this.scrollUp(this.parameterValue(0, 1));
                    break;
                case 'T':
                    this.scrollDown(this.parameterValue(0, 1));
                    break;

                // ---------------------------------------------------------------
                // Unknown CSI
                // ---------------------------------------------------------------
                default:
                    console.log(
                        "Unknown CSI:",
                        this.parser.buffer,
                        `'${c}'`,
                        this.parser.state
                    );
            }

            this.escapeReset();
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
                    `modes=${this.modes.screen}/${this.modes.ansi}/${this.modes.origin}/${this.modes.keypad} ` +
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
        //   • VT52 or VT100 keymaps depending on modes.ansi
        //   • Application keypad mode (DECKPAM / DECKPNM)
        //   • Ctrl‑key combinations (Ctrl+A → 0x01, etc.)
        //   • Printable ASCII
        //
        // Paste events are handled elsewhere!
        // ============================================================================
        handleKey(ev) {
            const map = this.modes.ansi ? Terminal.VT100_KEYMAP : Terminal.VT52_KEYMAP;

            // Prefer keypad mapping unless keypad mode is disabled
            let bytes =
                (!this.modes.keypad && map.noKeypad[ev.code]) ||
                map.keyMap[ev.code];

            // DECCKM (CSI ? 1 h): application cursor keys — the arrow keys
            // transmit SS3 (ESC O A..D) instead of CSI (ESC [ A..D).
            if (this.modes.ansi && this.modes.appCursor) {
                const appArrows = {
                    ArrowUp:    [ESC, 79, 65], // ESC O A
                    ArrowDown:  [ESC, 79, 66], // ESC O B
                    ArrowRight: [ESC, 79, 67], // ESC O C
                    ArrowLeft:  [ESC, 79, 68]  // ESC O D
                };
                if (appArrows[ev.code]) bytes = appArrows[ev.code];
            }

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
                ["screen", "ansi", "origin", "insert", "wrap",
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

    window.vt52Initialize = vt52Initialize;
    window.vt52Get        = vt52Get;
    window.vt52Write      = vt52Write;
    window.vt52SnapshotAll  = vt52SnapshotAll;
    window.vt52RestoreAll   = vt52RestoreAll;
})();
