#!/usr/bin/env node
/**
 * Generate themed bitmap artwork for the desktop installers:
 *
 *   1. NSIS sidebar (left panel of Welcome/Finish)  ->  sidebar.bmp  164x314
 *   2. MSI/WiX banner (top strip of every page)     ->  banner.bmp   493x58
 *   3. MSI/WiX dialog (Welcome/Finish body)         ->  dialog.bmp   493x312
 *
 * NSIS Modern UI 2 and the WiX UI extension both require BMP files, so the
 * artwork is drawn programmatically, pixel by pixel, following the approach
 * used by tools/gen-favicon.js. The design mirrors the emulator's front panel:
 * dark cabinet, "11" lettering, indicator lamps, toggle switches and the
 * DEC-style accent strip.
 *
 * Usage: node tools/gen-installer-images.js
 * Output: src-tauri/installer/*.bmp
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Small pixel canvas helper (24-bit RGB, top-down while drawing)
// ---------------------------------------------------------------------------

function makeCanvas(w, h) {
    const buf = Buffer.alloc(w * h * 3, 0);

    function setPixel(x, y, r, g, b) {
        if (x < 0 || x >= w || y < 0 || y >= h) return;
        const off = (y * w + x) * 3;
        buf[off] = r;
        buf[off + 1] = g;
        buf[off + 2] = b;
    }

    return {
        w, h, buf,
        setPixel,
        fillRect(x, y, rw, rh, r, g, b) {
            for (let j = y; j < y + rh; j++) {
                for (let i = x; i < x + rw; i++) {
                    setPixel(i, j, r, g, b);
                }
            }
        },
        fillCircle(x, y, radius, r, g, b) {
            for (let j = y - radius; j <= y + radius; j++) {
                for (let i = x - radius; i <= x + radius; i++) {
                    const dx = i - x;
                    const dy = j - y;
                    if (dx * dx + dy * dy <= radius * radius) {
                        setPixel(i, j, r, g, b);
                    }
                }
            }
        },
        // Vertical gradient filling the whole canvas.
        gradient(top, bottom) {
            for (let y = 0; y < h; y++) {
                const t = y / (h - 1);
                const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
                const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
                const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
                this.fillRect(0, y, w, 1, r, g, b);
            }
        },
        // Draw the front-panel frame (fill + border + top glare + inner hairline).
        panel(x, y, pw, ph) {
            this.fillRect(x + 4, y + 4, pw, ph, ...C.PANEL_EDGE);   // drop shadow
            this.fillRect(x, y, pw, ph, ...C.PANEL_BG);             // main fill
            this.fillRect(x + 3, y + 3, pw - 6, Math.max(4, Math.floor(ph * 0.07)), ...C.PANEL_GLARE);
            this.fillRect(x, y, pw, 2, ...C.PANEL_BORDER);          // border
            this.fillRect(x, y + ph - 2, pw, 2, ...C.PANEL_BORDER);
            this.fillRect(x, y + 2, 2, ph - 4, ...C.PANEL_BORDER);
            this.fillRect(x + pw - 2, y + 2, 2, ph - 4, ...C.PANEL_BORDER);
            const ix = x + 4, iy = y + 4, iw = pw - 8, ih = ph - 8;
            this.fillRect(ix, iy, iw, 1, ...C.PANEL_BORDER);        // inner hairline
            this.fillRect(ix, iy + ih - 1, iw, 1, ...C.PANEL_BORDER);
            this.fillRect(ix, iy + 1, 1, ih - 2, ...C.PANEL_BORDER);
            this.fillRect(ix + iw - 1, iy + 1, 1, ih - 2, ...C.PANEL_BORDER);
        },
        // "11" lettering (two solid digits).
        digits11(x, y, dw, dh, gap) {
            this.fillRect(x, y, dw, dh, ...C.LIGHT_GRAY);
            this.fillRect(x + dw + gap, y, dw, dh, ...C.LIGHT_GRAY);
        },
        // A row of indicator lamps; `lits` is an array of booleans (middle glows orange).
        lamps(x, ys, radius, lits) {
            ys.forEach((cy, i) => {
                const lit = lits[i];
                if (lit) {
                    this.fillCircle(x, cy, Math.round(radius * 1.45), ...C.LED_HALO);
                    this.fillCircle(x, cy, radius, ...C.LED_ON);
                    this.fillCircle(x - Math.round(radius * 0.25), cy - Math.round(radius * 0.25), Math.round(radius * 0.33), ...C.LED_HOT);
                    this.fillCircle(x, cy, Math.round(radius * 1.35), ...C.LED_RIM);
                } else {
                    this.fillCircle(x, cy, Math.round(radius * 0.8), ...C.LED_OFF);
                    this.fillCircle(x, cy, radius, ...C.LED_OFF_RIM);
                }
            });
        },
        // Row of toggle switches.
        toggles(y, sw, sh, count, gap) {
            const total = count * sw + (count - 1) * gap;
            const x0 = Math.floor((this.w - total) / 2);
            for (let i = 0; i < count; i++) {
                const sx = x0 + i * (sw + gap);
                this.fillRect(sx, y, sw, sh, ...C.SW_BODY);
                this.fillRect(sx, y, sw, 2, ...C.SW_FRAME);
                this.fillRect(sx, y + sh - 2, sw, 2, ...C.SW_FRAME);
                this.fillRect(sx, y + 2, 2, sh - 4, ...C.SW_FRAME);
                this.fillRect(sx + sw - 2, y + 2, 2, sh - 4, ...C.SW_FRAME);
                const lw = Math.max(3, Math.floor(sw * 0.28));
                const lh = Math.max(8, Math.floor(sh * 0.4));
                const lx = sx + 2 + (i % 2 === 0 ? 2 : 0);
                const ly = y + sh - lh - 4;
                this.fillRect(lx, ly, lw, lh, ...C.SW_LEVER);
                this.fillRect(lx + 1, ly - 2, lw - 2, 3, ...C.LIGHT_GRAY);
            }
        },
        text(text, y, scale, r, g, b) {
            const glyphW = 5 * scale;
            const step = glyphW + scale;
            const totalW = text.length * step - scale;
            const x0 = Math.floor((this.w - totalW) / 2);
            let x = x0;
            for (const ch of text) {
                const glyph = FONT[ch] || FONT['-'];
                for (let gy = 0; gy < 7; gy++) {
                    for (let gx = 0; gx < 5; gx++) {
                        if (glyph[gy][gx] === '1') {
                            this.fillRect(x + gx * scale, y + gy * scale, scale, scale, r, g, b);
                        }
                    }
                }
                x += step;
            }
        },
    };
}

// ---------------------------------------------------------------------------
// 5x7 bitmap font (only the glyphs we need)
// ---------------------------------------------------------------------------
const FONT = {
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '0': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'm': ['00000', '00000', '00000', '11010', '10101', '10101', '10101'],
    'u': ['00000', '00000', '00000', '10001', '10001', '10001', '01110'],
    'l': ['01000', '01000', '01000', '01000', '01000', '01000', '01110'],
    'a': ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
    't': ['00100', '00100', '01110', '00100', '00100', '00100', '00010'],
    'r': ['00000', '00000', '00000', '10110', '11001', '10000', '10000'],
    'o': ['00000', '00000', '00000', '01110', '10001', '10001', '01110'],
};

// ---------------------------------------------------------------------------
// Palette (matching the emulator's front-panel aesthetic)
// ---------------------------------------------------------------------------
const C = {
    CAB_TOP:    [0x26, 0x23, 0x1f],
    CAB_BOTTOM: [0x0d, 0x0c, 0x0a],
    PANEL_BG:   [0x2e, 0x2b, 0x27],
    PANEL_EDGE: [0x50, 0x4b, 0x43],
    PANEL_BORDER: [0x8a, 0x81, 0x74],
    PANEL_GLARE:  [0x3c, 0x38, 0x33],
    LIGHT_GRAY: [0xf0, 0xef, 0xee],
    LED_OFF:    [0x4a, 0x3b, 0x2c],
    LED_OFF_RIM:[0x35, 0x2b, 0x20],
    LED_HALO:   [0x7a, 0x33, 0x0e],
    LED_ON:     [0xff, 0x8a, 0x2e],
    LED_HOT:    [0xff, 0xd9, 0xa8],
    LED_RIM:    [0x52, 0x2a, 0x12],
    SW_BODY:    [0x1c, 0x1a, 0x17],
    SW_FRAME:   [0x6b, 0x64, 0x59],
    SW_LEVER:   [0xcf, 0xc9, 0xbc],
    ACCENT:     [0xc3, 0xbc, 0xaa],
    TEXT_DIM:   [0xa8, 0xa1, 0x93],
};

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

// NSIS sidebar: tall vertical front-panel view (164x314).
function drawSidebar() {
    const c = makeCanvas(164, 314);
    c.gradient(C.CAB_TOP, C.CAB_BOTTOM);

    const px = 20, py = 22, pw = 124, ph = 188;
    c.panel(px, py, pw, ph);

    // "11" lettering, right side
    const dw = 24, dh = 60, gap = 6;
    c.digits11(px + 66, py + Math.floor((ph - dh) / 2), dw, dh, gap);

    // three lamps, left side (middle glows)
    const lampX = px + 24;
    const lits = [false, true, false];
    const ys = [py + 34, py + 94, py + 154];
    c.lamps(lampX, ys, 9, lits);

    // caption + toggles + accent strip
    c.text('PDP-11/70', 228, 2, ...C.TEXT_DIM);
    c.toggles(252, 18, 30, 4, 18);
    c.fillRect(28, 296, 108, 3, ...C.ACCENT);

    return c;
}

// MSI dialog: wide Welcome/Finish body (493x312).
function drawDialog() {
    const c = makeCanvas(493, 312);
    c.gradient(C.CAB_TOP, C.CAB_BOTTOM);

    const px = 46, py = 36, pw = 400, ph = 196;
    c.panel(px, py, pw, ph);

    // "11" lettering, right side
    const dw = 58, dh = 122, gap = 12;
    c.digits11(px + 176, py + Math.floor((ph - dh) / 2), dw, dh, gap);

    // three lamps, left side (middle glows)
    const lampX = px + 54;
    const lits = [false, true, false];
    const ys = [py + 48, py + 98, py + 148];
    c.lamps(lampX, ys, 13, lits);

    // caption + toggles + accent strip
    c.text('PDP-11/70', 250, 3, ...C.TEXT_DIM);
    c.toggles(282, 26, 40, 4, 26);
    c.fillRect(90, 300, 313, 3, ...C.ACCENT);

    return c;
}

// MSI banner: thin top strip (493x58). Kept text-free so it never clashes
// with the title WiX draws over it on every page.
function drawBanner() {
    const c = makeCanvas(493, 58);
    c.gradient(C.CAB_TOP, C.CAB_BOTTOM);

    // mini front panel, bottom-left
    const px = 10, py = 8, pw = 130, ph = 42;
    c.panel(px, py, pw, ph);

    // mini "11"
    const dw = 16, dh = 28, gap = 4;
    c.digits11(px + 64, py + Math.floor((ph - dh) / 2), dw, dh, gap);

    // two mini lamps
    c.lamps(px + 26, [py + 13, py + 29], 5, [true, false]);

    // accent strip along the bottom edge
    c.fillRect(8, 54, 477, 2, ...C.ACCENT);

    return c;
}

// ---------------------------------------------------------------------------
// BMP writer (24-bit, bottom-up, no alpha)
// ---------------------------------------------------------------------------

function createBMP(c) {
    const w = c.w, h = c.h;
    const rowSize = w * 3;
    const paddedRowSize = Math.ceil(rowSize / 4) * 4;
    const pixelDataSize = paddedRowSize * h;
    const headerSize = 14;
    const infoSize = 40;
    const fileSize = headerSize + infoSize + pixelDataSize;

    const buf = Buffer.alloc(fileSize);
    let off = 0;

    // BITMAPFILEHEADER
    buf.write('BM', off, 'ascii'); off += 2;
    buf.writeUInt32LE(fileSize, off); off += 4;
    buf.writeUInt16LE(0, off); off += 2; // reserved
    buf.writeUInt16LE(0, off); off += 2; // reserved
    buf.writeUInt32LE(headerSize + infoSize, off); off += 4; // pixel data offset

    // BITMAPINFOHEADER
    buf.writeUInt32LE(infoSize, off); off += 4;
    buf.writeInt32LE(w, off); off += 4;
    buf.writeInt32LE(h, off); off += 4; // positive -> bottom-up
    buf.writeUInt16LE(1, off); off += 2; // planes
    buf.writeUInt16LE(24, off); off += 2; // bits per pixel
    buf.writeUInt32LE(0, off); off += 4; // BI_RGB
    buf.writeUInt32LE(pixelDataSize, off); off += 4;
    buf.writeInt32LE(2835, off); off += 4; // 72 dpi X
    buf.writeInt32LE(2835, off); off += 4; // 72 dpi Y
    buf.writeUInt32LE(0, off); off += 4; // colors used
    buf.writeUInt32LE(0, off); off += 4; // important colors

    // Pixel data, bottom-up: source row (h-1-y) is copied first.
    for (let y = 0; y < h; y++) {
        const srcRow = h - 1 - y;
        c.buf.copy(buf, off, srcRow * rowSize, srcRow * rowSize + rowSize);
        off += paddedRowSize; // padding bytes are already zero
    }

    return buf;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const outDir = path.join(__dirname, '..', 'src-tauri', 'installer');
fs.mkdirSync(outDir, { recursive: true });

const images = [
    { name: 'sidebar.bmp', canvas: drawSidebar() },
    { name: 'banner.bmp',  canvas: drawBanner() },
    { name: 'dialog.bmp',  canvas: drawDialog() },
];

for (const { name, canvas } of images) {
    const bmp = createBMP(canvas);
    const outputPath = path.join(outDir, name);
    fs.writeFileSync(outputPath, bmp);
    console.log(`Generated ${name} (${canvas.w}x${canvas.h}, ${bmp.length} bytes)`);
}

console.log(`Output: ${outDir}`);
