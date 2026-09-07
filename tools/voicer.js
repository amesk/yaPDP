#!/usr/bin/env node
/**
 * yaPDP — TTS voice recorder.
 *
 * Writes a spoken version of a piece of text to a WAV file, so the demo-reel
 * pipeline (tools/assemble-video.js) can mix a "computer voice" narration over
 * the clips later.
 *
 * The engine is chosen with --engine (default "auto"):
 *   kokoro  — Kokoro-82M, an open neural TTS model, run locally through the
 *             kokoro-js package (Transformers.js + onnxruntime-node on CPU).
 *             Sounds far more natural than the OS voices; no browser, no
 *             loopback capture device and no network voice dependency. The
 *             model (one quantized .onnx, ~86 MB) is downloaded from Hugging
 *             Face into .cache/kokoro on first use, then reused. Voices are
 *             shipped inside the kokoro-js package, so only the chosen one is
 *             read (default: am_michael, US Michael).
 *   auto    — browser loopback (Windows DirectShow) then Windows SAPI.
 *   browser — only the browser Web Speech API loopback capture.
 *   sapi    — only Windows SAPI.
 * The browser/SAPI paths use the OS "ancient computer" effect (pitch/rate).
 *
 * Browser loopback details (the "auto" primary): a headed Chrome renders a
 * generated in-memory page and speaks the text through the Web Speech API;
 * ffmpeg records the browser's audio output from a loopback capture device
 * (Stereo Mix / VB-Cable / ...) into raw PCM and wraps it into a WAV. Windows
 * SAPI is the fallback: a PowerShell System.Speech synthesizer writes the WAV
 * directly — no browser or capture device needed.
 *
 * Why not the old CDP approach: Media.startScreencast yields VIDEO frames and
 * Chrome's speechSynthesis is not routed into WebRTC tab capture, so neither
 * CDP screencast nor puppeteer-stream can hear it. The audio has to be caught
 * at the system output (loopback) or generated outside the browser (SAPI).
 *
 * Usage (mingw bash):
 *   node voicer.js --text "Hello, I'm yaPDP" --out voice-out.wav
 *   node voicer.js --file script.txt --out voice-out.wav --device "CABLE Input"
 *   node voicer.js --text "Hello" --out voice-out.wav --force-sapi
 *   node voicer.js --text "Hello" --out voice-out.wav --engine kokoro
 *
 * The module exports its pure helpers for unit tests (tests/voicer.test.js);
 * the CLI runs only when the file is executed directly.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

// --- Engine selection -------------------------------------------------------
// Voice engines. "auto" keeps the historical behaviour (browser loopback,
// then Windows SAPI). "kokoro" is the local neural TTS (kokoro-js) and is the
// recommended choice for natural narration.
const ENGINES = ["auto", "browser", "sapi", "kokoro"];

// Kokoro-82M, the official ONNX repo consumed by kokoro-js (Transformers.js).
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
// Quantized weights: tiny enough for a CPU synth while staying natural.
const KOKORO_DTYPE = "q8";
// Default voice = US Michael ("am" = American English, male). The user asked
// for exactly this voice; every voice ships inside the kokoro-js package, so
// no per-voice download happens.
const KOKORO_DEFAULT_VOICE = "am_michael";
// Local Transformers.js model cache, inside the repo but gitignored, so a CI
// checkout does not re-download the ~86 MB .onnx on every run.
const KOKORO_CACHE_DIR = path.join(__dirname, "..", ".cache", "kokoro");

// --- CLI defaults (the "ancient computer" browser TTS effect) ---
const DEFAULTS = {
    text: "Hello, I'm yaPDP - ancient computer in your head!",
    out: "voice-out.wav",
    engine: "auto",  // auto | browser | sapi | kokoro
    lang: "en-US",   // browser voice language
    rate: 0.95,      // browser speech rate
    pitch: 0.7,      // browser speech pitch (lower = "ancient")
    volume: 1.0,     // browser speech volume
    voice: null,     // explicit SAPI voice name / Kokoro voice code
    sapiRate: -1,    // SAPI Rate (-10..10); -1 ≈ slower, closer to low pitch
    sapiVolume: 100, // SAPI Volume (0..100)
    device: null,    // explicit DirectShow loopback device name
    forceSapi: false // skip the browser-loopback path entirely
};

const HELP = `yaPDP voice recorder
Writes spoken text to a WAV file via the kokoro-js neural TTS, a browser
loopback capture, or Windows SAPI.

Usage:
  node tools/voicer.js [options]

Options:
  --text <text>       Text to speak (default: a yaPDP greeting).
  --file <path>       Read the text from a file instead of --text.
  --out <path>        Output WAV file (default: voice-out.wav).
  --engine <name>     Voice engine: kokoro (neural, recommended) |
                      auto (browser loopback -> SAPI) | browser | sapi.
                      (default: auto).
  --voice <name>      Voice selector: a Kokoro voice code (e.g. am_michael,
                      af_heart) for --engine kokoro, or a Windows SAPI voice
                      name for the browser/SAPI paths. Kokoro default is
                      am_michael (US Michael).
  --lang <code>       Browser TTS language, e.g. en-US (default: en-US).
  --rate <float>      Browser TTS rate (default: 0.95).
  --pitch <float>     Browser TTS pitch (default: 0.7).
  --volume <float>    Browser TTS volume 0..1 (default: 1.0).
  --device <name>     DirectShow loopback device (default: auto-detect
                      Stereo Mix / VB-Cable from the device list).
  --sapi-rate <int>   SAPI rate -10..10 (default: -1).
  --sapi-volume <int> SAPI volume 0..100 (default: 100).
  --force-sapi        Skip the browser-loopback path and use SAPI directly
                      (equivalent to --engine sapi).
  -h, --help          Show this help.
`;

// --- Pure helpers (exported for tests) ------------------------------------

// Parse the CLI argv into an options object merged over DEFAULTS.
// Keep this free of fs/network side effects so tests can call it directly.
function parseArgs(argv) {
    const opts = Object.assign({}, DEFAULTS, { help: false });
    const indexOf = (name) => argv.indexOf("--" + name);
    const value = (name) => {
        const i = indexOf(name);
        return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
    };
    const bool = (name) => argv.includes("--" + name);

    if (argv.includes("--help") || argv.includes("-h")) opts.help = true;
    if (value("text") !== null) opts.text = value("text");
    if (value("file") !== null) opts.file = value("file");
    if (value("out") !== null) opts.out = value("out");
    if (value("engine") !== null) opts.engine = value("engine");
    if (value("lang") !== null) opts.lang = value("lang");
    if (value("rate") !== null) opts.rate = parseFloat(value("rate"));
    if (value("pitch") !== null) opts.pitch = parseFloat(value("pitch"));
    if (value("volume") !== null) opts.volume = parseFloat(value("volume"));
    if (value("voice") !== null) opts.voice = value("voice");
    if (value("sapi-rate") !== null) opts.sapiRate = parseInt(value("sapi-rate"), 10);
    if (value("sapi-volume") !== null) opts.sapiVolume = parseInt(value("sapi-volume"), 10);
    if (value("device") !== null) opts.device = value("device");
    if (bool("force-sapi")) opts.forceSapi = true;
    // --force-sapi is legacy for --engine sapi; a single effective engine
    // drives main() below.
    if (opts.engine === "auto" && opts.forceSapi) opts.engine = "sapi";
    return opts;
}

// Lowercase/validate an engine name against the known set. Pure and testable.
function normaliseEngine(name) {
    const engine = String(name == null ? "auto" : name).toLowerCase().trim();
    if (!ENGINES.includes(engine)) {
        throw new Error("unknown voice engine '" + name +
            "' (expected one of: " + ENGINES.join(", ") + ")");
    }
    return engine;
}

// Resolve the concrete Kokoro synthesis parameters from parsed CLI options.
// Pure and testable — kokoroSpeak() (below) is the only place that touches the
// real model, so unit tests can pin the defaults without downloading it.
function kokoroConfig(opts) {
    opts = opts || {};
    return {
        modelId: KOKORO_MODEL_ID,
        dtype: KOKORO_DTYPE,
        device: "cpu",
        voice: opts.voice || KOKORO_DEFAULT_VOICE,
        cacheDir: opts.kokoroCacheDir || KOKORO_CACHE_DIR
    };
}

// Parse `ffmpeg -list_devices true -f dshow -i dummy` stderr into the audio
// and video device name lists. ffmpeg groups them under "DirectShow audio
// devices" / "DirectShow video devices" section headers.
function parseDshowDevices(output) {
    const res = { audio: [], video: [] };
    let section = null;
    for (const line of String(output).split(/\r?\n/)) {
        const lower = line.toLowerCase();
        if (lower.includes("directshow video devices")) {
            section = "video";
            continue;
        }
        if (lower.includes("directshow audio devices")) {
            section = "audio";
            continue;
        }
        if (!section) continue;
        const m = /^\s*\[dshow[^\]]*\]\s+"([^"]+)"\s*$/.exec(line);
        if (m && !res[section].includes(m[1])) res[section].push(m[1]);
    }
    return res;
}

// Loopback devices are named after the virtual/stereo-route hardware they
// expose. Pick the first capture endpoint that looks like one, in order of
// reliability: a VB-Cable input, then the classic Stereo Mix, then the other
// virtual-loopback brands.
const LOOPBACK_HINTS = [
    "cable input", "vb-audio", "vb-cable",
    "stereo mix",
    "what u hear",
    "loopback",
    "voicemeeter",
    "virtual audio"
];

function findLoopbackDevice(audioDevices) {
    for (const hint of LOOPBACK_HINTS) {
        const match = audioDevices.find((n) => n.toLowerCase().includes(hint));
        if (match) return match;
    }
    return null;
}

// Map a language tag to a Windows LCID for SAPI's SelectVoiceByHints; only a
// couple of languages are common on SAPI installs, everything else falls back
// to the default voice.
function cultureIdFor(lang) {
    switch ((lang || "").toLowerCase()) {
        case "en": case "en-us": case "en-gb": return 0x0409;
        case "ru": case "ru-ru": return 0x0419;
        default: return null;
    }
}

// Escape a value for inclusion inside a single-quoted PowerShell string.
function escPS(s) {
    return String(s).replace(/'/g, "''");
}

// Build the PowerShell System.Speech script that writes a WAV for `text`.
// The text itself is NOT embedded — the caller pipes it to the process stdin,
// so arbitrary text never needs shell escaping. Pure and testable.
function buildSapiScript(opts) {
    const lines = [];
    lines.push('$ErrorActionPreference = "Stop";');
    // Read the piped text as UTF-8 regardless of the console code page.
    lines.push("[Console]::InputEncoding = [System.Text.Encoding]::UTF8;");
    lines.push("Add-Type -AssemblyName System.Speech;");
    lines.push("$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;");
    lines.push(`$synth.Rate = ${Number(opts.sapiRate) || 0};`);
    lines.push(`$synth.Volume = ${Math.max(0, Math.min(100, Number(opts.sapiVolume) || 100))};`);
    // Voice selection is best-effort: an unavailable named voice / missing
    // culture must NOT abort the script — System.Speech falls back to the
    // default installed voice instead.
    if (opts.voice) {
        lines.push("try { " +
            `$synth.SelectVoice('${escPS(opts.voice)}'); ` +
            "} catch { /* voice not installed, use default */ }");
    } else {
        const culture = cultureIdFor(opts.lang);
        if (culture != null) {
            // Emit the LCID as a hex literal (e.g. 0x409) — PowerShell reads it
            // as an Int32 culture id for SelectVoiceByHints.
            lines.push(
                "try { " +
                "$synth.SelectVoiceByHints(" +
                "[System.Speech.Synthesis.VoiceGender]::NotSet, " +
                "[System.Speech.Synthesis.VoiceAge]::NotSet, " +
                `0x${culture.toString(16)}); ` +
                "} catch { /* no matching voice, use default */ }");
        }
    }
    lines.push(`$synth.SetOutputToWaveFile('${escPS(path.resolve(opts.outPath))}');`);
    lines.push("$text = [Console]::In.ReadToEnd();");
    lines.push("if ($text) { $synth.Speak($text); }");
    lines.push("$synth.Dispose();");
    return lines.join("\n");
}

