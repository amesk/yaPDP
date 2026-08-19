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

function g60ConsoleWrite(code) {
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
  g60printer = new G60Printer('g60printer', {
    maxCols: maxCols,
    pageBreakMarker: false,
    charPrintDelay: teletypeDelay((cfg) ? cfg.teletypeSpeed : null)
  });
  g60Console = createG60Console(g60printer);
}

// ==================================================================
// Google60-style punch-keyboard for PDP-11 terminal input
// ==================================================================
// Renders a keypunch-style keyboard using sprite-based 3D keys
// (keys.png / keyfaces.png) matching the original Google60 keypunch.
// ==================================================================

var g60Keyboard = (function () {
  'use strict';

  // Row definitions: { top, left, keys[] }
  // key = [label, shiftLabel] or {label, code, shift, space}
  var keyRows = [
    {
      top: 4, left: 0, keys: [
        ['1', '!'], ['2', '"'], ['3', '#'], ['4', '$'], ['5', '%'],
        ['6', '&'], ['7', '\''], ['8', '('], ['9', ')'], ['0'],
        [':', '*'], ['-', '=']
      ]
    },
    {
      top: 44, left: 20, keys: [
        { label: 'CTRL', cls: 'func', ctrl: true },
        null,
        ['Q'], ['W'], ['E'], ['R'], ['T'], ['Y'],
        ['U'], ['I', '_'], ['O', '_'], ['P', '@'],
        null, { label: 'DISCARD', code: 8, cls: 'func' }
      ]
    },
    {
      top: 84, left: 40, keys: [
        ['A'], ['S'], ['D'], ['F'], ['G'], ['H'],
        ['J'], ['K', '['], ['L', '\\'], [';', '+'],
        null, { label: 'RETURN', code: 13, cls: 'func' }
      ]
    },
    {
      top: 124, left: 2, keys: [
        { label: 'PICS', shift: true, cls: 'shift' }, null,
        ['Z'], ['X'], ['C'], ['V'], ['B'],
        ['N', '^'], ['M', ']'], [',', '<'], ['.', '>'], ['/', '?'],
        null, { label: 'PICS', shift: true, cls: 'shift' }
      ]
    },
    {
      top: 172, left: 221, keys: [
        { label: '', code: 32, space: true }
      ]
    }
  ];

  var shifted = false;
  var ctrlHeld = false;

  function buildKeyboard() {
    var kbd = document.getElementById('punchkeyboard');
    if (!kbd) return;
    kbd.innerHTML = '';

    for (var ri = 0; ri < keyRows.length; ri++) {
      var row = keyRows[ri];
      var keys = row.keys;
      // Sprite row index for keyfaces.png: bgy = ri * 35
      var bgy = ri * 35;
      var bgx = 0;

      // x starts at row.left, decrements by 44 per null spacer
      // position = x + ci*50
      var x = row.left;

      for (var ci = 0; ci < keys.length; ci++) {
        var def = keys[ci];
        if (!def) { x -= 44; continue; }

        var pos = x + ci * 50;

        if (def.space === true) {
          // ---- Space bar (sprite-based) ----
          var el = document.createElement('div');
          el.className = 'key_blank';
          var bg = document.createElement('div');
          bg.className = 'key_blank_bg';
          el.appendChild(bg);
          el.style.left = pos + 'px';
          el.style.top = row.top + 'px';
          el._code = 32;

          el.addEventListener('mousedown', function (e) {
            e.preventDefault();
            this.classList.add('key_blank_down');
          });
          el.addEventListener('mouseup', function (e) {
            e.preventDefault();
            if (!this.classList.contains('key_blank_down')) return;
            this.classList.remove('key_blank_down');
            sendChar(this._code);
          });
          el.addEventListener('mouseleave', function (e) {
            if (this.classList.contains('key_blank_down')) {
              this.classList.remove('key_blank_down');
            }
          });

          kbd.appendChild(el);
          bgx += 37;
          continue;
        }

        if (def.ctrl === true) {
          // ---- CTRL key: text label over sprite body (no keyface) ----
          var el = document.createElement('div');
          el.className = 'key';
          var bg = document.createElement('div');
          bg.className = 'keybg';
          el.appendChild(bg);
          var label = document.createElement('span');
          label.className = 'keylabel_ctrl';
          label.textContent = def.label;
          el.appendChild(label);
          el.style.left = pos + 'px';
          el.style.top = row.top + 'px';
          el._ctrl = true;
          el.id = 'key_ctrl';

          el.addEventListener('mousedown', function (e) {
            e.preventDefault();
            ctrlHeld = !ctrlHeld;
            updateCtrlVisual();
          });

          kbd.appendChild(el);
          // Do NOT increment bgx — keep sprite positions aligned for subsequent keys
          continue;
        }

        if (def.shift === true) {
          // ---- PICS (shift) key: sprite-based (keybg + keyface) ----
          var el = document.createElement('div');
          el.className = 'key';
          var bg = document.createElement('div');
          bg.className = 'keybg';
          el.appendChild(bg);
          var face = document.createElement('div');
          face.className = 'keyface';
          face.style.backgroundPosition = '-' + bgx + 'px -' + bgy + 'px';
          el.appendChild(face);
          el.style.left = pos + 'px';
          el.style.top = row.top + 'px';
          el._shift = true;
          el.id = (ri === 3 && ci === 0) ? 'key_shift_1' : 'key_shift_2';

          el.addEventListener('mousedown', function (e) {
            e.preventDefault();
            shifted = !shifted;
            updateShiftVisual();
          });

          kbd.appendChild(el);
          bgx += 37;
          continue;
        }

        // ---- Regular key (character or function): keybg + keyface sprites ----
        var el = document.createElement('div');
        el.className = 'key';
        // 3D key body from keys.png sprite
        var bg = document.createElement('div');
        bg.className = 'keybg';
        el.appendChild(bg);
        // Character face from keyfaces.png sprite
        var face = document.createElement('div');
        face.className = 'keyface';
        face.style.backgroundPosition = '-' + bgx + 'px -' + bgy + 'px';
        el.appendChild(face);
        el.style.left = pos + 'px';
        el.style.top = row.top + 'px';

        // Set character codes
        if (Array.isArray(def)) {
          el._code = def[0].charCodeAt(0);
          el._shiftCode = def[1] ? def[1].charCodeAt(0) : el._code;
          el._shiftLabel = def[1] || null;
        } else if (typeof def.code === 'number') {
          el._code = def.code;
          el._shiftCode = def.code;
          el._shiftLabel = null;
        }

        el.addEventListener('mousedown', function (e) {
          e.preventDefault();
          this.classList.add('key_down');
        });

        el.addEventListener('mouseup', function (e) {
          e.preventDefault();
          if (!this.classList.contains('key_down')) return;
          this.classList.remove('key_down');
          var send = (shifted && this._shiftCode) ? this._shiftCode : this._code;
          if (ctrlHeld) {
            send = send & 0x1F;        // Ctrl clears bits 6 and 7
            ctrlHeld = false;
            updateCtrlVisual();
          }
          sendChar(send);
          if (shifted && this._shiftLabel) {
            shifted = false;
            updateShiftVisual();
          }
        });

        el.addEventListener('mouseleave', function (e) {
          if (this.classList.contains('key_down')) {
            this.classList.remove('key_down');
          }
        });

        kbd.appendChild(el);
        bgx += 37;
      }
    }
  }

  function updateShiftVisual() {
    // Shift keys use key_down class to shift sprite to pressed position
    var el1 = document.getElementById('key_shift_1');
    var el2 = document.getElementById('key_shift_2');
    if (el1) el1.className = 'key' + (shifted ? ' key_down' : '');
    if (el2) el2.className = 'key' + (shifted ? ' key_down' : '');
  }

  function updateCtrlVisual() {
    // Ctrl key uses key_down class for pressed visual
    var el = document.getElementById('key_ctrl');
    if (el) el.className = 'key' + (ctrlHeld ? ' key_down' : '');
  }

  // Physical keyboard handlers
  function installPhysicalKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (/^(input|textarea)$/i.test(e.target.tagName)) return;

      // Only intercept keyboard when the Teletype page is active —
      // on Panel and Info pages browser shortcuts (Ctrl+F etc.) must work normally.
      var termPage = document.getElementById('page-teletype');
      if (!termPage || !termPage.classList.contains('active')) return;

      // Special keys: Enter, Backspace, Tab
      var code = e.keyCode || e.which;
      if (code === 13) { sendDL([13]); e.preventDefault(); return; }
      if (code === 8) { sendDL([8]); e.preventDefault(); return; }
      if (code === 9) { sendDL([9]); e.preventDefault(); return; }
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

      if (ch >= 32 && ch < 127) {
        sendDL([ch]);
        e.preventDefault();
      }
    });

    var pane = document.getElementById('punchkeypane');
    if (pane) {
      pane.addEventListener('paste', function (e) {
        e.preventDefault();
        var text = (e.clipboardData || window.clipboardData).getData('text');
        if (text) {
          text = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
          var bytes = [];
          for (var i = 0; i < text.length; i++) {
            bytes.push(text.charCodeAt(i) & 0x7F);
          }
          sendDL(bytes);
        }
      });
    }
  }
  function sendChar(code) {
    if (typeof window.dlReceiveQueue === 'function') {
      window.dlReceiveQueue(0, [code]);
    }
  }
  function sendDL(bytes) {
    if (typeof window.dlReceiveQueue === 'function') {
      window.dlReceiveQueue(0, bytes);
    }
  }

  return { init: function () { buildKeyboard(); installPhysicalKeyboard(); } };
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

    // Route to the given unit via the globally exposed receive queue.
    // Unit 0 → dlReceiveQueue, unit N → dlReceiveQueueN.
    function sendToUnit(bytes) {
      // Optional audible key click (VT100-style feedback)
      if (typeof window.playKeyClick === 'function') window.playKeyClick();
      var q = (unit === 0) ? window.dlReceiveQueue : window['dlReceiveQueue' + unit];
      if (typeof q === 'function') q(unit, bytes);
    }

    // Special keys: Enter, Backspace
    var code = e.keyCode || e.which;
    if (code === 13) { sendToUnit([13]); e.preventDefault(); return; }
    if (code === 8) { sendToUnit([8]); e.preventDefault(); return; }

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
      if (text) {
        text = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
        var bytes = [];
        for (var i = 0; i < text.length; i++) {
          bytes.push(text.charCodeAt(i) & 0x7F);
        }
        var q = (unit === 0) ? window.dlReceiveQueue : window['dlReceiveQueue' + unit];
        if (typeof q === 'function') q(unit, bytes);
      }
    });
  }
}

