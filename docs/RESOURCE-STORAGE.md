# Resource Storage and Release Compatibility

## Status

Proposed architecture, for review before implementation.

This document defines the resource model needed for portable snapshots and Share packages. It does **not** implement Share bundling, migrate existing media, or change the `.state.zst` format.

The target for the first public 0.4.0 release is one canonical resource identity: SHA-256 over uncompressed resource bytes. Pre-0.4.0 fingerprint compatibility is intentionally not a release requirement.

## Problem statement

A snapshot records the emulated machine state, mounted logical image names, image fingerprints, and disk write-back overlays. It does not embed every base disk or tape image required to recreate the scenario. A recipient can therefore have a valid snapshot but lack one of its base resources, or have a different revision under the same filename.

The current `media/manifest.json` is a guest-media catalogue, not a complete inventory of every file under `media/` and not a content-version manifest. For example, `bootcode.ptap` exists in `media/` but is not listed in that catalogue.

The Pages workflow builds the site from the selected checkout. Files present only in a newer commit are not automatically retained when an older checkout is deployed. Consequently, Git history alone does not guarantee that an old resource URL remains available on the live site after a rollback.

## Existing compatibility contracts

The current `master` already implements several of the contracts that this proposal must build on. Keep the following concepts distinct: drive-to-image binding, mounted resource names/URLs, canonical content identity, the guest-media catalogue, and the set of files actually published by a release. They are related, but none is a substitute for another.

### 1. Mounted resources and drive bindings

The emulator captures the currently mounted resources separately from the drive-to-image mapping. A snapshot stores the mounted-resource list and a `mountmap` table; the latter records which image is assigned to each drive (for example, a remapped drive such as `rk4=rk5.dsk`). On restore, the mount map is applied before the machine is created, because device controllers resolve their image URL when their control blocks are built.

Do not collapse these fields into a new resource identifier or assume that a drive name alone identifies the image. Preserve the existing snapshot fields and their restore ordering when introducing a catalogue or package format.

### 2. Public runtime URLs

The emulator currently fetches built-in resources from URLs such as:

- `media/rp1.dsk.zst` for compressed disk images;
- `media/tm0.tap.zst` for compressed magnetic tapes;
- `media/lander.ptap` for an uncompressed paper tape;
- `media/bootcode.ptap` for boot code.

These paths are part of the current web-serving interface. The logical image name stored in the mount map (for example, `rp1.dsk`) is not the same thing as its public URL (for example, `media/rp1.dsk.zst`). Do not remove or repurpose existing `media/...` paths as part of the initial storage-model change.

### 3. Canonical image identity

The current implementation uses **SHA-256 over the decompressed resource bytes** as the canonical image identity. Compression is a transport/storage detail: recompressing identical payload bytes must not change the identity. The implementation is in `src/imagefingerprint.js`; it provides synchronous and asynchronous SHA-256 paths, with the same 64-character lowercase hexadecimal result.

This identity is already used by the runtime snapshot and DiskStore paths:

- snapshots capture `imageFingerprints` for mounted images and use them when checking image compatibility;
- snapshots also capture `imageVersions` and image-source information as separate metadata;
- DiskStore tags persisted blocks and per-image metadata with the SHA-256 identity of the decompressed image;
- disk-overlay capture and restore carry the image identity and check it before applying blocks.

Do not introduce another active image-identity algorithm or hash the compressed response body. Never reinterpret a legacy FNV value as SHA-256.

Unknown identity is not handled identically by every subsystem, and the proposal must not describe it as one universal rule:

- `ImageFingerprint.matches()` is permissive when either identity is unknown (`null`), because some hosts cannot expose the original bytes.
- DiskStore applies a stricter rule to cached blocks and overlays: known-vs-unknown is not a match; both identities must be known and equal, or both must be unknown. This prevents an identity-less persisted block from being applied to an image whose current identity is known.
- Snapshot metadata can contain absent or `null` image fingerprints. The current code comments define these as identities that were never learned, not as proof that the image bytes match. Snapshot compatibility behavior must therefore be described in terms of the actual snapshot restore checks, not inferred from DiskStore's stricter overlay rule.

The pre-0.4.0 FNV-1a/32 implementation is historical compatibility context, not the active identity contract. The current runtime's canonical identity is SHA-256 of the uncompressed payload.

### 4. Current media manifest

