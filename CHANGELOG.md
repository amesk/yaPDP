# Changelog

All notable changes to **yaPDP — Yet Another PDP-11/70 web emulator** are
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A **Force PDP Output Uppercase** CONFIG option (Equipment tab, on by default)
  prints the console teletype's output in upper case: a real Model 33 ASR has no
  lower-case type, so a loader that writes lower case cannot put those letters on
  the paper. The punched tape keeps the raw code — reading such a tape in LOCAL
  prints upper case while LINE delivers the original lower case to the machine —
  and a VT52 console, which prints both cases, is unaffected. Applied
  immediately. (`src/config.js`, `src/g60printer.js`, `src/pdp11-app.js`,
  `pdp11.html`)

- A floating **VT52 zoom** button hides the cabinet and grows the tube to the
  largest 4:3 box the window allows, clearing the corner controls. The state is
  per terminal (console TT0, TTY 1, TTY 2) and persisted between sessions; the
  button is hidden where no VT52 terminal is shown, and its icon mirrors the
  current state. (`src/vt52zoom.js`, `src/config.js`, `css/pdp11.css`,
  `pdp11.html`)

- **A phosphor choice for the VT100's tube: P4 white or P1 green.** The white
  phosphor is the one the VT100 was introduced on in 1978 and the only tube the
  DECscope ever shipped with; green is what late-1970s and 1980s terminals are
  known for, and the project's green is muted rather than the bright shade of
  period film. The option belongs to the VT100 alone — the VT52 pins P4 through
  its dialect's power-on state, because it was never sold in another phosphor —
  which is exactly what the dialect seam is for: the engine stores the palette
  and the dialect decides whether it may change. The choice is applied and saved
  the moment the radio moves, so it needs neither Apply nor a reload.
  (`src/config.js`, `src/terminal-core.js`, `src/vt52.js`, `src/dialect/vt100.js`,
  `src/pdp11-app.js`, `css/pdp11.css`, `pdp11.html`)

- **Double click on a terminal screen toggles zoom**, the same action as the
  floating button. Counted from two `click`s inside 400 ms rather than taken from
  `dblclick`: the tube is a canvas with `user-select: none` and Chrome does not
  raise a `dblclick` over it (measured — both clicks arrive, the composite event
  never does). The gesture names its own terminal, so a double click on TT1 does
  not zoom the console. (`src/pdp11-app.js`, `src/vt52zoom.js`)

