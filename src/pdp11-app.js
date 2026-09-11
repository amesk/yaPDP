/**
 * yaPDP — PDP-11/70 Application Initialization
 *
 * Bootstraps the emulator after all core modules are loaded:
 * - G60 Printer (console teletype)
 * - G60 Keyboard (punch-keyboard input)
 * - VT52 terminal page
 *
 * Must be loaded AFTER pdp11.js, vt52.js, g60printer.js, iopage.js, vt11.js.
 */
'use strict';

// ------------------------------------------------------------------
// Console input bridge — route bytes to a DL11 unit's receive queue.
// In-page features MUST go through the internal bridge (__yapdpBridge);
// the legacy window.dlReceiveQueue surface is gated behind ?bridge=1
// and exists only for external tooling (rt11-term legacy, tests). The
// fallback
// keeps older callers/tests working when no bridge is installed.
// ------------------------------------------------------------------
function bridgeSendToUnit(unit, bytes) {
  var bridge = window.__yapdpBridge;
  var q = bridge
    ? bridge.dlReceiveQueue
    : (unit === 0 ? window.dlReceiveQueue : window['dlReceiveQueue' + unit]);
  if (typeof q === 'function') q(unit, bytes);
}

// ------------------------------------------------------------------
// Google60 Printer — console output (teletype paper / line printer)
// ------------------------------------------------------------------

var g60printer = null;
var g60Console = null;

// Console teletype echo pace (ms per character) for each CONFIG speed.
// 'authentic' is the real Model 33 ASR at 110 baud (~10 chars/sec); 'fast' is the
// accelerated development pace (~33 chars/sec).
var TELETYPE_CHAR_DELAY_MS = { authentic: 100, fast: 30 };

function teletypeDelay(speed) {
  return TELETYPE_CHAR_DELAY_MS[speed] || 30;
}

// Punch enable flag. On a real Model 33 ASR the punch is OFF by default and
// is switched on by the operator (ON button) or by the machine sending DC2.
// While OFF, printed output is NOT duplicated onto the paper tape.
var ttyRelHeld = false; // the REL (release) button is latched
function setRelHeld(on) {
  ttyRelHeld = !!on;
  var relBtn = document.getElementById('punch-rel');
  if (relBtn) relBtn.classList.toggle('active', ttyRelHeld);
}
function setTtyPunch(on) {
  // While the CCU is in OFF the whole unit is powered down, so the punch
  // cannot be engaged (its motor is dead) even if the operator presses ON.
  if (on && window.ttyMode === 'off') return;
  window.ttyPunchEnabled = !!on;
  var onBtn = document.getElementById('punch-on');
  var offBtn = document.getElementById('punch-off');
  if (onBtn) onBtn.classList.toggle('active', !!on);
  // While REL is latched the punch is disengaged through RELEASE, not OFF,
  // so the OFF button stays unlit (pressed-out).
  if (offBtn) offBtn.classList.toggle('active', !on && !ttyRelHeld);
  // Engaging the punch releases the latched REL (release) button.
  if (on) setRelHeld(false);
}

// Punch the automatic NUL trailer on the paper tape (see punchtape.js
// punchTrailer). No-op when the tape UI is absent or the punch is a VT52
// console — the console punch only exists on the teletype.
function punchTapeTrailer() {
  if (window.paperTape && typeof window.paperTape.punchTrailer === 'function') {
    window.paperTape.punchTrailer();
  }
}

// Tape reader switch state. On the automatic (ASR) Model 33 the reader is
// controlled by a VERTICAL four-detent lever whose positions read top to
// bottom as on the machine: START (manual run — the reader feeds continuously
// at console speed), AUTO (line-controlled run: one byte goes out, then each
// next byte follows the DL11 "input drained" signal, paused by DC3/X-OFF and
// resumed by DC1/X-ON), STOP (forced stop) and FREE (tape released for manual
// pull). The array order IS the physical order, top to bottom, so each mode's
// index is also the lever's detent (--reader-lever-i).
var readerModes = ['start', 'auto', 'stop', 'free'];
var readerXoffPaused = false; // DC3/X-OFF pause latch, only used in AUTO

// Recompute whether the ASR reader may feed bytes, honouring the CCU power
// state. START always feeds; STOP/FREE never; AUTO feeds unless a DC3
// (X-OFF) pause is latched. In CCU OFF the unit is powered down, so the
// reader never feeds.
function updateReaderCanFeed() {
  if (window.ttyMode === 'off') { window.ttyReaderCanFeed = false; return; }
  if (window.ttyReaderMode === 'start') window.ttyReaderCanFeed = true;
  else if (window.ttyReaderMode === 'stop' || window.ttyReaderMode === 'free') window.ttyReaderCanFeed = false;
  else window.ttyReaderCanFeed = !readerXoffPaused; // AUTO
}

function setReaderMode(mode) {
  if (readerModes.indexOf(mode) === -1) return;
  window.ttyReaderMode = mode;
  updateReaderCanFeed();
  var pos = document.querySelectorAll('.asr-switch-pos');
  for (var i = 0; i < pos.length; i++) {
    pos[i].classList.toggle('active', pos[i].getAttribute('data-reader-mode') === mode);
  }
  // Slide the vertical lever to its detent: 0 = START (top) ... 3 = FREE
  // (bottom). The CSS turns that index into the handle position over the
  // four-detent slot (see .asr-reader-switch in css/g60printer.css).
  var rail = document.getElementById('asr-reader-switch');
  if (rail) rail.style.setProperty('--reader-lever-i', String(readerModes.indexOf(mode)));
  // Drive the reader mechanism (src/reader.js) and show the "Remove tape"
  // operator button: it appears while the reader is paused (STOP or FREE)
  // and hides while START or AUTO is running — pulling the tape out mid-run
  // would be surprising. FREE is now a purely decorative switch position.
  if (window.tapeReader && typeof window.tapeReader.setMode === 'function') {
    window.tapeReader.setMode(mode);
  }
  var removeBtn = document.getElementById('tty-remove-tape');
  if (removeBtn) removeBtn.classList.toggle('hidden', mode === 'start' || mode === 'auto');
}

// ---- CCU (Call Control Unit) line switch: LINE / OFF / LOCAL -----------
// On a real Model 33 ASR the mode is chosen with the rotary knob of the
// Call Control Unit: LINE (connected to the machine), OFF (power fully off
// — teletype, punch and reader are all disabled) and LOCAL (closed local
// loop — the keyboard prints locally and machine output is ignored). The
// knob's "beak" pointer sweeps from -60° (LINE, left) through 0° (OFF, up)
// to +60° (LOCAL, right). Default is LINE so the console is live until the
// operator moves the knob.
var ttyModes = ['line', 'off', 'local'];
window.ttyMode = 'line';

// Pointer angle per CCU detent: LINE -60°, OFF 0° (straight up), LOCAL +60°.
function ttyLeverAngle(mode) {
  if (mode === 'line') return -60;
  if (mode === 'local') return 60;
  return 0;
}

function setTtyMode(mode) {
  if (ttyModes.indexOf(mode) === -1) return;
  window.ttyMode = mode;
  // Light the active position label and rotate the knob (disc + beak)
  // around its own centre so the beak points at the active position.
  var pos = document.querySelectorAll('.ccu-switch-pos');
  for (var i = 0; i < pos.length; i++) {
    pos[i].classList.toggle('active', pos[i].getAttribute('data-tty-mode') === mode);
  }
  var knob = document.getElementById('ccu-switch-disc');
  if (knob) knob.style.transform = 'rotate(' + ttyLeverAngle(mode) + 'deg)';
  // OFF cuts power to the whole unit: disengage the punch and stop the
  // reader from feeding. Returning to LINE/LOCAL restores the reader's feed
  // permission according to the reader-mode switch.
  if (mode === 'off') {
    setTtyPunch(false);
    window.ttyReaderCanFeed = false;
  } else {
    updateReaderCanFeed();
  }
  // AUTO re-paces itself when the CCU changes the byte route (LOCAL prints
  // only, LINE prints and sends) — see tapeReader.onTtyMode().
  if (window.tapeReader && typeof window.tapeReader.onTtyMode === 'function') {
    window.tapeReader.onTtyMode();
  }
}

function g60ConsoleWrite(code) {
  // In LOCAL mode the teletype is disconnected from the machine line: output
  // from the machine is ignored (it neither prints nor punches). In OFF the
  // unit is powered down, so machine output is ignored too.
  if (window.ttyMode !== 'line') return;
  // Programmatic punch control: DC2 (0x12) engages the punch, DC4 (0x14)
  // disengages it. These control bytes are not printed themselves.
  if (code === 0x12) { setTtyPunch(true); return; }
  if (code === 0x14) {
    // Disengaging the punch punches the automatic NUL trailer first — the
    // tape gets a blank mechanical tail before it stops, like a real
    // operator finishing a tape.
    punchTapeTrailer();
    setRelHeld(false);
    setTtyPunch(false);
    return;
  }
  // Remote reader control in AUTO: DC1 / X-ON (0x11) starts reading,
  // DC3 / X-OFF (0x13) stops it.
  if (code === 0x11) {
    // X-ON resumes the AUTO reader after an X-OFF pause: clear the pause
    // latch and send one byte right away (the next bytes follow each
    // "input drained" signal from the DL11 console).
    readerXoffPaused = false;
    if (window.ttyReaderMode === 'auto') {
      window.ttyReaderCanFeed = true;
      if (window.tapeReader && typeof window.tapeReader.kick === 'function') {
        window.tapeReader.kick();
      }
    }
    return;
  }
  if (code === 0x13) {
    // X-OFF pauses the AUTO reader until the next X-ON.
    readerXoffPaused = true;
    if (window.ttyReaderMode === 'auto') window.ttyReaderCanFeed = false;
    return;
  }
  if (g60Console) g60Console.writeChar(code);
}

// Flush the console teletype's pending output queue (see G60Printer.flush()).
// Used on reboot, on the front-panel HALT and when the operator sends ^C to
// the console, so a runaway program's buffered backlog stops printing at once
// and the machine becomes responsive again. No-op for a VT52 console.
// NOTE: the queue lives on the G60Printer instance (g60printer); the console
// adapter (g60Console) deliberately exposes a no-op flush().
function flushG60Console() {
  if (g60printer && typeof g60printer.flush === 'function') {
    g60printer.flush();
  }
}

function initG60Printer() {
  if (g60printer) return;
  var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
  var maxCols = (cfg) ? cfg.printWidth : 72;
  // The Model 33 ASR console teletype used a smooth paper ROLL (no fanfold folds),
  // so it must NOT draw the LP11 fold-marker on form feed — only advance the
  // paper. The LP11 printer page keeps the marker (fanfold paper).
  // The Model 33 ASR console punches one row of holes on its paper tape for
  // every byte it renders — both the per-character echo (printChar) and the
  // line-based boot/program output (print()). Control codes (CR/LF/BS/TAB/FF)
  // are punched by their dedicated render handlers inside G60Printer. The
  // punch is OFF by default (see setTtyPunch) and only engages when the
  // operator presses ON or the machine sends DC2. The LP11 line printer has
  // no punch, so it never receives this callback.
  g60printer = new G60Printer('g60printer', {
    maxCols: maxCols,
    pageBreakMarker: false,
    charPrintDelay: teletypeDelay((cfg) ? cfg.teletypeSpeed : null),
    // Authentic physical carriage return: the head glides back to the left
    // margin over ~100 ms instead of teleporting (the fast LP11 keeps the
    // instant return — see carriageReturnMs in g60printer.js).
    carriageReturnMs: 100,
    // Authentic Model 33 ASR line feed: LF only advances the paper, the
    // carriage keeps its column (the LP11 line printer keeps the default
    // false — its LF snaps the head back to the left margin).
    lfKeepsColumn: true,
    onChar: function (code) {
      if (window.ttyMode !== 'off' && window.ttyPunchEnabled && window.paperTape) {
        window.paperTape.punchChar(code);
      }
      // Render hook for the Puppeteer screenshot/video generators: fired
      // whenever a character is ACTUALLY rendered on the paper. Unlike
      // window.__consoleOutputHook (fired at generation time, ahead of the
      // paced render), this lets the harness wait until the teletype has
      // really printed the byte — so captures never cut mid-print.
      if (typeof window !== 'undefined' &&
          typeof window.__consoleRenderHook === 'function') {
        window.__consoleRenderHook(code);
      }
    }
  });
  g60Console = createG60Console(g60printer);
}

// ==================================================================
// Model 33 ASR console keyboard — historical Teletype layout
// ==================================================================
// Renders the authentic Model 33 ASR keyboard: round two-tone keys
// (light alphanumeric, dark modifiers) with two-line legends — the
// base glyph in the centre and the CTRL-code name or shift symbol
// above it. Upper Case Only: the keycaps carry only upper-case glyphs
// (0x41-0x5A). The on-screen keyboard always sends upper case; the
// PHYSICAL keyboard normalizes letters to upper case only when
// Config.upperCaseOnly is set (off by default so 2.11 BSD receives
// lower case).
// ==================================================================

// Pure DOM-free helpers (unit-testable in Node, see
// tests/model33-keyboard.test.js).

// Fold a lower-case letter (a-z) to upper case when upperCaseOnly is
// on; otherwise pass the character code through unchanged. Used by the
// physical keyboard handler so a Model 33 console behaves like the
// Upper-Case-Only hardware only when the operator asks for it.
function model33UpperOnly(ch, upperCaseOnly) {
  if (upperCaseOnly && ch >= 0x61 && ch <= 0x7A) return ch - 0x20;
  return ch;
}

// Map a Model 33 key definition plus the current modifier state to the
// byte it produces. `def` carries: code (base byte), shiftCode,
// ctrlCode and `special` (esc|lf|cr|del|space|hereis|break|rept|ctrl|
// shift) for keys that do not map through modifiers. `state` is
// { shifted, ctrl }. Returns the byte to transmit, or the special key
// token for modifier/mechanical keys the caller must handle itself.
function model33KeyCode(def, state) {
  if (!def) return null;
  if (def.special) return def.special;
  var shifted = state && state.shifted;
  var ctrl = state && state.ctrl;
  if (ctrl && shifted && def.ctrlCode != null && def.shiftCode != null) {
    // Both code bars engaged: the bit-paired keyboard XORs one bit per
    // modifier — SHIFT toggles bit 4, CTRL toggles bit 6. On a key with
    // both legends (P @ DLE, K [ VT, N ^ SO, M ] CR) the combination is
    // the base with BOTH bits flipped: CTRL+SHIFT+P = 0x50^0x10^0x40 =
    // 0x00 = NUL — the one way the keyboard can produce a NULL.
    return def.ctrlCode ^ (def.code ^ def.shiftCode);
  }
  if (ctrl && def.ctrlCode != null) return def.ctrlCode;
  if (shifted && def.shiftCode != null) return def.shiftCode;
  return def.code;
}

// Model 33 CTRL/SHIFT keys are sticky modifiers: pressing one latches it
// (a second press does NOT cancel it), and pressing any OTHER key releases
// both latches. `mods` is { shifted, ctrl }; `def.special` selects the
// transition: 'ctrl'/'shift' latch their flag, 'rept' leaves them alone,
// and any other key trips both latches. Pure and unit-testable.
function model33StickyMods(mods, def) {
  var special = def && def.special;
  if (special === 'ctrl') return { shifted: mods.shifted, ctrl: true };
  if (special === 'shift') return { shifted: true, ctrl: mods.ctrl };
  if (special === 'rept') return { shifted: mods.shifted, ctrl: mods.ctrl };
  return { shifted: false, ctrl: false };
}

// Does the console print path punch this byte on the ASR tape by itself?
// Printable ASCII (32..126) goes through printChar -> onChar; BS/TAB/LF/FF/CR
// are punched by their dedicated render handlers (TAB as the equivalent
// spaces); NUL and DEL are punched by the receive path too (blank row / RUB
// OUT row). The keyboard transmit punch only needs to cover the remaining
// control codes that the print path drops (BEL, VT, SO..US).
function m33EchoPunches(code) {
  if (code >= 32 && code < 127) return true;
  return code === 8 || code === 9 || code === 10 || code === 12 || code === 13;
}

// ---- Key definition helpers ---------------------------------------
// letter: upper-case glyph with a small CTRL-code name printed at the top
// of the cap and the letter itself drawn low (as on a real Model 33). A
// hover tooltip repeats the CTRL function together with its hex code.
function m33Letter(label, ctrlName, ctrlCode) {
  return { label: label, code: label.charCodeAt(0), top: ctrlName,
    ctrlCode: ctrlCode, cls: 'alpha',
    title: 'CTRL ' + ctrlName + ' (0x' + ctrlCode.toString(16).toUpperCase() + ')' };
}
// shifted: key whose SHIFT variant shows a symbol (digit row, N, M, ...).
function m33Shifted(label, shiftLabel, shiftCode) {
  return { label: label, code: label.charCodeAt(0), top: shiftLabel,
    shiftCode: shiftCode, cls: 'alpha' };
}
// both: key carrying BOTH a shift symbol and a CTRL-code name on the cap
// (P @ DLE, K [ VT, N ^ SO, M ] CR). Alone, each modifier gives its own
// legend; held together the code bars XOR both bits — CTRL+SHIFT+P is the
// bit-paired NUL (0x00), the keyboard's only way to make a NULL.
function m33Both(label, shiftLabel, shiftCode, ctrlLabel, ctrlCode) {
  return { label: label, code: label.charCodeAt(0), shiftLabel: shiftLabel,
    shiftCode: shiftCode, ctrlLabel: ctrlLabel, ctrlCode: ctrlCode, cls: 'alpha',
    title: 'CTRL ' + ctrlLabel + ' (0x' + ctrlCode.toString(16).toUpperCase() +
      ') / SHIFT ' + shiftLabel };
}
// plain: ordinary key without a top legend.
function m33Plain(label, cls) {
  return { label: label, code: label.charCodeAt(0), cls: cls || 'alpha' };
}
// special: dark modifier/function key (ESC, RETURN, CTRL, BREAK, ...).
function m33Special(label, special, code, cls) {
  return { label: label, special: special, code: code, cls: cls || 'mod' };
}

