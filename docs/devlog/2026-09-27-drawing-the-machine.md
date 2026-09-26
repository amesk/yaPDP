---
title: "Drawing the machine: how the teletype, the VT52 and the VT100 are built inside"
date: 2026-09-27
lang: en
summary: "Two ways of drawing text that barely touch each other — paper you cannot unprint and a tube you can rewrite — and why a button lands on a button only when the artwork says where."
---

[A teletype is not an xterm](2026-09-23-bringing-back-the-machine-room.html). The first article was about the magic, the second was about the ordinary engineering underneath. This one is about the drawing: how three machines are built on screen, where I got it wrong, and why the code still carries names that lie.

A fair warning: there is a lot of CSS, coordinates and strange numbers like `0.36657` in here. If the history of the hardware interests you more than layout, the first article is the one to read. The question this one keeps returning to is narrow — why a button ends up *not* on the button, and how to stop catching that by hand.

## Two machines, two natures

I assumed a terminal was a field where text gets printed, and a teletype was the same thing with paper. That turned out to be wrong almost entirely: what is being displayed has a different nature on each.

Paper is a consumable. What is printed is printed. At most a hammer strikes the same position twice. A screen is a matrix of cells and can be rewritten whenever you like — which is where everything from `vi` to the jumping cursors of installers comes from.

So there are two engines. The teletype is DOM: rows, characters, animations, the sound of the print head. The terminal is a `<canvas>` and a cell buffer. They share exactly one thing: the byte stream arriving from the DL11.

| | Model 33 ASR | VT52 | VT100 |
| --- | --- | --- | --- |
| What it shows | Paper | An 80×24 screen | 80×24, and it can do 132 columns |
| Drawn with | DOM over SVG | `<canvas>` | the same canvas, a different artwork |
| Bold, underlined | no | no | yes |
| Graphics | no | DEC Special Graphics | that, plus SO/SI |
| What moves | carriage, paper, paper tape | glyphs and cursor | glyphs and cursor |
| Pace | about 10 characters a second | immediate | immediate |

At first the split annoyed me — one renderer for everything would have been tidier. I got used to it, and now I think it is the better arrangement: different physics of output live in different files, so when I go and fix the paper I cannot break the tube. Sharing code between the two devices would never have given me that guarantee.

## A teletype: the artist's plastic, my switches

The first idea was to draw the whole machine in SVG, keyboard included, and catch clicks with hitboxes. I spent a couple of evenings on it. It ended in crooked hitboxes, odd pressed states and the classic "the button presses, but not always". That kind of thing can be debugged forever.

Out of that came a rule I still follow: **the artwork holds what cannot be pressed or moved.** Plastic. The cast plate. The Teletype Corporation engraving. Slots with nothing behind them. Everything else — the keyboard, `REL/OFF/BSP/ON`, the vertical reader lever, the paper, both tapes, the rotary CCU — is HTML laid over the picture.

