# Image Version Registry

## 1. Purpose

The image registry defines how yaPDP identifies, versions, publishes, and retrieves disk and tape images. It separates the logical identity of an image from a particular published version and from the location where its bytes are stored.

The registry is also important for portable saved states: a state must be able to identify the exact base image required by its overlays and retrieve any image content that is not already available locally.

## 2. Image identity

An image's content identity is the SHA-256 digest of its **decompressed bytes**.

- Compression is a storage and transport detail. Recompressing identical bytes does not create a new image identity.
- The logical image name (for example, `rk1.dsk`) identifies the role or family of an image; it does not uniquely identify its contents.
- A publication version records the history of a logical image. It is not a substitute for the content digest.
- The registry associates each published version with its SHA-256 digest and a locator from which the exact bytes can be retrieved.

Consumers must use the digest when they need to verify exact content identity. They must not assume that two images are identical merely because their logical names match.

## 3. Version numbering and filenames

Versions are numbered independently for each logical image, starting at 1.

- Version 1 retains the original unversioned filename to preserve existing URLs and compatibility with older saved states. For example: `rk1.dsk.zst`.
- Versions 2 and later include the version number in the filename. For example: `rk1-v2.dsk.zst`, `rk1-v3.dsk.zst`.
- The highest published version number is the newest version of that logical image. A separate `latest` alias is not required.
- Version numbers are publication-history identifiers; SHA-256 digests are content identifiers.

A consumer must obtain the mapping from logical image name and version to digest and locator from the registry, rather than deriving it from the physical directory layout or guessing filenames.

## 4. Immutability and publication rules

Published image versions are immutable, and their content must remain available for as long as saved states or other published artifacts may depend on them.

1. Never change the content associated with an existing image version or SHA-256 identity.
2. Publish changed image content as a new version with the next available version number.
3. Never reuse a version number previously assigned to a published version.
4. Preserve the availability of every published image version, even if its physical storage location changes.
5. Do not publish a new version when the decompressed image bytes have not changed.

Version numbers must increase independently for each logical image. The registry must retain enough information to identify and retrieve published versions; a version does not become disposable merely because its original file has been moved or removed from the repository.

## 5. Generated registry

The registry is generated from the project's image metadata and is published as part of the site assets. It retains the existing `media` list for compatibility with consumers that use the current manifest format and adds version-aware metadata under `media-versioned`.

The intended version-aware structure associates each logical image with its published versions. Each version entry contains at least:

- `sha256`: SHA-256 of the decompressed image bytes.
- `url`: a locator for retrieving those exact bytes.

For example, the conceptual structure is:

```json
{
  "media": ["rk1.dsk"],
  "media-versioned": {
    "rk1.dsk": {
      "versions": {
        "1": {
          "sha256": "<digest-v1>",
          "url": "media/rk1.dsk.zst"
        },
        "2": {
          "sha256": "<digest-v2>",
          "url": "media/rk1-v2.dsk.zst"
        }
      }
    }
  }
}
```

This example describes the registry contract, not a guarantee that every generator or consumer already implements all version-aware behavior. Implementation changes must preserve the compatibility requirements below.

Registry generation and validation should detect missing files or locators, duplicate or reused version numbers, malformed digests, and digest mismatches between registered metadata and the decompressed image content.

## 6. Saved states and disk overlays

Saved states and overlays must identify the exact base-image content they depend on.

- An overlay may only be applied to the base image whose content identity matches the identity recorded with that overlay.
- A matching logical name alone is not sufficient: a newer version of `rk1.dsk` must not be used as the base for an overlay created against older, different bytes.
- A state shared with another user must either refer to an exact published image that the recipient can retrieve or carry the required image content itself.
- Images already available to the recipient may be reused only after their content identity has been verified.

These rules prevent an image update from silently changing the meaning of an existing saved state.

## 7. Storage independence and availability

The registry describes how to retrieve content, not where it must permanently live.

Published image bytes may be moved, mirrored, archived, or migrated to another storage system. When a locator changes, update the registry so that consumers can still retrieve the exact registered bytes. If old locators must remain valid for compatibility, preserve them or provide a reliable redirect or equivalent retrieval path.

The requirement is long-term content availability, not permanent storage in a particular directory or in the Git repository itself. Any migration must preserve the published image's SHA-256 identity and the ability of dependent saved states and artifacts to retrieve it.

## 8. Compatibility

The original unversioned filename for version 1 is retained so existing links and older saved states can continue to work. The existing top-level `media` list remains present while consumers transition to the version-aware registry.

Changes to the binary layout of a saved-state container require a `formatVersion` change. Changes to the saved-state manifest schema require a `schemaVersion` change, following the rules in [STATE-FORMAT.md](STATE-FORMAT.md).

The registry format and its generator should evolve without treating physical filenames or storage locations as the durable identity of image content.
