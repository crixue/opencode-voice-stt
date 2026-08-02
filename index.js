// opencode-voice-stt: Speech-to-text for OpenCode.
//
// STT: Record voice via sox, transcribe with whisper-cpp, normalize with
//      an OpenAI-compatible LLM, append to the TUI prompt.
//
// Prerequisites:
//   STT: brew install whisper-cpp sox   (see README for Linux/Windows)
//
// Configuration via tui.json plugin options:
//   ["@crixue/opencode-voice-stt", { "endpoint": "...", "model": "...", "apiKeyEnv": "..." }]
//
// Runtime state (model, mic, language) persisted via api.kv.
//
// Commands:
//   /stt-record (ctrl+r)  - start/stop recording + transcribe
//   /stt-submit (leader+r)- stop recording + transcribe + submit
//   /stt-stop             - cancel recording
//   /stt-model            - select whisper model
//   /stt-language         - select transcription language
//   /stt-mic              - select microphone

import fs from "node:fs";
import os from "node:os";
import { registerSTT } from "./lib/stt.js";
import { createClient } from "./lib/llm-client.js";
import { createLogger } from "./lib/logger.js";

function loadPromptFile(filePath, logger, name) {
  if (!filePath) return null;
  const resolved = filePath.replace(/^~(?=\/|$)/, os.homedir());
  try {
    const prompt = fs.readFileSync(resolved, "utf-8").trim() || null;
    logger?.log(
      "plugin",
      prompt ? `Loaded ${name} prompt: ${resolved}` : `Ignored empty ${name} prompt: ${resolved}`,
      "debug",
    );
    return prompt;
  } catch (err) {
    logger?.log("Plugin", `Failed to load ${name} prompt ${resolved}: ${err.message}`, "warn");
    return null;
  }
}

export default {
  id: "opencode-voice-stt",
  tui: async (api, options) => {
    const { kv } = api;
    const logger = createLogger(api.client);
    logger.log("plugin", "Initializing", "debug");
    const { complete } = createClient(options, logger);

    const prompts = {
      stt: loadPromptFile(options?.sttPrompt, logger, "STT"),
    };

    const sttCommands = registerSTT(api, kv, complete, prompts, options, logger);

    api.command.register(() => sttCommands);
  },
};
