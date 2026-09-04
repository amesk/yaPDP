# yaPDP Roadmap

Where the project is going. Each item is one or two lines — details live in
linked docs/issues. Known emulator bugs are tracked separately in
[known-issues.md](known-issues.md); this file is for direction, not defects.

## Next release (0.2.0)

- **SVG cabinet for the Model 33 ASR teletype.** Replace the CSS-drawn
  cabinet with an SVG art layer; keyboard, paper, tapes and buttons stay
  HTML overlays on top (single coordinate system, `pointer-events: none`
  on the art). Concept + brief prepared — see
  `ideas/tty-svg-cabinet.md` (workspace) / AI Studio concept. Motivated by
  appearance; the current DOM mechanics and e2e keyboard/tape helpers stay
  untouched; cabinet CSS contract tests are rewritten deliberately.
- **Retire the legacy stack (`?core=0`).** Once the core stack has soaked,
  drop the monolithic `src/iopage.js` path and the `E2E_LEGACY` parity run
  (the 10-guest matrix on the core stack remains the gate); delete the
  deprecated puppeteer CLI `tools/rt11-term.js` (headless-term is the tool
  of record). Tracked as
  [#18](https://github.com/amesk/yaPDP/issues/18).

## Backlog / ideas

- **XXDP diagnostics as an authenticity gate.** XXDP is DEC's own field
  diagnostics OS; run actual DEC diagnostics (CPU/memory/controller) inside
  the emulator and wait for their verdict — the era's own test equipment
  certifying the emulation, as an e2e extension. Bonus fact for the Habr
  series: XXDP's name comes from the DECsystem-10/20 world.
- **ULTRIX-11 multi-user panic** — root-cause and fix (MMU/user-mode
  candidate); tracked as [#15](https://github.com/amesk/yaPDP/issues/15),
  details in known-issues.md.
- **e2e-teletype-tape "HERE IS" LOCAL flake** — timing-sensitive output
  check, occasional spurious failure; tracked as
  [#16](https://github.com/amesk/yaPDP/issues/16).
- **`E2E_CORE` semantics cleanup.** After the core stack became the default,
  `E2E_CORE=1` in the teletype/tape/snapshot e2e suites is a no-op; legacy
  coverage there should be expressed as `?core=0` (or dropped with the
  legacy stack).
- **Landing redesign inspired by the AI Studio remix.** The Gemini-produced
  React landing (Cloud Run) looks great but duplicates content and iframes
  the emulator from GitHub Pages; the winning ideas (EN/RU toggle, design
  tokens, manual search) could be ported back into the static
  `index.html`/`manual.html`.
- **Full-disk write-back UX.** Guest writes already persist (DiskStore
  overlay); surface it in the UI (dirty indicators, reset-to-pristine).

## Done (0.1.0)

- Core machine layer refactor: bus + device cards + adapters
  (`src/core/`, `src/devices/`), headless machine (`tools/headless-machine.js`),
  shared DiskStore write-back, `?bridge=1` tooling seam.
- The refactored core stack became the default; legacy behind `?core=0`.
- Stack-parity gate: 10 guest OSes boot on both stacks
  (`tests/e2e-osboot.js`, `E2E_LEGACY=1`).
- ASR paper-tape lead-in/trailer, bare-tape fix, Ctrl+E command mode in the
  CLI tools (SIMH style).
