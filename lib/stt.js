// Speech-to-text: sox recording, whisper-cpp or API transcription, LLM normalization.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { getActiveSessionTitle } from "./session.js";

let sttApiEndpoint = null;
let sttApiModel = null;
let sttApiKeyEnv = null;
let whisperBinary = "whisper-cli";

const WAV_FILENAME = "opencode-stt.wav";
let tmpDir = "/tmp";

// Width presets exposed by the V2 dialog API; values match the host's columns.
const DIALOG_SIZES = new Set(["medium", "large", "xlarge"]);
let voiceDialogSize = "xlarge";
let voiceDialogLines = 8;

// Voice write-back: the composer focused when recording starts is the target
// for appending the transcription, so it lands in the prompt as a draft.
let appendToPrompt = true;
let voiceComposer = null;
let voiceRoute = null;

const MODELS_DIRS = [
  path.join(os.homedir(), ".local", "share", "whisper-cpp"),
  "/opt/homebrew/share/whisper-cpp/models",
  "/usr/local/share/whisper-cpp/models",
];

const MODELS = {
  "large-v3-turbo-q5_0": {
    label: "Large v3 Turbo Q5 (recommended)",
    file: "ggml-large-v3-turbo-q5_0.bin",
  },
  "large-v3-turbo-q8_0": { label: "Large v3 Turbo Q8", file: "ggml-large-v3-turbo-q8_0.bin" },
  "large-v3-turbo": { label: "Large v3 Turbo (full)", file: "ggml-large-v3-turbo.bin" },
  "medium-q5_0": { label: "Medium Q5 (multilingual, faster)", file: "ggml-medium-q5_0.bin" },
  "small.en": { label: "Small English", file: "ggml-small.en.bin" },
  small: { label: "Small Multilingual", file: "ggml-small.bin" },
  "base.en": { label: "Base English", file: "ggml-base.en.bin" },
  base: { label: "Base Multilingual", file: "ggml-base.bin" },
  "tiny.en": { label: "Tiny English (fastest)", file: "ggml-tiny.en.bin" },
  tiny: { label: "Tiny Multilingual (fastest)", file: "ggml-tiny.bin" },
};
const DEFAULT_MODEL = "large-v3-turbo-q5_0";

const DEFAULT_LANGUAGE = "auto";
// Curated subset for the /stt-language picker; options.sttLanguage accepts any
// whisper.cpp language code.
const LANGUAGES = {
  auto: { label: "Auto-detect" },
  en: { label: "English" },
  zh: { label: "Chinese" },
  yue: { label: "Cantonese" },
  ja: { label: "Japanese" },
  ko: { label: "Korean" },
  de: { label: "German" },
  fr: { label: "French" },
  es: { label: "Spanish" },
  pt: { label: "Portuguese" },
  ru: { label: "Russian" },
  it: { label: "Italian" },
};
let sttDefaultLanguage = DEFAULT_LANGUAGE;

export function isOpenRouterEndpoint(endpoint) {
  return /(^https?:\/\/)?([^/]+\.)?openrouter\.ai(\/|$)/i.test(endpoint || "");
}

function buildMultipartTranscriptionRequest(model, audioBuffer, apiKey) {
  const blob = new Blob([audioBuffer], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");

  const headers = {};
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  return {
    headers,
    body: form,
  };
}

export function buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  const payload = {
    model,
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: "wav",
    },
  };

  return {
    headers,
    body: JSON.stringify(payload),
  };
}

function getModelsDir() {
  for (const dir of MODELS_DIRS) {
    if (fs.existsSync(dir)) return dir;
  }
  return MODELS_DIRS[0];
}

// ---- Audio backend detection (coreaudio / pulseaudio / sox default) ----

function detectAudioBackend() {
  if (process.platform === "darwin") return "coreaudio";
  try {
    execSync("pactl --version", { stdio: "ignore", timeout: 3000 });
    return "pulseaudio";
  } catch {
    return "default";
  }
}

// ---- Audio server diagnostics ----

export function isWSL() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

