# Changelog

All notable changes to **yaPDP — Yet Another PDP-11/70 web emulator** are
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-10

## [Unreleased]

### Added

- **Configurable keycap layout for the Model 33 keyboard.** The CONFIG page
  (Equipment tab, right under the console-terminal radios) lets the operator
  choose who draws the keycaps: **Drawn in the artwork** (default — the caps and
  their legends come from `assets/Model-33-ASR.svg`, and the DOM keys stay in
  exactly the same boxes as invisible hit areas) or **Drawn by the page** (the
  CSS-drawn keycaps, i.e. the pre-artwork behaviour). Applied live and persisted
  as `keyboardLayout`; the flat key grid behind both modes
  (`model33KeyGrid` — 53 keys, 40px pitch, staggered rows, stable
  `r<row>c<col>` ids on every DOM key) is pinned by
  `tests/model33-keyboard.test.js` and the CSS contract tests.
  (`src/config.js`, `src/pdp11-app.js`, `css/g60printer.css`, `pdp11.html`,
  `tests/model33-keyboard.test.js`, `tests/config.test.js`,
  `tests/teletype-cabinet-css.test.js`)

- **Demo-reel voice-over narration on the title cards.** `tools/assemble-video.js`
  now speaks the intro, every clip's title card and the outro with a generated
  English narration (`tools/voicer.js`, Kokoro-82M or Windows SAPI);
  the WAVs are cached in `video/voice/` (rebuilt with `--voice-regen`, and the
  light reverb / pseudo-stereo added to the dry mono voice can be disabled with
  `--no-voice-reverb`). The intro card waits a beat (~3 s, until its title
  has fully faded in) before the voice starts. A card whose narration is
  longer than its default duration is stretched — freezing the last fully
  visible frame (just before the card's fade-out), so the speech never runs
  on an already-blackened screen — until the narration (plus its reverb tail)
  fits entirely, and the background music is ducked while it plays. The pure
  timing helpers live in `tools/reel-voice-util.js` with unit tests in
  `tests/reel-voice.test.js`.

- **Kokoro-82M neural narration engine for the demo reel.** The voice-over
  recorder (`tools/voicer.js`) can now synthesize the narration locally with
  **Kokoro-82M** through the official `kokoro-js` package (Transformers.js +
  onnxruntime-node on CPU, voice **US Michael** by default) — far less
  synthetic than the Windows SAPI voice, and fully headless: no browser and
  no network voice dependency. The quantized model (~86 MB) is downloaded
  once into the gitignored `.cache/kokoro/` and then reused (a CI checkout
  never re-downloads it); voices ship inside the package. Select it with
  `node tools/voicer.js --engine kokoro ...` or, for the whole reel,
  `node tools/assemble-video.js --voice-engine kokoro --voice-regen`; the
  `auto` engine (Kokoro, falling back to Windows SAPI) remains the default.
  Pure engine-selection/config helpers are pinned in `tests/voicer.test.js`.
  (`package.json`, `tools/voicer.js`, `tools/assemble-video.js`,
  `tests/voicer.test.js`, `.gitignore`)

- **Timed reel events while a demo clip is recorded.** The clip recorder
  (`tools/record-video.js`) now lets the scenario stamp timed events on the
  media timeline as it drives the machine — chapters (YouTube chapter
  markers), banner titles, spoken phrases and bottom subtitles — either
  declaratively on `extra` steps (`{ chapter/speak/title }`) or imperatively
  via a per-shot event recorder (`markChapter()`, `speak()`, `title()`,
  `subtitle()`). The events are written to `video/<base>.events.json`, and
  `tools/assemble-video.js` turns them into narration: every spoken phrase is
  synthesised through `tools/voicer.js` (content-addressed WAV cache) and mixed
  into the clip audio at its media offset, banner titles are burned into the
  finished MP4s, and `video/*.chapters.txt` + `video/*.srt` sidecars are
  written next to each output (`--burn-subtitles` also burns the bottom
  subtitle lines). Pure event/timing helpers live in `tools/reel-timeline-util.js`
  with unit tests in `tests/reel-timeline.test.js`; structural wiring tests in
  `tests/record-events.test.js` and `tests/assemble-events.test.js`.
  (`tools/record-video.js`, `tools/assemble-video.js`,
  `tools/reel-timeline-util.js`, the three new test files)

- **Server-side demo-video builds (GitHub Actions).** The whole demo-reel
  pipeline now runs on demand from the server: the manually-triggered
  **build-promo-videos** workflow (`.github/workflows/videos.yml`) checks out
  the requested branch, records every guest-OS clip on an `ubuntu-latest`
  runner (Chrome from the `puppeteer` postinstall, optional Xvfb-backed headed
  capture for reliable in-tab audio), assembles the reel + per-clip MP4s with
  the local Kokoro-82M narration and uploads them as a downloadable artifact.
  Two cross-platform gaps were closed along the way: the drawtext cards no
  longer hard-code Windows-only fonts — `tools/reel-font-util.js` resolves
  Consolas/Arial Bold on Windows and the repo-committed Courier Prime/Michroma
  faces on Linux/macOS (`YAPDP_FONT`/`YAPDP_FONT_BOLD` override); and
  `tools/record-video.js` now also discovers the common Linux Chromium paths
  and the browser bundled by `puppeteer`.
  (`.github/workflows/videos.yml`, `tools/reel-font-util.js`,
  `tools/assemble-video.js`, `tools/record-video.js`, `tests/reel-font.test.js`,
  `tests/record-browser.test.js`)

- **`bootHeadless` wait-for-silence readiness (`stableMs`).** Besides
  matching a known prompt marker (`waitFor`, whole-line by default, or as a
  substring with `waitForMode: "substring"`), the headless boot machinery
  can now treat the boot as ready once console output stays quiet for
  `stableMs` ms — no marker required. This makes it possible to explore an
  unknown guest image (whose prompts are not known yet) headlessly and then
  derive the readiness markers from the captured boot output.
  (`tools/headless-machine.js`, test 4 in `tests/headless-machine.test.js`)

### Changed

- **The Model 33 ASR console cabinet is drawn from SVG artwork.** The machine
  itself — the sand-cream body, the platen rollers, the carriage window and the
  Teletype Corporation wordmark — now comes from `assets/Model-33-ASR.svg` as a
  `pointer-events: none` backdrop, while the live controls stay HTML on top:
  the keyboard, the punch/reader plates, the CCU LINE/OFF/LOCAL knob, the
  printed sheet and both hanging tapes are anchored to the artwork's marked
  areas (`Keyboard`, `Apron`, `Puncher`, `Reader`, `Paper`, `Caret`) in ONE
  coordinate system — the `--tty-*` variables of the "SVG art layer" block in
  `css/g60printer.css`, which `tests/teletype-svg-backdrop.test.js` pins to the
  artwork so the two can never drift apart. Each control keeps its native
  pixel layout and is contain-fitted into its marker (round keycaps and knob
  never distort); the paper still rises out of the top of the machine and the
  tapes still hang past the rig to the bottom of the window. Behaviour, sounds,
  snapshots and the LP11 page are untouched; the CSS-drawn cabinet rules and
  their contract tests were retired deliberately.
  (`assets/Model-33-ASR.svg`, `pdp11.html`, `css/g60printer.css`,
  `src/pdp11-app.js`, `src/punchtape.js`, `src/reader.js`,
  `tests/teletype-svg-backdrop.test.js`, `tests/teletype-cabinet-css.test.js`,
  `tests/punchtape.test.js`, `tests/teletype-scaling.test.js`)

- **The artwork's markers are read at runtime and drive the keyboard grid.**
  The page now fetches `assets/Model-33-ASR.svg`, parses the marker rects
  (`ttyMarkerVars` in `src/pdp11-app.js`) and pushes them into the `--tty-*`
  variables of `#teletype-rig`, so moving a marker in Inkscape moves the
  matching control without touching any code (the stylesheet keeps the same
  numbers only as the fallback for fetch-less builds, and both sides are pinned
  by `tests/teletype-svg-backdrop.test.js`). The Model 33 key block is anchored
  to the Keyboard marker's corner and stretched to its width/height, so the
  invisible hit areas always cover the keycaps the artwork draws; the
  page-drawn keycaps keep the uniform centred fit (round caps). The printed
  sheet follows the Paper marker the same way: the printer publishes the width
  of the sheet it actually laid out (it depends on the column count) and the
  stylesheet scales the block by marker / that width, so the paper fills the
  platen the artwork draws instead of assuming the CSS base width (741px) — the
  sheet used to sit ~18% narrow inside the marker with dead margins and a
  correspondingly smaller font. Every marker
  rect also carries `display:none` in its own style, because Inkscape resets the
  LAYER's display on save and the markers must never paint over the cabinet —
  the same suite also guards the file against invalid XML, since a double hyphen
  inside a comment turns the artwork into a blank backdrop while the HTML
  overlays stay visible.

- **The punch unit's marker is split in two.** The punch control area and the
  punched tape are separate drawings on a real Model 33, so they carry separate
  markers now: `PuncherControl` anchors the REL/OFF/BSP/ON cluster (uniform,
  width-driven fit, so the round buttons stay round) and `PuncherTape` sets the
  strip's axis and its exit line — `#punchtape` no longer derives them from the
  plate centre plus hand-tuned 15/32px offsets. The plate frame keeps its own
  contain fit for the TAPE PUNCH label, while the tape-out slot and its
  triangular tongue are gone from the DOM — the artwork draws the punch
  mechanism now (the TAPE READER slot, which the artwork does not carry yet,
  stays HTML). While the markers are being
  aligned against the page the artwork's markers layer is deliberately left
  VISIBLE: the contract test reports that as the debug state, and requires
  `display:none` on every rect once the layer is switched off.
  (`assets/Model-33-ASR.svg`, `pdp11.html`, `css/g60printer.css`,
  `src/pdp11-app.js`, `tests/teletype-svg-backdrop.test.js`,
  `tests/teletype-cabinet-css.test.js`, `tests/punchtape.test.js`)

- **The reader unit's marker is split in two as well.** Mirroring the punch, the
  reader's four-position switch and the loaded tape are separate drawings on a
  real Model 33, so they carry their own markers now: `ReaderControl` anchors the
  START/STOP/FREE/AUTO switch block (uniform, width-driven fit, so the disc stays
  round) and `ReaderTape` gives `#readertape` its axis and exit line instead of
  the former plate-centre plus hand-tuned 32/24px offsets. The switch block left
  the plate frame for its own `#asr-reader-switch` layer, so the artwork owns
  where the switch sits, while `#asr-reader` keeps only the TAPE READER label
  plate (contain fit) and the reader slot. The marker the artist tilted is
  projected with `matrix3d()` through `--tty-rctrl-matrix`, exactly like the
  punch cluster. The geometry contract now reads both mechanisms' markers from
  the artwork and additionally checks that a tilted rect really is recognised as
  a quadrilateral (`tests/teletype-svg-backdrop.test.js`).
  (`assets/Model-33-ASR.svg`, `pdp11.html`, `css/g60printer.css`,
  `src/pdp11-app.js`, `tests/teletype-svg-backdrop.test.js`,
  `tests/teletype-cabinet-css.test.js`, `tests/reader.test.js`)

- **The artwork's Foreground layer paints above the controls.** A layer labelled
  `Foreground` is no longer part of the backdrop: the page fetches the same SVG
  once, keeps that single layer (plus `<defs>`, where the drawing's gradients
  live) and inlines it into `#tty-foreground`, which the stylesheet stacks above
  every control — the key deck, both hanging tapes, the printed sheet and the
  knobs. The host is `pointer-events: none`, so it stays purely cosmetic, and
  the rest of the machine remains the backdrop image behind the overlays. This
  is what lets the paper pass behind the platen lip and the punched tape behind
  the punch head, which a background image can never do. The layer is found
  through Inkscape's layer label (falling back to an id mentioning
  "foreground"), so renaming the editor id cannot break it.
  (`pdp11.html`, `css/g60printer.css`, `src/pdp11-app.js`,
  `tests/teletype-cabinet-css.test.js`, `tests/teletype-svg-backdrop.test.js`)

