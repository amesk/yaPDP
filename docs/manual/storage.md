## Storage (paper tape, disk & tape images)

The Storage page manages every kind of storage media. It has two tabs — **Images** and
**Paper Tapes** — because the two workflows are completely different. An image is a whole device
mounted into the machine and remembered between sessions; a paper tape is a stream of bytes that the
reader walks through from the first frame to the end.

![The Storage page — Images tab](assets/images/manual/storage.png)

The Storage page, Images tab: the drop zone, mounted images, disk export and
persistent disk changes.

**Images tab:**

- Drop image. Drop a disk or tape image here —.dsk,.tap,.ptap and their.zst -compressed forms are supported. While the Storage page is active you can also drop a file anywhere over the window: a full-window drop target appears. A.zst file is a zstd frame and the browser unwraps it on the fly, so a downloaded image needs no unpacking first.
- The file name is the device name. An image is mounted under the device URL taken from the file itself: RP1.DSK.ZST becomes rp1.dsk, which is why the guest boots it with boot rp1. Rename the file to the unit you want to use — the table below maps every device to its drive, its controller and its boot command.
- Mounted images / Unmount. Lists the images mounted in this browser and lets you unmount one again. The counter next to it counts the images you mounted (dropped or imported), not the ones the desktop build carries inside itself. Mounted images live in browser storage (IndexedDB) and are re-mounted automatically on the next launch.
- Export disk. Downloads a mounted disk image to your machine.
- Persistent disk changes. Guest-OS writes are saved to browser storage and overlaid on the base image on the next launch, so files an operating system created are still there tomorrow. Only the blocks the guest actually wrote are kept — the base image is fetched again on every launch — and a saved block always wins over the pristine one. They are written out periodically and when you leave the page, and they belong to one image: Reset image discards them for the selected disk, Reset all for every disk, which returns the media to its factory state.

**Which file is which device:**

| Image | Drive | Controller | Boot it with |
|---|---|---|---|
| rk0 … rk5 | RK05 disk cartridge | RK11 | boot rkN |
| rl0 … rl3 | RL01 / RL02 cartridge | RL11 | boot rlN |
| rp0 … rp4 | RP04 / RP06 disk pack | RP11 | boot rpN |
| ra0 … ra2 | RA80 / RA81 (MSCP) | UDA50 | boot raN |
| tm0 … tm2 | 9-track magnetic tape | TM11 | boot tmN (RSTS restores with ROLLIN) |
| *.ptap | Paper tape reader / punch | PTR11 | boot pr |

![The Storage page — Paper Tapes tab](assets/images/manual/storage-tapes.png)

The Storage page, Paper Tapes tab: the reader file selector, a `.ptap`
drop zone and the punch-tape export.

**Paper Tapes tab:**

- Paper tape reader file. A selector for the reader (#ptr) holding the tapes this build ships — BASIC-11 V007A, ODT-11X-V004A, ED-11-V004B, Lunar Lander and the bootstrap loader — plus any.ptap you dropped. Load one and boot it with BOOT PR.
- Rewind tape and the tape state. The indicator beside the button says whether a tape is loaded and how far the reader has moved through it; Rewind tape puts it back to the first frame, which is what a guest does when it restarts a read.
- Drop paper tape. A small drop zone accepting.ptap and.ptap.zst — dropped tapes are added to the reader file selector.
- Export paper tape. The punch buffer is filled by the bytes the console echoes, and the counter shows how much is on the tape. Download saves it as a.ptap; Clear empties the buffer for the next tape.

*Note:* the paper-tape reader is driven by the console bytes — every byte echoed to the console
punches a matching row of holes on the ASR paper tape.