// Unlike `pactl --version`, `pactl info` actually connects to the server.
function pulseServerHealth() {
  try {
    execSync("pactl info", { stdio: "ignore", timeout: 3000 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// User-facing hint for missing devices / recording failures. On WSL the audio
// server is WSLg's PulseAudio, which can wedge and needs a `wsl --shutdown`.
export function buildAudioHint({ backend, serverOk, isWsl }) {
  if (backend !== "pulseaudio") return "No input devices found";
  if (serverOk) return "No input devices found - check your audio input source configuration";
  if (isWsl) {
    return 'Audio server unreachable. On WSL, WSLg\'s PulseAudio may be stuck - run "wsl --shutdown" on Windows, then reopen Ubuntu';
  }
  return "Audio server unreachable - check that PipeWire/PulseAudio is running";
}

// Appends a server-health hint to recording failure messages when the
// PulseAudio server is unreachable (e.g. wedged WSLg on WSL).
function audioFailureSuffix(backend) {
  if (backend !== "pulseaudio") return "";
  if (pulseServerHealth().ok) return "";
  return `. ${buildAudioHint({ backend, serverOk: false, isWsl: isWSL() })}`;
}

// Input device descriptors: name is the value passed to sox, label is shown in the UI.
export function parsePactlSources(jsonText) {
  const data = JSON.parse(jsonText);
  return (Array.isArray(data) ? data : [])
    .filter((s) => s?.name && !s.name.endsWith(".monitor"))
    .map((s) => ({
      name: s.name,
      label: s.description ? `${s.description} (${s.name})` : s.name,
    }));
}

export function parsePactlSourcesShort(text) {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((name) => name && !name.endsWith(".monitor"))
    .map((name) => ({ name, label: name }));
}

function listInputDevices(backend) {
  if (backend === "coreaudio") {
    try {
      const json = execSync("system_profiler SPAudioDataType -json 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const data = JSON.parse(json);
      return (data.SPAudioDataType?.[0]?._items || [])
        .filter((d) => d.coreaudio_input_source != null)
        .map((d) => {
          const name = d.coreaudio_device_name || d._name;
          return { name, label: name };
        });
    } catch {
      return [];
    }
  }
  if (backend === "pulseaudio") {
    try {
      const json = execSync("pactl -f json list sources 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      return parsePactlSources(json);
    } catch {
      try {
        const out = execSync("pactl list sources short 2>/dev/null", {
          encoding: "utf-8",
          timeout: 5000,
        });
        return parsePactlSourcesShort(out);
      } catch {
        return [];
      }
    }
  }
  return [];
}

export function buildRecordArgs(backend, mic) {
  if (backend === "pulseaudio") return ["-t", "pulseaudio", mic || "default"];
  if (backend === "coreaudio" && mic) return ["-t", "coreaudio", mic];
  return ["-d"];
}

// ---- Recording state and control ----

let soxProc = null;
let soxStderr = "";
let recording = false;
let processing = false;

function forceKillSox(logger) {
  if (soxProc) {
    try {
      if (process.platform === "win32") {
        soxProc.kill();
      } else {
        process.kill(soxProc.pid, "SIGKILL");
      }
      logger?.log("STT", `Killed sox pid=${soxProc.pid}`, "debug");
    } catch {}
    soxProc = null;
  }
  if (process.platform !== "win32") {
    try {
      execSync("pkill -9 -f 'sox.*opencode-stt'", { stdio: "ignore" });
    } catch {}
  }
}

function startRecording(kv, backend, toast, logger) {
  if (soxProc) {
    logger?.log("STT", "Start recording skipped: sox already running", "debug");
    return;
  }

  const wavFile = path.join(tmpDir, WAV_FILENAME);
  forceKillSox(logger);
  try {
    fs.unlinkSync(wavFile);
  } catch {}

  soxStderr = "";
  const mic = kv.get("stt.mic", "") || null;
  const inputArgs = buildRecordArgs(backend, mic);
  logger?.log(
    "STT",
    `Starting recording backend=${backend} mic=${mic || "system default"}`,
    "debug",
  );

  soxProc = spawn(
    "sox",
    [...inputArgs, "-r", "16000", "-c", "1", "-b", "16", wavFile, "silence", "1", "0.1", "1%"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    },
  );

  soxProc.stderr.on("data", (chunk) => {
    soxStderr += chunk.toString();
  });

  soxProc.on("error", (err) => {
    soxProc = null;
    logger?.log("STT", `Recording failed: ${err.message}`, "error");
    if (recording) {
      recording = false;
      toast(`Recording failed: ${err.message}${audioFailureSuffix(backend)}`, "error");
    }
  });

  soxProc.on("exit", (code) => {
    soxProc = null;
    logger?.log(
      "STT",
      `sox exited code=${code} stderr=${soxStderr.trim()}`,
      code === 0 || code === null ? "debug" : "warn",
    );
    if (recording && code !== 0 && code !== null && !processing) {
      recording = false;
      const errLine = soxStderr.trim().split("\n").pop();
      toast(
        `Recording error: ${errLine || `sox exited (code=${code})`}${audioFailureSuffix(backend)}`,
        "error",
      );
    }
  });

  recording = true;
}

function stopRecording(logger) {
  logger?.log("STT", "Stopping recording", "debug");
  if (soxProc) {
    if (process.platform === "win32") {
      soxProc.kill();
    } else {
      soxProc.kill("SIGINT");
    }
  }
}

async function waitForSoxExit(logger, timeoutMs = 2000) {
  const start = Date.now();
  while (soxProc && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (soxProc) {
    logger?.log("STT", "sox did not stop before timeout", "warn");
    forceKillSox(logger);
  }
}

function getModelName(kv) {
  const model = kv.get("stt.model", DEFAULT_MODEL);
  return MODELS[model] ? model : DEFAULT_MODEL;
}

function getModelPath(kv) {
  return path.join(getModelsDir(), MODELS[getModelName(kv)].file);
}

function getLanguage(kv) {
  return kv.get("stt.language") || sttDefaultLanguage;
}

export function buildWhisperArgs(modelPath, wavFile, language) {
  return ["-m", modelPath, "-f", wavFile, "-l", language || DEFAULT_LANGUAGE, "-np", "-nt"];
}

function transcribe(kv, logger) {
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  const mp = getModelPath(kv);
  const lang = getLanguage(kv);
  logger?.log("STT", `Local transcription requested model=${mp} language=${lang}`, "debug");
  if (!fs.existsSync(mp)) {
    logger?.log("STT", `Whisper model missing: ${mp}`, "error");
    return Promise.resolve({
      error: `Model not found: ${getModelName(kv)}. Download from huggingface.co/ggerganov/whisper.cpp`,
    });
  }
  if (!fs.existsSync(wavFile)) {
    logger?.log("STT", `Recording file missing: ${wavFile}`, "error");
    return Promise.resolve({ error: "No recording file - sox may have failed to capture audio" });
  }
  if (fs.statSync(wavFile).size <= 44) {
    logger?.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return Promise.resolve({ error: "Recording is empty - no audio captured" });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(whisperBinary, buildWhisperArgs(mp, wavFile, lang), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    logger?.log("STT", `Started whisper-cli pid=${proc.pid}`, "debug");

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (process.platform === "win32") {
        proc.kill();
      } else {
        proc.kill("SIGKILL");
      }
      logger?.log("STT", "whisper-cli timed out after 60s", "error");
      resolve({ error: "Transcription timed out (60s)" });
    }, 60000);

    proc.on("error", (err) => {
      clearTimeout(timer);
      logger?.log("STT", `whisper-cli error: ${err.message}`, "error");
      if (err.code === "ENOENT") {
        resolve({
          error: `whisper-cli not found (${whisperBinary}). Install whisper.cpp and add it to PATH, or set the whisperPath plugin option`,
        });
        return;
      }
      resolve({ error: `Transcription failed: ${err.message}` });
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      // whisper-cli exits 0 even for an unknown language, printing the error to
      // stderr instead; surface it rather than reporting "no speech detected".
      const langError = stderr.match(/error: unknown language '([^']+)'/);
      if (langError) {
        logger?.log("STT", `whisper-cli rejected language: ${langError[1]}`, "error");
        resolve({ error: `Unknown whisper language: ${langError[1]}` });
        return;
      }
      if (code !== 0) {
        logger?.log("STT", `whisper-cli exited code=${code} stderr=${stderr.trim()}`, "error");
        resolve({ error: stderr.trim().split("\n").pop() || `whisper-cli exited (code=${code})` });
        return;
      }
      logger?.log("STT", `Local transcription succeeded stdoutChars=${stdout.length}`, "debug");
      resolve({
        text: stdout
          .replace(/\[.*?\]/g, "")
          .replace(/\(.*?\)/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      });
    });
  });
}

const STT_SYSTEM_PROMPT = `You are a speech-to-text normalizer for a coding assistant CLI.

Clean up raw whisper transcription into a clear, well-punctuated prompt. Rules:
- Fix punctuation, capitalization, and grammar
- Remove filler words (um, uh, like, you know, etc.)
- Keep technical terms, file names, and code references exact
- If the user is dictating code, format it appropriately
- Use the session context above to resolve ambiguous references (e.g. "that function", "the file", "it")
- Output ONLY the cleaned text, nothing else
- Do not add any commentary or explanation
- Keep the user's intent and meaning intact

CRITICAL DOMAIN CORRECTIONS - Fix common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless explicitly talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync"
- "a sink" -> "async"
- "doc" / "talker" -> "docker"
- "cash" -> "cache"
- "rap" -> "wrap"
- "Jason" -> "JSON"
- "get" -> "Git"
- "react" -> "React"
- "types creep" / "type script" -> "TypeScript"
- "bite" -> "byte"
- "string" -> "String"
- "int" -> "Int"
- "bullion" -> "boolean"

Rely heavily on context to fix words that sound similar to programming terminology.`;

async function normalizeTranscription(complete, rawText, sessionTitle, systemPrompt, logger) {
  const contextLine = sessionTitle ? ` The user is currently working on: "${sessionTitle}"` : "";
  const system = `${systemPrompt}${contextLine}`;

  logger?.log("STT", `Normalizing transcription chars=${rawText.length}`, "debug");
  const result = await complete({
    system,
    prompt: `Clean up this speech-to-text transcription:\n\n${rawText}`,
  });
  return result;
}

async function getApiModels(logger) {
  if (!sttApiEndpoint) return [];
  try {
    const url = sttApiEndpoint.endsWith("/")
      ? `${sttApiEndpoint}models`
      : `${sttApiEndpoint}/models`;
    const headers = {};
    if (sttApiKeyEnv && process.env[sttApiKeyEnv]) {
      headers["Authorization"] = "Bearer " + process.env[sttApiKeyEnv];
    }
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    logger?.log("STT", `Fetched STT API models status=${resp.status}`, resp.ok ? "debug" : "warn");
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.data || [])
      .filter((m) => m.id && /whisper/i.test(m.id))
      .map((m) => ({ value: m.id, label: m.id }));
  } catch (err) {
    logger?.log("STT", `Failed to fetch STT API models: ${err.message}`, "error");
    return [];
  }
}

async function transcribeApi(kv, logger) {
  if (!sttApiEndpoint || !sttApiModel) {
    logger?.log("STT", "STT API transcription skipped: API not configured", "warn");
    return { error: "STT API not configured" };
  }
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  const model = kv.get("stt.api.model") || sttApiModel;
  logger?.log("STT", `STT API transcription requested model=${model}`, "debug");

  if (!fs.existsSync(wavFile)) {
    logger?.log("STT", `Recording file missing: ${wavFile}`, "error");
    return { error: "No recording file - sox may have failed to capture audio" };
  }
  if (fs.statSync(wavFile).size <= 44) {
    logger?.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return { error: "Recording is empty - no audio captured" };
  }

  try {
    const audioBuffer = await fs.promises.readFile(wavFile);
    const apiKey = sttApiKeyEnv ? process.env[sttApiKeyEnv] : null;
    const useOpenRouterFormat = isOpenRouterEndpoint(sttApiEndpoint);

    const url = sttApiEndpoint.endsWith("/")
      ? `${sttApiEndpoint}audio/transcriptions`
      : `${sttApiEndpoint}/audio/transcriptions`;

    const request = useOpenRouterFormat
      ? buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey)
      : buildMultipartTranscriptionRequest(model, audioBuffer, apiKey);

    const resp = await fetch(url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(60000),
    });
    logger?.log("STT", `STT API response status=${resp.status}`, resp.ok ? "debug" : "error");

    if (!resp.ok) {
      const responseBody = await resp.text();
      let msg = `STT API error ${resp.status}`;
      try {
        const err = JSON.parse(responseBody);
        msg = err?.error?.message || msg;
      } catch {}
      return { error: msg };
    }

    let data;
    try {
      data = await resp.json();
    } catch (err) {
      logger?.log("STT", `STT API returned invalid JSON: ${err.message}`, "error");
      return { error: `STT API returned invalid JSON: ${err.message}` };
    }
    logger?.log("STT", `STT API transcription succeeded chars=${data.text?.length || 0}`, "debug");
    return { text: data.text?.trim() || "" };
  } catch (err) {
    logger?.log("STT", `STT API request failed: ${err.message}`, "error");
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { error: "STT API request timed out (60s)" };
    }
    return { error: `STT API request failed: ${err.message}` };
  }
}

async function submitTranscription(context, text) {
  let route = context.ui.router.current();

  if (route.type !== "session") {
    const location = context.location ?? context.data.location.default();
    const session = await context.client.session.create({ location });
    context.ui.router.navigate({ type: "session", sessionID: session.id });
    route = { type: "session", sessionID: session.id };
  }

  await context.client.session.prompt({ sessionID: route.sessionID, text });
}

// The stock V2 prompt dialog is 60 columns wide ("medium") and its textarea is
// pinned to a single line, which is too cramped to review a transcription.
// Widen the dialog through the public dialog options, then grow the focused
// textarea once the host has mounted and focused it. The textarea is found by
// the value we seeded, so the composer (also a textarea) is never resized.
function isSeededTextarea(renderable, text) {
  if (!renderable || typeof renderable.setText !== "function") return false;
  try {
    const value = renderable.plainText;
    if (typeof value !== "string") return false;
    return value === text || value.trim() === text.trim();
  } catch {
    return false;
  }
}

export function applyVoiceDialogLayout(context, text, dialog, logger) {
  try {
    dialog.set?.({ size: voiceDialogSize, centered: true });
  } catch (err) {
    logger?.log("STT", `Failed to resize voice dialog: ${err.message}`, "warn");
  }

  const renderer = context.renderer;
  if (!renderer) return;

  const deadline = Date.now() + 1500;
  const poll = () => {
    let focused;
    try {
      focused = renderer.currentFocusedRenderable ?? null;
    } catch {
      return;
    }
    if (isSeededTextarea(focused, text)) {
      try {
        focused.wrapMode = "word";
        focused.height = voiceDialogLines;
        focused.getLayoutNode?.().markDirty?.();
        renderer.requestRender?.();
        logger?.log("STT", `Voice dialog textarea lines=${voiceDialogLines}`, "debug");
      } catch (err) {
        logger?.log("STT", `Failed to grow voice dialog: ${err.message}`, "warn");
      }
      return;
    }
    if (Date.now() < deadline) setTimeout(poll, 10);
  };
  setTimeout(poll, 0);
}

function isTextareaRenderable(value) {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.insertText === "function" &&
    typeof value.plainText === "string"
  );
}

