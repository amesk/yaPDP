/*
 * g60printer.js
 * Google60-style line printer for PDP-11 console output
 * Adapted from Google60 by Norbert Landsteiner (mass:werk)
 *
 * This module provides a Printer class that renders text output
 * with animated line-printer effects: character-by-character printing,
 * moving print head, paper scrolling, and sound effects.
 */

(function() {
    'use strict';

    // ====================================================================
    // AudioManager
    // Uses keypunch2.mp3 (cloned per-play) for single character print,
    // teletype33-print.mp3 (long) for animated line printing,
    // teletype33-lf.mp3 for line feed.
    //
    // Cloning the Audio element for each play avoids overlap/restart issues:
    // each clone plays independently once and is garbage-collected.
    // ====================================================================
    var G60Audio = {
        _sounds: {},

        load: function(name, url) {
            try {
                var audio = new Audio(url);
                audio.preload = 'auto';
                this._sounds[name] = audio;
            } catch(e) {}
        },

        /**
         * Play a sound by cloning the pre-loaded Audio element.
         * The clone plays independently, so rapid calls never collide.
         */
        playCloned: function(name) {
            try {
                var s = this._sounds[name];
                if (s) {
                    var clone = s.cloneNode();
                    clone.volume = 0.5;
                    clone.play().catch(function() {});
                }
            } catch(e) {}
        },

        play: function(name) {
            try {
                var s = this._sounds[name];
                if (s) { s.currentTime = 0; s.play().catch(function() {}); }
            } catch(e) {}
        },

        // Start the dedicated line-printer whirr if it is not already playing.
        // Uses a SEPARATE audio element ("whirr") so the console teletype's
        // handling of the shared "print" sound can never cut it off. Driven by
        // the element's paused state so an autoplay-blocked attempt is retried
        // on the next tick once the user gesture unlocks audio.
        startWhirr: function() {
            try {
                var s = this._sounds['whirr'];
                if (s && s.paused) { s.loop = true; s.currentTime = 0; s.play().catch(function() {}); }
            } catch(e) {}
        },

        // Stop the line-printer whirr if it is currently playing.
        stopWhirr: function() {
            try {
                var s = this._sounds['whirr'];
                if (s && !s.paused) { s.pause(); s.currentTime = 0; s.loop = false; }
            } catch(e) {}
        },

        stopSound: function(name) {
            try {
                var s = this._sounds[name];
                if (s) { s.pause(); s.currentTime = 0; s.loop = false; }
            } catch(e) {}
        }
    };

    // Pre-load sounds
    G60Audio.load('punch', '../assets/sounds/keypunch2.mp3');      // short punch for single char
    G60Audio.load('print', '../assets/sounds/teletype33-print.mp3'); // long for line animation
    G60Audio.load('linefeed', '../assets/sounds/teletype33-lf.mp3'); // line feed
    // Dedicated element for the continuous LP11 whirr — separate from the
    // shared "print" element so the console teletype never stops it.
    G60Audio.load('whirr', '../assets/sounds/teletype33-print.mp3');

    // ====================================================================
    // Google60-style Line Printer
    // ====================================================================

    /**
     * G60Printer constructor
     * @param {string} containerId - DOM element ID to attach the printer to
     * @param {object} [options] - optional printer configuration
     *   options.maxCols        - printable columns (72/80/100/132); default 72
     *   options.idPrefix       - string prefix for the generated DOM element ids,
     *                            so multiple printer instances keep unique ids
     *                            (e.g. 'lp11' for the LP11 printer page)
     *   options.charPrintDelay - ms per character for the paced console echo
     *                            (default 30, ~33 cps). The LP11 line printer
     *                            overrides this with a small value so it prints
     *                            much faster than the ASR 33 console teletype.
     *   options.charSound      - play per-character punch / line-feed sounds
     *                            (default true; false disables them, used by the
     *                            fast LP11 line printer)
     *   options.charsPerTick   - how many buffered items are rendered per pacing
     *                            timer tick (default 1). The LP11 line printer
     *                            raises this to burst several characters per tick
     *                            and print close to the real ~300 LPM; the console
     *                            teletype keeps 1 (authentic per-character pacing).
     *   options.printWhirr     - play a looping continuous "print" sound while
     *                            characters are being rendered and stop when the
     *                            buffer drains (default false). Used by the fast
     *                            LP11 line printer instead of per-character clicks.
     */
    window.G60Printer = function(containerId, options) {
        var container = document.getElementById(containerId);
        if (!container) throw new Error('Container ' + containerId + ' not found');

        // Optional configuration (CONFIG page)
        var opts = options || {};
        var idPrefix = (typeof opts.idPrefix === 'string') ? opts.idPrefix : '';
        var PRINT_WIDTHS = [72, 80, 100, 132];

        // Printer state
        var textPos, textBuffer, timer, timer2, lines,
            element, printArea, paper, topSpacer, printHead,
            topOverlay, paperTopShadow,
            scrollState, scrollLock, initialTop, idle, headPos,
            headDir, curLine, headUp, callback, keepLocked,
            delayFeed, feedDy, topSpacerVisible, lastTime,
            lastLineFeed, afId1, afId2, afId3,
            spacerCurrentHeight;

        // Character pacing state. The per-character delay is configurable so a
        // fast line printer (LP11) can echo far faster than the ASR 33 console
        // teletype: the console keeps the authentic ~30 ms/char (33 cps) pacing
        // while the LP11 instance overrides it with a small value (~3 ms).
        var charPrintDelay = (typeof opts.charPrintDelay === 'number' && opts.charPrintDelay > 0)
            ? opts.charPrintDelay : 30;
        // Per-character punch / line-feed click sounds. Disabled for the fast
        // LP11 line printer: a real drum/chain printer makes continuous noise,
        // not per-character ticks.
        var charSound = (opts.charSound !== false);
        // Burst size per pacing tick. The LP11 line printer renders several
        // buffered items per tick (e.g. 3), lifting throughput above the
        // browser's ~4 ms floor for nested timers; the ASR 33 console keeps 1.
        var charsPerTick = (typeof opts.charsPerTick === 'number' && opts.charsPerTick >= 1)
            ? Math.floor(opts.charsPerTick) : 1;
        // Continuous line-printer whirr: while characters are being rendered the
        // fast LP11 plays a looping "print" sound (a real line printer makes
        // steady noise), stopping when the buffer drains. The ASR 33 console
        // keeps per-character clicks (charSound) instead.
        var printWhirr = (opts.printWhirr === true);
        // Form feed (FF, 0x0C): a real line printer advances the paper to the
        // top of the next page. On the continuous G60 paper this is rendered
        // as `pageLength` empty lines (filling the rest of the sheet) followed
        // by a fold/perforation marker at the seam. 2.11BSD lpd sends FF
        // between jobs, so each job starts on a fresh page. 66 lines = an 11"
        // fanfold page at 6 LPI.
        var pageLength = (typeof opts.pageLength === 'number' && opts.pageLength > 0)
            ? Math.floor(opts.pageLength) : 66;
        // Draw the fold-marker line on form feed (a dashed perforation seam).
        // A real ASR 33 used a smooth paper ROLL (no fanfold folds), so the
        // console teletype disables this; the LP11 fanfold paper keeps it.
        var pageBreakMarker = (opts.pageBreakMarker !== false);
        // Form-feed page tracking: pagePos counts lines printed on the current
        // fanfold sheet (wraps at pageLength); pageHasContent tells whether any
        // line has been printed since the last fold seam. Together they let a
        // form feed fill only the REMAINDER of the sheet (nroff-formatted man
        // pages already fill the page, so the footer sits right before the
        // seam) instead of always inserting a full extra blank page.
        var pagePos = 0;
        var pageHasContent = false;
        var charBuffer = [];        // pending characters to print
        var charPrintTimer = null;  // timer ID for paced printing
        var CHAR_LF = '\n';         // sentinel marker in buffer to trigger a line feed
        var CHAR_BS = '\b';         // sentinel marker in buffer to trigger a backspace
        var CHAR_CR = '\r';         // sentinel marker in buffer to trigger a carriage return
        var CHAR_FF = '\f';         // sentinel marker in buffer to trigger a form feed (page eject)
        // Sentinel queued AFTER the page filler so the fold marker is drawn
        // when the blank lines have scrolled past (seam at the sheet bottom).
        var CHAR_FF_MARK = '\u000C\u000C';

        // Printer configuration
        var delayBlank = 7;
        var delayChar = 12;
        var delayCharUp = 6;
        var delayEmptyLine = 50;
        var headIdlePos = -3;
        var headOffset = 30;
        var lineHeight = 16;
        var charWidth = 7;
        // Maximum printable columns per line.  Authentic ASR 33 stops the
        // carriage at the right margin (72 columns; some setups use 80) and
        // further characters overstrike the last column instead of wrapping
        // or widening the paper.
        var maxCols = (PRINT_WIDTHS.indexOf(Number(opts.maxCols)) !== -1)
            ? Number(opts.maxCols) : 72;

        // Printable-paper layout constants (CSS values, see g60printer.css).
        var PAPER_PADDING_X = 18;  // horizontal padding of the print-area cell
        var PAPER_MARGIN_X = 33;   // width of the left/right paper margin columns
        var LEFT_SKIN_WIDTH = 67;  // width of the fixed left machine skin
        var RIGHT_SKIN_WIDTH = 66; // width of the fixed right machine skin

        /**
         * computePaperGeometry(cols, opts) - Pure, DOM-free geometry helper.
         * Derives the printable-paper layout for a column count so a full
         * line of `cols` monospaced characters fills the paper from margin to
         * margin, with the paper centred between the fixed side skins of the
         * machine body. Kept as a standalone function so it can be extracted
         * and unit-tested in Node (see tests/paper-geometry.test.js).
         *
         * @param {number} cols - printable columns (72/80 teletype, 72..132 LP11)
         * @param {object} opts - layout constants:
         *   bodyWidth - usable inner width of the machine (container minus skins)
         *   charWidth - fixed monospaced cell width in px (7)
         *   paddingX  - horizontal padding of the print-area cell (18)
         *   marginX   - paper margin column width (33)
         *   leftSkin  - width of the left machine skin (67)
         * @returns {object} { paperWidth, paperLeft, printAreaWidth, headOffset }
         *   All values in px; headOffset keeps the carriage aligned with column 0.
         */
        function computePaperGeometry(cols, opts) {
            var bodyWidth = opts.bodyWidth;
            var cw = opts.charWidth;
            var paddingX = opts.paddingX;
            var marginX = opts.marginX;
            var leftSkin = opts.leftSkin;

            var contentWidth = cols * cw;
            // Rendered paper width = content + cell padding + both margin columns.
            var paperWidth = contentWidth + 2 * paddingX + 2 * marginX;
            paperWidth = Math.min(paperWidth, bodyWidth);

            // Centre the paper between the fixed side skins.
            var paperLeft = leftSkin + Math.max(0, Math.round((bodyWidth - paperWidth) / 2));

            // The print-area cell width is the pure content width (content-box);
            // the browser adds the 2*paddingX cell padding on top.
            var printAreaWidth = contentWidth;

            // Carriage offset follows the paper so column 0 stays aligned.
            // 30 was the original offset for the left-anchored layout
            // (paperLeft === leftSkin).
            var headOffset = 30 + (paperLeft - leftSkin);

            return {
                paperWidth: paperWidth,
                paperLeft: paperLeft,
                printAreaWidth: printAreaWidth,
                headOffset: headOffset
            };
        }

        /**
         * applyPaperGeometry() - Re-compute and apply the paper layout for the
         * current maxCols: paper position/width, print-area width, the paper
         * top overlay/shadow and the carriage head offset. When the machine is
         * on a hidden page (clientWidth is 0) it is skipped and reapplied by a
         * ResizeObserver once the page becomes visible.
         */
        function applyPaperGeometry() {
            if (!paper || !printArea || !topOverlay || !paperTopShadow) return;
            var bodyWidth = element.clientWidth - LEFT_SKIN_WIDTH - RIGHT_SKIN_WIDTH;
            if (bodyWidth <= 0) return; // hidden page; ResizeObserver reapplies
            var g = computePaperGeometry(maxCols, {
                bodyWidth: bodyWidth,
                charWidth: charWidth,
                paddingX: PAPER_PADDING_X,
                marginX: PAPER_MARGIN_X,
                leftSkin: LEFT_SKIN_WIDTH
            });
            paper.style.left = g.paperLeft + 'px';
            paper.style.width = g.paperWidth + 'px';
            printArea.style.width = g.printAreaWidth + 'px';
            topOverlay.style.left = g.paperLeft + 'px';
            topOverlay.style.width = g.paperWidth + 'px';
            paperTopShadow.style.left = g.paperLeft + 'px';
            paperTopShadow.style.width = g.paperWidth + 'px';
            headOffset = g.headOffset;
            // If the carriage has already been placed (e.g. the machine was
            // hidden at construction and this runs from a ResizeObserver
            // later), reposition it so the new offset applies immediately —
            // otherwise the head would sit at the previous offset until the
            // next keystroke.
            if (typeof headPos === 'number') {
                setHeadPos(headPos, headUp);
            }
        }
        var headBaseY = 8;
        var headUpY = 1;
        var headUpFuzzyness = 3;
        var bidirectional = true;
        var missedCharOpacity = true;
        var animateCharDetail = true;
        var paperHeight = 400;
        var paperTopSpacerOffset = 329;
        var spacerFullHeight = 345;
        var spacerMinHeight = 16;

        feedDy = 1;
        delayFeed = 40;

        // Current line tracking for character-by-character printing
        var currentLineEl = null;  // the current <p> element
        var currentCharPos = 0;    // character position in current line
        var overHang = 0;          // pending overstrike positions after a backspace

        // CSS property detection
        var cssPropertyTransform = '';
        var cssPropertyOpacity = '';
        var reqAnimFrame = null;
        var cancelReqAnimFrame = null;
        var performanceNow = Boolean(window.performance);

        // Detect CSS properties and requestAnimationFrame
        (function() {
            var vendors = ['moz', 'webkit', 'ms', 'o'];
            var el = document.createElement('div');
            var s = el.style;
            s.cssText = 'opacity:0.5;-webkit-opacity:0.5;-moz-opacity:0.5;-o-opacity:0.5;';
            if (s.opacity) cssPropertyOpacity = 'opacity';
            else if (s.webkitOpacity) cssPropertyOpacity = 'webkitOpacity';
            else if (s.MozOpacity) cssPropertyOpacity = 'MozOpacity';
            else if (s.OOpacity) cssPropertyOpacity = 'OOpacity';
            s.cssText = 'transform:rotate(10deg);-webkit-transform:rotate(10deg);-moz-transform:rotate(10deg);-o-transform:rotate(10deg);-ms-transform:rotate(10deg);';
            if (s.transform) cssPropertyTransform = 'transform';
            else if (s.webkitTransform) cssPropertyTransform = 'webkitTransform';
            else if (s.MozTransform) cssPropertyTransform = 'MozTransform';
            else if (s.OTransform) cssPropertyTransform = 'OTransform';
            else if (s.msTransform) cssPropertyTransform = 'msTransform';
            if (window.requestAnimationFrame) {
                reqAnimFrame = window.requestAnimationFrame;
                cancelReqAnimFrame = window.cancelAnimationFrame;
            } else {
                for (var i = 0; i < vendors.length; i++) {
                    var vend = vendors[i];
                    reqAnimFrame = window[vend + 'RequestAnimationFrame'];
                    if (reqAnimFrame) {
                        cancelReqAnimFrame = window[vend + 'CancelAnimationFrame'] ||
                            window[vend + 'CancelRequestAnimationFrame'];
                        break;
                    }
                }
            }
        })();

        // ================================================================
        // Printer DOM Setup
        // ================================================================

        function setupPrinter() {
            // All generated DOM ids are prefixed (options.idPrefix) so that
            // multiple printer instances on different pages keep unique ids
            // (empty prefix -> legacy ids, e.g. "printer", "paper").
            function pid(name) { return idPrefix + name; }
            var tbl, tb, tr, td1, td2, td3, el;
            element = document.createElement('div');
            element.id = pid('printer');
            el = document.createElement('div'); el.id = pid('printer_left'); element.appendChild(el);
            el = document.createElement('div'); el.id = pid('printer_right'); element.appendChild(el);
            topOverlay = document.createElement('div'); topOverlay.id = pid('printer_topoverlay'); element.appendChild(topOverlay);
            paper = document.createElement('div'); paper.id = pid('paper'); paper.className = 'paperNoScroll';
            topSpacer = document.createElement('div'); topSpacer.id = pid('paper_topspacer'); paper.appendChild(topSpacer);
            tbl = document.createElement('table'); tbl.id = pid('paper_area'); tb = document.createElement('tbody');
            tr = document.createElement('tr');
            td1 = document.createElement('td'); td1.id = pid('paper_top'); td1.setAttribute('colspan', 3); tr.appendChild(td1); tb.appendChild(tr);
            tr = document.createElement('tr');
            td1 = document.createElement('td'); td1.id = pid('papermargin_left');
            td2 = document.createElement('td'); td2.id = pid('paper_printarea');
            td3 = document.createElement('td'); td3.id = pid('papermargin_right');
            tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tb.appendChild(tr);
            tr = document.createElement('tr'); tr.id = pid('paper_bottom');
            td1 = document.createElement('td'); td1.setAttribute('colspan', 3); tr.appendChild(td1); tb.appendChild(tr);
            tbl.appendChild(tb); paper.appendChild(tbl); element.appendChild(paper);
            paperTopShadow = document.createElement('div'); paperTopShadow.id = pid('paper_topshadow'); element.appendChild(paperTopShadow);
            el = document.createElement('div'); el.id = pid('printer_frontpannel'); element.appendChild(el);
            el = document.createElement('div'); el.id = pid('printheadarea'); element.appendChild(el);
            printHead = document.createElement('img');
            printHead.id = pid('printhead'); printHead.src = '../assets/images/printhead.png'; el.appendChild(printHead);
            printArea = td2;
            container.appendChild(element);
            applyPaperGeometry();
            // Re-apply paper geometry once the machine gets a real size (e.g.
            // when a hidden LP11 page becomes active).
            if (typeof window.ResizeObserver !== 'undefined') {
                new ResizeObserver(function() { applyPaperGeometry(); }).observe(element);
            }
            resetPrinter();
        }

        // ================================================================
        // Character-by-character printing (for real-time console echo)
        // ================================================================

        /**
         * doPrintChar(c) - Internal: render a single character immediately.
         * This is the actual rendering logic, separated from the pacing queue.
         */
        function doPrintChar(c) {
            if (!currentLineEl) {
                currentLineEl = document.createElement('p');
                printArea.appendChild(currentLineEl);
                // Every line carries a leading NBSP spacer at children[0]
                // (see doPrintln()/resetPrinter()), so the character of column
                // k lives at children[k+1]. A line created here — the first
                // line after a form-feed page break, when doFormFeedMarker()
                // reset currentLineEl to null — must get the same spacer, or
                // it would render one cell left of every later line and lose
                // its leading space (e.g. the od offset column).
                var spaceEl = document.createElement('span');
                spaceEl.textContent = '\u00A0';
                currentLineEl.appendChild(spaceEl);
                currentCharPos = 0;
            }
            // A printed character marks the current sheet as used, so the
            // following form feed will close the page (draw the seam).
            pageHasContent = true;

            // Play short punch sound (cloned Audio element per play).
            // Skipped for the fast LP11 line printer (charSound:false).
            if (charSound) G60Audio.playCloned('punch');

            var space = (c === ' ');
            var span;

            if (currentCharPos >= maxCols) {
                // Carriage has reached the right margin: the carriage-return
                // mechanism is physically blocked, so every further character
                // overstrikes the last column, building up an unreadable dark
                // blob (authentic ASR 33 behaviour). No automatic wrapping.
                // NB: a leading NBSP span occupies children[0], so the
                // character on column k lives at children[k + 1]; the last
                // column (maxCols - 1) is therefore children[maxCols].
                span = currentLineEl.children[maxCols];
                if (span) {
                    span.textContent = space ? '\u00A0' : c;
                    if (span.className.indexOf('overstrike') === -1) {
                        span.className += ' overstrike';
                    }
                }
            } else if (overHang > 0) {
                // Overstrike: print over the character left by a previous
                // backspace/carriage return. nroff/man renders bold as "X\bX"
                // (or "X\rX") and underline as "_\bX" (or "_\rX"); the second
                // pass replaces the first. The leading NBSP span occupies
                // position 0, so the target character is at currentCharPos + 1.
                // Re-printing the SAME glyph is how a real terminal produces
                // bold (heavier ink), and a letter over an underscore produces
                // underline — mark the span so the CSS can show the emphasis.
                var index = currentCharPos + 1;
                span = currentLineEl.children[index];
                if (span) {
                    if (space) {
                        // A space overstrike is pure carriage motion on a real
                        // terminal (nroff moves the carriage with spaces between
                        // overstruck words); it must NOT erase the existing glyph.
                    } else {
                        var prevGlyph = span.textContent;
                        span.textContent = c;
                        if (c !== '_' && prevGlyph === c) {
                            // Same character overstruck → bold
                            if (span.className.indexOf('bold') === -1) span.className += ' bold';
                        } else if (c !== '_' && prevGlyph === '_') {
                            // Letter over an underscore → underline
                            if (span.className.indexOf('underline') === -1) span.className += ' underline';
                        }
                    }
                } else {
                    span = document.createElement('span');
                    span.textContent = space ? '\u00A0' : c;
                    currentLineEl.appendChild(span);
                }
                overHang--;
            } else {
                // Create a span for the character
                span = document.createElement('span');
                span.textContent = space ? '\u00A0' : c;
                currentLineEl.appendChild(span);
            }

            // Animate print head: clamp to the right margin (last column)
            // so the carriage stops and cannot advance any further.
            var targetPos = (currentCharPos >= maxCols) ? (maxCols - 1) : currentCharPos;
            movePrintHeadQuick(targetPos);

            if (currentCharPos < maxCols) currentCharPos++;

            // Scroll paper if at end
            ensurePaperScroll();
        }

        /**
         * doBackspace() - Internal: move the print head back one position.
         * The next printed character overstrikes the character left there
         * (used by nroff/man for bold output, e.g. "N\bN").
         */
        function doBackspace() {
            if (currentCharPos > 0) {
                currentCharPos--;
                overHang++;
                movePrintHeadQuick(currentCharPos);
            }
        }

        /**
         * doCarriageReturn() - Internal: return the carriage to column 0 so
         * the characters that follow overstrike the current line. nroff/man
         * renders bold as "NAME\rNAME" and underline as "text + CR + spaces +
         * overstruck word", so CR is the overstrike operator on a real
         * terminal. overHang is set so the next characters replace the
         * existing glyphs instead of appending at the end of the line.
         */
        function doCarriageReturn() {
            if (currentCharPos > 0) {
                overHang += currentCharPos;
                currentCharPos = 0;
                movePrintHeadQuick(0);
            }
        }

        /**
         * processCharBuffer() - Called by the pacing timer to render buffered
         * items. Renders one or more characters / line feeds (see charsPerTick),
         * then schedules the next timer if more items remain in the buffer.
         * Always clears charPrintTimer first so that synchronous calls to
         * printChar/println during the same CPU slice set a NEW timer.
         */
        function processCharBuffer() {
            // Clear timer reference so the next arrival starts a fresh timer
            charPrintTimer = null;

            if (charBuffer.length === 0) {
                // Nothing pending — stop the continuous whirr.
                if (printWhirr) G60Audio.stopWhirr();
                return;
            }

            // Keep the looping line-printer whirr running while output is
            // pending. startWhirr() is retried each tick while the audio stays
            // paused, so a blocked autoplay attempt recovers once audio unlocks.
            if (printWhirr) G60Audio.startWhirr();

            // Render up to charsPerTick items in this tick. Fast line printers
            // (LP11, charsPerTick > 1) burst several characters per tick to go
            // beyond the browser's ~4 ms nested-timer floor; the ASR 33 console
            // (charsPerTick = 1) keeps its authentic per-character pacing.
            var count = 0;
            while (charBuffer.length > 0 && count < charsPerTick) {
                var item = charBuffer.shift();
                count++;

                if (item === CHAR_LF) {
                    // Line feed marker: execute the println logic
                    doPrintln();
                } else if (item === CHAR_BS) {
                    // Backspace marker: move the print head back for overstrike
                    doBackspace();
                } else if (item === CHAR_CR) {
                    // Carriage return marker: return to column 0 for overstrike
                    doCarriageReturn();
                } else if (item === CHAR_FF) {
                    // Form feed: eject the paper to the top of the next page
                    doFormFeed();
                } else if (item === CHAR_FF_MARK) {
                    // Draw the fold marker now that the page filler has scrolled
                    doFormFeedMarker();
                } else {
                    // Regular character: render it
                    doPrintChar(item);
                }
            }

            // If more items queued, schedule the next one
            if (charBuffer.length > 0) {
                charPrintTimer = setTimeout(processCharBuffer, charPrintDelay);
            } else if (printWhirr) {
                // Buffer drained — stop the whirr until the next output arrives.
                G60Audio.stopWhirr();
            }
        }

        /**
         * printChar(c) - Enqueue a character for paced printing at teletype speed.
         * Characters are buffered and rendered one per charPrintDelay interval
         * by the pacing timer.  The first character to arrive starts the timer.
         */
        function printChar(c) {
            charBuffer.push(c);
            if (!charPrintTimer) {
                charPrintTimer = setTimeout(processCharBuffer, charPrintDelay);
            }
        }

        /**
         * flushCharBuffer() - Immediately discard all buffered items.
         * Used on reset/stop to clear pending output.
         */
        function flushCharBuffer() {
            if (charPrintTimer) {
                clearTimeout(charPrintTimer);
                charPrintTimer = null;
            }
            charBuffer = [];
        }

        /**
         * doPrintln() - Internal: execute the line feed / new paragraph logic.
         * This is the same as the original println() body, extracted so it can
         * be scheduled as a buffered item in the pacing queue.
         */
        function doPrintln() {
            // Start a new paragraph (line)
            currentLineEl = document.createElement('p');
            printArea.appendChild(currentLineEl);
            var spaceEl = document.createElement('span');
            spaceEl.textContent = '\u00A0';
            currentLineEl.appendChild(spaceEl);
            currentCharPos = 0;
            overHang = 0;

            // Track lines printed on the current fanfold sheet (wraps at
            // pageLength) so a form feed fills only the remainder of the page.
            pagePos = (pagePos + 1) % pageLength;
            pageHasContent = true;

            // Play linefeed sound (disabled on the fast LP11 line printer).
            // Do not cut the continuous LP11 whirr at a line boundary.
            if (charSound) G60Audio.play('linefeed');
            if (!printWhirr) G60Audio.stopSound('print');

            // Animate paper feed
            if (reqAnimFrame) {
                reqAnimFrame(function() {
                    if (topSpacerVisible) {
                        // Gradually reduce spacer height instead of collapsing all at once.
                        // This keeps the total content height (~424px) constant so scrollTop
                        // stays valid and there is no visual jump.
                        spacerCurrentHeight = Math.max(spacerMinHeight, spacerCurrentHeight - lineHeight);
                        topSpacer.style.height = spacerCurrentHeight + 'px';
                        if (spacerCurrentHeight <= spacerMinHeight) {
                            topSpacerVisible = false;
                            paper.className = 'paperScroll';
                        }
                    } else {
                        scrollState += lineHeight;
                        paper.scrollTop = scrollState;
                    }
                });
            } else {
                if (topSpacerVisible) {
                    spacerCurrentHeight = Math.max(spacerMinHeight, spacerCurrentHeight - lineHeight);
                    topSpacer.style.height = spacerCurrentHeight + 'px';
                    if (spacerCurrentHeight <= spacerMinHeight) {
                        topSpacerVisible = false;
                        paper.className = 'paperScroll';
                    }
                } else {
                    scrollState += lineHeight;
                    paper.scrollTop = scrollState;
                }
            }

            // Move print head to idle position
            setHeadPos(headIdlePos, false);
        }

        /**
         * doFormFeed() - Internal: eject the paper to the top of the next page.
         * A real line printer (LP11 + fanfold paper) advances to top of form on
         * FF; 2.11BSD lpd sends FF between print jobs so each job starts on a
         * fresh page. On the continuous G60 paper this queues the REMAINDER of
         * the current sheet (pageLength - pagePos empty lines) first, then
         * CHAR_FF_MARK so the fold/perforation seam is drawn AFTER the filler
         * — exactly where the seam sits on real fanfold paper. Because the fill
         * is computed from the current line position, a nroff-formatted man
         * page (which already fills the page) closes with its footer right
         * before the seam, while short raw output leaves a blank bottom margin.
         * The ASR 33 console teletype also supported FF (its FORM key) but
         * used a smooth paper roll, so it advances without the fold marker.
         */
        function doFormFeed() {
            // The page eject must appear at the FF position in the logical
            // stream — i.e. BEFORE any content already queued after the FF
            // (such as the next job / man page body). The filler is therefore
            // unshifted to the FRONT of the remaining buffer: the blank lines
            // filling the rest of the sheet, then the fold-marker draw
            // sentinel so the seam lands after the filler. Nothing is ejected
            // when the page is already empty at a boundary (e.g. an lpd FF
            // before the banner of a fresh job). Items render at the normal
            // pacing rate (in charsPerTick bursts).
            if (pageHasContent) {
                var fill = (pageLength - pagePos) % pageLength;
                charBuffer.unshift(CHAR_FF_MARK);
                for (var i = 0; i < fill; i++) {
                    charBuffer.unshift(CHAR_LF);
                }

                // Brief paper-advance sound on the console teletype (the fast
                // LP11 keeps charSound disabled and plays its continuous whirr
                // instead).
                if (charSound) G60Audio.play('linefeed');
            }
        }

        /**
         * doFormFeedMarker() - Internal: draw the fold/perforation seam that
         * closes a fanfold page. Queued after the page filler by doFormFeed()
         * so the seam appears at the bottom of the sheet, as on real paper.
         * Skipped on paper types with no visible fold (smooth ASR 33 roll).
         * Resets the current line so the next job's first line starts on a
         * fresh line below the seam (top of the next sheet).
         */
        function doFormFeedMarker() {
            if (pageBreakMarker) {
                var marker = document.createElement('p');
                marker.className = 'pageBreak';
                var markerSpan = document.createElement('span');
                markerSpan.textContent = '\u00A0';
                marker.appendChild(markerSpan);
                printArea.appendChild(marker);
            }
            // Start the next page on a clean line below the seam.
            currentLineEl = null;
            currentCharPos = 0;
            overHang = 0;
            // The fresh sheet is empty until the next line is printed.
            pageHasContent = false;
        }

        /**
         * println() - Enqueue a line feed in the pacing queue.
         * The line feed runs after all preceding characters in the buffer
         * have been printed at teletype speed.
         */
        function println() {
            charBuffer.push(CHAR_LF);
            if (!charPrintTimer) {
                charPrintTimer = setTimeout(processCharBuffer, charPrintDelay);
            }
        }

        /**
         * Quick print head movement for character echo
         */
        function movePrintHeadQuick(pos) {
            // Keep the logical carriage position in sync: the character-echo
            // path (doPrintChar/doBackspace/doCarriageReturn) drives the head
            // visually, and applyPaperGeometry() repositions it from headPos
            // when the machine page is shown again. Without this the head
            // would jump back to the idle position on every page switch.
            headPos = pos;
            var l = headOffset + pos * charWidth + 'px';
            if (reqAnimFrame) {
                reqAnimFrame(function() { printHead.style.left = l; });
            } else {
                printHead.style.left = l;
            }
        }

        /**
         * Ensure paper is scrolled if content exceeds visible area
         */
        function ensurePaperScroll() {
            // Don't interfere while spacer is being gradually reduced —
            // scrollTop is managed by the spacer reduction logic.
            if (topSpacerVisible) return;
            if (printArea && printArea.scrollHeight > paper.clientHeight) {
                if (reqAnimFrame) {
                    reqAnimFrame(function() {
                        scrollState = printArea.scrollHeight;
                        paper.scrollTop = scrollState;
                    });
                } else {
                    scrollState = printArea.scrollHeight;
                    paper.scrollTop = scrollState;
                }
            }
        }

        // ================================================================
        // Original line-based printing (for boot output, program output)
        // ================================================================

        function print(t, _callback, _keepLocked) {
            if (t) {
                if (textBuffer && textBuffer.length > 0) {
                    textBuffer += '\n';
                }
                textBuffer += t;
            }
            callback = _callback;
            keepLocked = _keepLocked;
            if (lines.length === 0) {
                paper.className = 'paperNoScroll';
                scrollLock = true;
                scrollToEnd();
                initialTop = scrollState;
            }
            while (true) {
                lines.push(getLine());
                if (textPos === 0) break;
            }
            if (idle) printOut();
        }

        function getLine() {
            var el, space, r, c, empty, pe, pb, p0 = 0, pos = 0, p1 = 0,
                missPause = 8, missCnt = missPause;
            pe = document.createElement('p');
            empty = true;
            pb = [];
            // Cap line length at the right margin (maxCols). Authentic ASR 33
            // never wraps: the carriage stops at the last column, so a longer
            // line must not widen the paper / create a horizontal scrollbar.
            while (pos < maxCols) {
                c = textBuffer.charAt(textPos++);
                if (c === '\n' || c === '') break;
                space = (c === ' ');
                el = document.createElement('span');
                if (!space && pos > 2 && ++missCnt > missPause && Math.random() < 0.05) {
                    missCnt = 0;
                    el.className = (Math.random() < 0.3) ? 'shift' : 'drop';
                    if (c.charCodeAt(0) > 127) el.className += ' nonAscii';
                    if (missedCharOpacity) {
                        el.className += ((Math.random() < 0.1) ? ' op8' : ' op9') +
                            Math.floor(Math.random() * 5);
                    }
                    el.textContent = c;
                } else if (c.charCodeAt(0) > 127) {
                    el.className = 'nonAscii'; el.textContent = c;
                } else {
                    el.textContent = space ? '\u00A0' : c;
                }
                pe.appendChild(el);
                if (space) { if (empty) p0++; }
                else { empty = false; p1 = pos; }
                pb.push(space);
                if (textPos >= textBuffer.length) break;
                if (++pos === maxCols && textBuffer.charAt(textPos) === '\n') textPos++;
            }
            if (textPos >= textBuffer.length) { textPos = 0; textBuffer = ''; }
            if (empty) {
                pe = document.createElement('p');
                el = document.createElement('span'); el.textContent = '\u00A0'; pe.appendChild(el);
                p0 = p1 = 0; pb.length = 0;
            } else if (p0 > p1) { p1 = p0; }
            printArea.appendChild(pe);
            return { buffer: pb, first: p0, last: p1, empty: empty };
        }

        function printOut() {
            if (timer) clearTimeout(timer);
            idle = false;
            headDir = 1;
            if (headPos !== 0) { movePrintHead(0, delayBlank, false, printStart); }
            else { printStart(); }
        }

        function printStart() {
            curLine = lines.shift();
            if (curLine) { printLine(); }
        }

        function printLine() {
            if (!curLine.empty) {
                G60Audio.play('print');
                var dx1, dx2, p;
                if (bidirectional) {
                    dx1 = Math.abs(headPos - curLine.first);
                    dx2 = Math.abs(headPos - curLine.last);
                    if (dx1 <= dx2) { p = curLine.first; headDir = 1; }
                    else { p = curLine.last; headDir = -1; }
                } else { p = curLine.first; headDir = 1; }
                if (headPos !== p) { movePrintHead(p, delayBlank, false, printChars); }
                else { printChars(); }
            } else {
                G60Audio.stopSound('print'); G60Audio.play('linefeed');
                setTimeout(lineFeed, delayEmptyLine);
            }
        }

        function printChars() {
            var b = curLine.buffer;
            var isSpace = b[headPos];
            var t = (headDir < 0) ? curLine.first : curLine.last;
            if (t < headPos) headDir = -1;
            else if (t > headPos) headDir = 1;
            var p = headPos + headDir;
            while (p !== t && b[p] === isSpace) p += headDir;
            movePrintHead(p, isSpace ? delayBlank : delayChar, !isSpace,
                (p !== t) ? printChars : lineFeed);
        }

        function lineFeed() {
            lastLineFeed = performanceNow ? Math.round(performance.now()) : new Date().getTime();
            if (reqAnimFrame) { afId1 = reqAnimFrame(lineFeedStep); }
            else { lineFeedStep(); }
        }

        function lineFeedStep() {
            scrollState += feedDy;
            var t = performanceNow ? Math.round(performance.now()) : new Date().getTime();
            var d = delayFeed - (t - lastLineFeed);
            while (d < 4 && (scrollState - initialTop) % lineHeight !== 0) {
                scrollState += feedDy; d += delayFeed;
            }
            if (paper.scrollTop !== scrollState) paper.scrollTop = scrollState;
            lastLineFeed = t;
            paper.scrollTop = scrollState;
            if ((scrollState - initialTop) % lineHeight === 0) {
                curLine = lines.shift();
                if (curLine) { printLine(); }
                else { idle = true; movePrintHead(headIdlePos, delayBlank, false, endPrint); }
            } else {
                if (reqAnimFrame) { afId1 = reqAnimFrame(lineFeedStep); }
                else { timer = setTimeout(lineFeedStep, d); }
            }
        }

        function endPrint() {
            G60Audio.stopSound('print');
            if (!keepLocked && (!topSpacerVisible || scrollState >= paperHeight)) {
                if (topSpacerVisible) {
                    topSpacer.className = 'paperScroll'; topSpacerVisible = false;
                    scrollState -= paperTopSpacerOffset;
                }
                paper.className = 'paperScroll';
                paper.scrollTop = scrollState;
                scrollLock = false;
            }
            if (callback) { callback(); callback = null; }
        }

        function movePrintHead(p, delay, up, moveCallback, iterated) {
            if (headPos !== p) {
                var dx = (p - headPos > 0) ? 1 : -1;
                if (iterated) {
                    var t = performanceNow ? performance.now() : new Date().getTime();
                    var d = delay - (t - lastTime);
                    var slipCnt = 0;
                    while (delay < 4 && headPos !== p - dx && slipCnt < 5) { headPos += dx; d += delay; slipCnt++; }
                    if (delay < 4) delay = 4;
                    lastTime = t;
                } else { lastTime = performanceNow ? performance.now() : new Date().getTime(); }
                var x = headPos + dx;
                if (animateCharDetail && up) {
                    setHeadUp(true);
                    timer2 = setTimeout(function() { setHeadPos(x, false); }, delayCharUp);
                } else { setHeadPos(x, up); }
                timer = setTimeout(function() { movePrintHead(p, delay, up, moveCallback, true); }, delay);
            } else { if (moveCallback) moveCallback(); }
        }

        function setHeadPos(p, up) {
            if (reqAnimFrame) {
                var l = headOffset + p * charWidth + 'px';
                var t = (up !== headUp) ? ((up ? headUpY + Math.floor(Math.random() * headUpFuzzyness) : headBaseY) + 'px') : 0;
                afId2 = reqAnimFrame(function() { printHead.style.left = l; if (t) printHead.style.top = t; });
                if (up !== headUp) headUp = up;
            } else {
                printHead.style.left = headOffset + p * charWidth + 'px';
                if (up !== headUp) {
                    printHead.style.top = (up ? headUpY + Math.floor(Math.random() * headUpFuzzyness) : headBaseY) + 'px';
                    headUp = up;
                }
            }
            headPos = p;
        }

        function setHeadUp(up) {
            if (Boolean(up) !== headUp) {
                var t = (up ? headUpY + Math.floor(Math.random() * headUpFuzzyness) : headBaseY) + 'px';
                if (reqAnimFrame) { afId3 = reqAnimFrame(function() { printHead.style.top = t; }); }
                else { printHead.style.top = t; }
                headUp = up;
            }
        }

        function resetPrinter(unloading) {
            // Cancel pending character pacing
            if (charPrintTimer) {
                clearTimeout(charPrintTimer);
                charPrintTimer = null;
            }
            charBuffer = [];
            // Stop the continuous whirr.
            if (printWhirr) G60Audio.stopWhirr();

            if (topSpacer) {
                topSpacer.className = '';
                // Set initial spacer height via JS for gradual reduction
                spacerCurrentHeight = spacerFullHeight;
                topSpacer.style.height = spacerCurrentHeight + 'px';
            }
            if (printArea) printArea.innerHTML = '';
            if (timer) clearTimeout(timer);
            if (timer2) clearTimeout(timer2);
            if (afId1 && cancelReqAnimFrame) cancelReqAnimFrame(afId1);
            if (afId2 && cancelReqAnimFrame) cancelReqAnimFrame(afId2);
            if (afId3 && cancelReqAnimFrame) cancelReqAnimFrame(afId3);
            timer = timer2 = afId1 = afId2 = afId3 = null;
            lines = []; initialTop = textPos = headPos = 0;
            textBuffer = ''; callback = curLine = null;
            idle = scrollLock = topSpacerVisible = true;
            keepLocked = false; headUp = headDir = undefined;
            // Reset current line tracking and form-feed page position.
            currentLineEl = null; currentCharPos = 0; overHang = 0;
            pagePos = 0; pageHasContent = false;
            if (!unloading) {
                setHeadPos(headIdlePos, false);
                // Re-create initial empty line
                currentLineEl = document.createElement('p');
                printArea.appendChild(currentLineEl);
                var spaceEl = document.createElement('span');
                spaceEl.textContent = '\u00A0';
                currentLineEl.appendChild(spaceEl);
                currentCharPos = 0;
            }
            // Calculate scrollState AFTER all content (spacer, initial empty line)
            // has been added to the DOM, so paper.scrollHeight is accurate.
            if (paper) {
                scrollState = Math.max(0, paper.scrollHeight - paper.clientHeight);
                paper.scrollTop = scrollState;
                // Keep overflow:hidden so scrollTop takes effect;
                // the first line will appear at the bottom of the paper area.
                paper.className = 'paperNoScroll';
            }
        }

        function stopPrinter() {
            // Cancel pending character pacing
            if (charPrintTimer) {
                clearTimeout(charPrintTimer);
                charPrintTimer = null;
            }
            charBuffer = [];
            // Stop the continuous whirr.
            if (printWhirr) G60Audio.stopWhirr();

            if (timer) clearTimeout(timer);
            if (timer2) clearTimeout(timer2);
            if (afId1 && cancelReqAnimFrame) cancelReqAnimFrame(afId1);
            if (afId2 && cancelReqAnimFrame) cancelReqAnimFrame(afId2);
            if (afId3 && cancelReqAnimFrame) cancelReqAnimFrame(afId3);
            timer = timer2 = afId1 = afId2 = afId3 = null;
            callback = null; setHeadUp(false);
        }

        function scrollToEnd() {
            if (reqAnimFrame) { var s = scrollState; reqAnimFrame(function() { paper.scrollTop = s; }); }
            else { paper.scrollTop = scrollState; }
        }

        function destroyPrinter() {
            resetPrinter(true);
            if (element && element.parentNode) element.parentNode.removeChild(element);
            element = printHead = paper = printArea = lines = topSpacer = topOverlay = paperTopShadow = null;
        }

        // Initialization
        setupPrinter();

        // ================================================================
        // Public API
        // ================================================================

        // Line-based printing (animated, for boot/program output)
        this.print = function(text, callback, keepLocked) {
            // If we have a current line with content, finalize it first
            if (currentLineEl && currentCharPos > 0) {
                println();
            }
            print(text, callback, keepLocked);
        };

        // Character-by-character printing (for real-time echo)
        this.printChar = function(c) {
            printChar(c);
        };

        // Backspace: move the print head back one position (overstrike)
        this.backspace = function() {
            charBuffer.push(CHAR_BS);
            if (!charPrintTimer) {
                charPrintTimer = setTimeout(processCharBuffer, charPrintDelay);
            }
        };

        // Newline (carriage return + line feed)
        this.println = function() {
            println();
        };

        // Form feed: eject the paper to the top of the next page. Sent by
        // 2.11BSD lpd between print jobs; rendered as a fold-marker line plus
        // pageLength empty lines so each job starts on a fresh page.
        this.formFeed = function() {
            charBuffer.push(CHAR_FF);
            if (!charPrintTimer) {
                charPrintTimer = setTimeout(processCharBuffer, charPrintDelay);
            }
        };

        // Carriage return: return the carriage to column 0 so the next
        // characters overstrike the current line. nroff/man uses CR (not
        // backspace) for bold/underline overstrike.
        this.carriageReturn = function() {
            charBuffer.push(CHAR_CR);
            if (!charPrintTimer) {
                charPrintTimer = setTimeout(processCharBuffer, charPrintDelay);
            }
        };

        this.reset = function() { resetPrinter(); };
        this.stop = function() { stopPrinter(); };
        this.destroy = function() { destroyPrinter(); };
        this.clear = function() { resetPrinter(); };

        // Change the printable column count (72/80/100) and re-render the
        // paper. Invalid values are ignored.
        this.setMaxCols = function(n) {
            if (PRINT_WIDTHS.indexOf(Number(n)) !== -1) {
                maxCols = Number(n);
                applyPaperGeometry();
                resetPrinter();
            }
        };

        // Advance the carriage to the next tab stop (every 8 columns) by
        // queueing spaces, matching real ASR 33 / LP11 tab behaviour. Used by
        // the console adapter on TAB (code 9).
        this.printTab = function() {
            var spaces = 8 - (currentCharPos % 8);
            for (var i = 0; i < spaces; i++) {
                printChar(' ');
            }
        };
    };

    // ================================================================
    // Console Adapter
    // ================================================================

    /**
     * Creates a console adapter.
     *
     * - Printable characters are sent to printer.printChar() for
     *   immediate display (real-time echo)
     * - CR (13) / LF (10) trigger printer.println() (new line)
     * - Tab and backspace are handled
     * - Full text blocks (multi-line) are sent to printer.print()
     *   for animated printing
     *
     * @param {G60Printer} printer
     * @returns {object} with writeChar, writeString, flush methods
     */
    window.createG60Console = function(printer) {
        /**
         * Simple console adapter:
         * - Printable characters → printer.printChar() (immediate, on current line)
         * - LF (10) → printer.println() (new line)
         * - CR (13) → ignored (handled by LF)
         * - No accumulation/duplication: characters print once only
         */

        function writeChar(code) {
            if (code === 10) {
                // LF: line feed - advance to next line
                printer.println();
            } else if (code === 13) {
                // CR: carriage return - return to column 0 so the following
                // characters overstrike the current line. nroff/man renders
                // bold/underline via "text\rtext" overstrike, not backspace.
                if (typeof printer.carriageReturn === 'function') {
                    printer.carriageReturn();
                }
            } else if (code === 8) {
                // Backspace (^H): move the print head back so the next character
                // overstrikes it. nroff/man uses "^H" to render bold text
                // (e.g. "N\bN" prints as "N" instead of "NN").
                printer.backspace();
            } else if (code === 0x7F) {
                // DEL (rubout) - ignored
            } else if (code >= 32 && code < 127) {
                // Printable ASCII: display immediately
                printer.printChar(String.fromCharCode(code));
            } else if (code === 12) {
                // Form feed (^L): eject the paper to the top of the next page.
                // 2.11BSD lpd sends FF between jobs so each starts on a fresh
                // page. The ASR 33 teletype also supported FF (its FORM key).
                if (typeof printer.formFeed === 'function') {
                    printer.formFeed();
                }
            } else if (code === 9) {
                // Tab - advance the carriage to the next tab stop (every
                // 8 columns), matching real ASR 33 / LP11 behaviour.
                if (typeof printer.printTab === 'function') {
                    printer.printTab();
                } else {
                    printer.printChar(' ');
                }
            }
            // Other control codes are ignored
        }

        function writeString(text) {
            for (var i = 0; i < text.length; i++) {
                writeChar(text.charCodeAt(i));
            }
        }

        function flush() {
            // No buffering needed
        }

        return {
            writeChar: writeChar,
            writeString: writeString,
            flush: flush
        };
    };

})();
