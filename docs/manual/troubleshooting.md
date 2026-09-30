## Troubleshooting

### An image cannot be loaded

If a guest OS image cannot be fetched completely — a big BSD image dropped by the hosting server
mid-download, or an image that is not bundled in the Minimal desktop build — the emulator doesn't stall
silently. A dialog in the same shared modal style as the [first-run hint](#quick-start)
explains that the image is
incomplete and offers **Open Storage**, which jumps straight to the drop
zone for a manual
drag & drop of the downloaded file.

The wording adapts to the environment: a page opened as a local `file://` explains that the
browser blocks fetching the media directory (and suggests a local web server), while the Tauri Minimal
build explains that the image is not shipped and points to the drop zone.

![Image load failure dialog](assets/images/manual/dialog-imgerror.png){.shot}

An incomplete image triggers this dialog with an [Open Storage](#storage) shortcut.{.shot-caption}

### A snapshot is refused after an image update

A snapshot stores the machine's memory and registers, not the disk image itself:
on restore it is layered back onto whatever disk the emulator currently ships.
If that disk has been **updated** since the snapshot was taken, the two no longer
match — the guest's file system in memory would not describe the disk underneath
it, which shows up as a corrupted file system rather than as anything obvious.

The emulator detects this and refuses the restore instead of corrupting the
disk. It names the image and both builds, and offers to delete the snapshot:

![Snapshot taken on a different build](assets/images/manual/dialog-snapshot-incompatible.png){.shot}

The snapshot was taken on a different build of the disk: it is not restored, and
can be deleted from here.{.shot-caption}

Take a fresh snapshot on the current build, or delete the stale one — a snapshot
cannot be migrated onto a disk it was not taken from.