- **The markers layer is switched off (release state).** Every marker rect hides
  itself now (`display:none` in the rect's own style, which survives Inkscape
  rewriting the LAYER's display on save) and the stylesheet fallbacks are back in
  step with the re-cut Apron, PuncherControl, ReaderControl and tape markers, so
  a fetch-less load still puts every overlay in place. To align the markers
  again, make the layer visible and drop those per-rect styles — the contract
  test names the ones it wants.
  (`assets/Model-33-ASR.svg`, `css/g60printer.css`)

- **The TAPE PUNCH / TAPE READER lettering and the tape slot are drawn by the
  artwork.** The two printed captions and the reader's tape slot come from
  `assets/Model-33-ASR.svg` now, so the page no longer carries a `.asr-label` or
  a `.asr-slot` element and their CSS rules are gone. The punch and reader plate
  frames (`#asr-punch` / `#asr-reader`) stay as empty, marker-anchored
  placeholders — the punch's slot and its triangular tongue had already moved
  into the drawing. (`pdp11.html`, `css/g60printer.css`)

- **Any marker can now lay its layer into perspective, not just the punch.**
  The quad projection (a marker drawn as a quadrilateral, or a rect carrying its
  own `rotate()`/`matrix()`) is wired for the whole cabinet: the Keyboard deck,
  the CCU apron block and the printed sheet join `PuncherControl` /
  `ReaderControl` in `TTY_QUAD_MARKERS`, each with the anchor its stylesheet
  fallback really uses — the marker's top-left corner for a corner-fitted block,
  the marker centre for a centred one — and the sheet with a "dynamic scale"
  mode that keeps the printer's own factor (its width follows the column count)
  and adds only the artist's transform, applied in rig space so the sheet tilts
  onto the platen the artwork draws and the paper-growth maths keeps working.
  Nothing changes until the artist tilts a marker: with plain rectangles the
  fallbacks render exactly as before (checked in the browser for all four
  layers). A guard in `tests/teletype-svg-backdrop.test.js` now fails when the
  artwork tilts a marker rect that the table does not list — exactly the gap the
  Apron marker had — and the three modes are unit-tested
  (`tests/tty-quad-matrix.test.js`).
  (`src/pdp11-app.js`, `css/g60printer.css`, `tests/tty-quad-matrix.test.js`,
  `tests/teletype-svg-backdrop.test.js`, `tests/teletype-cabinet-css.test.js`)

- **Four-point (quad) markers: the artwork can lay a layer into perspective.**
  A marker may now be drawn as a QUADRILATERAL instead of a rectangle — a
  polygon or a straight-line path with four nodes, e.g. a Trapezoid fitted over
  the punch control area in Inkscape. The page reads the four corners at load,
  solves the homography and publishes a `matrix3d()` (`--tty-pctrl-matrix`),
  which `#asr-punch-buttons` uses when present; with a plain rectangle the
  variable is absent and the honest uniform fit stays, so nothing changes until
  the artist draws the quad. A marker rectangle that carries its OWN transform
  (`rotate()`, `matrix()`, `translate()`, `scale()` — e.g. a marker tilted over
  a tilted drawing) counts as a quad too: its four transformed corners are used.
  The parser refuses curved paths, unsupported transforms and degenerate quads
  (the fallback applies) and is pure/unit-tested together with the solver
  (`tests/tty-quad-matrix.test.js`).
  (`src/pdp11-app.js`, `css/g60printer.css`, `tests/tty-quad-matrix.test.js`,
  `tests/teletype-cabinet-css.test.js`)

### Changed

- **The TAPE PUNCH operator buttons got the Model 33 keycap look.** REL/OFF/BSP/ON
  are flat-top dark cylinders now, exactly like the keyboard keycaps
  (`#punchkeyboard .m33-key`): the same dark radial plastic and a solid side
  wall, 6px high (the keycaps use 4px) so the buttons stand a touch higher. In
  the tilted ASR block the wall stands to the RIGHT and BELOW the cap (3px/6px)
  rather than straight down, and pressing drops the cap onto that base by the
  same offset. The latching buttons (REL/ON/OFF) stay visibly pressed down — the
  cap sinks and KEEPS the sunk position — while momentary BSP is only down while
  held. The buttons never light up: the gold rim, the `.active` colour highlight
  and the hover brightening are all gone, so the only feedback is the physical
  sink. `tests/punchtape.test.js` pins the sunk latch and the absence of any
  highlight. (`css/g60printer.css`, `tests/punchtape.test.js`)

- **The TAPE READER switch is now the authentic vertical four-detent lever.**
  The rotary knob with four labels around a disc was wrong: on the automatic
  (ASR) Model 33 the reader is controlled by a lever that slides up and down a
  slot and clicks into four fixed positions, printed top to bottom as
  **START** (manual run — the reader feeds continuously), **AUTO**
  (line-controlled run: X-ON starts, X-OFF pauses), **STOP** (forced stop) and
  **FREE** (tape released for manual pull). The handle can be dragged to a
  detent (it follows the pointer and the mode latches on release, with the
  switch click), clicked to step one position down, and the labels stay direct
  hit targets. The block is PORTRAIT now: the 40x115 native frame matches the
  artwork's portrait `ReaderControl` slot, which it is fitted onto. `readerModes`
  is stored in the machine's top-to-bottom order, so each mode's index is also
  the lever's detent. (`pdp11.html`, `css/g60printer.css`, `src/pdp11-app.js`,
  `tests/punchtape.test.js`, `tests/teletype-cabinet-css.test.js`,
  `tests/teletype-svg-backdrop.test.js`)

