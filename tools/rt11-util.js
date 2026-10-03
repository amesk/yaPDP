#!/usr/bin/env node

/**
 * mkrt11.js — create and maintain RT-11 (RK05) disk images.
 *
 * Usage:
 *   node mkrt11.js create <image.dsk> [VOLID]        create an empty RT-11 volume
 *   node mkrt11.js add    <image.dsk> <file1> [...]  add host files to the volume
 *   node mkrt11.js dir    <image.dsk>                list the volume directory
 *   node mkrt11.js delete <image.dsk> <NAME.EXT> ... delete files by RT-11 name
 *
 * Example:
 *   node mkrt11.js create rk05.dsk
 *   node mkrt11.js add rk05.dsk SPCINV.SAV README.TXT
 *   node mkrt11.js dir rk05.dsk
 *
 * The on-disk layout is modelled on real DEC RT-11 RK05 volumes that ship with
 * the emulator (media/rk1.dsk = RT-11 V4, media/rk5.dsk = RT-11 V5). Two facts
 * that the first version of this tool got wrong and that made RT-11 print
 * garbage:
 *
 *   1. The home block field offsets in the RT-11 documentation are OCTAL byte
 *      offsets, not decimal word indices: the first directory block lives at
 *      byte 0o724 = 468, the volume id at 0o730 = 472 and the system id at
 *      0o760 = 496 (both ids are plain ASCII, space padded).
 *   2. A directory entry is always 7 words (14 bytes), and the status word of
 *      a PERMANENT file is 0x0400 while 0x0200 marks the free-space pseudo-file
 *      "EMPTY.FIL". 0x0800 ends a segment. (RT-11 V5 additionally sets 0x8000
 *      on permanent entries; RT-11 V4 does not, and 0x0400 alone is enough.)
 */

const fs = require('fs');
const path = require('path');

// ─── RK05 geometry ─────────────────────────────────────────────────────────
const BLOCK_SIZE = 512;                 // Bytes per block
const RK05_BLOCKS = 4872;               // Blocks on an RK05 pack
const RK05_SIZE = BLOCK_SIZE * RK05_BLOCKS;

const HOME_BLOCK = 1;                   // The home block is always block 1
const DIR_START_BLOCK = 6;              // First directory segment (RT-11 RK05)
const DIR_SEGMENT_BLOCKS = 2;           // A directory segment spans 2 blocks
const DIR_ENTRIES_PER_SEGMENT = 72;     // 72 entries of 7 words fit in 2 blocks
const DIR_SEGMENTS = 16;                // Segments reserved for the directory
const DATA_START_BLOCK = DIR_START_BLOCK + DIR_SEGMENT_BLOCKS * DIR_SEGMENTS; // 38

// The monitor keeps a fixed tail of the pack out of the free space: an RT-11
// RK05 INIT offers 4762 of the 4834 blocks after the directory. Declaring the
// full 4834 makes the monitor reject the volume with "Illegal directory".
const RT11_RESERVED_BLOCKS = 72;
const DATA_BLOCKS = RK05_BLOCKS - DATA_START_BLOCK - RT11_RESERVED_BLOCKS;

// Home block byte offsets (octal in the DEC docs → decimal here).
const HB_OFF_ID        = 0o722;         // 466: home block identifier (= 1)
const HB_OFF_ID2       = 0o726;         // 470: fixed word written by INIT
const HB_OFF_FIRST_DIR = 0o724;         // 468: first directory block
const HB_OFF_VOLID     = 0o730;         // 472: volume id (ASCII, 24 bytes)
const HB_OFF_SYSID     = 0o760;         // 496: system id (ASCII, 12 bytes)

const HB_INIT_WORD = 0x8ea9;            // the value RT-11 V4 INIT puts at 0o726

// Directory entry format (7 words = 14 bytes).
const DIR_ENTRY_WORDS = 7;
const DIR_ENTRY_BYTES = DIR_ENTRY_WORDS * 2;
const DIR_SEGMENT_HEADER_WORDS = 5;

// Entry status words.
const E_PERM  = 0x0400;                 // Permanent (visible) file
const E_EMPTY = 0x0200;                 // Free-space pseudo-file ("EMPTY.FIL")
const E_EOS   = 0x0800;                 // End of directory segment

// The free space on an RT-11 volume is represented by this pseudo-file.
const EMPTY_NAME = ' EMPTY';
const EMPTY_EXT  = 'FIL';

const RADIX50_CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ$.*0123456789';

// ─── Radix-50 helpers ──────────────────────────────────────────────────────

