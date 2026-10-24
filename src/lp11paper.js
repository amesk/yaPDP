/*
 * lp11paper.js — the LP11 "paper copy": the plain-text job model and the
 * printable document built from it (the Print / Save .txt buttons).
 *
 * Why this file exists: the same logic used to live twice — once in the legacy
 * iopage.js closure and once in the devices/lp11.js Device copy — and the two
 * drifted apart. The Device copy (the one the browser actually runs) glued a
 * LITERAL two-character "\f" onto the line text, so exported jobs carried stray
 * markers and lost their page breaks entirely, while the legacy copy wrote a
 * real 0x0C sentinel. Both are replaced by this module; both callers delegate.
 *
 * Model:
 *   state = { buffer, bufferRuns, line, col, lineRuns }
 *     buffer[i]      — one completed line (string); FF pages are the sentinel
 *                      FF ("\f", a real 0x0C) as a buffer entry of its own.
 *     bufferRuns[i]  — style runs of that line: [{ at, len, kind }].
 *     line/col       — the line being built and the carriage column.
 *     lineRuns       — style runs of the line being built.
 *
 *   Runs record what a struck-twice line printer leaves on real paper:
 *     BOLD       — the same glyph struck twice (nroff bold, "A\bA");
 *     UNDERLINE  — a glyph struck over "_" or "_" struck over a glyph
 *                  (nroff underline, "_\bX" / "X\b_");
 *                  any other overstrike keeps the LAST glyph struck (which is
 *                  what the mechanism leaves) and reads as BOLD: a real ink
 *                  blot cannot be reproduced on paper, "heavier" can.
 *
 * Rendering: Save .txt stays plain text (a .txt has no styling). Print builds
 * one <section> per sheet, a <pre> of <b>/<u> runs per sheet, and sizes the
 * font so that exactly `columns` characters span the printable width of the
 * sheet the print dialog hands us, turned landscape like real fanfold
 * (@page { size: landscape }):
 *   100cqw / var(--colw)  — width-fit, the requested "132 columns = paper";
 *   100vh  / (lines * lh) — height guard so one logical sheet stays one sheet.
 *
 * UMD-ish: exports to window.Lp11Paper in the browser, module.exports in Node
 * (tests and the headless harness), so both printer paths share one source.
 */
