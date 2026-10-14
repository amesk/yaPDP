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

### The guest OS does not boot

If the machine halts at the `@` prompt or shows an error instead of booting:

- **Wrong boot command.** Each guest OS has its own boot command — see the [Guest OS table](#guest-oses) for the correct one. Typing `boot rk0` on a system that expects `boot rp1` will not start it.
- **Wrong machine profile.** Some guests need the [LP11 line printer](#printer) or a teletype console. The [quick-boot wizard](#quick-start) sets these automatically; when booting manually, check the [Config page](#config) for the required peripherals.
- **Corrupted or missing image.** If the image did not download fully, the emulator shows an [image load failure](#an-image-cannot-be-loaded) dialog. Re-download or drag & drop the image file onto the **Storage** page.

### The keyboard does not type

If keystrokes produce no visible output on the console or terminal:

- **Wrong keyboard layout** The most obvious reason. Just switch to English.
- **Input is locked.** During an [autoload](#quick-start) the emulator locks all input. Click **Take control!** in the toast to unlock.
- **Wrong terminal selected.** Click the console or terminal page in the sidebar — the active page has a highlighted border. Only the active page receives keyboard input.
- **Teletype upper-case only.** When the **Upper Case Only** [CONFIG](#config) option is on, the teletype folds lower-case letters to upper-case. This is normal for guests that expect upper-case input.
- **Browser focus.** Click inside the terminal area to ensure the page has focus. Some browsers require an explicit click before they forward keystrokes.

### No sound

If the emulator is silent:

- **Mute is on.** Click the **Mute** button (bottom-left corner, just right of the sidebar) to toggle sound back on. The mute state is persisted across sessions.
- **Browser sound.** Check that your browser's sound is not muted for the page or tab.
- **Desktop build.** The Tauri desktop app uses the same sound settings as the browser version. Check the system volume mixer for the application.

### Poor performance

If the emulator feels sluggish:

- **Browser vs desktop.** The browser version shares resources with other tabs. Close unused tabs or switch to the [Tauri desktop app](#desktop) for dedicated performance.
- **Video terminals.** A VT100 or VT52 terminal with scanline effects uses more CPU than the teletype. Switch to the teletype console in [Config](#config) if performance is critical.
- **Animation.** The LP11 line printer and paper-tape machines animate during operation. Disable them in [Config](#config) if they are not needed.
- **Network.** Large disk images load over the network on first access. The **Loading N%** bar shows progress; once cached, subsequent boots are faster.

### The screen is blank

If a terminal page shows nothing:

- **Machine is off.** Check the front-panel POWER LOCK switch. The machine must be powered on to produce output.
- **Wrong page.** The console and terminals show output only when the guest OS writes to them. Switch to the [Console](#console) page to see the boot sequence.
- **Display page not configured.** The [VT11 vector display](#vt11) is optional and must be enabled in [Config](#config). Without it, the Display page stays blank.
- **Browser zoom.** Accidental browser zoom can push the terminal content off-screen. Reset zoom with Ctrl+0 (Cmd+0 on macOS).

### CORS errors in the browser version

If the emulator page shows a CORS error when loading images or media:

- **file:// protocol.** Opening `pdp11.html` as a local file (`file://`) triggers browser CORS policies. Use a local web server instead — or open the page through the **Launch Online!** link on the [landing page](index.html).
- **The built-in server.** Run `npm run serve` from the repository root to start a local HTTP server on port 1187, then open `http://127.0.0.1:1187/pdp11.html`.
- **Tauri desktop.** The [desktop app](#desktop) has no CORS restrictions — it bundles its own server.