function sameRoute(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  return a.type !== "session" || a.sessionID === b.sessionID;
}

// Remembers the composer the user was typing in when recording started. It is
// the only reliable way to tell the prompt textarea apart from other inputs,
// because the plugin API cannot inspect the focus tree.
export function captureComposerTarget(context, logger) {
  voiceComposer = null;
  voiceRoute = null;
  if (!appendToPrompt) return;
  try {
    const focused = context.renderer?.currentFocusedRenderable ?? null;
    if (!isTextareaRenderable(focused) || focused.isDestroyed) {
      logger?.log(
        "STT",
        `No composer captured for write-back (focused=${focused?.constructor?.name ?? "none"})`,
        "debug",
      );
      return;
    }
    voiceComposer = focused;
    voiceRoute = context.ui.router.current();
    logger?.log("STT", "Captured composer for voice write-back", "debug");
  } catch (err) {
    logger?.log("STT", `Failed to capture composer: ${err.message}`, "warn");
  }
}

// Appends the transcription to the captured composer. OpenTUI's insertText is
// the same call the host makes for its internal `tui.prompt.append` event, so
// the draft state updates exactly like a normal keystroke sequence.
export function appendToComposer(context, text, logger) {
  const target = voiceComposer;
  if (!appendToPrompt) return false;
  if (!target || !isTextareaRenderable(target) || target.isDestroyed) {
    logger?.log("STT", "Write-back skipped: no live composer target", "debug");
    return false;
  }
  let route;
  try {
    route = context.ui.router.current();
  } catch {
    return false;
  }
  if (!sameRoute(voiceRoute, route)) {
    logger?.log("STT", "Write-back skipped: route changed since recording started", "debug");
    return false;
  }
  try {
    const before = target.plainText ?? "";
    const separator = before.length > 0 && !/\s$/.test(before) ? " " : "";
    target.focus?.();
    target.gotoBufferEnd?.();
    target.insertText(separator + text);
    target.getLayoutNode?.().markDirty?.();
    context.renderer?.requestRender?.();
    logger?.log("STT", `Appended transcription to prompt chars=${text.length}`, "debug");
    return true;
  } catch (err) {
    logger?.log("STT", `Failed to append to prompt: ${err.message}`, "warn");
    return false;
  }
}

