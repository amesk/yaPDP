## Machine State (STATE button)

The round **STATE** button (top-left corner, right of [REBOOT](#controls)) opens the
machine-state dialog — a
full save/restore of the emulated PDP-11, not just the CPU: registers, memory, every I/O device
(console, terminals, printer, disks, tape and the paper-tape reader/punch), the paper in the teletype
and LP11, the video-terminal screen contents (VT52 and VT100 alike) and even the VT11 vector-display
picture are all captured. Think of it as a save file of the whole machine.

![The machine-state dialog](assets/images/manual/dialog-state.png){.shot}

The machine-state dialog with one freshly saved state.{.shot-caption}

- **Save state** — captures the machine exactly as it is right now under an auto-generated name (date and time). The hardware configuration is part of the state: restoring it re-applies the console type, user terminals, printer and VT11 display, restarting the machine to match.
- **Load** — restores the selected state and restarts the machine; a confirmation asks first. States saved by older versions of the emulator keep working. The **Load** button has a dropdown with **Load as shared state** for loading a `.state.txt` envelope file.
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

The STATE button mirrors [REBOOT](#controls) and is available on the **Panel**, **Console** (teletype, VT52 or
VT100) and **TTY** pages. States are stored in the browser's IndexedDB and survive reloads and
sessions.

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

The Share dialog: give the state a title, a description, a screenshot and optional post-restore command.{.shot-caption}

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

A **Cancel** button is placed separately from the action buttons.

Host that file anywhere reachable by a URL, then send the link. Two things decide whether it works:

- **The host must allow the file to be read from another site** (the `Access-Control-Allow-Origin`
  header). A browser refuses to let this page read a file on another host that does not say so, and
  the visitor then sees a "Shared state not restored" message naming the URL. Static hosts often do
  not send that header by default. The surest way to avoid the problem is to keep the file **next to
  the emulator** — on the same site — exactly as the states under `states/` are served.
- **The receiver needs the same disk images.** A state does not carry its images, only a record of
  which ones it needs and their fingerprints. If the image differs from the one the state was taken
  on, the restore is **refused** rather than half-applied: a machine with new memory and an old disk
  is worse than no restore at all.

When either condition fails the visitor is told in a dialog that names the URL, and the address bar
keeps the `?state=` parameter so what was asked for stays visible. If a link cannot work at all — the
state lives somewhere that cannot be fetched — the file itself is still the fallback: **Import** it
takes any `.state` or `.state.zst` file from disk, with no server and no CORS involved.

### Configuration restore dialog

When a saved state carries its own hardware configuration (console type, terminals, printer, VT11
display), restoring it asks whether you want to **Reset** your configuration to the state's own, or
**Keep** your current settings. This dialog appears automatically after a state restore or before a
reboot that would apply a state's configuration.
