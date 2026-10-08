# The `.state` format

A machine state is one file — `*.state.zst` — that holds everything needed to
put an emulated PDP-11 back where it was: CPU registers, RAM, every device
register, the terminal screens, the paper in the teletype, and the disk
write-back overlay. The format is defined once, in
[`src/state-format.js`](../src/state-format.js), and shared by every reader
and writer: the browser snapshot store ([`src/snapshots.js`](../src/snapshots.js)),
the deep-link loader (`?state=`), and the Node tools
([`tools/export-state.js`](../tools/export-state.js),
[`tools/headless-term.js`](../tools/headless-term.js),
[`tools/restore-state.js`](../tools/restore-state.js),
[`tools/state-manifest.js`](../tools/state-manifest.js)).

## The container

The bytes under the compression frame are a small binary container:

```
[8 bytes]  magic "YAPDPSTA"
[4 bytes]  manifest length, little-endian
[manifest] UTF-8 JSON — version, device, profile, CPU, devices, overlays, …
[memory]   raw bytes, little-endian words, exactly CPU.memory's size
```

Memory is the bulk of a state and travels as **raw bytes** (not a JSON array
of words), because the PDP-11 is little-endian exactly like the disk images.
The manifest stays **JSON**: it is small, human-readable, and grows new fields
as devices are added — which is what JSON is good at. `memory` is simply
"everything after the manifest"; there is no offset/length pair in the
manifest, because it would be redundant and could drift.

### The frame

The container is wrapped in a compression frame, decided by
[`src/state-frame.js`](../src/state-frame.js) from what the *writer* had:

| Frame  | Writer | How it is read |
|--------|--------|----------------|
| `zstd` | the Node tools, the repo's own `states/` | `fzstd` (browser) / `zlib.zstdDecompressSync` (Node) |
| `gzip` | the browser export (`CompressionStream`) | `DecompressionStream` / `zlib.gunzipSync` |
| none   | a writer with no compressor at all | read as a bare container |

Every reader accepts all three; the frame says nothing about *what* is inside,
so a decoded frame must still pass `StateFormat.isContainer()`.

## Three versions

Two different versions travel with a state, plus the app version:

| Field | Kind | Describes |
|-------|------|-----------|
| `CONTAINER_VERSION` (in code) | number | the **byte layout** — magic, manifest length, what follows the manifest. Changes only with the layout. `1` today. |
| `schemaVersion` (in the manifest) | semver string | the **shape of the manifest JSON**. See the rules below. |
| `yaPDPVersion` (in the manifest) | semver string | the **application** that wrote the state — the source of the "newer snapshot" warning. |

They answer different questions and must not be conflated: a new manifest field
is a `schemaVersion` MINOR and leaves `CONTAINER_VERSION` alone; a second
binary segment after the memory is a `CONTAINER_VERSION` bump.

Legacy states wrote `schemaVersion` as a **bare number** (`1`). Readers normalise
it with `StateFormat.normalizeSchemaVersion()` — `1` reads as `"1.0.0"`, a number
`n` as `"n.0.0"`, an absent field as the current base schema. Writers always
write the semver **string**. `StateFormat.schemaMajor(manifest)` returns the
MAJOR readers branch on.

### `schemaVersion` evolution rules

* **MAJOR** (`1.0.0 → 2.0.0`) — a breaking change (e.g. a JSON overlay becoming
  binary). A reader that does not understand it **cannot** read the state: it is
  refused (`unsupported-version`), never half-applied. Readers switch on MAJOR.
* **MINOR** (`1.0.0 → 1.1.0`) — new fields. An older reader ignores unknown
  fields (JSON) and still reads the state.
* **PATCH** (`1.1.0 → 1.1.1`) — corrections with no structural change.

## The newer-snapshot warning (the "red flag")

`yaPDPVersion` is informational but drives one rule. When a state is restored
or imported and its `yaPDPVersion` is **newer** than the running build — a
higher MAJOR, or the same MAJOR and a higher MINOR — the snapshot may carry
fields this build does not know, so the operator is warned before the machine
is touched:

> ⚠️ **Snapshot Compatibility Warning** — this snapshot was created with yaPDP
> X.Y.Z, but you are using A.B.C. Restoring may work incorrectly or lose data.
> We recommend updating to the latest version: https://amesk.github.io/yaPDP
> **[Update to Latest] [Open Anyway] [Cancel]**

* **Update to Latest** opens the project site in a new tab; the dialog stays.
* **Open Anyway** proceeds with the restore/import.
* **Cancel** backs out (the import is aborted with reason `cancelled`).

A state with **no** `yaPDPVersion`, or one that cannot be parsed, is treated as
**compatible** — a value that was never written (or that this build cannot judge)
contradicts nothing. A newer **PATCH** never warns. Headless callers (no DOM)
proceed silently: there is nobody to ask.

The rule lives in `StateFormat.checkVersionCompatibility(manifest,
currentVersion)`; the running version is `window.YAPDP_VERSION` in the browser
(set from `package.json` by `npm run version:sync`) and is passed in by the Node
tools, so the format module stays platform-free.

## Future evolution: non-memory segments and named blobs

The memory section is "everything after the manifest" because there is exactly
one binary segment today. When a **second** binary segment is needed (a binary
disk overlay instead of JSON blocks, large tapes), the container moves to
`CONTAINER_VERSION 2` and the segments get an explicit descriptor. The choice
of form — a flat list of sections or a named-blob registry with
`{ offset, length }` — is deliberately **deferred** until that need is concrete:
an offset/length pair for a single segment would be redundant and could drift,
and no current state needs deduplication or lazy reading of its blobs.

So: `memory.offset`/`memory.length` are **not** written today, and there is no
blob registry. The rule is recorded here and at `CONTAINER_VERSION` in
[`src/state-format.js`](../src/state-format.js) so the next change starts from a
known point.
