/**
 * Script to generate a PDP-11/70 themed favicon.ico
 *
 * Generates an ICO file with embedded BGRA BMP images at multiple sizes.
 * The icon design is a simplified representation of the PDP-11/70 front panel:
 *   - Dark panel background (like the emulator's frame)
 *   - "11" lettering in light gray (like the DEC logo style)
 *   - Three indicator circles on the left (register/status lights)
 *
 * Usage: node tools/gen-favicon.js
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Design helpers
// ---------------------------------------------------------------------------

/**
 * Create a 32-bit BGRA pixel buffer for a given size.
 * Each pixel is 4 bytes: B, G, R, A.
 */
function createCanvas(w, h) {
    return Buffer.alloc(w * h * 4, 0);
}

function setPixel(buf, w, h, x, y, r, g, b, a = 255) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const off = (y * w + x) * 4;
    buf[off]     = b;       // B
    buf[off + 1] = g;       // G
    buf[off + 2] = r;       // R
    buf[off + 3] = a;       // A
}

function fillRect(buf, w, h, x, y, rw, rh, r, g, b, a = 255) {
    for (let j = y; j < y + rh; j++) {
        for (let i = x; i < x + rw; i++) {
            setPixel(buf, w, h, i, j, r, g, b, a);
        }
    }
}