// ---- Layout (staggered rows; key pitch 40px, diameter 36px) -------
var MODEL33_KEYS = [
  { top: 0, left: 0, keys: [
    m33Shifted('1', '!', 0x21), m33Shifted('2', '"', 0x22),
    m33Shifted('3', '#', 0x23), m33Shifted('4', '$', 0x24),
    m33Shifted('5', '%', 0x25), m33Shifted('6', '&', 0x26),
    m33Shifted('7', "'", 0x27), m33Shifted('8', '(', 0x28),
    m33Shifted('9', ')', 0x29), m33Plain('0'),
    m33Shifted(':', '*', 0x2A), m33Shifted('-', '=', 0x3D),
    m33Special('HERE\nIS', 'hereis', null)
  ]},
  { top: 44, left: 20, keys: [
    m33Special('ESC', 'esc', 0x1B),
    m33Letter('Q', 'DC1', 0x11), m33Letter('W', 'ETB', 0x17),
    m33Letter('E', 'ENQ', 0x05), m33Letter('R', 'DC2', 0x12),
    m33Letter('T', 'DC4', 0x14), m33Letter('Y', 'EM', 0x19),
    m33Letter('U', 'NAK', 0x15), m33Letter('I', 'HT', 0x09),
    m33Letter('O', 'SI', 0x0F), m33Both('P', '@', 0x40, 'DLE', 0x10),
    m33Special('LINE\nFEED', 'lf', 0x0A),
    m33Special('RE-\nTURN', 'cr', 0x0D)
  ]},
  { top: 88, left: 20, keys: [
    m33Special('CTRL', 'ctrl', null),
    m33Letter('A', 'SOH', 0x01), m33Letter('S', 'DC3', 0x13),
    m33Letter('D', 'EOT', 0x04), m33Letter('F', 'ACK', 0x06),
    m33Letter('G', 'BELL', 0x07), m33Letter('H', 'BS', 0x08),
    m33Letter('J', 'LF', 0x0A), m33Both('K', '[', 0x5B, 'VT', 0x0B),
    m33Letter('L', 'FF', 0x0C),
    m33Shifted(';', '+', 0x2B),
    m33Special('DE-\nLETE', 'del', 0x7F),
    m33Special('REPT', 'rept', null),
    m33Special('BREAK', 'break', null)
  ]},
  { top: 132, left: 0, keys: [
    m33Special('SHIFT', 'shift', null),
    m33Letter('Z', 'SUB', 0x1A), m33Letter('X', 'CAN', 0x18),
    m33Letter('C', 'ETX', 0x03), m33Letter('V', 'SYN', 0x16),
    m33Letter('B', 'STX', 0x02),
    m33Both('N', '^', 0x5E, 'SO', 0x0E), m33Both('M', ']', 0x5D, 'CR', 0x0D),
    m33Shifted(',', '<', 0x3C), m33Shifted('.', '>', 0x3E),
    m33Shifted('/', '?', 0x3F),
    m33Special('SHIFT', 'shift', null)
  ]},
  // The space bar is as tall as the other keys and spans the bottom row
  // from the V key (x=160) to the comma key (right edge x=356).
  { top: 176, left: 160, keys: [
    { space: true, special: 'space', code: 0x20 }
  ]}
];

// HERE IS (answerback drum): CR LF ACK <station id> CR LF, up to 20
// characters. The station id is a constant by default.
var MODEL33_ANSWERBACK = [13, 10, 6]; // CR LF ACK
(function () {
  var id = 'PDP-11/70';
  for (var i = 0; i < id.length; i++) MODEL33_ANSWERBACK.push(id.charCodeAt(i));
  MODEL33_ANSWERBACK.push(13, 10); // CR LF
})();

// ---- Flat key grid (one entry per key, row by row) ------------------
// The Model 33 keycap grid, derived from MODEL33_KEYS so the keycaps drawn in
// assets/Model-33-ASR.svg and the click boxes in the DOM can never disagree:
// every entry carries a stable positional id ('r<row>c<col>'), the baseline
// x/y of its box (staggered rows, 40px pitch, 36px caps, 196px space bar) and
// its key definition. The block it spans is 576x212 px (KEY_BLOCK_W/H below),
// which is what #punchkeyboard is sized to and what the "Keyboard" marker of
// the artwork is contain-fitted to. Pure and unit-testable
// (see tests/model33-keyboard.test.js).
var M33_GRID_PITCH = 40;    // key pitch (px)
var M33_GRID_CELL = 36;     // keycap diameter (px)
var M33_GRID_SPACE_W = 196; // space-bar width (px)

function model33KeyGrid(rows, pitch, spaceW, cell) {
  var out = [];
  for (var r = 0; r < rows.length; r++) {
    for (var c = 0; c < rows[r].keys.length; c++) {
      var def = rows[r].keys[c];
      out.push({
        id: 'r' + r + 'c' + c,
        row: r,
        col: c,
        x: rows[r].left + c * pitch,
        y: rows[r].top,
        w: def.space ? spaceW : cell,
        h: cell,
        def: def
      });
    }
  }
  return out;
}

var g60Keyboard = (function () {
  'use strict';

  // Key geometry: the flat grid above (40px pitch, 36px caps, staggered rows);
  // positions are absolute within #punchkeyboard.
  var GRID = model33KeyGrid(MODEL33_KEYS, M33_GRID_PITCH, M33_GRID_SPACE_W,
    M33_GRID_CELL);

  // Who draws the keycaps: 'drawn' (default) leaves the caps AND their legends
  // to the artwork — the DOM keys stay in the same boxes as invisible hit
  // areas — while 'grid' draws them in CSS (the pre-artwork behaviour, kept as
  // the fallback). The container class is the single switch, see the
  // keycap-layout rules in css/g60printer.css.
  var layout = 'drawn';

  var shifted = false;
  var ctrlHeld = false;
  var reptHeld = false;
  var repeatTimer = null;

  // Is the given modifier special-token currently latched? The mouseleave
  // handler uses this so it does not clear the 'down' visual of a latched
  // CTRL/SHIFT/REPT key (which would make the latch look un-stuck).
  function isLatched(sp) {
    if (sp === 'ctrl') return ctrlHeld;
    if (sp === 'shift') return shifted;
    if (sp === 'rept') return reptHeld;
    return false;
  }

  function buildKeyboard() {
    var kbd = document.getElementById('punchkeyboard');
    if (!kbd) return;
    kbd.innerHTML = '';
    applyLayout();

    for (var gi = 0; gi < GRID.length; gi++) {
      var slot = GRID[gi];
      var def = slot.def;

      var el = document.createElement('div');
      el._def = def;
      // Stable positional id of this key in the flat grid — exactly the box
      // the artwork draws its keycap in.
      el.dataset.key = slot.id;
      el.style.left = slot.x + 'px';
      el.style.top = slot.y + 'px';
      if (def.space) el.style.width = slot.w + 'px';

      if (def.space) {
        el.className = 'm33-space';
        } else {
          el.className = 'm33-key ' + (def.cls === 'alpha' ? 'alpha' : 'mod');
          if (def.title) el.title = def.title;
          if (def.label) {
            if (def.ctrlLabel && def.shiftLabel) {
              // Triple-named cap (P @ DLE, K [ VT, N ^ SO, M ] CR): the
              // shift symbol sits on the left, the CTRL name on the right.
              el.classList.add('dual');
              var sh = document.createElement('span');
              sh.className = 'm33-shift';
              sh.textContent = def.shiftLabel;
              el.appendChild(sh);
              var ctl = document.createElement('span');
              ctl.className = 'm33-top';
              ctl.textContent = def.ctrlLabel;
              el.appendChild(ctl);
            } else if (def.top) {
              var top = document.createElement('span');
              top.className = 'm33-top';
              top.textContent = def.top;
              el.appendChild(top);
            }
            var center = document.createElement('span');
            center.className = 'm33-center';
            center.textContent = def.label;
            el.appendChild(center);
          }
        }

        el.addEventListener('mousedown', function (e) {
          e.preventDefault();
          // Every teletype key makes a computer-button click when pressed.
          playComputerButton();
          this.classList.add('down');
        });
        el.addEventListener('mouseup', function (e) {
          e.preventDefault();
          if (!this.classList.contains('down')) return;
          this.classList.remove('down');
          activateKey(this._def);
        });
        el.addEventListener('mouseleave', function (e) {
          // Latch-driven modifiers (CTRL/SHIFT/REPT) keep their pressed
          // state owned by updateMods(); only a momentary press clears
          // 'down' when the cursor drags off before release.
          var sp = this._def && this._def.special;
          if (this.classList.contains('down') && !isLatched(sp)) {
            this.classList.remove('down');
          }
        });

      kbd.appendChild(el);
    }
  }

  // Apply the sticky modifier transition for the pressed key, updating the
  // on-screen CTRL/SHIFT key lighting when the latch state changes.
  function applyStickyMods(def) {
    var next = model33StickyMods({ shifted: shifted, ctrl: ctrlHeld }, def);
    if (next.shifted !== shifted || next.ctrl !== ctrlHeld) {
      shifted = next.shifted;
      ctrlHeld = next.ctrl;
      updateMods();
    }
  }

  // Send the byte a key produces, honouring the sticky modifier latch and
  // the REPT auto-repeat. `def.special` keys (ctrl/shift/rept/break/hereis/
  // esc/lf/cr/del/space) are dispatched here.
  function activateKey(def) {
    if (!def) return;
    if (def.special) {
      switch (def.special) {
        case 'ctrl':
          // Model 33 CTRL latches when pressed; a second click does not
          // cancel it — only another keypress trips the latch.
          applyStickyMods(def);
          return;
        case 'shift':
          // Model 33 SHIFT latches when pressed; a second click does not
          // cancel it — only another keypress trips the latch.
          applyStickyMods(def);
          return;
        case 'rept':
          reptHeld = !reptHeld;
          if (!reptHeld) stopRepeat();
          updateMods();
          return;
        case 'break':
          sendBreak();
          applyStickyMods(def);
          return;
        case 'hereis':
          sendHereIs();
          applyStickyMods(def);
          return;
        case 'space':
          if (reptHeld) startRepeat(def.code); else sendChar(def.code);
          applyStickyMods(def);
          return;
        default: // esc / lf / cr / del
          sendChar(def.code);
          applyStickyMods(def);
          return;
      }
    }
    var code = model33KeyCode(def, { shifted: shifted, ctrl: ctrlHeld });
    if (reptHeld) {
      startRepeat(code);
    } else {
      sendChar(code);
    }
    // Sticky Model 33 CTRL/SHIFT release after the next keypress of any
    // other key (character or function key).
    applyStickyMods(def);
  }

  // REPT: repeat a character key at the teletype's 10 chars/sec while the
  // repeat latch stays engaged.
  function startRepeat(code) {
    stopRepeat();
    sendChar(code);
    repeatTimer = setInterval(function () { sendChar(code); }, 100);
  }

  function stopRepeat() {
    if (repeatTimer) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
  }

  // BREAK: open the line for >150 ms — signals the console DL11's break
  // condition (see window.dlConsoleBreak in iopage.js).
  function sendBreak() {
    if (window.ttyMode !== 'line') return; // LOCAL/OFF: no line, no break
    if (typeof window.dlConsoleBreak === 'function') window.dlConsoleBreak();
  }

  // HERE IS: the answerback drum mechanically "taps out" its fixed
  // sequence (CR LF ACK <station id> CR LF) into the line.
  function sendHereIs() {
    var bytes = MODEL33_ANSWERBACK;
    if (window.ttyMode === 'off') return; // powered down: the drum is silent
    if (window.ttyMode === 'local') {
      if (g60Console) {
        for (var i = 0; i < bytes.length; i++) g60Console.writeChar(bytes[i]);
      }
      return;
    }
    bridgeSendToUnit(0, bytes);
  }

  function updateMods() {
    var keys = document.querySelectorAll('#punchkeyboard .m33-key');
    for (var i = 0; i < keys.length; i++) {
      var sp = keys[i]._def && keys[i]._def.special;
      if (sp === 'ctrl') keys[i].classList.toggle('down', ctrlHeld);
      else if (sp === 'shift') keys[i].classList.toggle('down', shifted);
      else if (sp === 'rept') keys[i].classList.toggle('down', reptHeld);
    }
  }

  // Physical keyboard handlers
  function installPhysicalKeyboard() {
    // Does the operator want the historical Upper-Case-Only behaviour for
    // the PHYSICAL keyboard (Config.upperCaseOnly)? Off by default so
    // lower case passes through (2.11 BSD file names, etc.).
    function upperOnly() {
      if (typeof Config !== 'undefined' && Config.get()) {
        return !!Config.get().upperCaseOnly;
      }
      return false;
    }

    document.addEventListener('keydown', function (e) {
      if (/^(input|textarea)$/i.test(e.target.tagName)) return;

      // Only intercept keyboard when the Teletype page is active —
      // on Panel and Info pages browser shortcuts (Ctrl+F etc.) must work normally.
      var termPage = document.getElementById('page-teletype');
      if (!termPage || !termPage.classList.contains('active')) return;

      // Special keys: Enter, Backspace, Tab, Escape, Delete.
      var code = e.keyCode || e.which;
      if (code === 13) { sendDL([13]); e.preventDefault(); return; }
      if (code === 8) { sendDL([8]); e.preventDefault(); return; }
      if (code === 9) { sendDL([9]); e.preventDefault(); return; }
      if (code === 27) { sendDL([27]); e.preventDefault(); return; }
      // The physical Delete key maps to the Model 33 DELETE (0x7F) key.
      if (code === 46) { sendDL([127]); e.preventDefault(); return; }
      if (e.ctrlKey && code >= 65 && code <= 90) {
        sendDL([code - 64]); e.preventDefault(); return;
      }

      // Printable characters
      var ch = 0;

      // 1) Try e.key first — handles Shift/case correctly on US layout
      if (typeof e.key === 'string' && e.key.length === 1) {
        ch = e.key.charCodeAt(0);
      }

      // 2) If not printable ASCII (e.g., Cyrillic layout), fall back to keyCode
      if (ch < 32 || ch >= 127) {
        if (code >= 65 && code <= 90) {
          ch = code + 32;  // lowercase letter (a-z)
        }
      }

      // The Model 33's @ key is SHIFT+P, and CTRL+@ is the bit-paired
      // NUL (0x00): pressing whatever PC combination yields @ while holding
      // Ctrl transmits a NULL — the keyboard's only way to punch the blank
      // leader row on the tape.
      if (e.ctrlKey && ch === 0x40) {
        sendDL([0]); e.preventDefault(); return;
      }

      if (ch >= 32 && ch < 127) {
        // Historical Upper-Case-Only: fold a-z to A-Z when requested.
        ch = model33UpperOnly(ch, upperOnly());
        sendDL([ch]);
        e.preventDefault();
      }
    });

    var pane = document.getElementById('punchkeypane');
    if (pane) {
      pane.addEventListener('paste', function (e) {
        e.preventDefault();
        var text = (e.clipboardData || window.clipboardData).getData('text');
        // Route through the shared PasteUtil helper (CR/LF -> CR, 7-bit bytes);
        // unit 0 is the operator console teletype.
        if (text) PasteUtil.pasteIntoUnit(0, text);
      });
    }
  }
  // Mechanical ASR transmit punch: on a real Model 33 the punch is coupled to
  // the keyboard, so every key pressed punches the tape directly whenever the
  // punch is engaged — in LOCAL and LINE alike. Bytes the console print path
  // already punches (printable + BS/TAB/LF/FF/CR) are left to that path to
  // avoid a double row; only the dropped control codes (NUL..BEL, VT, SO..US,
  // DEL) are punched here so they are not lost. Returns true when the byte
  // was recorded on the tape by this call.
  function punchKeyboard(code) {
    if (window.ttyMode === 'off') return false;
    if (!window.ttyPunchEnabled) return false;
    if (!window.paperTape) return false;
    if (m33EchoPunches(code)) return false;
    window.paperTape.punchChar(code);
    return true;
  }
  // Model 33 keyboard bell: typing BEL (CTRL+G, 0x07) rings the teletype
  // gong mechanically on the keyboard — in LOCAL and LINE alike, and
  // independent of the punch. Reuses the shared synthesized bell.
  function bellKeyboard(code) {
    if (code !== 7) return;
    if (window.ttyMode === 'off') return;
    if (typeof window.playBell === 'function') window.playBell();
  }
  function sendChar(code) {
    bellKeyboard(code);
    var punched = punchKeyboard(code);
    // OFF: the unit is powered down — the key does nothing. LOCAL mode: the
    // keyboard is not connected to the machine — the typed character is
    // printed locally (paper + tape) instead of being sent. Bytes the
    // keyboard punch already recorded (NUL..BEL, VT, SO..US, DEL) are NOT
    // echoed through the print path: echoing would punch a second row.
    if (window.ttyMode === 'off') return;
    if (window.ttyMode === 'local') {
      if (!punched && g60Console) g60Console.writeChar(code);
      return;
    }
    bridgeSendToUnit(0, [code]);
  }
  function sendDL(bytes) {
    var punched = [];
    for (var i = 0; i < bytes.length; i++) {
      bellKeyboard(bytes[i]);
      punched.push(punchKeyboard(bytes[i]));
    }
    // OFF: powered down — nothing typed is echoed or transmitted.
    if (window.ttyMode === 'off') return;
    if (window.ttyMode === 'local') {
      if (g60Console) {
        for (i = 0; i < bytes.length; i++) {
          // Skip bytes the keyboard punch already recorded (NUL..BEL, VT,
          // SO..US, DEL) — echoing them would punch a second row.
          if (!punched[i]) g60Console.writeChar(bytes[i]);
        }
      }
      return;
    }
    bridgeSendToUnit(0, bytes);
  }

  // Apply the selected keycap layout to the keyboard container: the class is
  // absent for 'drawn' (the artwork draws the caps) and present for 'grid'
  // (the page draws them — see css/g60printer.css).
  function applyLayout() {
    var kbd = document.getElementById('punchkeyboard');
    if (kbd) kbd.classList.toggle('m33-css-caps', layout === 'grid');
  }

  return {
    init: function () { buildKeyboard(); installPhysicalKeyboard(); },
    // CONFIG page: 'drawn' (keycaps in the artwork, default) or 'grid'
    // (keycaps drawn by CSS). Applied live, no reload.
    setLayout: function (name) {
      layout = (name === 'grid') ? 'grid' : 'drawn';
      applyLayout();
    }
  };
})();

