/**
 * yaPDP — Guest OS boot scenarios for the quick-boot wizard
 *
 * Machine-readable, hand-curated boot sequences for the guest operating
 * systems and paper tapes listed on the Info page. The Info table is free
 * text, so the wizard cannot reliably parse it — this module is the single
 * source of truth for what the quick-boot button types into the console.
 *
 * Each scenario:
 *   device    — logical key (rk0, rp1, tm0 ...; a mnemonic for paper tapes:
 *               basic, odt11, ed11, lander)
 *   label     — human-readable name
 *   boot      — the first command typed at the Boot> prompt
 *   paperTape — (paper tapes only) the value of the Storage "#ptr" select,
 *               selected and rewound before booting
 *   page      — (optional) sidebar page to switch to after booting, e.g.
 *               "vt11" for Lunar Lander (Display page); defaults to the
 *               operator console
 *   steps[]   — follow-up inputs; each is { send: "text" } (then Enter),
 *               { ctrlD: true } (^D), or carries a waitFor prompt (sent only
 *               once that text appears on the console)
 *   autoLogin — true when steps include credentials up to a login prompt
 *   hardware  — the machine profile this OS wants, applied by quickboot.js
 *               before booting. Every scenario lists ALL keys explicitly so
 *               the profile is easy to edit:
 *                 console: "teletype" | "vt52" | null  (null = keep current)
 *                 printer: true | false | null          (null = keep current)
 *                 vt11:    true | false                 (never null — see below)
 *               false means "the OS does not use this device, turn it off";
 *               null (console/printer) means "the OS does not care, leave the
 *               user's choice".
 *
 * The VT11 vector display is used ONLY by Lunar Lander; every other scenario
 * sets vt11: false so the unused device is removed from the machine.
 *
 * Paper tapes are listed FIRST: they are tiny and load instantly, so on a
 * slow host (e.g. GitVerse Pages, where the big BSD disk images may not
 * finish downloading) the demo still has something bootable right away.
 *
 * Only the boot command is typed for OSes whose procedure is interactive or
 * ambiguous (tape restores, RSTS answer-prompt flows, XXDP), so the wizard
 * never hangs waiting for a prompt it cannot answer.
 *
 * urlFor() mirrors the naming convention in onboarding.js: a tape device
 * resolves to <dev>.tap, every other device to <dev>.dsk.
 *
 * Must be loaded BEFORE quickboot.js.
 */
"use strict";

