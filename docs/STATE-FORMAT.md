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

The bytes under the compression frame are a small binary container. The first
canonical format uses the established eight-byte magic `YAPDPSTA`; the manifest
discriminator selects between the legacy representation and the current blob
representation.

```
[8 bytes]  magic "YAPDPSTA"
[4 bytes]  manifest length, little-endian
[manifest] UTF-8 JSON
[payload]  catalogued binary blobs, with offsets relative to this region
```

The manifest remains JSON. It carries the machine configuration and a
`blobCatalog` whose entries identify each binary resource by `id`, `mediaType`,
`offset`, `size`, and SHA-256 digest. RAM, disk overlays, and embedded media
are all represented as blobs; identical payloads may share the same physical
range. Blob ranges and hashes are validated before a parsed state is exposed.

Legacy `YAPDPSTA` states without `containerVersion` and `blobCatalog` keep their
original layout: every byte after the manifest is RAM. The current format sets
`containerVersion: 1` and includes `blobCatalog`. The unpublished development
format `YAPDPST2` / `containerVersion: 2` is accepted only as a migration input;
new writes never produce it.

Memory is stored as raw little-endian bytes rather than a JSON array of words.
The manifest stays JSON because it is small, human-readable, and grows new
fields as devices are added.

That growth is additive by contract: a device may add an optional field, and a
reader that does not know it must ignore it rather than reject the state. The
LP11 paper copy uses this twice — `lp11BufferRuns` and `lp11LineRuns` carry the
bold/underline style runs of the printed job (empty or absent in states written
before they existed, which the printer then treats as plain text).

## Three versions

The versions answer different questions and must not be conflated:

| Field                                | Kind          | Describes                                                                          |
| ------------------------------------ | ------------- | ---------------------------------------------------------------------------------- |
| `containerVersion` (in the manifest) | number        | the binary payload layout. The first canonical blob layout is `1`.                 |
| `schemaVersion` (in the manifest)    | semver string | the shape of the manifest JSON.                                                    |
| `yaPDPVersion` (in the manifest)     | semver string | the application that wrote the state and the source of the newer-snapshot warning. |

The canonical blob representation is version 1, even though a different
intermediate representation was explored during development. Version numbers
describe released contracts, not the count of prototypes.

### `schemaVersion` evolution rules

* **MAJOR** (`1.0.0 → 2.0.0`) — a breaking change to the manifest schema. A reader
  that does not understand it must refuse the state rather than half-apply it.
* **MINOR** (`1.0.0 → 1.1.0`) — additive fields that older readers may ignore.
* **PATCH** (`1.1.0 → 1.1.1`) — corrections with no structural change.

Legacy states may contain a numeric `schemaVersion` (`1`). Readers normalise it
with `StateFormat.normalizeSchemaVersion()`; writers use a semver string.
`StateFormat.schemaMajor(manifest)` returns the major version.

## The newer-snapshot warning

`yaPDPVersion` is informational but drives one rule. When a state was written
by a newer application (higher MAJOR, or same MAJOR and higher MINOR), the
operator is warned before the machine is touched. A newer PATCH never warns.
Missing or unparsable versions are treated as compatible. Headless callers
proceed silently because there is nobody to ask.

The rule lives in `StateFormat.checkVersionCompatibility(manifest,
currentVersion)`.

## Migrating existing states

The one-time migration utility accepts legacy `YAPDPSTA` states and the
unreleased `YAPDPST2` development prototype. It scans `states/` recursively
when no files are supplied and performs a dry run unless `--write` is passed:

```sh
node tools/convert-state-format.js
node tools/convert-state-format.js --write
node tools/convert-state-format.js --write states/example.state.zst
```

Before replacing a file, the tool converts it, validates the container, checks
the manifest, RAM and extra blobs, and verifies that the output uses canonical
container version 1. It also migrates legacy 8-digit FNV-1a image fingerprints in snapshot metadata and disk overlays to SHA-256 of the decompressed image payload. The old fingerprint must match the exact local compressed image bytes (`media/<image>.zst`) before replacement; if the image is unavailable or differs, the converter refuses to rewrite that state. It writes a temporary file first and only replaces the
original after validation. Keep a normal repository backup/commit before using
`--write`; the migration should be reviewed and committed separately from the
code change.