[`assets/Model-33-ASR.svg`](https://github.com/amesk/yaPDP/blob/master/assets/Model-33-ASR.svg) sits behind as a background with `pointer-events: none`. The mouse never catches on it and clicks never fall through. A small thing that removed a whole litter of bugs in one move.

But then how does an HTML button know where to lie? It should not know. The artwork should say.

There is a hidden `Markers` layer in the SVG: eight rectangles with `id`s and `display: none` — `Keyboard`, `Apron`, `PuncherControl`, `PuncherTape`, `ReaderControl`, `ReaderTape`, `Paper`, `Caret`. The page reads them on load and lays the rig out from them:

```js
// src/pdp11-app.js
var TTY_MARKER_VARS = [
  { id: 'Keyboard',       prefix: '--tty-kbd'   },
  { id: 'Apron',          prefix: '--tty-apron' },
  { id: 'PuncherControl', prefix: '--tty-pctrl' },
  { id: 'PuncherTape',    prefix: '--tty-ptape' },
  { id: 'ReaderControl',  prefix: '--tty-rctrl' },
  { id: 'ReaderTape',     prefix: '--tty-rtape' },
  { id: 'Paper',          prefix: '--tty-paper' },
  { id: 'Caret',          prefix: '--tty-caret' }
];
```

This is still my favourite thing in the project. Move a marker in Inkscape, save, reload — the buttons have moved. There is no table of coordinates to keep in step with the drawing by hand. Such tables always drift apart; the only question is whether it takes a week or six months, and whether you notice or a user does.

The numbers in [`css/g60printer.css`](https://github.com/amesk/yaPDP/blob/master/css/g60printer.css) survive only as a fallback for builds where `fetch` does not work (strict `file://`). A test checks they still match the artwork, because without it there would be disorder there long ago.

A marker does not have to be a rectangle, incidentally. The machine is drawn in a slight perspective — the plate is turned, the sheet in the carriage lies at an angle — and a vertical rectangle on such a marker looks like a sticker. So a layer can be projected onto a quadrilateral by matrix, anchored one of three ways: at a corner, at the centre (the CCU), or as a sheet (the paper, whose width depends on the column count). Projection only engages when the marker really is a quadrilateral; while the artist has not tilted the part, nothing happens. An edit to the artwork cannot quietly break the layout.

The keyboard follows the same principle from the other end: one description, `MODEL33_KEYS`, produces both the drawn keycaps and the DOM boxes, on a grid of 40-unit pitch and 36-unit cells. They cannot drift apart physically — they have a common source. [`tests/model33-keyboard.test.js`](https://github.com/amesk/yaPDP/blob/master/tests/model33-keyboard.test.js) holds the numbers to the artwork, and [`tests/tty-quad-matrix.test.js`](https://github.com/amesk/yaPDP/blob/master/tests/tty-quad-matrix.test.js) checks the projection onto the tilted markers.

One last detail of the cabinet. Part of the drawing has to lie *over* the print: the platen felt, the punch head, the front edge. The paper must go under the roller, not lie on top of it. Those layers are marked `Foreground` in the artwork and inlined as a separate `pointer-events: none` overlay above every control.

## Paper

### Character by character

A line is not emitted whole. The printer descends from the "slow" mechanism of Google60 and lives in [`src/g60printer.js`](https://github.com/amesk/yaPDP/blob/master/src/g60printer.js), which has two paths: per-character, for echo when a character arrives from the machine, and per-line, when a chunk of output lands on the paper. The first one buffers characters and takes them out one at a time:

```js
function printChar(c) {
    charBuffer.push(c);
    if (!charPrintTimer) charPrintTimer = setTimeout(processCharBuffer, charPrintDelay);
}
```

`charPrintDelay` is the "teletype speed" from CONFIG: about ten characters a second (110 baud), or a faster pace for demonstrations. That feeling cannot be faked by anything else. You sit and wait while the bootstrap finishes printing.

At my day job I work with Qt widgets, web stacks and mostly backends, where an artificial delay is usually a defect someone asks you to remove. Here it is the other way round. The delay has to stay, because the delay **is** the product. A strange sensation, tuning for slowness what you have spent a career tuning for speed.

The per-line path works differently — in batches of identical columns rather than one character at a time. The head crosses a space column in 7 ms and a character column in 12 ms, and on a character it also strikes the paper. A run of like columns is crossed in one jump, up to the first change:

```js
var isSpace = b[headPos];
var p = headPos + headDir;
while (p !== t && b[p] === isSpace) p += headDir;
movePrintHead(p, isSpace ? delayBlank : delayChar, !isSpace, ...);
```

The logic is mechanical: crossing empty space is easier than hammering out a dozen characters. On the real machine a space is still the carriage moving, just without the strike.

### CR is a carriage ride

The carriage return is animated. The head actually travels back to the left margin, and on this machine that is a noticeable hundred milliseconds:

```js
// ASR возвращается ~100 мс, LP11 (300 строк/мин) — мгновенно
var carriageReturnMs = (typeof opts.carriageReturnMs === 'number' && opts.carriageReturnMs > 0)
    ? opts.carriageReturnMs : 0;
```

The window for the trip is always the same — the whole return fits into about a hundred milliseconds however many columns are left. The distance is not. From the middle of a line the head covers less ground and therefore moves more slowly. I first wrote in a comment that a return from the middle was "faster", then re-read the code and rewrote the comment: it is not faster, it is shorter.

The head lifts on the strike rather than on the return: before printing a character it rises by a pixel and comes down onto the paper 6 ms later, with a little random variation in height. Without that variation the mechanism looks like a robot, and it shows even at ten characters a second.

### LF, which does not return the carriage

Small things like this are why I started on this hardware at all. On an ASR-33, a line feed only advances the paper. The carriage stays in its column and the next character prints directly below the previous one. The LP11 has no carriage at all, so there a line feed starts a new line at the left margin.

```js
var lfKeepsColumn = (opts.lfKeepsColumn === true);
```

What is funny is that this is implemented with the same material the text is printed with: the new line is begun by non-breaking spaces (`\u00A0`) that reproduce the column. There is no separate "carriage position" in the model. On paper the carriage does not exist; what exists is what has already been printed. It took me a while to get used to that, and then I decided it was more honest.

Overstrike lives in the same place — the one from `man` and `nroff`. A letter struck a second time. Different characters in one position give a dark backing, the class `overstrike` and the colour `#3a3a3a`; the same glyph printed twice gives bold; an underline over a letter or a letter over an underline gives `span.underline`. And when the carriage has already hit the right stop, every further character is pressed into the last column and accumulates the unreadable blot a real ASR-33 produces if you do not notice the line has ended.

Separate from all of that is `missedCharOpacity`, and here I lied to myself: I thought it was about overstrike. It is about mechanics. The print unit sometimes fails to strike cleanly — a random character gets a microscopic shift up or down and reduced opacity. On a real machine that happens with a loose hammer, and on paper you see it immediately as gaps of random "under-strikes".

### The width of the sheet

Paper does not adapt to its contents and does not scroll sideways. It is calculated for the width of the carriage — 72 or 80 columns for the ASR. The geometry is a pure function so it can be run in Node without a browser:

```js
function computePaperGeometry(cols, opts) {
    var contentWidth = cols * cw;                       // 7px на знак
    var paperWidth = Math.min(contentWidth + 2 * paddingX + 2 * marginX, bodyWidth);
    var paperLeft  = leftSkin + Math.max(0, Math.round((bodyWidth - paperWidth) / 2));
    var headOffset = 30 + (paperLeft - leftSkin);
    ...
}
```

Margins of 33 px a side, padding for the printing area, a fixed machine width (the "skin" of the cabinet on either side): the sheet is centred between them and the head offset is recomputed to follow the sheet. Column 0 has to stay under the carriage, or the whole text slides relative to the drawn mechanism and you see it on the first run.

At the right margin, by the way, characters are not wrapped to a new line — they are pressed into the last column. The carriage hits the stop and keeps striking the same spot. There is no horizontal scrollbar and there cannot be. At first this annoyed me; then it landed that there is no other way: the carriage is a piece of iron, not a flag in a config file, and it stops physically.

That is what broke two tests I had written from memory. I was certain an overflowing line wrapped downwards and wrote the expectations for that. The tests had to be rewritten, not the code.

Geometry is recomputed by a `ResizeObserver`, but only while the page is visible. On a hidden page `clientWidth` is zero, and without that check the sheet collapses to nothing for anyone who opens the emulator in a background tab. I found that by accident, switching between tabs.

### Paper grows upwards

The most visible effect in the console: what is printed rises out of the machine, like a roll coming up from under the platen. The sheet is attached to the carriage from below and grows upwards because of `height: auto`.

The ceiling on that growth is not a constant but the live distance from the carriage to the top of the window:

```js
var bottom = paper.getBoundingClientRect().bottom;
container.style.setProperty('--tty-paper-max',
    (teletypePaperMaxHeight(bottom, 0) / scale) + 'px');
```

I spent more time on the division by scale than I would like to admit. The paper lives in a doubly scaled space: the rig is scaled as a whole, and the printer block once more when it fits into the `Paper` marker. Without dividing the local `max-height` by the product of the coefficients, the top of the sheet never reaches the edge of the window. On a short screen it is especially visible.

Once the ceiling is reached the sheet gets its own scroll. The ceiling is recomputed on resize, on a scale change and after markers are applied — all three move the carriage relative to the screen, so there is no other way.

## Screen

The second half, and the VT52 and VT100 share it. Everything lives in [`src/terminal-core.js`](https://github.com/amesk/yaPDP/blob/master/src/terminal-core.js); the dialects only supply details to the core.

### Why canvas, not DOM

Because of full-screen editors. A terminal has to do bold, underline, blink and inverse text, instantaneous cursor addressing, a blinking cursor, character insertion with a line shift. All of that can be done in DOM, but every cursor movement becomes a rebuild of hundreds of nodes, and the browser starts to choke exactly where `vi` needs it.

So: if there is a `<canvas>`, we draw in pixels. If not, a textarea mode works — text selection and the system clipboard in exchange for losing attributes. A third mode is LA36-hardcopy, where the terminal pretends to be a printing device; the VT52 starts there and enters screen mode lazily, the first time a program asks for cursor addressing.

### A cell is two numbers

```js
emptyCell() { return { c: 32, a: 0 }; }
```

`c` is the character code, `a` an attribute mask. The sparse array of rows is not about saving memory. Cursor addressing and wrapping at the right margin happily move the print somewhere nothing has been yet, and full-screen programs like to draw a couple of lines at the bottom and go off to think.

There is an asymmetry visible in the load. On canvas only the changed cell is repainted; in the textarea, everything. So the text mode is noticeably heavier, and that is why canvas stays primary. I keep the text mode for one scenario: when I run BASIC programs myself I am too lazy to type them through a model teletype, so I paste code from the clipboard. Attributes get lost, and I honestly do not care.

A cell is drawn either as a character or as a space with a background (for inverse), plus an underline if needed — a filled rectangle along the bottom edge of the cell rather than `text-decoration`. Bold is done by striking twice: the glyph is drawn again, shifted one pixel horizontally, with the font swapped to `bold <size>px <family>` as a backup. The logic is the same as nroff's overstrike, except the hammer is replaced by a second `fillText`.

### Attributes ask the dialect

The core stores attributes but does not decide what to do with them. It asks:

```js
static attrMask() {
    return ~(ATTR_BOLD | ATTR_UNDERSCORE);   // VT52: ни жирного, ни подчёркивания
}
static cursorIsBlock() { return false; }     // VT52 рисует подчёркивание
```

The DECscope had no SGR expressiveness, so in VT52 mode bold and underline must not reach the tube however they ended up in the cell — through overstrike or an escape sequence. The VT52 cursor is an underline, the VT100's is a block. A small thing, and from it you can tell which machine you are sitting at.

The dialect hands over graphics, keyboard and power-on state through the same seam. The core knows no VT52 or VT100 mode name at all — only a neutral flag it stores and returns.

### 4:3, the glyph and the cursor

The real VT52 drew an 80×24 grid on a 4:3 tube. A monospaced grid of 80 columns at 7–8 px is noticeably wider than 3:4 of the height, so the logical grid has to be compressed horizontally, exactly as the hardware did it with its sweep.

```js
gridMetrics() {
    const logicalW = this.screenPadding * 2 + this.cols * this.canvas.charWidth;
    const logicalH = this.screenPadding * 2 + this.rows * this.fontHeight;
    const width    = Math.round(logicalH * CRT_ASPECT);      // 4 / 3
    const scaleX   = logicalW > 0 ? width / logicalW : 1;
    ...
}
```

That goes into the context as `ctx.setTransform(scaleX, 0, 0, 1, 0, 0)`. `setTransform` replaces the transform rather than accumulating it, so a run of resizes does not pile up distortion — an easy thing to get wrong with `scale()`. In text mode the same coefficient is mirrored by a CSS transform on the textarea, so both implementations show one geometry. `screenPadding` lives here too: the inset that moves the grid away from the edges of the glass. Without it the text sticks to the bezel and looks like a homemade terminal.

The tube's font is the bitmap `fritzm/vt52`, falling back to `monospace` until it loads. There I hit an error that lasted a long time and looked like "the cursor is drawn badly". A bitmap terminal font inside an em box carries its own padding above and below. Draw it with `textBaseline = "top"` and the glyph sinks down the cell while a full-height block cursor sticks up above the letter. The fix is measurement:

```js
const m = this.canvas.ctx.measureText("M");
const ascent  = m.actualBoundingBoxAscent  || 0;
const descent = m.actualBoundingBoxDescent || 0;
this.glyphBaselineOffset = this.fontHeight / 2 + (ascent - descent) / 2;
```

One offset per line, not per glyph, so the baseline is fixed and letters do not float relative to each other. A bonus: swap the font and everything stays aligned. The cell width is not a constant either — after the web font loads, the host calls `setFont()`, which re-measures the "M", recomputes the canvas and repaints the tube.

## Phosphor, reverse video, flicker

A tube in code is a pair of colours. Glass and light; it is never one colour:

```js
const PHOSPHORS = Object.freeze({
    p4: Object.freeze({ fg: "#E0E0E0", bg: "#141914" }),  // трубка VT52 и VT100-1978
    p1: Object.freeze({ fg: "#2BD62B", bg: "#0A1A0A" })   // зелёный 80-х
});
```

P4 is the only tube the VT52 ever existed in. P1 is the green everyone remembers from films; in life it was considerably more restrained than in cinema. Reverse video swaps `fg` and `bg` and repaints the tube at once.

I could go on about the cinema green but I will not. I will only say that I first turned it up bright, "like in the films", and on a normal monitor my eyes were tired within ten minutes. The real P1 is softer. That is not a compromise, that is how it was.

Blinking is one timer at 500 ms, and it blinks the cursor too. There was a separate annoyance here: after a backspace or a carriage return the cursor stayed drawn in the old place, because the cursor is not part of the buffer and has to be repainted after every movement. There is now a shared `repaintCursor()`, and this is one of those cases where a small function closes a whole class of visual litter.

The glass itself is part of the artwork and cannot be recoloured from CSS, so the artist drew two paths with the same geometry, `Glass` dark and `GlassInverted` light, and CSS picks which to show. There is a lesson in what is *not* there: the tube has no CSS outline and no shadow. For a while `.vt52-crt` had a `box-shadow` drawing a second hard contour around the screen. While it coincided with the drawn one you could not see it; the moment the overlay slipped by a pixel it was obvious. Only the artwork draws the frame now.

One honest inaccuracy remains. The geometry variables are still `--vt52-*` and the rig class is still `.vt52-rig`, though there are two dialects now. Renaming would touch CSS, tests and both artworks at once, and I decided a comment in the code is cheaper than the risk of numbers drifting apart. A name that lies but is documented seems to me the lesser evil than a layout that has come apart.

## VT100

It arrived later than the VT52, and I spent a while wondering whether to make another terminal from scratch. I did not. The VT100 in hardware is a VT52 plus ANSI grammar, plus DEC private modes, minus the printing device. So in code it is a descendant: [`src/dialect/vt100.js`](https://github.com/amesk/yaPDP/blob/master/src/dialect/vt100.js) extends the VT52 class and overrides only where the machines really diverge.

The divergences are not cosmetic. The same bytes mean different things:

- `ESC E` — on a VT52, clear the screen and go home; on a VT100 it is NEL, that is CR + LF;
- `ESC Y row col` — direct addressing on the VT52. The VT100 does not know it at all;
- `ESC F` / `ESC G` — VT52 graphics; on the VT100 they are enabled by `SO`/`SI` with G0/G1 switches;
- `ESC Z` — "identify yourself" on the VT52 (it answers `ESC / K`); a VT100 does not answer `ESC Z` at all, but to a DA request (`CSI c`) it replies `ESC [ ? 1 ; 4 c` — which is "VT100 with AVO";
- `ESC =` and `ESC >` — VT52 keyboard mode; on the VT100 these are `DECKPAM` and `DECKPNM`;
- `ESC <` — "enter ANSI" on the VT52. Meaningless for a VT100, which is in ANSI from power-on.

Unknown VT52 sequences are swallowed silently by the VT100. That is not laziness but the behaviour of the hardware: what you do not understand, ignore. Answering `ESC Z` with a VT52 identity would not be an inaccuracy but a straightforward lie to the program asking the question.

What delights me is that the private mode `CSI ? 2 h` (DECANM) drops the VT100 into VT52 compatibility. That is real hardware behaviour. So I inherited the grammar rather than rewriting it: a VT100 is obliged to be able to be a VT52, and let that be literally the same code.

```js
// src/vt52.js — режим переключается на уровне ИНСТАНСА, а не класса
attrMask()      { return this.modes.ansi ? -1 : ~(ATTR_BOLD | ATTR_UNDERSCORE); }
cursorIsBlock() { return !!this.modes.ansi; }
```

In ANSI mode the machine draws bold, underline and a block cursor. In VT52 mode it does not — and that is not a simplification for the tests: the DECscope really did not have those attributes.

Of the useful things ANSI brought: `DECAWM` with deferred wrapping (the cursor sits in the last column until the next character arrives), `IRM` insert mode without which `vi` with an insert-capable termcap simply overwrites text, `DECSTBM` scrolling regions with an exclusive bottom boundary as on the hardware, `DECCKM` for arrows sending `ESC O A..D` instead of `ESC [ A..D`, and `DECCOLM`, that is 80↔132 columns with a screen clear and a canvas rebuild. The geometry of the tube changes, not just the text.

I am most grateful for `DECSTBM`. Without scrolling regions, `vi` under 2.11 BSD behaves as if half its screen had fallen off, and diagnosing that from "the picture looks wrong" is nearly impossible: everything appears to be in place, it simply lives somewhere other than where you expect.

### A tube with no paper, and one missed call

The VT100 has no LA36 block, so it does not enter screen mode lazily. It is born in it:

```js
powerOnState() {
    return { screen: true, dialect: true, ansi: true };
}
```

And now a parable. This was first done not as a hook but by overriding `reset()`. Logical enough — a reset means the right modes. Except the engine constructor never calls `reset()`. So a VT100 created by `vt100Initialize()` started with `screen = false`, and the guest's very first output — the `@` boot prompt — went into the hidden textarea of hardcopy mode. The user saw a tidy DECscope cabinet with a completely empty screen and was sure the machine had died while booting.

The conclusion I now follow: power-on state is a hook, not a side effect of a constructor. The engine must ask the dialect about its starting modes both where it creates the object and where it resets it.

A trap of the same kind lives next door, only worse. A dialect has its own public mode name, `modes.ansi`; the engine has a neutral one, `modes.dialect`, because the engine must not know what ANSI is — it merely stores and returns a flag. As soon as one reset updated one field of the two, the terminal was left half-configured: VT100 output began to be routed as if this were a teletype, and the console received nothing at all. The two fields have to travel as a pair. That is now pinned by a test, because eyes cannot track it.

### Capability flags instead of "who are you?"

This was the most expensive mistake, and I understood it only when the bug count reached double figures.

The terminal registry is shared by all dialects — otherwise snapshots would silently lose the VT100, since restoring would not find it in a separate map. But a shared registry has an unpleasant consequence: `vt100Get(unit)` will happily return a DECscope if that is what is on the unit. So "the terminal is reachable" no longer means "this is a VT100".

Therefore every dialect declares what it accepts:

```js
// src/dialect/vt100.js
acceptsPhosphor     = true;    // трубку выбирает оператор из CONFIG
acceptsReverseVideo = false;   // тумблера нет, только SGR 7 от программы
acceptsKeyClick     = true;

// src/vt52.js
acceptsReverseVideo = true;    // тумблер на самой машине
acceptsKeyClick     = false;   // клавиатура механическая
powerOnState() { return { phosphor: "p4" }; }  // другой трубки у VT52 не было
```

The trap is in inheritance. The VT100 extends the VT52, so by default it inherits all its opt-ins; a superset has to explicitly refuse what it does not have. Otherwise the reverse-video switch on the DECscope would recolour the VT100 too.

Before this, every subsystem worked out identification for itself: the cabinet file, the phosphor, reverse video, the key click, the zoom geometry. Five independent ways to answer "which terminal is this", and most of that session's bugs were born from differences between those copies of the answer. Now the rig declares `data-dialect="vt52|vt100"` once and everything else derives from it: the artwork, the terminal class, what the machine is allowed at all.

A live example: the key click. It is synthesised through Web Audio and asks the terminal that received the press, not "is key click enabled in the config". So the DECscope stays silent even with the option on, and the CONFIG field honestly greys out when no VT100 is configured. I had tried to sell a VT52 click as "period atmosphere". The effect was the opposite: a sound you cannot switch off is perceived not as atmosphere but as a bug.

## The phone was shrinking the machine

The opening of the Russian original of this article warns that on a small screen the machine shrinks until the labels cannot be read, and calls that a subject of its own. The Russian edition ends with the question open. This one can close it, because the fix and the evidence are in the repository now.

The symptom was described to me by eye: on a phone, the manual and the devlog show strips of the machine-room photograph down each side of the article, while the landing page looks right. I then spent four hours on four wrong diagnoses — a media-query breakpoint, the Android scrollbar, picture borders, browser cache — all of them read off the CSS rather than measured.

The measurement took a minute and settled it. With a phone-sized viewport, `innerWidth` was **980** on the generated pages and **393** on the landing page. The static pages had no viewport meta tag at all, so a phone treated them as desktop documents, laid them out in a virtual 980 px and zoomed the result down to fit. Inside those 980 px the reading column reached its full `max-width: 800px` and was centred — leaving ninety pixels of photograph down each side. That was the "stripe".

One line in the shared template fixed it:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```

After the change: `innerWidth` 393 everywhere, zero pixels of background beside the column instead of ninety, and — the part I did not expect — the `@media (max-width: 768px)` rules finally took effect at all. The button row had been laid out as a row on phones this whole time, because the breakpoint had never been reached.

The lesson is not about viewport tags. It is that a visual defect is diagnosed by measuring, not by reading CSS and reasoning about what might be wrong: measure the broken page and the working one, compare, and only then edit. There is a small tool for it in the tree, `tools/probe-mobile.js`, which reports computed styles and box geometry for the landing page, the devlog and the manual at phone sizes. It is not part of the suite — it needs a running server — but it is what turned four hours of guessing into a minute of knowing.

## What holds it together

All of this lives under tests, because things like this break silently and annoyingly:

- [`tests/teletype-svg-backdrop.test.js`](https://github.com/amesk/yaPDP/blob/master/tests/teletype-svg-backdrop.test.js) — the `--tty-*` numbers against the markers in the artwork, every contain factor obliged to be `min(marker / native)`;
- [`tests/teletype-cabinet-css.test.js`](https://github.com/amesk/yaPDP/blob/master/tests/teletype-cabinet-css.test.js) — every `scale()` dimensionless;
- [`tests/tty-quad-matrix.test.js`](https://github.com/amesk/yaPDP/blob/master/tests/tty-quad-matrix.test.js) — projection onto rotated and trapezoidal markers;
- [`tests/paper-geometry.test.js`](https://github.com/amesk/yaPDP/blob/master/tests/paper-geometry.test.js) — sheet geometry for 72 and 80 columns;
- [`tests/teletype-paper-growth.test.js`](https://github.com/amesk/yaPDP/blob/master/tests/teletype-paper-growth.test.js) and [`tests/teletype-scaling.test.js`](https://github.com/amesk/yaPDP/blob/master/tests/teletype-scaling.test.js) — growth, ceiling, scale;
- [`tests/vt52-svg-backdrop.test.js`](https://github.com/amesk/yaPDP/blob/master/tests/vt52-svg-backdrop.test.js) — the `Screen` marker, fallback numbers in CSS, no embedded raster;
- [`tests/vt52.test.js`](https://github.com/amesk/yaPDP/blob/master/tests/vt52.test.js) — modes, attributes, and separately that the VT52 draws neither bold nor underline;
- [`tests/config-select-fill.test.js`](https://github.com/amesk/yaPDP/blob/master/tests/config-select-fill.test.js) — CONFIG must show the terminal that is actually working.

The point is not coverage. These tests fix the contract between the artist and the code, and between two dialects sharing one engine. Re-save the SVG in Inkscape, move a rectangle, and you learn that the overlay no longer lies on the glass before a single live user sees it.

## What is not finished

The main conclusion after three machines: draw hardware in the coordinates of the hardware. One system of units, honest contain fits, the artwork as the source of truth — and a cabinet with buttons stops being a set of "approximately matching" layers. And a second, less obvious one: a machine should declare its own capabilities, not the subsystem that happens to need them.

In the queue:

- move artwork inlining into a shared module; the teletype and the terminal do it in two similar but independent pieces, and that irritates me;
- rename `--vt52-*` and `.vt52-rig` to something neutral, now that there are two dialects;
- add CRT effects as a second layer — a phosphor trail after a character is cleared. Right now there is only CSS flicker and a vertical sync band;
- go through the "magic" numbers in the artworks; some of them want to be markers.

Which is closer to your heart, the physics of paper or the physics of the tube?