// ---- VT52 page keyboard handler (parameterized by unit and page) ----
// Routes physical keyboard input to a given VT52 unit while its page is
// active. The global handler pattern keeps input consistent across the
// console VT52 and every user terminal page.
function installVT52Keyboard(unit, pageId) {
  document.addEventListener('keydown', function (e) {
    if (/^(input|textarea)$/i.test(e.target.tagName)) return;

    // Ignore browser auto-repeat (key held down)
    if (e.repeat) return;

    // Only intercept when THIS VT52 page is active
    var pageEl = document.getElementById(pageId);
    if (!pageEl || !pageEl.classList.contains('active')) return;

    // Don't intercept when the teletype console page is active
    // (let g60Keyboard handle it)
    var telePage = document.getElementById('page-teletype');
    if (telePage && telePage.classList.contains('active')) return;

    // Prevent Tab switching away from the emulator
    if (e.key === 'Tab') { e.preventDefault(); return; }

    // Route to the given unit via the internal bridge (__yapdpBridge).
    // Unit 0 → dlReceiveQueue, unit N → dlReceiveQueueN (bridge is
    // unit-aware; the legacy window surface is ?bridge=1-gated).
    function sendToUnit(bytes) {
      // Optional audible key click (VT100-style feedback)
      if (typeof window.playKeyClick === 'function') window.playKeyClick();
      bridgeSendToUnit(unit, bytes);
    }

    // Special keys: Enter, Backspace
    var code = e.keyCode || e.which;
    if (code === 13) { sendToUnit([13]); e.preventDefault(); return; }
    if (code === 8) { sendToUnit([8]); e.preventDefault(); return; }

    // Ctrl+V: paste from the native clipboard into the terminal. In canvas mode
    // the browser has no native paste shortcut (focus sits on the canvas), so
    // read the clipboard explicitly and feed the bytes through the receive
    // queue with CR/LF normalization. In text mode this handler never runs
    // (focus is on the textarea), where the native paste event is used instead.
    if (e.ctrlKey && !e.altKey && (e.key === 'v' || e.key === 'V' || code === 86)) {
      e.preventDefault();
      if (typeof navigator !== 'undefined' && navigator.clipboard &&
          typeof navigator.clipboard.readText === 'function') {
        navigator.clipboard.readText().then(function (text) {
          // PasteUtil normalizes CR/LF to CR and routes the bytes to the unit.
          PasteUtil.pasteIntoUnit(unit, text);
        }).catch(function () { /* clipboard permission denied: ignore */ });
      }
      return;
    }

    // Ctrl+letter → control codes
    if (e.ctrlKey && code >= 65 && code <= 90) {
      sendToUnit([code - 64]); e.preventDefault(); return;
    }

    // Printable characters
    var ch = 0;

    // 1) Try e.key first — handles Shift/case correctly on US layout
    if (typeof e.key === 'string' && e.key.length === 1) {
      ch = e.key.charCodeAt(0);
    }

    // 2) If not printable ASCII (e.g., Cyrillic layout), fall back to keyCode
    if (ch < 32 || ch >= 127) {
      if (code >= 65 && code <= 90) {
        ch = code + 32;  // lowercase letter (a-z)
      }
    }

    if (ch >= 32 && ch < 127) {
      sendToUnit([ch]);
      e.preventDefault();
    }
  });

  // Paste handler for this VT52 page's canvas
  var crt = document.querySelector('#' + pageId + ' canvas');
  if (crt) {
    crt.addEventListener('paste', function (e) {
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData('text');
      if (text) PasteUtil.pasteIntoUnit(unit, text);
    });
  }
}

// ---- DECscope VT52 cabinet builder ----
// Recreates the recognisable DEC VT52 front: a slanted off-white moulded-plastic
// monoblock with a vent grille, a deep bezel around the tube, a plain plastic
// side panel with a raised ridge, and a keyboard deck (main block + keypad +
// PF1–PF4 + the d.i.g.i.t.a.l brand). The keys are clickable: each click feeds
// the same bytes the physical keyboard would send through the unit's DL11
// receive queue, then returns focus to the canvas so typing keeps working.
function buildVT52Cabinet(unit, cabinet, crt) {
  // The earlier decorative badge/controls are superseded by the full cabinet.
  var oldBadge = cabinet.querySelector('.vt52-badge');
  if (oldBadge) oldBadge.remove();
  var oldControls = cabinet.querySelector('.vt52-controls');
  if (oldControls) oldControls.remove();

  // Vent grille (drawn purely in CSS via repeating-linear-gradient).
  var vents = document.createElement('div');
  vents.className = 'vt52-vents';

  // Top section: screen bezel (left) + plastic side (right).
  var top = document.createElement('div');
  top.className = 'vt52-top';

  var bezel = document.createElement('div');
  bezel.className = 'vt52-bezel';

  if (crt) bezel.appendChild(crt); // move the existing tube inside the bezel

  // The dark side panel is a recessed insert INSIDE the beige bezel, so the
  // cabinet embraces both the screen and the panel as one piece.
  var sidePlastic = document.createElement('div');
  sidePlastic.className = 'vt52-side-plastic';

  // DEC "digital" wordmark stamped at the top of the dark side panel,
  // echoing the boxed letters of the front panel's .decLetter block.
  var decLogo = document.createElement('div');
  decLogo.className = 'vt52-dec-logo';
  var brand = 'digital';
  for (var i = 0; i < brand.length; i++) {
    var letter = document.createElement('span');
    letter.className = 'vt52-dec-letter';
    letter.textContent = brand.charAt(i);
    decLogo.appendChild(letter);
  }
  sidePlastic.appendChild(decLogo);

  var ridge = document.createElement('div');
  ridge.className = 'vt52-side-ridge';
  sidePlastic.appendChild(ridge);
  bezel.appendChild(sidePlastic);

  top.appendChild(bezel);

  cabinet.appendChild(vents);
  cabinet.appendChild(top);
}

// ==================================================================
// Authentic VT52 display font
// ------------------------------------------------------------------
// The webfont 'VT52' (declared via @font-face in css/pdp11.css, asset at
// assets/fonts/vt52.otf) reproduces the DECscope's bitmap-style glyphs.
// loadVT52Font() waits for it with the CSS Font Loading API before the CRT
// re-measures its cell grid, so the canvas never renders with the wrong
// metrics. It always resolves: on failure the terminals keep 'monospace'.
// ==================================================================
var VT52_FONT_FAMILY = 'VT52';
var VT52_FONT_STACK  = "'" + VT52_FONT_FAMILY + "', monospace";

function loadVT52Font() {
  try {
    if (document.fonts && typeof document.fonts.load === 'function') {
      var loaded = document.fonts.load('20px "' + VT52_FONT_FAMILY + '"');
      if (loaded && typeof loaded.then === 'function') {
        return loaded.catch(function () { /* font unavailable — keep fallback */ });
      }
    }
  } catch (err) { /* ignore */ }
  return Promise.resolve();
}

// ---- Initialize a VT52 terminal on the given page ----
function initVT52Page(unit, pageId, canvasId, textareaId) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;

  var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
  var textMode = !!(cfg && cfg.vt52TextMode);

  // Create a textarea for the VT52 to use as a backing store. In text mode it
  // becomes the visible "plain input" terminal (native selection + clipboard);
  // otherwise it stays hidden and only the authentic canvas CRT is shown. It is
  // inserted as a sibling of the canvas inside .vt52-crt so the CRT bezel and
  // the scanline overlays (pointer-events: none) keep framing the input.
  var crt = canvas.parentElement;
  var textarea = document.createElement('textarea');
  textarea.id = textareaId;
  textarea.className = 'vt52-textarea';
  textarea.setAttribute('autocomplete', 'off');
  textarea.setAttribute('autocorrect', 'off');
  textarea.setAttribute('autocapitalize', 'off');
  textarea.setAttribute('spellcheck', 'false');
  textarea.style.display = textMode ? 'block' : 'none';
  (crt || document.body).appendChild(textarea);

  // Build the authentic DECscope cabinet shell once per page (vent grille,
  // slanted bezel around the tube, right plastic side, keyboard deck, brand and
  // power indicator). The tube (.vt52-crt) is moved inside the bezel.
  var cabinet = crt ? crt.parentElement : null;
  if (cabinet && !cabinet.querySelector('.vt52-top')) {
    buildVT52Cabinet(unit, cabinet, crt);
  }

  // Initialize the VT52 terminal. In text mode the screen buffer is rendered
  // through the visible textarea; in canvas mode through the CRT canvas.
  window.vt52Initialize(unit, function (unit, bytes) {
    bridgeSendToUnit(unit, bytes);
  }, textarea, canvas, {
    allowCanvas: !textMode,
    noHardcopyFallback: true,
    fontSize: 20,
    fontFamily: VT52_FONT_STACK,
    cols: 80,
    rows: 24
  });

  // Intercept the native paste in the textarea (which would otherwise edit the
  // textarea DOM) and feed the emulator the clipboard bytes through the shared
  // PasteUtil helper (CR/LF normalization + DL11 receive-queue routing).
  textarea.addEventListener('paste', function (e) {
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text');
    if (text) PasteUtil.pasteIntoUnit(unit, text);
  });

  // Allow the native context menu on this textarea only, so right-click paste
  // works; the page-wide block in contextmenu.js stays untouched elsewhere.
  textarea.addEventListener('contextmenu', function (e) { e.stopPropagation(); });

  // Install keyboard handler for this page.
  installVT52Keyboard(unit, pageId);

  // Force terminal into screen mode with the right element visible immediately.
  // Without this, the terminal starts in hardcopy mode (output to the textarea)
  // and only switches to screen mode upon receiving an escape sequence.
  var term = window.vt52Get(unit);
  if (term) {
    // Keep a reference to the terminal's built-in key handler: text mode wraps
    // it for native-clipboard behaviour, canvas mode silences it (the global
    // installVT52Keyboard() handles keys there).
    term._builtinKey = term.handleKey.bind(term);
    term.modes.screen = true;
    term.rows = 24;
    term.cols = 80;
    term.clearScreen();

    if (textMode) {
      // Plain textarea terminal: native clipboard and text selection. Mirror the
      // authentic 4:3 canvas CRT onto the textarea (logical grid + scaleX).
      term.allowCanvas = false;
      canvas.style.display = 'none';
      textarea.style.display = 'block';
      applyVT52TextGeometry(term);
      // Keep the terminal's built-in key handler so typing reaches the emulator,
      // but let Ctrl+V always fall through to the native paste (the paste
      // listener routes it into the emulator) and Ctrl+C copy when a selection
      // exists, mirroring Windows Terminal; otherwise Ctrl+C stays ^C.
      term.handleKey = makeTextModeKeyHandler(term, textarea);
      textarea.focus();
    } else {
      // Canvas CRT terminal.
      term.allowCanvas = true;
      textarea.style.display = 'none';
      canvas.style.display = 'block';
      canvas.focus();

      // Size canvas to match font metrics for 80x24 (plus the inner margin).
      // resizeCanvas() keeps the geometry (grid + screenPadding) in one place.
      var charW = term.canvas.charWidth;
      if (charW > 0) {
        term.resizeCanvas();
        term.renderCanvas();
      }

      // Disable vt52's built-in keydown handler on the canvas to avoid
      // double-sending; the global installVT52Keyboard() captures physical
      // keyboard input instead. In text mode the built-in handler is kept so
      // typing into the focused textarea reaches the emulator.
      term.handleKey = function () { };
    }
  }

  // Apply the authentic VT52 webfont once the browser has loaded it. The
  // terminal is first measured with the monospace fallback so the page never
  // blocks on the font fetch; setFont() re-measures the cell width from "M",
  // re-sizes the CRT canvas and repaints. In text mode the <textarea> grid is
  // mirrored to the new metrics too (the CSS font-family picks the font up by
  // itself, so no DOM re-render is needed there).
  loadVT52Font().then(function () {
    var t = (typeof window.vt52Get === 'function') ? window.vt52Get(unit) : null;
    if (!t || typeof t.setFont !== 'function') return;
    t.setFont(VT52_FONT_STACK);
    if (t.textArea && t.textArea.style.display !== 'none') {
      // After the webfont re-measures the cell width, re-apply the mirrored
      // 4:3 textarea geometry (logical grid + scaleX + tube size).
      applyVT52TextGeometry(t);
    }
  });
}

// ==================================================================
// Optional audible key click for VT52 terminals (VT100-style feedback).
// Synthesized with Web Audio (no binary asset needed). The CONFIG
// "keyClick" setting is checked live on every keystroke.
// ==================================================================
(function installKeyClick() {
  var audioCtx = null;
  window.playKeyClick = function () {
    var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
    // The global "mute" flag silences every sound source, including this one.
    if (!cfg || !cfg.keyClick || cfg.mute) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.value = 2000;
      gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.03);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.03);
    } catch (err) { /* ignore audio errors */ }
  };
})();

// ==================================================================
// Audible click for the front-panel rotary selectors and the teletype
// CCU / tape-reader switches. Synthesized with Web Audio on a dedicated
// context so it never clashes with the teletype/printer, the VT52 key
// click or the bell. Always on — the click is authentic switch hardware
// behaviour — but the global "mute" flag silences it like every other
// sound source. The click models a rotary detent switch ("галетник"):
// the spring-loaded indexer snapping through the notch as a cascade of
// crisp micro-ticks. The POWER LOCK key, the ASR punch buttons and every
// teletype key use their own mp3 assets (playComputerButton / playButtonPress).
// ==================================================================
(function installSwitchClick() {
  var audioCtx = null;
  var noiseBuf = null; // shared short noise burst (lazy, per context)

  // One metallic tick: band-passed noise with a fast decay.
  function playTick(ctx, t, gain, center, q, dur) {
    var src = ctx.createBufferSource();
    src.buffer = ensureNoise(ctx);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = center;
    bp.Q.value = q;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(ctx.destination);
    src.start(t);
    src.stop(t + dur);
  }

  function ensureNoise(ctx) {
    if (noiseBuf) return noiseBuf;
    var len = Math.max(1, Math.floor(ctx.sampleRate * 0.02));
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  window.playSwitchClick = function () {
    var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
    if (cfg && cfg.mute) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      // The operator has just clicked a switch, so the context is usable;
      // resuming here keeps the very first click audible too.
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t0 = audioCtx.currentTime;
      // Rotary detent ("галетник") ratchet: release from the previous
      // detent, engage the next (loudest), then a settling micro-tick.
      playTick(audioCtx, t0,         0.14, 3800, 2.4, 0.01);
      playTick(audioCtx, t0 + 0.026, 0.20, 3000, 2.2, 0.012);
      playTick(audioCtx, t0 + 0.052, 0.10, 4300, 2.6, 0.009);
    } catch (err) { /* ignore audio errors */ }
  };

  // Front-panel latching toggle switch (data/address rocker, ENABLE/HALT,
  // LAMP TEST, S INST/S BUS): a single press+release pair played together,
  // matching a bat-handle toggle that snaps to its new position.
  window.playPanelToggle = function () {
    var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
    if (cfg && cfg.mute) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t0 = audioCtx.currentTime;
      playTick(audioCtx, t0,         0.11, 2600, 2.0, 0.009);
      playTick(audioCtx, t0 + 0.055, 0.07, 2100, 1.8, 0.008);
    } catch (err) { /* ignore audio errors */ }
  };

  // The press half of a momentary (self-returning) switch, e.g. LOAD ADRS,
  // EXAM, DEP, CONT, START: a single click on the way down. The matching
  // release click (playPanelRelease) fires when the switch springs back.
  window.playPanelPress = function () {
    var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
    if (cfg && cfg.mute) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t0 = audioCtx.currentTime;
      playTick(audioCtx, t0, 0.11, 2600, 2.0, 0.009);
    } catch (err) { /* ignore audio errors */ }
  };

  // The release half of a momentary switch: a slightly softer, lower click
  // as the switch springs back to centre after its ~350 ms throw.
  window.playPanelRelease = function () {
    var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
    if (cfg && cfg.mute) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t0 = audioCtx.currentTime;
      playTick(audioCtx, t0, 0.07, 2100, 1.8, 0.008);
    } catch (err) { /* ignore audio errors */ }
  };
})();

// ==================================================================
// Audible Model 33 ASR tape-unit sounds: the reader's tape-advance
// ratchet ("стрёкот") and the punch's solenoid clicks. Synthesized with
// Web Audio on a dedicated context so they never clash with the switch
// click, the teletype/printer, the VT52 key click or the bell. Always
// on — the ratchet and the punch clicks are authentic ASR-33 mechanics —
// but the global "mute" flag silences them like every other sound source.
//
// The reader "стрёкот" models the spring-loaded ratchet wheel driving
// the tape forward: each byte read advances the sprocket holes past the
// read head, so the sound is a short cascade of crisp micro-ticks at a
// slightly descending pitch (the mechanical step of the indexer).
// The punch solenoid click is a single, louder, sharper burst — the
// punch pins striking the paper. Punching an empty byte (NUL, only the
// feed hole) fires no pins, so it is the same ratchet but quiet and
// soft — just the tape indexing with no solenoid strike.
// ==================================================================
(function installTtyMechanicalSounds() {
  var audioCtx = null;
  var noiseBuf = null; // shared short noise burst (lazy, per context)

  // One metallic tick: band-passed noise with a fast decay.
  function playTick(ctx, t, gain, center, q, dur) {
    var src = ctx.createBufferSource();
    src.buffer = ensureNoise(ctx);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = center;
    bp.Q.value = q;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(ctx.destination);
    src.start(t);
    src.stop(t + dur);
  }

  function ensureNoise(ctx) {
    if (noiseBuf) return noiseBuf;
    var len = Math.max(1, Math.floor(ctx.sampleRate * 0.02));
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  // Shared lazy context so the reader and the punch never spawn their own.
  function ensureCtx() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = audioCtx || new Ctx();
    // The very first byte may arrive outside a user gesture (e.g. the boot
    // reader in AUTO), so resuming here keeps that first click audible.
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // Reader ratchet: three quick ticks, pitch falling as the ratchet
  // indexes the sprocket holes past the read head.
  window.playReaderRatchet = function () {
    var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
    if (cfg && cfg.mute) return;
    try {
      var ctx = ensureCtx();
      if (!ctx) return;
      var t0 = ctx.currentTime;
      playTick(ctx, t0,         0.12, 3400, 2.6, 0.009);
      playTick(ctx, t0 + 0.016, 0.10, 2900, 2.4, 0.010);
      playTick(ctx, t0 + 0.032, 0.07, 2400, 2.2, 0.011);
    } catch (err) { /* ignore audio errors */ }
  };

  // Punch solenoid: a single crisp, louder burst — the pins striking the
  // paper. A slightly lower, thockier centre gives it the "solenoid clack".
  window.playPunchClick = function () {
    var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
    if (cfg && cfg.mute) return;
    try {
      var ctx = ensureCtx();
      if (!ctx) return;
      var t0 = ctx.currentTime;
      playTick(ctx, t0,         0.30, 1900, 2.2, 0.014);
      playTick(ctx, t0 + 0.010, 0.22, 3100, 2.8, 0.010);
    } catch (err) { /* ignore audio errors */ }
  };

  // Empty byte (NUL — only the feed hole): no solenoid fires, so just a
  // soft, quiet ratchet of the tape indexing one step.
  window.playPunchQuiet = function () {
    var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
    if (cfg && cfg.mute) return;
    try {
      var ctx = ensureCtx();
      if (!ctx) return;
      var t0 = ctx.currentTime;
      playTick(ctx, t0,         0.05, 3000, 2.4, 0.009);
      playTick(ctx, t0 + 0.018, 0.04, 2600, 2.2, 0.010);
    } catch (err) { /* ignore audio errors */ }
  };
})();

// ==================================================================
// Audible VT52 bell (BEL, 0x07). Synthesized with Web Audio on a
// dedicated context so it never clashes with the key-click sound. The
// "ding" is modelled as a mechanical bell: a bright fundamental plus
// two metallic partials that decay over ~0.4 s. Returns true when a
// sound was actually produced (false when audio is unavailable), so
// src/vt52.js keeps the visual flash as a fallback. Always on — the
// bell is authentic VT52 hardware behaviour, unlike keyClick.
// ==================================================================
(function installBell() {
  var audioCtx = null;
  window.playBell = function () {
    // The global "mute" flag silences the bell too, but return false so the
    // VT52 visual bell flash (src/vt52.js) still fires as a fallback.
    var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
    if (cfg && cfg.mute) return false;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      audioCtx = audioCtx || new Ctx();
      // Browsers start an AudioContext suspended until a user gesture;
      // the operator is typing by the time a program rings the bell, so
      // resuming here keeps the very first bell audible too.
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t0 = audioCtx.currentTime;
      [
        [880, 0.5],   // fundamental
        [1760, 0.25], // first metallic partial
        [2637, 0.12]  // second metallic partial
      ].forEach(function (p) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = p[0];
        gain.gain.setValueAtTime(0.08 * p[1], t0);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.4);
      });
      return true;
    } catch (err) { /* ignore audio errors */ }
    return false;
  };
})();

