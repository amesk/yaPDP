#!/usr/bin/env node
/**
 * yaPDP — voicer.js pure-helper tests.
 *
 * tools/record-video.js cannot capture Chrome's speechSynthesis (it is not
 * routed into WebRTC tab capture) and CDP screencast is video-only, so
 * voicer.js records TTS by loopback-capturing the browser audio output
 * (ffmpeg DirectShow) with a Windows SAPI fallback. Those paths need real
 * hardware/voices and are exercised by hand; this test pins the PURE pieces
 * that drive them so the mechanics cannot silently drift:
 *   1. parseArgs() maps the CLI flags onto the option defaults.
 *   2. parseDshowDevices() splits `ffmpeg -list_devices` output into the audio
 *      and video device lists.
 *   3. findLoopbackDevice() picks a real loopback capture endpoint (Stereo
 *      Mix / VB-Cable) over the plain microphone.
 *   4. buildSapiScript() emits a well-formed PowerShell System.Speech script
 *      (rate/volume clamp, optional voice, en-US culture hint, single-quote
 *      escaping, UTF-8 stdin read).
 *
 * Run with:  node tests/voicer.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const path = require("path");
const voicer = require(path.join(__dirname, "..", "tools", "voicer.js"));

const { parseArgs, parseDshowDevices, findLoopbackDevice,
    cultureIdFor, escPS, buildSapiScript, DEFAULTS } = voicer;

// --- 1. parseArgs ----------------------------------------------------------

assert.strictEqual(DEFAULTS.rate, 0.95, "default browser rate must be 0.95");
assert.strictEqual(DEFAULTS.pitch, 0.7, "default browser pitch must be 0.7");
assert.strictEqual(DEFAULTS.lang, "en-US", "default language must be en-US");

const noArgs = parseArgs([]);
assert.strictEqual(noArgs.help, false);
assert.strictEqual(noArgs.text, DEFAULTS.text, "no --text keeps the greeting");
assert.strictEqual(noArgs.forceSapi, false);
assert.ok(!("file" in noArgs), "--file must not be present when not given");

const full = parseArgs([
    "--text", "Hello world",
    "--out", "demo.wav",
    "--lang", "ru-RU",
    "--rate", "1.2",
    "--pitch", "0.5",
    "--volume", "0.8",
    "--voice", "Microsoft Irina Desktop",
    "--sapi-rate", "-3",
    "--sapi-volume", "80",
    "--device", "CABLE Input",
    "--force-sapi"
]);
assert.strictEqual(full.text, "Hello world");
assert.strictEqual(full.out, "demo.wav");
assert.strictEqual(full.lang, "ru-RU");
assert.strictEqual(full.rate, 1.2);
assert.strictEqual(full.pitch, 0.5);
assert.strictEqual(full.volume, 0.8);
assert.strictEqual(full.voice, "Microsoft Irina Desktop");
assert.strictEqual(full.sapiRate, -3);
assert.strictEqual(full.sapiVolume, 80);
assert.strictEqual(full.device, "CABLE Input");
assert.strictEqual(full.forceSapi, true, "--force-sapi must be parsed");

assert.strictEqual(parseArgs(["--help"]).help, true);
assert.strictEqual(parseArgs(["-h"]).help, true);

const fileOnly = parseArgs(["--file", "script.txt"]);
assert.strictEqual(fileOnly.file, "script.txt");
assert.strictEqual(fileOnly.text, DEFAULTS.text,
    "text default must stay when only --file is given");

// --- 2. parseDshowDevices --------------------------------------------------

const FFMPEG_DEVICE_OUTPUT = [
    "[dshow @ 000001] DirectShow video devices (some may be both video and audio devices)",
    '[dshow @ 000001]  "OBS Virtual Camera"',
    "[dshow @ 000001] DirectShow audio devices (some may be both video and audio devices)",
    '[dshow @ 000001]  "Microphone (Realtek High Definition Audio)"',
    '[dshow @ 000001]  "Stereo Mix (Realtek High Definition Audio)"',
    '[dshow @ 000001]  "CABLE Input (VB-Audio Virtual Cable)"',
    "[dshow @ 000001] Could not enumerate video devices (or none associated with this device)."
].join("\r\n");

const devices = parseDshowDevices(FFMPEG_DEVICE_OUTPUT);
assert.ok(Array.isArray(devices.audio), "audio list must be an array");
assert.deepStrictEqual(devices.video, ["OBS Virtual Camera"],
    "video section must list only video devices");
assert.ok(devices.audio.includes("Microphone (Realtek High Definition Audio)"),
    "audio section must include the microphone");
assert.ok(devices.audio.includes("Stereo Mix (Realtek High Definition Audio)"),
    "audio section must include Stereo Mix");
assert.ok(devices.audio.includes("CABLE Input (VB-Audio Virtual Cable)"),
    "audio section must include the VB-Cable input");

assert.deepStrictEqual(parseDshowDevices("").audio, [],
    "empty output must yield no devices");

// --- 3. findLoopbackDevice -------------------------------------------------

assert.strictEqual(
    findLoopbackDevice(["Microphone (Realtek)", "Stereo Mix (Realtek)"]),
    "Stereo Mix (Realtek)",
    "Stereo Mix must be preferred over the microphone");
assert.strictEqual(
    findLoopbackDevice(["CABLE Input (VB-Audio Virtual Cable)"]),
    "CABLE Input (VB-Audio Virtual Cable)",
    "VB-Cable input must be detected");
assert.strictEqual(
    findLoopbackDevice(["Microphone (Realtek)"]),
    null,
    "a plain microphone must NOT be treated as a loopback device");
assert.strictEqual(
    findLoopbackDevice(["Stereo Mix (Realtek)", "CABLE Input (VB-Audio)"]),
    "CABLE Input (VB-Audio)",
    "VB-Cable must win over Stereo Mix when both exist");
assert.strictEqual(
    findLoopbackDevice(["Loopback Audio (Virtual)"]),
    "Loopback Audio (Virtual)",
    "a generic 'Loopback' device must be detected");

// --- 4. cultureIdFor / escPS -----------------------------------------------

assert.strictEqual(cultureIdFor("en-US"), 0x0409);
assert.strictEqual(cultureIdFor("en-us"), 0x0409);
assert.strictEqual(cultureIdFor("ru-RU"), 0x0419);
assert.strictEqual(cultureIdFor("fr-FR"), null,
    "an unknown language must map to null (default voice)");
assert.strictEqual(cultureIdFor(null), null);

assert.strictEqual(escPS("O'Brien"), "O''Brien",
    "single quotes must be doubled inside a PowerShell string");

// --- 5. buildSapiScript ----------------------------------------------------

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

// --- 6. buildVoiceHtml -----------------------------------------------------

// The browser TTS page must be generated in-memory — there is no external
// voice.html fixture anymore. It carries the #speakBtn + VOICE_OPTS /
// __voiceEnded contract and must stay a STATIC template (no ${} interpolation,
// so arbitrary text can never inject markup into the page).
assert.strictEqual(typeof voicer.buildVoiceHtml, "function",
    "buildVoiceHtml must be exported");
const pageHtml = voicer.buildVoiceHtml();
for (const needle of ["id=\"speakBtn\"", "VOICE_OPTS", "__voiceEnded",
    "speechSynthesis.speak"]) {
    assert.ok(pageHtml.includes(needle),
        "generated TTS page must contain " + needle);
}
assert.ok(!pageHtml.includes("${"),
    "the page must be a static template (no interpolation)");

console.log("All voicer pure-helper tests passed.");
