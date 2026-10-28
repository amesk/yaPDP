# Service mode (museum maintenance)

yaPDP keeps what a museum operator does with the machine: a saved
configuration, imported disk and tape images, saved machine states and the
write-back "disk overlays" of the guest's own changes. Bringing an exhibit back
to the state it was delivered in is therefore **destructive**, and it is
deliberately absent from the ordinary interface: no sidebar page, no button,
no menu entry offers it.

The service screen is a full-window overlay inside `pdp11.html`
([`src/maintenance.js`](../src/maintenance.js), [`css/maintenance.css`](../css/maintenance.css)).
It has exactly two actions:

- **System reset…** — stop the machine, wipe the persisted machine state, reload.
- **Close** — leave without touching anything.

## Entering service mode

Three entries, all of them landing in the same screen:

| Entry                                                                                                                                                | When to use                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pdp11.html?maintenance=1`                                                                                                                           | Web/kiosk launch configuration, or a shortcut. Any other query parameters (`?boot=`, `?state=`, `?code=`) are preserved.                            |
| **5 clicks within 2 seconds** on the version marker (`v0.4.0` under the `yaPDP` name in the bottom-left corner, or the version row of the Info page) | A kiosk has no address bar, so this is the on-glass way in. One click still opens the Info page as before.                                          |
| `yaPDP.exe --maintenance` (desktop build)                                                                                                            | The cleanest museum path: one process, one window, no web server, no origin questions. The Rust command `startup_flags` hands the flag to the page. |

The gesture is armed on the version string, which a mobile layout hides with
the whole sidebar marker (`@media (max-width: 768px)` in `css/pdp11.css`); on a
tablet it therefore works from the **Info** page, where the same string is
shown in the About table. An empty version string (a trimmed build) arms the
whole marker instead, so the way in never disappears silently.

## What System Reset does

The confirmation dialog describes exactly what will happen, and its text is
generated from the same registry the reset walks — the warning and the action
cannot drift apart.

| Step        | What it erases                                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diskstore` | The disk overlays: every block the guest OS wrote (files created, disks repartitioned). Goes **first**, because the page flushes pending blocks while unloading.       |
| `states`    | Every machine state saved in this browser (`yapdp-snapshots`).                                                                                                         |
| `images`    | Every disk/tape image imported by drag & drop (`yapdp-images`), plus their in-memory mounts. Bundled media is not stored and is streamed again on the next boot.       |
| `mounts`    | The drive binding table (`yapdp.mountmap.v1`): which image each drive holds.                                                                                           |
| `boot`      | The last boot device (`yapdp.lastboot`), which could point at an image that no longer exists.                                                                          |
| `viewer`    | The configuration baseline captured from a state (`yapdp.origconfig.v1`).                                                                                              |
| `config`    | The user configuration: every setting, down to the last checkbox, returns to its factory default.                                                                      |
| `keys`      | Pending restores and reload markers (snapshot/state/boot pending keys, share metadata, the pause flag) and the first-run hint, so the exhibit introduces itself again. |

**Kept on purpose:** the GitHub personal access token used by the Share
dialog (`yapdp.github-pat`). A factory reset restores the exhibit; it does not
log the operator out.

**Not touched:** the core stack and the device modules. The reset ends with a
page reload, which rebuilds the CPU, RAM, every device, the terminals, printer,
punched tape and the panel from scratch — a per-device `reset()` would be dead
code. Only state that survives a reload is on the list above.

### Why the stores are cleared through their own modules

The service screen runs inside the emulator page, which already holds open
IndexedDB connections to the three stores. `indexedDB.deleteDatabase()` would
sit in `blocked` until those connections close — i.e. never, while the page
lives. Each store therefore exposes a clear method that runs in a transaction
on the connection the page already has: `DiskStore.clearAll()`,
`SnapshotStore.removeAll()` and `dragdrop`'s `clearAll()` (reached through
`window.yapdpExportList`).

### After the reset

The page reloads with `?maintenance=1` still in the URL, so the operator sees
the result ("System reset complete") and leaves deliberately with **Close**.
Close strips `maintenance` and returns to the exhibit URL with every other
parameter intact.

## Museum kiosk notes

- **The origin is the storage identity.** `http://127.0.0.1:1170`,
  `http://localhost:1170` and any other port are three different IndexedDB /
  localStorage namespaces. Pin scheme, host and port in the kiosk shortcut, or
  a reset will clean a store the exhibit does not use.
- **A static server is enough**, but it must honour Range requests (the loader
  fetches byte ranges): `node tools/serve.js` (`npm run serve`), nginx or IIS
  do; `python -m http.server` does not. Never serve `.zst` with
  `Content-Encoding: zstd` — the page decompresses those bytes itself.
- **Two windows are the only complication.** While another window of the same
  profile keeps the emulator loaded, the stores cannot be cleared and the
  screen reports which step was blocked. Close the exhibit window and press
  System reset again; nothing is half-done silently.
- **Desktop app:** launch the exhibit normally, and use a second shortcut with
  `--maintenance` when service is needed. With `cargo tauri dev`, the flag goes
  after `--`.

## Extending the service screen

Add a step to `resetSteps()` in [`src/maintenance.js`](../src/maintenance.js):

```js
{ id: "media-cache", label: "Erase the re-downloaded media cache",
  run: () => Something.clear() }
```

The label is rendered in the service card **and** in the confirmation dialog,
so the new operation is described to the operator automatically. If the
feature also persists something new in `localStorage`/`sessionStorage`, add the
key to `LOCAL_KEYS`/`SESSION_KEYS` (or to a module that owns a reset step):
`tests/maintenance-reset.test.js` scans `src/` for every storage key and fails
when one is neither reset here nor explicitly kept.

## Where this is documented

This file, the "Service mode (museum maintenance)" section of
[FEATURES.md](FEATURES.md), the documentation index in the README and the
CHANGELOG entry. The user manual (`docs/manual/`) deliberately does **not**
cover the service mode: that manual is the user-facing guide, and the entry
gesture is not something to advertise on the shop window.

## Tests

- `node tests/maintenance-reset.test.js` — gesture, registry order, failure and
  timeout behaviour, key cleanup, the storage-surface drift guard and the
  markup the engine addresses.
- `node tests/e2e-maintenance.js` (or `npm run e2e:maintenance`) — entry by
  parameter, Cancel focus, Esc, the reset itself, Close, and the kiosk gesture
  in a real browser. Seeded images/states/overlays live in a throwaway
  puppeteer profile.