- **The CCU (LINE/OFF/LOCAL) switch is modelled as the real knob again, with the
  original dark lettering.** It is a RAISED two-step cylinder now — a wide
  moulded base standing proud of the apron with a smaller flat cap set LOW on it
  (its centre sits on the base's centre, not lifted above the turning axis),
  instead of a flat disc. The base and the cap keep their moulded shading
  fixed while only the BEAK turns: `setTtyMode` rotates `#ccu-switch-lever`,
  whose orbit origin follows the smaller cap. The LINE/OFF/LOCAL legends went
  back to dark moulded lettering on the apron (a light stamp with a faint light
  catch, as the real panel prints them dark, not glowing). (`css/g60printer.css`,
  `src/pdp11-app.js`, `tests/teletype-cabinet-css.test.js`)

- **The reader tape now comes OUT of the slot as it is read.** It used to be
  rendered in full and pulled UP into the reader (the top rows disappearing) —
  which is backwards: on the machine the tape is fed through the slot and spills
  forwards, downwards. A loaded tape now sits INSIDE the reader (0 rows hang
  out) and every byte read prepends a fresh row under the head, so the tape
  grows downwards — the same mechanic as the punched tape (`punchtape.js`).
  When the last byte is read the whole tape has left the slot and stays hanging
  (the tail at the bottom) until it is pulled out or a new tape is loaded;
  `restore()` re-plays the rows that had already come out, in read order.
  (`src/reader.js`, `tests/reader.test.js`, `tests/e2e-teletype-tape.js`)

- **The artwork can now carry a second front-most layer for the tape tongues.**
  A layer labelled `Middle` (see `TTY_ART_LAYERS` in `src/pdp11-app.js`) is
  inlined into its own host, `#tty-foreground-back`, which the stylesheet stacks
  BETWEEN the two hanging tapes — above the reader tape (z-index 10) and below
  the punched tape (z-index 12). That is what lets the punched tape come out
  OVER the punch tongue while the reader tape still slips UNDER its own
  translucent tongue. `#tty-overlay` no longer creates a stacking context of its
  own (its `z-index` is gone): an isolated context would put both tapes under
  every front-most layer, and the punched tape could never rise above the
  tongue. Layer lookup is generic now — `ttyArtLayerId(text, label)` matches
  Inkscape's label first and an id mentioning it second, and the plain
  `Foreground` lookup never swallows the middle layer. (`pdp11.html`,
  `css/g60printer.css`, `src/pdp11-app.js`, `tests/teletype-cabinet-css.test.js`,
  `tests/teletype-svg-backdrop.test.js`)

- **Marker fallbacks re-synced with the re-cut punch/reader markers.** The
  artwork's `PuncherControl` and the now PORTRAIT `ReaderControl` slots were
  re-cut, so the stylesheet's marker numbers and contain factors (`--tty-pctrl-*`,
  `--tty-rctrl-*`, and `--tty-rctrl-switch-k` over the new 40px-wide lever
  block) were brought back in step, and the markers layer returned to its
  release state (per-rect `display:none`). (`assets/Model-33-ASR.svg`,
  `css/g60printer.css`)

### Removed

- **Browser loopback capture voice engine.** `tools/voicer.js` no longer
  records Chrome's Web Speech API through an ffmpeg DirectShow loopback device:
  the `browser` engine and its `--device`/`--force-sapi`/`--rate`/`--pitch`/
  `--volume` flags are gone. The narration is produced by the two remaining
  mechanisms — Kokoro-82M (`kokoro`) and Windows SAPI (`sapi`) — with `auto`
  trying Kokoro first and falling back to SAPI.
  (`tools/voicer.js`, `tools/assemble-video.js`, `tests/voicer.test.js`)

### Fixed

- **The teletype rig was being squashed vertically, so overlays could never
  line up with the artwork markers.** `#teletype-rig` is a flex item of the
  column-flex `#page-teletype`, so on windows shorter than the artwork it was
  SHRUNK to fit instead of keeping its aspect ratio. The backdrop stretches to
  the rig box (`background-size: 100% 100%`), so the squashed rig smeared the
  whole drawing at a different px-per-unit than the HTML overlays (which live in
  `--tty-u` units) — no amount of re-drawing the markers could make the two
  agree. The rig now declares `flex: none` and is fitted the way
  `installTeletypeScaling()` was designed to fit it: one uniform
  `transform: scale()` on an unsquashed rig. Measured after the fix: the reader
  lever block and its `ReaderControl` marker differ by 0 px on all four sides.
  The quad projection for the reader was also brought in step with the new
  portrait lever block (40x115 native, instead of the former 92x62 knob).
  (`css/g60printer.css`, `src/pdp11-app.js`)

- **Server-built demo-reel videos run end to end on CI.** The
  `build-promo-videos` workflow no longer dies at any point of the pipeline:
  it records every guest-OS clip (Chromium launch made root-safe, the
  browser executable path exported asynchronously — `puppeteer.executablePath()`
  is a `Promise` in Puppeteer v25 and previously leaked a raw `Promise { … }`
  literal into `$GITHUB_ENV`, which GitHub Actions rejected) and assembles a
  correct reel and per-clip MP4s with the distro ffmpeg (the static
  `ffmpeg-static` build lacks the `drawtext` filter the caption cards need).
  The Verify step no longer misreports the assembled audio as missing: the
  reel and every clip carry a real audio stream, and the check now matches it.
  (`.github/workflows/videos.yml`, `tools/record-video.js`,
  `tools/assemble-video.js`)
- **`buildSapiScript()` no longer re-resolves the output path.** The pure
  PowerShell-script builder embedded `path.resolve(outPath)` into the emitted
  script. On Linux (the CI runner) `path.resolve` of a Windows-style path such
  as `C:\tmp\voice-out.wav` treated it as relative and prefixed the CWD, so the
  emitted `SetOutputToWaveFile(...)` argument no longer matched the expected
  verbatim path — breaking `tests/voicer.test.js` on the Linux unit job. The
  caller (`sapiSpeak`) already resolves the path before handing it in, so the
  builder now embeds `outPath` verbatim (single-quote escaped only), staying
  pure and platform-independent. (`tools/voicer.js`, `tests/voicer.test.js`)

- **Emulator hangs, image loads and headless-tool correctness fixed.**
  VT11 (`src/vt11.js`) calls the global `requestInterrupt()` function that
  was only defined in the legacy `src/iopage.js`; the refactored machine layer
  (`src/browser-machine.js`) now provides the same global so the VT11 can
  signal interrupts and Lunar Lander proceeds past the GREETINGS screen into
  the landing phase. The image loader also accepts a plain file when no
  compressed `.zst` variant exists (`lander.ptap` ships raw — previously a
  404), the Minimal desktop build ships the bootcode tape it needs again, and
  the Manual page's "Launch the Emulator" button actually launches.
  On the headless/CLI side, `headless-term` keeps the guest's captured output
  when a boot times out (instead of discarding it), `:export` resolves output
  paths from the working directory (not the repo root) and `:status` after a
  `:rewind` reports the tape state truthfully; `bootHeadless` can treat a
  console that has stayed quiet for `stableMs` as booted so an unknown guest
  image can be explored and its readiness prompt captured.