// ---- Sidebar visibility according to the configuration ----
function setNavVisible(page, visible) {
  var btn = document.querySelector('.nav-btn[data-page="' + page + '"]');
  if (btn) {
    if (visible) btn.classList.remove('hidden');
    else btn.classList.add('hidden');
  }
}

function applyVisibility() {
  var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
  if (!cfg) return;
  setNavVisible('teletype', cfg.consoleType === 'teletype');
  setNavVisible('vt52-console', cfg.consoleType === 'vt52');
  setNavVisible('vt52', cfg.userTerminals >= 1);
  setNavVisible('vt52-2', cfg.userTerminals >= 2);
  setNavVisible('printer', cfg.printer);
  setNavVisible('vt11', cfg.vt11);
}

// Toggle the PDP-11 photo backdrop on body. The 'no-photo-bg' class restores
// the plain dark background (see css/pdp11.css).
function applyPhotoBackdrop(enabled) {
  document.body.classList.toggle('no-photo-bg', !enabled);
}

// Toggle the pure-CSS CRT simulation on body. The 'crt-effects' class drives
// the VT52 flicker/roll overlays (see css/pdp11.css); disabling it restores
// the static scanline-only tube.
function applyCRTEffects(enabled) {
  document.body.classList.toggle('crt-effects', !!enabled);
}

// Apply the configured reverse-video mode to every live VT52 terminal
// (console + user terminals). Non-canvas terminals simply ignore it.
function applyVT52ReverseVideo(enabled) {
  for (var u = 0; u <= 2; u++) {
    var t = (typeof window.vt52Get === 'function') ? window.vt52Get(u) : null;
    if (t && typeof t.setReverseVideo === 'function') {
      t.setReverseVideo(!!enabled);
    }
  }
}

// Build the text-mode key handler for a VT52 terminal: the terminal's built-in
// handler routes typing to the emulator, but Ctrl+V always falls through to the
// native paste (routed by the textarea paste listener) and Ctrl+C copies when a
// selection exists, mirroring Windows Terminal; otherwise Ctrl+C stays ^C
// (interrupt), which interactive DEC software relies on.
function makeTextModeKeyHandler(term, ta) {
  var builtin = (typeof term._builtinKey === 'function')
      ? term._builtinKey
      : term.handleKey.bind(term);
  return function (ev) {
    var codeV = ev.keyCode || ev.which;
    var isPaste = ev.ctrlKey && (ev.key === 'v' || ev.key === 'V' || codeV === 86);
    var isCopy = ev.ctrlKey && (ev.key === 'c' || ev.key === 'C' || codeV === 67);
    if (isPaste) return; // native paste (routed by the textarea paste listener)
    if (isCopy && (ta.selectionEnd - ta.selectionStart) > 0) return; // native copy
    builtin(ev);
  };
}

// ---- Mirror the authentic 4:3 canvas geometry onto the text-mode <textarea> ----
// The textarea keeps its logical 80x24 grid (so monospace text still lays out
// in 80 columns) and is then squeezed to the 4:3 tube with the same horizontal
// scale the canvas path applies via ctx.setTransform (gridMetrics in vt52.js).
// The .vt52-crt is pinned to the visible footprint so the cabinet and the
// auto-scaler (installVT52Scaling) measure the same proportions as the canvas.
function applyVT52TextGeometry(t) {
  if (!t || typeof t.gridMetrics !== 'function') return;
  var m = t.gridMetrics();
  if (!m || m.logicalW <= 0) return;
  if (t.textArea) {
    t.textArea.style.width = m.logicalW + 'px';
    t.textArea.style.height = m.logicalH + 'px';
    t.textArea.style.transformOrigin = 'left top';
    t.textArea.style.transform = (m.scaleX < 1) ? 'scaleX(' + m.scaleX + ')' : '';
  }
  var crt = t.screenCanvas ? t.screenCanvas.parentElement : null;
  if (crt) {
    crt.style.width = m.width + 'px';
    crt.style.height = m.height + 'px';
  }
}

// ---- Undo the text-mode geometry when switching back to the canvas CRT ----
function clearVT52TextGeometry(t) {
  if (!t) return;
  if (t.textArea) t.textArea.style.transform = '';
  var crt = t.screenCanvas ? t.screenCanvas.parentElement : null;
  if (crt) {
    crt.style.width = '';
    crt.style.height = '';
  }
}

// Apply the configured text-mode preference to every live VT52 terminal
// (console + user terminals). When enabled each terminal renders through its
// visible <textarea>, giving native text selection and Windows Clipboard
// (Ctrl+C / Ctrl+V / right-click paste) for fast source-code entry; otherwise
// the authentic canvas CRT is shown again. The DOM elements are created by
// initVT52Page() (textarea is a sibling of the canvas inside .vt52-crt).
function applyVT52TextMode(enabled) {
  enabled = !!enabled;
  for (var u = 0; u <= 2; u++) {
    var t = (typeof window.vt52Get === 'function') ? window.vt52Get(u) : null;
    if (!t) continue;
    var canvas = t.screenCanvas;
    var ta = t.textArea;
    if (!canvas || !ta) continue;
    if (enabled) {
      t.allowCanvas = false;
      canvas.style.display = 'none';
      ta.style.display = 'block';
      // Restore the text-mode key handler so typing reaches the emulator and
      // Ctrl+V / Ctrl+C behave like Windows Terminal (native clipboard).
      if (typeof t._builtinKey === 'function') t.handleKey = makeTextModeKeyHandler(t, ta);
      // Mirror the authentic 4:3 canvas CRT onto the textarea (logical grid +
      // horizontal scaleX), keeping the tube the same proportions as the canvas.
      applyVT52TextGeometry(t);
      if (typeof ta.focus === 'function') ta.focus();
    } else {
      t.allowCanvas = true;
      ta.style.display = 'none';
      canvas.style.display = 'block';
      // Drop the text-mode squeeze so the canvas path fully controls the tube.
      clearVT52TextGeometry(t);
      // Size the canvas to the current grid first: the buffer may still hold
      // the raw HTML attribute dimensions (672x504) when the terminal was
      // started in text mode and initVT52Page's canvas branch never ran, which
      // would otherwise render a squashed, wide-flat CRT. resizeCanvas() is
      // idempotent, so re-sizing an already-correct canvas is harmless.
      if (typeof t.resizeCanvas === 'function') t.resizeCanvas();
      // Canvas mode relies on the global installVT52Keyboard() handler, so the
      // terminal's built-in keydown listener is silenced to avoid double
      // sending (mirrors initVT52Page's canvas branch).
      t.handleKey = function () { };
      if (typeof canvas.focus === 'function') canvas.focus();
    }
    // Redraw the whole screen in the newly active rendering path.
    if (typeof t.render === 'function') t.render(true);
  }
}

// ---- Leaving the CONFIG page with uncommitted changes ----
// Confirmation dialog reusing the shared modal overlay style (modal-* classes,
// see css/pdp11.css) so it matches the first-run hint. onLeave() runs when the
// user confirms leaving; onStay() when they cancel or click the backdrop.
var __configLeaveCallbacks = { onLeave: null, onStay: null };
var __configLeaveOverlay = null;

window.configConfirmLeave = function (onLeave, onStay) {
  __configLeaveCallbacks.onLeave = onLeave || null;
  __configLeaveCallbacks.onStay = onStay || null;
  if (!__configLeaveOverlay) {
    __configLeaveOverlay = document.createElement('div');
    __configLeaveOverlay.id = 'config-leave-overlay';
    __configLeaveOverlay.className = 'modal-overlay';
    __configLeaveOverlay.innerHTML =
      '<div class="modal-box">' +
        '<span class="modal-title">Unapplied configuration</span>' +
        '<p class="modal-intro">You have uncommitted configuration changes. ' +
        'Press Apply on the Config page to commit them before leaving.</p>' +
        '<button type="button" class="modal-close" data-leave-action="stay">Stay</button>' +
        '<button type="button" class="modal-close" data-leave-action="leave">Leave</button>' +
        '<button type="button" class="modal-close" data-leave-action="apply-leave">Apply & Leave</button>' +
      '</div>';
    __configLeaveOverlay.addEventListener('click', function (e) {
      var action = e.target.getAttribute && e.target.getAttribute('data-leave-action');
      var cb = __configLeaveCallbacks;
      if (action === 'apply-leave') {
        // Commit the pending changes through the form's own Apply button and
        // then leave the page (switchPage runs as the onLeave callback).
        __configLeaveOverlay.classList.remove('visible');
        var applyBtn = document.getElementById('config-apply');
        if (applyBtn) applyBtn.click();
        if (cb.onLeave) cb.onLeave();
      } else if (action === 'leave') {
        __configLeaveOverlay.classList.remove('visible');
        if (cb.onLeave) cb.onLeave();
      } else if (action === 'stay' || e.target === __configLeaveOverlay) {
        __configLeaveOverlay.classList.remove('visible');
        if (cb.onStay) cb.onStay();
      }
    });
    document.body.appendChild(__configLeaveOverlay);
  }
  __configLeaveOverlay.classList.add('visible');
};

// ---- CONFIG / Storage page tabs: switch between the grouped panels ----
// One tab list per .config-tabs container (the CONFIG page and the Storage
// page), so both tab sets share the same markup, styling and behaviour.
function initConfigTabs() {
  document.querySelectorAll('.config-tabs').forEach(function (container) {
    var tabs = container.querySelectorAll('.config-tab');
    if (!tabs.length) return;

    function indexOf(tab) {
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i] === tab) return i;
      }
      return -1;
    }

    function selectTab(tab) {
      for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        var active = (t === tab);
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
        t.tabIndex = active ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.classList.toggle('active', active);
      }
      if (tab) tab.focus();
    }

    for (var j = 0; j < tabs.length; j++) {
      tabs[j].addEventListener('click', function () { selectTab(this); });
    }

    // Arrow-key navigation within the tab list (WAI-ARIA tabs pattern).
    for (var k = 0; k < tabs.length; k++) {
      tabs[k].addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        var idx = indexOf(this);
        var next = (e.key === 'ArrowRight') ? idx + 1 : idx - 1;
        if (next < 0) next = tabs.length - 1;
        if (next >= tabs.length) next = 0;
        selectTab(tabs[next]);
      });
    }
  });
}

// ---- Help Me! sticker visibility (CONFIG -> Behaviour) ----
// Shows/hides the operator's hand-written bootstrap sticky note on the Panel
// page. Shared by the Help Me! button (pdp11-panel.js) and the Behaviour-tab
// checkbox, so both stay in sync. Live: no reload needed.
function applyPanelSticker(visible) {
  var sticker = document.querySelector('.panel-sticker');
  if (sticker) sticker.classList.toggle('hidden', !visible);
  var btn = document.getElementById('panel-sticker-btn');
  if (btn) {
    btn.classList.toggle('active', !!visible);
    btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
  }
}
window.applyPanelSticker = applyPanelSticker;

// ---- Machine power (CONFIG -> Behaviour) -----------------------------
// Powers the PDP-11 on/off: turns the front-panel POWER LOCK key, halts the
// CPU when powering down and silences the ambient hum. Shared by the
// Behaviour-tab "Machine power" checkbox and the front-panel POWER LOCK labels
// (pdp11-panel.js). With the "auto-boot" option set, turning the machine ON
// starts the default bootstrap; otherwise the operator presses Bootstrap now!
// on the Panel page or types a boot command on the console. `skipAutoBoot`
// suppresses that for programmatic power-ons that already reboot (e.g.
// resetPanelControls during doReboot). Live: no reload needed.
function applyMachinePower(powerOn, skipAutoBoot) {
  if (typeof panel === 'undefined') return;
  var wasOn = panel.powerSwitch >= 0;
  panel.powerSwitch = powerOn ? 0 : -1;
  if (!powerOn && typeof CPU !== 'undefined') {
    CPU.runState = STATE_HALT;
  }
  var key = document.getElementById('key');
  if (key) key.style.transform = 'rotate(' + (panel.powerSwitch * 90 - 45) + 'deg)';
  if (window.Hum) window.Hum.update();
  // Sync the Panel nav status indicators immediately (power lamp + run-state
  // icon — see PanelLed in src/panel-led.js; its timer keeps them in sync as
  // the CPU run state changes elsewhere).
  if (window.PanelLed) window.PanelLed.update();
  // Persist the live power state so it survives reloads and stays in sync
  // with the Behaviour checkbox.
  if (typeof Config !== 'undefined') Config.set({ powerOn: powerOn });
  // Start the default bootstrap when the machine is turned on, unless the
  // caller already reboots (skipAutoBoot) — gated on the auto-boot option.
  if (powerOn && !skipAutoBoot && !wasOn &&
      typeof Config !== 'undefined' && Config.get().autoBoot) {
    boot();
  }
}
window.applyMachinePower = applyMachinePower;

