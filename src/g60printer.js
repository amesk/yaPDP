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

        stopSound: function(name) {
            try {
                var s = this._sounds[name];
                if (s) { s.pause(); s.currentTime = 0; }
            } catch(e) {}
        }
    };

    // Pre-load sounds
    G60Audio.load('punch', '../assets/sounds/keypunch2.mp3');      // short punch for single char
    G60Audio.load('print', '../assets/sounds/teletype33-print.mp3'); // long for line animation
    G60Audio.load('linefeed', '../assets/sounds/teletype33-lf.mp3'); // line feed

    // ====================================================================
    // Google60-style Line Printer
    // ====================================================================

    /**
     * G60Printer constructor
     * @param {string} containerId - DOM element ID to attach the printer to
     */
    window.G60Printer = function(containerId) {
        var container = document.getElementById(containerId);
        if (!container) throw new Error('Container ' + containerId + ' not found');

        // Printer state
        var textPos, textBuffer, timer, timer2, lines,
            element, printArea, paper, topSpacer, printHead,
            scrollState, scrollLock, initialTop, idle, headPos,
            headDir, curLine, headUp, callback, keepLocked,
            delayFeed, feedDy, topSpacerVisible, lastTime,
            lastLineFeed, afId1, afId2, afId3,
            spacerCurrentHeight;

        // Character pacing state (authentic teletype speed)
        var charPrintDelay = 30;    // ms per character (~33 cps, compromise between
                                    //   authentic ASR 33 feel and practical usability)
        var charBuffer = [];        // pending characters to print
        var charPrintTimer = null;  // timer ID for paced printing
        var CHAR_LF = '\n';         // sentinel marker in buffer to trigger a line feed
        var CHAR_BS = '\b';         // sentinel marker in buffer to trigger a backspace

        // Printer configuration
        var delayBlank = 7;
        var delayChar = 12;
        var delayCharUp = 6;
        var delayEmptyLine = 50;
        var headIdlePos = -3;
        var headOffset = 30;
        var lineHeight = 16;
        var charWidth = 7;
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
            var tbl, tb, tr, td1, td2, td3, el;
            element = document.createElement('div');
            element.id = 'printer';
            el = document.createElement('div'); el.id = 'printer_left'; element.appendChild(el);
            el = document.createElement('div'); el.id = 'printer_right'; element.appendChild(el);
            el = document.createElement('div'); el.id = 'printer_topoverlay'; element.appendChild(el);
            paper = document.createElement('div'); paper.id = 'paper'; paper.className = 'paperNoScroll';
            topSpacer = document.createElement('div'); topSpacer.id = 'paper_topspacer'; paper.appendChild(topSpacer);
            tbl = document.createElement('table'); tbl.id = 'paper_area'; tb = document.createElement('tbody');
            tr = document.createElement('tr');
            td1 = document.createElement('td'); td1.id = 'paper_top'; td1.setAttribute('colspan', 3); tr.appendChild(td1); tb.appendChild(tr);
            tr = document.createElement('tr');
            td1 = document.createElement('td'); td1.id = 'papermargin_left';
            td2 = document.createElement('td'); td2.id = 'paper_printarea';
            td3 = document.createElement('td'); td3.id = 'papermargin_right';
            tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tb.appendChild(tr);
            tr = document.createElement('tr'); tr.id = 'paper_bottom';
            td1 = document.createElement('td'); td1.setAttribute('colspan', 3); tr.appendChild(td1); tb.appendChild(tr);
            tbl.appendChild(tb); paper.appendChild(tbl); element.appendChild(paper);
            el = document.createElement('div'); el.id = 'paper_topshadow'; element.appendChild(el);
            el = document.createElement('div'); el.id = 'printer_frontpannel'; element.appendChild(el);
            el = document.createElement('div'); el.id = 'printheadarea'; element.appendChild(el);
            printHead = document.createElement('img');
            printHead.id = 'printhead'; printHead.src = '../assets/images/printhead.png'; el.appendChild(printHead);
            printArea = td2;
            container.appendChild(element);
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
                currentCharPos = 0;
            }

            // Play short punch sound (cloned Audio element per play)
            G60Audio.playCloned('punch');

            var space = (c === ' ');
            var span;

            if (overHang > 0) {
                // Overstrike: print over the character left by a previous
                // backspace. nroff/man renders bold as "X\bX"; the second
                // 'X' must replace the first. The leading NBSP span occupies
                // position 0, so the target character is at currentCharPos + 1.
                var index = currentCharPos + 1;
                span = currentLineEl.children[index];
                if (span) {
                    span.textContent = space ? '\u00A0' : c;
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

            // Animate print head
            var targetPos = currentCharPos;
            movePrintHeadQuick(targetPos);

            currentCharPos++;

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
         * processCharBuffer() - Called by the pacing timer to render one item.
         * Renders a single character or performs a line feed, then schedules
         * the next timer if more items remain in the buffer.
         * Always clears charPrintTimer first so that synchronous calls to
         * printChar/println during the same CPU slice set a NEW timer.
         */
        function processCharBuffer() {
            // Clear timer reference so the next arrival starts a fresh timer
            charPrintTimer = null;

            if (charBuffer.length === 0) return;

            var item = charBuffer.shift();

            if (item === CHAR_LF) {
                // Line feed marker: execute the println logic
                doPrintln();
            } else if (item === CHAR_BS) {
                // Backspace marker: move the print head back for overstrike
                doBackspace();
            } else {
                // Regular character: render it
                doPrintChar(item);
            }

            // If more items queued, schedule the next one
            if (charBuffer.length > 0) {
                charPrintTimer = setTimeout(processCharBuffer, charPrintDelay);
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

            // Play linefeed sound
            G60Audio.play('linefeed');
            G60Audio.stopSound('print');

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
            while (pos < 100) {
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
                if (++pos === 100 && textBuffer.charAt(textPos) === '\n') textPos++;
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
            // Reset current line tracking
            currentLineEl = null; currentCharPos = 0; overHang = 0;
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
            element = printHead = paper = printArea = lines = topSpacer = null;
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

        this.reset = function() { resetPrinter(); };
        this.stop = function() { stopPrinter(); };
        this.destroy = function() { destroyPrinter(); };
        this.clear = function() { resetPrinter(); };
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
                // CR: carriage return - ignored on line printer
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
            } else if (code === 9) {
                // Tab - print as space
                printer.printChar(' ');
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