function fillCircle(buf, w, h, cx, cy, radius, r, g, b, a = 255) {
    for (let j = cy - radius; j <= cy + radius; j++) {
        for (let i = cx - radius; i <= cx + radius; i++) {
            const dx = i - cx;
            const dy = j - cy;
            if (dx * dx + dy * dy <= radius * radius) {
                setPixel(buf, w, h, i, j, r, g, b, a);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Icon design: simplified PDP-11/70 front panel
// ---------------------------------------------------------------------------

// Colors (matching the emulator's aesthetic)
const PANEL_BG    = [0x2a, 0x28, 0x25];   // dark warm gray
const PANEL_BORDER = [0x73, 0x6c, 0x62];  // medium gray border (from .decBase)
const LIGHT_GRAY  = [0xf6, 0xf5, 0xf5];   // stroke color from SVG
const LED_OFF     = [0x50, 0x40, 0x30];   // dim indicator
const LED_ON      = [0xff, 0x60, 0x20];   // warm orange glow
const ACCENT      = [0xc3, 0xbc, 0xaa];   // frame background

function drawPDP11Panel(buf, w, h) {
    // --- Background ---
    const margin = Math.max(1, Math.floor(w * 0.08));
    const bw = w - margin * 2;
    const bh = h - margin * 2;

    // Panel background
    fillRect(buf, w, h, margin, margin, bw, bh, ...PANEL_BG);

    // --- Border (rounded rect approximation) ---
    const borderW = 1;
    // top/bottom lines
    fillRect(buf, w, h, margin + 1, margin, bw - 2, borderW, ...PANEL_BORDER);
    fillRect(buf, w, h, margin + 1, margin + bh - borderW, bw - 2, borderW, ...PANEL_BORDER);
    // left/right lines
    fillRect(buf, w, h, margin, margin + 1, borderW, bh - 2, ...PANEL_BORDER);
    fillRect(buf, w, h, margin + bw - borderW, margin + borderW, borderW, bh - 2, ...PANEL_BORDER);

    const innerLeft = margin + 3;
    const innerTop = margin + 3;
    const innerW = bw - 6;
    const innerH = bh - 6;

    // --- Three indicator circles (left side, like in the SVG) ---
    const circleRadius = Math.max(2, Math.floor(w * 0.07));
    const circleSpacing = Math.floor(innerH / 4);
    const circlesX = innerLeft + Math.floor(innerW * 0.15);
    const circlesY0 = innerTop + circleSpacing;

    // Draw three indicators: first ON (orange glow), others OFF
    for (let i = 0; i < 3; i++) {
        const cy = circlesY0 + i * circleSpacing;
        const color = (i === 1) ? LED_ON : LED_OFF;
        fillCircle(buf, w, h, circlesX, cy, circleRadius, ...color);
    }

    // --- "11" digits (right side, like in the SVG) ---
    const digitW = Math.max(2, Math.floor(w * 0.12));
    const digitH = Math.max(4, Math.floor(h * 0.28));
    const digitGap = Math.max(1, Math.floor(w * 0.03));
    const digitsX = innerLeft + Math.floor(innerW * 0.55);
    const digitsY = innerTop + Math.floor((innerH - digitH) / 2);

    // First "1"
    fillRect(buf, w, h, digitsX, digitsY, digitW, digitH, ...LIGHT_GRAY);
    // Second "1"
    fillRect(buf, w, h, digitsX + digitW + digitGap, digitsY, digitW, digitH, ...LIGHT_GRAY);

    // --- Bottom accent line (like the DEC base strip in the HTML) ---
    const stripY = margin + bh - 3;
    fillRect(buf, w, h, margin + 4, stripY, bw - 8, 1, ...ACCENT);
}

// ---------------------------------------------------------------------------
// ICO format writer
// ---------------------------------------------------------------------------

/**
 * Create an ICO file from multiple sizes.
 * Each image is stored as a DIB (device-independent bitmap) in BGRA 32-bit format.
 */
function createICO(sizes) {
    const headerSize = 6;
    const dirEntrySize = 16;
    const numImages = sizes.length;

    // We'll collect: { offset, data }
    const images = [];

    for (const size of sizes) {
        const w = size;
        const h = size;

        // Create the pixel canvas and draw the PDP-11 panel
        const canvas = createCanvas(w, h);
        drawPDP11Panel(canvas, w, h);

        // Build DIB data (BITMAPINFOHEADER + pixel data)
        const bihSize = 40;
        const pixelDataSize = w * h * 4;  // BGRA 32bpp

        // BITMAPINFOHEADER structure:
        //   DWORD biSize (4)
        //   LONG  biWidth (4)
        //   LONG  biHeight (4) — positive = bottom-up
        //   WORD  biPlanes (2)
        //   WORD  biBitCount (2)
        //   DWORD biCompression (4)
        //   DWORD biSizeImage (4)
        //   LONG  biXPelsPerMeter (4)
        //   LONG  biYPelsPerMeter (4)
        //   DWORD biClrUsed (4)
        //   DWORD biClrImportant (4)
        const dib = Buffer.alloc(bihSize + pixelDataSize);

        let off = 0;
        // biSize
        dib.writeUInt32LE(bihSize, off); off += 4;
        // biWidth
        dib.writeInt32LE(w, off); off += 4;
        // biHeight — ICO needs height * 2 (XOR + AND mask height)
        // But for embedded ICO DIB, the height is doubled
        dib.writeInt32LE(h * 2, off); off += 4;
        // biPlanes
        dib.writeUInt16LE(1, off); off += 2;
        // biBitCount
        dib.writeUInt16LE(32, off); off += 2;
        // biCompression (BI_RGB = 0)
        dib.writeUInt32LE(0, off); off += 4;
        // biSizeImage
        dib.writeUInt32LE(pixelDataSize, off); off += 4;
        // biXPelsPerMeter
        dib.writeInt32LE(0, off); off += 4;
        // biYPelsPerMeter
        dib.writeInt32LE(0, off); off += 4;
        // biClrUsed
        dib.writeUInt32LE(0, off); off += 4;
        // biClrImportant
        dib.writeUInt32LE(0, off); off += 4;

        // Pixel data — ICO expects top-down (not bottom-up like BMP)
        // The height is doubled in ICO, and we write XOR mask + AND mask
        // For 32bpp, the pixel data is just the BGRA pixels top-down
        canvas.copy(dib, off, 0, pixelDataSize);
        off += pixelDataSize;

        // AND mask (1 bit per pixel) — all transparent (0 = opaque in AND mask)
        // But since we use 32bpp with alpha channel, AND mask should be all zeros
        const andMaskSize = Math.ceil(w / 32) * 4 * h;
        // Already zero-initialized from Buffer.alloc

        // Total image data size: bihSize + pixelDataSize + andMaskSize
        const totalSize = bihSize + pixelDataSize + andMaskSize;

        images.push({ w, h, data: dib, size: totalSize });
    }

    // Calculate offsets
    let currentOffset = headerSize + numImages * dirEntrySize;
    const entries = images.map(img => {
        const entry = {
            w: img.w,
            h: img.h,
            offset: currentOffset,
            size: img.size,
        };
        currentOffset += img.size;
        return entry;
    });

    // Write ICO file
    const fileSize = currentOffset;
    const buf = Buffer.alloc(fileSize);
    let off = 0;

    // Header
    buf.writeUInt16LE(0, off); off += 2;    // reserved
    buf.writeUInt16LE(1, off); off += 2;    // type = ICO
    buf.writeUInt16LE(numImages, off); off += 2; // count

    // Directory entries
    for (const ent of entries) {
        buf.writeUInt8(ent.w === 256 ? 0 : ent.w, off); off += 1;  // width
        buf.writeUInt8(ent.h === 256 ? 0 : ent.h, off); off += 1;  // height
        buf.writeUInt8(0, off); off += 1;  // color count
        buf.writeUInt8(0, off); off += 1;  // reserved
        buf.writeUInt16LE(1, off); off += 2;  // planes
        buf.writeUInt16LE(32, off); off += 2; // bit count
        buf.writeUInt32LE(ent.size, off); off += 4; // size
        buf.writeUInt32LE(ent.offset, off); off += 4; // offset
    }

    // Image data
    for (let i = 0; i < images.length; i++) {
        images[i].data.copy(buf, entries[i].offset, 0, images[i].size);
    }

    return buf;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const sizes = [16, 32, 48];
const icoData = createICO(sizes);

const outputPath = path.join(__dirname, '..', 'favicon.ico');
fs.writeFileSync(outputPath, icoData);

console.log(`Generated favicon.ico (${sizes.join('x')} sizes)`);
console.log(`File size: ${icoData.length} bytes`);
console.log(`Output: ${outputPath}`);
