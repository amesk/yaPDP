// ============================================================================
// VT52 / VT100 Hybrid Terminal Emulator
// ----------------------------------------------------------------------------
// The VT52 dialect of the yaPDP terminal. Everything specific to a DECscope
// VT52 — and to the VT100 compatibility mode it can be switched into — lives
// here; the dialect-independent engine (screen buffer, cursor physics,
// destructive operations, SGR, rendering, artwork projection) lives in
// src/terminal-core.js and is inherited.
//
// The terminal begins in LA36-style hardcopy mode and enters screen mode lazily
// when cursor addressing or screen semantics are first required. Switching
// between 80 and 132 columns clears the screen, and scroll regions use an
// exclusive bottom margin, both matching real DEC hardware.
//
// The escape grammar is split by introducer, exactly as the hardware split it:
//   - ESC <letter>        VT52 single-letter sequences (checkEscape)
//   - ESC Y row col       VT52 direct cursor addressing (checkExtended)
//   - ESC [ ... / ESC ?   VT100 CSI sequences (checkCSI)
//
// Loaded AFTER src/terminal-core.js.
// ============================================================================

(() => {
    'use strict';

    // The engine, plus the control-character and attribute constants it shares
    // with its dialects (see the export block at the bottom of terminal-core.js).
    const {
        Core,
        BS, TAB, LF, FF, CR, ESC, SO, SI, DEL,
        ASCII_PRINTABLE_MIN, ASCII_PRINTABLE_MAX, CSI_PRIVATE,
        ATTR_BOLD, ATTR_UNDERSCORE, ATTR_BLINK, ATTR_REVERSE
    } = window.yapdpCore;


    class Terminal extends Core {

        // =====================================================================
        // Engine hooks
        // ---------------------------------------------------------------------
        // The engine (src/terminal-core.js) never inspects this dialect's own
        // state: it asks. These four are the whole contract — which attributes
        // the tube can draw, what the cursor looks like, how a graphic-mode
        // character is translated, and what a keystroke transmits.
        // =====================================================================

        static attrMask() {
            // A DECscope VT52 (no DECANM) has no SGR emphasis: bold and
            // underline are VT100-only. In VT52 mode they must never reach the
            // tube, however they landed in the cell (overstrike or SGR).
            // Instance flavour (see the instance hook below); the static form
            // exists so a caller holding only the class still gets a sane answer.
            return ~(ATTR_BOLD | ATTR_UNDERSCORE);
        }

        static cursorIsBlock() {
            // VT52 draws an underline cursor; the instance hook below overrides
            // this for ANSI mode.
            return false;
        }

        static graphicsChar(machine, ch) {
            // VT52: G0 graphics mode only (the instance hook below handles ANSI).
            if (machine.graphics.vt52) {
                return this.VT52_GRAPHICS_MAP[ch] || ch;
            }
            return ch;
        }

        /** The keymap pair for a mode flag. */
        static keyMap(ansi) {
            return ansi
                ? { noKeypad: this.VT100_KEYMAP.noKeypad, keyMap: this.VT100_KEYMAP.keyMap }
                : { noKeypad: this.VT52_KEYMAP.noKeypad, keyMap: this.VT52_KEYMAP.keyMap };
        }

        /**
         * translateKey(ev, modes, ESC) — the bytes a keystroke transmits, or
         * null when the engine should fall back to printable/Ctrl handling.
         */
        static translateKey(ev, modes, ESC) {
            const map = this.keyMap(!!modes.ansi);

            // Prefer keypad mapping unless keypad mode is disabled
            let bytes =
                (!modes.keypad && map.noKeypad[ev.code]) ||
                map.keyMap[ev.code];

            // DECCKM (CSI ? 1 h): application cursor keys — the arrow keys
            // transmit SS3 (ESC O A..D) instead of CSI (ESC [ A..D).
            if (modes.ansi && modes.appCursor) {
                const appArrows = {
                    ArrowUp:    [ESC, 79, 65], // ESC O A
                    ArrowDown:  [ESC, 79, 66], // ESC O B
                    ArrowRight: [ESC, 79, 67], // ESC O C
                    ArrowLeft:  [ESC, 79, 68]  // ESC O D
                };
                if (appArrows[ev.code]) bytes = appArrows[ev.code];
            }

            return bytes || null;
        }

        /**
         * Per-instance switch, called from DECANM (CSI ? 2), ESC < and reset.
         *
         * modes.ansi is this dialect's own public name for the flag (callers and
         * tests use it). modes.dialect is the NEUTRAL field the engine stores and
         * hands back — the engine never reads modes.ansi. Both must move
         * together: a reset that updates only one of them leaves the terminal
         * half-configured, which showed up as a VT100 console that received
         * nothing (its output was routed as if it were a teletype).
         */
        _setAnsiMode(on) {
            var flag = !!on;
            this.modes.ansi = flag;
            this.modes.dialect = flag;
        }

        /** The engine asks the INSTANCE, so each terminal keeps its own mode. */
        attrMask()    { return this.modes.ansi ? -1 : ~(ATTR_BOLD | ATTR_UNDERSCORE); }
        cursorIsBlock() { return !!this.modes.ansi; }
        graphicsChar(ch) {
            if (this.modes.ansi) {
                if (this.graphics.enabled[this.graphics.activeSet]) {
                    return Terminal.VT100_GRAPHICS_MAP[ch] || ch;
                }
                return ch;
            }
            if (this.graphics.vt52) {
                return Terminal.VT52_GRAPHICS_MAP[ch] || ch;
            }
            return ch;
        }
        translateKey(ev, modes, ESC) {
            return Terminal.translateKey.call(Terminal, ev, modes, ESC);
        }

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
                        this._setAnsiMode(!action);
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
                case '<': this._setAnsiMode(true); break;

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
    }

    // Publish the class so a superset dialect (src/dialect/vt100.js, which
    // extends this one) can reach it.
    window.yapdpDialects = window.yapdpDialects || {};
    window.yapdpDialects.VT52 = Terminal;

    // The engine reaches this dialect's static tables through this binding.
    window.yapdpCore.registerDialect(Terminal);

    // =========================================================================
    // Terminal Registry
    // -------------------------------------------------------------------------
    // Multiple terminal instances may exist (e.g., DL11 multiplexing). Each
    // instance is keyed by a "unit" number and stored here.
    //
    // SHARED with every other dialect (it lives on window.yapdpCore.terminals).
    // Each dialect has its own writer — vt52Write() for a VT52, vt100Write() for
    // a VT100 — but the console routing in browser-machine.js/iopage.js calls
    // the VT52 one for BOTH, because the two share the console page and unit.
    // With a private map the VT100 was registered where vt100Get() could find it
    // but vt52Write() could not, so the guest's output vanished silently
    // (`if (!term) return`). One registry fixes both the routing and the
    // snapshot/restore path.
    // =========================================================================
    const VT = window.yapdpCore.terminals;

    // ============================================================================
    // Public API
    // ----------------------------------------------------------------------------
    // vt52Initialize(unit, receiveRoutine, textArea, screenCanvas)
    //     Creates a new terminal instance and registers it.
    //
    // vt52Write(unit, data)
    //     Feeds characters into the terminal (string or numeric byte).
    //
    // The canvas callbacks on the engine are re-exported unchanged, so the
    // artwork projection keeps the exact surface it had before the split
    // (see the "artwork projection" section of src/terminal-core.js).
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
    // array keyed by unit.
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
    // (e.g. terminals that no longer exist) are ignored.
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

    window.vt52Initialize   = vt52Initialize;
    window.vt52Get          = vt52Get;
    window.vt52Write        = vt52Write;
    window.vt52SnapshotAll  = vt52SnapshotAll;
    window.vt52RestoreAll   = vt52RestoreAll;
})();
