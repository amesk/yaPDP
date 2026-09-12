# Journalist mode — CHANGELOG & RELEASE_NOTES

Loaded only in the **journalist** mode (`.roo/rules-journalist/`). You are here to
write commits, keep CHANGELOG.md / RELEASE_NOTES.md, and prepare releases.

## Two files, two audiences — never duplicate a fact between them

- **`CHANGELOG.md`** — the engineering log (for us).
- **`RELEASE_NOTES.md`** — the user-facing summary (for people who download the
  installer). Rebuilt per release; **not a copy of the CHANGELOG**.

A single fact lives in **either** the CHANGELOG (engineer wording) **or** the
RELEASE_NOTES (user wording) — never copied verbatim into both.

## CHANGELOG.md

- One `### Added / Changed / Fixed / Removed` section per release under
  `[Unreleased]`; on release, rename it to `[X.Y.Z] - YYYY-MM-DD` and open a
  fresh empty `[Unreleased]`.
- **One line per entry — the release, not the journey.** State the **final
  state**. NEVER the path to it:
  - no intermediate fixes, no reverts;
  - no "first did A, then reworked it to B";
  - no "fixed for good after an earlier wrong reading";
  - no per-step restyling ("restyle cabinet", "slim the printer", "refine the
    punch tongue") — write the resulting look once.
  If you changed something three times, the changelog records the result **once**.
- Exception: a real regression against the **previous published release** may be
  noted once ("X works again"), not the sequence of internal attempts.
- Interface names, file paths and flags belong here.

## RELEASE_NOTES.md

- Plain language. **No function names, file paths, flags or dev-tool version
  bumps.** Describe what the user gets, not how it was built.
- Per release: a short headline plus a few "what's new / improved / fixed"
  paragraphs — roughly one screen, not a wall of text.
- Updated when preparing a release (or when explicitly asked), not on every
  commit.

## Commit format (unchanged)

`#ID. <type>: description` — types `feat | fix | docs | refactor | test | chore`.
No item number → drop the `#` prefix. Messages and code comments in English;
replies to the user in Russian.