// ---- CONFIG page form: populate controls and wire up events ----
function initConfigForm() {
  var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
  if (!cfg) return;

  var radios = document.querySelectorAll('input[name="consoleType"]');
  var capRadios = document.querySelectorAll('input[name="keyboardLayout"]');
  var speedRadios = document.querySelectorAll('input[name="teletypeSpeed"]');
  var userTerm = document.getElementById('config-userTerminals');
  var printerEl = document.getElementById('config-printer');
  var vt11El = document.getElementById('config-vt11');
  var pwEl = document.getElementById('config-printWidth');
  var pwrEl = document.getElementById('config-printerWidth');
  var kcEl = document.getElementById('config-keyClick');
  var upperCaseEl = document.getElementById('config-upperCaseOnly');
  var vt52RevEl = document.getElementById('config-vt52ReverseVideo');
  var crtEl = document.getElementById('config-crtEffects');
  var textModeEl = document.getElementById('config-vt52TextMode');
  var humEl = document.getElementById('config-hum');
  var pbEl = document.getElementById('config-photoBackdrop');
  var confirmRebootEl = document.getElementById('config-confirmReboot');
  var panelStickerEl = document.getElementById('config-panelSticker');
  var powerOnEl = document.getElementById('config-powerOn');
  var autoBootEl = document.getElementById('config-autoBoot');
  var firstRunEl = document.getElementById('config-showFirstRunHint');
  var applyBtn = document.getElementById('config-apply');
  var resetBtn = document.getElementById('config-reset');

  function setRadioChecked(list, value) {
    for (var i = 0; i < list.length; i++) {
      list[i].checked = (list[i].value === value);
    }
  }

  // Populate the form from the persisted config.
  setRadioChecked(radios, cfg.consoleType);
  setRadioChecked(capRadios, cfg.keyboardLayout);
  setRadioChecked(speedRadios, cfg.teletypeSpeed);
  if (userTerm) userTerm.value = String(cfg.userTerminals);
  if (printerEl) printerEl.checked = cfg.printer;
  if (vt11El) vt11El.checked = cfg.vt11;
  if (pwEl) pwEl.value = String(cfg.printWidth);
  if (pwrEl) pwrEl.value = String(cfg.printerWidth);
  if (kcEl) kcEl.checked = cfg.keyClick;
  if (upperCaseEl) upperCaseEl.checked = cfg.upperCaseOnly;
  if (vt52RevEl) vt52RevEl.checked = cfg.vt52ReverseVideo;
  if (crtEl) crtEl.checked = cfg.crtEffects;
  if (textModeEl) textModeEl.checked = cfg.vt52TextMode;
  if (humEl) humEl.checked = cfg.hum;
  if (pbEl) pbEl.checked = cfg.photoBackdrop;
  if (confirmRebootEl) confirmRebootEl.checked = cfg.confirmReboot;
  if (panelStickerEl) panelStickerEl.checked = cfg.panelSticker;
  if (powerOnEl) powerOnEl.checked = cfg.powerOn;
  if (autoBootEl) autoBootEl.checked = cfg.autoBoot;
  // The first-run hint is not part of the persisted Config: its state lives in
  // the onboarding flag, so read it straight from the Onboarding module.
  if (firstRunEl && typeof Onboarding !== 'undefined') {
    firstRunEl.checked = Onboarding.isEnabled();
  }
  applyPhotoBackdrop(cfg.photoBackdrop);
  applyCRTEffects(cfg.crtEffects);
  updateEquipmentVisibility();

  // Read every control into a full config-shaped object. The values come from
  // the fixed option lists, so they always survive Config.validate() unchanged.
  function readForm() {
    var consoleType = 'teletype';
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) consoleType = radios[i].value;
    }
    var teletypeSpeed = 'authentic';
    for (var j = 0; j < speedRadios.length; j++) {
      if (speedRadios[j].checked) teletypeSpeed = speedRadios[j].value;
    }
    var keyboardLayout = 'drawn';
    for (var m = 0; m < capRadios.length; m++) {
      if (capRadios[m].checked) keyboardLayout = capRadios[m].value;
    }
    return {
      consoleType: consoleType,
      keyboardLayout: keyboardLayout,
      userTerminals: (userTerm) ? Number(userTerm.value) : cfg.userTerminals,
      printer: (printerEl) ? printerEl.checked : cfg.printer,
      vt11: (vt11El) ? vt11El.checked : cfg.vt11,
      printWidth: (pwEl) ? Number(pwEl.value) : cfg.printWidth,
      printerWidth: (pwrEl) ? Number(pwrEl.value) : cfg.printerWidth,
      teletypeSpeed: teletypeSpeed,
      keyClick: (kcEl) ? kcEl.checked : cfg.keyClick,
      upperCaseOnly: (upperCaseEl) ? upperCaseEl.checked : cfg.upperCaseOnly,
      vt52ReverseVideo: (vt52RevEl) ? vt52RevEl.checked : cfg.vt52ReverseVideo,
      crtEffects: (crtEl) ? crtEl.checked : cfg.crtEffects,
      vt52TextMode: (textModeEl) ? textModeEl.checked : cfg.vt52TextMode,
      hum: (humEl) ? humEl.checked : cfg.hum,
      photoBackdrop: (pbEl) ? pbEl.checked : cfg.photoBackdrop,
      // confirmReboot is a live setting that can also be toggled from the
      // reboot confirmation dialog (pdp11-panel.js), which never touches the
      // form DOM. Read it from the persisted config so a stale checkbox cannot
      // mark the form as dirty or be overwritten by Apply.
      confirmReboot: (typeof Config !== 'undefined')
          ? Config.get().confirmReboot
          : cfg.confirmReboot,
      // panelSticker is live (toggled by the Help Me! button outside this
      // form), so read it from the persisted config like confirmReboot.
      panelSticker: (typeof Config !== 'undefined')
          ? Config.get().panelSticker
          : cfg.panelSticker,
      // powerOn is live (the front-panel POWER LOCK updates it outside this
      // form), so read it from the persisted config like panelSticker.
      powerOn: (typeof Config !== 'undefined')
          ? Config.get().powerOn
          : cfg.powerOn,
      autoBoot: (typeof Config !== 'undefined')
          ? Config.get().autoBoot
          : cfg.autoBoot
    };
  }

  // The form is dirty when its values differ from the persisted config. Live
  // settings update Config immediately, so only uncommitted structural edits
  // (and a pending Restore-defaults) surface as a difference.
  function isDirty() {
    if (typeof Config === 'undefined') return false;
    var current = Config.get();
    var form = readForm();
    return form.consoleType !== current.consoleType ||
      form.userTerminals !== current.userTerminals ||
      form.printer !== current.printer ||
      form.vt11 !== current.vt11 ||
      form.printWidth !== current.printWidth ||
      form.printerWidth !== current.printerWidth ||
      form.teletypeSpeed !== current.teletypeSpeed ||
      form.keyboardLayout !== current.keyboardLayout ||
      form.keyClick !== current.keyClick ||
      form.upperCaseOnly !== current.upperCaseOnly ||
      form.vt52ReverseVideo !== current.vt52ReverseVideo ||
      form.crtEffects !== current.crtEffects ||
      form.vt52TextMode !== current.vt52TextMode ||
      form.hum !== current.hum ||
      form.photoBackdrop !== current.photoBackdrop ||
      form.confirmReboot !== current.confirmReboot;
  }

  // Re-tune the live console/printer instances from a full config snapshot.
  function applyLive(f) {
    if (g60printer) {
      if (g60printer.setMaxCols) g60printer.setMaxCols(f.printWidth);
      if (g60printer.setCharPrintDelay) g60printer.setCharPrintDelay(teletypeDelay(f.teletypeSpeed));
      ttySyncSheetWidth();
    }
    if (window.lp11G60Printer && window.lp11G60Printer.setMaxCols) {
      window.lp11G60Printer.setMaxCols(f.printerWidth);
    }
    applyVT52ReverseVideo(f.vt52ReverseVideo);
    applyVT52TextMode(f.vt52TextMode);
    applyCRTEffects(f.crtEffects);
    applyPhotoBackdrop(f.photoBackdrop);
    applyPanelSticker(f.panelSticker);
  }

  function updateDirtyUI() {
    if (applyBtn) applyBtn.classList.toggle('dirty', isDirty());
  }

  // Structural changes are no longer applied on the fly; they only mark the
  // form as dirty and are committed together by the Apply button.
  function markStructural() {
    updateDirtyUI();
  }

  // Conditional state on the Equipment tab: teletype-only parameters are
  // active only when the console terminal is a teletype, and the printer
  // width only when an LP11 is installed. Inapplicable fields are dimmed and
  // their controls disabled (see .config-field.config-disabled in
  // css/pdp11.css) instead of being hidden — the form reads as a stable list
  // where greyed-out options explain their dependency, and the Defaults/Apply
  // bar below it never jumps.
  function setFieldDisabled(field, disabled) {
    field.classList.toggle('config-disabled', disabled);
    var controls = field.querySelectorAll('input, select, button');
    for (var i = 0; i < controls.length; i++) {
      controls[i].disabled = disabled;
    }
  }

  function updateEquipmentVisibility() {
    var teletype = false;
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked && radios[i].value === 'teletype') teletype = true;
    }
    var ttyFields = [
      document.getElementById('config-field-printWidth'),
      document.getElementById('config-field-teletypeSpeed'),
      document.getElementById('config-field-upperCaseOnly'),
      document.getElementById('config-field-keyboardLayout')
    ];
    for (var k = 0; k < ttyFields.length; k++) {
      if (ttyFields[k]) setFieldDisabled(ttyFields[k], !teletype);
    }
    var pwField = document.getElementById('config-field-printerWidth');
    if (pwField) setFieldDisabled(pwField, !(printerEl && printerEl.checked));
  }

  // Apply: persist the whole form in one Config.set() call, then reload only
  // when the hardware layout changed (so iopage.js re-registers the devices).
  function applyForm() {
    if (typeof Config === 'undefined') return;
    var before = Config.get();
    var form = readForm();
    var structuralChanged =
      form.consoleType !== before.consoleType ||
      form.userTerminals !== before.userTerminals ||
      form.printer !== before.printer ||
      form.vt11 !== before.vt11;
    // Persist the complete form (validated) and refresh the in-memory snapshot.
    Config.set(form);
    // Re-tune live instances; harmless if we are about to reload anyway.
    applyLive(readForm());
    if (structuralChanged) {
      // The form now equals the saved config, so the beforeunload guard
      // (registered below) won't intercept this intentional reload.
      window.location.reload();
    } else {
      updateDirtyUI();
    }
  }

  for (var i = 0; i < radios.length; i++) {
    radios[i].addEventListener('change', function () {
      if (this.checked) {
        markStructural();
        updateEquipmentVisibility();
      }
    });
  }
  if (userTerm) {
    userTerm.addEventListener('change', markStructural);
  }
  if (printerEl) {
    printerEl.addEventListener('change', function () {
      markStructural();
      updateEquipmentVisibility();
    });
  }
  if (vt11El) {
    vt11El.addEventListener('change', markStructural);
  }

  // Teletype speed applies live (no reload): persist the choice and retune the
  // existing console printer's char pacing.
  for (var j = 0; j < speedRadios.length; j++) {
    speedRadios[j].addEventListener('change', function () {
      if (!this.checked) return;
      if (typeof Config !== 'undefined') Config.set({ teletypeSpeed: this.value });
      if (g60printer && g60printer.setCharPrintDelay) {
        g60printer.setCharPrintDelay(teletypeDelay(this.value));
      }
      updateDirtyUI();
    });
  }

  // Keycap layout applies live (no reload): persist the choice and switch the
  // keyboard between the keycaps drawn by the artwork and the CSS-drawn caps.
  for (var n = 0; n < capRadios.length; n++) {
    capRadios[n].addEventListener('change', function () {
      if (!this.checked) return;
      if (typeof Config !== 'undefined') Config.set({ keyboardLayout: this.value });
      if (typeof g60Keyboard !== 'undefined' && g60Keyboard.setLayout) {
        g60Keyboard.setLayout(this.value);
      }
      updateDirtyUI();
    });
  }

  // Live changes apply without reloading.
  if (pwEl) {
    pwEl.addEventListener('change', function () {
      if (typeof Config !== 'undefined') Config.set({ printWidth: Number(this.value) });
      if (g60printer && g60printer.setMaxCols) g60printer.setMaxCols(Number(this.value));
      // The printable width changed: publish the new sheet width and re-fit the
      // sheet onto the artwork's Paper marker (the scale is derived from it).
      ttySyncSheetWidth();
      if (typeof window.__ttyRescale === 'function') window.__ttyRescale();
      updateDirtyUI();
    });
  }
  if (pwrEl) {
    pwrEl.addEventListener('change', function () {
      if (typeof Config !== 'undefined') Config.set({ printerWidth: Number(this.value) });
      if (window.lp11G60Printer && window.lp11G60Printer.setMaxCols) {
        window.lp11G60Printer.setMaxCols(Number(this.value));
      }
      updateDirtyUI();
    });
  }
  if (kcEl) {
    kcEl.addEventListener('change', function () {
      if (typeof Config !== 'undefined') Config.set({ keyClick: this.checked });
      updateDirtyUI();
    });
  }
  // VT52 reverse video applies immediately to the live terminals (no reload).
  if (vt52RevEl) {
    vt52RevEl.addEventListener('change', function () {
      if (typeof Config !== 'undefined') Config.set({ vt52ReverseVideo: this.checked });
      applyVT52ReverseVideo(this.checked);
      updateDirtyUI();
    });
  }
  // CRT effects apply immediately (no reload): toggling the body class that
  // drives the pure-CSS flicker/roll overlays (see css/pdp11.css).
  if (crtEl) {
    crtEl.addEventListener('change', function () {
      if (typeof Config !== 'undefined') Config.set({ crtEffects: this.checked });
      applyCRTEffects(this.checked);
      updateDirtyUI();
    });
  }
  // VT52 text mode applies immediately (no reload): switch every live VT52
  // terminal between the canvas CRT and a plain <textarea> (native clipboard).
  if (textModeEl) {
    textModeEl.addEventListener('change', function () {
      if (typeof Config !== 'undefined') Config.set({ vt52TextMode: this.checked });
      applyVT52TextMode(this.checked);
      updateDirtyUI();
    });
  }
  // Ambient power-supply hum applies immediately (no reload): persist the
  // choice; Hum.update() re-reads the config on its next tick.
  if (humEl) {
    humEl.addEventListener('change', function () {
      if (typeof Config !== 'undefined') Config.set({ hum: this.checked });
      if (window.Hum) window.Hum.update();
      updateDirtyUI();
    });
  }
  if (pbEl) {
    pbEl.addEventListener('change', function () {
      if (typeof Config !== 'undefined') Config.set({ photoBackdrop: this.checked });
      applyPhotoBackdrop(this.checked);
      updateDirtyUI();
    });
  }
  // Reboot confirmation applies immediately (no reload): the REBOOT handler
  // re-reads the config on every click.
  if (confirmRebootEl) {
    confirmRebootEl.addEventListener('change', function () {
      if (typeof Config !== 'undefined') Config.set({ confirmReboot: this.checked });
      updateDirtyUI();
    });
  }
  // Help Me! sticker applies immediately (no reload): the Panel-page button
  // persists the same CONFIG option.
  if (panelStickerEl) {
    panelStickerEl.addEventListener('change', function () {
      if (typeof Config !== 'undefined') Config.set({ panelSticker: this.checked });
      applyPanelSticker(this.checked);
      updateDirtyUI();
    });
  }
  // Machine power applies immediately (no reload): power the PDP-11 on/off
  // (the front-panel POWER LOCK persists the same option). With auto-boot
  // set, turning it on starts the default bootstrap.
  if (powerOnEl) {
    powerOnEl.addEventListener('change', function () {
      applyMachinePower(this.checked, false);
      updateDirtyUI();
    });
  }
  // Auto-boot applies immediately (no reload): it only affects the next
  // power-on, so just persist the choice.
  if (autoBootEl) {
    autoBootEl.addEventListener('change', function () {
      if (typeof Config !== 'undefined') Config.set({ autoBoot: this.checked });
      updateDirtyUI();
    });
  }
  // First-run hint applies immediately (no reload): toggling the checkbox
  // clears/sets the onboarding "seen" flag, so the welcome overlay shows or
  // stays hidden on the next launch.
  if (firstRunEl && typeof Onboarding !== 'undefined') {
    firstRunEl.addEventListener('change', function () {
      Onboarding.setEnabled(this.checked);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      if (typeof Config === 'undefined') return;
      var d = Config.DEFAULTS;
      setRadioChecked(radios, d.consoleType);
      setRadioChecked(capRadios, d.keyboardLayout);
      setRadioChecked(speedRadios, d.teletypeSpeed);
      if (userTerm) userTerm.value = String(d.userTerminals);
      if (printerEl) printerEl.checked = d.printer;
      if (vt11El) vt11El.checked = d.vt11;
      if (pwEl) pwEl.value = String(d.printWidth);
      if (pwrEl) pwrEl.value = String(d.printerWidth);
      if (kcEl) kcEl.checked = d.keyClick;
      if (vt52RevEl) vt52RevEl.checked = d.vt52ReverseVideo;
      if (crtEl) crtEl.checked = d.crtEffects;
      if (textModeEl) textModeEl.checked = d.vt52TextMode;
      if (humEl) humEl.checked = d.hum;
      if (pbEl) pbEl.checked = d.photoBackdrop;
      if (confirmRebootEl) confirmRebootEl.checked = d.confirmReboot;
      if (panelStickerEl) panelStickerEl.checked = d.panelSticker;
      if (powerOnEl) powerOnEl.checked = d.powerOn;
      if (autoBootEl) autoBootEl.checked = d.autoBoot;
      // The four BEHAVIOUR settings above are live options: they persist the
      // moment their checkboxes change and can be toggled outside this form
      // (the reboot dialog, the Help Me! button, the front-panel POWER LOCK),
      // so readForm() never reads them from the checkboxes. Restore defaults
      // therefore resets them for real, exactly as if each checkbox had been
      // toggled to the factory value: confirmReboot and autoBoot are
      // persisted, the sticker is re-applied, and the machine powers down to
      // the factory "off" state.
      if (confirmRebootEl && typeof Config !== 'undefined') {
        Config.set({ confirmReboot: d.confirmReboot });
      }
      if (panelStickerEl) {
        if (typeof Config !== 'undefined') Config.set({ panelSticker: d.panelSticker });
        applyPanelSticker(d.panelSticker);
      }
      if (powerOnEl) applyMachinePower(d.powerOn, false);
      if (autoBootEl && typeof Config !== 'undefined') {
        Config.set({ autoBoot: d.autoBoot });
      }
      // The rest of the form now shows factory values; nothing is persisted
      // until Apply.
      updateEquipmentVisibility();
      updateDirtyUI();
    });
  }

  if (applyBtn) {
    applyBtn.addEventListener('click', applyForm);
  }

  // Expose the dirty state so sidebar navigation (pdp11-panel.js) and the
  // beforeunload guard below can warn about uncommitted changes.
  window.isConfigDirty = isDirty;

  // Warn before closing/reloading the page with uncommitted config changes.
  // The quick-boot wizard sets __allowConfigReload before its intentional
  // profile-driven reload, so the browser does not ask "Reload site?".
  window.addEventListener('beforeunload', function (e) {
    if (window.__allowConfigReload) return;
    if (!window.isConfigDirty || !window.isConfigDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  updateDirtyUI();
}

// ---- Proportional scaling of the VT52 cabinet ----
// When the browser window is too small for the full-size DECscope cabinet,
// scale it down proportionally (transform: scale) instead of clipping it.
// The natural (unscaled) size is measured on every pass after clearing the
// transform, so hidden pages (display:none → offsetWidth 0) are simply
// skipped and get sized once they become visible. The container's height is
// reserved to match the scaled cabinet (transform does not affect layout),
// so there is no dead space or overlap.
function installVT52Scaling() {
  if (typeof ResizeObserver === 'undefined') return;

  ['page-vt52', 'page-vt52-console', 'page-vt52-2'].forEach(function (pageId) {
    var page = document.getElementById(pageId);
    if (!page) return;
    var container = page.querySelector('.vt52-container');
    var terminal = page.querySelector('.vt52-terminal');
    if (!container || !terminal) return;

    function apply() {
      // Clear the transform to measure natural (unscaled) geometry.
      terminal.style.transform = '';
      var natW = terminal.offsetWidth;
      var natH = terminal.offsetHeight;
      if (!natW || !natH) return; // hidden page — skip until visible
      // Height reserved for the status row below the cabinet.
      var statusPad = Math.max(0, container.offsetHeight - natH);

      var s = Math.min(1, (page.clientWidth - 24) / natW);
      if (s < 0.1) s = 0.1; // never collapse below readability
      terminal.style.transformOrigin = 'top center';
      terminal.style.transform = (s < 1) ? 'scale(' + s + ')' : '';
      container.style.height = (natH * s + statusPad) + 'px';
    }

    apply();
    var ro = new ResizeObserver(apply);
    ro.observe(page);
  });
}

// ---- Proportional scaling of the LP11 printer cabinet ----
// Mirrors installVT52Scaling: when the window is too small for the full-width
// (1160px) LP11 cabinet, scale it down proportionally (transform: scale)
// instead of clipping it. The cabinet is pinned to the bottom of the page
// (margin-top:auto), so its reserved layout height is shrunk to natH*s and the
// flex column keeps exactly the visual footprint — no dead space, no bottom
// clipping. The live --lp11-scale variable is consumed by g60printer.css so
// the paper's viewport-relative max-height is divided by the scale, keeping
// the fanfold climbing the same fraction of the window after scaling. Hidden
// pages (display:none → offsetWidth 0) are skipped and re-sized once they
// become visible.
function lp11FitScale(availW, availH, natW, natH, fixedH) {
  if (!natW || !natH) return 1;
  var s = Math.min(1, (availW > 0) ? availW / natW : 1);
  // Only constrain vertically when there is actually room left over for the
  // cabinet after the fixed (unscaled) spacer + actions rows are accounted for.
  var spaceH = availH - fixedH;
  if (spaceH > 0 && natH > spaceH) {
    s = Math.min(s, spaceH / natH);
  }
  if (s < 0.1) s = 0.1; // never collapse below readability
  return s;
}

function installLP11Scaling() {
  if (typeof ResizeObserver === 'undefined') return;
  var page = document.getElementById('page-printer');
  if (!page) return;
  var cabinet = page.querySelector('.lp11-cabinet');
  var spacer = page.querySelector('p.clear');
  var actions = page.querySelector('.printer-actions');
  if (!cabinet || !actions) return;

  function apply() {
    // Clear the transform, reserved geometry and margins before measuring, so
    // offsetHeight always returns the natural (unscaled) size. Leaving the
    // previously applied scale/height/margin in place would make each pass
    // compound on the last (offsetHeight would already be the shrunk height)
    // and the cabinet would never restore when the window grows back.
    cabinet.style.transform = '';
    cabinet.style.height = '';
    cabinet.style.marginBottom = '';
    cabinet.style.setProperty('--lp11-scale', 1);
    var natW = cabinet.offsetWidth;
    var natH = cabinet.offsetHeight;
    if (!natW || !natH) return; // hidden page — skip until visible

    // Unscaled chrome (top spacer + actions row) keeps its full layout height.
    var fixedH = (spacer ? spacer.offsetHeight : 0) +
                 (actions ? actions.offsetHeight : 0);
    var s = lp11FitScale(page.clientWidth - 24, page.clientHeight - 24,
                         natW, natH, fixedH);

    cabinet.style.transformOrigin = 'top center';
    cabinet.style.transform = (s < 1) ? 'scale(' + s + ')' : '';
    // Keep the cabinet at its natural height so its beige background covers the
    // full content (mechanics bay + operator console) and scales uniformly with
    // it. Reserving the height here would double-shrink the background (the
    // scale is applied again by the transform) and leave the console strip
    // sticking out below the cabinet. Transform does not affect layout, so pull
    // the following actions row up by the now-empty bottom (natH*(1-s)) with a
    // negative margin: the scaled cabinet sits flush above the actions row.
    cabinet.style.marginBottom = (s < 1) ? (-(natH * (1 - s))) + 'px' : '';
    cabinet.style.setProperty('--lp11-scale', s);
  }

  apply();
  var ro = new ResizeObserver(apply);
  ro.observe(page);
}

// ---- Proportional scaling of the front panel (with the Help Me! sticker) ----
// The PDP-11/70 front panel (.frame) has a fixed native size and — unlike the
// VT52 and LP11 cabinets — was never scaled down, so on narrow windows (small
// viewport or a high UI zoom) the operator's hand-written sticky note, which
// sticks out ~270px to the LEFT of the panel (see .panel-sticker in
// css/pdp11.css), slid under the navigation sidebar. This mirrors
// installLP11Scaling: when the panel page cannot fit the panel plus its
// sticker, scale the whole .frame (the sticker is a child of .frame, so it
// scales along) via transform: scale. The frame stays centred, so the sticker
// needs symmetric room on both sides: the available width must fit
// natW + 2 * extent. The extent is measured live from the note's rotated
// bounding box (getBoundingClientRect already includes the -3deg tilt), so
// the fit always reserves exactly what the note actually needs. A 40px page
// margin keeps the note M/2 = 20px clear of the page edge — past the
// sidebar's box-shadow — whenever scaling is active.
function panelFitScale(availW, availH, natW, natH, stickerExtent) {
  if (!natW || !natH) return 1;
  var s = Math.min(1, (availW > 0) ? availW / (natW + 2 * stickerExtent) : 1);
  if (availH > 0 && natH > availH) {
    s = Math.min(s, availH / natH);
  }
  if (s < 0.1) s = 0.1; // never collapse below readability
  return s;
}

function installPanelScaling() {
  if (typeof ResizeObserver === 'undefined') return;
  var page = document.getElementById('page-panel');
  if (!page) return;
  var frame = page.querySelector('.frame');
  if (!frame) return;
  var sticker = page.querySelector('.panel-sticker');
  // Fallback for the note's left protrusion when it cannot be measured (a
  // visible note whose layout has not flushed yet): 260px wide note + 8px gap
  // to the panel edge (see css/pdp11.css .panel-sticker).
  var fallbackExtent = 268;

  // Measure how far the note's real bounding box reaches to the LEFT of the
  // frame. getBoundingClientRect already includes the -3deg rotation, so the
  // swinging top-left corner is accounted for regardless of the note's actual
  // height or font rendering. Returns 0 while the note is hidden (nothing to
  // reserve for).
  function measureExtent() {
    if (!sticker || sticker.classList.contains('hidden')) return 0;
    var fr = frame.getBoundingClientRect();
    var sr = sticker.getBoundingClientRect();
    if (!sr.width || !sr.height) return 0; // not rendered yet
    return Math.max(0, fr.left - sr.left);
  }

  function apply() {
    // Clear the transform before measuring so offsetWidth returns the natural
    // (unscaled) size; hidden pages (display:none -> offsetWidth 0) are
    // skipped and re-sized once they become visible.
    frame.style.transform = '';
    var natW = frame.offsetWidth;
    var natH = frame.offsetHeight;
    if (!natW || !natH) return; // hidden page - skip until visible

    var extent = measureExtent();
    if (extent === 0 && sticker && !sticker.classList.contains('hidden')) {
      extent = fallbackExtent; // visible note, layout not flushed yet
    }
    // 40px horizontal margin keeps the note's bounding box M/2 = 20px clear of
    // the page edge (and past the sidebar's box-shadow) whenever scaling is
    // active; the same 40px vertical margin mirrors it on the other axis.
    var s = panelFitScale(page.clientWidth - 40, page.clientHeight - 40,
                          natW, natH, extent);
    // 'center center' pivots around the flex-centred layout box, so the
    // shrunk panel (and its sticker) stay visually centred in the page.
    frame.style.transformOrigin = 'center center';
    frame.style.transform = (s < 1) ? 'scale(' + s + ')' : '';
  }

  apply();
  var ro = new ResizeObserver(apply);
  ro.observe(page);
  // The note is absolute/out-of-flow, so toggling its visibility does not
  // resize the page; observe it directly so apply() re-runs (and re-measures
  // the extent) when the Help Me! button shows/hides the sticker.
  if (sticker) ro.observe(sticker);
}

// ---- Model 33 ASR console paper: grow upward to the top of the window ----
// Mirrors the LP11 printer page: the console paper is anchored to the
// carriage and grows upward (height:auto, bottom:64px in g60printer.css)
// until its top edge reaches the top of the browser window, at which point
// the paper's own scrollbar appears. The teletype page is vertically
// centred (justify-content:center), so the carriage-to-window-top distance
// is NOT a fixed constant (unlike the LP11 cabinet, which is pinned to the
// bottom of the page) — it must be measured live. The paper bottom (== the
// carriage) in viewport coordinates is exactly the max height that lets the
// paper top reach y=0, so it is applied as --tty-paper-max.
// Kept as a standalone, DOM-free helper so it can be extracted and
// unit-tested in Node (see tests/teletype-paper-growth.test.js).
function teletypePaperMaxHeight(carriageBottomPx, topReservePx) {
  var max = Number(carriageBottomPx) - (Number(topReservePx) || 0);
  return max > 0 ? max : 0;
}

// Visual scale of a teletype element: its rendered width (transforms applied)
// over its layout width (transform-free). The rig is scaled as a whole
// (installTeletypeScaling sets --tty-scale) and every block inside it carries
// its own contain scale (--tty-*-k, see the "SVG art layer" block in
// css/g60printer.css), so the ratio IS the product of those transforms — the
// paper window and the two hanging tapes divide their viewport-driven
// max-height by it to still reach the window edge. Pure (both widths are
// injected) so it can be extracted and unit-tested in Node.
function ttyScaleFor(rectWidth, offsetWidth) {
  var rendered = Number(rectWidth);
  var layout = Number(offsetWidth);
  if (!isFinite(rendered) || !isFinite(layout) || layout <= 0 || rendered <= 0) {
    return 1;
  }
  return rendered / layout;
}

// ---- The artwork is the source of truth ------------------------------------
// The marker rects of assets/Model-33-ASR.svg are read AT RUNTIME and pushed
// into the --tty-* variables of #teletype-rig, so moving a marker in Inkscape
// moves the matching HTML control — the numbers in css/g60printer.css are only
// the fallback for builds where the artwork cannot be fetched (strict file://
// origin). The parser is pure and unit-tested
// (tests/teletype-svg-backdrop.test.js).
var TTY_ART_URL = 'assets/Model-33-ASR.svg';

// The fetched artwork text, kept so the quad projections can be re-derived
// whenever their inputs move (the sheet factor follows the column count).
var ttyArtText = '';

// Marker id -> CSS variable prefix (the order is irrelevant).
var TTY_MARKER_VARS = [
  { id: 'Keyboard', prefix: '--tty-kbd' },
  { id: 'Apron', prefix: '--tty-apron' },
  // The punch unit is split in two: the control area (REL/OFF/BSP/ON buttons)
  // and the punched tape (its axis and exit line) are separate drawings on the
  // real machine, so they carry separate markers.
  { id: 'PuncherControl', prefix: '--tty-pctrl' },
  { id: 'PuncherTape', prefix: '--tty-ptape' },
  // ... and the reader unit the same way: the switch plate and the loaded tape.
  { id: 'ReaderControl', prefix: '--tty-rctrl' },
  { id: 'ReaderTape', prefix: '--tty-rtape' },
  { id: 'Paper', prefix: '--tty-paper' },
  { id: 'Caret', prefix: '--tty-caret' }
];

// ---- Four-point markers (perspective areas) --------------------------------
// A marker may be drawn as a QUADRILATERAL instead of a rectangle: the artist
// fits four corners over the drawing (Inkscape's Pen tool with straight
// segments, or a polygon) and the page projects the matching HTML layer onto
// them with a matrix3d(). Rectangles keep the honest uniform/contain fit, so
// only markers that really are quads change behaviour.

// Pure: the four corners of a marker in SVG user units, or null when it is not
// a quadrilateral. Accepts <polygon>/<polyline points="..."> and a
// straight-line <path> (M/L/H/V plus Z); anything with curves or arcs returns
// null, which keeps the stylesheet fallback.
function ttyMarkerQuad(svgText, id) {
  // A <rect> that carries its OWN transform (Inkscape's rotate()/matrix(), as
  // when the artist tilts a marker over a tilted drawing) is a quadrilateral
  // too: its four transformed corners are returned. A plain rect stays null —
  // rectangles keep the honest uniform fit.
  var rect = new RegExp('<rect[^>]*id="' + id + '"[^>]*/?>').exec(svgText);
  if (rect) {
    var transform = /transform="([^"]+)"/.exec(rect[0]);
    if (!transform) return null; // a plain rectangle: the uniform fit stays
    var matrix = ttyMarkerTransform(transform[1]);
    if (!matrix) return null;
    var attrs = {};
    var reAttr = /([a-zA-Z:-]+)="([^"]*)"/g;
    var hit;
    while ((hit = reAttr.exec(rect[0])) !== null) attrs[hit[1]] = hit[2];
    var x = parseFloat(attrs.x), y = parseFloat(attrs.y);
    var w = parseFloat(attrs.width), h = parseFloat(attrs.height);
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null;
    var corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    var out = [];
    for (var c = 0; c < corners.length; c++) {
      out.push([
        matrix[0] * corners[c][0] + matrix[2] * corners[c][1] + matrix[4],
        matrix[1] * corners[c][0] + matrix[3] * corners[c][1] + matrix[5]
      ]);
    }
    return out;
  }

  var element = new RegExp('<(polygon|polyline|path)[^>]*id="' + id + '"[^>]*/?>')
    .exec(svgText);
  if (!element) return null;
  var tag = element[1];
  var text = element[0];
  var points = [];
  if (tag === "polygon" || tag === "polyline") {
    var attr = /points="([^"]+)"/.exec(text);
    if (!attr) return null;
    var pairs = attr[1].trim().split(/[\s,]+/);
    if (pairs.length !== 8) return null;
    for (var i = 0; i < 8; i += 2) {
      points.push([parseFloat(pairs[i]), parseFloat(pairs[i + 1])]);
    }
  } else {
    var d = /d="([^"]+)"/.exec(text);
    if (!d) return null;
    points = ttyStraightPathPoints(d[1]);
    if (!points) return null;
  }
  for (var j = 0; j < points.length; j++) {
    if (!isFinite(points[j][0]) || !isFinite(points[j][1])) return null;
  }
  return points.length === 4 ? points : null;
}