// ---- Initialize a VT52 terminal on the given page ----
function initVT52Page(unit, pageId, canvasId, textareaId) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Create a hidden textarea for the VT52 to use as a backing store
  var textarea = document.createElement('textarea');
  textarea.id = textareaId;
  textarea.style.display = 'none';
  document.body.appendChild(textarea);

  // Initialize the VT52 terminal with canvas enabled.
  // receiveRoutine feeds input back through the unit's global queue.
  window.vt52Initialize(unit, function (unit, bytes) {
    var q = (unit === 0) ? window.dlReceiveQueue : window['dlReceiveQueue' + unit];
    if (typeof q === 'function') q(unit, bytes);
  }, textarea, canvas, {
    allowCanvas: true,
    noHardcopyFallback: true,
    fontSize: 20,
    cols: 80,
    rows: 24
  });

  // Install keyboard handler for this page
  installVT52Keyboard(unit, pageId);

  // Force terminal into screen mode with canvas visible immediately.
  // Without this, the terminal starts in hardcopy mode (output to hidden textarea)
  // and only switches to canvas upon receiving an escape sequence.
  var term = window.vt52Get(unit);
  if (term) {
    term.modes.screen = true;
    term.rows = 24;
    term.cols = 80;
    if (term.allowCanvas) {
      term.textArea.style.display = 'none';
      term.screenCanvas.style.display = 'block';
      term.screenCanvas.focus();
    }
    term.clearScreen();

    // Size canvas to match font metrics for 80x24 (plus the inner margin).
    // resizeCanvas() keeps the geometry (grid + screenPadding) in one place.
    var charW = term.canvas.charWidth;
    if (charW > 0) {
      term.resizeCanvas();
      term.renderCanvas();
    }

    // Disable vt52's built-in keydown handler on the canvas to avoid double-sending.
    // The global installVT52Keyboard() captures physical keyboard input instead.
    term.handleKey = function () { };
  }
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
    if (!cfg || !cfg.keyClick) return;
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
      '</div>';
    __configLeaveOverlay.addEventListener('click', function (e) {
      var action = e.target.getAttribute && e.target.getAttribute('data-leave-action');
      var cb = __configLeaveCallbacks;
      if (action === 'leave') {
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

// ---- CONFIG page tabs: switch between the grouped config panels ----
function initConfigTabs() {
  var tabs = document.querySelectorAll('.config-tab');
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
}

// ---- CONFIG page form: populate controls and wire up events ----
function initConfigForm() {
  var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
  if (!cfg) return;

  var radios = document.querySelectorAll('input[name="consoleType"]');
  var speedRadios = document.querySelectorAll('input[name="teletypeSpeed"]');
  var userTerm = document.getElementById('config-userTerminals');
  var printerEl = document.getElementById('config-printer');
  var vt11El = document.getElementById('config-vt11');
  var pwEl = document.getElementById('config-printWidth');
  var pwrEl = document.getElementById('config-printerWidth');
  var kcEl = document.getElementById('config-keyClick');
  var vt52RevEl = document.getElementById('config-vt52ReverseVideo');
  var crtEl = document.getElementById('config-crtEffects');
  var humEl = document.getElementById('config-hum');
  var pbEl = document.getElementById('config-photoBackdrop');
  var confirmRebootEl = document.getElementById('config-confirmReboot');
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
  setRadioChecked(speedRadios, cfg.teletypeSpeed);
  if (userTerm) userTerm.value = String(cfg.userTerminals);
  if (printerEl) printerEl.checked = cfg.printer;
  if (vt11El) vt11El.checked = cfg.vt11;
  if (pwEl) pwEl.value = String(cfg.printWidth);
  if (pwrEl) pwrEl.value = String(cfg.printerWidth);
  if (kcEl) kcEl.checked = cfg.keyClick;
  if (vt52RevEl) vt52RevEl.checked = cfg.vt52ReverseVideo;
  if (crtEl) crtEl.checked = cfg.crtEffects;
  if (humEl) humEl.checked = cfg.hum;
  if (pbEl) pbEl.checked = cfg.photoBackdrop;
  if (confirmRebootEl) confirmRebootEl.checked = cfg.confirmReboot;
  // The first-run hint is not part of the persisted Config: its state lives in
  // the onboarding flag, so read it straight from the Onboarding module.
  if (firstRunEl && typeof Onboarding !== 'undefined') {
    firstRunEl.checked = Onboarding.isEnabled();
  }
  applyPhotoBackdrop(cfg.photoBackdrop);
  applyCRTEffects(cfg.crtEffects);

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
    return {
      consoleType: consoleType,
      userTerminals: (userTerm) ? Number(userTerm.value) : cfg.userTerminals,
      printer: (printerEl) ? printerEl.checked : cfg.printer,
      vt11: (vt11El) ? vt11El.checked : cfg.vt11,
      printWidth: (pwEl) ? Number(pwEl.value) : cfg.printWidth,
      printerWidth: (pwrEl) ? Number(pwrEl.value) : cfg.printerWidth,
      teletypeSpeed: teletypeSpeed,
      keyClick: (kcEl) ? kcEl.checked : cfg.keyClick,
      vt52ReverseVideo: (vt52RevEl) ? vt52RevEl.checked : cfg.vt52ReverseVideo,
      crtEffects: (crtEl) ? crtEl.checked : cfg.crtEffects,
      hum: (humEl) ? humEl.checked : cfg.hum,
      photoBackdrop: (pbEl) ? pbEl.checked : cfg.photoBackdrop,
      // confirmReboot is a live setting that can also be toggled from the
      // reboot confirmation dialog (pdp11-panel.js), which never touches the
      // form DOM. Read it from the persisted config so a stale checkbox cannot
      // mark the form as dirty or be overwritten by Apply.
      confirmReboot: (typeof Config !== 'undefined')
          ? Config.get().confirmReboot
          : cfg.confirmReboot
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
      form.keyClick !== current.keyClick ||
      form.vt52ReverseVideo !== current.vt52ReverseVideo ||
      form.crtEffects !== current.crtEffects ||
      form.hum !== current.hum ||
      form.photoBackdrop !== current.photoBackdrop ||
      form.confirmReboot !== current.confirmReboot;
  }

  // Re-tune the live console/printer instances from a full config snapshot.
  function applyLive(f) {
    if (g60printer) {
      if (g60printer.setMaxCols) g60printer.setMaxCols(f.printWidth);
      if (g60printer.setCharPrintDelay) g60printer.setCharPrintDelay(teletypeDelay(f.teletypeSpeed));
    }
    if (window.lp11G60Printer && window.lp11G60Printer.setMaxCols) {
      window.lp11G60Printer.setMaxCols(f.printerWidth);
    }
    applyVT52ReverseVideo(f.vt52ReverseVideo);
    applyCRTEffects(f.crtEffects);
    applyPhotoBackdrop(f.photoBackdrop);
  }

  function updateDirtyUI() {
    if (applyBtn) applyBtn.classList.toggle('dirty', isDirty());
  }

  // Structural changes are no longer applied on the fly; they only mark the
  // form as dirty and are committed together by the Apply button.
  function markStructural() {
    updateDirtyUI();
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
      if (this.checked) markStructural();
    });
  }
  if (userTerm) {
    userTerm.addEventListener('change', markStructural);
  }
  if (printerEl) {
    printerEl.addEventListener('change', markStructural);
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

  // Live changes apply without reloading.
  if (pwEl) {
    pwEl.addEventListener('change', function () {
      if (typeof Config !== 'undefined') Config.set({ printWidth: Number(this.value) });
      if (g60printer && g60printer.setMaxCols) g60printer.setMaxCols(Number(this.value));
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
      setRadioChecked(speedRadios, d.teletypeSpeed);
      if (userTerm) userTerm.value = String(d.userTerminals);
      if (printerEl) printerEl.checked = d.printer;
      if (vt11El) vt11El.checked = d.vt11;
      if (pwEl) pwEl.value = String(d.printWidth);
      if (pwrEl) pwrEl.value = String(d.printerWidth);
      if (kcEl) kcEl.checked = d.keyClick;
      if (vt52RevEl) vt52RevEl.checked = d.vt52ReverseVideo;
      if (crtEl) crtEl.checked = d.crtEffects;
      if (humEl) humEl.checked = d.hum;
      if (pbEl) pbEl.checked = d.photoBackdrop;
      if (confirmRebootEl) confirmRebootEl.checked = d.confirmReboot;
      // The form now shows factory values; nothing is persisted until Apply.
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
  window.addEventListener('beforeunload', function (e) {
    if (!window.isConfigDirty || !window.isConfigDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  updateDirtyUI();
}

// ---- Bootstrap ----
var __appCfg = (typeof Config !== 'undefined') ? Config.get() : null;

initG60Printer();
g60Keyboard.init();

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

// Apply the configured VT52 reverse-video mode to the live terminals.
applyVT52ReverseVideo(__appCfg && __appCfg.vt52ReverseVideo);

// Apply the configured CRT-effects mode (pure-CSS flicker/roll simulation).
applyCRTEffects(__appCfg && __appCfg.crtEffects);

applyVisibility();
initConfigForm();
initConfigTabs();
boot();

// First-run onboarding hint (no-op after the user has dismissed it once)
Onboarding.init();
