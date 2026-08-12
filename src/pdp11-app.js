/**
 * PDP-11/70 Application Initialization
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

function g60ConsoleWrite(code) {
  if (g60Console) g60Console.writeChar(code);
}

function initG60Printer() {
  if (g60printer) return;
  g60printer = new G60Printer('g60printer');
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

// ---- VT52 page keyboard handler ----
// Routes physical keyboard input to TTY1 (unit 1) when VT52 page is active.
function installVT52Keyboard() {
  document.addEventListener('keydown', function (e) {
    if (/^(input|textarea)$/i.test(e.target.tagName)) return;

    // Ignore browser auto-repeat (key held down)
    if (e.repeat) return;

    // Only intercept when VT52 page is active
    var vt52Page = document.getElementById('page-vt52');
    if (!vt52Page || !vt52Page.classList.contains('active')) return;

    // Don't intercept when teletype page is also active (let g60Keyboard handle it)
    var telePage = document.getElementById('page-teletype');
    if (telePage && telePage.classList.contains('active')) return;

    // Prevent Tab switching away from the emulator
    if (e.key === 'Tab') { e.preventDefault(); return; }

    // Route to TTY1 (unit 1) via globally exposed dlReceiveQueue1
    function sendVT52(bytes) {
      if (typeof window.dlReceiveQueue1 === 'function') {
        window.dlReceiveQueue1(1, bytes);
      }
    }

    // Special keys: Enter, Backspace
    var code = e.keyCode || e.which;
    if (code === 13) { sendVT52([13]); e.preventDefault(); return; }
    if (code === 8) { sendVT52([8]); e.preventDefault(); return; }

    // Ctrl+letter → control codes
    if (e.ctrlKey && code >= 65 && code <= 90) {
      sendVT52([code - 64]); e.preventDefault(); return;
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
      sendVT52([ch]);
      e.preventDefault();
    }
  });

  // Paste handler for VT52 page
  var vt52Crt = document.getElementById('vt52-crt');
  if (vt52Crt) {
    vt52Crt.addEventListener('paste', function (e) {
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData('text');
      if (text) {
        text = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
        var bytes = [];
        for (var i = 0; i < text.length; i++) {
          bytes.push(text.charCodeAt(i) & 0x7F);
        }
        if (typeof window.dlReceiveQueue1 === 'function') {
          window.dlReceiveQueue1(1, bytes);
        }
      }
    });
  }
}

// ---- Initialize VT52 terminal on the VT52 page ----
function initVT52Page() {
  var canvas = document.getElementById('vt52-screen');
  if (!canvas) return;

  // Create a hidden textarea for the VT52 to use as a backing store
  var textarea = document.createElement('textarea');
  textarea.id = 'tty1_textarea';
  textarea.style.display = 'none';
  document.body.appendChild(textarea);

  // Initialize the VT52 terminal with canvas enabled
  // Note: receiveRoutine must use dlReceiveQueue1 for TTY1 input
  window.vt52Initialize(1, function (unit, bytes) {
    if (typeof window.dlReceiveQueue1 === 'function') {
      window.dlReceiveQueue1(1, bytes);
    }
  }, textarea, canvas, {
    allowCanvas: true,
    noHardcopyFallback: true,
    fontSize: 20,
    cols: 80,
    rows: 24
  });

  // Install keyboard handler for this page
  installVT52Keyboard();

  // Force terminal into screen mode with canvas visible immediately.
  // Without this, the terminal starts in hardcopy mode (output to hidden textarea)
  // and only switches to canvas upon receiving an escape sequence.
  var term = window.vt52Get(1);
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

    // Size canvas to match font metrics for 80x24
    var charW = term.canvas.charWidth;
    if (charW > 0) {
      canvas.width = 80 * charW;
      canvas.height = 24 * term.fontHeight;
      term.resetCanvasContext(term.canvas.ctx);
      term.renderCanvas();
    }

    // Disable vt52's built-in keydown handler on the canvas to avoid double-sending.
    // The global installVT52Keyboard() captures physical keyboard input instead.
    term.handleKey = function () { };
  }
}

// ---- Bootstrap ----
initG60Printer();
g60Keyboard.init();
initVT52Page();
boot();

// First-run onboarding hint (no-op after the user has dismissed it once)
Onboarding.init();