// Pure: compose an SVG transform list (matrix/translate/scale/rotate) into the
// [a b c d e f] matrix, or null for anything not supported (skewX/skewY, bad
// numbers) so the caller falls back to the uniform fit.
function ttyMarkerTransform(text) {
  var re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  var m = [1, 0, 0, 1, 0, 0];
  var part;
  var seen = false;
  while ((part = re.exec(String(text))) !== null) {
    seen = true;
    var name = part[1];
    var args = part[2].trim().split(/[\s,]+/).filter(function (v) { return v !== ""; })
      .map(parseFloat);
    var t = null;
    if (name === "matrix") {
      t = args.length === 6 ? args.slice() : null;
    } else if (name === "translate") {
      t = [1, 0, 0, 1, args[0] || 0, (args.length > 1) ? args[1] : 0];
    } else if (name === "scale") {
      var sy = (args.length > 1) ? args[1] : args[0];
      t = [args[0], 0, 0, sy, 0, 0];
    } else if (name === "rotate") {
      var rad = args[0] * Math.PI / 180;
      var cos = Math.cos(rad), sin = Math.sin(rad);
      if (args.length >= 3) {
        var cx = args[1], cy = args[2];
        t = [cos, sin, -sin, cos,
             cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
      } else {
        t = [cos, sin, -sin, cos, 0, 0];
      }
    }
    if (!t) return null;
    for (var i = 0; i < 6; i++) {
      if (!isFinite(t[i])) return null;
    }
    m = ttyMatrixMultiply(m, t);
  }
  return seen ? m : null;
}

// Pure: multiply two SVG matrices (m1 applied after m2, SVG nesting order).
function ttyMatrixMultiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

// Pure: the corner list of a straight-line SVG path, or null when the path
// contains curves/arcs or does not end up with exactly four points.
function ttyStraightPathPoints(d) {
  var tokens = String(d).match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!tokens) return null;
  var points = [];
  var cur = [0, 0];
  var cmd = null;
  var i = 0;
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
    var a, b;
    switch (cmd) {
      case "M":
      case "m":
        a = parseFloat(tokens[i++]);
        b = parseFloat(tokens[i++]);
        cur = (cmd === "m") ? [cur[0] + a, cur[1] + b] : [a, b];
        points.push(cur.slice());
        cmd = (cmd === "m") ? "l" : "L"; // implicit lineto follows a moveto
        break;
      case "L":
      case "l":
        a = parseFloat(tokens[i++]);
        b = parseFloat(tokens[i++]);
        cur = (cmd === "l") ? [cur[0] + a, cur[1] + b] : [a, b];
        points.push(cur.slice());
        break;
      case "H":
      case "h":
        a = parseFloat(tokens[i++]);
        cur = [(cmd === "h") ? cur[0] + a : a, cur[1]];
        points.push(cur.slice());
        break;
      case "V":
      case "v":
        b = parseFloat(tokens[i++]);
        cur = [cur[0], (cmd === "v") ? cur[1] + b : b];
        points.push(cur.slice());
        break;
      case "Z":
      case "z":
        i = tokens.length;
        break;
      default:
        return null; // curves, arcs, or a malformed path
    }
  }
  return points.length === 4 ? points : null;
}

// Pure: the CSS matrix3d() that projects a w x h box onto four points
// (each [x, y] in the element's LOCAL px space — quad[0] is where the element's
// own top-left corner lands). Returns null for a degenerate quad, so the caller
// keeps the uniform fit. Implemented as a homography solved from the four point
// correspondences; the CSS argument list is column-major.
function ttyQuadMatrix3d(w, h, quad) {
  if (!quad || quad.length !== 4 || !(w > 0) || !(h > 0)) return null;
  var src = [[0, 0], [w, 0], [w, h], [0, h]];
  var rows = [];
  var rhs = [];
  for (var i = 0; i < 4; i++) {
    var x = src[i][0], y = src[i][1];
    var u = quad[i][0], v = quad[i][1];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    rhs.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    rhs.push(v);
  }
  var m = ttySolveLinear(rows, rhs);
  if (!m) return null;
  var args = [m[0], m[3], 0, m[6],
              m[1], m[4], 0, m[7],
              0, 0, 1, 0,
              m[2], m[5], 0, 1];
  for (var j = 0; j < args.length; j++) {
    if (!isFinite(args[j])) return null;
  }
  return "matrix3d(" + args.join(", ") + ")";
}

// Pure: Gaussian elimination with partial pivoting for an n x n system.
// Returns null when the matrix is singular (a degenerate quad).
function ttySolveLinear(rows, rhs) {
  var n = rows.length;
  var a = [];
  for (var i = 0; i < n; i++) a.push(rows[i].slice().concat([rhs[i]]));
  for (var col = 0; col < n; col++) {
    var pivot = col;
    for (var r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    var tmp = a[col]; a[col] = a[pivot]; a[pivot] = tmp;
    for (var r2 = 0; r2 < n; r2++) {
      if (r2 === col) continue;
      var factor = a[r2][col] / a[col][col];
      if (factor === 0) continue;
      for (var c = col; c <= n; c++) a[r2][c] -= factor * a[col][c];
    }
  }
  var out = [];
  for (var k = 0; k < n; k++) out.push(a[k][n] / a[k][k]);
  return out;
}

// Every layer that may be projected into a quad marker: the native px box it
// occupies, the marker it belongs to and HOW its stylesheet fallback lays it
// out (the projection must replace that fallback exactly):
//   anchor "corner" — the layer sits at the marker's TOP-LEFT corner and its
//     w x h box is fitted onto the marker rect (the fallback is that fit), so
//     the projection maps the same box from the same corner;
//   anchor "centre" — the layer is CENTRED on the marker (the fallback carries
//     the centring), so the box is projected from the marker CENTRE;
//   anchor "sheet"  — the layer keeps its own dynamic scale (the printed
//     sheet's width follows the column count), so only the artist's transform
//     is published, pivoting on `pivot` in the layer's own px.
// Only a marker drawn as a QUAD publishes anything: a rectangle keeps the
// stylesheet's honest fit, so nothing changes until the artist tilts a marker.
var TTY_QUAD_MARKERS = [
  // The REL/OFF/BSP/ON cluster.
  { id: "PuncherControl", prefix: "--tty-pctrl", name: "--tty-pctrl-matrix",
    anchor: "corner", w: 106, h: 64 },
  // The vertical four-detent reader lever block (its native PORTRAIT 40x115 px
  // frame — the artist's ReaderControl marker is a vertical slot, so the quad
  // projection must map THIS rectangle onto the marker, not the former knob).
  { id: "ReaderControl", prefix: "--tty-rctrl", name: "--tty-rctrl-matrix",
    anchor: "corner", w: 40, h: 115 },
  // The key deck: anchored to the Keyboard marker's corner and stretched to its
  // width/height (576x212 — see model33KeyGrid).
  { id: "Keyboard", prefix: "--tty-kbd", name: "--tty-kbd-matrix",
    anchor: "corner", w: 576, h: 212 },
  // The CCU apron block (knob + three labels), centred on the Apron marker.
  { id: "Apron", prefix: "--tty-apron", name: "--tty-apron-matrix",
    anchor: "centre", w: 118, h: 66 },
  // The printed sheet: the printer block's own scale stays (the sheet width
  // follows the column count), and the artist's transform of the Paper marker
  // — or, when that rect is plain, of the Caret band — is applied on top, so
  // the sheet tilts with the platen it lies in. 404/316 is the printer's print
  // point (sheet centre, print line) in the block's own px.
  { id: "Paper", prefix: "--tty-paper", name: "--tty-paper-matrix",
    anchor: "sheet", altId: "Caret", pivot: [404, 316] }
];

// Pure: the column-major matrix3d() of a 2D affine matrix [a b c d e f] in the
// SVG convention (x' = a*x + c*y + e, y' = b*x + d*y + f).
function ttyAffineMatrix3d(a, b, c, d, e, f) {
  var args = [a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1];
  for (var i = 0; i < args.length; i++) {
    if (!isFinite(args[i])) return null;
  }
  return "matrix3d(" + args.join(", ") + ")";
}

// Pure: the transform attribute of a marker <rect> ("" when it carries none).
function ttyMarkerRectTransform(svgText, id) {
  var element = new RegExp('<rect[^>]*id="' + id + '"[^>]*/>').exec(svgText);
  if (!element) return "";
  var transform = /transform="([^"]+)"/.exec(element[0]);
  return transform ? transform[1] : "";
}

