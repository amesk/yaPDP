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
- **Load** — restores the selected state and restarts the machine; a confirmation asks first. States saved by older versions of the emulator keep working.
- **Export / Import** — take a state out as a `.state` file, or bring one in from a file somebody sent you. An imported file joins the list like any other state.
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
command that types itself into the guest once the machine is back (e.g. `RUN SPCINV`). **Create
Shareable State** then saves a `.state.zst` file to your computer.

![The Share dialog](assets/images/manual/dialog-share.png){.shot}

The Share dialog: give the state a title, a description and the keys the receiver needs.{.shot-caption}

Host that file anywhere reachable by a URL, then send the link. Two things decide whether it works:

- **The host must allow the file to be read from another site** (the `Access-Control-Allow-Origin`
  header). A browser refuses to let this page read a file on another host that does not say so, and
  the visitor then sees a “Shared state not restored” message naming the URL. Static hosts often do
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
