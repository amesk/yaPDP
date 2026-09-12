# Releasing yaPDP

A step-by-step release checklist. The goal is a boring, repeatable process:
bump → document → build → publish. Total time: under an hour.

## Conventions

- **Version source of truth:** `package.json` (SemVer). `npm run version:sync`
  pushes it into `src/version.js` (UI marker), `src-tauri/tauri.conf.minimal.json`
  / `tauri.conf.full.json` (installer versions) and `src-tauri/Cargo.toml`.
- **Tags:** `releases/vX.Y.Z` (e.g. `releases/v0.1.0-alpha2`) — the CHANGELOG
  compare links rely on this prefix.
- **Commit format:** `#ID. <type>: description` (feat / fix / docs / refactor /
  test / chore) — see `.roo/rules/RESPONSE_RULES.md`.
- **Artifacts are platform-locked:** there is no cross-compilation, so
  Windows installers must be built on Windows and Linux packages on Linux.

## Checklist

### 1. Pre-flight — master must be green

- [ ] `git checkout master && git pull`
- [ ] **`git status --short` is EMPTY.** A dirty working tree silently ships
      stale/experimental files (a local teletype CSS experiment once made it
      into the Windows installers while the live site — built from clean
      master — was fine). Stash or commit local work before building.
- [ ] CI on master is green (`.github/workflows/ci.yml` — npm test + e2e)
- [ ] `npm test` passes locally
- [ ] `npm run e2e:os` passes (boots Unix V5, RT-11, BSD 2.11, BASIC-11)
- [ ] `npm run manifest` — run it if `media/` changed since the last release
      (the committed manifest feeds the quick-boot picker)
- [ ] **Screenshots in sync** — if any UI or document (user manual, README,
      landing) visually changed since the last release, regenerate and commit:
      `npm run screenshots:manual` writes every shot to **both** the repo
      source (`assets/images/manual/`) and the React landing mirror
      (`landing/public/assets/images/manual/`) — confirm both trees are
      updated and committed together so the docs never show a stale look.
      (`docs/BUILDING.md` lists the command under the User-manual section)
- [ ] CHANGELOG `[Unreleased]` contains everything significant since the last
      tag — if the CHANGELOG maintenance rule was followed, it already does

### 2. Version bump

- [ ] Decide the new version (SemVer): `0.1.0-alpha2` → `0.1.0` (or `0.1.1`,
      `0.2.0` …)
- [ ] Edit `package.json` → `"version": "X.Y.Z"`
- [ ] `npm run version:sync` — verify with `git diff` that `src/version.js`,
      both `tauri.conf.*.json` and `Cargo.toml` picked it up

### 3. Documentation

**Two files, two audiences — do not duplicate content between them.**

- **CHANGELOG.md** — the engineering log (for us). One `### Added / Changed /
  Fixed / Removed` section per release. **One line per entry**: a short
  statement of the final state, not the path taken to it. Interface names,
  file paths and flags belong here.
  - **No development history.** Intermediate fixes, reverts, "first did A, then
    reworked it to B", font/colour swaps and other steps the user never saw are
    **not** changelog entries. Write the net result once.
  - Exception: a real regression against the **previous published release** may
    be noted once ("X works again"), never the sequence of internal attempts.
- **RELEASE_NOTES.md** — the user-facing summary (for people who download the
  installer). Short: a headline plus a handful of "what's new / improved /
  fixed" paragraphs. Plain language, **no function names, paths, flags or
  version bumps of dev tools**. Rebuilt from scratch per release — **not a
  copy of the CHANGELOG**.
- A single fact lives in **either** CHANGELOG (engineer wording) **or**
  RELEASE_NOTES (user wording) — never copied verbatim into both.

Checklist:

- [ ] **CHANGELOG.md:** add entries under `[Unreleased]` as work lands, one
      line each; on release, rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD`
      (Keep a Changelog format) and open a fresh empty `[Unreleased]`
- [ ] Update the compare links at the bottom of CHANGELOG.md:
      `[X.Y.Z]: https://github.com/amesk/yaPDP/compare/releases/v<PREV>...releases/vX.Y.Z`
      and `[Unreleased]: .../compare/releases/vX.Y.Z...HEAD`
- [ ] **RELEASE_NOTES.md:** write the user-facing summary for this release
      from scratch (new headline at the top with the version); do not paste
      CHANGELOG lines — describe what the user gets, not how it was built
- [ ] README, if the release changes anything user-visible (new guest OS,
      new page, changed default): update the relevant section — details go to
      `docs/`, one line to the README

### 4. Commit & tag

- [ ] Commit the bump + docs together:
      `#<ID>. chore: release vX.Y.Z`
- [ ] Push to master (rebase-and-merge if coming from a branch)
- [ ] Tag: `git tag releases/vX.Y.Z && git push origin releases/vX.Y.Z`

### 5. Build artifacts

On **Windows** (MSI / NSIS):

- [ ] `npm run desktop:minimal`
- [ ] `npm run desktop:full`

On **Linux** (deb / rpm / AppImage):

- [ ] `npm run desktop:minimal`
- [ ] `npm run desktop:full`

Sanity-check the installer names and sizes (Minimal ~3 MB Windows / ~13 MB
Linux; Full ~84–172 MB — see `docs/BUILDING.md`).

### 6. Publish

- [ ] Create a **GitHub Release** from tag `releases/vX.Y.Z`
- [ ] Title: `yaPDP vX.Y.Z`; body: paste the RELEASE_NOTES summary
- [ ] Attach the artifacts (both variants, all platforms built)
- [ ] Mark as latest (unless this is a pre-release — mark pre-release for
      alpha/beta)
- [ ] Update the live demo on GitHub Pages if the web build changed
      (published manually via the Pages web UI)

### 7. Post-release

- [ ] Download and install one artifact per platform — smoke-test: boot a
      guest OS (Minimal: Unix V5 `boot rk0`; Full: BSD 2.11 `boot rp1`),
      save/load a machine state, drag & drop an image
- [ ] Verify the version marker in the sidebar (`yaPDP vX.Y.Z` → Info page)
- [ ] Tell the user what's in the release (one paragraph from RELEASE_NOTES)

## Optional automation (future)

- `release.yml` / `nightly.yml` workflow templates exist in
  `.github/workflows/` (commented out) — nightly builds and auto-release can
  be enabled when the commit format is stable enough for changelog generation
  (e.g. release-please).
