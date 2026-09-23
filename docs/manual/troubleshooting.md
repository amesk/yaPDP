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