// --- Non-pure pieces (browser / ffmpeg / powershell) ----------------------

// Resolve an installed Edge/Chrome for the browser launch (same candidate list
// as tools/record-video.js, kept local so requiring this module never runs the
// video recorder's main()).
function findBrowserExecutable() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ].filter(Boolean);
    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

// Render the in-memory page that drives Chrome's Web Speech API. There is
// deliberately NO external voice.html fixture to keep — the page is generated
// on the fly, and the caller injects the text/voice options through
// window.VOICE_OPTS at the JS level, so arbitrary text never risks HTML
// injection. Pure and testable.
function buildVoiceHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>yaPDP Voice</title>
</head>
<body>
<button id="speakBtn">Hear the voice of ancient computer</button>
<script>
    // Options are injected by the recorder before this page renders (see
    // speakViaBrowser's evaluateOnNewDocument); defaults keep it usable by hand.
    var VOICE_OPTS = window.VOICE_OPTS || {};
    window.__voiceEnded = false;
    window.__voiceError = null;

    if ('speechSynthesis' in window && window.speechSynthesis.onvoiceschanged) {
        window.speechSynthesis.onvoiceschanged = function () {
            window.__voicesReady = true;
        };
    }

    function pickVoice(lang) {
        var voices = speechSynthesis.getVoices();
        if (!voices || !voices.length) return null;
        var norm = (lang || 'en-US').toLowerCase();
        var byLang = voices.filter(function (v) {
            return v.lang && v.lang.toLowerCase() === norm;
        });
        var candidate = byLang.find(function (v) {
            return !/google/i.test(v.voiceURI || '');
        }) || byLang[0];
        if (candidate) return candidate;
        return voices.find(function (v) {
            return v.lang && v.lang.indexOf('en') === 0 &&
                !/google/i.test(v.voiceURI || '');
        }) || voices[0];
    }

    function speakYaPDP() {
        var utterance = new SpeechSynthesisUtterance();
        utterance.text = VOICE_OPTS.text ||
            "Hello, I'm yaPDP - ancient computer in your head!";
        utterance.volume = (VOICE_OPTS.volume != null) ? VOICE_OPTS.volume : 1.0;
        utterance.rate = (VOICE_OPTS.rate != null) ? VOICE_OPTS.rate : 0.95;
        utterance.pitch = (VOICE_OPTS.pitch != null) ? VOICE_OPTS.pitch : 0.7;

        var voice = pickVoice(VOICE_OPTS.lang);
        if (voice) utterance.voice = voice;

        utterance.onstart = function () { window.__voiceStarted = true; };
        utterance.onend = function () { window.__voiceEnded = true; };
        utterance.onerror = function (event) {
            window.__voiceError = (event && event.error) || true;
        };

        speechSynthesis.speak(utterance);
    }

    document.getElementById('speakBtn').addEventListener('click', speakYaPDP);