async function deliverTranscription(context, text, submit) {
  if (submit) {
    await submitTranscription(context, text);
    return "sent";
  }

  if (appendToComposer(context, text, logger)) return "prompt";

  // V2 does not expose the composer to plugins yet (opencode issues #51209 and
  // #51392), so when write-back is unavailable the transcription is edited in
  // a dialog and sent on confirmation instead.
  const dialog = context.ui.dialog;
  const pending = dialog.prompt({
    title: "Voice input",
    description: "Edit the transcription, then press Enter to send it",
    value: text,
  });
  applyVoiceDialogLayout(context, text, dialog, logger);
  let edited;
  try {
    edited = await pending;
  } finally {
    try {
      dialog.set?.({ size: "medium", centered: false });
    } catch {}
  }
  if (edited === undefined) return "cancelled";
  const finalText = edited.trim();
  if (!finalText) return "cancelled";
  await submitTranscription(context, finalText);
  return "sent";
}

async function doTranscribePipeline(
  kv,
  complete,
  context,
  toast,
  systemPrompt,
  submit = false,
  logger,
) {
  processing = true;
  try {
    logger?.log("STT", `Pipeline started submit=${submit}`, "debug");
    stopRecording(logger);
    await waitForSoxExit(logger);

    toast("Transcribing...");
    const result = sttApiEndpoint ? await transcribeApi(kv, logger) : await transcribe(kv, logger);

    if (result.error) {
      logger?.log("STT", `Transcription failed: ${result.error}`, "error");
      toast(result.error, "error");
      return;
    }
    if (!result.text) {
      logger?.log("STT", "Transcription produced no text", "warn");
      toast("No speech detected", "warning");
      return;
    }

    toast("Normalizing...");
    const sessionTitle = getActiveSessionTitle(context);
    const llmResult = await normalizeTranscription(
      complete,
      result.text,
      sessionTitle,
      systemPrompt,
      logger,
    );

    if (!llmResult.text) {
      logger?.log("STT", `Normalization failed, using raw input: ${llmResult.error}`, "warn");
      toast(`Normalization failed, using raw input: ${llmResult.error}`, "warning");
      announceDelivery(await deliverTranscription(context, result.text, submit), toast);
      return;
    }

    const delivery = await deliverTranscription(context, llmResult.text, submit);
    logger?.log("STT", `Pipeline completed normalizedChars=${llmResult.text.length}`, "debug");
    announceDelivery(delivery, toast);
  } catch (err) {
    logger?.log("STT", `Pipeline error: ${err.message}`, "error");
    toast(`STT error: ${err.message}`, "error");
  } finally {
    processing = false;
    recording = false;
  }
}

