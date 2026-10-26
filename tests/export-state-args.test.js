#!/usr/bin/env node
/**
 * export-state.js command-line guard.
 *
 * The tool grew `--mountmap drive=image` (repeatable) so a state can record
 * which image each drive held. A flag's VALUE is not a path: without an
 * explicit split, `export-state.js rk1 --mountmap rk4=rk5.dsk` took
 * "rk4=rk5.dsk" as the output file name and wrote the state there.
 *
 * Only the pure argument helpers are exercised — requiring the tool does not
 * boot a machine (the work lives behind require.main).
 *
 * Run with:  node tests/export-state-args.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");

const TOOL = path.join(__dirname, "..", "tools", "export-state.js");
const { parseMountMap, positionalArgs } = require(TOOL);

function run() {
    // ---- positionalArgs ------------------------------------------------
    assert.deepStrictEqual(positionalArgs(["rk1"]), ["rk1"],
        "a bare device stays positional");
    assert.deepStrictEqual(positionalArgs(["rk1", "states/rk1.state.zst"]),
        ["rk1", "states/rk1.state.zst"],
        "device and output path stay positional");
    assert.deepStrictEqual(positionalArgs(["rk1", "--mountmap", "rk4=rk5.dsk"]),
        ["rk1"],
        "the binding spec must never become the output path");
    assert.deepStrictEqual(
        positionalArgs(["rk1", "--mountmap", "rk4=rk5.dsk", "out.state.zst"]),
        ["rk1", "out.state.zst"],
        "an output path after the flag is still picked up");
    assert.deepStrictEqual(
        positionalArgs(["rk1", "--mountmap", "rk4=rk5.dsk", "--mountmap", "rl0=mybsd.dsk"]),
        ["rk1"],
        "repeated flags drop every spec");
    assert.deepStrictEqual(positionalArgs(["--verbose", "rk1"]), ["rk1"],
        "a bare flag is not positional");

    // ---- parseMountMap -------------------------------------------------
    assert.deepStrictEqual(plain(parseMountMap(["--mountmap", "rk4=rk5.dsk"])),
        { rk4: "rk5.dsk" }, "drive=image becomes one binding");
    assert.deepStrictEqual(
        plain(parseMountMap([
            "--mountmap", "rk4=rk5.dsk",
            "--mountmap", "rl0=mybsd.dsk"
        ])),
        { rk4: "rk5.dsk", rl0: "mybsd.dsk" },
        "the flag is repeatable");
    assert.deepStrictEqual(plain(parseMountMap(["--mountmap", "RK4=rk5.dsk"])),
        { rk4: "rk5.dsk" }, "the drive key is normalised to lower case");
    assert.deepStrictEqual(plain(parseMountMap([])), {},
        "no flag means no bindings");

    // Malformed specs are refused instead of silently dropped: a typo must
    // not produce a state that boots the default image.
    for (const bad of ["--mountmap", "--mountmap rk4", "--mountmap 4=rk5.dsk",
                       "--mountmap rk4=", "--mountmap =rk5.dsk"]) {
        assert.throws(() => parseMountMap(bad.split(" ")),
            /--mountmap expects drive=image/,
            "refused: " + bad);
    }

    console.log("export-state-args: all checks passed");
}

// The sandbox-free plain copy keeps deepStrictEqual prototype-stable.
function plain(obj) {
    return JSON.parse(JSON.stringify(obj));
}

try {
    run();
} catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
}
