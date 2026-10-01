# yaPDP Roadmap

Where the project is going. Each item is one or two lines — details live in
linked docs/issues. Known emulator bugs are tracked separately in
[known-issues.md](known-issues.md); this file is for direction, not defects.

## Next release (0.2.0)

- **Retire the legacy stack (`?core=0`).** Once the core stack has soaked,
  drop the monolithic `src/iopage.js` path and the `E2E_LEGACY` parity run
  (the 10-guest matrix on the core stack remains the gate); delete the
  deprecated puppeteer CLI `tools/rt11-term.js` (headless-term is the tool
  of record). Tracked as
  [#18](https://github.com/amesk/yaPDP/issues/18).

## Backlog / ideas

- **OverlayArbiter — one authority over the modal overlays.** Today every
  dialog decides on its own how to coexist with the quick-boot autoload:
  `imgerror` calls `window.__autoloadAbort()`, `quickboot` holds the input gate
  and its toast, the first-run hint and the refused-snapshot dialog call
  `QuickBoot.yieldToOperator()` (added 2026-10-01, see the fix below), and
  every dialog added later has to remember the rule on its own. On 2026-10-01
  the first-run hint met a running autoload and produced a **trap with no
  exit**: the input gate swallowed the click that would dismiss the hint, and
  the toast's "Take control!" sat underneath it — the only way out was waiting
  out the 45 s prompt budget or reloading the page. Nothing is broken now, but
  the mechanism is still a convention, not a structure.

  What the arbiter should be:
  - a single place that knows **who owns the machine** (a state, not a DOM
    element — the toast being visible is a symptom, not the ownership);
  - a distinction between **system-raised dialogs** (the autoload, an image
    error, a refused snapshot, the first-run hint) and **operator-raised ones**
    (reboot confirm, config-leave, the snapshot manager): the criterion is not
    "modal or not" but **who raised it** — the input gate already makes an
    operator dialog unreachable while the autoload runs, so only the
    system-raised ones can collide;
  - the rule that a system-raised dialog arriving while the autoload owns the
    machine makes the autoload **yield automatically** — "Take control!"
    becomes something the system does, not a button the operator has to find;
  - `QuickBoot` split explicitly into its two states — the **wizard** (an
    ordinary operator dialog, owns nothing) and `launch()` (system, owns the
    machine). Today one module holds both, which is how the collision stayed
    invisible in review.

  Test the **invariant**, not the cases: "no two owners of the machine" and
  "any system-raised dialog takes the machine back". Migration: move
  `imgerror`, `quickboot`, `onboarding`, the snapshot dialogs, config-leave and
  the reboot/power-off confirms onto the arbiter, and delete the ad-hoc
  `window.__autoloadAbort()` / `yieldToOperator()` call sites.

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
- **Release artifacts built in CI.** The 0.1.0 dirty-tree incident (a local
  uncommitted teletype CSS experiment shipped in the Windows installers
  while the clean-built site was fine) proved the last non-CI release step
  is the local desktop build. Move installer builds (Windows + Linux) onto
  a releases/v* workflow: clean tag checkout, windows/ubuntu runners, and
  the artifacts attach to the GitHub Release automatically.

## Done (0.1.0)

- Core machine layer refactor: bus + device cards + adapters
  (`src/core/`, `src/devices/`), headless machine (`tools/headless-machine.js`),
  shared DiskStore write-back, `?bridge=1` tooling seam.
- The refactored core stack became the default; legacy behind `?core=0`.
- Stack-parity gate: 10 guest OSes boot on both stacks
  (`tests/e2e-osboot.js`, `E2E_LEGACY=1`).
- ASR paper-tape lead-in/trailer, bare-tape fix, Ctrl+E command mode in the
  CLI tools (SIMH style).