The current `media/manifest.json` has two related parts:

- `media`: the sorted list of logical guest-media names known to the media registry;
- `media-versioned`: a per-logical-name registry of published versions. Each version records its version number, SHA-256 of the decompressed payload, and the public URL from which that payload is served.

This is already a content-version registry for the guest media it covers. It is not merely a filename catalogue. The generator, `tools/gen-media-manifest.js`, computes the digest from decompressed bytes and refuses to change the bytes associated with an already published version number; changed content must be published under a new version number.

However, this manifest is not a complete physical-file inventory of `media/`, the repository, or the deployed site. It covers supported guest-media image files and deliberately excludes at least boot code (for example, `bootcode.ptap`). Nor does it define the complete set of resources guaranteed to be present in a particular application release. Keep those responsibilities separate in the proposed model.

### 5. Pages deployment and rollback

The current Pages workflow (`.github/workflows/pages.yml`) checks out the selected release tag or manually selected branch/commit, builds the documentation when that checkout supports it, builds the landing page when present, assembles the site from that checkout plus the landing build, and deploys the resulting artifact.

A manual rollback therefore republishes the site assembled from the older selected checkout. It does not merge in files from newer deployments or retain a separate immutable resource archive automatically. A resource that exists only in a newer checkout can consequently disappear from the deployed site after rollback.

The current media-version registry protects version immutability while its history is carried forward in the manifest: the generator rejects changed bytes for an existing logical-name/version pair. That check does not, by itself, make the corresponding payload independently durable across a rollback to a checkout that predates it. The proposed deployment/archive model must address that gap explicitly.

## Proposed model

### Logical resource

A stable name used by the emulator and legacy snapshot structure, for example `rp1.dsk` or `tm0.tap`. This name answers “which resource does this machine expect?” It is not a version identifier.

### Content revision

An immutable identity for the actual resource payload. Use SHA-256 of the **uncompressed resource bytes** as the single canonical image identity for DiskStore compatibility, snapshot/overlay checks, and the resource catalogue/archive. The identity therefore does not change merely because a resource is recompressed. The same algorithm and input representation must be used at every call site.

If two logical resources have identical uncompressed bytes, they have the same content identity and should share one stored payload where practical. A changed payload receives a new identity; never overwrite a historical revision in place.

The storage representation (raw or compressed) is an implementation detail and must be described explicitly by the catalogue. Choose one canonical stored representation per content identity to avoid retaining duplicate encodings accidentally.

### Resource catalogue

A machine-readable catalogue maps logical names and content identities to the information required to locate and decode the stored payload. It should distinguish at least:

- logical name;
- SHA-256 of the uncompressed payload (the canonical image/resource identity used throughout the runtime and archive);
- resource kind (disk, magnetic tape, paper tape, or other supported type);
- storage path and encoding;
- legacy/public URL aliases, where applicable.

The catalogue is metadata, not the definition of which resources are built into a particular release.

### Release-specific built-in set

Each application release has an explicit manifest identifying the exact resource revisions guaranteed to be available as built-ins for that release. A candidate layout is `resources/releases/<version>.json`; the exact schema and paths should be finalized alongside the validator.

A resource is “built-in” only when that release manifest says so. A file merely existing in the repository, under `media/`, or somewhere on Pages does not make it a built-in resource for every release.

The manifest must refer to immutable content identities, not just mutable filenames. A logical name can therefore be associated with one revision in one release and a different revision in a later release without changing the meaning of either manifest.

### Immutable resource archive

Keep content revisions in an append-only archive under Git version control, addressed by content identity. A candidate layout is:

```text
resources/
  catalog.json
  releases/
    0.3.0.json
    0.4.0.json
  blobs/
    sha256/
      <digest>.<kind>.<encoding>
```

This is a conceptual layout, not a commitment to those exact filenames. The key properties are immutable payloads, explicit encoding metadata, and deduplication by content identity.

The existing `media/` paths remain compatibility aliases for the resources that need them. Migration must not require rewriting logical mounted resource names.

## Snapshot and Share responsibilities

The storage model must preserve the separation of concerns:

- A snapshot stores machine state, mounted logical names, canonical SHA-256 identities, and disk overlays.
- The release manifest says which exact resource revisions the selected yaPDP release guarantees as built-ins.
- Later, Share packaging compares the scenario's required resource revisions with that release's built-in set and includes the missing payloads in the share package.
- Creating a share package must not mutate the source snapshot or its stored overlays.
- Resource kinds must not be hard-coded to disks only. Tape and paper-tape resources must be representable by the same model.

