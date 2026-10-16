# Contributing to yaPDP

Thank you for your interest in contributing to yaPDP. Contributions can improve the emulator, its documentation, and the historical experiences people can explore with it.

yaPDP aims to make PDP-11/70 computing approachable while respecting the history and constraints of the systems it recreates. Contributions are evaluated for correctness, maintainability, historical context, and fit with that goal.

## Before you start

- For a bug, use the issue tracker to describe the problem and how to reproduce it.
- For a substantial feature, architectural change, new device, or a change to snapshot/state behavior, open an issue or discussion first. This helps agree on an extension point before time is spent on an implementation.
- Small, self-contained fixes can be submitted directly as a pull request.
- Please keep changes focused. Avoid unrelated refactoring or formatting churn in a patch.

If you are unsure whether an idea fits the project, ask. Early discussion is especially useful for changes that affect the emulated machine, its peripherals, saved states, or the experience of launching historical software.

## Contributions to the emulator

### Implementation

- Follow the existing JavaScript and Rust/Tauri patterns in the area you are changing. Consult [Architecture](docs/ARCHITECTURE.md) and [Building](docs/BUILDING.md) before introducing a new abstraction or dependency.
- Prefer the smallest safe change at the appropriate extension point. Preserve existing behavior unless a behavior change is intentional and described.
- Keep the browser emulator and headless/test environment compatible where applicable.
- Avoid adding dependencies for functionality that can be implemented clearly with the existing stack.
- Treat historical accuracy as a design constraint. If a behavior is deliberately simplified or differs from the original hardware, document that limitation rather than presenting it as historically exact.

### Tests and verification

Run the checks relevant to your change from the repository root:

```sh
npm test
```

The test suite is the main project verification entry point. Some changes also require targeted checks or end-to-end tests; see the scripts in `package.json` and the project documentation.

- Add or update a test when the change affects behavior that can be tested automatically.
- Prefer focused unit or integration coverage for logic changes; use end-to-end coverage when the behavior depends on the browser UI, boot flow, hardware interaction, or state restoration.
- For hardware or guest-OS changes, verify the affected behavior and relevant existing scenarios where practical.
- If a check cannot be run, say which check was skipped and why. Do not report a check as passing unless it was actually run.

Documentation-only changes generally do not need emulator tests, but should be checked for accurate links, commands, and Markdown structure.

## Historical software, snapshots, and other content

Community contributions need not be code. Documentation, verified boot instructions, reproducible demonstrations, historical notes, and shareable machine states can all help people explore the PDP-11 ecosystem.

For content contributions, please include enough context for another person to understand and verify the material:

- **Description:** What the user will see or learn, including the expected starting state and any steps needed.
- **Provenance:** Identify the original author, publisher, source archive, or historical reference when known. Distinguish documented facts from recollection, reconstruction, and uncertainty.
- **Reproducibility:** Explain how to load or run the material and what a successful result looks like. Check that any shared state or instructions work with the relevant project version.
- **Compatibility and limitations:** State the guest OS, required device configuration, known constraints, and any deviations from original hardware or software when relevant.
- **Attribution:** Preserve copyright notices and required acknowledgements.

A contribution does not have to be added to the main repository to be useful. Large disk images, third-party software, and independently maintained collections may be better hosted separately, with a description and a link from an appropriate project page when accepted.

### Adding a machine state to the collection

The `states/` directory holds the pre-built machine states the quick-boot
Scenario tab offers. To add a new one:

1. **Create the state** through the emulator's machine-state dialog
   (STATE → Save → Export). The browser exports a gzip-wrapped `.state.zst`.
2. **Repack to zstd** (the repo keeps zstd frames for states):
   `npm run media:repack -- states/<name>.state.zst`
3. **Place the file** in `states/`.
4. **Regenerate the manifest and previews**:
   `node tools/gen-state-manifest.js`
5. **Optional — a hand-crafted full preview.** If you want a larger or
   otherwise improved screenshot for the lightbox, place your own PNG at
   `states/previews/<name>-full.png` **before** step 4. The generator
   never overwrites an existing full preview and derives the list thumbnail
   from it; without it the thumbnail is built from the screenshot embedded
   in the state's own manifest.
6. **Commit** the new `.state.zst`, the updated `states/manifest.json` and
   the new files under `states/previews/`.

### Copyright and licensing

Only submit material that you have the right to contribute and distribute under the terms you propose. The project's MIT license applies to the project code; it does **not** automatically relicense guest operating systems, disk images, tapes, manuals, photographs, audio, fonts, or other third-party material.

- Do not assume that material found online is free to redistribute.
- Include source and licensing information for third-party assets, and retain required notices.
- When redistribution permission is unclear, do not add the material to the repository. Open an issue with the source and relevant context instead.
- By submitting a contribution, you confirm that you have the right to submit it and that you identify any applicable third-party terms. The contribution remains subject to the license and terms that apply to it; do not imply that you can relicense someone else's work.

## Documentation and historical claims

Documentation is part of the project, not an afterthought. Keep the README concise and use the existing `docs/` pages for detailed instructions, architecture, and feature descriptions. If you add a new documentation page, link it from the relevant README section.

When making historical claims, cite sources where possible and be clear about uncertainty. Do not describe an approximation, reconstructed experience, or known limitation as exact historical behavior. See the project documentation for the current architecture and supported features.

## Pull request checklist

Before opening a pull request, please check that:

- [ ] The change has a clear purpose and is limited to that purpose.
- [ ] The implementation follows the existing architecture and does not introduce unnecessary dependencies.
- [ ] Relevant tests were added or updated, and the applicable checks were run.
- [ ] User-visible behavior and limitations are documented where appropriate.
- [ ] Historical content includes provenance, attribution, and licensing information where applicable.
- [ ] No unrelated generated files, local configuration, credentials, or machine-specific artifacts are included.

In the pull request description, explain **why** the change is needed, what approach it takes, how it was verified, and any known risks or untested cases. Include screenshots, logs, or a reproducible example when they materially help review.

Keep commits focused and use clear English commit messages. The maintainer may ask for changes, defer a contribution, or decline it if it is out of scope, cannot be verified, raises unresolved rights concerns, or does not meet the project's quality and historical-fidelity goals.

## Review and acceptance

Opening a pull request starts a review; it does not guarantee acceptance. Review may consider correctness, test coverage, maintainability, user experience, historical accuracy, licensing, and the cost of maintaining the change over time.

The maintainer makes the final decision about merging contributions. Feedback is intended to help reach a safe, coherent result, and contributors are encouraged to discuss alternatives when a requested change is unclear.

Thank you for helping preserve and explore the history of computing with yaPDP.