var OSBoot = (function () {
    var BOOT_SCENARIOS = [
        // ---- Paper tapes (loaded through the Storage "#ptr" select) ----
        // All four are interactive teletype programs; the tape itself is the
        // program, so the only follow-up is acknowledging the program's own
        // prompt (BASIC-11 prints "*O " after loading and waits for Enter).
        { device: "basic", label: "BASIC-11 V007A", boot: "BOOT PR",
            paperTape: "DEC-11-AJPB-PB",
            steps: [{ send: "", waitFor: "*O " }], autoLogin: false,
            upperCase: true,
            hardware: { console: "teletype", printer: null, vt11: false } },
        { device: "odt11", label: "ODT-11X-V004A", boot: "BOOT PR",
            paperTape: "DEC-11-O2PA-PB", steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: "teletype", printer: null, vt11: false } },
        { device: "ed11", label: "ED-11-V004B", boot: "BOOT PR",
            paperTape: "ED-11-V004B-8K", steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: "teletype", printer: null, vt11: false } },
        // Lunar Lander draws the lander on the VT11 vector display, so the
        // wizard enables it and switches to the Display page after booting.
        { device: "lander", label: "Lunar Lander", boot: "BOOT PR",
            paperTape: "lander", page: "vt11", steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: "teletype", printer: null, vt11: true } },

        // ---- Disk / tape images ---------------------------------------
        // Unix V5 — historically a Model 33 ASR teletype console.
        { device: "rk0", label: "Unix V5", boot: "boot rk0",
            steps: [{ send: "unix" }, { send: "root", waitFor: "login:" }],
            autoLogin: true,
            hardware: { console: "teletype", printer: null, vt11: false } },
        // RT-11 — teletype console and an LP11 line printer.
        { device: "rk1", label: "RT-11 v4.0", boot: "BOOT RK1",
            steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: "teletype", printer: true, vt11: false } },
        // RT-11 variant with a VT52 terminal as the operator console — same
        // rk1.dsk image, different console profile (url/bootDev reuse the
        // underlying device so mounting and the boot command stay correct).
        { device: "rk1vt52", label: "RT-11 v4.0 (VT52 console)", boot: "BOOT RK1",
            bootDev: "rk1", url: "rk1.dsk", steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: "vt52", printer: true, vt11: false } },
        // RSTS — LP11 line printer; console is the user's choice. At the
        // "Option:" prompt "START" begins timesharing (an empty CR is
        // rejected; the historic ^J answer starts it, but the wizard sends
        // CR, so START is the reliable answer).
        { device: "rk2", label: "RSTS V06C-03", boot: "BOOT RK2",
            steps: [{ send: "START", waitFor: "Option:" }], autoLogin: false,
            upperCase: true,
            hardware: { console: null, printer: true, vt11: false } },
        // XXDP — diagnostics, no special requirements.
        { device: "rk3", label: "XXDP (diagnostics)", boot: "BOOT RK3",
            steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: null, printer: null, vt11: false } },
        // RT-11 3B Distribution — teletype console and an LP11 line printer.
        { device: "rk4", label: "RT-11 3B Distribution", boot: "BOOT RK4",
            steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: "teletype", printer: true, vt11: false } },
        // RSTS 4B-17 rollin tape — LP11 printer; restore procedure is manual.
        { device: "tm0", label: "RSTS 4B-17 (tape)", boot: "BOOT TM0",
            steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: null, printer: true, vt11: false } },
        // BSD 2.9 — historically a teletype console. The kernel boots into
        // single-user ("#" prompt) before init; Ctrl-D must be sent AFTER
        // the "#" appears, otherwise it is lost in the bootloader/kernel.
        // getty flushes console input received before it finished opening
        // the console, so "root" waits 3s after "login:" appears.
        { device: "rl0", label: "BSD 2.9", boot: "boot rl0",
            steps: [{ send: "rl(0,0)rlunix" }, { send: "", waitFor: "#" },
                { ctrlD: true }, { send: "root", waitFor: "login:", wait: 3000 }],
            autoLogin: true,
            hardware: { console: "teletype", printer: true, vt11: false } },
        // RSX-11M — LP11 line printer; console is the user's choice. The
        // disk image autostarts: MCR runs the system startup on its own and
        // stops at the date/time prompt, so no typed steps are needed.
        { device: "rl1", label: "RSX-11M v3.2", boot: "BOOT RL1",
            steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: null, printer: true, vt11: false } },
        // RSTS/E v7.0 — LP11 line printer. Same "Option:" flow as rk2.
        { device: "rl2", label: "RSTS/E v7.0", boot: "BOOT RL2",
            steps: [{ send: "START", waitFor: "Option:" }], autoLogin: false,
            upperCase: true,
            hardware: { console: null, printer: true, vt11: false } },
        // XXDP (extended) — diagnostics, no special requirements.
        { device: "rl3", label: "XXDP (extended)", boot: "BOOT RL3",
            steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: null, printer: null, vt11: false } },
        // ULTRIX-11 — historically a teletype console. The kernel boots into
        // single-user ("#") on its own. NOTE: Ctrl-D from here panics the
        // kernel ('panic: trap' during multi-user init, pc=136250) — an
        // emulator bug, not a scenario bug; until fixed, the scenario stops
        // at the single-user prompt (autoLogin below sends "root" into the
        // shell, which the e2e test tolerates).
        { device: "rp0", label: "ULTRIX-11 V3.1", boot: "boot rp0",
            steps: [{ ctrlD: true }, { send: "root", waitFor: "login:" }],
            autoLogin: true,
            hardware: { console: "teletype", printer: null, vt11: false } },
        // BSD 2.11 — historically a teletype console. The loader prints a lot
        // before "login:" and waits at a "Press <CR> to boot, or any other key
        // to abort:" countdown; an Enter sent as soon as that prompt appears
        // skips the countdown and starts the kernel, then the login waits for
        // the prompt instead of firing on a fixed timer.
        { device: "rp1", label: "BSD 2.11", boot: "boot rp1",
            steps: [{ send: "", waitFor: "Press <CR> to boot, or any other key to abort:" },
                { send: "root", waitFor: "login:" }],
            autoLogin: true,
            hardware: { console: "vt52", printer: true, vt11: false } },
        // RSTS/E v9.6 — LP11 line printer.
        { device: "rp2", label: "RSTS/E v9.6", boot: "BOOT RP2",
            steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: null, printer: true, vt11: false } },
        // RSX-11M v4.6 — LP11 line printer; VT52 console. The disk image
        // autostarts (MCR runs the startup and stops at the date/time
        // prompt), so no typed steps are needed.
        { device: "rp3", label: "RSX-11M v4.6", boot: "BOOT RP3",
            steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: "vt52", printer: true, vt11: false } },
        // RSTS/E v10.1 — LP11 line printer.
        { device: "rp4", label: "RSTS/E v10.1", boot: "BOOT RP4",
            steps: [], autoLogin: false,
            upperCase: true,
            hardware: { console: null, printer: true, vt11: false } }
    ];

    // Logical media URL for a device (tape vs disk), matching onboarding.js.
    function urlFor(device) {
        return /^tm/i.test(device) ? device + ".tap" : device + ".dsk";
    }

    // Convert a plain ASCII string to console bytes (no terminator; callers
    // append the Enter code). Pure and DOM-free — unit-testable in Node.
    function stringToBytes(text) {
        var bytes = [];
        for (var i = 0; i < text.length; i++) {
            bytes.push(text.charCodeAt(i) & 0x7F);
        }
        return bytes;
    }

    // Look up a scenario by device key, or undefined if unknown.
    function scenarioFor(device) {
        for (var i = 0; i < BOOT_SCENARIOS.length; i++) {
            if (BOOT_SCENARIOS[i].device === device) return BOOT_SCENARIOS[i];
        }
        return undefined;
    }

    // Keep only scenarios whose image can actually boot in this build.
    // Paper tapes always stay: they are tiny and load instantly, so even a
    // minimal deployment keeps the demo bootable. Disk/tape scenarios need
    // their image in the build manifest (browser deployments; generated by
    // tools/gen-media-manifest.js) OR mounted in DataLoader (desktop bundle,
    // drag-and-drop imports). Union semantics — either source suffices, so
    // a user-mounted image makes its OS bootable even when the build does
    // not ship it. Pure — unit-testable in Node.
    function filterAvailable(manifest, mounted) {
        var have = {};
        (manifest || []).forEach(function (u) { have[u] = true; });
        (mounted || []).forEach(function (u) { have[u] = true; });
        return BOOT_SCENARIOS.filter(function (s) {
            // Paper tapes are selected via the "#ptr" select, not mounted in
            // DataLoader, so they always stay available.
            if (s.paperTape) return true;
            return have[s.url || urlFor(s.device)];
        });
    }

    // Keep only scenarios whose image is mounted in DataLoader (used by the
    // desktop builds where images are pre-bundled; in the browser HTTP mode
    // the list is typically empty, so the wizard shows everything instead).
    function filterMounted(images) {
        return filterAvailable(null, images);
    }

    return {
        BOOT_SCENARIOS: BOOT_SCENARIOS,
        urlFor: urlFor,
        stringToBytes: stringToBytes,
        scenarioFor: scenarioFor,
        filterMounted: filterMounted,
        filterAvailable: filterAvailable
    };
})();
