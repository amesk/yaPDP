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

  // Tell the floating controls that the visible page changed. The VT52 zoom
  // button is per terminal (console / TT1 / TT2), so it has to re-read which
  // terminal is on screen and repaint its state (see src/vt52zoom.js).
  if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
    document.dispatchEvent(new CustomEvent('yapdp:pagechange', { detail: { page: page } }));
  }

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

  // The floating REBOOT and STATE buttons appear on every OPERATOR page: the
  // front Panel, the operator console (teletype or VT52 console), the VT52
  // terminal (TTY 1), the VT11 display and the LP11 printer.
  //
  // They used to be limited to the first four, on the reasoning that a
  // machine-state action belongs where the machine is operated. Time in the
  // field disproved it: a restored state can land on the VT11 display (Lunar
  // Lander is played there) or the printer, and from those pages the operator
  // could not save again without first navigating away — a step nobody
  // expects. The two displays are working screens; the buttons belong on
  // them.
  //
  // CONFIG and Storage keep their own controls (Apply, Reset, Bind, the drop
  // zones) and are not operator consoles — a machine-state button there would
  // sit among settings. INFO is long-form help text and stays clean, the same
  // rule the magic-wand button already follows.
  var OPERATOR_PAGES = ['panel', 'teletype', 'vt52-console', 'vt52', 'vt11', 'printer'];
  var onOperatorPage = OPERATOR_PAGES.indexOf(page) !== -1;

  var rebootBtn = document.getElementById('reboot-btn');
  if (rebootBtn) {
    rebootBtn.classList.toggle('hidden', !onOperatorPage);
  }

  // The floating STATE button (machine-state dialog) mirrors REBOOT.
  var stateBtn = document.getElementById('state-btn');
  if (stateBtn) {
    stateBtn.classList.toggle('hidden', !onOperatorPage);
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
  // Mechanical toggle snick (press + release) so flipping a data/address
  // switch is audible, not just a visual rocker move.
  if (typeof window.playPanelToggle === 'function') window.playPanelToggle();
}

