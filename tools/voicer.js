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
 *             Sounds far more natural than the OS voice and is fully headless:
 *             no browser and no network voice dependency. The model (one
 *             quantized .onnx, ~86 MB) is downloaded from Hugging Face into
 *             .cache/kokoro on first use, then reused. Voices are shipped
 *             inside the kokoro-js package, so only the chosen one is read
 *             (default: am_michael, US Michael).
 *   sapi    — Windows SAPI: a PowerShell System.Speech synthesizer writes the
 *             WAV directly — no browser or capture device needed.
 *   auto    — Kokoro first, falling back to Windows SAPI when it fails.
 *
 * Usage (mingw bash):
 *   node voicer.js --text "Hello, I'm yaPDP" --out voice-out.wav
 *   node voicer.js --text "Hello" --out voice-out.wav --engine sapi
 *   node voicer.js --text "Hello" --out voice-out.wav --engine kokoro
 *
 * The module exports its pure helpers for unit tests (tests/voicer.test.js);
 * the CLI runs only when the file is executed directly.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// --- Engine selection -------------------------------------------------------
// Voice engines. "auto" is the default: Kokoro (local neural TTS, kokoro-js),
// falling back to Windows SAPI when synthesis fails. "kokoro"/"sapi" force one
// of the two mechanisms directly.
const ENGINES = ["auto", "kokoro", "sapi"];

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

// --- CLI defaults ---
const DEFAULTS = {
    text: "Hello, I'm yaPDP - ancient computer in your head!",
    out: "voice-out.wav",
    engine: "auto",  // auto | kokoro | sapi
    lang: "en-US",   // SAPI voice culture hint
    voice: null,     // explicit SAPI voice name / Kokoro voice code
    sapiRate: -1,    // SAPI Rate (-10..10); -1 ≈ slower, closer to low pitch
    sapiVolume: 100  // SAPI Volume (0..100)
};

const HELP = `yaPDP voice recorder
Writes spoken text to a WAV file via the kokoro-js neural TTS (Kokoro-82M) or
Windows SAPI.

Usage:
  node tools/voicer.js [options]

Options:
  --text <text>       Text to speak (default: a yaPDP greeting).
  --file <path>       Read the text from a file instead of --text.
  --out <path>        Output WAV file (default: voice-out.wav).
  --engine <name>     Voice engine: auto (default; Kokoro -> Windows SAPI) |
                      kokoro | sapi.
  --voice <name>      Voice selector: a Kokoro voice code (e.g. am_michael,
                      af_heart) for --engine kokoro, or a Windows SAPI voice
                      name for --engine sapi. Kokoro default is am_michael
                      (US Michael).
  --lang <code>       SAPI voice language, e.g. en-US (default: en-US).
  --sapi-rate <int>   SAPI rate -10..10 (default: -1).
  --sapi-volume <int> SAPI volume 0..100 (default: 100).
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

    if (argv.includes("--help") || argv.includes("-h")) opts.help = true;
    if (value("text") !== null) opts.text = value("text");
    if (value("file") !== null) opts.file = value("file");
    if (value("out") !== null) opts.out = value("out");
    if (value("engine") !== null) opts.engine = value("engine");
    if (value("lang") !== null) opts.lang = value("lang");
    if (value("voice") !== null) opts.voice = value("voice");
    if (value("sapi-rate") !== null) opts.sapiRate = parseInt(value("sapi-rate"), 10);
    if (value("sapi-volume") !== null) opts.sapiVolume = parseInt(value("sapi-volume"), 10);
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

// --- Non-pure pieces (powershell / kokoro) --------------------------------

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
// Fully headless — no browser and no network voice needed.
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

    // parseArgs keeps the engine as given; this is the single place that
    // decides which synthesis path runs (auto = Kokoro -> SAPI fallback).
    const engine = normaliseEngine(opts.engine);
    let method;
    if (engine === "kokoro") {
        await kokoroSpeak(text, opts, outWav);
        method = "Kokoro-82M (kokoro-js, voice " + kokoroConfig(opts).voice + ")";
    } else if (engine === "sapi") {
        await sapiSpeak(text, opts);
        method = "Windows SAPI";
    } else { // auto: Kokoro first, then the Windows SAPI fallback.
        try {
            await kokoroSpeak(text, opts, outWav);
            method = "Kokoro-82M (kokoro-js, voice " + kokoroConfig(opts).voice + ")";
        } catch (err) {
            process.stdout.write("note: Kokoro unavailable (" + err.message +
                "); falling back to Windows SAPI.\n");
            try {
                await sapiSpeak(text, opts);
                method = "Windows SAPI";
            } catch (err2) {
                throw new Error("both engines failed.\n" +
                    "kokoro: " + err.message + "\nsapi: " + err2.message);
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
    cultureIdFor,
    escPS,
    buildSapiScript
};
