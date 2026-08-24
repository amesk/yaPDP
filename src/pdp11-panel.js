/**
 * yaPDP — PDP-11/70 Front Panel Controller
 *
 * Handles the physical front panel UI: switches, rotary encoders,
 * navigation sidebar, and examine/deposit operations.
 *
 * Must be loaded BEFORE pdp11.js because it defines CPU_TYPE
 * used by the CPU core.
 */

const CPU_TYPE = 70; // This is a PDP 11/70

// ==================================================================
// Page navigation (sidebar)
// ==================================================================

function switchPage(page) {
  var pages = document.querySelectorAll('.page');
  var btns = document.querySelectorAll('.nav-btn');
  for (var i = 0; i < pages.length; i++) {
    pages[i].classList.remove('active');
  }
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.remove('active');
  }
  var pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');
  var btn = document.querySelector('.nav-btn[data-page="' + page + '"]');
  if (btn) btn.classList.add('active');

  // Scroll the paper of the console teletype / LP11 printer when shown.
  // Scoped selectors keep the two G60Printer instances (teletype + printer)
  // independent even though they share the same inner element ids.
  var paperSelectors = {
    'teletype': '#page-teletype #paper',
    'printer': '#page-printer #lp11g60paper'
  };
  if (paperSelectors[page]) {
    var paper = document.querySelector(paperSelectors[page]);
    if (paper && paper.scrollHeight > paper.clientHeight) {
      paper.scrollTop = paper.scrollHeight - paper.clientHeight;
    }
  }

  // Focus the VT52 canvas on VT52 pages for keyboard capture.
  var canvasIds = {
    'vt52': 'vt52-screen',
    'vt52-console': 'vt52-console-screen',
    'vt52-2': 'vt52-2-screen'
  };
  if (canvasIds[page]) {
    var canvas = document.getElementById(canvasIds[page]);
    if (canvas) canvas.focus();
  }

  // The floating REBOOT button is an operator action: show it on the console
  // teletype, the VT52 terminal (TTY 1) and the front Panel page.
  var rebootBtn = document.getElementById('reboot-btn');
  if (rebootBtn) {
    rebootBtn.classList.toggle('hidden', !(page === 'teletype' || page === 'vt52' || page === 'panel'));
  }

  // The floating quick-boot (magic wand) button is a global action: show it on
  // every page except the INFO page (instructions), whose long-form help text
  // already explains the wizard.
  var quickBootBtn = document.getElementById('quick-boot-btn');
  if (quickBootBtn) {
    quickBootBtn.classList.toggle('hidden', page === 'instructions');
  }
}

// ==================================================================
// Switch helpers (toggle / rocker / momentary)
// ==================================================================

function moveSwitch(id, position) { // -1 up  0 centre   1 down  - will move 5/16 units
  var style = window.getComputedStyle(id, null);
  id.style.borderTopWidth = 'calc(var(--unitHeight) * ' + (8 + 4 * position) + ')';
  id.style.borderBottomWidth = 'calc(var(--unitHeight) * ' + (7 - 4 * position) + ')';
}

function setSwitch(id, weight) {
  var mask = 1 << weight;
  CPU.switchRegister ^= mask;
  moveSwitch(id, (CPU.switchRegister & mask) ? -1 : 0);
}

function toggleSwitch(id) {
  moveSwitch(id, 1);
  setTimeout(function () {
    moveSwitch(id, 0);
  }, 350);
}

// ==================================================================
// Examine / Deposit logic
// ==================================================================

