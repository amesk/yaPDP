# yaPDP Roadmap

Where the project is going. Each item is one or two lines — details live in
linked docs/issues. Known emulator bugs are tracked separately in
[known-issues.md](known-issues.md); this file is for direction, not defects.

## Next release (0.4.0)

- **Shareable and reproducible emulator states.** Snapshots should be portable:
  import and export, and loading one from an external URL. A snapshot carries
  enough metadata to name the emulator build and the machine configuration it
  was taken on, so a link can open yaPDP **in that exact state** — not "boot
  this OS", but "here is the moment". Today's one-click launch goes
  `image → launch an operating system`; this extends it to
  `image / link → launch the exact historical state`.

  Why this is more than a feature: a disk image is "somewhere over there" — the
  game is on it, but it has to be found, booted and reached. A state is "right
  here": the machine is already where the sender left it. That makes a snapshot
  shareable the way a screenshot is shareable, except the reader does not look
  at the moment, they *stand in it*. Nothing else in this niche shares a runnable
  moment as a link.

  RT-11 is the lever. It is small and boots instantly, so a shared state opens
  faster than the visitor can decide whether it is worth it: a 1984 game, one
  tap, no commands and no instructions. Heavy guests (BSD, RSTS/E) work too, but
  their startup cost is visible — so the curated set leads with the light
  systems and is honest about the heavy ones.

  Two things this reuses rather than invents:
  - `imageFingerprints` (added for 0.3.0, #126) already answers "is this the
    same disk?". A shared state must name the image it needs, and the fingerprint
    is how the receiver is told honestly that it is the right one — or that it
    is not, before anything is restored.
  - `SCHEMA_VERSION` and the machine configuration already travel with a
    snapshot. Between emulator versions the *devices* can drift too, so a shared
    state is only trustworthy when it declares both.

  The curated collection is the other half: states hosted by the project and
  launchable from the site, so a visitor goes from "interesting" to "I am
  inside it" in one click. That makes yaPDP not only an emulator but a medium
  for publishing, discovering and exchanging interactive historical computing —
  with a **"Play this exact state"** link that can sit beside a screenshot, an
  article, a forum post or a video.

  Settle before it ships:
  - **Two kinds of link, two different rules.** A *curated* state carries an
    identifier into the project's own catalogue — the `?boot=` rule, nothing
    foreign travels. A *user* state cannot work that way: the payload lives on
    somebody's host, so its URL is necessarily a pointer to foreign content.
    The design accepts that and defends instead of forbidding — validate the
    schema, the machine configuration and the image fingerprints; refuse a
    state beyond a sane size bound; never inline a state in the URL itself (a
    `#state=<base64>` fragment would put a stranger's multi-megabyte save into
    history, logs and bookmarks); and make it visible to the operator that a
    state came from a third party.
  - **User states come first, curation second.** A catalogue only the project
    fills is a site; a catalogue other people bring states to is a platform.
    Ship the user mechanism before the curated collection, so the first person
    who contributes a state makes it a platform, instead of the site having to
    be re-taught as one later.
  - **A point of entry, not an exclusive distributor.** Hosting the states that
    make a 1984 game one tap away makes yaPDP where that game is found — but
    the goal is a catalogue, not a monopoly. Exclusivity defends and restricts;
    an entry point welcomes everything that arrives.
  - **Instant-start is a property of the combination** of a small image and a
    small state, not a slogan.

- **Retire the legacy stack (`?core=0`).** Once the core stack has soaked,
  drop the monolithic `src/iopage.js` path and the `E2E_LEGACY` parity run
  (the 10-guest matrix on the core stack remains the gate); delete the
  deprecated puppeteer CLI `tools/rt11-term.js` (headless-term is the tool
  of record). Tracked as
  [#18](https://github.com/amesk/yaPDP/issues/18).

## Backlog / ideas

- **OverlayArbiter — one authority over the modal overlays.** Every dialog
  decides on its own how to coexist with the quick-boot autoload: `imgerror`
  calls `window.__autoloadAbort()`, `quickboot` holds the input gate and its
  toast, the first-run hint and the refused-snapshot dialog call
  `QuickBoot.yieldToOperator()`. On 2026-10-01 the first-run hint met a running
  autoload and produced a **trap with no exit**: the input gate swallowed the
  click that would dismiss the hint, and the toast's "Take control!" sat
  underneath it — the only way out was waiting out the 45 s prompt budget or
  reloading the page. Fixed in `2bee5ba` (see the 0.3.0 notes), but the
  mechanism is still a convention, not a structure.

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
- **Landing: manual search.** The EN/RU toggle and the design tokens are
  already ported from the AI Studio remix; manual search is the last idea from
  it still unclaimed.
- **Full-disk write-back UX.** Guest writes already persist (DiskStore
  overlay); surface it in the UI (dirty indicators, reset-to-pristine).

## Done (0.3.0) — 2026-09-30

- **The emulator runs on phones and tablets.** On-screen keyboards for the
  terminals, special-key bars, two-finger pan/zoom, the operator controls kept
  at a readable size.
- **VT100 beside the VT52.** A terminal's capabilities are now stated by the
  terminal: `terminal-core.js` drives dialect modules (`dialect/vt100.js` is
  212 lines against the original 2724-line module), and the engine no longer
  knows which terminal it is driving. Vector cabinets, P4/P1 phosphor, key
  click.
- **One click from the gallery to a running guest.** `?boot=<device>` opens the
  emulator configured for that OS and types the boot; a missing image explains
  itself. Hardened further in `#121`, `#126`, `#131`.
- **Image downloads show progress**; the startup gate holds the first frame.
- **Disks are safer.** The write-back cache, the disk overlay and every
  snapshot are tagged with an FNV-1a fingerprint of the image bytes
  (`src/imagefingerprint.js`) instead of a hand-maintained `IMAGE_VERSION` that
  had already been forgotten once; a snapshot taken on a disk this build no
  longer ships is refused, with an explanation, instead of corrupting the
  guest's file system (`#126`).
- **The manual is a build product**, generated in both languages from one
  Markdown source, with the PDFs rebuilt on every site release.
- **Release artifacts are built in CI** from a `releases/v*` tag
  (`.github/workflows/release.yml`), rehearsed on `yapdp-bot/yaPDP` and
  promoted to `amesk/yaPDP`.
- **A gallery link no longer traps a first-time visitor** behind the first-run
  hint (`2bee5ba`, `#131`): a deep link stands the hint down, and any dialog
  the system raises hands the machine back before it appears.

## Done (0.2.0) — 2026-09-10

- **Desktop builds.** The same emulator packaged with Tauri v2, offline, in a
  Minimal and a Full variant; the bundled-image mount race fixed so late images
  are not empty at guest start.
- **A startup loading gate**, so the machine is not shown half-assembled.
- The release CI workflow and `docs/RELEASING.md`.
- Machine-state snapshots grew their L2 (device registers) and L3 (terminals,
  printer, punched tape) layers.
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
