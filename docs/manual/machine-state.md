## Machine State (STATE button)

The round **STATE** button (top-right corner, immediately left of the
[magic wand](#quick-start)) opens the machine-state dialog — a
full save/restore of the emulated PDP-11, not just the CPU: registers, memory, every I/O device
(console, terminals, printer, disks, tape and the paper-tape reader/punch), the paper in the teletype
and LP11, the video-terminal screen contents (VT52 and VT100 alike) and even the VT11 vector-display
picture are all captured. Think of it as a save file of the whole machine.

![The machine-state dialog](assets/images/manual/dialog-state.png){.shot}

The machine-state dialog with one freshly saved state.{.shot-caption}

- **Save state** — captures the machine exactly as it is right now under an auto-generated name (date and time). The hardware configuration is part of the state: restoring it re-applies the console type, user terminals, printer and VT11 display, restarting the machine to match.
- **Load** — restores the selected state and restarts the machine; a confirmation asks first. States saved by older versions of the emulator keep working, while a state written by a **newer** yaPDP asks first — Update to Latest / Open Anyway / Cancel. The **Load** button has a dropdown with **Load as shared state**, which replays the guided restore a shared-state link shows (screenshot, description, steps) — offered for states that carry such a guide.
- **Export** — a split-button with three options:
  - **Export** (main action) — downloads the selected state as a `.state.zst` binary file.
  - **Save as text file** — encodes the state as a text envelope (`.state.txt`) that can be copied through channels that reject binary attachments.
  - **Copy text to clipboard** — places the text envelope directly on the system clipboard.
- **Import** — a split-button with three options:
  - **Import** (main action) — opens a file picker for `.state.zst`, `.state` or `.state.txt` files from disk.
  - **Import from clipboard** — reads a text envelope from the clipboard and decodes it.
  - **Import from URL** — prompts for a URL, fetches the state file from the network and imports it.
- **Share** — turn a state into a file you can hand to somebody else; the Sharing a state subsection below explains what the file needs to work.
- **Rename / Delete** — organise the list or remove states; the counter next to the list shows how many states you have.

The STATE button is offered on the same pages as [REBOOT](#controls) — the **Panel**, the
**Console** (teletype, VT52 or VT100), **TTY 1**, the **VT11** display and the **Printer** — but it sits
in the top-right corner next to the [magic wand](#quick-start): both are session-level actions that open a
dialog. States are stored in the browser's IndexedDB and survive reloads and sessions.

### Sharing a state

A state is a file of a whole machine, and a link can open it for somebody else. The link form is
`pdp11.html?state=<url>`, where `<url>` is wherever the file lives: a path next to the emulator
(`states/lander.state.zst` — this is how the [Games](#guest-oses) tiles work) or a full `http(s)` URL
on your own host.

**To share your own state:** open the machine-state dialog, pick a state and press **Share**. The
dialog asks for the words the receiver will see — a **Title**, a **Description**, a **Button label**
(for the message they read before they get control), a **Screenshot**, and a **Run after restore**
command that types itself into the guest once the machine is back (e.g. `RUN SPCINV`).

The **Screenshot** field accepts an image pasted from the clipboard (**Ctrl+V**) or selected via a
file picker. A preview is shown once an image is attached; a **Remove** button clears it.

![The Share dialog](assets/images/manual/dialog-share.png){.shot}

The Share dialog: title, description, screenshot, optional post-restore command,
and the **Make state self-contained** option.{.shot-caption}

The **Create Shareable State** button is a split-button with additional options:
- **Copy text to clipboard** — copies the text envelope of the shareable state.
- **Save as text file** — downloads the text envelope as a `.state.txt` file.
- **Share via platform…** — uses the browser's native sharing mechanism (Web Share API).
- **Create GitHub Gist…** — opens a Gist dialog that creates a **secret** Gist on GitHub with the
  machine state. You need a GitHub Personal Access Token with the `gist` scope.

  ![The Gist dialog](assets/images/manual/dialog-gist.png){.shot}

  The Gist dialog: enter your GitHub token and generate a shareable link.{.shot-caption}

  The Gist dialog provides:
  - A **PAT input** field (masked by default) for your token.
  - **Show/hide** toggle (&#9679; / #) to reveal or mask the token.
  - **Clear saved token** button to remove the token from local storage.
  - **Info** button (i) with instructions on creating a PAT.
  - A **Generate** button that posts the state to GitHub and returns a shareable link.
  - The generated link can be **copied**, **tested** in a new tab, or **shared** via the platform.

  Clicking the **info** button (i) opens the **About GitHub Personal Access Token** dialog,
  which explains the security model: the PAT is used only to create a Gist via the GitHub
  API, is never sent anywhere else, and is stored in obfuscated form in localStorage. It
  also provides step-by-step instructions for creating a PAT with the `gist` scope.

  ![The About PAT dialog](assets/images/manual/dialog-gist-about-pat.png){.shot}

  The About PAT dialog: security policy and PAT creation instructions.{.shot-caption}

A **Cancel** button is placed separately from the action buttons.

A **Make state self-contained** checkbox makes the file portable: a normal share
references this build's published images by version and identity, while a
self-contained share carries the disk images inside the file, so it restores on
a machine that has none of them. It is larger by the size of those images, and
a bundled image whose bytes cannot be read fails the export instead of
promising portability it cannot keep.

**Portability does not automatically carry over to a new snapshot.** If you
restore a self-contained state, continue working and then save a new state, the
new snapshot does not automatically inherit the embedded disk images from the
state you restored. It may keep only a reference to the mounted base image and
its disk overlay. If that was a custom image that is not available after a
reset or storage cleanup, the snapshot cannot be restored from a different
image with the same filename: the content identity must match. To share the new
state independently of the original environment, create a self-contained share
of it as well.

Host that file anywhere reachable by a URL, then send the link. Two things decide whether it works:

- **The host must allow the file to be read from another site** (the `Access-Control-Allow-Origin`
  header). A browser refuses to let this page read a file on another host that does not say so, and
  the visitor then sees a "Shared state not restored" message naming the URL. Static hosts often do
  not send that header by default. The surest way to avoid the problem is to keep the file **next to
  the emulator** — on the same site — exactly as the states under `states/` are served.
- **The receiver needs the same disk images — or the state must carry them.** Every image is
  identified by the SHA-256 digest of its decompressed bytes, and a state may pin the exact published
  version it was taken on. If the image differs from the one the state was taken on, the restore is
  **refused** rather than half-applied: a machine with new memory and an old disk is worse than no
  restore at all. A **self-contained** state needs nothing from the receiver, because the images
  travel inside the file.

On restore the emulator fetches a pinned version from the media registry when the image is not loaded
yet, verifies its digest, and only then touches the machine. Bytes this machine already has are used
first, even when they are loaded under another name — the digest decides, not the file name. A plain
**Export** bundles what it can: an image whose bytes are no longer loaded stays an external reference,
and a toast warns that the exported state still depends on it.

A disk you dropped in yourself has no published version to fetch back, so a state taken on it restores
only in this browser, and saving such a state says so in a toast. If a restore is refused because of
such a disk, the dialog offers **Use my own copy of this disk…**: pick the file, and the emulator
accepts it only if its digest is the one the state was saved with — a disk with the right contents
works under any name, and a different disk changes nothing. The other two actions are **Keep it**
(leave the state alone) and **Delete this state**. The **Technical details** section holds the full
digests, with **Copy details** for a bug report.

When either condition fails the visitor is told in a dialog that names the URL, and the address bar
keeps the `?state=` parameter so what was asked for stays visible. If a link cannot work at all — the
state lives somewhere that cannot be fetched — the file itself is still the fallback: **Import** takes
any `.state`, `.state.zst` or `.state.txt` file from disk, with no server and no CORS involved.

### Embedding the emulator

The emulator can be embedded into any HTML page as an `<iframe>`. This
makes it suitable for museum exhibits, educational websites, and online
articles — visitors interact with a live PDP-11 without leaving your
site.

**Basic OS boot**

```html
<iframe src="https://amesk.github.io/yaPDP/pdp11.html?boot=rk1"
        width="1024" height="768"
        allow="clipboard-read; clipboard-write"
        title="yaPDP PDP-11/70 Emulator">
</iframe>
```

The `?boot=` parameter starts the quick-boot wizard for the specified
disk. The wizard types the boot command and, where credentials are
known, the login — the visitor sees a running operating system
immediately.

**Loading a machine state**

```html
<iframe src="https://amesk.github.io/yaPDP/pdp11.html?state=states/lunar-lander.state.zst"
        width="1024" height="768"
        allow="clipboard-read; clipboard-write"
        title="yaPDP PDP-11/70 Emulator">
</iframe>
```

The `?state=` parameter loads a saved machine state. The state file must
be reachable from the browser — see the CORS discussion above.

**Using a GitHub Gist to bypass CORS**

If you cannot place the state file on the same host as the emulator, the
GitHub Gist workflow (see [Sharing a state](#sharing-a-state)) solves
the CORS problem: GitHub serves Gist raw files with the correct
`Access-Control-Allow-Origin` header. The link generated by the **Create
GitHub Gist** dialog works directly in an iframe:

```html
<iframe src="https://amesk.github.io/yaPDP/pdp11.html?state=https://gist.githubusercontent.com/.../raw/.../demo.state.txt"
        width="1024" height="768"
        allow="clipboard-read; clipboard-write"
        title="yaPDP PDP-11/70 Emulator">
</iframe>
```

**Guided restore for museum exhibits**

When you create a shareable state, the **Title**, **Description**,
**Screenshot** and **Run after restore** fields (see [Sharing a
state](#sharing-a-state) above) let you prepare a self-contained
exhibit. The visitor sees a welcome message with your description and a
screenshot before the machine starts; after they click the button, the
emulator boots and types the post-restore command automatically. No
server configuration, no disk hunting — the state carries everything
except the disk images, which are bundled with the emulator.

**Recommendations for museums and educators**

- Use `?boot=` for a quick OS demonstration — no state file needed.
- Use `?state=` with a GitHub Gist for a curated exhibit that survives
  hosting changes.
- Set `allow="clipboard-read; clipboard-write"` on the iframe so the
  emulator's clipboard features (Import from clipboard, Copy text to
  clipboard) work inside the embedded page.
- The emulator is responsive: on narrow viewports it adapts to a
  mobile-friendly layout automatically.

### Configuration and the state

A state carries its own hardware configuration, and restoring it applies that profile — console type,
user terminals, LP11 printer, VT11 display, widths, teletype speed, zoom, glow, phosphor and backdrop.
There is one exception: the two sound settings (**Mute** and the machine hum) are never touched,
because they belong to the person at the keyboard, not to the guest. A page reload happens only when
the **device set** differs; everything else applies live.

A state opened from a `?state=` link asks nothing — the state is the point of the link. Your own
configuration is remembered before it is replaced, and after a reload (or in the **Reboot** /
**Bootstrap now!** dialog) you are offered **Return my configuration**, which restores every field.
Returning it reloads only when the device set differs, and a Reboot parked across that reload runs as
soon as the page is back.
