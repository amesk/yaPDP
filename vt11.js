// PDP‑11/70 Emulator – VT11 subsystem v5.0
// Original author: Paul Nankervis
// Co‑author (v5.0 rewrite): Copilot
//
// v5.0 changelog:
//  - Modularised VT11 into clear internal components (state, timing, renderer, light pen, exec, CPU)
//  - Added VT11 statistics panel with live mode/DSR/position/activity display
//  - Implemented green-phosphor CRT aesthetic with configurable decay
//  - Improved light pen handling with distance-based hit testing and larger tolerance
//  - Refined cursor/light-pen behaviour and interrupt signalling for usability
//
// This code may be used freely provided the original author name is acknowledged
// in any modified source code.
//
// -----------------------------------------------------------------------------
// VT11 Graphic Display Processor emulator (modular + statistics + phosphor)
// -----------------------------------------------------------------------------

iopage.register(0o17772000, 4, (function () {
    "use strict";

    // -------------------------------------------------------------------------
    // Constants and configuration
    // -------------------------------------------------------------------------

    const WIDTH = 1024;
    const HEIGHT = 768;

    // Timing model (soft, not cycle-accurate)
    const PROCESSOR_TIMESLICE_MS = 4;
    const PROCESSOR_RESCHEDULE_MS = 15;
    const REFRESH_HOLD_MS = 800;
    const BLINK_INTERVAL_MS = 500;

    // Phosphor decay configuration (foreground canvas)
    const VT11_PHOSPHOR_DECAY = true;
    const VT11_PHOSPHOR_FADE_ALPHA = 0.55; // fraction of black applied per frame

    // Statistics panel configuration
    const VT11_STATS_ENABLED_DEFAULT = true;
    const VT11_STATS_PANEL_WIDTH_PX = 390;

    // Interrupt flag bits for iMask
    const IMASK_PEN = 1; // bit 0: pen hit
    const IMASK_STOP = 2; // bit 1: stop

    // VT11 mode names for clarity (DSR bits 14:11)
    const VT11_MODES = {
        0: "CHAR",
        1: "SHORT_VECTOR",
        2: "LONG_VECTOR",
        3: "POINT",
        4: "GRAPH_X",
        5: "GRAPH_Y",
        6: "REL_POINT",
        7: "RESERVED",
        8: "RESERVED",
        9: "RESERVED",
        10: "RESERVED",
        11: "RESERVED",
        12: "JUMP",
        13: "RESERVED",
        14: "SRA",
        15: "SRB"
    };

    // -------------------------------------------------------------------------
    // State module
    // -------------------------------------------------------------------------

    const state = (function () {
        let DPC = 0;             // Display Program Counter
        let DSR = 0x8000;        // Display Status Register (start stopped)

        let Xpen = 0;            // light pen X position
        let Ypen = 0;            // light pen Y position

        let stopInterrupt = 0;   // enable interrupt on stop
        let penInterrupt = 0;    // enable interrupt on light pen hit
        let lineRefresh = 0;     // line refresh mode (not deeply modelled)

        let XRegister = 0;       // current X position
        let YRegister = 0;       // current Y position
        let graphIncrement = 0;  // graphplot increment

        let iMask = 0;           // interrupt mask flags (pen + stop pending)

        function reset() {
            DPC = 0;
            DSR = 0x8000;
            Xpen = 0;
            Ypen = 0;
            stopInterrupt = 0;
            penInterrupt = 0;
            lineRefresh = 0;
            XRegister = 0;
            YRegister = 0;
            graphIncrement = 0;
            iMask = 0;
        }

        return {
            reset,

            getDPC: () => DPC,
            setDPC: value => { DPC = value & 0xffff; },

            getDSR: () => DSR,
            setDSR: value => { DSR = value & 0xffff; },

            getXRegister: () => XRegister,
            setXRegister: value => { XRegister = value & 0x3ff; },

            getYRegister: () => YRegister,
            setYRegister: value => { YRegister = value & 0x3ff; },

            getGraphIncrement: () => graphIncrement,
            setGraphIncrement: value => { graphIncrement = value & 0x3f; },

            getXpen: () => Xpen,
            setXpen: value => { Xpen = value & 0x3ff; },

            getYpen: () => Ypen,
            setYpen: value => { Ypen = value & 0x3ff; },

            getStopInterrupt: () => stopInterrupt,
            setStopInterrupt: value => { stopInterrupt = value ? 1 : 0; },

            getPenInterrupt: () => penInterrupt,
            setPenInterrupt: value => { penInterrupt = value ? 1 : 0; },

            getLineRefresh: () => lineRefresh,
            setLineRefresh: value => { lineRefresh = value & 1; },

            getIMask: () => iMask,
            setIMask: value => { iMask = value & 0x3; },

            setIMaskBits: bits => { iMask |= (bits & 0x3); },
            clearIMaskBits: bits => { iMask &= ~(bits & 0x3); },

            // Field helpers for DSR
            getMode: () => ((DSR >>> 11) & 0xf),
            setModeBits: modeBits => {
                // modeBits should already be in bits 14:11 format
                DSR = (DSR & 0x87ff) | (modeBits & 0x7800);
            },

            setIntensityFromInstruction: inst => {
                // If bit 10 set, load bits 9:7 into DSR 10:8
                if (inst & 0x400) {
                    DSR = (DSR & 0xf8ff) | ((inst << 1) & 0x700);
                }
            },

            setPenFlagFromInstruction: inst => {
                // Pen interrupt enable flag uses bits 6:5 in control word
                if (inst & 0x40) {
                    penInterrupt = (inst & 0x20) ? 1 : 0;
                }
            },

            setBlinkFromInstruction: inst => {
                // DSR bit 3 blink from instruction bit 3 (when bit 4 set)
                if (inst & 0x10) {
                    DSR = (DSR & 0xfff7) | (inst & 0x8);
                }
            },

            setLineStyleFromInstruction: inst => {
                // DSR bits 1:0 = line style from inst bits 1:0 (when bit 2 set)
                if (inst & 4) {
                    DSR = (DSR & 0xfffc) | (inst & 0x3);
                }
            },

            setStopBit: () => { DSR |= 0x8000; },
            clearStopBit: () => { DSR &= 0x7fff; },

            isStopped: () => !!(DSR & 0x8000),

            setLightPenEnableFromInstruction: inst => {
                // inst bit 7: set; inst bit 6: value -> DSR bit 7
                if (inst & 0x80) {
                    DSR = (DSR & 0xff7f) | ((inst << 1) & 0x80);
                }
            },

            isLightPenEnabled: () => !(DSR & 0x80),

            setItalicsFromInstruction: inst => {
                if (inst & 0x20) {
                    DSR = (DSR & 0xffef) | (inst & 0x10);
                }
            },

            setLineRefreshFromInstruction: inst => {
                if (inst & 0x4) {
                    lineRefresh = inst & 0x4;
                }
            }
        };
    })();

    // -------------------------------------------------------------------------
    // Timing and blink module
    // -------------------------------------------------------------------------

    const timing = (function () {
        let blinkFlag = 0;
        let refreshTime = 0;
        let refreshCount = 0;
        let initializedBlink = false;

        function startBlinkTimer() {
            if (initializedBlink) return;
            initializedBlink = true;
            setInterval(() => {
                blinkFlag = 1 - blinkFlag;
            }, BLINK_INTERVAL_MS);
        }

        function getBlinkFlag() {
            return blinkFlag;
        }

        function shouldUpdateFrame(dataCount) {
            const now = Date.now();
            if (dataCount >= refreshCount || now > refreshTime) {
                refreshCount = dataCount;
                refreshTime = now + REFRESH_HOLD_MS;
                return true;
            }
            return false;
        }

        function getTimesliceDeadline() {
            return Date.now() + PROCESSOR_TIMESLICE_MS;
        }

        return {
            startBlinkTimer,
            getBlinkFlag,
            shouldUpdateFrame,
            getTimesliceDeadline
        };
    })();

    // -------------------------------------------------------------------------
    // VT11 statistics panel module
    // -------------------------------------------------------------------------

    const statsPanel = (function () {
        let panel = null;
        let visible = VT11_STATS_ENABLED_DEFAULT;
        let inited = false;

        function padLeft(val, len) {
            let s = String(val);
            while (s.length < len) s = " " + s;
            return s;
        }

        function padRight(val, len) {
            let s = String(val);
            while (s.length < len) s = s + " ";
            return s;
        }

        function init(container) {
            if (inited) return;
            inited = true;

            let toggle = document.getElementById('vt11_stats_toggle');
            if (toggle) {
                visible = !!toggle.checked;
                toggle.addEventListener('change', function () {
                    visible = !!toggle.checked;
                    if (panel) {
                        panel.style.display = visible ? 'block' : 'none';
                    }
                }, false);
            }

            panel = document.createElement('div');
            panel.style.fontFamily = 'monospace';
            panel.style.fontSize = '11px';
            panel.style.whiteSpace = 'pre';
            panel.style.color = '#80FF80';      // match vector phosphor tint
            panel.style.background = '#001000'; // deep green-black
            panel.style.border = '1px solid #406040';
            panel.style.padding = '4px 6px';
            panel.style.marginBottom = '4px';
            panel.style.width = VT11_STATS_PANEL_WIDTH_PX + 'px';
            panel.style.boxSizing = 'border-box';
            panel.style.display = visible ? 'block' : 'none';

            panel.textContent = 'VT11 Statistics\ninitializing...';

            (container || document.body).appendChild(panel);
        }

        function update(stats) {
            if (!panel || !visible) return;

            let mode = (stats.dsr >>> 11) & 0xf;
            let intensity = (stats.dsr >>> 8) & 0x7;
            let blink = (stats.dsr >>> 3) & 0x1;
            let penDisabled = (stats.dsr >>> 7) & 0x1;
            let lineStyle = stats.dsr & 0x3;

            let lineName = ['Solid', 'Long', 'Short', 'Dot'][lineStyle] || '?';
            let modeName = VT11_MODES[mode] || '?';

            let text = '';
            text += 'VT11 Statistics\n';
            text += '----------------\n';
            text += 'DPC: ' +
                stats.dpc.toString(8).padStart(6, '0') +
                ' (0x' + stats.dpc.toString(16).padStart(4, '0') + ')\n';
            text += 'Mode: ' + padRight(modeName, 12) +
                ' Int=' + padLeft(intensity, 2) +
                ' Blink=' + blink +
                ' Pen=' + (penDisabled ? 'OFF' : ' ON') +
                ' Line=' + padRight(lineName, 6) + '\n';
            text += 'X,Y: ' + padLeft(stats.x, 4) + ',' + padLeft(stats.y, 4) + '\n';
            text += 'Pen: mouse(' + padLeft(stats.penMouseX, 4) + ',' + padLeft(stats.penMouseY, 4) +
                ') hit(' + padLeft(stats.penHitX, 4) + ',' + padLeft(stats.penHitY, 4) +
                ') pend=' + (stats.penPending ? '1' : '0') + '\n';
            text += 'Instr/frame: ' + padLeft(stats.instrCount, 5) +
                '  Vectors: ' + padLeft(stats.vectorCount, 4) +
                '  Points: ' + padLeft(stats.pointCount, 4) +
                '  Chars: ' + padLeft(stats.charCount, 4) + '\n';
            text += 'Slice: ' + stats.sliceMs.toFixed(1).padStart(5, ' ') + ' ms' +
                '  Loops: ' + padLeft(stats.loops, 4) + '\n';

            panel.textContent = text;
        }

        return {
            init,
            update
        };
    })();

    // -------------------------------------------------------------------------
    // Renderer module (with phosphor decay)
    // -------------------------------------------------------------------------

    const renderer = (function () {
        let canvasBG = null;
        let canvasFG = null;
        let ctxBG = null;
        let ctxFG = null;
        let initialized = false;

        function initDOM() {
            if (initialized) return;

            canvasBG = document.createElement('canvas');
            canvasBG.width = WIDTH;
            canvasBG.height = HEIGHT;
            ctxBG = canvasBG.getContext('2d');

            // Set phosphor colour for lines & text
            ctxBG.strokeStyle = "#80FF80";   // bright green vectors
            ctxBG.fillStyle = "#55BB55";     // slightly softer text
            ctxBG.font = "12px monospace";

            canvasFG = document.createElement('canvas');
            canvasFG.width = WIDTH;
            canvasFG.height = HEIGHT;
            canvasFG.style.border = "1px solid #406040";
            canvasFG.style.cursor = "none";
            canvasFG.style.backgroundColor = "#001000"; // deep green-black CRT look

            let container = document.getElementById('vt11') || document.body;

            // Create VT11 statistics toggle dynamically
            let statsToggleLabel = document.createElement('label');
            statsToggleLabel.style.display = 'block';
            statsToggleLabel.style.marginBottom = '4px';

            let statsToggle = document.createElement('input');
            statsToggle.type = 'checkbox';
            statsToggle.id = 'vt11_stats_toggle';
            statsToggle.checked = true;   // or false if you want it hidden by default

            statsToggleLabel.appendChild(statsToggle);
            statsToggleLabel.appendChild(document.createTextNode(' VT11 statistics'));

            container.appendChild(statsToggleLabel);


            statsPanel.init(container);      // stats above canvas
            container.appendChild(canvasFG);

            ctxFG = canvasFG.getContext("2d");

            initialized = true;
        }

        function getCanvasFG() {
            return canvasFG;
        }

        function setCursorStyle(style) {
            if (canvasFG) {
                canvasFG.style.cursor = style;
            }
        }

        function beginFramePath() {
            if (!ctxBG) return;
            ctxBG.beginPath();
        }

        function clearBackground() {
            if (!ctxBG) return;
            ctxBG.clearRect(0, 0, WIDTH, HEIGHT);
        }

        function commitFrame() {
            if (!ctxFG || !ctxBG) return;

            // Phosphor decay: fade existing foreground slightly towards black
            if (VT11_PHOSPHOR_DECAY) {
                ctxFG.save();
                ctxFG.globalAlpha = VT11_PHOSPHOR_FADE_ALPHA;
                ctxFG.fillStyle = "black";
                ctxFG.fillRect(0, 0, WIDTH, HEIGHT);
                ctxFG.restore();
            } else {
                ctxFG.clearRect(0, 0, WIDTH, HEIGHT);
            }

            // Draw new vectors from background onto foreground
            ctxFG.drawImage(canvasBG, 0, 0);

            // Clear background for next frame’s drawing
            clearBackground();
        }

        function updateStrokeStyleFromDSR(DSR) {
            if (!ctxBG) return;
            // Intensity bits 10:8 -> adjust green channel
            let level = ((DSR >>> 7) & 0xe).toString(16) + "0";
            ctxBG.strokeStyle = "#00" + level + "00"; // green phosphor
        }

        function applyLineStyle(DSR) {
            if (!ctxBG) return;
            switch (DSR & 0x3) {
                case 0: // solid
                    ctxBG.setLineDash([]);
                    break;
                case 1: // long dash
                    ctxBG.setLineDash([8, 8]);
                    break;
                case 2: // short dash
                    ctxBG.setLineDash([4, 4]);
                    break;
                case 3: // dot dash
                    ctxBG.setLineDash([2, 2]);
                    break;
            }
        }

        function drawVector(x0, y0, x1, y1) {
            if (!ctxBG) return;
            ctxBG.moveTo(x0, HEIGHT - 1 - y0);
            ctxBG.lineTo(x1, HEIGHT - 1 - y1);
            ctxBG.stroke();
        }

        function drawPoint(x, y) {
            if (!ctxBG) return;
            ctxBG.fillRect(x, HEIGHT - 1 - y, 1, 1);
        }

        function drawChar(x, y, code) {
            if (!ctxBG) return;
            ctxBG.fillText(String.fromCharCode(code), x, HEIGHT - 1 - y);
        }

        return {
            initDOM,
            getCanvasFG,
            setCursorStyle,
            beginFramePath,
            commitFrame,
            updateStrokeStyleFromDSR,
            applyLineStyle,
            drawVector,
            drawPoint,
            drawChar
        };
    })();

    // -------------------------------------------------------------------------
    // Light pen module (distance-based hit testing)
    // -------------------------------------------------------------------------

    const lightPen = (function () {
        const MARGIN = 12; // pixels, more forgiving for usability

        let mouseX = 0;
        let mouseY = 0;
        let initializedMouse = false;

        function attachMouseTracking(canvasFG) {
            if (!canvasFG || initializedMouse) return;
            initializedMouse = true;

            canvasFG.addEventListener('mousemove', function vt11TrackMouse(evt) {
                let rect = canvasFG.getBoundingClientRect();
                mouseX = evt.clientX - rect.left;
                mouseY = evt.clientY - rect.top;
            }, false);
        }

        function getPenCoords() {
            return {
                x: mouseX,
                y: mouseY
            };
        }

        function distanceCheck(x0, y0, x1, y1, xMouse, yMouse) {
            // Convert VT coordinates to same Y-space as xMouse/yMouse already are
            // Caller passes yMouse as HEIGHT - 1 - rawMouseY, so x0,y0/x1,y1 are in VT coords.
            // Here we assume they are already comparable (VT 0..HEIGHT-1, origin at bottom).
            let dx = x1 - x0;
            let dy = y1 - y0;
            let len2 = dx * dx + dy * dy;

            // Handle degenerate segment as a point
            let Xpen, Ypen;
            if (len2 === 0) {
                Xpen = x0;
                Ypen = y0;
            } else {
                // Project mouse onto the line segment, clamped to [0,1]
                let t = ((xMouse - x0) * dx + (yMouse - y0) * dy) / len2;
                if (t < 0) t = 0;
                else if (t > 1) t = 1;
                Xpen = x0 + t * dx;
                Ypen = y0 + t * dy;
            }

            let ddx = xMouse - Xpen;
            let ddy = yMouse - Ypen;
            let dist2 = ddx * ddx + ddy * ddy;
            if (dist2 > MARGIN * MARGIN) {
                return false;
            }

            state.setXpen(~~Xpen);
            state.setYpen(~~Ypen);
            return true;
        }

        return {
            attachMouseTracking,
            getPenCoords,
            distanceCheck
        };
    })();

    // -------------------------------------------------------------------------
    // Memory access helper module
    // -------------------------------------------------------------------------

    const mem = (function () {
        function readAndAdvance() {
            let DPC = state.getDPC();
            let word = -1;

            if ((DPC & 1) || (word = readWordByPhysical(DPC)) < 0) {
                // Invalid address or read error -> stop and possibly interrupt
                if (state.getStopInterrupt()) {
                    state.setIMaskBits(IMASK_STOP);
                    requestInterrupt();
                }
                state.setStopBit();
            } else {
                state.setDPC((DPC + 2) & 0xffff);
            }
            return word;
        }

        return {
            readAndAdvance
        };
    })();


    // -------------------------------------------------------------------------
    // Instruction decode + execution module
    // -------------------------------------------------------------------------

    const exec = (function () {
        function handleControl(instruction) {
            let mode = (instruction >>> 11) & 0xf;

            if (mode < 8) {
                // Mode/attribute change
                state.setModeBits(instruction & 0x7800);
                state.setIntensityFromInstruction(instruction);
                state.setPenFlagFromInstruction(instruction);
                state.setBlinkFromInstruction(instruction);
                state.setLineStyleFromInstruction(instruction);
                return;
            }

            switch (mode) {
                case 0xc:  // JUMP
                    controlJump();
                    break;

                case 0xe:  // SRA
                    controlSRA(instruction);
                    break;

                case 0xf:  // SRB
                    controlSRB(instruction);
                    break;

                default:
                    // Reserved / unimplemented
                    break;
            }
        }

        function controlJump() {
            let newPC = mem.readAndAdvance();
            if (newPC >= 0) {
                state.setDPC(newPC);
            }
        }

        function controlSRA(instruction) {
            // Stop interrupt enable
            if (instruction & 0x200) {
                state.setStopInterrupt(instruction & 0x100);
            }

            // Light pen enable / disable
            let oldLightPenEnabled = state.isLightPenEnabled();
            state.setLightPenEnableFromInstruction(instruction);
            let newLightPenEnabled = state.isLightPenEnabled();

            if (oldLightPenEnabled !== newLightPenEnabled) {
                renderer.setCursorStyle(newLightPenEnabled ? "crosshair" : "none");
            }

            // Stop VT11 if requested
            if (instruction & 0x404) {
                if (state.getStopInterrupt()) {
                    state.setIMaskBits(IMASK_STOP);
                    requestInterrupt();
                }
                state.setStopBit();
            }

            // Italics (cosmetic only here)
            state.setItalicsFromInstruction(instruction);

            // Line refresh mode (not deeply modelled)
            state.setLineRefreshFromInstruction(instruction);
        }

        function controlSRB(instruction) {
            // Graph increment (6 bits)
            if (instruction & 0x40) {
                state.setGraphIncrement(instruction & 0x3f);
            }
        }

        function handleCharData(instruction, visible, counters) {
            let X = state.getXRegister();
            let Y = state.getYRegister();

            function paintChar(code) {
                if (code >= 32 && code <= 127) {
                    if (visible) {
                        renderer.drawChar(X, Y, code);
                    }
                    X += 8;
                    counters.charCount++;
                    return;
                }
                switch (code) {
                    case 0o15: // CR
                        X = 0;
                        break;
                    case 0o12: // LF
                        Y -= 10;
                        if (Y < 0) Y = 0;
                        break;
                }
            }

            paintChar(instruction & 0x7f);
            paintChar((instruction >>> 8) & 0x7f);

            state.setXRegister(X);
            state.setYRegister(Y);
        }

        function decodeShortVectorOrRelPoint(inst) {
            let XRegister = state.getXRegister();
            let YRegister = state.getYRegister();

            let XValue = (inst >>> 7) & 0x3f;
            let YValue = inst & 0x3f;

            if (inst & 0x2000) {
                XValue = XRegister - XValue;
            } else {
                XValue = XRegister + XValue;
            }

            if (inst & 0x40) {
                YValue = YRegister - YValue;
            } else {
                YValue = YRegister + YValue;
            }

            return { X: XValue & 0x3ff, Y: YValue & 0x3ff };
        }

        function decodeLongVector(inst, ext) {
            let XRegister = state.getXRegister();
            let YRegister = state.getYRegister();

            let XValue = inst & 0x3ff;
            let YValue = ext & 0x3ff;

            if (inst & 0x2000) {
                XValue = XRegister - XValue;
            } else {
                XValue = XRegister + XValue;
            }

            if (ext & 0x2000) {
                YValue = YRegister - YValue;
            } else {
                YValue = YRegister + YValue;
            }

            return { X: XValue & 0x3ff, Y: YValue & 0x3ff };
        }

        function decodePoint(inst, ext) {
            let XValue = inst & 0x3ff;
            let YValue = ext & 0x3ff;
            return { X: XValue, Y: YValue };
        }

        function decodeGraphX(inst) {
            let XValue = inst & 0x3ff;
            let YValue = (state.getYRegister() + state.getGraphIncrement()) & 0x3ff;
            return { X: XValue, Y: YValue };
        }

        function decodeGraphY(inst) {
            let XValue = (state.getXRegister() + state.getGraphIncrement()) & 0x3ff;
            let YValue = inst & 0x3ff;
            return { X: XValue, Y: YValue };
        }

        function handleGraphicsData(instruction, counters) {
            let DSR = state.getDSR();
            let mode = state.getMode();
            let blinkFlag = timing.getBlinkFlag();
            let visible = !(DSR & 0x8) || blinkFlag;

            if (mode === 0) {
                handleCharData(instruction, visible, counters);
                counters.instrCount++;
                return;
            }

            let ext = 0;
            if (mode === 2 || mode === 3) {
                ext = mem.readAndAdvance();
                if (ext < 0) {
                    return;
                }
            }

            let pos;
            switch (mode) {
                case 1:
                case 6:
                    pos = decodeShortVectorOrRelPoint(instruction);
                    break;
                case 2:
                    pos = decodeLongVector(instruction, ext);
                    break;
                case 3:
                    pos = decodePoint(instruction, ext);
                    break;
                case 4:
                    pos = decodeGraphX(instruction);
                    break;
                case 5:
                    pos = decodeGraphY(instruction);
                    break;
                default:
                    return;
            }

            let intensify = instruction & 0x4000;
            if (intensify && visible) {
                let Xstart = state.getXRegister();
                let Ystart = state.getYRegister();
                let Xend = pos.X;
                let Yend = pos.Y;

                renderer.updateStrokeStyleFromDSR(DSR);

                if (mode === 3 || mode === 6) {
                    renderer.drawPoint(Xend, Yend);
                    counters.pointCount++;
                } else {
                    renderer.applyLineStyle(DSR);
                    renderer.drawVector(Xstart, Ystart, Xend, Yend);
                    counters.vectorCount++;
                }

                if (state.getPenInterrupt()) {
                    let pen = lightPen.getPenCoords();
                    let penX = pen.x;
                    let penY = HEIGHT - 1 - pen.y;

                    if (lightPen.distanceCheck(Xstart, Ystart, Xend, Yend, penX, penY)) {
                        state.setIMaskBits(IMASK_PEN);
                        requestInterrupt();
                        state.setStopBit();
                    }
                }
            }

            state.setXRegister(pos.X);
            state.setYRegister(pos.Y);
            counters.instrCount++;
        }

        return {
            handleControl,
            handleGraphicsData
        };
    })();

    // -------------------------------------------------------------------------
    // Processor loop module
    // -------------------------------------------------------------------------

    const cpu = (function () {
        function processorTimeslice() {
            renderer.beginFramePath();

            let deadline = timing.getTimesliceDeadline();
            let startingDPC = state.getDPC();

            let counters = {
                instrCount: 0,
                vectorCount: 0,
                pointCount: 0,
                charCount: 0
            };

            let loops = 0;
            let iterations = 1000;
            let sliceStart = Date.now();

            while (true) {
                let instruction = mem.readAndAdvance();
                if (instruction < 0) break;

                if (instruction & 0x8000) {
                    exec.handleControl(instruction);
                } else {
                    exec.handleGraphicsData(instruction, counters);
                }

                if (--iterations <= 0) {
                    if (Date.now() >= deadline) break;
                    iterations = 1000;
                }

                let DSR = state.getDSR();
                if (DSR & 0x8000) break;

                let currentDPC = state.getDPC();
                if (currentDPC === startingDPC) {
                    loops++;
                    if (loops > 1000) break;
                }
            }

            let sliceEnd = Date.now();
            let sliceMs = sliceEnd - sliceStart;

            if (timing.shouldUpdateFrame(counters.instrCount)) {
                renderer.commitFrame();
            }

            let penCoords = lightPen.getPenCoords();
            let stats = {
                dpc: state.getDPC(),
                dsr: state.getDSR(),
                x: state.getXRegister(),
                y: state.getYRegister(),
                penMouseX: Math.floor(penCoords.x),
                penMouseY: Math.floor(penCoords.y),
                penHitX: state.getXpen(),
                penHitY: state.getYpen(),
                penPending: !!(state.getIMask() & IMASK_PEN),
                instrCount: counters.instrCount,
                vectorCount: counters.vectorCount,
                pointCount: counters.pointCount,
                charCount: counters.charCount,
                sliceMs: sliceMs,
                loops: loops
            };
            statsPanel.update(stats);

            if (!state.isStopped()) {
                setTimeout(processorTimeslice, PROCESSOR_RESCHEDULE_MS);
            }
        }

        function startIfStopped() {
            if (state.isStopped()) {
                state.clearStopBit();
                setTimeout(processorTimeslice, PROCESSOR_RESCHEDULE_MS);
            }
        }

        return {
            processorTimeslice,
            startIfStopped
        };
    })();

    // -------------------------------------------------------------------------
    // I/O page device interface
    // -------------------------------------------------------------------------

    const vt11Device = {
        access: function (physicalAddress, data, byteFlag) {
            "use strict";

            let result;

            switch (physicalAddress & 0o6) {
                case 0o0: {
                    let DPC = state.getDPC();
                    result = insertData(DPC, physicalAddress, data, byteFlag);

                    if (result >= 0 && data >= 0) {
                        renderer.initDOM();
                        timing.startBlinkTimer();

                        let canvasFG = renderer.getCanvasFG();
                        lightPen.attachMouseTracking(canvasFG);

                        if (state.isLightPenEnabled()) {
                            renderer.setCursorStyle("crosshair");
                        } else {
                            renderer.setCursorStyle("none");
                        }

                        if (!(result & 1)) {
                            state.setDPC(result & 0xfffe);
                        }

                        cpu.startIfStopped();
                    }
                    break;
                }

                case 0o2:
                    result = state.getDSR();
                    break;

                case 0o4: {
                    let Xpen = state.getXpen();
                    let graphInc = state.getGraphIncrement();
                    result = (Xpen & 0x3ff) | ((graphInc & 0x3f) << 10);
                    break;
                }

                case 0o6:
                    result = state.getYpen() & 0x3ff;
                    break;

                default:
                    result = 0;
                    break;
            }

            return result;
        },

        poll: function (takeInterrupt) {
            "use strict";

            let iMask = state.getIMask();

            if (takeInterrupt) {
                if (iMask & IMASK_PEN) {
                    state.clearIMaskBits(IMASK_PEN);
                    return 0o324;
                } else {
                    state.setIMask(0);
                    return 0o320;
                }
            } else {
                return (4 << 5) | (iMask ? 1 : 0);
            }
        },

        reset: function () {
            state.reset();
        }
    };

    state.reset();
    return vt11Device;
})());