(function (global) {
    "use strict";

    // A real form feed (0x0C) kept as its own line in the text copy, so the
    // .txt export and the printable document both keep real page breaks.
    var FF = "\f";
    // Pre-0.4 states stored a literal two-character marker glued to the line;
    // normalizeEntries() still understands it, so an old snapshot prints sanely.
    var LEGACY_FF = "\\f";

    var BOLD = "bold";
    var UNDERLINE = "underline";

    var DEFAULT_COLUMNS = 132;        // LP11 platen, 10 pitch
    var DEFAULT_LINES_PER_PAGE = 66;  // 11in sheet at 6 LPI
    // Real line-printer type is set solid: 10 pitch = 1/10in per glyph advance,
    // 6 LPI = 1/6in per line, so a line is 1.667 advances tall. For a monospace
    // face whose advance is 0.6em that is exactly 1.0em of line-height, and the
    // 132 x 66 block becomes 79.2 x 66 em — the 1.2 aspect ratio of the real
    // 13.2 x 11in printed area on 14 7/8 x 11in fanfold. Keep in step with the
    // print stylesheet.
    var LINE_HEIGHT = 1;
    var FONT_STACK = "'Courier New', 'Liberation Mono', 'DejaVu Sans Mono', monospace";
    // Advance width of one monospace glyph in em, used until the browser
    // measures the real face (see printDocument).
    var FALLBACK_ADVANCE = 0.6;
    // A line printer draws its glyph INSIDE the character cell: the dot matrix
    // covered roughly 75-80% of the 1/10 x 1/6in cell, which is why 6 LPI type
    // has visible air between the lines. CSS couples the glyph size to the line
    // box, so the two are decoupled here instead: the glyph is drawn at
    // AIR x cell / ink-height — where ink-height is the measured ascent+descent
    // of the resolved face — and letter-spacing widens the advance back to the
    // cell, keeping the 132-column width exact. AIR is the share of the cell the
    // ink may use; the rest is the air that keeps lines apart. Measured with
    // canvas TextMetrics in printDocument(); the fallback is used when that
    // measurement is unavailable.
    var GLYPH_FALLBACK = 0.9;
    var AIR = 0.9;

    // ------------------------------------------------------------------
    // Raw-stream recorder (debug aid, silent unless __lp11Record is on)
    // ------------------------------------------------------------------
    // The same trick pdp11.js uses for __tracePC/__trapTrace: when a driver
    // mangles a job, the text copy shows the damage but not the cause. Set
    //   __lp11Record = true
    // in the console, print the job, then read lp11RawStream() — the bytes the
    // guest actually wrote to LPDB, in order.
    var RAW_LIMIT = 16384;
    var rawRing = [];

    function recordByte(ch) {
        // globalThis, not window: the same code runs in Node (tests, headless).
        if (!global || !global.__lp11Record) return;
        rawRing.push(ch);
        if (rawRing.length > RAW_LIMIT) rawRing.splice(0, rawRing.length - RAW_LIMIT);
    }

    function rawStream() {
        return rawRing.slice();
    }

    // ------------------------------------------------------------------
    // Style runs
    // ------------------------------------------------------------------

    /**
     * markRun — record a style run over one column. Columns already carrying
     * a run keep it (first strike wins), so overlapping strikes cannot make
     * the markup ambiguous.
     */
    function markRun(runs, col, kind) {
        for (var i = 0; i < runs.length; i++) {
            var r = runs[i];
            if (col >= r.at && col < r.at + r.len) return runs;
        }
        runs.push({ at: col, len: 1, kind: kind });
        return normalizeRuns(runs);
    }

    /**
     * normalizeRuns — sort, then merge touching runs of the same kind. Also
     * drops malformed entries: runs may arrive from a snapshot written by an
     * older build, so nothing here trusts them.
     */
    function normalizeRuns(runs) {
        if (!runs || !runs.length) return [];
        var sorted = runs.filter(function (r) {
            return r && typeof r.at === "number" && typeof r.len === "number" &&
                r.len > 0 && (r.kind === BOLD || r.kind === UNDERLINE);
        }).map(function (r) {
            return { at: r.at, len: r.len, kind: r.kind };
        }).sort(function (a, b) { return a.at - b.at; });

        var out = [];
        for (var i = 0; i < sorted.length; i++) {
            var r = sorted[i];
            var last = out[out.length - 1];
            if (last && last.kind === r.kind && r.at <= last.at + last.len) {
                var end = Math.max(last.at + last.len, r.at + r.len);
                last.len = end - last.at;
            } else {
                out.push(r);
            }
        }
        return out;
    }

    /** clipRuns — cut runs to the printable width (a real platen has an edge). */
    function clipRuns(runs, columns) {
        var out = [];
        (runs || []).forEach(function (r) {
            if (r.at >= columns) return;
            out.push({ at: r.at, len: Math.min(r.len, columns - r.at), kind: r.kind });
        });
        return normalizeRuns(out);
    }

    // ------------------------------------------------------------------
    // Text state machine
    // ------------------------------------------------------------------

    function freshLine(state) {
        state.line = "";
        state.col = 0;
        state.lineRuns = [];
    }

    function pushLine(state) {
        state.buffer.push(state.line);
        state.bufferRuns.push(state.lineRuns);
        freshLine(state);
    }

    /** Lazily add the run streams, so callers may pass a bare {buffer,line,col}. */
    function ensureStreams(state) {
        if (!state.lineRuns) state.lineRuns = [];
        if (!state.bufferRuns) state.bufferRuns = [];
        return state;
    }

    /**
     * putChar — overstrike-aware insertion of one printable glyph.
     *
     * A second strike on an occupied column can only ADD ink: the mechanism
     * never lightens what is already on the paper. So a blank strike leaves the
     * glyph alone, an underscore strike underlines the glyph instead of
     * replacing it, and two real glyphs leave the last one (bold when they are
     * the same, a heavier blot when they differ). Treating the incoming byte as
     * a plain replacement is what turned "sh [ -ceik…" into "sh   -ceik…" and
     * ate whole phrases of a man page. A strike past the line end pads any gap
     * the carriage left (TAB/BS move the column without writing).
     */
    function putChar(state, ch) {
        ensureStreams(state);
        if (state.col < state.line.length) {
            var was = state.line.charAt(state.col);
            var glyph = null;
            var kind = null;
            if (ch === " ") {
                // A blank strike prints nothing at all.
            } else if (was === " ") {
                glyph = ch;                       // onto a blank: just prints
            } else if (was === "_" || ch === "_") {
                glyph = (was === "_") ? ch : was; // the underscore is the underline
                kind = UNDERLINE;
            } else {
                glyph = ch;                       // last strike wins the shape
                kind = BOLD;                      // same glyph = bold, other = blot
            }
            if (glyph !== null) {
                state.line = state.line.slice(0, state.col) + glyph +
                    state.line.slice(state.col + 1);
            }
            if (kind !== null) {
                // markRun/normalizeRuns are pure: keep the merged stream.
                state.lineRuns = markRun(state.lineRuns, state.col, kind);
            }
        } else {
            while (state.line.length < state.col) state.line += " ";
            state.line += ch;
        }
        state.col++;
        return state;
    }

    /**
     * textPut — the character stream a guest driver writes to LPDB, turned
     * into the paper copy. LF ends a line, CR returns the carriage, BS backs
     * up one column, TAB advances to the next 8-column stop with spaces.
     *
     * FF ejects the sheet AT THE CURRENT POSITION: the half-printed line is
     * completed first, then a real FF sentinel opens the next sheet. A second
     * FF with nothing printed in between is a no-op, exactly like the on-screen
     * fanfold (G60Printer only ejects a sheet that has content), so a driver
     * that pads with FF does not emit a blank sheet.
     */
    function textPut(state, ch) {
        ensureStreams(state);
        recordByte(ch);
        if (ch === 0o12) {                    // LF: complete the line
            pushLine(state);
        } else if (ch === 0o15) {             // CR: carriage to column 0
            state.col = 0;
        } else if (ch === 0o14) {             // FF: eject the sheet here
            if (state.line !== "") pushLine(state);
            var last = state.buffer.length
                ? state.buffer[state.buffer.length - 1] : null;
            if (last !== null && last !== FF) {
                state.buffer.push(FF);
                state.bufferRuns.push([]);
            }
        } else if (ch === 0o10) {             // BS: back one column
            if (state.col > 0) state.col--;
        } else if (ch === 0o11) {             // TAB: advance to the next stop
            // A tab only MOVES the carriage: it must never strike the platen.
            // Padding through putChar() would overwrite whatever was already
            // printed from the cursor to the next stop — which is how a man
            // page lost whole phrases in the job copy while the paper (G60)
            // showed them. Pad the gap only, then jump.
            var next = (state.col + 8) & ~7;
            while (state.line.length < next) state.line += " ";
            state.col = next;
        } else if (ch >= 0x20 && ch < 0x7F) { // printable ASCII
            putChar(state, String.fromCharCode(ch));
        }
        // DEL (0o7F) and other controls are ignored.
        return state;
    }

    /** joinText — the plain-text job, exactly what Save .txt writes. */
    function joinText(buffer, currentLine) {
        return (buffer || []).concat([currentLine === undefined ? "" : currentLine])
            .join("\n");
    }

    // ------------------------------------------------------------------
    // Pagination
    // ------------------------------------------------------------------

    /** clip — the platen is 132 columns wide; a longer strike is cut there. */
    function clip(text, columns) {
        text = text === null || text === undefined ? "" : String(text);
        return text.length > columns ? text.slice(0, columns) : text;
    }

    /**
     * normalizeEntries — buffer + the line in progress become printable
     * entries: { text, runs } for a line, { pageBreak: true } for an FF.
     * Understands the legacy literal "\f" marker as well, so jobs captured by
     * an older build still break pages instead of printing the marker.
     */
    function normalizeEntries(buffer, currentLine, bufferRuns) {
        var entries = [];
        var lines = (buffer || []).slice();
        if (currentLine !== undefined && currentLine !== null) lines.push(currentLine);
        var runs = (bufferRuns || []).slice();

        lines.forEach(function (raw, i) {
            var text = raw === null || raw === undefined ? "" : String(raw);
            if (text === FF) {                       // real 0x0C sentinel
                entries.push({ pageBreak: true });
                return;
            }
            var lineRuns = runs[i] || [];
            if (text === LEGACY_FF) {                // pre-0.4 glued marker
                entries.push({ pageBreak: true });
                return;
            }
            if (text.length > 2 && text.slice(-2) === LEGACY_FF) {
                text = text.slice(0, -2);
                entries.push({ text: text, runs: lineRuns });
                entries.push({ pageBreak: true });
                return;
            }
            entries.push({ text: text, runs: lineRuns });
        });
        return entries;
    }

    /**
     * asEntries — buildPrintDocument accepts either prepared entries or raw
     * buffer lines (with FF sentinels and the legacy literal marker), so a
     * caller cannot skip the normalization step by accident.
     */
    function asEntries(input) {
        var list = input || [];
        var raw = list.every(function (e) {
            return e === null || e === undefined || typeof e === "string";
        });
        return raw ? normalizeEntries(list, undefined, []) : list;
    }

    /**
     * paginate — entries become sheets. A sheet ends on an FF or after
     * `linesPerPage` lines, whichever comes first, and an FF that arrives when
     * nothing has been printed since the previous sheet does not add a blank
     * one. Trailing blank sheets are dropped for the same reason.
     */
    function paginate(entries, options) {
        var opts = options || {};
        var columns = opts.columns || DEFAULT_COLUMNS;
        var linesPerPage = opts.linesPerPage || DEFAULT_LINES_PER_PAGE;

        var pages = [];
        var page = [];
        function flush() {
            if (page.length) { pages.push(page); page = []; }
        }

        (entries || []).forEach(function (entry) {
            if (entry && entry.pageBreak) { flush(); return; }
            if (!entry) return;
            page.push({
                text: clip(entry.text, columns),
                runs: clipRuns(entry.runs, columns),
            });
            if (page.length >= linesPerPage) flush();
        });
        flush();
        return pages;
    }

    // ------------------------------------------------------------------
    // Printable document
    // ------------------------------------------------------------------

    // The replacement texts are assembled from a code point on purpose. Written
    // as literal entities they were rewritten into bare "&", "<" and ">" by an
    // editor on save, which silently turned this function into a no-op — the
    // same defect the legacy iopage.js copy shipped with.
    var AMP = String.fromCharCode(38);
    var ESCAPE_MAP = {
        38: AMP + "amp;",
        60: AMP + "lt;",
        62: AMP + "gt;",
    };

    function escapeHtml(text) {
        return String(text).replace(/[&<>]/g, function (ch) {
            return ESCAPE_MAP[ch.charCodeAt(0)];
        });
    }

    /** lineHtml — one printed line: escaped glyphs plus <b>/<u> over the runs. */
    function lineHtml(entry) {
        var text = entry && entry.text ? entry.text : "";
        var runs = normalizeRuns((entry && entry.runs) || []);
        if (!runs.length) return escapeHtml(text);

        var out = "";
        var pos = 0;
        runs.forEach(function (r) {
            var at = Math.max(0, r.at);
            var end = Math.min(text.length, r.at + r.len);
            if (end <= pos || end <= at) return;
            if (at > pos) out += escapeHtml(text.slice(pos, at));
            var inner = escapeHtml(text.slice(at, end));
            out += (r.kind === UNDERLINE) ? "<u>" + inner + "</u>" : "<b>" + inner + "</b>";
            pos = end;
        });
        if (pos < text.length) out += escapeHtml(text.slice(pos));
        return out;
    }

    /**
     * buildPrintDocument — the HTML handed to the hidden print iframe.
     *
     * The paper is whatever the print dialog settles on, turned landscape
     * (@page size: landscape, like real fanfold); the font is sized from the
     * printable box instead of a guessed sheet, so
     * `columns` characters span its width exactly and `linesPerPage` lines fit
     * its height. --colw is the width of one full line in em, refined by
     * printDocument() once the resolved face has been measured; --lpp is the
     * line count the height guard divides by.
     */
    function buildPrintDocument(entries, options) {
        var opts = options || {};
        var columns = opts.columns || DEFAULT_COLUMNS;
        var linesPerPage = opts.linesPerPage || DEFAULT_LINES_PER_PAGE;
        var title = opts.title || "LP11 output";
        // Default: turn whatever paper the dialog offers. A caller may name the
        // sheet explicitly — real 14 7/8 x 11in fanfold needs that, because the
        // `landscape` keyword would rotate an already-landscape custom size.
        var pageSize = opts.pageSize || "landscape";
        var fontStack = opts.fontStack || FONT_STACK;
        // The paper LOOK: green-bar fanfold with perforated tractor strips.
        // "plain" leaves a bare sheet — the right choice when the job really goes
        // onto fanfold, where the perforation and the seam are already there.
        var fanfold = (opts.paper || "fanfold") !== "plain";
        // The strips are not printable area: they take width from the text
        // column exactly as the tractor holes do. The share comes from the
        // on-screen paper (css/g60printer.css): a 33px strip beside a 960px
        // print area is 3.4% of the sheet, split between the two edges.
        var strip = fanfold ? "1.7%" : "0";
        // The on-screen paper is the artwork, not a gradient: paper.png is a
        // 96x64 tile over a 960px-wide column of 16px lines, i.e. one tile per
        // four character cells. Sizing it the same way here keeps the bar period
        // and colour identical to the Printer page.
        var paperUrl = opts.paperUrl || "assets/images/paper.png";
        var pages = paginate(asEntries(entries), opts);

        // .col is the text column: it carries the container query (so 100cqw is
        // the printable width between the strips), the green bars and the
        // perforated strips as pseudo-elements.
        var body = pages.map(function (page) {
            var lines = page.map(function (line) { return lineHtml(line); }).join("\n");
            return '<section class="page"><div class="col"><pre>' + lines +
                "</pre></div></section>";
        }).join("");

        return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
            "<title>" + escapeHtml(title) + "</title><style>" +
            ":root { --adv: " + FALLBACK_ADVANCE +
            "; --colw: " + (columns * FALLBACK_ADVANCE).toFixed(4) +
            "; --lpp: " + linesPerPage + "; --glyph: " + GLYPH_FALLBACK +
            "; --cell: min(calc(100cqw / var(--colw)), calc(100vh / var(--lpp))); }" +
            // A line-printer sheet is WIDER than it is tall (14 7/8 x 11in), so
            // landscape is the faithful orientation: the tractor strips fall on
            // the long edges and 132 columns keep their share of the width,
            // exactly as on the paper. The bare `landscape` keyword keeps the
            // paper the operator picks in the dialog and only turns it; an
            // explicit size ("14.875in 11in") can be passed for real fanfold.
            "@page { size: " + pageSize + "; margin: 10mm; }" +
            "html, body { margin: 0; padding: 0; background: #fff; color: #000; }" +
            "body { font-family: " + fontStack + "; }" +
            ".page { position: relative; break-after: page; page-break-after: always;" +
            " break-inside: avoid; padding: 0 " + strip + "; }" +
            ".page:last-child { break-after: auto; page-break-after: auto; }" +
            ".col { position: relative; container-type: inline-size; }" +
            (fanfold
                // The strips are painted on the page box, not on <pre>, so they
                // must be the SAME paper as the text column — otherwise the white
                // rows read as grey beside a #fff margin. The tile itself cannot
                // move here (its 100cqw sizing resolves inside .col), so the page
                // gets the paper's own colour, which is exactly what the strips
                // show between the holes on screen (paper-margin.png is the same
                // stock): measured 241,239,238.
                ? ".page { background-color: #f1efee; }" +
                  // The same paper.png tile the Printer page uses, scaled so one
                  // tile is four character cells (64px / 16px on screen): the bar
                  // period and the colour are then the artwork's, not an imitation.
                  // It sits on the <pre>, the element whose container (cqw) and
                  // font are resolved.
                // Two layers: the artwork on top, and a bar gradient underneath
                // as a fallback — if the tile cannot be loaded (the print
                // document lives in an about:blank iframe, where a relative URL
                // may not resolve) the bars must not vanish. The fallback carries
                // the TILE'S OWN colours — measured from paper.png as
                // 228,232,229 on 242,240,239 — so the printed sheet looks the
                // same colour whichever layer gets painted. The old #dfe8d2 /
                // #ffffff pair was visibly greener and whiter than the artwork,
                // which is why the print dialog and the Printer page disagreed.
                  "pre { background-image: url('" + paperUrl + "')," +
                  " repeating-linear-gradient(to bottom, #e4e8e5 0 calc(var(--cell))," +
                  " #f2f0ef calc(var(--cell)) calc(var(--cell) * 2));" +
                  " background-size: 100% calc(var(--cell) * 4), 100% calc(var(--cell) * 2);" +
                  " background-repeat: repeat, repeat; background-position: 0 0, 0 0; }" +
                  // Tractor strips: feed holes every half inch, as on the paper,
                  // a third of the strip wide. They sit INSIDE the page box (the
                  // .page padding), because anything painted in the @page margin
                  // is clipped away by the printer.
                  ".page::before, .page::after { content: \"\"; position: absolute;" +
                  " top: 0; bottom: 0; width: " + strip + ";" +
                  " background-image: radial-gradient(circle closest-side at 50% 50%," +
                  " #141414 0 62%, transparent 72%);" +
                  " background-size: 100% 12.7mm; background-repeat: repeat-y;" +
                  " background-position: 50% 0; }" +
                  ".page::before { left: 0; }" +
                  ".page::after { right: 0; }"
                : "") +
            // --cell is the machine's character cell (the line pitch, one cell
            // tall); the glyph is drawn smaller inside it and letter-spacing
            // widens the advance back to the cell width, so the column count and
            // the line pitch stay the machine's while the type keeps its air.
            "pre { margin: 0; font-family: inherit; white-space: pre; overflow: hidden;" +
            " font-size: calc(var(--cell) * var(--glyph));" +
            " line-height: calc(1 / var(--glyph));" +
            " letter-spacing: calc(var(--cell) * var(--adv) * (1 - var(--glyph))); }" +
            "b { font-weight: 700; }" +
            "u { text-decoration: underline; }" +
            "@supports not (container-type: inline-size) { pre { font-size: 5.5pt; } }" +
            "</style></head><body><div class=\"sheet\">" + body + "</div></body></html>";
    }

    /**
     * measureLineEm — width of `columns` glyphs at 100px, in em. Runs inside
     * the print iframe before printing, once per weight: a bold face whose
     * advance is wider than the roman one would break the column grid, so the
     * caller keeps the larger of the two.
     */
    function measureLineEm(doc, columns, fontStack, weight) {
        var probe = doc.createElement("span");
        probe.setAttribute("style", "position:absolute;left:-9999px;top:0;" +
            "visibility:hidden;white-space:pre;font-family:" + fontStack +
            ";font-size:100px;font-weight:" + weight + ";");
        probe.textContent = new Array(columns + 1).join("M");
        doc.body.appendChild(probe);
        var px = probe.getBoundingClientRect().width;
        if (probe.parentNode) probe.parentNode.removeChild(probe);
        return px > 0 ? px / 100 : columns * FALLBACK_ADVANCE;
    }

    /**
     * measureInkEm — height of the visible ink (ascenders + descenders) of the
     * resolved face, in em, measured on real glyphs rather than on the font's
     * line box: the box says nothing about how much of the cell the letters
     * actually cover, and sizing by the box is what made the type look stunted.
     */
    function measureInkEm(doc, fontStack) {
        var canvas = doc.createElement("canvas");
        var ctx = canvas.getContext ? canvas.getContext("2d") : null;
        if (!ctx) return 0;
        ctx.font = "100px " + fontStack;
        var m = ctx.measureText("Mgjpq_|");
        var up = m.actualBoundingBoxAscent || 0;
        var down = m.actualBoundingBoxDescent || 0;
        return (up + down) > 0 ? (up + down) / 100 : 0;
    }

    /** ready — Node has no document; callers skip printing there. */
    function canPrint() {
        return typeof document !== "undefined" && typeof window !== "undefined";
    }

    /**
     * printDocument — open the system print dialog with the paper copy of the
     * job. DOM-only: the pure parts above stay testable in Node.
     */
    function printDocument(buffer, currentLine, bufferRuns, options) {
        var entries = normalizeEntries(buffer, currentLine, bufferRuns);
        var opts = options || {};
        var columns = opts.columns || DEFAULT_COLUMNS;
        // The print document is written into an about:blank iframe, where a
        // relative url() may resolve against nothing: pin the artwork to an
        // absolute URL now, while the real document is still in scope.
        if (!opts.paperUrl && typeof document !== "undefined" && document.baseURI) {
            opts = Object.assign({}, opts, {
                paperUrl: new URL("assets/images/paper.png", document.baseURI).href,
            });
        }
        if (!canPrint()) return false;
        if (!entries.some(function (e) { return e.text && e.text.trim(); })) {
            return false; // nothing but blank paper
        }

        var iframe = document.createElement("iframe");
        iframe.setAttribute("style",
            "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;");
        document.body.appendChild(iframe);
        var doc = iframe.contentWindow.document;
        doc.open();
        doc.write(buildPrintDocument(entries, opts));
        doc.close();

        try {
            var fontStack = opts.fontStack || FONT_STACK;
            var roman = measureLineEm(doc, columns, fontStack, "normal");
            var bold = measureLineEm(doc, columns, fontStack, "700");
            doc.documentElement.style.setProperty(
                "--colw", Math.max(roman, bold).toFixed(4));
            // Draw the glyph inside the machine's cell with AIR to spare, sized
            // by the face's measured ink rather than by its line box (see AIR):
            // the ink fills AIR of the cell, the rest keeps the lines apart.
            var ink = measureInkEm(doc, fontStack);
            var glyph = ink > 0 ? Math.min(1, Math.max(0.6, AIR / ink)) : GLYPH_FALLBACK;
            doc.documentElement.style.setProperty("--glyph", glyph.toFixed(4));
        } catch (e) { /* keep the CSS fallback: printing still works */ }

        // The paper tile is a CSS background, and the system dialog can open
        // before it decodes — Chrome then paints the fallback bars instead of the
        // artwork. Warm the tile in the print document itself and print only
        // once it has loaded; onerror is the same path (a missing tile must not
        // hold the dialog hostage) and the timeout is the last resort for a URL
        // that never settles.
        var printed = false;
        function doPrint() {
            if (printed) return;
            printed = true;
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
            setTimeout(function () {
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            }, 1000);
        }
        var wantsTile = (opts.paper || "fanfold") !== "plain" && !!opts.paperUrl;
        if (!wantsTile) {
            doPrint();
        } else {
            var warmed = doc.createElement("img");
            // Out of the layout and out of the printed page, but still fetched.
            warmed.setAttribute("style",
                "position:absolute;left:-9999px;top:0;width:0;height:0;");
            warmed.onload = doPrint;
            warmed.onerror = doPrint;
            warmed.src = opts.paperUrl;
            doc.body.appendChild(warmed);
            setTimeout(doPrint, 1500);
        }
        return true;
    }

    var api = {
        FF: FF,
        LEGACY_FF: LEGACY_FF,
        BOLD: BOLD,
        UNDERLINE: UNDERLINE,
        DEFAULT_COLUMNS: DEFAULT_COLUMNS,
        DEFAULT_LINES_PER_PAGE: DEFAULT_LINES_PER_PAGE,
        LINE_HEIGHT: LINE_HEIGHT,
        GLYPH_FALLBACK: GLYPH_FALLBACK,
        AIR: AIR,
        FONT_STACK: FONT_STACK,
        putChar: putChar,
        textPut: textPut,
        rawStream: rawStream,
        markRun: markRun,
        normalizeRuns: normalizeRuns,
        clipRuns: clipRuns,
        joinText: joinText,
        normalizeEntries: normalizeEntries,
        asEntries: asEntries,
        paginate: paginate,
        escapeHtml: escapeHtml,
        lineHtml: lineHtml,
        buildPrintDocument: buildPrintDocument,
        printDocument: printDocument,
        canPrint: canPrint,
    };

    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.Lp11Paper = api;
        // Console hook for driver debugging: __lp11Record = true, print the job,
        // then lp11RawStream() returns the bytes the guest wrote to LPDB.
        window.lp11RawStream = rawStream;
    }
})(typeof window !== "undefined" ? window : globalThis);