function announceDelivery(delivery, toast) {
  if (delivery === "prompt") toast("Transcription added to prompt", "success");
  else if (delivery === "sent") toast("Transcription submitted", "success");
}

// ---- Public API for TUI plugin ----

export function registerSTT(context, kv, complete, prompts, opts, logger) {
  const systemPrompt = prompts?.stt || STT_SYSTEM_PROMPT;
  const backend = detectAudioBackend();
  logger?.log("STT", `Audio backend=${backend}`, "debug");
  function toast(message, variant = "info") {
    context.ui.toast.show({ message, variant, duration: 3000 });
  }

  if (opts?.sttEndpoint) {
    sttApiEndpoint = opts.sttEndpoint;
    sttApiModel = opts.sttModel || "whisper-large-v3-turbo";
    sttApiKeyEnv = opts.sttApiKeyEnv || null;
    logger?.log(
      "STT",
      `Configured STT API endpoint=${sttApiEndpoint} model=${sttApiModel}`,
      "debug",
    );
  }

  if (opts?.sttLanguage) {
    sttDefaultLanguage = opts.sttLanguage;
  }
  logger?.log("STT", `Default language=${sttDefaultLanguage}`, "debug");

  const recordKeybind = opts?.recordKeybind || "ctrl+r";
  const cancelKeybind = opts?.cancelKeybind || "ctrl+y";
  const submitKeybind = opts?.submitKeybind ?? false;
  const submitOnStop = opts?.submitOnStop === true;
  appendToPrompt = opts?.appendToPrompt !== false;
  logger?.log(
    "STT",
    `Record keybind=${recordKeybind} submit keybind=${submitKeybind} submitOnStop=${submitOnStop} appendToPrompt=${appendToPrompt}`,
    "debug",
  );

  tmpDir = opts?.tmpDir || "/tmp";
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    logger?.log("STT", `Failed to create tmpDir ${tmpDir}: ${err.message}`, "warn");
  }
  logger?.log("STT", `STT temp dir=${tmpDir}`, "debug");

  whisperBinary = opts?.whisperPath || "whisper-cli";
  logger?.log("STT", `whisper binary=${whisperBinary}`, "debug");

  if (DIALOG_SIZES.has(opts?.dialogSize)) voiceDialogSize = opts.dialogSize;
  if (Number.isFinite(opts?.dialogHeight) && opts.dialogHeight > 1) {
    voiceDialogLines = Math.min(30, Math.floor(opts.dialogHeight));
  }
  logger?.log("STT", `Voice dialog size=${voiceDialogSize} lines=${voiceDialogLines}`, "debug");

  const commands = [
    {
      id: "opencode-voice-stt.record",
      title: sttApiEndpoint ? "STT: record/transcribe (API)" : "STT: record/transcribe",
      group: "Voice",
      palette: true,
      description: submitOnStop
        ? "Toggle recording; stopping transcribes and sends the prompt"
        : sttApiEndpoint
          ? "Toggle recording; press again to stop and transcribe via API"
          : "Toggle recording; press again to stop and transcribe",
      bind: recordKeybind,
      slash: { name: "stt-record" },
      async run() {
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (recording) {
          toast("Stopping, transcribing...");
          await doTranscribePipeline(
            kv,
            complete,
            context,
            toast,
            systemPrompt,
            submitOnStop,
            logger,
          );
        } else {
          captureComposerTarget(context, logger);
          startRecording(kv, backend, toast, logger);
          if (recording) toast("Recording... press again to transcribe");
        }
      },
    },
    {
      id: "opencode-voice-stt.submit",
      title: sttApiEndpoint ? "STT: submit recording (API)" : "STT: submit recording",
      group: "Voice",
      palette: true,
      description: sttApiEndpoint
        ? "Stop recording, transcribe via API, and send the prompt"
        : "Stop recording, transcribe, and send the prompt",
      bind: submitKeybind,
      slash: { name: "stt-submit" },
      async run() {
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (!recording) {
          toast("No recording in progress", "warning");
          return;
        }
        toast("Stopping, transcribing...");
        await doTranscribePipeline(kv, complete, context, toast, systemPrompt, true, logger);
      },
    },
    {
      id: "opencode-voice-stt.cancel",
      title: "STT: cancel recording",
      group: "Voice",
      palette: true,
      description: "Cancel current recording",
      bind: cancelKeybind,
      slash: { name: "stt-stop" },
      run() {
        if (recording) {
          recording = false;
          forceKillSox(logger);
          logger?.log("STT", "Recording cancelled", "debug");
          toast("Recording cancelled");
        }
      },
    },
    {
      id: "opencode-voice-stt.model",
      title: sttApiEndpoint ? "STT: select model (API)" : "STT: select model",
      group: "Voice",
      palette: true,
      description: sttApiEndpoint ? "Choose whisper model via API" : "Choose whisper model",
      slash: { name: "stt-model" },
      async run() {
        if (sttApiEndpoint) {
          const current = kv.get("stt.api.model") || sttApiModel;
          const apiModels = await getApiModels(logger);
          const options = apiModels.length > 0 ? apiModels : [{ value: current, label: current }];
          const selected = await context.ui.dialog.select({
            title: "Select whisper model (API)",
            current,
            options: options.map((m) => ({ title: m.label, value: m.value })),
          });
          if (selected === undefined) return;
          kv.set("stt.api.model", selected);
          toast(`Whisper API model: ${selected}`);
        } else {
          const current = getModelName(kv);
          const selected = await context.ui.dialog.select({
            title: "Select whisper model",
            current,
            options: Object.entries(MODELS).map(([key, v]) => ({ title: v.label, value: key })),
          });
          if (selected === undefined) return;
          kv.set("stt.model", selected);
          toast(`Whisper model: ${MODELS[selected]?.label || selected}`);
        }
      },
    },
    {
      id: "opencode-voice-stt.language",
      title: "STT: select language",
      group: "Voice",
      palette: true,
      description: "Choose transcription language (local whisper-cli only)",
      slash: { name: "stt-language" },
      async run() {
        const current = getLanguage(kv);
        const selected = await context.ui.dialog.select({
          title: "Select transcription language",
          current,
          options: Object.entries(LANGUAGES).map(([key, v]) => ({ title: v.label, value: key })),
        });
        if (selected === undefined) return;
        kv.set("stt.language", selected);
        toast(`Whisper language: ${LANGUAGES[selected]?.label || selected}`);
      },
    },
    {
      id: "opencode-voice-stt.mic",
      title: "STT: select microphone",
      group: "Voice",
      palette: true,
      description: "Choose audio input device",
      slash: { name: "stt-mic" },
      async run() {
        const current = kv.get("stt.mic", "");
        const devices = listInputDevices(backend);
        if (devices.length === 0) {
          const serverOk = backend !== "pulseaudio" || pulseServerHealth().ok;
          const hint = buildAudioHint({ backend, serverOk, isWsl: isWSL() });
          logger?.log("STT", `No input devices: ${hint}`, "warn");
          toast(hint);
          return;
        }
        const selected = await context.ui.dialog.select({
          title: "Select microphone",
          current,
          options: [
            { title: "System default", value: "" },
            ...devices.map((d) => ({ title: d.label, value: d.name })),
          ],
        });
        if (selected === undefined) return;
        kv.set("stt.mic", selected);
        if (!selected) {
          toast("Mic: system default");
          return;
        }
        const device = devices.find((d) => d.name === selected);
        toast(`Mic: ${device?.label || selected}`);
      },
    },
  ];

  return {
    commands,
    dispose() {
      if (recording) {
        recording = false;
        forceKillSox(logger);
      }
    },
  };
}
