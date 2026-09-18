// ============================================================================
// VT100 terminal dialect
// ----------------------------------------------------------------------------
// The VT100 is a SUPERSET of the VT52, exactly as the hardware was: a VT100 is
// a VT52 plus the ANSI escape grammar, the DEC private modes, and a tube that
// only ever runs in screen mode. So this dialect extends the VT52 dialect class
// and overrides only where the two genuinely differ — everything ANSI (CSI
// parsing, DECMODE, DECSTBM, the VT100 keymap and graphics tables) is inherited.
//
// Differences from the VT52 the hardware actually had:
//
//   ESC E          VT52: clear screen + home.  VT100: NEL (CR + LF).
//   ESC Y r c      VT52 direct addressing — the VT100 does not know it.
//   ESC F / G      VT52 graphics on/off — the VT100 uses SO / SI and the
//                  G0/G1 designators instead.
//   ESC Z          VT52 "identify yourself" — the VT100 answers a DA query
//                  (CSI c) with "VT100 with AVO" instead.
//   ESC = / >      VT52 keypad mode — the VT100 uses DECKPAM / DECKPNM.
//   ESC <          VT52 "enter ANSI mode" — meaningless on a VT100, which is
//                  ANSI from power-on.
//   CSI ? 2 h      DECANM: the VT100 drops into VT52 compatibility mode. This
//                  is real VT100 hardware behaviour and the reason the ANSI
//                  grammar is inherited rather than reimplemented.
//
// Power-on: a VT100 has no LA36 hardcopy unit, so it never enters hardcopy mode
// (the VT52 does, and enters the screen lazily on the first cursor motion).
//
// Loaded AFTER src/terminal-core.js and AFTER src/vt52.js.
// ============================================================================

(() => {
    'use strict';

    const {
        CR, LF, ESC
    } = window.yapdpCore;

    const Terminal52 = window.yapdpDialects.VT52;

    class Terminal extends Terminal52 {

        // =====================================================================
        // Power-on state
        // ---------------------------------------------------------------------
        // A VT100 is CRT-only: no hardcopy mode, no lazy entry into the screen.
        // It starts on the screen and stays there.
        // =====================================================================

        /**
         * powerOnState() — the engine asks this whenever it builds the mode
         * flags (the constructor AND reset()). A VT100 is CRT-only: it is in
         * screen mode and ANSI from the instant it exists.
         *
         * This is a HOOK rather than a reset() override on purpose. The engine
         * constructor does not call reset(), so a VT100 built by
         * vt100Initialize() used to start with screen=false — and the guest's
         * very first output (the bootstrap "@" prompt) was routed to the hidden
         * hardcopy textarea instead of the CRT. The operator saw a cabinet with
         * a blank screen.
         */
        /**
         * acceptsPhosphor — this terminal takes a tube choice from CONFIG.
         *
         * The VT52 does not set this, so the host's applyTerminalPhosphor()
         * leaves a DECscope on P4. The flag exists because every dialect shares
         * ONE terminal registry, so "reachable" no longer implies "is a VT100":
         * iterating the registry lit DECscopes green.
         */
        acceptsPhosphor = true;

        /**
         * acceptsReverseVideo — NO, unlike the base dialect it inherits from.
         *
         * The VT52 had a reverse-video control on the machine, so its dialect
         * opts in. The VT100 has no such switch — only the SGR 7 attribute the
         * software sends — so it must explicitly opt out. Without this it
         * inherited the base's opt-in and the DECscope's CONFIG switch repainted
         * the VT100's tube as well.
         */
        acceptsReverseVideo = false;

        powerOnState() {
            // No phosphor here: the VT100 takes it as an option (Config), and
            // that choice is applied by the host after construction. Only the
            // VT52, which had no such option, pins a phosphor of its own.
            return { screen: true, dialect: true, ansi: true };
        }

        // =====================================================================
        // VT52 sequences the VT100 does not have
        // ---------------------------------------------------------------------
        // The VT52 grammar is inherited, so the handful of sequences that never
        // existed on a VT100 are neutralised here rather than duplicated.
        // =====================================================================

        checkEscape(ch) {
            const c = String.fromCharCode(ch);

            // ESC E — on the VT100 this is NEL (next line), not clear screen.
            if (this.parser.buffer.length === 1 && c === 'E') {
                this.parser.buffer.push(ch);
                this.carriageReturn();
                this.lineFeed();
                this.escapeReset();
                return;
            }

            // Sequences with no VT100 meaning at all. Consume them silently:
            // a real VT100 ignores what it does not understand, and answering
            // ESC Z with the VT52 identification would be actively wrong.
            if (this.parser.buffer.length === 1 &&
                (c === 'Y' || c === 'F' || c === 'G' || c === 'Z' ||
                 c === '=' || c === '>' || c === '<')) {
                this.parser.buffer = [];
                this.parser.state = 0;
                return;
            }

            // Everything else is the inherited VT52 grammar, which already
            // carries the full ANSI CSI path (ESC [ … / ESC ? …).
            super.checkEscape(ch);
        }
    }

    // The engine reaches this dialect's static tables through this binding.
    window.yapdpCore.registerDialect(Terminal);

    // =========================================================================
    // Public API — same shape as the VT52 dialect's, so the host can drive
    // either terminal through one interface.
    //
    // The unit -> terminal registry is SHARED with the VT52 dialect (it lives on
    // window.yapdpCore.terminals). Separate maps would mean a VT100 terminal is
    // invisible to vt52SnapshotAll(), so snapshots would silently drop it and
    // restoring would not bring it back.
    // =========================================================================
    const VT = window.yapdpCore.terminals;

    function vt100Initialize(unit, receiveRoutine, textArea, screenCanvas, options) {
        VT.set(unit, new Terminal(Object.assign({
            unit,
            receiveRoutine,
            textArea,
            screenCanvas
        }, options || {})));
    }

    function vt100Get(unit) {
        return VT.get(unit);
    }

    function vt100Write(unit, data) {
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

    window.yapdpDialects = window.yapdpDialects || {};
    window.yapdpDialects.VT100 = Terminal;

    window.vt100Initialize = vt100Initialize;
    window.vt100Get        = vt100Get;
    window.vt100Write      = vt100Write;
})();
