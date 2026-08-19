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
        { device: "basic", label: "BASIC-11 V007A", boot: "boot pr",
            paperTape: "DEC-11-AJPB-PB",
            steps: [{ send: "", waitFor: "*O " }], autoLogin: false,
            hardware: { console: "teletype", printer: null, vt11: false } },
        { device: "odt11", label: "ODT-11X-V004A", boot: "boot pr",
            paperTape: "DEC-11-O2PA-PB", steps: [], autoLogin: false,
            hardware: { console: "teletype", printer: null, vt11: false } },
        { device: "ed11", label: "ED-11-V004B", boot: "boot pr",
            paperTape: "ED-11-V004B-8K", steps: [], autoLogin: false,
            hardware: { console: "teletype", printer: null, vt11: false } },
        // Lunar Lander draws the lander on the VT11 vector display, so the
        // wizard enables it and switches to the Display page after booting.
        { device: "lander", label: "Lunar Lander", boot: "boot pr",
            paperTape: "lander", page: "vt11", steps: [], autoLogin: false,
            hardware: { console: "teletype", printer: null, vt11: true } },

        // ---- Disk / tape images ---------------------------------------
        // Unix V5 — historically a Model 33 ASR teletype console.
        { device: "rk0", label: "Unix V5", boot: "boot rk0",
            steps: [{ send: "unix" }, { send: "root", waitFor: "login:" }],
            autoLogin: true,
            hardware: { console: "teletype", printer: null, vt11: false } },
        // RT-11 — teletype console and an LP11 line printer.
        { device: "rk1", label: "RT-11 v4.0", boot: "boot rk1",
            steps: [], autoLogin: false,
            hardware: { console: "teletype", printer: true, vt11: false } },
        // RT-11 variant with a VT52 terminal as the operator console — same
        // rk1.dsk image, different console profile (url/bootDev reuse the
        // underlying device so mounting and the boot command stay correct).
        { device: "rk1vt52", label: "RT-11 v4.0 (VT52 console)", boot: "boot rk1",
            bootDev: "rk1", url: "rk1.dsk", steps: [], autoLogin: false,
            hardware: { console: "vt52", printer: true, vt11: false } },
        // RSTS — LP11 line printer; console is the user's choice.
        { device: "rk2", label: "RSTS V06C-03", boot: "boot rk2",
            steps: [{ send: "11,70" }, { send: "PDP" }], autoLogin: true,
            hardware: { console: null, printer: true, vt11: false } },
        // XXDP — diagnostics, no special requirements.
        { device: "rk3", label: "XXDP (diagnostics)", boot: "boot rk3",
            steps: [], autoLogin: false,
            hardware: { console: null, printer: null, vt11: false } },
        // RT-11 3B Distribution — teletype console and an LP11 line printer.
        { device: "rk4", label: "RT-11 3B Distribution", boot: "boot rk4",
            steps: [], autoLogin: false,
            hardware: { console: "teletype", printer: true, vt11: false } },
        // RSTS 4B-17 rollin tape — LP11 printer; restore procedure is manual.
        { device: "tm0", label: "RSTS 4B-17 (tape)", boot: "boot tm0",
            steps: [], autoLogin: false,
            hardware: { console: null, printer: true, vt11: false } },
        // BSD 2.9 — historically a teletype console.
        { device: "rl0", label: "BSD 2.9", boot: "boot rl0",
            steps: [{ send: "rl(0,0)rlunix" }, { ctrlD: true },
                { send: "root", waitFor: "login:" }], autoLogin: true,
            hardware: { console: "teletype", printer: true, vt11: false } },
        // RSX-11M — LP11 line printer; console is the user's choice.
        { device: "rl1", label: "RSX-11M v3.2", boot: "boot rl1",
            steps: [{ send: "1,2" }, { send: "SYSTEM" }], autoLogin: true,
            hardware: { console: null, printer: true, vt11: false } },
        // RSTS/E v7.0 — LP11 line printer.
        { device: "rl2", label: "RSTS/E v7.0", boot: "boot rl2",
            steps: [{ send: "11,70" }, { send: "PDP" }], autoLogin: true,
            hardware: { console: null, printer: true, vt11: false } },
        // XXDP (extended) — diagnostics, no special requirements.
        { device: "rl3", label: "XXDP (extended)", boot: "boot rl3",
            steps: [], autoLogin: false,
            hardware: { console: null, printer: null, vt11: false } },
        // ULTRIX-11 — historically a teletype console.
        { device: "rp0", label: "ULTRIX-11 V3.1", boot: "boot rp0",
            steps: [{ ctrlD: true }, { send: "root", waitFor: "login:" }],
            autoLogin: true,
            hardware: { console: "teletype", printer: null, vt11: false } },
        // BSD 2.11 — historically a teletype console. The loader prints a lot
        // before "login:" and shows a countdown; an Enter interrupts it and the
        // login waits for the prompt instead of firing on a fixed timer.
        { device: "rp1", label: "BSD 2.11", boot: "boot rp1",
            steps: [{ send: "" }, { send: "root", waitFor: "login:" }],
            autoLogin: true,
            hardware: { console: "vt52", printer: true, vt11: false } },
        // RSTS/E v9.6 — LP11 line printer.
        { device: "rp2", label: "RSTS/E v9.6", boot: "boot rp2",
            steps: [], autoLogin: false,
            hardware: { console: null, printer: true, vt11: false } },
        // RSX-11M v4.6 — LP11 line printer.
        { device: "rp3", label: "RSX-11M v4.6", boot: "boot rp3",
            steps: [{ send: "1,2" }, { send: "SYSTEM" }], autoLogin: true,
            hardware: { console: "vt52", printer: true, vt11: false } },
        // RSTS/E v10.1 — LP11 line printer.
        { device: "rp4", label: "RSTS/E v10.1", boot: "boot rp4",
            steps: [], autoLogin: false,
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

    // Keep only scenarios whose image is mounted in DataLoader (used by the
    // desktop builds where images are pre-bundled; in the browser HTTP mode
    // the list is typically empty, so the wizard shows everything instead).
    function filterMounted(images) {
        var mounted = {};
        (images || []).forEach(function (url) { mounted[url] = true; });
        return BOOT_SCENARIOS.filter(function (s) {
            // Paper tapes are selected via the "#ptr" select, not mounted in
            // DataLoader, so they always stay available.
            if (s.paperTape) return true;
            return mounted[s.url || urlFor(s.device)];
        });
    }

    return {
        BOOT_SCENARIOS: BOOT_SCENARIOS,
        urlFor: urlFor,
        stringToBytes: stringToBytes,
        scenarioFor: scenarioFor,
        filterMounted: filterMounted
    };
})();
