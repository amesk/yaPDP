# Resource Storage and Release Compatibility

## Status

Proposed architecture, for review before implementation.

This document defines the resource model needed for portable snapshots and Share packages. It does **not** implement Share bundling, migrate existing media, or change the `.state.zst` format.

## Problem statement

A snapshot records the emulated machine state, mounted logical image names, image fingerprints, and disk write-back overlays. It does not embed every base disk or tape image required to recreate the scenario. A recipient can therefore have a valid snapshot but lack one of its base resources, or have a different revision under the same filename.

The current `media/manifest.json` is a guest-media catalogue, not a complete inventory of every file under `media/` and not a content-version manifest. For example, `bootcode.ptap` exists in `media/` but is not listed in that catalogue.

The Pages workflow builds the site from the selected checkout. Files present only in a newer commit are not automatically retained when an older checkout is deployed. Consequently, Git history alone does not guarantee that an old resource URL remains available on the live site after a rollback.

## Existing compatibility contracts

The following are separate contracts and must not be conflated.

### 1. Logical resource name

Snapshots refer to mounted images by logical names such as `rp1.dsk`. They do not serialize the `media/` URL prefix as the mounted name.

Logical names are part of the existing snapshot/runtime contract. Preserve their interpretation for existing snapshots.

### 2. Public runtime URL

The emulator currently fetches built-in resources from URLs such as:

- `media/rp1.dsk.zst` for compressed disk images;
- `media/tm0.tap.zst` for compressed magnetic tapes;
- `media/lander.ptap` for an uncompressed paper tape;
- `media/bootcode.ptap` for boot code.

The `media/` path is therefore part of the web-serving interface even though it is not the logical name saved in a snapshot. Do not remove or repurpose these paths as part of the initial storage-model change.

### 3. Pre-0.4.0 fingerprint migration

In `releases/v0.3.0`, `src/imagefingerprint.js` used **FNV-1a/32** over the compressed `.zst` response body. That historical value was used by DiskStore and snapshot compatibility checks, but it is not the runtime identity contract for 0.4.0.

Before the first 0.4.0 release, replace that mechanism with SHA-256 over the **decompressed resource payload** everywhere image identity is needed. Do not keep FNV-1a/32 as a second active mechanism and do not reinterpret an old eight-digit FNV value as SHA-256. Old snapshots carrying an eight-digit FNV value must be rejected explicitly, even if the current image cannot be loaded for comparison. For DiskStore cache entries and overlays, accept them only when saved and current identities match, or when both are unknown; a known-versus-unknown pair is not proof of compatibility. This prevents stale or identity-less pre-0.4.0 blocks from being applied to a newly identified image. Snapshots without identity information remain unknown rather than being assigned a fabricated identity.

A filename or URL does not prove that the bytes are unchanged between releases. The canonical identity detects payload changes; the resource catalogue and release manifests separately make exact historical payloads discoverable and available.

## Proposed model

### Logical resource

A stable name used by the emulator and legacy snapshots, for example `rp1.dsk` or `tm0.tap`. This name answers “which resource does this machine expect?” It is not a version identifier.

### Content revision

An immutable identity for the actual resource payload. Use SHA-256 of the **uncompressed resource bytes** as the single canonical image identity for DiskStore compatibility, snapshot/overlay checks, and the resource catalogue/archive. Thus the identity does not change merely because a resource is recompressed. The same algorithm and input representation must be used at every call site.

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

The existing `media/` paths remain compatibility aliases for the resources that need them. Migration must not require rewriting old snapshots or changing their `mounted` entries.

## Snapshot and Share responsibilities

The storage model must preserve the current separation of concerns:

- A snapshot stores machine state, mounted logical names, compatibility fingerprints, and disk overlays.
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
2. Compute and verify content identities from uncompressed bytes.
3. Record the built-in resource set for each supported release based on the actual bytes shipped by that release; do not infer it from the current directory listing.
4. Add catalogue/manifest validation and deployment safeguards.
5. Only after those contracts are tested, implement Share resource collection and packaging.

Do not retroactively claim that an old release guaranteed a resource unless the exact historical payload can be verified.

## Validation requirements

The first implementation should add automated checks for:

- every release-manifest entry resolving to a catalogue entry and an existing payload;
- each payload decoding to the recorded SHA-256 of its uncompressed bytes;
- duplicate payload content being represented without unnecessary copies;
- resource kind and encoding being consistent with the actual payload;
- compatibility aliases resolving to the intended content revision;
- the `media/manifest.json` guest catalogue not being mistaken for a complete physical-file inventory;
- pre-0.4.0 FNV-1a/32 values never being mistaken for SHA-256, with old cache entries and overlays safely rejected when their known identity differs;
- deployment failing when a release references a missing resource;
- deployment/rollback preserving previously published immutable resource URLs according to the declared support policy.

Regression coverage must include snapshots from a historical release with mounted media and disk overlays, and must confirm that existing logical names and restore semantics remain unchanged. Also cover magnetic tape and paper tape, not only disk images.

## Non-goals for this phase

- No Share UI or bundling implementation.
- No change to the `.state.zst` container or snapshot schema.
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