## Images: identity, versions and embedded bytes

A state never stores a disk image under its logical name alone. Three manifest
fields describe what the state needs and how the bytes can be obtained:

| Field               | Meaning                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mounted`           | the image urls the machine had mounted when the state was saved                                                                                                                                 |
| `imageFingerprints` | url → SHA-256 of the **decompressed** image bytes at capture time. The short legacy FNV-1a/32 value is still accepted where a state carries one                                                 |
| `imageVersions`     | url → `{ version, sha256 }` — the exact published version the state was taken on, resolved through `media-versioned` in `media/manifest.json` (rules in [image-registry.md](image-registry.md)) |
| `embeddedImages`    | url → blob id. The image bytes travel **inside this container** and take precedence over `imageVersions`                                                                                        |

Restore is a preflight, not a best effort. Before CPU or RAM is touched, every
needed image is loaded (from its pinned version when `imageVersions` names one)
or mounted from `embeddedImages`, and its identity is compared with
`imageFingerprints`. A mismatch refuses the state with a dialog; an unknown
current identity — a host that cannot expose the bytes — does not invalidate
anything.

### Self-contained states

The Share dialog's **Make state self-contained** option embeds every mounted
image, including published ones, and folds each disk's write-back overlay into
its embedded base. Such a state does not depend on the media registry or on the
images this build ships: it restores on any host that can read the file.

A plain export and a compact share embed only what is not already published —
published media stays referenced by its version — and treat an unobtainable
image as a warning: the resource stays an external reference and the operator
sees a toast. A self-contained share is strict instead, because it promises
portability: a resource whose bytes cannot be obtained fails the export.

**Self-containment is not inherited by later snapshots.** Restoring a
self-contained state makes its embedded images available to that restore; it
does not make every subsequently saved state self-contained. A new snapshot may
refer to the mounted image by identity and retain only its disk overlay. If the
base image is a custom image that is not published in the media registry, the
new snapshot will depend on that image remaining available separately. After a
reset or storage cleanup, an image with the same logical name but different
bytes cannot replace it: the SHA-256 check correctly refuses the restore. To
preserve portability, create a new self-contained share of the resulting state.

The container size ceiling is 256 MB (state plus bundled resources), so a
self-contained share of a large disk set is refused rather than truncated.

## Text envelope for GitHub Gist

A `.state.zst` file can be wrapped in a text envelope for sharing via
GitHub Gist (or any text pastebin). The format is:

```
yapdp-text-envelope-v1
<base64-encoded content of .state.zst, wrapped at 76 characters>
```

The marker `yapdp-text-envelope-v1` on the first line identifies the format.
The rest is standard base64 with lines wrapped at 76 characters (MIME style).

### Encoding (export)

1. Take the binary `.state.zst` bytes
2. Base64-encode them (chunked for large files)
3. Wrap at 76 characters per line
4. Prepend the marker line

### Decoding (import)

1. Check the first line for the marker
2. Strip the marker line
3. Concatenate remaining lines
4. Base64-decode to get the original `.state.zst` bytes

### Auto-detection

When importing, the system auto-detects the format:
- Bytes starting with zstd magic (`0x28 0xB5 0x2F 0xFD`), gzip magic (`0x1F 0x8B`),
  or the container magic (`YAPDPSTA`) are treated as binary `.state` containers.
- Text starting with `yapdp-text-envelope-v1` is treated as a text envelope
  and decoded to binary before import.

### UI integration

- **Import** split-button: file picker (binary `.state.zst` or `.txt` envelope),
  clipboard import, URL import. All inputs are auto-detected.
- **Export** split-button: download `.state.zst`, save as text file (`.txt`),
  copy text envelope to clipboard.
- **Share** dialog: create a shareable state with metadata, then choose output:
  download `.state.zst`, copy text envelope, save text file, or create a
  GitHub Gist (opens a helper dialog with instructions and link generator).
  **Make state self-contained** embeds the disk images too, so the file no
  longer depends on the media registry or on the images this build ships.

The envelope is handled by [`src/state-envelope.js`](../src/state-envelope.js),
shared between the browser and Node tools.