</script>
</body>
</html>`;
}

// Render the generated page in a HEADED Chrome (speechSynthesis needs a real
// audio output), let the Web Speech API speak `text`, and resolve once onend
// fires. The #speakBtn click is a real (trusted) input event, which satisfies
// Chrome's user-activation requirement for speechSynthesis.speak().
async function speakViaBrowser(text, opts) {
    const puppeteer = require("puppeteer-core");
    const exe = findBrowserExecutable();
    if (!exe) throw new Error("no Edge/Chrome found for the browser TTS path");

    const browser = await puppeteer.launch({
        executablePath: exe,
        headless: false,
        args: ["--autoplay-policy=no-user-gesture-required"],
        defaultViewport: { width: 900, height: 320 }
    });
    try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument((cfg) => {
            window.VOICE_OPTS = cfg;
            window.__voiceEnded = false;
            window.__voiceError = null;
        }, { text, lang: opts.lang, rate: opts.rate, pitch: opts.pitch, volume: opts.volume });

        await page.setContent(buildVoiceHtml(), { waitUntil: "load" });
        // Chrome fills the voice list asynchronously; wait for at least one so
        // the chosen en-US (non-Google) voice is present at click time.
        try {
            await page.waitForFunction(
                () => window.speechSynthesis.getVoices().length > 0,
                { timeout: 8000 });
        } catch (err) { /* some engines populate later; proceed anyway */ }

        await page.waitForSelector("#speakBtn", { timeout: 10000 });
        await page.click("#speakBtn");

        const ok = await page.waitForFunction(
            () => window.__voiceEnded === true || !!window.__voiceError,
            { timeout: 120000 }
        ).then(async () => page.evaluate(() => !window.__voiceError))
            .catch(() => false);
        if (!ok) throw new Error("browser TTS did not finish (error or timeout)");
    } finally {
        await browser.close();
    }
}

// Run `ffmpeg -list_devices ...` and return its stderr text.
function dshowDeviceOutput(ffmpegPath) {
    const res = spawnSync(ffmpegPath,
        ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return res.stderr || "";
}

// Start recording the given DirectShow device into a raw s16le mono 44100 PCM
// file (no WAV footer is written yet, so an abrupt kill cannot corrupt it).
// Resolves with the child once the capture is clearly running; rejects if
// ffmpeg exits immediately (bad device name / device busy).
function startLoopbackCapture(ffmpegPath, device, rawPcm) {
    const proc = spawn(ffmpegPath, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "dshow", "-i", "audio=" + device,
        "-f", "s16le", "-ar", "44100", "-ac", "1",
        rawPcm
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let errText = "";
    proc.stderr.on("data", (d) => { errText += d; });

    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = () => {
            if (settled) return;
            settled = true;
            try { proc.kill(); } catch (err) { /* ignore */ }
            reject(new Error("ffmpeg dshow capture failed: " +
                (errText.trim() || "no stderr output")));
        };
        proc.once("error", fail);
        proc.once("exit", fail);
        // If ffmpeg is still alive after the startup window, the device opened
        // and capture is streaming.
        setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(proc);
        }, 2500);
    });
}

// Stop a running raw-PCM capture. Raw capture needs no trailer, so a plain
// terminate is safe — the file simply ends where the capture stopped.
async function stopLoopbackCapture(proc) {
    if (!proc || proc.exitCode != null) return;
    try { proc.kill(); } catch (err) { /* already gone */ }
    await new Promise((resolve) => {
        const t = setTimeout(resolve, 4000);
        proc.once("exit", () => { clearTimeout(t); resolve(); });
    });
}

// Wrap a raw s16le 44100 mono PCM file into a proper WAV with a real header.
function wrapPcmToWav(ffmpegPath, rawPcm, outWav) {
    const res = spawnSync(ffmpegPath, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", "44100", "-ac", "1", "-i", rawPcm,
        outWav
    ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (res.status !== 0) {
        throw new Error("ffmpeg PCM->WAV wrap failed: " + (res.stderr || "").trim());
    }
}

// Primary path: record the browser's Web Speech API output via a loopback
// DirectShow device and write it to `outWav`.
async function captureLoopbackTts(text, opts, outWav) {
    if (os.platform() !== "win32") {
        throw new Error("DirectShow loopback capture is Windows-only");
    }
    const ffmpegPath = require("ffmpeg-static");
    let device = opts.device;
    if (!device) {
        const audio = parseDshowDevices(dshowDeviceOutput(ffmpegPath)).audio;
        device = findLoopbackDevice(audio);
        if (!device) {
            throw new Error("no loopback capture device (Stereo Mix / VB-Cable) " +
                "found; install one or pass --device");
        }
    }

    const rawPcm = outWav + ".pcm";
    try {
        const rec = await startLoopbackCapture(ffmpegPath, device, rawPcm);
        try {
            await speakViaBrowser(text, opts);
            // Small tail so the last syllables flush out of the capture buffer.
            await new Promise((r) => setTimeout(r, 400));
        } finally {
            await stopLoopbackCapture(rec);
        }
        wrapPcmToWav(ffmpegPath, rawPcm, outWav);
    } finally {
        try { fs.unlinkSync(rawPcm); } catch (err) { /* best effort */ }
    }
}

// Fallback path: write the WAV directly through Windows SAPI via PowerShell.
async function sapiSpeak(text, opts) {
    if (os.platform() !== "win32") {
        throw new Error("the SAPI fallback requires Windows");
    }
    const outWav = path.resolve(opts.out);
    const script = buildSapiScript(Object.assign({}, opts, { outPath: outWav }));
    await new Promise((resolve, reject) => {
        const child = spawn("powershell",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-Command", script],
            { stdio: ["pipe", "pipe", "pipe"] });
        let errText = "";
        child.stderr.on("data", (d) => { errText += d; });
        child.once("error", (e) => reject(e));
        child.once("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error("PowerShell SAPI failed (code " + code +
                "): " + errText.trim()));
        });
        child.stdin.write(text, "utf8");
        child.stdin.end();
    });
}

// Kokoro path: synthesize locally with the kokoro-js neural TTS (Kokoro-82M).
// The quantized model is downloaded once into the repo-local .cache/kokoro by
// Transformers.js; the voice binary is read from inside the kokoro-js package.
// No headed browser, no loopback capture device and no network voice needed.
async function kokoroSpeak(text, opts, outWav) {
    let kokoro;
    try {
        kokoro = require("kokoro-js");
    } catch (err) {
        throw new Error("the kokoro engine needs the kokoro-js package " +
            "(npm install --save-dev kokoro-js)");
    }
    const cfg = kokoroConfig(opts);
    fs.mkdirSync(cfg.cacheDir, { recursive: true });
    // Point Transformers.js at our cache so a fresh CI checkout does not
    // re-download the ~86 MB .onnx on every run, then load the quantized
    // model on the CPU backend. `env` is a shared singleton, so mutating it
    // here affects the from_pretrained() call below.
    const transformers = require("@huggingface/transformers");
    if (transformers.env) {
        transformers.env.cacheDir = cfg.cacheDir;
        transformers.env.allowRemoteModels = true;
    }
    process.stdout.write("Loading Kokoro-82M (first run downloads the model " +
        "into " + cfg.cacheDir + ", may take a while)...\n");
    const tts = await kokoro.KokoroTTS.from_pretrained(cfg.modelId, {
        dtype: cfg.dtype,
        device: cfg.device
    });
    process.stdout.write("Speaking with Kokoro voice '" + cfg.voice + "'...\n");
    const audio = await tts.generate(text, { voice: cfg.voice });
    await audio.save(path.resolve(outWav));
}

// --- CLI ------------------------------------------------------------------

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { process.stdout.write(HELP); return; }

    const text = opts.file
        ? fs.readFileSync(path.resolve(opts.file), "utf8")
        : opts.text;
    if (!text || !text.trim()) {
        throw new Error("no text to speak (use --text or --file)");
    }

    const outWav = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(outWav), { recursive: true });

    // parseArgs already folds --force-sapi into engine "sapi"; this is the
    // single place that decides which capture/synthesis path runs.
    const engine = normaliseEngine(opts.engine);
    let method;
    if (engine === "kokoro") {
        await kokoroSpeak(text, opts, outWav);
        method = "Kokoro-82M (kokoro-js, voice " + kokoroConfig(opts).voice + ")";
    } else if (engine === "sapi") {
        await sapiSpeak(text, opts);
        method = "Windows SAPI";
    } else if (engine === "browser") {
        await captureLoopbackTts(text, opts, outWav);
        method = "browser loopback";
    } else { // auto: browser loopback first, then the Windows SAPI fallback.
        try {
            await captureLoopbackTts(text, opts, outWav);
            method = "browser loopback";
        } catch (err) {
            process.stdout.write("note: browser-loopback unavailable (" +
                err.message + "); falling back to Windows SAPI.\n");
            try {
                await sapiSpeak(text, opts);
                method = "Windows SAPI";
            } catch (err2) {
                throw new Error("both TTS paths failed.\n" +
                    "loopback: " + err.message + "\nsapi: " + err2.message);
            }
        }
    }

    const kb = Math.round(fs.statSync(outWav).size / 1024);
    process.stdout.write(`Saved ${outWav} (${kb} kB) via ${method}.\n`);
}

if (require.main === module) {
    main().catch((err) => {
        process.stderr.write("Error: " + err.message + "\n");
        process.exitCode = 1;
    });
}

module.exports = {
    ENGINES,
    KOKORO_MODEL_ID,
    KOKORO_DTYPE,
    KOKORO_DEFAULT_VOICE,
    KOKORO_CACHE_DIR,
    DEFAULTS,
    parseArgs,
    normaliseEngine,
    kokoroConfig,
    parseDshowDevices,
    findLoopbackDevice,
    cultureIdFor,
    escPS,
    buildSapiScript,
    buildVoiceHtml
};