/** Encode a string into Radix-50 words (3 characters per word). */
function rad50(str, words) {
  const out = [];
  for (let i = 0; i < words; i++) {
    const c1 = RADIX50_CHARS.indexOf((str[i * 3]     || ' ').toUpperCase());
    const c2 = RADIX50_CHARS.indexOf((str[i * 3 + 1] || ' ').toUpperCase());
    const c3 = RADIX50_CHARS.indexOf((str[i * 3 + 2] || ' ').toUpperCase());
    out.push(((c1 < 0 ? 0 : c1) * 40 + (c2 < 0 ? 0 : c2)) * 40 + (c3 < 0 ? 0 : c3));
  }
  return out;
}

/** Decode one Radix-50 word back into its 3 characters. */
function unRad50(word) {
  return RADIX50_CHARS[Math.floor(word / 1600) % 40] +
         RADIX50_CHARS[Math.floor(word / 40) % 40] +
         RADIX50_CHARS[word % 40];
}

/** Split a host file name into RT-11 { name (6 chars), ext (3 chars) }. */
function parseRt11Name(filename) {
  const base = path.basename(filename).toUpperCase();
  const dot = base.lastIndexOf('.');
  const name = (dot === -1 ? base : base.slice(0, dot)).slice(0, 6).padEnd(6, ' ');
  const ext  = (dot === -1 ? ''   : base.slice(dot + 1)).slice(0, 3).padEnd(3, ' ');
  return { name, ext };
}

/** "NAME.EXT" for the directory listing. */
function formatRt11Name(name, ext) {
  const e = ext.replace(/\s+$/, '');
  return (e ? `${name.replace(/\s+$/, '')}.${e}` : name.replace(/\s+$/, ''));
}

// ─── Low-level buffer helpers ──────────────────────────────────────────────

function writeWord(buf, offset, value) {
  buf.writeUInt16LE(value & 0xFFFF, offset);
}

function writeAscii(buf, offset, text, length) {
  buf.fill(0x20, offset, offset + length);
  buf.write(text.slice(0, length), offset, 'latin1');
}

function readAscii(buf, offset, length) {
  return buf.toString('latin1', offset, offset + length);
}

// ─── Directory entry encoding ──────────────────────────────────────────────

/** Write one 7-word directory entry at `offset`. */
function writeEntry(buf, offset, status, name, ext, length, date) {
  writeWord(buf, offset + 0, status);
  const n = rad50(name.padEnd(6, ' '), 2);
  writeWord(buf, offset + 2, n[0]);
  writeWord(buf, offset + 4, n[1]);
  const e = rad50(ext.padEnd(3, ' '), 1);
  writeWord(buf, offset + 6, e[0]);
  writeWord(buf, offset + 8, length);
  writeWord(buf, offset + 10, 0);          // job number (unused)
  writeWord(buf, offset + 12, date);       // RT-11 date word (0 = no date)
}

/** The "EMPTY.FIL" entry describing `length` free blocks. */
function writeEmptyEntry(buf, offset, length) {
  writeEntry(buf, offset, E_EMPTY, EMPTY_NAME, EMPTY_EXT, length, 0);
}

// ─── Volume reading ────────────────────────────────────────────────────────

/**
 * readVolume — parse the home block and the whole directory chain.
 * Returns { volid, files: [{ name, ext, length, date, data }] }.
 * Works on any RT-11 volume (single or multi-segment), not just ours.
 */