- **Manual screenshots stay in sync with the React landing.**
  `tools/screenshots-manual.js` previously wrote every shot only to
  `assets/images/manual/`, letting the landing mirror
  (`landing/public/assets/images/manual/`) drift out of date. Each generated
  PNG is now written to both tracked locations, and all manual illustrations
  were regenerated from current `master` — they now show the machine's real
  quiet `@` bootstrap prompt instead of the stale `Boot>` banner.

## [0.1.0] - 2026-09-04

### Architecture: the machine layer becomes cards on a bus

- **Core machine stack (`?core=1` era ended — it is now the default).** The
  PDP‑11/70 machine is no longer welded to the UI. Following the hardware's
  own Unibus idea (1969), the machine layer is split into core base classes
  (`src/core/`: bus, device, machine) and one module per peripheral
  (`src/devices/`): DL11, KW11, RK11, RL11, RP11, TM11, UDA50 (MSCP),
  PTR11/PTP11, LP11, MMU and CPU registers — 1:1 DOM-free ports of the
  legacy iopage closures. `pdp11.html` boots the core stack by default; the
  monolithic `src/iopage.js` remains reachable with `?core=0` as the
  reference/rollback implementation.
- **Headless machine.** The same cards assemble in pure Node
  (`tools/headless-machine.js`) — RT‑11 boots to its prompt in ~1.6 s with
  no browser. `tools/headless-term.js` is the CLI tool of record
  (`:mount`/`:export`/`:wait`/`:raw`, Ctrl+E SIMH-style command mode);
  `tools/rt11-term.js` (puppeteer era) is deprecated.
- **Shared write-back.** DiskStore moved to `src/diskstore.js`; the browser
  core stack persists guest writes through the same IndexedDB overlay as
  legacy.
- **Tooling seam.** Internal `__yapdpBridge` is always exposed; the legacy
  `window.*` bridge surface is gated behind `?bridge=1`.
- **Stack-parity gate.** `tests/e2e-osboot.js` boots **ten guest OSes**
  (Unix V5, RT‑11 ×2, RSX‑11M 3.2/4.6, RSTS V06C/V7.0/E 9.6/10.1, XXDP,
  BSD 2.9/2.11, BASIC‑11) through the wizard on the core stack;
  `E2E_LEGACY=1` runs the same matrix on `?core=0`. RSTS/E 9.6+10.1 boot
  is a regression anchor for the UDA50 fix below.
- **Docs:** `docs/machine-layer.md` (design deep-dive), ARCHITECTURE
  updated for both stacks, `docs/ROADMAP.md` added, known issues linked to
  GitHub issues.

### Fixed

- **UDA50 debug guard.** `process.env.DEBUG_UDA` was read without a
  `typeof process` guard, crashing the browser CPU loop when RSTS/E 9.6 /
  10.1 autoconfigured the UDA50 (they probe every controller, even when
  booting from RP).
- **Paper-tape re-mount after reset.** `boot()`/device reset forgot the PTR
  tape; the DOM-free card cannot lazily rebuild from the Storage select, so
  the adapter re-applies the selected tape after reset/restore — BASIC‑11
  boots on the core stack again (`@BOOT PR` → `*O` in ~2 s).
- **RSTS/RSX quick-boot scenarios.** RSTS `Option:` answers corrected
  (`START` starts timesharing; the historic `^J` is honoured, blind
  `11,70`/`PDP` dropped); RSX‑11M images autostart, so the blind MCR typing
  was removed.


### Added

- **Automatic NUL lead-in / trailer on the ASR paper tape.** A fresh tape
  (tear-off) now starts with 6 blank NUL rows — the historic lead-in: the
  punch feeds the tape while no data pins fire, so the tape gets a
  mechanically-sound blank stretch (a RUB OUT leader would be all holes and
  tear on loading). Disengaging the punch (machine DC4 or the OFF button)
  punches the matching 6-row NUL trailer before the tape stops. The saved
  `.ptap` includes the leader, byte-exact. (`src/punchtape.js`,
  `src/pdp11-app.js`; e2e updated in `tests/e2e-teletype-tape.js`,
  `tests/reader.test.js`.)

