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
- [ ] CI on master is green (`.github/workflows/ci.yml` — npm test + e2e)
- [ ] `npm test` passes locally
- [ ] `npm run e2e:os` passes (boots Unix V5, RT-11, BSD 2.11, BASIC-11)
- [ ] `npm run manifest` — run it if `media/` changed since the last release
      (the committed manifest feeds the quick-boot picker)
- [ ] CHANGELOG `[Unreleased]` contains everything significant since the last
      tag — if the CHANGELOG maintenance rule was followed, it already does

### 2. Version bump

- [ ] Decide the new version (SemVer): `0.1.0-alpha2` → `0.1.0` (or `0.1.1`,
      `0.2.0` …)
- [ ] Edit `package.json` → `"version": "X.Y.Z"`
- [ ] `npm run version:sync` — verify with `git diff` that `src/version.js`,
      both `tauri.conf.*.json` and `Cargo.toml` picked it up

### 3. Documentation

- [ ] **CHANGELOG.md:** rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD`
      (Keep a Changelog format) and open a fresh empty `[Unreleased]`
- [ ] Update the compare links at the bottom of CHANGELOG.md:
      `[X.Y.Z]: https://github.com/amesk/yaPDP/compare/releases/v<PREV>...releases/vX.Y.Z`
      and `[Unreleased]: .../compare/releases/vX.Y.Z...HEAD`
- [ ] **RELEASE_NOTES.md:** rebuild from the released section — new headline
      at the top (with the version), refresh Highlights / What's New /
      Improvements / Bug Fixes from the CHANGELOG entries, prune stale text
- [ ] README, if the release changes anything user-visible (new guest OS,
      new page, changed default): update the relevant section — details go to
      `docs/`, one line to the README

### 4. Commit & tag

- [ ] Commit the bump + docs together:
      `#<ID>. chore: release vX.Y.Z`
- [ ] Push to master (rebase-and-merge if coming from a branch)
- [ ] Tag: `git tag releases/vX.Y.Z && git push origin releases/vX.Y.Z`

### 5. Build artifacts

On **Windows** (MSI / NSIS / portable exe):

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
