// opencode-voice-stt: Speech-to-text for OpenCode V2.
//
// STT: Record voice via sox, transcribe with whisper-cpp, normalize with
//      an OpenAI-compatible LLM, then submit it as a prompt (or edit it in a
//      dialog first when submitOnStop is off).
//
// Prerequisites:
//   STT: brew install whisper-cpp sox   (see README for Linux/Windows)
//
// Configuration via cli.json plugin options:
//   { "plugins": [{ "package": "@crixue/opencode-voice-stt", "options": { ... } }] }
//
// Runtime state (model, mic, language) persisted via context.storage.
//
// Commands:
//   /stt-record (ctrl+r)   - start/stop recording + transcribe + send
//   /stt-submit            - stop recording + transcribe + send
//   /stt-stop (ctrl+y)     - cancel recording
//   /stt-model             - select whisper model
//   /stt-language          - select transcription language
//   /stt-mic               - select microphone

import { Plugin } from "@opencode/plugin/tui";
import { createPluginDefinition } from "./lib/plugin.js";

export default Plugin.define(createPluginDefinition());
