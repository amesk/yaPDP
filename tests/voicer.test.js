#!/usr/bin/env node
/**
 * yaPDP — voicer.js pure-helper tests.
 *
 * tools/voicer.js writes the narration WAV through one of two engines:
 * Kokoro-82M (kokoro-js) or Windows SAPI, with "auto" trying Kokoro first and
 * falling back to SAPI. The real synthesis needs the model / OS voices and is
 * exercised by hand; this test pins the PURE pieces that drive it so the
 * mechanics cannot silently drift:
 *   1. parseArgs() maps the CLI flags onto the option defaults (and ignores
 *      the removed browser/capture flags: --device, --force-sapi, --rate,
 *      --pitch, --volume).
 *   2. cultureIdFor() maps a language tag to a Windows LCID.
 *   3. buildSapiScript() emits a well-formed PowerShell System.Speech script
 *      (rate/volume clamp, optional voice, en-US culture hint, single-quote
 *      escaping, UTF-8 stdin read).
 *   4. engine selection pins the two engines (kokoro/sapi) plus the "auto"
 *      default, rejects the removed "browser" engine, and resolves the Kokoro
 *      config defaults.
 *
 * Run with:  node tests/voicer.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const path = require("path");
const voicer = require(path.join(__dirname, "..", "tools", "voicer.js"));

const { parseArgs, cultureIdFor, escPS, buildSapiScript, DEFAULTS,
    ENGINES, KOKORO_MODEL_ID, KOKORO_DTYPE, KOKORO_DEFAULT_VOICE,
    normaliseEngine, kokoroConfig } = voicer;

// --- 1. parseArgs ----------------------------------------------------------

assert.strictEqual(DEFAULTS.lang, "en-US", "default language must be en-US");
assert.strictEqual(DEFAULTS.engine, "auto",
    "the default engine must be auto (Kokoro -> SAPI fallback)");

const noArgs = parseArgs([]);
assert.strictEqual(noArgs.help, false);
assert.strictEqual(noArgs.text, DEFAULTS.text, "no --text keeps the greeting");
assert.ok(!("file" in noArgs), "--file must not be present when not given");

const full = parseArgs([
    "--text", "Hello world",
    "--out", "demo.wav",
    "--lang", "ru-RU",
    "--voice", "Microsoft Irina Desktop",
    "--sapi-rate", "-3",
    "--sapi-volume", "80"
]);
assert.strictEqual(full.text, "Hello world");
assert.strictEqual(full.out, "demo.wav");
assert.strictEqual(full.lang, "ru-RU");
assert.strictEqual(full.voice, "Microsoft Irina Desktop");
assert.strictEqual(full.sapiRate, -3);
assert.strictEqual(full.sapiVolume, 80);

assert.strictEqual(parseArgs(["--help"]).help, true);
assert.strictEqual(parseArgs(["-h"]).help, true);

const fileOnly = parseArgs(["--file", "script.txt"]);
assert.strictEqual(fileOnly.file, "script.txt");
assert.strictEqual(fileOnly.text, DEFAULTS.text,
    "text default must stay when only --file is given");

// The browser/capture-device path was removed — its flags must no longer
// surface on the parsed options or change the effective engine.
const legacy = parseArgs(["--device", "CABLE Input", "--force-sapi",
    "--rate", "1.2", "--pitch", "0.5", "--volume", "0.8"]);
assert.ok(!("device" in legacy), "the removed --device flag must be ignored");
assert.ok(!("forceSapi" in legacy),
    "the removed --force-sapi flag must be ignored");
assert.ok(!("rate" in legacy), "the removed --rate flag must be ignored");
assert.ok(!("pitch" in legacy), "the removed --pitch flag must be ignored");
assert.ok(!("volume" in legacy), "the removed --volume flag must be ignored");
assert.strictEqual(legacy.engine, "auto",
    "browser-only flags must not change the default engine");

// --- 2. cultureIdFor / escPS -----------------------------------------------

assert.strictEqual(cultureIdFor("en-US"), 0x0409);
assert.strictEqual(cultureIdFor("en-us"), 0x0409);
assert.strictEqual(cultureIdFor("ru-RU"), 0x0419);
assert.strictEqual(cultureIdFor("fr-FR"), null,
    "an unknown language must map to null (default voice)");
assert.strictEqual(cultureIdFor(null), null);

assert.strictEqual(escPS("O'Brien"), "O''Brien",
    "single quotes must be doubled inside a PowerShell string");

// --- 3. buildSapiScript ----------------------------------------------------

const OUT = "C:\\tmp\\voice-out.wav";
const script = buildSapiScript({ outPath: OUT, lang: "en-US",
    sapiRate: -1, sapiVolume: 100 });

assert.ok(script.includes("Add-Type -AssemblyName System.Speech;"),
    "the script must load System.Speech");
assert.ok(script.includes("$synth.Rate = -1;"), "SAPI rate must be applied");
assert.ok(script.includes("$synth.Volume = 100;"), "SAPI volume must be applied");
assert.ok(script.includes("SelectVoiceByHints"),
    "the en-US hint must select a voice by culture");
assert.ok(script.includes("0x409"), "en-US must map to LCID 0x409");
assert.ok(script.includes("SetOutputToWaveFile('C:\\tmp\\voice-out.wav');"),
    "the output path must be embedded in a single-quoted PowerShell string");
assert.ok(script.includes("[Console]::InputEncoding = [System.Text.Encoding]::UTF8;"),
    "the piped text must be read as UTF-8");
assert.ok(script.includes("$synth.Speak($text);"),
    "the script must speak the stdin text");

// Rate/volume clamp and explicit-voice branch.
const clamped = buildSapiScript({ outPath: "x.wav", lang: "xx-XX",
    sapiRate: 99, sapiVolume: 500, voice: "A'n Voice" });
assert.ok(clamped.includes("$synth.Rate = 99;"), "SAPI rate may exceed -10..10");
assert.ok(clamped.includes("$synth.Volume = 100;"),
    "SAPI volume must be clamped to 100");
assert.ok(clamped.includes("$synth.SelectVoice('A''n Voice');"),
    "an explicit voice must be selected and escaped");
assert.ok(!clamped.includes("SelectVoiceByHints"),
    "no culture hint when a voice is given explicitly");

// Escaping the output path with a single quote must not break the script.
const quoted = buildSapiScript({ outPath: "C:\\tmp\\o'brien.wav", lang: "en-US" });
assert.ok(quoted.includes("SetOutputToWaveFile('C:\\tmp\\o''brien.wav');"),
    "the output path must be single-quote escaped");

// --- 4. engine selection / kokoro config -----------------------------------

assert.ok(ENGINES.includes("auto"), "auto engine must exist (Kokoro->SAPI)");
assert.ok(ENGINES.includes("kokoro"), "kokoro engine must exist");
assert.ok(ENGINES.includes("sapi"), "sapi engine must exist");
assert.ok(!ENGINES.includes("browser"),
    "the browser loopback capture engine must be gone");

// --engine parsing.
assert.strictEqual(parseArgs(["--engine", "kokoro"]).engine, "kokoro");
assert.strictEqual(parseArgs(["--engine", "sapi"]).engine, "sapi");
assert.strictEqual(parseArgs(["--engine", "auto"]).engine, "auto");

// normaliseEngine: lowercases, tolerates defaults, rejects unknowns —
// including the removed "browser" engine.
assert.strictEqual(normaliseEngine("KOKORO"), "kokoro",
    "engine names must be case-insensitive");
assert.strictEqual(normaliseEngine("SAPI"), "sapi",
    "engine names must be case-insensitive");
assert.strictEqual(normaliseEngine(undefined), "auto");
assert.strictEqual(normaliseEngine(null), "auto");
assert.throws(() => normaliseEngine("browser"),
    "the removed browser engine must be rejected");
assert.throws(() => normaliseEngine("acapela"),
    "an unknown engine must be rejected");

// kokoroConfig defaults: US Michael voice, CPU, q8, official ONNX repo and a
// local cache dir — all pinned so a CI checkout reuses the cached model.
const cfg = kokoroConfig({});
assert.strictEqual(cfg.modelId, KOKORO_MODEL_ID);
assert.strictEqual(cfg.modelId, "onnx-community/Kokoro-82M-v1.0-ONNX");
assert.strictEqual(cfg.dtype, KOKORO_DTYPE);
assert.strictEqual(cfg.dtype, "q8", "quantized q8 weights must be the default");
assert.strictEqual(cfg.device, "cpu", "Node synthesis must run on the CPU");
assert.strictEqual(cfg.voice, KOKORO_DEFAULT_VOICE);
assert.strictEqual(cfg.voice, "am_michael",
    "the default Kokoro voice must be US Michael (am_michael)");
assert.ok(cfg.cacheDir.endsWith(path.join("PDP11", ".cache", "kokoro")) ||
    cfg.cacheDir.includes(".cache") && cfg.cacheDir.includes("kokoro"),
    "the model cache must live in the repo .cache/kokoro");
// An explicit --voice must override the Kokoro default.
assert.strictEqual(kokoroConfig({ voice: "af_heart" }).voice, "af_heart");

console.log("All voicer pure-helper tests passed.");