function readVolume(imagePath) {
  if (!fs.existsSync(imagePath)) {
    console.error(`Image ${imagePath} not found.`);
    process.exit(1);
  }
  const buf = fs.readFileSync(imagePath);
  const hb = HOME_BLOCK * BLOCK_SIZE;

  const volid = readAscii(buf, hb + HB_OFF_VOLID, 24).replace(/\s+$/, '');
  const firstDir = buf.readUInt16LE(hb + HB_OFF_FIRST_DIR);
  if (!firstDir) {
    console.error(`Image ${imagePath} is not an RT-11 volume (no directory pointer).`);
    process.exit(1);
  }

  const files = [];
  for (let s = 0; s < DIR_SEGMENTS; s++) {
    const base = (firstDir + s * DIR_SEGMENT_BLOCKS) * BLOCK_SIZE;
    if (base + DIR_SEGMENT_BLOCKS * BLOCK_SIZE > buf.length) break;

    // Stop at the first all-zero header: that is where the used segments end.
    let allZero = true;
    for (let i = 0; i < DIR_SEGMENT_HEADER_WORDS; i++) {
      if (buf.readUInt16LE(base + i * 2) !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    let dataBlock = buf.readUInt16LE(base + 8);
    let off = base + DIR_SEGMENT_HEADER_WORDS * 2;
    const end = base + DIR_SEGMENT_BLOCKS * BLOCK_SIZE;

    while (off + DIR_ENTRY_BYTES <= end) {
      const status = buf.readUInt16LE(off);
      if (status === 0x0000 || status === E_EOS) break;

      const length = buf.readUInt16LE(off + 8);
      if (status & E_PERM) {
        const name = unRad50(buf.readUInt16LE(off + 2)) + unRad50(buf.readUInt16LE(off + 4));
        const ext  = unRad50(buf.readUInt16LE(off + 6));
        const date = buf.readUInt16LE(off + 12);
        const start = dataBlock * BLOCK_SIZE;
        const data = Buffer.from(buf.subarray(start, start + length * BLOCK_SIZE));
        files.push({ name, ext, length, date, data });
      }
      dataBlock += length;
      off += DIR_ENTRY_BYTES;
    }
  }
  return { volid, files };
}

// ─── Volume writing ────────────────────────────────────────────────────────

/**
 * writeVolume — lay out the home block, the directory (single used segment,
 * up to DIR_ENTRIES_PER_SEGMENT files) and the file data, then save.
 * `files` is the full list: [{ name, ext, length, date, data }].
 */
function writeVolume(imagePath, volid, files) {
  // One segment holds 72 entries; the last slot is the free-space entry and
  // two more bytes are the EOS marker, so at most 71 real files fit.
  if (files.length > DIR_ENTRIES_PER_SEGMENT - 1) {
    console.error(`❌ Too many entries for a single segment ` +
      `(max ${DIR_ENTRIES_PER_SEGMENT - 1}); this tool does not chain segments.`);
    process.exit(1);
  }

  const usedBlocks = files.reduce((n, f) => n + f.length, 0);
  if (usedBlocks > DATA_BLOCKS) {
    console.error(`❌ Not enough space: ${usedBlocks} blocks needed, ` +
      `${DATA_BLOCKS} available.`);
    process.exit(1);
  }

  const buf = Buffer.alloc(RK05_SIZE, 0);

  // ── Home block ──
  const hb = HOME_BLOCK * BLOCK_SIZE;
  writeWord(buf, hb + HB_OFF_ID, 1);
  writeWord(buf, hb + HB_OFF_ID2, HB_INIT_WORD);
  writeWord(buf, hb + HB_OFF_FIRST_DIR, DIR_START_BLOCK);
  writeAscii(buf, hb + HB_OFF_VOLID, (volid || 'RT11A').slice(0, 12), 24);
  writeAscii(buf, hb + HB_OFF_SYSID, 'DECRT11A', 12);

  // ── Assign each file its data blocks (contiguous from DATA_START_BLOCK) ──
  let cursor = DATA_START_BLOCK;
  const placed = files.map((f) => {
    const start = cursor;
    cursor += f.length;
    return Object.assign({}, f, { start });
  });
  for (const f of placed) {
    if (f.data) f.data.copy(buf, f.start * BLOCK_SIZE);
  }

  // ── Directory segment ──
  const base = DIR_START_BLOCK * BLOCK_SIZE;
  writeWord(buf, base + 0, DIR_SEGMENTS);   // segments reserved for the directory
  writeWord(buf, base + 2, 0);              // next segment number (none)
  writeWord(buf, base + 4, 1);              // highest segment number in use
  writeWord(buf, base + 6, 0);              // extra bytes per entry
  writeWord(buf, base + 8, DATA_START_BLOCK); // first block of the data area

  let off = base + DIR_SEGMENT_HEADER_WORDS * 2;
  for (const f of placed) {
    writeEntry(buf, off, E_PERM, f.name, f.ext, f.length, f.date || 0);
    off += DIR_ENTRY_BYTES;
  }

  // Free space (the "EMPTY.FIL" pseudo-file) then end of segment. The monitor
  // reserves RT11_RESERVED_BLOCKS at the end of the pack, so the offered free
  // space is DATA_BLOCKS minus what the files already use.
  const freeBlocks = DATA_BLOCKS - usedBlocks;
  writeEmptyEntry(buf, off, freeBlocks);
  off += DIR_ENTRY_BYTES;
  writeWord(buf, off, E_EOS);

  fs.writeFileSync(imagePath, buf);
}

// ─── Commands ──────────────────────────────────────────────────────────────

function createImage(imagePath, volid) {
  if (fs.existsSync(imagePath)) {
    console.error(`File ${imagePath} already exists.`);
    process.exit(1);
  }
  writeVolume(imagePath, volid || 'RT11A', []);
  console.log(`✅ Created ${imagePath} — RK05, ${RK05_BLOCKS} blocks ` +
    `(${DATA_BLOCKS} free), volume id "${(volid || 'RT11A')}"`);
}

function addFiles(imagePath, sourceFiles) {
  const { volid, files } = readVolume(imagePath);
  for (const src of sourceFiles) {
    if (!fs.existsSync(src)) {
      console.error(`Source file ${src} not found.`);
      process.exit(1);
    }
    const data = fs.readFileSync(src);
    const length = Math.max(1, Math.ceil(data.length / BLOCK_SIZE));
    const { name, ext } = parseRt11Name(src);
    // RADIX-50 has no underscore or other punctuation: warn rather than
    // silently turn such a character into a blank in the stored name.
    const base = path.basename(src).toUpperCase();
    if (/[^A-Z0-9$.*]/.test(base)) {
      console.error(`   ⚠️  ${path.basename(src)}: characters outside ` +
        `A-Z 0-9 $ . * cannot be stored in RADIX-50 and become blanks.`);
    }
    const existing = files.findIndex((f) =>
      f.name === name && f.ext === ext);
    if (existing >= 0) {
      console.error(`❌ ${formatRt11Name(name, ext)} already exists on the volume.`);
      process.exit(1);
    }
    files.push({ name, ext, length, date: 0, data });
    console.log(`  + ${formatRt11Name(name, ext)}  (${length} blocks)`);
  }
  writeVolume(imagePath, volid, files);
  console.log(`✅ ${imagePath} updated (${files.length} file(s))`);
}

function deleteFiles(imagePath, names) {
  const { volid, files } = readVolume(imagePath);
  let removed = 0;
  for (const arg of names) {
    const { name, ext } = parseRt11Name(arg);
    const idx = files.findIndex((f) => f.name === name && f.ext === ext);
    if (idx < 0) {
      console.error(`❌ ${formatRt11Name(name, ext)} not found.`);
      continue;
    }
    console.log(`  - ${formatRt11Name(files[idx].name, files[idx].ext)}`);
    files.splice(idx, 1);
    removed++;
  }
  if (!removed) {
    console.error('❌ Nothing deleted.');
    process.exit(1);
  }
  writeVolume(imagePath, volid, files);
  console.log(`✅ ${imagePath} updated (${files.length} file(s))`);
}

/** RT-11 date word → "DD-Mon-YYYY", or "" when the date is unset. */
function formatDate(word) {
  if (!word) return '';
  const day = word & 0x1F;
  const month = (word >> 5) & 0x0F;
  const year = ((word >> 9) & 0x7F) + 1972;
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (day < 1 || day > 31 || month < 1 || month > 12) return '';
  return `${String(day).padStart(2, '0')}-${names[month]}-${year}`;
}

function listDir(imagePath) {
  const { volid, files } = readVolume(imagePath);
  console.log(`Volume ${volid || '(none)'} — ${imagePath}`);
  let used = 0;
  for (const f of files) {
    used += f.length;
    const label = formatRt11Name(f.name, f.ext).padEnd(12, ' ');
    console.log(`  ${label} ${String(f.length).padStart(5)}  ${formatDate(f.date)}`);
  }
  const free = DATA_BLOCKS - used;
  console.log(`\n  ${files.length} Files, ${used} Blocks`);
  console.log(`  ${free} Free blocks`);
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function usage() {
  console.log(`Usage:
  node mkrt11.js create <image.dsk> [VOLID]
  node mkrt11.js add    <image.dsk> <file1> [file2 ...]
  node mkrt11.js dir    <image.dsk>
  node mkrt11.js delete <image.dsk> <NAME.EXT> [NAME2.EXT ...]

Examples:
  node mkrt11.js create rk05.dsk
  node mkrt11.js add rk05.dsk SPCINV.SAV README.TXT
  node mkrt11.js dir rk05.dsk
  node mkrt11.js delete rk05.dsk SPCINV.SAV`);
}

const [,, command, ...args] = process.argv;

if (!command || !args.length) {
  usage();
  process.exit(command ? 1 : 0);
}

switch (command) {
  case 'create':
    createImage(args[0], args[1]);
    break;
  case 'add':
    if (args.length < 2) { usage(); process.exit(1); }
    addFiles(args[0], args.slice(1));
    break;
  case 'dir':
    listDir(args[0]);
    break;
  case 'delete':
    if (args.length < 2) { usage(); process.exit(1); }
    deleteFiles(args[0], args.slice(1));
    break;
  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
}
