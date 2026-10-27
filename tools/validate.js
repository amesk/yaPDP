#!/usr/bin/env node
/**
 * yaPDP — the single entry point that runs every e2e suite, ONE AT A TIME
 * against a single shared static server.
 *
 * Usage:
 *   node tools/validate.js                  run every suite (this is `npm run validate`)
 *   node tools/validate.js e2e:os           run the suites matching the given names
 *                                           (exact suite name wins, otherwise a substring;
 *                                           any number of filters is allowed) — this is what
 *                                           every `npm run e2e:*` alias drives, so a single
 *                                           suite and the full run can never disagree
 *   node tools/validate.js --list           print the suite names in run order and exit
 *
 * Both the local `npm run validate` and the CI e2e job drive this file, so the
 * two can never drift apart: there is ONE list of suites (SUITES below), and
 * both run exactly it. (They used to be two hand-maintained lists — the wireit
 * e2e:* tasks and a run of CI steps — and they had already diverged, so each
 * side skipped suites the other ran.)
 *
 * Why not let wireit run the suites as separate tasks (which is how this began):
 * wireit runs independent scripts in PARALLEL by default (WIREIT_PARALLEL =
 * os.cpus().length * 2), but every browser suite binds the SAME static-server
 * port (1170, tools/serve.js) and calls ensureServer() on startup / server.kill()
 * on exit. In parallel the first to bind wins, the losers' serve.js processes
 * die with EADDRINUSE (spawned with stdio:"ignore", so invisibly), and the
 * moment the winner finishes it kills the server the others are still using —
 * leaving a suite to fail halfway through with "net::ERR_CONNECTION_REFUSED".
 * CI never had that: it starts ONE server and runs each suite as a sequential
 * step. This file is that model, shared.
 *
 * The suites keep their own ensureServer(), so each still runs standalone and
 * simply REUSES the server started here (ensureServer() returns null when the
 * port already answers, and then the suite does not kill it).
 *
 * Nothing is lost by driving the suites from here instead of as wireit tasks:
 * they declare no wireit `output`, and wireit only caches tasks that do.
 */
"use strict";

const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PORT = 1170;
const BASE = `http://127.0.0.1:${PORT}`;
const ON_CI = process.env.GITHUB_ACTIONS === "true";

// The e2e suites, in the order they run. `name` is the label wireit uses for
// the matching e2e:* task (a suite may have NO wireit task — several do not);
// `argv` is what follows the node binary.
//
// ADD A SUITE HERE AND IT RUNS EVERYWHERE: here and in CI. Do not add a step to
// .github/workflows/ci.yml for it — that step just calls this file.
const SUITES = [
    ["e2e:quickboot-manifest", ["tests/e2e-quickboot-manifest.js"]],
    ["e2e:quickboot-deeplink", ["tests/e2e-quickboot-deeplink.js"]],
    ["e2e:quickboot-scenario", ["tests/e2e-quickboot-scenario.js"]],
    ["e2e:snapshots",          ["tests/e2e-snapshots.js"]],
    ["e2e:startup-cls",        ["tests/e2e-startup-cls.js"]],
    ["e2e:os",                 ["tests/e2e-osboot.js"]],
    ["e2e:os:legacy",          ["tests/e2e-osboot.js", "--legacy"]],
    ["e2e:teletype",           ["tests/e2e-teletype.js"]],
    ["e2e:teletype-tape",      ["tests/e2e-teletype-tape.js"]],
    ["e2e:bsd",                ["tests/e2e-bsd-boot.js"]],
    ["e2e:bsd29",              ["tests/e2e-bsd29-boot.js"]],
    ["e2e:xxdp",               ["tests/e2e-xxdp-ekbbf0.js"]],
    ["e2e:xxdp:kfp",           ["tests/e2e-xxdp-kfp.js"]],
    // Idle monitor = WAIT (not a stop); a halted diagnostic = fast verdict.
    ["e2e:xxdp:halt",          ["tests/e2e-xxdp-halt-notice.js"]],
    ["e2e:panel",              ["tests/e2e-panel-lamps.js"]],
    ["e2e:snapshot-image",     ["tests/e2e-snapshot-image-changed.js"]],
    ["e2e:state",              ["tests/e2e-state-deeplink.js"]],
    ["e2e:vt100",              ["tests/e2e-vt100.js"]],
    ["e2e:mobile",             ["tests/e2e-mobile-input.js"]],
    ["e2e:share",              ["tests/e2e-share.js"]],
    ["e2e:import-export",      ["tests/e2e-import-export.js"]],
    ["e2e:state:disk-access",  ["tests/e2e-state-disk-access.js"]],
    ["e2e:unmount",            ["tests/e2e-unmount-reboot.js"]],
    ["e2e:firstrun-deeplink",  ["tests/e2e-firstrun-deeplink.js"]],
    ["e2e:quickboot-take-control", ["tests/e2e-quickboot-take-control.js"]],
    ["e2e:diskstore",          ["tests/e2e-diskstore.js"]],
];

