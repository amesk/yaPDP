#!/usr/bin/env node
/**
 * e2e suite registry guard.
 *
 * The e2e suites have exactly one source of truth: the `SUITES` array in
 * tools/validate.js — both `npm run validate` and the CI e2e job drive that
 * file, so a suite added there runs everywhere. What used to drift is the
 * per-suite npm alias: `npm run e2e:xxx` was a third hand-maintained list, so
 * `npm run e2e:teletype` was simply "Missing script", while `e2e:unmount`
 * existed as an alias but was never in `SUITES` — runnable alone, invisible to
 * `validate` and to CI.
 *
 * Every alias now delegates to validate.js by suite name, which makes the
 * wiring checkable. This guard fails when:
 *
 *   1. a suite name is duplicated in SUITES;
 *   2. a suite points at an e2e file that does not exist (renamed/moved);
 *   3. a suite has no npm script, or its wireit task does not delegate to
 *      `node tools/validate.js <name>` (so the alias runs a single suite);
 *   4. an `e2e:*` npm script or wireit task names a suite that is not in
 *      SUITES (renamed or removed suite — the alias would run nothing);
 *   5. a tests/e2e-*.js file is not reachable from SUITES (CI never runs it).
 *
 * Run with:  node tests/validate-suites.test.js
 *
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const TESTS = path.join(ROOT, "tests");
const pkg = require("../package.json");
const { SUITES, selectSuites } = require("../tools/validate.js");

// Shared drivers, not suites: they print a reminder and exit 0 when run alone.
const NOT_SUITES = new Set(["e2e-teletype-harness.js"]);

function suiteNames() {
    return SUITES.map(([name]) => name);
}

function namesOf(suites) {
    return suites.map(([name]) => name);
}

function e2eFiles() {
    return fs.readdirSync(TESTS)
        .filter((f) => f.startsWith("e2e-") && f.endsWith(".js"))
        .filter((f) => !NOT_SUITES.has(f))
        .sort();
}

function run() {
    const names = suiteNames();

    // 1. One suite, one name.
    assert.strictEqual(
        new Set(names).size, names.length,
        "duplicate suite name in SUITES"
    );

    // 2. The suite runs a file that exists.
    for (const [name, argv] of SUITES) {
        assert.ok(Array.isArray(argv) && argv.length > 0,
            `${name}: empty argv`);
        assert.ok(fs.existsSync(path.join(ROOT, argv[0])),
            `${name}: ${argv[0]} does not exist`);
    }

    // 3. `npm run <name>` exists and runs exactly that suite.
    for (const name of names) {
        assert.ok(pkg.scripts[name],
            `npm script "${name}" is missing — the suite cannot be run alone`);
        const task = pkg.wireit && pkg.wireit[name];
        assert.ok(task, `wireit task "${name}" is missing`);
        assert.strictEqual(
            task.command, `node tools/validate.js ${name}`,
            `${name}: the wireit command must delegate to ` +
            `"node tools/validate.js ${name}" so the alias and validate ` +
            "run the same definition"
        );
    }

    // 4. No alias points at a suite that is gone.
    for (const key of Object.keys(pkg.scripts)) {
        if (!key.startsWith("e2e:")) continue;
        assert.ok(names.includes(key),
            `npm script "${key}" is not in SUITES of tools/validate.js — ` +
            "it never runs under validate or CI");
    }
    for (const key of Object.keys(pkg.wireit || {})) {
        if (!key.startsWith("e2e:")) continue;
        assert.ok(names.includes(key),
            `wireit task "${key}" is not in SUITES of tools/validate.js`);
    }

    // 5. No suite file left behind, and no suite listed twice for one file
    //    (osboot is the exception: --legacy is a second, distinct suite).
    const covered = new Set(SUITES.map(([, argv]) => path.basename(argv[0])));
    for (const file of e2eFiles()) {
        assert.ok(covered.has(file),
            `tests/${file} is not in SUITES of tools/validate.js — ` +
            "validate and CI never run it");
    }

    // 6. The command-line selection `npm run e2e:*` relies on: an exact name
    //    wins (e2e:xxdp must not drag in kfp/halt), a substring widens, an
    //    unknown filter is an error rather than "run everything".
    assert.deepStrictEqual(namesOf(selectSuites([]).selected), names,
        "no filters must mean the whole set, in run order");
    assert.deepStrictEqual(namesOf(selectSuites(["e2e:xxdp"]).selected),
        ["e2e:xxdp"],
        "an exact suite name must select that suite only");
    assert.deepStrictEqual(namesOf(selectSuites(["teletype"]).selected),
        ["e2e:teletype", "e2e:teletype-tape"],
        "a substring must select every suite whose name contains it");
    assert.deepStrictEqual(selectSuites(["no-such-suite"]).missing,
        ["no-such-suite"],
        "an unknown filter must be reported");
}

run();
console.log(`validate-suites: ${SUITES.length} e2e suite(s) wired consistently`);
