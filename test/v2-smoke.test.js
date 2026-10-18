// V2 port smoke tests.
//
// They validate the plugin definition, command registration, and storage
// wiring against a fake plugin context. The definition itself has no host
// import, so these run anywhere. One extra test verifies the module export
// consumed by OpenCode; it needs "@opencode/plugin/tui" (or a stub) under
// node_modules and is skipped otherwise.

import assert from "node:assert/strict";
import test from "node:test";

import { createPluginDefinition } from "../lib/plugin.js";
import { applyVoiceDialogLayout, appendToComposer, captureComposerTarget } from "../lib/stt.js";

let moduleExport = null;
try {
  moduleExport = (await import("../index.js")).default;
} catch {
  // The OpenCode runtime provides "@opencode/plugin/tui"; plain Node needs a stub.
}

function createFakeContext(options = {}) {
  const store = {};
  const registered = [];
  const toasts = [];

  const context = {
    options,
    location: undefined,
    app: { version: "0.0.0", channel: "test" },
    client: {
      session: {
        create: async () => ({ id: "ses_test" }),
        prompt: async () => ({}),
        message: { get: async () => ({ content: [] }) },
      },
    },
    data: {
      on: () => () => {},
      session: {
        list: () => [],
        get: () => undefined,
        message: { list: () => [] },
      },
      location: { default: () => ({ directory: process.cwd() }) },
    },
    keymap: {
      layer(factory) {
        const layer = factory();
        registered.push(...(layer.commands ?? []));
      },
    },
    storage: {
      store: () => [
        store,
        (mutation) => {
          mutation(store);
          return Promise.resolve();
        },
      ],
    },
    ui: {
      toast: { show: (toast) => toasts.push(toast) },
      dialog: {
        select: async () => undefined,
        prompt: async () => undefined,
        clear: () => {},
      },
      router: {
        current: () => ({ type: "session", sessionID: "ses_test" }),
        navigate: () => {},
      },
    },
  };

  return { context, store, registered, toasts };
}

test(
  "index.js exports a V2 plugin definition",
  { skip: moduleExport ? false : "host module not resolvable" },
  () => {
    assert.equal(moduleExport.id, "opencode-voice-stt");
    assert.equal(typeof moduleExport.setup, "function");
  },
);

test("definition registers every STT command", async () => {
  const { context, registered } = createFakeContext();
  const plugin = createPluginDefinition();
  const cleanup = await plugin.setup(context);

  const ids = registered.map((command) => command.id).sort();
  assert.deepEqual(ids, [
    "opencode-voice-stt.cancel",
    "opencode-voice-stt.language",
    "opencode-voice-stt.mic",
    "opencode-voice-stt.model",
    "opencode-voice-stt.record",
    "opencode-voice-stt.submit",
  ]);

  for (const command of registered) {
    assert.equal(typeof command.run, "function", `${command.id} has a run function`);
    assert.ok(command.slash?.name, `${command.id} keeps its slash command`);
    assert.ok(
      command.bind === undefined || command.bind === false || typeof command.bind === "string",
    );
  }

  assert.equal(typeof cleanup, "function");
  await cleanup();
});

test("record command exposes the configured keybind", async () => {
  const { context, registered } = createFakeContext({ recordKeybind: "ctrl+shift+r" });
  const plugin = createPluginDefinition();
  await plugin.setup(context);

  const record = registered.find((command) => command.id === "opencode-voice-stt.record");
  assert.equal(record.bind, "ctrl+shift+r");
});

test("selecting a model persists the choice through storage", async () => {
  const { context, store, registered } = createFakeContext();
  const plugin = createPluginDefinition();
  await plugin.setup(context);

  // The record keybind is the configured default.
  const record = registered.find((command) => command.id === "opencode-voice-stt.record");
  assert.equal(record.bind, "ctrl+r");

  context.ui.dialog.select = async () => "tiny.en";
  const model = registered.find((command) => command.id === "opencode-voice-stt.model");
  await model.run();
  assert.equal(store["stt.model"], "tiny.en");
});

function createFakeRenderer(textarea) {
  const calls = [];
  return {
    calls,
    get currentFocusedRenderable() {
      return textarea;
    },
    requestRender: () => calls.push("render"),
  };
}

test("voice dialog widens and grows the seeded textarea", async () => {
  const { context } = createFakeContext();
  const calls = [];
  const textarea = {
    plainText: "hello world",
    setText() {},
    wrapMode: "none",
    height: 1,
    getLayoutNode: () => ({ markDirty: () => calls.push("dirty") }),
  };
  const renderer = createFakeRenderer(textarea);
  context.renderer = renderer;
  const dialog = { set: (options) => calls.push(["set", options]) };

  applyVoiceDialogLayout(context, "hello world", dialog, null);
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(calls[0], ["set", { size: "xlarge", centered: true }]);
  assert.equal(textarea.height, 8);
  assert.equal(textarea.wrapMode, "word");
  assert.ok(calls.includes("dirty"));
  assert.ok(renderer.calls.includes("render"));
});

test("voice dialog leaves an unrelated focused textarea alone", async () => {
  const { context } = createFakeContext();
  const composer = {
    plainText: "existing draft",
    setText() {},
    wrapMode: "none",
    height: 4,
  };
  const renderer = createFakeRenderer(composer);
  context.renderer = renderer;

  applyVoiceDialogLayout(context, "hello world", { set: () => {} }, null);
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(composer.height, 4);
  assert.equal(composer.wrapMode, "none");
  assert.deepEqual(renderer.calls, []);
});

function createFakeComposer(initial = "existing") {
  const inserted = [];
  const composer = {
    plainText: initial,
    isDestroyed: false,
    inserted,
    insertText(text) {
      inserted.push(text);
      composer.plainText += text;
    },
    gotoBufferEnd() {},
    focus() {},
    getLayoutNode: () => ({ markDirty() {} }),
  };
  return composer;
}

test("voice write-back appends to the composer captured at record start", () => {
  const { context } = createFakeContext();
  const composer = createFakeComposer("existing");
  context.renderer = { currentFocusedRenderable: composer, requestRender() {} };

  captureComposerTarget(context, null);
  assert.equal(appendToComposer(context, "hello world", null), true);
  assert.deepEqual(composer.inserted, [" hello world"]);
  assert.equal(composer.plainText, "existing hello world");
});

test("voice write-back skips the separator after whitespace", () => {
  const { context } = createFakeContext();
  const composer = createFakeComposer("existing\n");
  context.renderer = { currentFocusedRenderable: composer, requestRender() {} };

  captureComposerTarget(context, null);
  assert.equal(appendToComposer(context, "hello", null), true);
  assert.deepEqual(composer.inserted, ["hello"]);
});

test("voice write-back refuses a different session", () => {
  const { context } = createFakeContext();
  const composer = createFakeComposer("");
  context.renderer = { currentFocusedRenderable: composer, requestRender() {} };

  captureComposerTarget(context, null);
  context.ui.router.current = () => ({ type: "session", sessionID: "ses_other" });

  assert.equal(appendToComposer(context, "hello", null), false);
  assert.deepEqual(composer.inserted, []);
});

test("voice write-back is skipped when no composer was focused", () => {
  const { context } = createFakeContext();
  context.renderer = { currentFocusedRenderable: null, requestRender() {} };

  captureComposerTarget(context, null);
  assert.equal(appendToComposer(context, "hello", null), false);
});