function examineDeposit(data) {
  var result, autoMask, trapState;
  if (data < 0) {
    autoMask = 1; // Examine auto increment mask
  } else {
    autoMask = 2; // Deposit auto increment mask
  }
  trapState = CPU.trapPSW;
  CPU.trapPSW = -2; // Disable trap handling
  if (panel.rotary0 >= 1 && panel.rotary0 <= 6) { // If a virtual address is selected...
    if (panel.autoIncr & autoMask) {
      CPU.displayAddress += 2; // auto increment if applicable
    }
    CPU.displayAddress &= 0xffff;
    CPU.displayAddress |= [0, 0, 0, 0, 0x10000, 0x10000, 0x10000, 0][panel.rotary0];
    CPU.mmuMode = [0, 0, 1, 3, 3, 1, 0, 0][panel.rotary0];
    if (data < 0) { // examine (read)
      result = readWordByVirtual(CPU.displayAddress);
    } else { // deposit (write)
      data &= 0xffff; // 16 bits only
      result = writeWordByVirtual(CPU.displayAddress, data);
      if (result >= 0) {
        result = data; // Write return may just be a status
      }
    }
    CPU.displayAddress &= 0xffff;
  } else { // Physical address stuff...
    CPU.displayAddress &= 0x3fffff; // 22 bits max
    if (CPU_TYPE !== 70 && CPU.displayAddress >= IOBASE_18BIT) { // For 18 bit CPU map address to 22 bit
      CPU.displayAddress |= IOBASE_22BIT;
    }
    if (panel.autoIncr & autoMask) {
      if (CPU.displayAddress >= 017777700 && CPU.displayAddress <= 017777717) {
        CPU.displayAddress++; // register addresses increment only by 1
        if (CPU.displayAddress >= 017777720) {
          CPU.displayAddress = 017777700; // and registers loop around! (!)
        }
      } else {
        CPU.displayAddress += 2; // ordinary increment to next word
      }
    }
    CPU.displayAddress &= 0x3fffff; // 22 bits only
    if (CPU.displayAddress < IOBASE_UNIBUS && ((CPU.displayAddress & 1) || CPU.displayAddress >= MAX_MEMORY)) {
      CPU.displayAddress |= 0x400000; // Set ADRS ERR light
    } else {
      if (data < 0) { // examine (read)
        result = readWordByPhysical(CPU.displayAddress);
      } else { // deposit (write)
        data &= 0xffff; // 16 bits only
        result = writeWordByPhysical(CPU.displayAddress, data);
        if (result >= 0) {
          result = data; // Write return may just be a status
        } else {
          if (CPU.displayAddress == 017777776) { // write to PSW
            result = readPSW(); // PSW write return is a false error
          }
        }
      }
    }
  }
  CPU.trapPSW = trapState; // Reenable trap handling
  writePSW(CPU.PSW); // Restore mode (CPU.mmuMode)
  if (result >= 0) {
    panel.autoIncr = autoMask; // Set auto increment for next time
    CPU.displayDataPaths = result;
  } else {
    panel.autoIncr = 0;
  }
}

// ==================================================================
// DOM event binding (replaces inline onclick / onClick)
// ==================================================================