This phase does not define or change the share-container format. It establishes the identities and release metadata that a later Share implementation can rely on.

## Deployment and rollback requirements

The current Pages workflow publishes the selected checkout's assembled site. It does not automatically union files from the selected commit with files from newer deployments. A manual rollback to an older commit can therefore remove resource files introduced later.

The resource archive must have a lifecycle independent of the application code rollback:

1. Publishing an application release must publish every resource revision referenced by that release's manifest.
2. Once a content-addressed resource URL has been published, a later application deployment or rollback must not silently replace it with different bytes or make it disappear while the URL is within the project's supported compatibility window.
3. A rollback must identify the application release being rolled back to; it must not silently redefine the built-in set of that release.
4. The deployment workflow must validate resource references before publishing and fail rather than publish a manifest whose required payload is absent.
5. If Pages cannot retain the immutable archive independently of the selected application tree, the workflow must explicitly assemble the archive from a durable source before deployment. Simply keeping files in Git history is insufficient when deploying an older tree.

A rollback to older application code is not a promise that every newer snapshot can run on that older code. Runtime/schema compatibility remains a separate concern. The guarantee here is that resource identities and published immutable payloads are not silently corrupted or deleted by the deployment process.

## Legacy compatibility and migration

Do not introduce a speculative mapping for a `media/` prefix in old snapshots: inspected snapshots use logical mounted names such as `rp1.dsk`. Preserve the URL alias layer because the emulator itself fetches `media/...` paths.

Migration should be incremental:

1. Inventory all shipped resources, including resources omitted from the current guest-media manifest, and classify disk, tape, paper-tape, boot/runtime, and other assets.
2. Compute and verify canonical SHA-256 identities from uncompressed bytes.
3. Record the built-in resource set for each release based on the actual bytes shipped by that release; do not infer it from the current directory listing.
4. Add catalogue/manifest validation and deployment safeguards.
5. In the 0.4.0 implementation, explicitly invalidate incompatible pre-0.4.0 DiskStore records and provide a clear error for old snapshots with FNV metadata.
6. Only after those contracts are tested, implement Share resource collection and packaging.

Do not retroactively claim that an old release guaranteed a resource unless the exact historical payload can be verified. Recording historical payloads in the archive does not imply that the new application must continue to load every old snapshot.

## Validation requirements

The first implementation should add automated checks for:

- every release-manifest entry resolving to a catalogue entry and an existing payload;
- each payload decoding to the recorded SHA-256 of its uncompressed bytes;
- duplicate payload content being represented without unnecessary copies;
- resource kind and encoding being consistent with the actual payload;
- compatibility aliases resolving to the intended content revision;
- the `media/manifest.json` guest catalogue not being mistaken for a complete physical-file inventory;
- all runtime identity call sites using SHA-256 over decompressed bytes, with no active FNV-1a/32 fallback;
- old snapshots carrying FNV metadata being rejected explicitly and deterministically;
- legacy DiskStore cache/overlay records not being applied under the new identity contract;
- deployment failing when a release references a missing resource;
- deployment/rollback preserving previously published immutable resource URLs according to the declared support policy.

Regression coverage must include current-format snapshots with mounted media and disk overlays and confirm that restore semantics remain correct. Add separate tests proving that pre-0.4.0 snapshots with old fingerprint metadata fail clearly rather than being silently accepted. Also cover magnetic tape and paper tape, not only disk images.

## Non-goals for this phase

- No Share UI or bundling implementation.
- No change to the `.state.zst` container unless implementation proves it necessary; any required schema change must be explicit and versioned.
- No renaming of logical mounted resources.
- No removal of existing `media/...` URLs.
- No assumption that every file under `media/` is a built-in guest resource.
- No requirement to re-embed a resource that the selected release explicitly guarantees as built-in.

## Decisions to settle during implementation

- The final catalogue and release-manifest schema.
- The canonical on-disk encoding for archived payloads.
- The exact policy defining the supported lifetime of public immutable resource URLs.
- How the Pages workflow obtains the durable archive when publishing or rolling back application code.
- The historical releases for which the exact built-in set can be reconstructed and verified.