// Pure: the matrix3d() the layer of a quad marker must consume, or null when
// the marker is not a quad (a rectangle keeps the stylesheet fit), its numbers
// are missing, the projection is degenerate or the layer's mode cannot express
// the artist's transform.
//   entry — one TTY_QUAD_MARKERS row
//   quad  — the four marker corners, SVG units (ttyMarkerQuad)
//   vars  — the marker numbers, SVG units (ttyMarkerVars output)
//   opts  — { unit, sheetK, artTransform }
function ttyQuadLayerMatrix(entry, quad, vars, opts) {
  if (!entry || !quad || quad.length !== 4 || !opts) return null;
  var unit = opts.unit;
  if (!isFinite(unit) || unit <= 0) return null;
  function marker(name) {
    var value = parseFloat(vars ? vars[name] : NaN);
    return isFinite(value) ? value : null;
  }
  if (entry.anchor === "sheet") {
    // The printer block keeps its own scale, so only the artist's transform is
    // published — expressed in the block's own px and pivoting on the print
    // point. For an affine transform L/t the map is
    //   M(p) = L*(p - pivot) + pivot + (L*C + t - C) / k
    // where C is the print point in rig px and k the factor the stylesheet
    // scales the block by (the block's px are k times smaller than the rig's,
    // so a translation shrinks by k).
    var affine = ttyMarkerTransform(opts.artTransform || "");
    var sheetK = opts.sheetK;
    if (!affine || !entry.pivot) return null;
    if (!isFinite(sheetK) || sheetK <= 0) return null;
    var cx = marker("--tty-paper-x");
    var cw = marker("--tty-paper-w");
    var lineY = marker("--tty-caret-line-y");
    if (cx === null || cw === null || lineY === null) return null;
    var line = [(cx + cw / 2) * unit, lineY * unit];
    var pivot = entry.pivot;
    var movedX = affine[0] * line[0] + affine[2] * line[1] + affine[4] - line[0];
    var movedY = affine[1] * line[0] + affine[3] * line[1] + affine[5] - line[1];
    var tx = pivot[0] - (affine[0] * pivot[0] + affine[2] * pivot[1]) + movedX / sheetK;
    var ty = pivot[1] - (affine[1] * pivot[0] + affine[3] * pivot[1]) + movedY / sheetK;
    return ttyAffineMatrix3d(affine[0], affine[1], affine[2], affine[3], tx, ty);
  }

  // The anchor is the point the stylesheet positions the layer BY: the marker's
  // top-left corner (corner fit) or its centre (centred block).
  var w = marker(entry.prefix + "-w");
  var h = marker(entry.prefix + "-h");
  var x = marker(entry.prefix + "-x");
  var y = marker(entry.prefix + "-y");
  if (w === null || h === null || x === null || y === null) return null;
  var centred = (entry.anchor === "centre");
  var anchorX = (centred ? x + w / 2 : x) * unit;
  var anchorY = (centred ? y + h / 2 : y) * unit;
  var target = [];
  for (var i = 0; i < 4; i++) {
    target.push([quad[i][0] * unit - anchorX, quad[i][1] * unit - anchorY]);
  }
  return ttyQuadMatrix3d(entry.w, entry.h, target);
}

// The factor the stylesheet scales the printer block by (--tty-sheet-k, see
// css/g60printer.css): the Paper marker divided by the sheet the printer really
// laid out. 741 is the fetch-less stylesheet fallback.
function ttySheetFactor(vars, unit) {
  var rig = document.getElementById('teletype-rig');
  var native = rig ? parseFloat(rig.style.getPropertyValue('--tty-sheet-native')) : NaN;
  if (!isFinite(native) || native <= 0) native = 741;
  var w = parseFloat(vars ? vars['--tty-paper-w'] : NaN);
  if (!isFinite(w) || !isFinite(unit) || unit <= 0) return NaN;
  return unit * w / native;
}

// Compute the projection of every quad marker and publish it on the rig; the
// stylesheet falls back to its own fit when the variable is absent, so a
// rectangular marker changes nothing.
function applyTtyQuadMatrices(rig, svgText) {
  var vars = ttyMarkerVars(svgText) || {};
  var unit = parseFloat(window.getComputedStyle(rig).getPropertyValue("--tty-u-num"));
  if (!isFinite(unit) || unit <= 0) return;
  var sheetK = ttySheetFactor(vars, unit);
  for (var i = 0; i < TTY_QUAD_MARKERS.length; i++) {
    var marker = TTY_QUAD_MARKERS[i];
    var quad = ttyMarkerQuad(svgText, marker.id);
    var source = marker.id;
    if (!quad && marker.altId) {
      // The printed sheet may be tilted through either of its two markers.
      quad = ttyMarkerQuad(svgText, marker.altId);
      source = marker.altId;
    }
    var matrix = quad
      ? ttyQuadLayerMatrix(marker, quad, vars, {
          unit: unit,
          sheetK: sheetK,
          artTransform: ttyMarkerRectTransform(svgText, source)
        })
      : null;
    if (matrix) rig.style.setProperty(marker.name, matrix);
    else rig.style.removeProperty(marker.name);
  }
}

// Pure: SVG text -> { '--tty-kbd-x': '127.64988', ... } (x/y/w/h per marker
// plus the viewBox and the derived print line). Missing markers are skipped, so
// a partial result keeps the stylesheet fallback for whatever is absent.
function ttyMarkerVars(svgText) {
  if (!svgText) return null;
  var out = {};
  var viewBox = /viewBox="0 0 ([-0-9.eE]+) ([-0-9.eE]+)"/.exec(svgText);
  if (viewBox) {
    out['--tty-vb-w'] = viewBox[1];
    out['--tty-vb-h'] = viewBox[2];
  }
  for (var i = 0; i < TTY_MARKER_VARS.length; i++) {
    var marker = TTY_MARKER_VARS[i];
    var element = new RegExp('<rect[^>]*id="' + marker.id + '"[^>]*/>').exec(svgText);
    if (!element) continue;
    var rect = element[0];
    var value = function (attr) {
      var m = new RegExp(attr + '="([-0-9.eE]+)"').exec(rect);
      return m ? m[1] : null;
    };
    var x = value('x'), y = value('y'), w = value('width'), h = value('height');
    if (x === null || y === null || w === null || h === null) continue;
    out[marker.prefix + '-x'] = x;
    out[marker.prefix + '-y'] = y;
    out[marker.prefix + '-w'] = w;
    out[marker.prefix + '-h'] = h;
  }
  // The print line is the Caret band's BOTTOM edge (y + h).
  if (out['--tty-caret-y'] && out['--tty-caret-h']) {
    out['--tty-caret-line-y'] = String(parseFloat(out['--tty-caret-y']) +
      parseFloat(out['--tty-caret-h']));
  }
  return out;
}

// Pure: the id of the artwork layer addressed by its Inkscape LABEL (the id
// itself may be renamed by the editor at any save) — "" when there is none.
// The top layer is "Foreground"; the middle one is "Middle" (a layer painted
// BETWEEN the two hanging tapes: the tongues the tapes slip under / come out
// over). Matched by label first, then by an id that mentions it.
function ttyArtLayerId(svgText, wanted) {
  var want = String(wanted || "").toLowerCase();
  if (!want) return "";
  var tags = String(svgText || "").match(/<g\b[^>]*>/g) || [];
  var i, label, id;
  for (i = 0; i < tags.length; i++) {
    label = /inkscape:label="([^"]*)"/.exec(tags[i]);
    if (label && label[1].trim().toLowerCase() === want) {
      id = /id="([^"]*)"/.exec(tags[i]);
      if (id && id[1]) return id[1];
    }
  }
  for (i = 0; i < tags.length; i++) {
    id = /id="([^"]*)"/.exec(tags[i]);
    if (!id || !id[1]) continue;
    if (id[1].toLowerCase().indexOf(want) === -1) continue;
    return id[1];
  }
  return "";
}

// The artwork's top layer: the one painted ABOVE every live control.
function ttyForegroundLayerId(svgText) {
  return ttyArtLayerId(svgText, "Foreground");
}

// The front-most layers the page inlines out of the artwork (the stylesheet
// owns the stacking order, see css/g60printer.css):
//   Middle     — BETWEEN the two hanging tapes: the tongues drawn there — the
//                reader tongue the reader tape slips UNDER, and the punch
//                tongue the punched tape comes out OVER;
//   Foreground — above everything.
// Either layer may be absent: its host is then simply left empty.
var TTY_ART_LAYERS = [
  { host: 'tty-foreground-back', label: 'Middle' },
  { host: 'tty-foreground', label: 'Foreground' }
];

// The machine itself is the #tty-backdrop background image, i.e. BEHIND every
// control, so a layer that must cover the keys or the hanging tapes cannot be
// part of it. The page therefore inlines the SAME artwork — fetched once —
// stripped down to those layers (plus <defs>, where the artwork's gradients
// live) into their host elements, which the stylesheet stacks over the
// controls. The rest of the drawing is not copied: the backdrop already
// paints it.
function installTtyLayer(svgText, hostId, id) {
  var node = document.getElementById(hostId);
  if (!node || typeof DOMParser === 'undefined') return;
  node.textContent = '';
  if (!id) return; // no such layer: nothing has to paint there
  var parsed = new DOMParser().parseFromString(String(svgText), 'image/svg+xml');
  var root = parsed && parsed.documentElement;
  if (!root || root.localName !== 'svg') return; // malformed artwork
  var viewBox = root.getAttribute('viewBox');
  if (!viewBox) return;
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  // The backdrop stretches the artwork to the rig box (background-size: 100%
  // 100%), so these copies have to stretch exactly the same way to line up. The
  // size lives on the element itself: a stylesheet rule for the inlined <svg>
  // would only add a second place to keep in step.
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('style', 'display:block');
  var layer = null;
  for (var i = 0; i < root.children.length; i++) {
    var child = root.children[i];
    if (child.localName === 'defs') {
      svg.appendChild(document.importNode(child, true));
    } else if (child.getAttribute('id') === id) {
      layer = child;
    }
  }
  if (!layer) return;
  svg.appendChild(document.importNode(layer, true));
  node.appendChild(svg);
}

// Inline every front-most artwork layer into its host (see TTY_ART_LAYERS).
function installTtyForeground(svgText) {
  for (var i = 0; i < TTY_ART_LAYERS.length; i++) {
    installTtyLayer(svgText,
      TTY_ART_LAYERS[i].host,
      ttyArtLayerId(svgText, TTY_ART_LAYERS[i].label));
  }
}

// Fetch the artwork, apply the markers and re-derive everything that depends on
// them (the rig scale, the paper ceiling and the two hanging tapes).
function installTtyArtLayer() {
  var rig = document.getElementById('teletype-rig');
  if (!rig || typeof fetch !== 'function') return;
  fetch(TTY_ART_URL)
    .then(function (res) { return res && res.ok ? res.text() : null; })
    .then(function (text) {
      var vars = ttyMarkerVars(text);
      if (!vars) return;
      ttyArtText = text; // kept for later re-projections (sheet factor)
      for (var name in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, name)) {
          rig.style.setProperty(name, vars[name]);
        }
      }
      window.__ttyMarkerVars = vars; // inspectable from the console/tests
      // Four-point markers (perspective areas) switch their layer to matrix3d.
      applyTtyQuadMatrices(rig, text);
      // The artwork's Foreground layer goes ABOVE the controls (keys, tapes).
      installTtyForeground(text);
      // The sheet scale follows the marker AND the real sheet width.
      ttySyncSheetWidth();
      if (typeof window.__ttyRescale === 'function') window.__ttyRescale();
      else teletypePaperGrowthApply();
      if (window.paperTape && typeof window.paperTape.refreshHeight === 'function') {
        window.paperTape.refreshHeight();
      }
      if (window.tapeReader && typeof window.tapeReader.refreshHeight === 'function') {
        window.tapeReader.refreshHeight();
      }
    })
    .catch(function () { /* keep the stylesheet fallbacks */ });
}

// Publish the width of the sheet the printer actually laid out (it depends on
// the configured column count: computePaperGeometry centres the roll inside the
// 808px body). css/g60printer.css divides the artwork's Paper marker by it, so
// the printed sheet always fills the platen the SVG draws — without this the
// stylesheet could only assume the CSS base width (741px), which is wider than
// the real sheet and made the paper look too narrow with room to spare (and the
// text smaller than it should be).
function ttySyncSheetWidth() {
  var rig = document.getElementById('teletype-rig');
  var paper = document.getElementById('paper');
  if (!rig || !paper) return;
  // offsetWidth is 0 while the CONSOLE page is hidden (display:none), so this is
  // re-run whenever the page becomes visible (installTeletypeScaling.apply).
  var native = paper.offsetWidth; // layout px — transforms excluded
  if (native > 0) {
    // MUST live on the rig: --tty-sheet-k is computed there and inherited by the
    // printer block, so setting it on the block itself would have no effect.
    rig.style.setProperty('--tty-sheet-native', String(native));
    // The sheet's projection divides by that factor, so re-derive it now that
    // the real width is known (the first pass runs before the page is visible).
    if (ttyArtText) applyTtyQuadMatrices(rig, ttyArtText);
  }
}

// Size the console paper's growth ceiling from the carriage's live distance to
// the top of the window (CSS variable --tty-paper-max, consumed by
// css/g60printer.css). Split out of installTeletypePaperGrowth() so it can also
// be re-run when the artwork markers move the sheet (installTtyArtLayer).
function teletypePaperGrowthApply() {
  var container = document.getElementById('g60printer');
  var paper = document.getElementById('paper');
  if (!container || !paper) return;
  var bottom = paper.getBoundingClientRect().bottom;
  if (bottom <= 0) return; // hidden page — skip until visible
  // The paper lives in a scaled space: the rig is scaled as a whole and the
  // printer block is scaled again onto the artwork's Paper marker, so the
  // local max-height must be divided by the measured product (ttyScaleFor)
  // for the sheet's VISUAL top to still reach the window top.
  var scale = ttyScaleFor(container.getBoundingClientRect().width,
                          container.offsetWidth);
  container.style.setProperty('--tty-paper-max',
      (teletypePaperMaxHeight(bottom, 0) / scale) + 'px');
}

// Keep the ceiling fresh while the page is on screen: the observer fires when
// the page's layout size changes (show/hide of the page, window resize).
function installTeletypePaperGrowth() {
  if (typeof ResizeObserver === 'undefined') return;
  var page = document.getElementById('page-teletype');
  var container = document.getElementById('g60printer');
  var paper = document.getElementById('paper');
  if (!page || !container || !paper) return;

  function apply() {
    teletypePaperGrowthApply();
  }

  apply();
  var ro = new ResizeObserver(apply);
  ro.observe(page);
}

// ---- Proportional scaling of the Model 33 ASR teletype rig ----
// Mirrors installLP11Scaling / installPanelScaling: the teletype machine
// (#teletype-rig: printer + keyboard + ASR tape unit) has a fixed native size
// and was never scaled down, so on narrow/short windows it clipped under the
// page's overflow:hidden (and the pinned operator buttons overlapped it).
// When the page cannot fit the rig, scale the whole #teletype-rig (paper and
// hanging tape included — they are children of it) via transform: scale and
// expose the factor as --tty-scale so the paper and the punchtape can divide
// their viewport-driven max-heights and still reach the top/bottom of the
// window. The vertical fit is measured live: the rig's layout centre is
// flex-centred in the page (a top <p class=clear> spacer shifts it), so the
// scale keeps the visual inside the window top AND above the operator
// buttons, whatever the spacer/centring geometry happens to be.
function teletypeFitScale(availW, availH, natW, natH) {
  if (!natW || !natH) return 1;
  var s = Math.min(1, (availW > 0) ? availW / natW : 1);
  if (availH > 0 && natH > availH) {
    s = Math.min(s, availH / natH);
  }
  if (s < 0.1) s = 0.1; // never collapse below readability
  return s;
}

function installTeletypeScaling() {
  if (typeof ResizeObserver === 'undefined') return;
  var page = document.getElementById('page-teletype');
  if (!page) return;
  var rig = document.getElementById('teletype-rig');
  var container = document.getElementById('g60printer');
  var paper = document.getElementById('paper');
  if (!rig || !container || !paper) return;

  function apply() {
    // Clear the transform before measuring so offsetWidth returns the natural
    // (unscaled) size; hidden pages (display:none -> offsetWidth 0) are
    // skipped and re-sized once they become visible.
    rig.style.transform = '';
    var natW = rig.offsetWidth;
    var natH = rig.offsetHeight;
    if (!natW || !natH) return; // hidden page - skip until visible
    // The page is visible now, so the sheet can finally be measured: publish its
    // width, which the stylesheet divides the Paper marker by (see
    // ttySyncSheetWidth — it is a no-op while the page is hidden).
    ttySyncSheetWidth();

    // Measure the live vertical room around the rig's layout centre (the
    // page flex-centres the rig, but the top <p class=clear> spacer shifts
    // it up on short windows). The visual must stay inside the window top
    // (spaceTop) and above the pinned operator buttons (spaceBottom), so the
    // available height is 2 * min(spaceTop, spaceBottom). The width side is
    // symmetric, hence the plain 24px page margin.
    var controls = document.getElementById('teletype-controls');
    var controlsTop = controls
        ? controls.getBoundingClientRect().top
        : page.clientHeight;
    var rigTop = rig.getBoundingClientRect().top;
    var rigCenter = rigTop + natH / 2;
    // Keep a 24px breathing gap above the rig and above the operator buttons,
    // so the shrunk machine never touches the window top or the button row.
    var GAP = 24;
    var spaceTop = rigCenter - GAP;
    var spaceBottom = (controlsTop - GAP) - rigCenter;
    var availH = 2 * Math.min(spaceTop, spaceBottom);
    if (availH < 0) availH = 0;
    var s = teletypeFitScale(page.clientWidth - 24, availH, natW, natH);

    rig.style.setProperty('--tty-scale', s);
    rig.style.transformOrigin = 'center center';
    rig.style.transform = (s < 1) ? 'scale(' + s + ')' : '';

    // Re-derive the paper's growth ceiling for the new scale (the local
    // max-height must be divided by the FULL scale — rig transform times the
    // printer's own contain scale — so the sheet's visual top stays at y=0;
    // ttyScaleFor measures that product on the rendered block).
    var bottom = paper.getBoundingClientRect().bottom;
    if (bottom > 0) {
      var blockScale = ttyScaleFor(container.getBoundingClientRect().width,
                                   container.offsetWidth);
      container.style.setProperty('--tty-paper-max',
          (teletypePaperMaxHeight(bottom, 0) / blockScale) + 'px');
    }
    // The hanging punchtape is measured in the same scaled space; refresh it
    // so it still reaches the bottom of the window after the scale changes.
    if (window.paperTape && typeof window.paperTape.refreshHeight === 'function') {
      window.paperTape.refreshHeight();
    }
  }

  apply();
  var ro = new ResizeObserver(apply);
  ro.observe(page);
  // Exposed so installTtyArtLayer() can re-run the fit right after the artwork
  // markers have been applied (the rig size follows the marker numbers).
  window.__ttyRescale = apply;
}