(function initPanelUI() {

  // --- Sidebar navigation (data-page) ---
  // Leaving the CONFIG page with uncommitted changes asks for confirmation via
  // the shared modal overlay (window.configConfirmLeave) so the user does
  // not silently lose pending structural edits.
  document.querySelectorAll('.nav-btn[data-page]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = this.dataset.page;
      if (target !== 'config' &&
          typeof window.isConfigDirty === 'function' &&
          window.isConfigDirty()) {
        var cfgPage = document.getElementById('page-config');
        var onConfig = cfgPage && cfgPage.classList.contains('active');
        if (onConfig) {
          if (typeof window.configConfirmLeave === 'function') {
            // The overlay's "Leave" button performs the switch asynchronously.
            window.configConfirmLeave(function () { switchPage(target); });
          } else if (window.confirm('You have uncommitted configuration changes. Leave without applying?')) {
            switchPage(target);
          }
          return;
        }
      }
      switchPage(target);
    });
  });

  // --- Power lock (OFF / POWER / LOCK) ---
  // The position labels are the hit targets: clicking a label selects that
  // state directly, mirroring the CCU LINE/OFF/LOCAL switch of the Model 33
  // teletype (click the states, not the switch itself). The lock key stays
  // decorative and rotates to point at the selected position.
  var powerStates = { off: -1, run: 0, lock: 1 };

  function setPowerState(state, skipAutoBoot) {
    if (!(state in powerStates) || typeof panel === 'undefined') return;
    var powerOn = powerStates[state] >= 0;
    var position = powerStates[state];
    if (typeof window.applyMachinePower === 'function') {
      // pdp11-app.js applies the power state (POWER LOCK key, CPU halt on
      // power-off, Config.powerOn sync and the auto-boot bootstrap on
      // power-on). skipAutoBoot suppresses the auto-bootstrap when the caller
      // already reboots (resetPanelControls inside doReboot).
      window.applyMachinePower(powerOn, !!skipAutoBoot);
    } else {
      // Fallback before pdp11-app.js has loaded (clicks only happen later).
      panel.powerSwitch = position;
      if (!powerOn) CPU.runState = STATE_HALT;
      if (window.Hum) window.Hum.update();
      if (typeof Config !== 'undefined') Config.set({ powerOn: powerOn });
    }
    // Always point the key at the exact selected position: applyMachinePower()
    // collapses every powered-on state to RUN (powerSwitch 0), which would
    // otherwise leave the key on POWER (ON) instead of LOCK and keep the
    // front-panel switches enabled while the panel is locked.
    panel.powerSwitch = position;
    var key = document.getElementById('key');
    if (key) key.style.transform = 'rotate(' + (position * 90 - 45) + 'deg)';
  }

  var lockPos = document.querySelectorAll('.lockPanelPos');
  for (var li = 0; li < lockPos.length; li++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        // The POWER LOCK key clicks only when the state actually changes.
        if (typeof panel !== 'undefined' &&
            typeof window.playComputerButton === 'function' &&
            panel.powerSwitch !== powerStates[btn.getAttribute('data-power-state')]) {
          window.playComputerButton();
        }
        setPowerState(btn.getAttribute('data-power-state'));
      });
    })(lockPos[li]);
  }

  // Old Paul-emulator reaction: clicking the POWER LOCK key itself cycles the
  // state OFF -> POWER -> LOCK (plain click) or back (Shift+click), kept in
  // addition to the direct label clicks above so familiar users are not
  // surprised. setPowerState() restores the exact cycled key position.
  var lockEl = document.querySelector('.lock');
  if (lockEl) {
    lockEl.addEventListener('click', function (e) {
      if (typeof panel === 'undefined') return;
      // Never steal a direct label click (the labels may overlap the disc).
      if (e.target && e.target.closest && e.target.closest('.lockPanelPos')) return;
      if (typeof window.playComputerButton === 'function') window.playComputerButton();
      var next = panel.powerSwitch;
      next = e.shiftKey
        ? (next - 1 < -1 ? 1 : next - 1)
        : (next + 1 > 1 ? -1 : next + 1);
      setPowerState(next < 0 ? 'off' : (next === 0 ? 'run' : 'lock'));
    });
  }

  // Default to the powered-on RUN position so the active label matches the
  // initial panel state. Deferred: `panel` is created by pdp11.js, which is
  // loaded after this module.
  setTimeout(function () {
    setPowerState('run');
  }, 0);

  // --- Rotary switch 0 (class="rotarySwitch" in rotaryTopPanel) ---
  var rotary0 = document.querySelector('.rotaryTopPanel .rotarySwitch');
  if (rotary0) {
    rotary0.addEventListener('click', function (e) {
      if (typeof window.playSwitchClick === 'function') window.playSwitchClick();
      if (e.shiftKey) {
        if (--panel.rotary0 < 0) panel.rotary0 = 7;
      } else {
        if (++panel.rotary0 > 7) panel.rotary0 = 0;
      }
      this.style.transform = 'rotate(' + (panel.rotary0 * 45 - 45) + 'deg)';
      panel.autoIncr = 0;
    });
  }

  // --- Rotary switch 1 (class="rotarySwitch" in rotaryBottomPanel) ---
  var rotary1 = document.querySelector('.rotaryBottomPanel .rotarySwitch');
  if (rotary1) {
    rotary1.addEventListener('click', function (e) {
      if (typeof window.playSwitchClick === 'function') window.playSwitchClick();
      if (e.shiftKey) {
        if (--panel.rotary1 < 0) panel.rotary1 = 3;
      } else {
        if (++panel.rotary1 > 3) panel.rotary1 = 0;
      }
      this.style.transform = 'rotate(' + (panel.rotary1 * 45 - 45) + 'deg)';
      panel.autoIncr = 0;
    });
  }

  // --- Data/address switches (data-weight attributes) ---
  document.querySelectorAll('.switch[data-weight]').forEach(function (el) {
    el.addEventListener('click', function () {
      setSwitch(this, parseInt(this.dataset.weight));
    });
  });

  // --- Lamp Test (class="switch white") ---
  var lampTest = document.querySelector('.switch.white');
  if (lampTest) {
    lampTest.addEventListener('click', function () {
      moveSwitch(this, panel.lampTest = 1 - panel.lampTest);
      if (!panel.powerSwitch) {
        if (panel.lamp) panel.lamp = 1;
      }
    });
  }

  // --- LOAD ADRS (class="switch redBase" + data-action="loadAdrs") ---
  var loadAdrs = document.querySelector('[data-action="loadAdrs"]');
  if (loadAdrs) {
    loadAdrs.addEventListener('click', function () {
      toggleSwitch(this);
      CPU.displayAddress = CPU.switchRegister;
      panel.autoIncr = 0;
    });
  }

  // --- EXAM (class="switch purpleBase" + data-action="examine") ---
  var exam = document.querySelector('[data-action="examine"]');
  if (exam) {
    exam.addEventListener('click', function () {
      toggleSwitch(this);
      if (!panel.powerSwitch) {
        if (CPU.runState === STATE_HALT) examineDeposit(-1);
      }
    });
  }

  // --- DEP (class="switch redBase" + data-action="deposit") ---
  var dep = document.querySelector('[data-action="deposit"]');
  if (dep) {
    dep.addEventListener('click', function () {
      toggleSwitch(this);
      if (!panel.powerSwitch) {
        if (CPU.runState === STATE_HALT) examineDeposit(CPU.switchRegister);
      }
    });
  }

  // --- CONT (class="switch purpleBase" + data-action="cont") ---
  var cont = document.querySelector('[data-action="cont"]');
  if (cont) {
    cont.addEventListener('click', function () {
      toggleSwitch(this);
      if (!panel.powerSwitch && CPU.runState === STATE_HALT) {
        if (panel.halt) {
          CPU.runState = STATE_STEP;
        } else {
          CPU.runState = STATE_RUN;
        }
      }
    });
  }

  // --- ENABLE/HALT (class="switch redBase" + data-action="enableHalt") ---
  var enableHalt = document.querySelector('[data-action="enableHalt"]');
  if (enableHalt) {
    enableHalt.addEventListener('click', function () {
      moveSwitch(this, panel.halt = 1 - panel.halt);
      if (!panel.powerSwitch) {
        if (panel.halt) {
          CPU.runState = STATE_HALT;
          // A halted machine must stop producing console output at once.
          flushG60Console();
        }
      }
      // Reflect the new RUN/HALT state in the ambient hum immediately.
      if (window.Hum) window.Hum.update();
    });
  }

  // --- S INST/S BUS (class="switch purpleBase" + data-action="step") ---
  var step = document.querySelector('[data-action="step"]');
  if (step) {
    step.addEventListener('click', function () {
      moveSwitch(this, panel.step = 1 - panel.step);
    });
  }

  // --- START (class="switch redBase" + data-action="start") ---
  var start = document.querySelector('[data-action="start"]');
  if (start) {
    start.addEventListener('click', function () {
      toggleSwitch(this);
      if (!panel.powerSwitch) {
        if (CPU.runState === STATE_HALT) {
          iopage.reset();
          CPU.registerVal[7] = CPU.displayAddress & 0xffff;
          if (!panel.halt) {
            CPU.runState = STATE_RUN;
          }
        }
      }
      // Starting the machine raises the hum back to full level at once.
      if (window.Hum) window.Hum.update();
    });
  }

  // --- REBOOT button (data-action="reboot") ---
  // A single floating button (top-left of the window) shown on the Panel,
  // teletype and VT52 (TTY 1) pages. Unless the user disabled the confirmation
  // on the CONFIG -> Behaviour tab, ask first so a stray click near the
  // console cannot wipe a running guest.
  // Reset the physical front-panel controls to their powered-on default state
  // so a reboot cannot leave the panel inconsistent with the machine — e.g.
  // the ENABLE/HALT switch still in HALT while the RUN light is lit.
  function resetPanelControls() {
    panel.halt = 0; // ENABLE/HALT switch -> ENABLE (run) position
    var enableHalt = document.querySelector('[data-action="enableHalt"]');
    if (enableHalt) moveSwitch(enableHalt, 0);

    panel.step = 0; // S INST/S BUS switch -> S INST position
    var step = document.querySelector('[data-action="step"]');
    if (step) moveSwitch(step, 0);

    panel.lampTest = 0; // LAMP TEST switch -> off
    var lampTest = document.querySelector('.switch.white');
    if (lampTest) moveSwitch(lampTest, 0);

    CPU.switchRegister = 0; // Data/address switches -> all cleared
    document.querySelectorAll('.switch[data-weight]').forEach(function (el) {
      moveSwitch(el, 0);
    });

    panel.rotary0 = 0; // Rotary switches -> position 0
    panel.rotary1 = 0;
    panel.autoIncr = 0;
    var rotary0 = document.querySelector('.rotaryTopPanel .rotarySwitch');
    if (rotary0) rotary0.style.transform = 'rotate(-45deg)';
    var rotary1 = document.querySelector('.rotaryBottomPanel .rotarySwitch');
    if (rotary1) rotary1.style.transform = 'rotate(-45deg)';

    // Power lock -> RUN position (powered on). skipAutoBoot: doReboot() starts
    // the bootstrap itself, so resetting the panel must not trigger the
    // auto-boot option again.
    setPowerState('run', true);

    // Reflect the powered-on RUN state in the ambient hum immediately.
    if (window.Hum) window.Hum.update();
  }

  function doReboot(forceBoot) {
    if (g60Console) g60Console.writeChar(10);
    // Stop any runaway teletype output backlog before restarting the CPU,
    // so the Boot> prompt is immediately visible and usable.
    flushG60Console();
    resetPanelControls();
    // The default bootstrap is started only when the operator explicitly asks
    // for it (Bootstrap now! passes forceBoot) or when the auto-boot option is
    // set — otherwise the machine reboots into a halted state and the operator
    // boots it manually.
    if (forceBoot ||
        (typeof Config !== 'undefined' && Config.get().autoBoot)) {
      boot();
    }
  }

  // Confirmation overlay (reuses the shared modal style, see css/pdp11.css).
  var rebootConfirmOverlay = null;

  function ensureRebootConfirm() {
    if (rebootConfirmOverlay) return rebootConfirmOverlay;
    rebootConfirmOverlay = document.createElement('div');
    rebootConfirmOverlay.id = 'reboot-confirm-overlay';
    rebootConfirmOverlay.className = 'modal-overlay';
    rebootConfirmOverlay.innerHTML =
      '<div class="modal-box">' +
        '<span class="modal-title">Reboot the machine?</span>' +
        '<p class="modal-intro">This restarts the emulated PDP-11 and boots the ' +
        'built-in default loader.</p>' +
        '<label class="modal-dontask"><input type="checkbox" id="reboot-dont-ask"> ' +
        'Don\'t show this warning anymore</label>' +
        '<button type="button" class="modal-close" data-reboot-action="cancel">Cancel</button>' +
        '<button type="button" class="modal-close" data-reboot-action="reboot">Reboot</button>' +
      '</div>';
    rebootConfirmOverlay.addEventListener('click', function (e) {
      var action = e.target.getAttribute && e.target.getAttribute('data-reboot-action');
      if (action === 'cancel' || e.target === rebootConfirmOverlay) {
        rebootConfirmOverlay.classList.remove('visible');
        return;
      }
      if (action === 'reboot') {
        var dontAsk = document.getElementById('reboot-dont-ask');
        if (dontAsk && dontAsk.checked && typeof Config !== 'undefined') {
          Config.set({ confirmReboot: false });
          // Keep the CONFIG page checkbox in sync: confirmReboot is a live
          // setting that can be toggled from here, so the form must not show a
          // stale value (which would trip the uncommitted-changes warning).
          var confirmRebootEl = document.getElementById('config-confirmReboot');
          if (confirmRebootEl) confirmRebootEl.checked = false;
        }
        rebootConfirmOverlay.classList.remove('visible');
        doReboot();
      }
    });
    document.body.appendChild(rebootConfirmOverlay);
    return rebootConfirmOverlay;
  }

  function showRebootConfirm() {
    var overlay = ensureRebootConfirm();
    var dontAsk = document.getElementById('reboot-dont-ask');
    if (dontAsk) dontAsk.checked = false; // never carry a stale "don't ask" tick
    overlay.classList.add('visible');
  }

  document.querySelectorAll('[data-action="reboot"]').forEach(function (reboot) {
    reboot.addEventListener('click', function () {
      var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
      if (!cfg || cfg.confirmReboot === false) {
        doReboot();
        return;
      }
      showRebootConfirm();
    });
  });

  // --- Panel action buttons (Help Me! / Bootstrap now!) ------------------
  // "Help Me!" toggles the operator's sticky note; the choice is the
  // "panelSticker" CONFIG option (BEHAVIOUR tab), applied live by
  // pdp11-app.js and hidden by default on the very first start. "Boot now!"
  // reboots the machine and switches to the operator console (teletype or
  // VT52, per config).
  var stickerBtn = document.getElementById('panel-sticker-btn');
  var stickerEl = document.querySelector('.panel-sticker');
  if (stickerBtn && stickerEl) {
    stickerBtn.addEventListener('click', function () {
      // Toggle: a hidden sticker must be shown, a visible one hidden.
      var show = stickerEl.classList.contains('hidden');
      if (typeof Config !== 'undefined') Config.set({ panelSticker: show });
      if (typeof window.applyPanelSticker === 'function') {
        window.applyPanelSticker(show);
      } else {
        // Fallback before pdp11-app.js has loaded: keep the UI in sync.
        stickerEl.classList.toggle('hidden', !show);
        stickerBtn.classList.toggle('active', show);
        stickerBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
      }
    });
  }

  // --- Bootstrap now! power-off guard ---------------------------------
  // The machine must be powered on to boot. If the POWER LOCK switch is OFF
  // (panel.powerSwitch < 0), show an onboarding-style dialog asking the
  // operator to power the machine on first, instead of silently halting.
  var powerOffOverlay = null;

  function ensurePowerOffDialog() {
    if (powerOffOverlay) return powerOffOverlay;
    powerOffOverlay = document.createElement('div');
    powerOffOverlay.id = 'power-off-overlay';
    powerOffOverlay.className = 'modal-overlay';
    powerOffOverlay.innerHTML =
      '<div class="modal-box">' +
        '<span class="modal-title">The machine is powered off</span>' +
        '<p class="modal-intro">Turn the <b>POWER LOCK</b> switch on the front ' +
          'panel to <b>POWER</b> (or click the POWER label) to power the machine ' +
          'on, then press <b>Bootstrap now!</b> again.</p>' +
        '<button type="button" class="modal-close" data-power-off-action="ok">Got it</button>' +
      '</div>';
    powerOffOverlay.addEventListener('click', function (e) {
      if (e.target === powerOffOverlay ||
          (e.target.getAttribute && e.target.getAttribute('data-power-off-action'))) {
        powerOffOverlay.classList.remove('visible');
      }
    });
    document.body.appendChild(powerOffOverlay);
    return powerOffOverlay;
  }

  function showPowerOffDialog() {
    ensurePowerOffDialog().classList.add('visible');
  }

  var panelBootBtn = document.getElementById('panel-boot-btn');
  if (panelBootBtn) {
    panelBootBtn.addEventListener('click', function () {
      if (typeof panel !== 'undefined' && panel.powerSwitch < 0) {
        showPowerOffDialog();
        return;
      }
      var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
      var consolePage = (cfg && cfg.consoleType === 'vt52') ? 'vt52-console' : 'teletype';
      // Bootstrap now! always starts the default bootstrap (unlike the generic
      // REBOOT button, which does so only when the auto-boot option is set).
      doReboot(true);
      switchPage(consolePage);
    });
  }
})();