function serverAlive() {
    return new Promise((resolve) => {
        const req = http.get(`${BASE}/pdp11.html`, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
}

// Start the repo's static server unless the port already answers; return the
// child (so the caller can stop it) or null when one was already up.
async function ensureServer() {
    if (await serverAlive()) return null;
    const child = spawn(process.execPath, [
        path.join(ROOT, "tools", "serve.js"),
        "--port", String(PORT)
    ], { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        if (await serverAlive()) return child;
        await new Promise((r) => setTimeout(r, 200));
    }
    child.kill();
    throw new Error(`Static server did not start on port ${PORT}`);
}

// Resolve the filters from the command line to suites. An exact suite name
// wins over a substring, so "e2e:xxdp" means that suite and not the kfp/halt
// ones; no filters means the whole set.
function selectSuites(filters) {
    if (!filters.length) return { selected: SUITES, missing: [] };
    const selected = [];
    const missing = [];
    for (const filter of filters) {
        const exact = SUITES.filter(([name]) => name === filter);
        const hits = exact.length
            ? exact
            : SUITES.filter(([name]) => name.includes(filter));
        if (!hits.length) missing.push(filter);
        for (const suite of hits) {
            if (!selected.includes(suite)) selected.push(suite);
        }
    }
    return { selected, missing };
}

async function main(suites) {
    const server = await ensureServer();
    const failed = [];
    try {
        for (const [name, argv] of suites) {
            // GitHub Actions log folding, so one step still reads as N suites.
            if (ON_CI) console.log(`::group::${name}`);
            else console.log(`\n──── ${name} ────`);
            const r = spawnSync(process.execPath, argv, {
                cwd: ROOT,
                stdio: "inherit"
            });
            if (ON_CI) console.log("::endgroup::");
            if (r.status === 0) continue;
            failed.push(name);
            if (r.signal) console.error(`❌ ${name}: killed by ${r.signal}`);
            else console.error(`❌ ${name}: exit code ${r.status}`);
        }
    } finally {
        // Only stop a server WE started; one that was already up is not ours.
        if (server) server.kill();
    }

    if (failed.length) {
        console.error(`\n❌ ${failed.length} suite(s) failed: ${failed.join(", ")}`);
        process.exit(1);
    }
    console.log(`\nvalidate: all ${suites.length} e2e suite(s) passed`);
}

module.exports = { SUITES, selectSuites, ensureServer, serverAlive };

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes("--list")) {
        SUITES.forEach(([name]) => console.log(name));
        process.exit(0);
    }
    const filters = args.filter((a) => !a.startsWith("-"));
    const { selected, missing } = selectSuites(filters);
    if (missing.length) {
        console.error(`No suite matches: ${missing.join(", ")}`);
        console.error("Known suites: node tools/validate.js --list");
        process.exit(1);
    }
    main(selected).catch((err) => {
        console.error(err && err.stack ? err.stack : err);
        process.exit(1);
    });
}