- **Guest-OS boot e2e test (`tests/e2e-osboot.js`, `npm run e2e:os`).** Boots
  four real guest operating systems through the quick-boot wizard in Chromium
  — exactly the user path (magic-wand picker -> scenario click) — and asserts
  each reaches its ready state: Unix V5 and BSD 2.11 to the shell prompt
  (auto-login typed by the wizard's prompt-aware logic), RT-11 to its "."
  monitor prompt once the boot output settles, and DEC BASIC-11 to its "*O "
  prompt. Covers the emulator core, the boot sequences and the wizard's
  login-typing end to end; failures save an artifact screenshot and the
  console tail to `tests/artifacts/`. The suite starts its own dev server if
  :1170 is not serving.


- **BASIC-11 from the ASR paper-tape reader (promo clip `basic-tape`).**
  The demo-reel generator now has a second BASIC-11 clip: it boots BASIC-11
  on the Model 33 ASR teletype, then feeds an integer-valued "heart" program
  from the ASR tape reader in AUTO mode (one byte per DL11 drained signal)
  instead of typing it, so the whole program + RUN come off the tape. The
  drawing is pure integer math — this BASIC-11 V007A build has no integer
  variables and TAB() errors, so the program uses real variables holding exact
  small integers, leading-space loops and no FPP built-ins / fractional STEP
  (verified by `tools/_debug-basic-tape.js`; the FPP suspicion from the sine
  demo turned out to be a TAB() error, not FPP). The clip is registered in the
  reel CLIPS (`tools/assemble-video.js`); the capture feeds the reader with the
  raw console queue so the tape never animates the keys, and the quick-boot
  list scroll is now DOWN-only so the first item (BASIC) is not scrolled on
  camera. Structural coverage: `tests/video-shots.test.js`.

- **Labelled title cards in the standalone demo MP4s.** Every exported
  `<name>.mp4` now shows a title card (the same slide the reel uses, e.g.
  "DEC BASIC-11 · ASR TAPE") right after the product intro, so the viewer
  knows what the demo demonstrates before the clip starts — matching the
  reel's per-clip title cards. The card text uses the intro's subtitle style
  (bold sans-serif, light with a dark outline) and is sized up to read
  clearly as the clip's description, and the card is overlaid with the same
  CRT scanlines as the intro. The card is held ~3x longer than the reel's
  quick title cards (9 s), and the intro card's final-frame hold was raised
  to 8 s so the green "DEC era" line stays readable before the fade-out /
  cross-fade.

- **Crisper promo videos (native capture resolution).** The tab capture was
  silently capped at 800×600 by `chrome.tabCapture`'s default and then
  upscaled to the 1280×800 export — hence blurry, smeared clips. The recorder
  now passes explicit `videoConstraints` (1280×800@30) so the raw WebM is
  captured at the full native resolution, the intermediate VP8 bitrate is
  raised (12 Mbps) and the final H.264 export uses CRF 18 instead of 20.
  Re-record with `npm run record:video` to pick up the sharper capture.


- **Build manifest (`media/manifest.json`) + availability-aware quick-boot
  picker.** A deployment now declares which guest images it ships: the
  manifest is generated from `media/` by `node tools/gen-media-manifest.js`
  (deterministic, committed, drift-guarded by `tests/media-manifest.test.js`).
  The magic-wand picker lists only guest OSes whose image is in the manifest
  and/or mounted in DataLoader (desktop bundle, drag & drop imports) — so the
  **Minimal** desktop build no longer advertises OSes it cannot boot; paper
  tapes always stay (tiny, keep the demo bootable). Deployments without a
  manifest (ad-hoc hosts, `file://`) keep the previous show-everything
  behaviour. The Info page's guest-OS table is annotated the same way: rows
  whose image is not shipped are dimmed with an *image not in this build*
  note. Desktop: `tauri-bundled.js` re-renders the picker once the bundle
  finishes mounting. New e2e coverage: `tests/e2e-quickboot-manifest.js`
  (reduced manifest, absent manifest, drag-drop union, Info annotation,
  full-repo manifest).


- **Working ASR paper-tape reader.** The TAPE READER on the Model 33 ASR
  console now actually reads: **Load tape** opens a file dialog for a
  `.ptap`, `.ptap.zst` or `.txt` tape, which hangs from the reader slot down
  to the window edge (same 8-track rows and ragged free end as the punched
  tape). **START** feeds the tape at the console speed; **AUTO** sends one
  byte and then one per DL11 "input drained" signal (paused by DC3/X-OFF,
  resumed by DC1/X-ON); **STOP** and **FREE** show the **Remove tape**
  button (hidden while START or AUTO is running); loading a tape forces
  the reader to **STOP** so a fresh tape never starts feeding on its own.
  The ASR tape unit is cast from the SAME plastic as the teletype cover —
  the keyboard deck's sand gradient with the same subtle grain and inner
  top shadow, no contrasting frame (the punch/reader areas are transparent
  parts of the one body). The grain texture is shared with the printer
  face, the deck and the ASR unit, so the whole console reads as one
  moulded cabinet. The punch and reader contours are raised plastic
  plates (relief): a lighter sand tone than the body with the same grain,
  a top highlight and a drop shadow; both plates are the same width
  (144px) and the TAPE PUNCH / TAPE READER labels centre on them. The
  decorative corner screws were removed.
  The CCU routes every read byte
  exactly like the keyboard: **LOCAL** prints the tape on paper only
  (tape-to-paper copy), **LINE** sends it to the machine and the guest's
  echo prints it (a local print would double every character on echoing
  guests like BASIC); with the punch engaged every read byte is also
  punched onto the output tape — the classic ASR tape-to-tape duplication
  trick. Removing a tape from the reader is silent (no rip sound). The
  punched tape hangs one step above the reader tape (z-index), so it
  always passes in front of the reader mechanism — as on the real ASR-33.
  The tape visibly moves up and shortens as it is read, and the reader
  tape joins the machine-state snapshots (L2) alongside the punched tape.

- **Full machine-state snapshots.** The snapshot feature now captures the
  whole machine, not just the CPU: RAM, MMU and mounted images ([`d292244`](https://github.com/amesk/yaPDP/commit/d292244)); the registers of all nine I/O-page devices — KW11, DL11×3, LP11, PTR11/PTP11 (including the punch buffer), TM11, RK11, RL11, RP11, UDA50 — through clean `snapshot()`/`restore()` hooks that never read registers with hardware side effects ([`f0b866a`](https://github.com/amesk/yaPDP/commit/f0b866a)); the punched paper tape ([`d06f564`](https://github.com/amesk/yaPDP/commit/d06f564)); the LP11 printed paper ([`27a95a1`](https://github.com/amesk/yaPDP/commit/27a95a1)); the LP11 ON LINE state ([`142b2c9`](https://github.com/amesk/yaPDP/commit/142b2c9)); the VT52 terminals with their screen buffers ([`3940ebb`](https://github.com/amesk/yaPDP/commit/3940ebb)); and the VT11 vector display — registers and the CRT image itself ([`21d420f`](https://github.com/amesk/yaPDP/commit/21d420f)).
- **Machine-state dialog.** The STATE floating button opens a snapshot
  manager (save/load/rename/delete) that replaces the old snapshot section
  on the Storage page ([`0c4289b`](https://github.com/amesk/yaPDP/commit/0c4289b)). Restoring a snapshot also restores the hardware device set, with styled confirm modals ([`24d3772`](https://github.com/amesk/yaPDP/commit/24d3772)) and a styled rename dialog instead of the native `window.prompt` ([`8e42159`](https://github.com/amesk/yaPDP/commit/8e42159)).
- **Persistent disk write-back cache (DiskStore).** Guest-OS writes are
  saved to browser storage and overlaid on the base image on the next
  launch, with per-image or full reset on the Storage page ([`49f379b`](https://github.com/amesk/yaPDP/commit/49f379b)).
- **Linux desktop builds**: deb and AppImage bundle targets for the Tauri
  app ([`14c14a7`](https://github.com/amesk/yaPDP/commit/14c14a7)).
- **About block**: version marker in the navigation sidebar and an About
  section on the Info page ([`e091062`](https://github.com/amesk/yaPDP/commit/e091062)).
- **Storage page tabs** (Images / Paper Tapes): the two storage workflows
  are now separated; the Paper Tapes tab gets its own `.ptap` drop zone,
  and the full-window drop target appears only while the Storage page is
  active (previously it showed on every page, where a drop mounted the
  image with no visible feedback) ([`faae411`](https://github.com/amesk/yaPDP/commit/faae411)).
- **Quick boot button** in the welcome dialog and an **Auto-boot shortcut**
  in the power-off dialog ([`d2e8a72`](https://github.com/amesk/yaPDP/commit/d2e8a72)).
- Floating **REBOOT and STATE buttons on the VT52 console page** too
  ([`820def1`](https://github.com/amesk/yaPDP/commit/820def1)).

### Changed

- Repository moved from GitVerse to GitHub — the canonical home is now
  [`github.com/amesk/yaPDP`](https://github.com/amesk/yaPDP). The git remote,
  all landing-page links and the `repository` fields in `package.json` and
  `Cargo.toml` now point at GitHub; every commit/release URL in this changelog
  has been updated accordingly ([`2e13a61`](https://github.com/amesk/yaPDP/commit/2e13a61)).
- Snapshot UI hint updated to reflect the full L2/L3 state capture
  ([`1c3f208`](https://github.com/amesk/yaPDP/commit/1c3f208)).

### Fixed

- **LP11 printer buttons render at full brightness again.** The cabinet's
  drop shadow (`0 26px 44px`) was painting over the button row below it (the
  cabinet is a positioned element, so it draws after the inline content),
  making the buttons ~30% darker than every other operator button. The
  printer action row now sits above the shadow (`.printer-actions` gets
  `position: relative; z-index: 1`).

- ASR punch **BSP** no longer erases the last byte by itself — it pulls the
  tape back one step, so the hanging tail visibly shortens as the row
  disappears into the punch unit, and the next punch overpunches the row now
  under the punch head, holes OR-ing together like a real overpunch. The
  erasure is the **DELETE / RUB OUT** key's job: it punches all holes over
  the byte, turning it into DEL — the authentic two-step ASR-33 correction
  ([`92e10c5`](https://github.com/amesk/yaPDP/commit/92e10c5)).
- ASR receive punch now records machine output too: a **NUL** from the
  machine punches a blank row with only the feed hole — the classic tape
  leader/trailer that threads the reader — and a received **DEL** punches an
  all-holes RUB OUT row, exactly like a real ASR-33 receive punch. The LOCAL
  echo no longer punches a second row for bytes the keyboard punch already
  recorded ([`1671979`](https://github.com/amesk/yaPDP/commit/1671979)).
- **UI chrome re-fonted to VT323** (OFL, bundled woff2): buttons, dialogs,
  sidebar, badges, labels, the CONFIG page, the machine lettering (DEC
  wordmark, bezel letters) and the ASR/LP11 key legends now render in the
  VT320-style terminal face instead of Arial/Helvetica, so the whole
  interface reads like a 1970s DEC terminal. The console output keeps its
  authentic bitmap VT52 glyphs and the LP11 paper keeps lp1_regular; the
  handwritten Help Me! sticker is untouched. Font sizes were re-tuned per
  element (VT323 is a pixel face, illegible below ~11 px).
- **Help Me! sticker re-fonted to Kalam** (OFL, bundled): the operator's
  handwritten note now uses a real handwriting face (Kalam) instead of the
  system cursive stack (Segoe Script/Comic Sans), with sizes bumped for
  legibility; the boot-command listing on the note stays monospaced (VT323)
  so the address columns line up.
- **Chrome font sizes re-tuned for readability**: after the VT323 retrofit
  every label was re-checked on the real screen; sizes were raised across
  the board (sidebar 9→12 px, keycap legends 9–10→11–12 px, switch
  positions 11→13 px, badges/labels 13→15 px, CONFIG labels 12→14 px,
  modal titles 22→24 px, and more). Form controls (buttons, selects,
  inputs) now inherit the chrome font too — the UA stylesheet was silently
  rendering them in Arial.
- **Chrome font switched VT323 → Courier Prime** (OFL, bundled): the
  pixel VT323 was still hard to read at UI sizes (small x-height, thin
  strokes). Courier Prime (typewriter face, real Bold included) keeps the
  rough, hand-made feel of the original while staying legible; a brief
  Share Tech Mono experiment was dropped for lacking that character. The
  console output keeps its bitmap VT52 glyphs, the LP11 paper keeps
  lp1_regular, the sticker keeps Kalam.
- **Teletype machine chrome stays pixel VT323**: the ASR-33's own labels
  (keycaps, punch/reader switch positions, CCU knob, operator buttons)
  were too wide in Courier Prime and shifted the machine layout, so they
  keep the narrow VT323 their geometry was tuned for. Courier Prime
  remains everywhere else (panel, dialogs, sidebar, CONFIG, LP11 badges).
- **LP11 and VT52 machine chrome also back to VT323** (badge, keys,
  bezel lettering, status): same narrow-advance logic as the teletype —
  machines speak the pixel font, the rest of the UI speaks Courier Prime.
- **Front-panel machine chrome back to VT323 too**: Courier Prime's wider
  and taller glyphs overflowed the keycaps (ENABLE/HALT, S INST/S BUS,
  START) and the status label strips (PAR/ADRS ERR/RUN/...). The panel —
  like the teletype, LP11 and VT52 — keeps the narrow pixel VT323.
- **Engraved "digital" wordmark and cabinet caption set in Michroma**
  (OFL, bundled): the real DEC lettering was in the spirit of
  Microgramma/Eurostile, and Michroma is the closest free analogue — the
  wordmark letters on the front panel, the VT52 bezel and the LP11 cover,
  plus the "digital equipment corporation • maynard, massachusetts"
  caption, now use it. Keycaps and status strips keep pixel VT323.
- **Front-panel masthead caption placement fixed for good**: checked
  against a photo of a real PDP-11/70 masthead, the caption belongs *to
  the right* of the boxed "digital" wordmark on the same line, vertically
  centred — which is where the emulator had it all along; the earlier
  "under the wordmark" reading of the photo was wrong. The caption is now
  engraved-small (Michroma at 8px, ~1/3 of the letter height, like the
  original) so the full "digital equipment corporation • maynard,
  massachusetts" fits on one line in the space next to the wordmark.
- **Status LED labels readable again**: the labels next to the LEDs (PAR,
  ADRS ERR, RUN, ..., ADDRESSING 16/18/22, PARITY HIGH/LOW, ADDRESS) were
  set at 7px — fine for Arial, but VT323's thin pixel strokes became
  nearly invisible at that size. Bumped the status blocks and LED base
  plates to 9px (~0.7 of the LED height, matching the real panel) and
  fixed the label strip's line-height so the text sits inside its strip
  instead of bleeding into the LED area.
- **Front-panel lettering back to its original arial** (deployed version
  as the reference): Alexei compared the panel against the live GitHub
  Pages build and the arial lettering there was far more readable than
  VT323's thin pixel strokes at the small sizes the keycaps and status
  strips need. The panel base returns to arial 7px (switch labels, status
  labels, LED base plates) exactly like the deployed build; only the
  engraved Michroma masthead stays. All labels fit their keycaps and
  strips again.
- **LP11 "digital" wordmark lowercase again**: the stamped wordmark on the
  LP11 cover was forced to uppercase by a stray `text-transform: uppercase`
  in `.lp11-dec-letter` — the real DEC wordmark is lowercase, like the
  front-panel masthead. Removed the transform; the seven letters now read
  "digital" (Michroma, engraved look).
- **One face for all operator buttons**: Help Me! / Bootstrap now! (panel
  actions), the teletype controls (Tear tape / Tear paper / Save tape /
  Load tape / Remove tape) and the printer actions (Print / Save .txt /
  Tear paper) now share a single typeface — VT323 14px bold — and the same
  dark-amber gradient, exactly like the already-unified teletype controls.
  Previously the panel actions were Courier Prime 12px and the printer
  actions Courier Prime 14px, so identical-looking buttons rendered in
  three different faces. The CONFIG/STORAGE action buttons (Restore
  defaults, Apply, Unmount, Reset image, Reset all, Rewind tape, Download,
  Clear) were already uniform (Courier Prime 14px bold) and stay as their
  own set.
- **Storage "Persistent disk changes" row no longer merges**: "Reset all"
  used to wrap onto the line below the combobox and sat flush against it,
  looking like part of the select. The field is now a flex row (gap 8px);
  the select is capped at 190px and the buttons at 12px padding so all
  three controls fit on one line — and if the window is ever too narrow,
  the wrap keeps the same clean gap instead of touching the select.
- **CONFIG hint spacing after action buttons**: the "Fills the form with
  factory values…" hint sat 4px under "Restore defaults", looking glued to
  the button. Hints that directly follow an action button now get an 8px
  gap (the "Apply" field benefits too); hints after selects/radios keep
  the tighter 4px spacing.
- **Operator buttons restyled to the manual's "Launch the Emulator"
  recipe**: the PANEL (Help Me! / Bootstrap now!), CONSOLE (Tear tape /
  Tear paper / Save tape / Load tape / Remove tape) and PRINTER (Print /
  Save .txt / Tear paper) buttons looked flat and muddy at VT323 14px with
  faux bold. They now follow the manual page's call-to-action exactly:
  Courier Prime 11px uppercase with 0.5px letter-spacing, the engraved
  inset amber top highlight and a soft drop shadow (same dark-amber
  gradient and border as before).
- **One shared action-button recipe for the whole app**: the operator
  buttons (PANEL / CONSOLE / PRINTER) and the form buttons (CONFIG /
  STORAGE: Restore defaults, Apply, Unmount, Reset image, Reset all,
  Rewind tape, Download, Clear) now all read from a single grouped rule —
  `.panel-action-btn, .tty-btn, .printer-actions button, .config-control
  button` — instead of three duplicated copies in two files. The
  CONFIG/STORAGE buttons were still Courier Prime 14px sentence case and
  flat; they now use the same small uppercase + engraved bevel recipe as
  the operator buttons, so one edit tunes every action button at once.
  (The round punch-key caps keep their VT323 labels; the Apply "dirty"
  highlight and the persist-row sizing overrides still apply.)
- **Manual: the console section is readable again**: the "Paper-tape
  reader" bullet had grown into a 200-word wall covering five topics. It
  is now four separate bullets — reader/load, the four-position reader
  switch (START / AUTO / STOP / FREE as a nested list), the CCU knob
  (LINE / OFF / LOCAL) and tape duplication — so each topic can be
  scanned on its own.
- **Printer buttons are no longer dimmed by the machine's shadow**: the
  LP11 cabinet's drop shadow (`0 26px 44px rgba(0,0,0,0.5)`) landed
  exactly on the Print / Save .txt / Tear paper row, and because the
  cabinet is `position: relative` it painted over the inline buttons —
  they rendered ~30% darker than every other action button. The
  `.printer-actions` row is now lifted above the shadow
  (`position: relative; z-index: 1`), so the buttons read as bright as
  the PANEL / CONSOLE ones while the cabinet keeps its floating look.
- **Manual screenshots regenerated**: all 27 images under
  `assets/images/manual/` were re-captured so they show the current
  look — the shared action-button recipe (small uppercase buttons on
  PANEL / CONSOLE / CONFIG / STORAGE), the brighter printer buttons and
  the current fonts.
- **Mute during continuous LP11 printing** now silences the line-printer
  whirr immediately (and it resumes on unmute). Previously the whirr's stop
  was debounced by 150 ms and re-armed on every print tick, so a mute pressed
  while output kept flowing never took effect — the sound played until the
  print job ended.
- **Restore defaults** on the CONFIG page now really resets the four live
  BEHAVIOUR options — **Reboot confirmation**, **Help Me! sticker**,
  **Machine power** and **Auto-boot** — immediately (they persist the moment
  they change and are read from the config, not the form, so a form-only
  reset never reached them). The machine powers down to the factory "off"
  state; the remaining fields still wait for **Apply**.
- The reboot confirmation dialog ("Reboot the machine?") now carries an
  Auto-boot shortcut: **Start the default bootstrap automatically after
  reboot** — a live mirror of the CONFIG|BEHAVIOUR **Auto-boot** option. The
  tick persists to the config, stays in sync with the CONFIG page checkbox
  and decides whether this reboot runs the built-in default loader or halts
  the machine (the CPU now really stops; a bootstrap already in RAM no
  longer keeps running after a boot-less reboot).
- The CCU knob (LINE/OFF/LOCAL) and the TAPE READER switch (START/STOP/FREE/AUTO)
  now turn by clicking the switch itself, not only the position labels: the
  knob/disc cycles one detent clockwise (LINE → OFF → LOCAL → LINE, START →
  STOP → FREE → AUTO → START) like rotating the real control; labels still
  jump straight to a position.
- The Model 33 keyboard is bit-paired: SHIFT flips bit 4 of the base code,
  CTRL flips bit 6. Held together on a key that carries both legends
  (P @ DLE, K [ VT, N ^ SO, M ] CR) both code bars engage, so
  **CTRL+SHIFT+P** = 0x50^0x10^0x40 = **0x00 = NUL** — the keyboard's only
  way to generate a NULL. With the punch engaged it punches a blank row
  with just the feed hole: the tape leader, punched by hand exactly as
  operators did on the iron. On a PC keyboard **Ctrl+@** does the same
  ([`8a91c2e`](https://github.com/amesk/yaPDP/commit/8a91c2e)).
- CONFIG|Equipment: teletype-only parameters and the LP11 printer width are
  now **disabled and dimmed** (opacity .45) instead of hidden when they do
  not apply to the current selection — the form reads as a stable list where
  greyed-out options explain their dependency, and their values survive the
  switch back ([`ea570ba`](https://github.com/amesk/yaPDP/commit/ea570ba)).
- `trap()`: runaway trap recursion on a corrupted stack (e.g. from an e2e
  test mutating PC/SP/RAM while the CPU is running) now halts the machine
  like real PDP-11 hardware instead of crashing with a `RangeError`
  ([`7d85b61`](https://github.com/amesk/yaPDP/commit/7d85b61)).
- Restoring a snapshot that changes the hardware config no longer triggers
  the browser's "Reload site?" beforeunload prompt ([`6c6d420`](https://github.com/amesk/yaPDP/commit/6c6d420)).
- Quick boot typed boot commands in lower case for the upper-case-only DEC
  guests (BASIC-11, ODT-11, ED-11, RT-11, RSTS, XXDP, RSX-11M) — a real
  ASR-33 teletype cannot produce lower case, and those systems do not
  understand it. The wizard now types `BOOT PR` / `BOOT RK1` etc.; the
  case-sensitive *nix guests (Unix V5, BSD 2.9/2.11, ULTRIX-11) keep their
  lower-case commands ([`1f999ab`](https://github.com/amesk/yaPDP/commit/1f999ab)).

### Documentation

- **Info page**: the "What makes it special" table gains an **Authentic LP11
  Line Printer** row (faithful DEC line printer — cabinet, fanfold paper,
  ON LINE / TOP OF FORM / PAPER FEED — printing at ~300 lines/min, with the
  finished job exportable to a real printer via the system dialog or as a
  `.txt`); table headers on the Info page are now left-aligned. The README
  "What makes it special" table mirrors the new row, and the landing page
  (index.html) mentions the printout export.

- README and user manual: machine-state section, the STATE button in the
  floating-controls table, refreshed screenshots ([`9fdd8bf`](https://github.com/amesk/yaPDP/commit/9fdd8bf)).
- User manual: internal cross-links between sections ([`906c274`](https://github.com/amesk/yaPDP/commit/906c274)).
- User manual: CONFIG screenshots cropped to the page's content column
  ([`43c992d`](https://github.com/amesk/yaPDP/commit/43c992d)).
- User manual and README: Storage section rewritten for the two tabs, with
  new per-tab screenshots ([`faae411`](https://github.com/amesk/yaPDP/commit/faae411)).

### Chore

- **`npm run version:sync` now covers every version location.** It used
  to regenerate only `src/version.js`; the installer versions in
  `src-tauri/tauri.conf.minimal.json` / `tauri.conf.full.json` and the
  `Cargo.toml` crate version had to be bumped by hand and were easy to
  forget. One `package.json` edit + `npm run version:sync` now syncs all
  four (idempotent).
- **Test runner**: `npm test` now delegates to
  [`tools/run-tests.js`](tools/run-tests.js) instead of a 35-entry `&&`
  chain — same canonical order, but the run continues past failures and
  reports every broken file, `npm test -- <substr>` filters by file name and
  `--list` prints the order.
- **Sidebar version marker** now reads `yaPDP v0.1.0`: the marker was
  rendering as `YAPDP` because `.sidebar-version-name` had
  `text-transform: uppercase` in the CSS. The name is displayed as written
  now. (The stylised all-caps `YAPDP` on the promo-video intro title card
  is intentional and unchanged.)
### Chore

- Demo video pipeline: teletype human-input capture, VT52 pacing, MP4
  montage and YouTube-ready exports ([`18549e7`](https://github.com/amesk/yaPDP/commit/18549e7)).

## [0.1.0-alpha2] - 2026-08-24

Changes since [v0.1.0-alpha1] (2026-08-19). 70 commits, 69 of them
non-merge — the bulk of the work went into authentic peripherals (Model 33
ASR teletype, DECscope VT52, DEC LP11 printer) and front-panel/machine
controls.

### Added

#### Peripherals — Model 33 ASR
- Redraw the console teletype as an authentic Model 33 ASR ([`d9ccd78`](https://github.com/amesk/yaPDP/commit/d9ccd78)).
- Authentic ASR-33 paper tape with punch controls ([`70ddb41`](https://github.com/amesk/yaPDP/commit/70ddb41)).
- Four-position TAPE READER switch and latching REL ([`0ceb537`](https://github.com/amesk/yaPDP/commit/0ceb537)).
- Authentic Model 33 ASR keyboard with special keys and BREAK support ([`1229e29`](https://github.com/amesk/yaPDP/commit/1229e29)).
- Rotary CCU switch replacing the LOCAL/LINE buttons ([`4e3e072`](https://github.com/amesk/yaPDP/commit/4e3e072)).
- Sticky CTRL/SHIFT latch, dual-legend keys and echo punch for dropped control codes ([`f0d51d5`](https://github.com/amesk/yaPDP/commit/f0d51d5)).
- Teletype Corporation logo on the console front panel ([`31fd8ab`](https://github.com/amesk/yaPDP/commit/31fd8ab)).

#### Peripherals — LP11 line printer
- DEC-style LP11 printer cabinet with rising paper ([`a1376c7`](https://github.com/amesk/yaPDP/commit/a1376c7)).
- LP11 cabinet hood, indicator panel and working ON LINE key ([`798c9a6`](https://github.com/amesk/yaPDP/commit/798c9a6)).
- Sidebar output-activity lamps and historical LP11 DONE/ERROR semantics ([`6af0ab3`](https://github.com/amesk/yaPDP/commit/6af0ab3)).

#### Peripherals — DECscope VT52
- Authentic VT52 cabinet: slanted beige monoblock, dark side panel, dark grey-green glass, scanline tuning and proportional window scaling ([`d21646a`](https://github.com/amesk/yaPDP/commit/d21646a)).
- Authentic fritzm/vt52 bitmap display font ([`adbf6e2`](https://github.com/amesk/yaPDP/commit/adbf6e2)).
- IRM insert mode, ESC L/M and previously missing escape sequences ([`f7a5860`](https://github.com/amesk/yaPDP/commit/f7a5860)).
- DEC 'digital' wordmark on the cabinet side panels ([`2879fe7`](https://github.com/amesk/yaPDP/commit/2879fe7)).
- VT52 text mode option and shared PasteUtil paste helper ([`98d72b2`](https://github.com/amesk/yaPDP/commit/98d72b2)).

#### Front panel & machine controls
- Machine power/auto-boot config options, power lamp on the Panel nav button and auto-boot-aware reboot ([`16a2c40`](https://github.com/amesk/yaPDP/commit/16a2c40)).
- Bootstrap sticky note with "Help Me!"/"Bootstrap now!" controls and a power-off guard ([`27c2c05`](https://github.com/amesk/yaPDP/commit/27c2c05)).
- Control OFF/POWER/LOCK by clicking position labels instead of cycling the switch ([`8186471`](https://github.com/amesk/yaPDP/commit/8186471)).
- Global reboot and quick-boot buttons; panel controls reset on reboot ([`f481344`](https://github.com/amesk/yaPDP/commit/f481344)).
- PANEL nav-button status indicators: power lamp and run-state pause/play icon ([`9c1d642`](https://github.com/amesk/yaPDP/commit/9c1d642)).
- "Power on & Bootstrap" and "Apply & Leave" dialog buttons ([`33b9958`](https://github.com/amesk/yaPDP/commit/33b9958)).

#### UI, config & misc
- Global mute button for all sounds ([`d9fe637`](https://github.com/amesk/yaPDP/commit/d9fe637)).
- CONFIG: retitle the Visual tab to "Look and sound", add a Development tab for VT52 text mode ([`fb536c3`](https://github.com/amesk/yaPDP/commit/fb536c3)).
- CONFIG Equipment: group each device with its parameters, hide inapplicable fields without layout shift ([`af06612`](https://github.com/amesk/yaPDP/commit/af06612)).
- Storage: mounted image count indicator next to Unmount ([`59959a4`](https://github.com/amesk/yaPDP/commit/59959a4)).
- Info page: animated front-panel GIF instead of the static large panel ([`01240b1`](https://github.com/amesk/yaPDP/commit/01240b1)).
- Quick Boot: always show terminal type and printer state; BSD 2.11 waits for the boot prompt ([`4ec1d6b`](https://github.com/amesk/yaPDP/commit/4ec1d6b)).
- Project Page link on the landing page hero CTA buttons ([`ebb3f71`](https://github.com/amesk/yaPDP/commit/ebb3f71)).
- Tooltips on all navigation sidebar buttons ([`99ba26d`](https://github.com/amesk/yaPDP/commit/99ba26d)).
- Click sounds for panel switches, punch buttons and teletype keys ([`ecc53f4`](https://github.com/amesk/yaPDP/commit/ecc53f4)).

### Changed

- Model 33 ASR: restyle the teletype cabinet and flat-top keycaps ([`a5d76f0`](https://github.com/amesk/yaPDP/commit/a5d76f0)).
- Model 33 ASR: polish controls and printer body styling ([`d1b74e4`](https://github.com/amesk/yaPDP/commit/d1b74e4)).
- Model 33 ASR: slim the printer and keyboard and reposition keys ([`0e8bd3c`](https://github.com/amesk/yaPDP/commit/0e8bd3c)).
- Model 33 ASR: sans-serif grotesk for keycap legends ([`665923e`](https://github.com/amesk/yaPDP/commit/665923e)).
- Model 33 ASR: stack the punch above the reader with the historical 2x2 button layout ([`dc2ceac`](https://github.com/amesk/yaPDP/commit/dc2ceac)).
- Model 33 ASR: refine punch tongue, button alignment and punch block height ([`149fc61`](https://github.com/amesk/yaPDP/commit/149fc61)).
- Model 33 ASR: align the tape unit bottom with the keyboard deck bottom ([`5c43e86`](https://github.com/amesk/yaPDP/commit/5c43e86)).
- Model 33 ASR: console paper grows to the top of the window like the LP11 printer page ([`1163675`](https://github.com/amesk/yaPDP/commit/1163675)).
- Scale the LP11 printer cabinet to fit the window like the VT52 console ([`e22f721`](https://github.com/amesk/yaPDP/commit/e22f721)).
- Move the autoloading balloon to the top of the window ([`6b76eb1`](https://github.com/amesk/yaPDP/commit/6b76eb1)).
- Center the teletype tear/save buttons on screen like the PANEL actions ([`11b7bdc`](https://github.com/amesk/yaPDP/commit/11b7bdc)).
- Config page: clarify which settings require Apply and which apply immediately ([`f4cf32e`](https://github.com/amesk/yaPDP/commit/f4cf32e)).
- Remove the DIGITAL logo from the bottom of the navigation sidebar ([`ba858c6`](https://github.com/amesk/yaPDP/commit/ba858c6)).
- Remove the external link from the 'Open the PDP-11/70 emulator' walkthrough step ([`02cc040`](https://github.com/amesk/yaPDP/commit/02cc040)).
- Order the Image load interrupted dialog buttons: "Got it" before "Open Storage" ([`f971c52`](https://github.com/amesk/yaPDP/commit/f971c52)).
- Teletype: proportionally scale the Model 33 ASR rig to fit the window; divide paper/tape max-heights by the scale and fix subpixel punchtape seams ([`d0a0d25`](https://github.com/amesk/yaPDP/commit/d0a0d25)).
- Panel: proportionally scale the front panel with the Help Me! sticker to fit narrow windows ([`cbd80e5`](https://github.com/amesk/yaPDP/commit/cbd80e5)).

### Fixed

- VT52 bell (BEL): let 0x07 reach the terminal and always ring/flash ([`08cc77e`](https://github.com/amesk/yaPDP/commit/08cc77e)).
- VT52: do not render bold/underline attributes in VT52 mode ([`6e98ae5`](https://github.com/amesk/yaPDP/commit/6e98ae5)).
- VT52: restore the authentic 4:3 aspect ratio on the tube ([`ae0c294`](https://github.com/amesk/yaPDP/commit/ae0c294)).
- VT52 cabinet side panel overflowing the case on Windows 10 ([`334940c`](https://github.com/amesk/yaPDP/commit/334940c)).
- Tear sound plays only when paper/tape is actually torn off ([`72d914b`](https://github.com/amesk/yaPDP/commit/72d914b)).
- Restore the cycling POWER LOCK key click alongside the position labels ([`8f20c55`](https://github.com/amesk/yaPDP/commit/8f20c55)).
- POWER LOCK: clicking the LOCK label keeps the key pointing at LOCK instead of leaving it on POWER (ON) — the front-panel switches are now properly disabled while the panel is locked.
- LP11 whirr sound no longer aborted by a play/pause race in the renderer ([`60bbc70`](https://github.com/amesk/yaPDP/commit/60bbc70)).
- REBOOT description: the default loader boots only when Auto-boot is enabled ([`92b1bf3`](https://github.com/amesk/yaPDP/commit/92b1bf3)).

### Documentation

- User manual page linked from the landing page ([`8bca590`](https://github.com/amesk/yaPDP/commit/8bca590)).
- Screenshot generator; user manual illustrated with emulator screenshots ([`f4ce4a5`](https://github.com/amesk/yaPDP/commit/f4ce4a5)).
- Per-tab config, dialog and Lunar Lander illustrations for the user manual ([`3812fa4`](https://github.com/amesk/yaPDP/commit/3812fa4)).
- Remove the ExampleBoots link and add author contact on the instructions page ([`16b08c1`](https://github.com/amesk/yaPDP/commit/16b08c1)).
- README: toolchain installation section for the desktop build ([`a47159b`](https://github.com/amesk/yaPDP/commit/a47159b)).
- Document every Config page option in the user manual ([`3524994`](https://github.com/amesk/yaPDP/commit/3524994)).
- Guest-OS screenshot generator and landing-page OS carousel ([`553058e`](https://github.com/amesk/yaPDP/commit/553058e)).
- XXDP+ diagnostics screenshot added to the guest-OS carousel ([`7ea4706`](https://github.com/amesk/yaPDP/commit/7ea4706)).
- Document the fast teletype speed used for guest-OS screenshots ([`af0d6f9`](https://github.com/amesk/yaPDP/commit/af0d6f9)).
- Fix onboarding screenshot capture in the manual generator ([`0f568a2`](https://github.com/amesk/yaPDP/commit/0f568a2)).
- Regenerate user-manual screenshots ([`460137e`](https://github.com/amesk/yaPDP/commit/460137e)).
- Regenerate landing-page carousel screenshots ([`dfcb1cd`](https://github.com/amesk/yaPDP/commit/dfcb1cd)).

### Chore

- Remove OS/editor junk entries from `.gitignore` ([`ba26696`](https://github.com/amesk/yaPDP/commit/ba26696)).

## [0.1.0-alpha1] - 2026-08-19

Initial public alpha release.

[0.1.0]: https://github.com/amesk/yaPDP/compare/v0.1.0-alpha2...releases/v0.1.0
[0.2.0]: https://github.com/amesk/yaPDP/compare/releases/v0.1.0...releases/v0.2.0
[Unreleased]: https://github.com/amesk/yaPDP/compare/releases/v0.2.0...HEAD
[0.1.0-alpha2]: https://github.com/amesk/yaPDP/compare/releases/v0.1.0-alpha1...v0.1.0-alpha2
[0.1.0-alpha1]: https://github.com/amesk/yaPDP/releases/tag/releases/v0.1.0-alpha1
