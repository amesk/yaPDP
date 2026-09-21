# yaPDP Media

Some of the emulator media images in the media folder are in compressed format (ZST) to keep github file sizes below limits.

Files of type .dsk are disk images, .tap are magnetic tape images, and .ptap are paper tape images.

File names for disk and tape images start with two character names matching the devices they attach to. For example rk is is used for the RK05 disk drives with rk1.dsk attaching to RK05 disk drive unit 1. Similarly rp4.dsk would attach to unit 4 of the RP04/RP06 disk controller.

```
.DSK  disk images
.TAP  magnetic tape images
.PTAP paper tape images
```

The emulator main page lists what PDP 11 operating system is loaded on each of the available media files.

## Building a magnetic tape

A magnetic tape can be built out of ordinary files and read back, in either of the two archive layouts a PDP-11 Unix guest expects:

```
npm run tape:pack   -- out.tap a.c b.c            Unix V5 tp: up to 12 files, names up to 32 characters
npm run tape:pack   -- out.tap a.c b.c --format tar    v7 tar stream instead
npm run tape:unpack -- out.tap                    the files come out next to the tape
node tools/tape-archive.js list out.tap           print the contents, write nothing
```

The image is a SIMH .tap: every record is [length][data][length] with a zero length as the tape mark, which is what the emulated TM11 walks both ways, and each block goes on the tape as its own 512-byte record. The payload is either the tp directory in block 0 (twelve 40-byte entries: name, mode, size in bytes, first block) or a v7 tar stream (512-byte headers, no magic, two zero blocks at the end). unpack and list work out which one they are looking at by themselves. Mount the result as tm0.tap.