// ---- Global sound mute button (bottom-left, magic-wand style) ----
// Toggles the CONFIG "mute" flag like a checkbox: syncs aria-pressed and the
// .muted CSS class from the persisted config, persists on every click and
// nudges Hum.update() so the ambient hum silences/restores instantly.
function initMuteButton() {
  var btn = document.getElementById('mute-btn');
  if (!btn) return;

  function sync() {
    var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
    var muted = !!(cfg && cfg.mute);
    btn.classList.toggle('muted', muted);
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }

  sync();
  btn.addEventListener('click', function () {
    if (typeof Config === 'undefined') return;
    Config.set({ mute: !Config.get().mute });
    sync();
    // The hum follows the config on its next tick anyway; updating now makes
    // the toggle feel instant.
    if (window.Hum && typeof window.Hum.update === 'function') window.Hum.update();
  });
}

// Play the paper-tear sound (same asset as the LP11 Tear paper button on the
// PRINTER page). The Audio element is created lazily on the first tear (inside
// the click handler, so autoplay is not blocked) and replayed from 0 each time.
var tearAudio = null;
function playTearSound() {
  try {
    if (typeof Config !== 'undefined' && Config.get().mute) return;
    if (!tearAudio && typeof Audio !== 'undefined') {
      tearAudio = new Audio('assets/sounds/paper-rip-sound-effect.mp3');
      tearAudio.preload = 'auto';
    }
    if (tearAudio) {
      tearAudio.currentTime = 0;
      tearAudio.play().catch(function () {});
    }
  } catch (e) { /* ignore audio errors */ }
}

// Play the computer-button press sound (pressing-a-computer-button.mp3): used
// for the POWER LOCK key on the front panel and for every teletype keyboard
// key. The Audio element is created lazily on the first press (inside the
// click handler, so autoplay is not blocked) and replayed from 0 each time.
var computerButtonAudio = null;
function playComputerButton() {
  try {
    if (typeof Config !== 'undefined' && Config.get().mute) return;
    if (!computerButtonAudio && typeof Audio !== 'undefined') {
      computerButtonAudio = new Audio('assets/sounds/pressing-a-computer-button.mp3');
      computerButtonAudio.preload = 'auto';
    }
    if (computerButtonAudio) {
      computerButtonAudio.currentTime = 0;
      computerButtonAudio.play().catch(function () {});
    }
  } catch (e) { /* ignore audio errors */ }
}

// Play the ASR punch-button press sound (pressing a ballpoint pen on the
// table — the crisp click the operator hears when pressing ON/OFF/BSP/REL).
// Lazy Audio element, same pattern as playComputerButton above.
var punchButtonAudio = null;
function playButtonPress() {
  try {
    if (typeof Config !== 'undefined' && Config.get().mute) return;
    if (!punchButtonAudio && typeof Audio !== 'undefined') {
      punchButtonAudio = new Audio('assets/sounds/pressing-a-button-on-a-ballpoint-pen-on-the-table.mp3');
      punchButtonAudio.preload = 'auto';
    }
    if (punchButtonAudio) {
      punchButtonAudio.currentTime = 0;
      punchButtonAudio.play().catch(function () {});
    }
  } catch (e) { /* ignore audio errors */ }
}

// ---- Model 33 ASR operator controls (CCU LINE/OFF/LOCAL, Tear, Save) ----
// Wires the #teletype-controls buttons and the CCU rotary switch. The CCU
// knob (LINE/OFF/LOCAL) selects the unit's mode: LINE is the normal connected
// mode, OFF powers the unit fully down (teletype, punch and reader), LOCAL
// disconnects it from the machine (keyboard types are printed locally, machine
// output is ignored). Tear tape rewinds the punched tape, Tear paper clears
// the printed paper, Save tape downloads the punched bytes as a .ptap file.
function initTtyControls() {
  // CCU rotary line switch (LINE / OFF / LOCAL) on the apron right of the
  // keyboard; each position label is a hit target that rotates the knob.
  var ccuPos = document.querySelectorAll('.ccu-switch-pos');
  for (var ci = 0; ci < ccuPos.length; ci++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        // Only the actual act of switching produces the mechanical click.
        if (window.ttyMode !== btn.getAttribute('data-tty-mode')) playSwitchClick();
        setTtyMode(btn.getAttribute('data-tty-mode'));
      });
    })(ccuPos[ci]);
  }
  // Clicking the KNOB itself (not a label) turns it to the next detent,
  // like rotating the real knob clockwise: LINE -> OFF -> LOCAL -> LINE.
  var ccuKnob = document.getElementById('ccu-switch-disc');
  if (ccuKnob) {
    ccuKnob.addEventListener('click', function () {
      playSwitchClick();
      setTtyMode(ttyModes[(ttyModes.indexOf(window.ttyMode) + 1) % ttyModes.length]);
    });
  }

  var tearTapeBtn = document.getElementById('tty-tear-tape');
  if (tearTapeBtn) {
    tearTapeBtn.addEventListener('click', function () {
      // Play the rip sound only if there was actually punched tape to tear off.
      if (window.paperTape && typeof window.paperTape.clear === 'function') {
        if (window.paperTape.clear()) playTearSound();
      }
    });
  }

  var tearPaperBtn = document.getElementById('tty-tear-paper');
  if (tearPaperBtn) {
    tearPaperBtn.addEventListener('click', function () {
      // Play the rip sound only if printed paper was actually torn off.
      if (g60printer && typeof g60printer.clear === 'function') {
        if (g60printer.clear()) playTearSound();
      }
    });
  }

  var saveTapeBtn = document.getElementById('tty-save-tape');
  if (saveTapeBtn) {
    saveTapeBtn.addEventListener('click', function () {
      if (window.paperTape && typeof window.paperTape.save === 'function') {
        window.paperTape.save();
      }
    });
  }

  // Load tape: opens a file dialog (.ptap / .ptap.zst / .txt) and inserts
  // the tape into the reader (src/reader.js). Loading replaces any tape
  // already in the reader.
  var loadTapeBtn = document.getElementById('tty-load-tape');
  var tapeFileInput = document.getElementById('tty-tape-file');
  if (loadTapeBtn && tapeFileInput) {
    loadTapeBtn.addEventListener('click', function () {
      tapeFileInput.click();
    });
    tapeFileInput.addEventListener('change', function () {
      var file = tapeFileInput.files && tapeFileInput.files[0];
      if (!file) return;
      var fr = new FileReader();
      fr.onload = function () {
        if (window.tapeReader && typeof window.tapeReader.bytesFromFile === 'function') {
          var bytes = window.tapeReader.bytesFromFile(fr.result, file.name);
          if (bytes) {
            window.tapeReader.loadBytes(bytes);
            // Loading is a deliberate pause: force the reader to STOP so
            // the switch position, the motor state and the Remove button
            // all agree — leaving the switch on START/AUTO with a stopped
            // motor would be a mental mismatch.
            setReaderMode('stop');
            playSwitchClick();
          }
        }
      };
      fr.readAsArrayBuffer(file);
      // Allow re-selecting the same file after a failed or repeated load.
      tapeFileInput.value = '';
    });
  }

  // Remove tape from reader: the FREE-mode operator action — pull the tape
  // out of the reader by hand.
  var removeTapeBtn = document.getElementById('tty-remove-tape');
  if (removeTapeBtn) {
    removeTapeBtn.addEventListener('click', function () {
      // Pulling the tape out of the READER is a quiet action — no rip
      // sound (unlike tearing the punched tape).
      if (window.tapeReader && typeof window.tapeReader.removeTape === 'function') {
        window.tapeReader.removeTape();
      }
    });
  }

  // Punch operator buttons (ON/OFF/BSP/REL).
  var punchOnBtn = document.getElementById('punch-on');
  var punchOffBtn = document.getElementById('punch-off');
  var punchBspBtn = document.getElementById('punch-bsp');
  var punchRelBtn = document.getElementById('punch-rel');
  if (punchOnBtn) {
    punchOnBtn.addEventListener('click', function () {
      playButtonPress();
      setTtyPunch(true);
    });
  }
  if (punchOffBtn) {
    punchOffBtn.addEventListener('click', function () {
      playButtonPress();
      setRelHeld(false);
      // The OFF button finishes the tape: punch the automatic NUL trailer
      // before the punch stops (same as machine DC4).
      punchTapeTrailer();
      setTtyPunch(false);
    });
  }
  if (punchBspBtn) {
    punchBspBtn.addEventListener('click', function () {
      playButtonPress();
      // BSP moves the tape back one step only — it punches nothing. The
      // next byte (e.g. the DELETE / RUB OUT key) overpunches the row the
      // punch head now sits over, exactly like a real ASR-33.
      if (window.paperTape && typeof window.paperTape.backspace === 'function') {
        window.paperTape.backspace();
      }
    });
  }
  // REL is a latching button: it releases the tape for manual pull-out, which
  // keeps the punch mechanically disengaged (functionally like OFF). Clicking
  // again (or pressing ON) unlatches it.
  if (punchRelBtn) {
    punchRelBtn.addEventListener('click', function () {
      playButtonPress();
      setRelHeld(!ttyRelHeld);
      if (ttyRelHeld) setTtyPunch(false);
    });
  }

  // Vertical four-detent tape reader lever (START/AUTO/STOP/FREE, top to
  // bottom). Each label is a hit target that moves the lever straight to that
  // detent, exactly as clicking a CCU label turns the knob.
  var switchPos = document.querySelectorAll('.asr-switch-pos');
  for (var si = 0; si < switchPos.length; si++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        // Only the actual act of switching produces the mechanical click.
        if (window.ttyReaderMode !== btn.getAttribute('data-reader-mode')) playSwitchClick();
        setReaderMode(btn.getAttribute('data-reader-mode'));
      });
    })(switchPos[si]);
  }
  // The lever itself: DRAG the handle up/down the slot to pick a detent (it
  // follows the pointer and the mode latches on release, like pushing the real
  // lever to the next notch), or CLICK it to step one detent DOWN:
  // START -> AUTO -> STOP -> FREE -> START. Clicking the slot moves the lever
  // straight to the detent under the pointer.
  var rail = document.getElementById('asr-reader-switch');
  var handle = document.getElementById('reader-switch-lever');
  var slot = rail ? rail.querySelector('.asr-switch-slot') : null;
  if (rail && handle && slot) {
    var detents = readerModes.length;
    var dragging = false;
    var moved = false;
    // Nearest detent (0..detents-1, from the top) to a viewport Y. Only the
    // RELATIVE position inside the slot matters, so this stays correct under
    // the rig's scale transform and a tilted ReaderControl marker.
    var detentAt = function (clientY) {
      var box = slot.getBoundingClientRect();
      if (!box.height) return 0;
      var idx = Math.round(((clientY - box.top) / box.height) * (detents - 1));
      return Math.max(0, Math.min(detents - 1, idx));
    };
    var applyMode = function (idx) {
      var mode = readerModes[idx];
      if (window.ttyReaderMode !== mode) playSwitchClick();
      setReaderMode(mode);
    };
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      dragging = true;
      moved = false;
      handle.classList.add('dragging');
      if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      moved = true;
      // Preview the detent under the pointer; the mode latches on release.
      rail.style.setProperty('--reader-lever-i', String(detentAt(e.clientY)));
    });
    var releaseLever = function (e) {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      applyMode(moved
        ? detentAt(e.clientY)
        : (readerModes.indexOf(window.ttyReaderMode) + 1) % detents);
    };
    handle.addEventListener('pointerup', releaseLever);
    handle.addEventListener('pointercancel', releaseLever);
    slot.addEventListener('click', function (e) {
      if (e.target === handle) return; // the handle's own click steps instead
      applyMode(detentAt(e.clientY));
    });
  }

  // LINE is the default mode; the punch is OFF; the reader switch starts in
  // STOP (reading is not active until the operator or the machine engages it).
  setTtyMode('line');
  setTtyPunch(false);
  setReaderMode('stop');
}

// ---- Bootstrap ----
var __appCfg = (typeof Config !== 'undefined') ? Config.get() : null;

initG60Printer();
ttySyncSheetWidth();
g60Keyboard.init();
// Keycap layout (CONFIG -> Keyboard keycaps): 'drawn' (default) lets the
// artwork draw the caps, 'grid' draws them in CSS.
g60Keyboard.setLayout((__appCfg && __appCfg.keyboardLayout) || 'drawn');
// Prepare the ASR paper tape (finds #punchtape and creates the tape body).
if (window.paperTape && typeof window.paperTape.init === 'function') {
  window.paperTape.init();
}
// Wire the LOCAL/LINE, Tear tape/paper and Save tape operator controls.
initTtyControls();

// Console terminal: teletype (already initialized above) or VT52 on tty0.
if (__appCfg && __appCfg.consoleType === 'vt52') {
  initVT52Page(0, 'page-vt52-console', 'vt52-console-screen', 'console_vt52_textarea');
}
// User terminals: one page per configured terminal (TT1 / TT2).
if (__appCfg && __appCfg.userTerminals >= 1) {
  initVT52Page(1, 'page-vt52', 'vt52-screen', 'tty1_textarea');
}
if (__appCfg && __appCfg.userTerminals >= 2) {
  initVT52Page(2, 'page-vt52-2', 'vt52-2-screen', 'tty2_textarea');
}

// Fit the VT52 cabinets to the available window size (proportional scaling).
installVT52Scaling();

// Fit the LP11 printer cabinet to the available window size (proportional
// scaling, mirroring the VT52 cabinets above).
installLP11Scaling();

// Fit the front panel (and its Help Me! sticker) to the available window size
// (proportional scaling, mirroring the VT52/LP11 cabinets above).
installPanelScaling();

// Make the Model 33 ASR console paper grow up to the top of the window
// (viewport-driven max-height), like the LP11 printer page.
installTeletypePaperGrowth();

// Fit the Model 33 ASR teletype rig to the available window size
// (proportional scaling, mirroring the VT52/LP11/panel scalers above).
installTeletypeScaling();

// Read the artwork's marker rects and push them into the rig variables: the SVG
// is the single source of truth for the overlay geometry (the numbers in
// css/g60printer.css are only the fallback for fetch-less builds).
installTtyArtLayer();

// Apply the configured VT52 reverse-video mode to the live terminals.
applyVT52ReverseVideo(__appCfg && __appCfg.vt52ReverseVideo);

// Apply the configured VT52 text mode to the live terminals (idempotent with
// the mode chosen inside initVT52Page, but also covers late-created ones).
applyVT52TextMode(__appCfg && __appCfg.vt52TextMode);

// Apply the configured CRT-effects mode (pure-CSS flicker/roll simulation).
applyCRTEffects(__appCfg && __appCfg.crtEffects);

// Apply the configured Help Me! sticker visibility (CONFIG -> Behaviour).
applyPanelSticker(__appCfg && __appCfg.panelSticker);

applyVisibility();
initConfigForm();
initMuteButton();
initConfigTabs();

// Power the machine per the CONFIG option (default: off). Reset the front
// panel to OFF first so applyMachinePower sees a genuine power-on transition;
// with the auto-boot option set, powering on starts the default bootstrap —
// otherwise the operator presses Bootstrap now! on the Panel page or types a
// boot command on the console.
if (typeof panel !== 'undefined') panel.powerSwitch = -1;
applyMachinePower(__appCfg && __appCfg.powerOn, false);

// Keep the Panel nav status indicators (power lamp + run-state icon) in sync
// with the CPU run state even for transitions that originate inside the CPU
// core (HALT instruction, WAIT, RESET) — see src/panel-led.js.
if (window.PanelLed) window.PanelLed.start();

// First-run onboarding hint (no-op after the user has dismissed it once)
Onboarding.init();

// Annotate the Info page's guest-OS table with the build manifest: rows
// whose image is not shipped in this deployment are dimmed and marked, so
// the documentation matches what can actually boot (manifest generated by
// tools/gen-media-manifest.js). Availability = manifest ∪ DataLoader-mounted
// images (desktop bundle, drag-and-drop imports); when there is no manifest
// and nothing is mounted the table is left untouched — the deployment may
// still serve every image.
(function annotateGuestOsTable() {
    if (typeof QuickBoot === "undefined" ||
        typeof QuickBoot.manifest !== "function") return;
    var mounted = (typeof DataLoader !== "undefined" &&
                   typeof DataLoader.list === "function")
        ? DataLoader.list() : [];
    QuickBoot.manifest().then(function (manifest) {
        if (!manifest && (!mounted || mounted.length === 0)) return;
        var table = document.getElementById("guest-os-table");
        if (!table) return;
        var have = {};
        (manifest || []).forEach(function (u) { have[u] = true; });
        mounted.forEach(function (u) { have[u] = true; });
        table.querySelectorAll("tbody tr").forEach(function (tr) {
            var diskCell = tr.querySelector("td.disk");
            var sysCell = tr.querySelector("td.system");
            if (!diskCell || !sysCell) return;
            var dev = diskCell.textContent.trim().toLowerCase();
            var url = dev.indexOf("tm") === 0 ? dev + ".tap" : dev + ".dsk";
            if (have[url]) return;
            tr.classList.add("guest-os-missing");
            var note = document.createElement("span");
            note.className = "guest-os-note";
            note.textContent = " — image not in this build";
            sysCell.appendChild(note);
        });
    });
})();