- **The emulator now works on phones and tablets.** A touch device has no
  physical keyboard, so the VT52/VT100 terminals gain an on-screen one: tapping a
  tube focuses an invisible textarea that raises the system keyboard, and the
  typed bytes reach the machine through the same paths as a physical keyboard.
  The Model 33 ASR keeps its own drawn keycaps — the printed ones plus
  CTRL/SHIFT/REPT/BREAK/HERE IS on the punch keyboard — and never raises the
  system keyboard: a phone's keyboard cannot latch SHIFT or CTRL. Typing is
  delivered keystroke by keystroke,
  including while an Android keyboard composes the word it is about to commit. A
  **special-key bar** covers what an
  on-screen keyboard will not give up: CR (its Enter arrives as an IME action, if
  at all), ESC, TAB, BS, RUBOUT and the control codes ^C/^D/^Z/^S/^Q, with a
  latching CTRL that sends the next character as its control code (Ctrl+C =
  0x03, exactly the hardware arithmetic). The bar docks under the navigation bar,
  shows on the VT52/VT100 pages only — the terminals with no keys of their own —
  and types into the terminal whose page is on screen, canvas or text mode.
  **Two fingers zoom and pan the machine pages** (the front panel,
  the Model 33 rig, the VT52/VT100 cabinets, the LP11 and the VT11), which is the
  emulator's own gesture and therefore also works where the browser has no page
  zoom at all — a home-screen app or a desktop WebView; where the browser does
  zoom the page (a tab, the landing page's iframe) the module sees the visual
  viewport move and steps aside, leaving that behaviour alone. The view returns
  to 1:1 when the operator leaves the page. The operator CONTROLS of those pages
  — the Model 33's button row, the printer's console and Print/Save row, the
  front panel's action buttons — are not part of the picture: they are moved into
  a layer that carries the inverse of the zoom, so they keep their own size and
  place while the machine grows behind them, and they dock as one strip under the
  floating buttons (Reboot/State left, Quick Boot right) instead of colliding
  with them. The page declares a **mobile
  viewport** (`width=device-width`, with pinch-zoom left enabled): without it a
  phone laid the emulator out at the browser's ~980 px desktop fallback, where
  the media block below never matched and the page could not be zoomed. Below
  768 px the navigation sidebar becomes a compact bar along the bottom edge, the
  floating controls move clear of it, and the CONFIG/Storage tabs wrap instead of
  running off the screen. The emulator's state and timing loops are untouched.
  (`src/mobile-input.js`, `src/mobile-keys.js`, `src/touchzoom.js`,
  `src/pdp11-app.js`, `css/pdp11.css`, `pdp11.html`,
  `tests/e2e-mobile-input.js` — `npm run e2e:mobile`, in `validate`)

### Fixed

- **The cursor no longer lags half a second behind the text.** Moving the cursor
  called `render(false)`, which in canvas mode repaints nothing at all — the
  drawn cursor stayed where it was until the next 500 ms blink tick, while the
  character it had moved past was already erased. Which delay you saw depended on
  the tick's phase, so it looked intermittent: one backspace seemed instant and
  the next waited. Cursor movement now repaints the cursor itself (backspace,
  carriage return and tab), through a shared `repaintCursor()`.
  (`src/terminal-core.js`)

- **The CONFIG fields that depend on a terminal's dialect now follow the form,
  and count only the terminals that exist.** Two faults in the same pass:
  the terminal-type selects and the terminal-count select only re-marked the form
  dirty, so switching TT1 between VT52 and VT100 left the phosphor, key-click and
  reverse-video fields stale until a page reload; and the check read every type
  select, so a value left in the select for a terminal that is NOT installed
  (TT2 while the count is 1) claimed a VT100 the machine does not have. The
  reverse-video field also had no id, so it could not be dimmed at all — it now
  dims when no VT52 is installed, mirroring the two VT100 fields.
  (`pdp11-app.js`, `pdp11.html`)

### Added

- **An end-to-end suite for the VT100 terminal itself** (`tests/e2e-vt100.js`,
  `npm run e2e:vt100`). The guest-boot suite already boots RT-11 on a VT100
  console, but it watches the GENERATED output — it would pass just as happily if
  the VT100 never drew a cabinet, or drew the DECscope's. This one asserts the
  terminal the way an operator sees it, on a machine holding a VT100 console plus
  a DECscope on tty1 and a VT100 on tty2, so every check compares the two
  dialects rather than trusting one: the rig's dialect and artwork, the canvas
  filling the tube, the phosphor reaching the VT100 and NOT the DECscope, reverse
  video flipping the DECscope and NOT the VT100, the key click belonging to the
  VT100 alone, zoom by button and by double click (including the marker-offset
  regression), and the terminal types surviving validation and driving what the
  machine actually builds. It runs in `validate` next to the other e2e suites.

### Changed

- **The quick-boot wizard puts the teletype on LINE before it types.** Its steps
  go straight into the machine's console input, but the machine's answers only
  reach the teletype paper on LINE — with the CCU left in OFF or LOCAL a freshly
  booted guest showed nothing at all, which read as a hung machine. The wizard
  also stops a feeding reader tape (START, and AUTO where the guest's own X-ON
  can start it), so its bytes cannot land in the middle of the boot.
  (`src/quickboot.js`)
- **The second user terminal is filled after the first, not around it.** TT2's
  select is disabled while TT1 says None, and clearing TT1 clears TT2 with it.
  The earlier behaviour filled TT1 behind the operator's back when TT2 was
  chosen, which worked but asked them to trust a field they had not touched; a
  slot that cannot be used says the same thing without the surprise. The two
  selects also sit as one pair now, with the hint on its own line beneath them.
  (`pdp11.html`, `css/pdp11.css`, `src/pdp11-app.js`)

- **The Equipment tab is driven by selects, and a terminal's number is derived
  from its type rather than set beside it.** The console terminal and the
  teletype speed became drop-downs like the rest of the form, the speed options
  are named by their rate (10 chars/sec — authentic, 33 — accelerated) with the
  authentic one spelled out in the hint, and the separate user-terminal COUNT is
  gone: TT1 and TT2 each name themselves (`None | VT52 | VT100`) and the number
  of terminals is read off them. A count and a list can disagree, and did — a
  value left in TT2's select while the count said 1 claimed a terminal the
  machine did not have. TT1 must be filled before TT2, so a terminal numbered 2
  with none numbered 1 is now impossible by construction. The CRT-effects copy
  no longer claims VT52: the effect covers every terminal screen.
  (`pdp11.html`, `src/pdp11-app.js`)

- **A rig states its dialect once, and everything follows from it.** The cabinet
  file, the phosphor, the reverse-video switch, the key click and the zoom tube
  numbers each used to work out "which terminal is this" on their own — from a
  getter, a CSS class, a markup attribute or a proxy for one — and eight separate
  bugs this session came out of those copies disagreeing. A rig now carries
  `data-dialect="vt52|vt100"`, stamped by `initVT52Page` from the same table that
  names its initializer and artwork, and the stylesheet, the artwork loader and
  the marker rules all read that instead of a proxy. `data-artwork` disappears
  from the CSS entirely. (`pdp11.html`, `src/pdp11-app.js`, `src/terminal-core.js`,
  `css/pdp11.css`)

- **The key click belongs to the VT100.** It was offered to the DECscope as
  period flavour, but the DECscope's keyboard was mechanical and had no such
  setting — the VT100 is the terminal with a key-click option. The hook now
  receives the unit that was typed on and asks that terminal whether it takes a
  click at all: a DECscope stays silent even with the option on. The CONFIG field
  reads "VT100 key click" and dims when no VT100 is installed, like the phosphor
  field. (`src/config.js`, `src/pdp11-app.js`, `src/terminal-core.js`,
  `src/vt52.js`, `src/dialect/vt100.js`, `pdp11.html`)

- **A terminal's capabilities are now stated by the terminal.** The two dialects
  share one registry, so "reachable through `vt52Get()`" stopped meaning "is a
  VT52" — and the CONFIG switches for phosphor and reverse video leaked onto
  whichever terminal happened to sit on the unit. Each dialect now declares what
  it accepts (`acceptsPhosphor`, `acceptsReverseVideo`) and the host asks instead
  of assuming. The VT100, being a superset of the VT52, must opt OUT explicitly
  of capabilities it lacks — inheritance hands it the base's opt-ins otherwise.

- **Reverse video is the DECscope's switch, and now stays on the DECscope.** The
  flip was a class on `<body>`, so it repainted every tube including the VT100's;
  it now sits on the DECscope rigs only (`.vt52-rig.reverse-video:not([data-artwork])`).
  The VT100 has no such control — only the SGR 7 attribute software sends.
  (`css/pdp11.css`, `src/pdp11-app.js`, `src/vt52.js`, `src/dialect/vt100.js`)

- **A user terminal takes the cabinet its dialect names.** The console page
  hard-coded `data-artwork` in the markup and TT1/TT2 had none, so a VT100 user
  terminal kept the DECscope backdrop whatever it was built as. `initVT52Page`
  now stamps the artwork from the same dialect table that carries the initializer
  and the getter. (`src/pdp11-app.js`)

- **The artwork fetches no longer race**, and each rig takes only the file it
  asked for. Both files were fetched in parallel and the DECscope's response
  filled *every* backdrop, so a VT100 console showed the DECscope cabinet
  whenever `vt52.svg` happened to land second — intermittent, load by load. The
  marker numbers had the same fault, keyed on "has it received its own yet"
  rather than on what the rig named. (`src/terminal-core.js`)

- **Zoom's tube position and the VT100's maximal case.**
  The marker numbers (where the painted glass sits inside the artwork) outranked
  `.vt52-zoomed .vt52-crt` on selector weight — a class plus an attribute beats
  two classes — so a maximised VT100 planted the tube at the marker's offset
  inside a box built for zoom; the rule is scoped to `:not(.vt52-zoomed)`. And
  zoom builds its case in CSS rather than from the artwork, so a maximised VT100
  wore the DECscope's off-white moulding: it now uses the artist's own hull
  colour, flat — the same saturated sand that reads well on a cabinet glared
  across a whole screen, and it was the three-stop gradient and the radial
  highlight that did it, not the colour. (`css/pdp11.css`)

- **The VT100 cabinet artwork is now a real vector drawing.** `assets/vt100.svg`
  replaces the placeholder derived from the DECscope: it is authored from scratch
  (Hull, keyboard layers, Keycaps, DEC logo) at 160 KB instead of carrying an
  800x623 raster underlay, so the stylesheet can reach inside it — the same
  property the DECscope artwork has, and the reason the glass can be recoloured
  at all. Its `Markers`/`Screen` guide layer is hidden exactly as the DECscope's
  is (`display:none` on the layer AND on the rect, because a rect's own
  `display:inline` outranks its parent's `none`), and the glass is the console
  background colour (`#141914`, matching `BG_COLOR` in `src/terminal-core.js`).
  Its Screen marker keeps the DECscope's 112.852x84.639 tube at 4:3.

  The artwork is larger on screen than the DECscope, by choice: both rigs are
  1074x830 CSS px, so the smaller viewBox (255.12x192.49 against 284.23x219.66)
  scales the cabinet up. That was deliberate — the tube reads bigger.

  The tube box cannot be derived at runtime (nothing rewrites `left/top`), so
  `css/pdp11.css` carries the four numbers for whichever artwork a rig names
  through `data-artwork`, measured against the rendered marker rather than
  parsed out of the SVG: the artwork nests its marker inside transformed groups,
  and a transform chain contributes scale as well as offset. Parsing the
  translate alone left the canvas 45x42 px short and 16x11 px off.
  (`assets/vt100.svg`, `css/pdp11.css`)

- **The maximised VT100 is drawn in its own plastic, and the tube lands in its
  frame again.** Two separate faults, both from the artwork arriving after the
  zoom was written for the DECscope. The tube's marker numbers (where the painted
  glass sits inside the artwork) outranked `.vt52-zoomed .vt52-crt` on selector
  weight — a class plus an attribute beats two classes — so a maximised VT100
  planted the tube at the marker's offset inside a box sized for zoom; the rule
  is now scoped to `:not(.vt52-zoomed)`. And zoom builds its case in CSS rather
  than from the artwork, so the VT100 wore the DECscope's off-white moulding:
  it now uses the artist's own hull colour, flat. Flat matters — the same
  saturated sand that reads well on a cabinet glared across a whole screen, and
  it was the three-stop gradient and the radial highlight that did it, not the
  colour, which is kept exactly as drawn. (`css/pdp11.css`)

- **The engine no longer knows which terminal it is driving.** The engine's four
  points of contact with its dialect are now explicit hooks: `attrMask()` (which
  attributes the tube can draw), `cursorIsBlock()` (cursor shape),
  `graphicsChar()` (character-set translation) and `translateKey()` (the bytes a
  keystroke transmits). `src/terminal-core.js` contains no reference to the
  VT52/VT100 mode flag at all — it stores it as the neutral `modes.dialect` and
  hands it to the dialect — so a new terminal is a new dialect file, not a patch
  to the engine. Instances with no registered dialect fall back to plain DEC
  defaults instead of failing. (`src/terminal-core.js`, `src/vt52.js`)

- **The terminal engine is now separate from the VT52 dialect.** The 2 724-line
  `src/vt52.js` split into `src/terminal-core.js` (the dialect-independent engine:
  screen buffer, cursor physics, scroll regions, destructive operations, SGR,
  character output and overstrike handling, the three rendering paths, artwork
  projection) and `src/vt52.js` (the VT52/VT100-compatibility dialect: escape
  grammar, DECMODE, DECSTBM, static keymaps and graphics tables). Behaviour is
  unchanged — the public surface (`vt52Initialize` and friends) is identical, so
  nothing else had to move — and the engine is now reusable by further terminal
  dialects (a native VT100 is the next one). `src/terminal-core.js` must load
  before any dialect that extends it. (`src/terminal-core.js`, `src/vt52.js`,
  `pdp11.html`, `tests/vt52.test.js`, `tests/vt52-svg-backdrop.test.js`)

- **The Model 33 ASR TAPE PUNCH buttons are plungers, not discs.** Each button
  is the Ø28 panel boss the old round cap was — a moulded bulge of the cabinet,
  so it wears the cabinet's own sand and reads as a slightly flattened oval — with
  a light Ø14 plunger rising 20px out of it, perpendicular to the panel, and its
  free end closed by a flat oval cap that can be turned on its own. Each legend is
  printed on the panel beside its own button (above the top row REL/OFF, below the
  bottom row BSP/ON), and a press retracts the plunger alone: the boss and the
  legend hold still. (`css/g60printer.css`, `pdp11.html`, `assets/Model-33-ASR.svg`)

- **The Model 33 ASR CCU switch is a tall cylinder the operator grips by its
  sides.** The knob stands proud of the apron pad with its axis pointing at the
  operator and to the right; the pointer is a moulded lever at its base, its
  root on the footprint ring's rim and its thickness cast towards the viewer.
  The lever still sweeps LINE / OFF / LOCAL, its moulding stays screen-aligned
  while it turns, and the end cap carries no outline, so it never reads bigger
  than the cylinder it caps. (`css/g60printer.css`, `src/pdp11-app.js`,
  `pdp11.html`)

- **The quick-boot profiles state the console type explicitly, and teletype
  scenarios request the new force-upper output.** `src/osboot.js` no longer
  leaves the console to the operator for the RSTS, RSTS/E, RSX-11M and XXDP
  scenarios (each now names `teletype` or `vt52`), and every teletype scenario
  carries the new `forceUpperCaseOut` profile key. BSD 2.11 keeps a VT52 console:
  it is the one guest whose loader does not detect a teletype and prints lower
  case. The flag is applied live by the wizard — it never triggers a reload
  (`QuickBoot.liveProfile()`). (`src/osboot.js`, `src/quickboot.js`)

- **The two slow headless BSD boot checks moved to the e2e suites.**
  `tests/bsd-boot.test.js` → `tests/e2e-bsd-boot.js` and
  `tests/bsd29-boot.test.js` → `tests/e2e-bsd29-boot.js`: they shake out the
  whole emulator core (CPU → bus → MMU map → UDA50/RP11/RL11 → console →
  bootstrap → kernel → init → getty → login), so by the `tests/e2e-*.js`
  convention they no longer run inside `npm test` (which drops from ~4.5 min
  to ~1 min; the other 47 files take ~1.5 s in total). They now run in CI
  next to `e2e-osboot`, and locally via `npm run e2e:bsd` /
  `npm run e2e:bsd29`; `npm run validate` still runs everything.
 The body,
  platen, carriage window and Teletype wordmark come from
  `assets/Model-33-ASR.svg` (a `pointer-events: none` backdrop); the live
  controls — keyboard, punch/reader plates, CCU knob, printed sheet and both
  hanging tapes — anchor to the artwork's marked areas in one coordinate
  system. (`assets/Model-33-ASR.svg`, `src/pdp11-app.js`, `css/g60printer.css`,
  `pdp11.html`)
- The hanging ASR tapes answer each punched/read row with a short damped swing
  (punches pull one way, BSP the other) and are scrolled with the wheel only —
  no painted scrollbar. (`src/punchtape.js`, `src/reader.js`,
  `css/g60printer.css`)
- The TAPE PUNCH buttons use the Model 33 keycap look; the TAPE READER switch
  is the authentic vertical four-detent lever; the CCU switch is the real
  two-step knob. (`src/pdp11-app.js`, `css/g60printer.css`, `pdp11.html`)
- **VT52 DECscope: the cabinet is drawn from SVG artwork.** The body, bezel,
  glass and keyboard come from `assets/vt52.svg`, whose Screen marker is read
  at runtime so the canvas is projected onto the tube — moving the marker in
  Inkscape moves the screen. The artwork is inlined into `.vt52-backdrop`
  (a background image cannot be restyled), which lets the glass swap between
  the dark and the light plate in reverse video, and the decorative badge and
  status row are gone. (`assets/vt52.svg`, `src/vt52.js`, `src/pdp11-app.js`,
  `css/pdp11.css`, `pdp11.html`)

### Removed

- The Model 33 "Drawn in the artwork" keyboard-source option. (`src/config.js`,
  `src/pdp11-app.js`, `pdp11.html`)

### Fixed

- Reading past the end of a mounted disk/tape image no longer stops the
  machine: the missing cache block is now created explicitly, so the guest
  gets a completion (zeros — a tape sees its record mark and ends the read
  cleanly) instead of an endlessly repeated fetch. Hit short dragged-in
  `.tap`/`.dsk` files, HTTP 416 range answers and truncated `.zst` images.
  (`src/iopage.js`, `tests/iopage-pastend.test.js`)
- The VT52 fit is recomputed on both zoom transitions instead of waiting for a
  window resize: leaving zoom no longer clips the lower half of the cabinet, and
  entering zoom no longer draws the maximised screen at the old cabinet scale.
  (`src/pdp11-app.js`)
- The VT52 tube is projected onto the artwork's Screen marker: the stylesheet's
  px offsets include the Markers layer's own translate and agree with
  `assets/vt52.svg`, and `tests/vt52-svg-backdrop.test.js` pins all four numbers
  to the artwork, so a re-save in Inkscape cannot leave the canvas drifting off
  the drawn glass. (`assets/vt52.svg`, `css/pdp11.css`,
  `tests/vt52-svg-backdrop.test.js`)
- Manual screenshots are regenerated for the new teletype artwork, written to
  both the repo source and the landing mirror. (`tools/screenshots-manual.js`)
- `headless-term` batch runs keep the whole guest output and execute the first
  scripted command: the first guest line waits for the guest's prompt, and
  pending output is flushed before the tool exits. (`tools/headless-term.js`)
- **The last `Boot>` references are gone: the prompt is `@`.** The monitor has
  printed `@` since the bootstrap was rebuilt, yet the first-run hint, the
  quick-start steps (landing, emulator and manual), the two console screenshot
  captions and every transcript in `docs/ExampleBoots.md` still sent the
  operator looking for `Boot>`. (`src/onboarding.js`, `pdp11.html`,
  `index.html`, `manual.html`, `docs/ExampleBoots.md`, `src/osboot.js`,
  `src/quickboot.js`, `src/pdp11-panel.js`, `tools/screenshots-manual.js`)

### Added

- **A startup loading gate holds the first frame.** The overlay is inline in
  `pdp11.html`, so the very first painted frame already covers the page, and it
  is lifted only when the Model 33 artwork markers, the terminal artwork markers,
  the first-screen webfonts and `media/manifest.json` are ready: before this the
  CSS fallback artwork painted first and the real art, the fonts and the manifest
  replaced it piece by piece, so a slow link showed two different machines in a
  row. Sounds, the machine-room photo, alternative panels and the disk/tape
  images keep loading behind the gate — none of them is needed for the first
  screen. Every source is best-effort (a failure resolves its slot instead of
  hanging) and a 15 s ceiling lifts the gate regardless. (`src/loading-gate.js`,
  `pdp11.html`, `src/pdp11-app.js`, `css/g60printer.css`)

### Changed

- **The Model 33 artwork is 96% lighter and is fetched once.** `assets/Model-33-ASR.svg`
  went from 2.0 MB to 75 KB, and the teletype rig downloads the file it names
  instead of asking for it twice, so the console page reaches its real look
  sooner on a slow link. (`assets/Model-33-ASR.svg`, `src/pdp11-app.js`,
  `css/g60printer.css`)

- The user-manual and guest-OS screenshots are regenerated for the VT100, the
  retuned Equipment tab and the lighter teletype artwork, written to both the
  repo source and the landing mirror. (`tools/screenshots-manual.js`,
  `tools/screenshots-os.js`)

## [0.2.0] - 2026-09-10

### Added

- Demo-reel narration: the intro, each clip's title card and the outro are
  spoken (Kokoro-82M locally by default, Windows SAPI as fallback); narration
  is cached, cards stretch to fit the speech, and music ducks under it.
  (`tools/voicer.js`, `tools/assemble-video.js`, `tools/reel-voice-util.js`)
- Timed reel events recorded with each clip — chapters, banner titles, spoken
  phrases, bottom subtitles — turned into narration, burned overlays and
  `.chapters.txt`/`.srt` sidecars. (`tools/record-video.js`,
  `tools/assemble-video.js`, `tools/reel-timeline-util.js`)
- Server-side promo-video build (`build-promo-videos` workflow): records every
  guest-OS clip and assembles the reel + per-clip MP4s on CI, uploaded as an
  artifact. (`.github/workflows/videos.yml`)
- Cross-platform drawtext fonts (`tools/reel-font-util.js`): repo-committed
  faces on Linux/macOS instead of Windows-only Consolas/Arial.
- `bootHeadless` readiness by console silence (`stableMs`), for booting an
  unknown guest image without a known prompt. (`tools/headless-machine.js`)

### Removed

- The browser (Web Speech / DirectShow loopback) voice engine — narration is
  Kokoro-82M or Windows SAPI only. (`tools/voicer.js`)

### Fixed

- Desktop builds: bundled images are mounted in parallel and consumers wait
  for the bundle, so images that used to load last (Lunar Lander's paper tape,
  the ra*/rp* disks) are no longer read empty at guest start.
  (`src/tauri-bundled.js`, `src/browser-machine.js`)
- Promo-video CI runs end to end; the verify step no longer reports the
  (present) audio as missing. (`.github/workflows/videos.yml`,
  `tools/assemble-video.js`)
- Lunar Lander no longer hangs in `?core=1` mode; the loader accepts a raw
  `.ptap` when no `.zst` exists; headless-term keeps guest output on timeout,
  resolves `:export` from the CWD and reports `:status` truthfully after a
  rewind. (`src/browser-machine.js`, `tools/headless-term.js`)

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