function toggleSwitch(id) {
  moveSwitch(id, 1);
  // Momentary (self-returning) switch: one click on the press, a second,
  // softer click when it springs back after ~350 ms.
  if (typeof window.playPanelPress === 'function') window.playPanelPress();
  setTimeout(function () {
    moveSwitch(id, 0);
    if (typeof window.playPanelRelease === 'function') window.playPanelRelease();
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
  // not silently lose pending structural edits. The sidebar version marker
  // reuses the same navigation path (it carries data-page="instructions").
  function navigateTo(target) {
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
  }

  document.querySelectorAll('.nav-btn[data-page]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      navigateTo(this.dataset.page);
    });
  });

  // --- Version marker (sidebar bottom) ---
  // The "yaPDP" name is static; the "vX.Y.Z" line and the Info page "About"
  // table version cell come from src/version.js (window.YAPDP_VERSION), which
  // is generated from package.json by tools/sync-version.js.
  var versionMarker = document.getElementById('sidebar-version');
  var versionText = versionMarker &&
    versionMarker.querySelector('.sidebar-version-text');
  var aboutVersion = document.getElementById('about-version');
  var appVersion = window.YAPDP_VERSION || '';
  if (versionText && appVersion) versionText.textContent = 'v' + appVersion;
  if (aboutVersion && appVersion) aboutVersion.textContent = appVersion;
  if (versionMarker) {
    versionMarker.addEventListener('click', function () {
      navigateTo(this.dataset.page);
    });
  }

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
      if (typeof window.playPanelToggle === 'function') window.playPanelToggle();
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
      if (typeof window.playPanelToggle === 'function') window.playPanelToggle();
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
      if (typeof window.playPanelToggle === 'function') window.playPanelToggle();
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

    // Processor state is reset by boot() itself, which performs a full
    // virtual power cycle (registers, PSW, MMU) while preserving main memory.
    // The panel only resets the switches and the power lock.

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
    // so the @ prompt is immediately visible and usable.
    flushG60Console();

    // Disks first: a controller reset must not keep serving blocks cached by
    // the previous boot (2.11 BSD / Unix V5 read a kernel in many blocks and
    // then stall silently; RT-11 reads one block and never noticed). The
    // flush runs on its own: boot() must NOT wait for it. flushDrive() talks
    // to IndexedDB, and gating the bootstrap on that promise left the machine
    // stranded whenever the store was slow or rejected — the panel was already
    // reset, boot() never ran, and the CPU sat at 0o2370 with psw 0o44 and no
    // "@" prompt. The cache is dropped inside the promise once the writes are
    // in; the guest's blocks are never lost because the cache is only cleared
    // after the flush resolves.
    if (typeof window !== 'undefined' &&
        typeof window.__yapdpFlushAndResetDisks === 'function') {
      window.__yapdpFlushAndResetDisks();
    }

    resetPanelControls();
    // The default bootstrap is started when the operator explicitly asks for
    // it (Bootstrap now! passes forceBoot) or when a Boot ROM is configured
    // (bootDevice is anything but 'none') — otherwise the machine reboots
    // into a halted state and the operator boots it manually. What the ROM
    // then does (interactive @ or replay the last medium) is decided inside
    // boot() itself.
    if (forceBoot ||
        (typeof Config !== 'undefined' && Config.get().bootDevice !== 'none')) {
      boot();
    } else if (typeof CPU !== 'undefined') {
      // No bootstrap: halt the CPU so the machine really rests. Without this,
      // a bootstrap already loaded in RAM (e.g. from an earlier boot) would
      // keep running and print its prompt again.
      CPU.runState = STATE_HALT;
    }
  }

  // The operator console page for the given config (VT52 and VT100 share the
  // graphical page; the teletype has its own).
  function consolePageFor(cfg) {
    var t = cfg && cfg.consoleType;
    return (t === 'vt52' || t === 'vt100') ? 'vt52-console' : 'teletype';
  }

  // Run a Reboot / Bootstrap now! action, first offering the viewer's own
  // configuration back when the machine is running on one imported from a saved
  // state. `action` ("reboot" | "boot") is parked across a rollback reload by
  // src/snapshots.js offerConfigRollback, so the operation is not lost — the
  // DOMContentLoaded handler at the end of this file replays it.
  function withRollbackOffer(action, proceed) {
    if (typeof window !== 'undefined' &&
        typeof window.__yapdpOfferConfigRollback === 'function') {
      window.__yapdpOfferConfigRollback(action, proceed);
    } else {
      proceed();
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
        '<p class="modal-intro">This restarts the emulated PDP-11. Choose what the ' +
        'Boot ROM does after the reboot — nothing, the interactive loader (@), or ' +
        'reload the medium that was loaded last.</p>' +
        '<label class="modal-field">Boot device' +
          '<select class="modal-select" id="reboot-bootDevice">' +
            '<option value="none">None</option>' +
            '<option value="interactive@">Interactive loader (@)</option>' +
            '<option value="last">Last medium</option>' +
          '</select></label>' +
        '<label class="modal-dontask"><input type="checkbox" id="reboot-dont-ask"> ' +
        'Don\'t show this warning anymore</label>' +
        '<button type="button" class="modal-close" data-reboot-action="cancel">Cancel</button>' +
        '<button type="button" class="modal-close" data-reboot-action="reboot">Reboot</button>' +
      '</div>';
    // The select is a shortcut to the CONFIG Boot device option: persist it
    // immediately and keep the Config form select in sync so it never shows a
    // stale value (bootDevice is a live option, not part of isDirty()).
    var rebootBootDeviceEl = rebootConfirmOverlay.querySelector('#reboot-bootDevice');
    if (rebootBootDeviceEl) {
      rebootBootDeviceEl.addEventListener('change', function () {
        if (typeof Config !== 'undefined' && Config.set) {
          Config.set({ bootDevice: this.value });
        }
        var cfgEl = document.getElementById('config-bootDevice');
        if (cfgEl) cfgEl.value = this.value;
      });
    }
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
        // The boot after the reboot follows the CONFIG Boot device option
        // (the dialog's select is a live mirror, persisted on change above):
        // doReboot() without forceBoot boots exactly when a Boot ROM is set.
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
    // Mirror the persisted Boot device choice every time the dialog opens, so
    // the select always reflects the config (it can change on the CONFIG page
    // or via a snapshot restore while the dialog exists).
    var bootDeviceEl = document.getElementById('reboot-bootDevice');
    if (bootDeviceEl && typeof Config !== 'undefined' && Config.get) {
      bootDeviceEl.value = Config.get().bootDevice;
    }
    overlay.classList.add('visible');
  }

  document.querySelectorAll('[data-action="reboot"]').forEach(function (reboot) {
    reboot.addEventListener('click', function () {
      // The configuration-rollback offer runs first; "Return my
      // configuration" may reload the page, in which case the parked
      // "reboot" action replays after the reload instead of running now.
      withRollbackOffer('reboot', function () {
        var cfg = (typeof Config !== 'undefined') ? Config.get() : null;
        if (!cfg || cfg.confirmReboot === false) {
          doReboot();
          return;
        }
        showRebootConfirm();
      });
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
          'on, then press <b>Bootstrap now!</b> again — or let the panel do it ' +
          'for you below.</p>' +
        '<label class="modal-field">Boot device' +
          '<select class="modal-select" id="power-off-bootDevice">' +
            '<option value="none">None</option>' +
            '<option value="interactive@">Interactive loader (@)</option>' +
            '<option value="last">Last medium</option>' +
          '</select></label>' +
        '<button type="button" class="modal-close" data-power-off-action="ok">Got it</button>' +
        '<button type="button" class="modal-close" data-power-off-action="power-on-boot">Power on & Bootstrap</button>' +
      '</div>';
    // The select is a shortcut to the CONFIG Boot device option: persist it
    // immediately and keep the Config form select in sync so it never shows a
    // stale value (bootDevice is a live option, not part of isDirty()).
    var powerOffBootDeviceEl = powerOffOverlay.querySelector('#power-off-bootDevice');
    if (powerOffBootDeviceEl) {
      powerOffBootDeviceEl.addEventListener('change', function () {
        if (typeof Config !== 'undefined' && Config.set) {
          Config.set({ bootDevice: this.value });
        }
        var cfgEl = document.getElementById('config-bootDevice');
        if (cfgEl) cfgEl.value = this.value;
      });
    }
    powerOffOverlay.addEventListener('click', function (e) {
      if (e.target === powerOffOverlay) {
        powerOffOverlay.classList.remove('visible');
        return;
      }
      var action = e.target.getAttribute && e.target.getAttribute('data-power-off-action');
      if (action === 'power-on-boot') {
        // Power the machine on and start the default bootstrap: doReboot(true)
        // powers on via resetPanelControls and then boots with forceBoot.
        powerOffOverlay.classList.remove('visible');
        withRollbackOffer('boot', function () {
          doReboot(true);
          switchPage(consolePageFor(Config.get()));
        });
      } else if (action === 'ok') {
        powerOffOverlay.classList.remove('visible');
      }
    });
    document.body.appendChild(powerOffOverlay);
    return powerOffOverlay;
  }

  function showPowerOffDialog() {
    var el = ensurePowerOffDialog();
    // Mirror the persisted Boot device choice every time the dialog opens, so
    // the select always reflects the config (it can change on the CONFIG page
    // or via a snapshot restore while the dialog exists).
    var bootDeviceEl = el.querySelector('#power-off-bootDevice');
    if (bootDeviceEl && typeof Config !== 'undefined' && Config.get) {
      bootDeviceEl.value = Config.get().bootDevice;
    }
    el.classList.add('visible');
  }

  var panelBootBtn = document.getElementById('panel-boot-btn');
  if (panelBootBtn) {
    panelBootBtn.addEventListener('click', function () {
      if (typeof panel !== 'undefined' && panel.powerSwitch < 0) {
        showPowerOffDialog();
        return;
      }
      // Bootstrap now! always starts the default bootstrap (unlike the generic
      // REBOOT button, which does so only when the auto-boot option is set).
      withRollbackOffer('boot', function () {
        doReboot(true);
        switchPage(consolePageFor(Config.get()));
      });
    });
  }

  // A Reboot / Bootstrap now! parked across the configuration-rollback reload
  // (see withRollbackOffer and src/snapshots.js offerConfigRollback): run it
  // now that the page is back with the viewer's own configuration.
  document.addEventListener('DOMContentLoaded', function () {
    var pending = null;
    try {
      pending = sessionStorage.getItem('yapdp.pending-reboot');
      sessionStorage.removeItem('yapdp.pending-reboot');
    } catch (e) { /* ignore */ }
    if (pending === 'boot') {
      doReboot(true);
      switchPage(consolePageFor(typeof Config !== 'undefined' ? Config.get() : null));
    } else if (pending === 'reboot') {
      doReboot();
    }
  });
})();
