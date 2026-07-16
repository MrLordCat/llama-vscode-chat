# Copilot Chat Integration

## Purpose

VS Code can consume extension-contributed language models through the stable
`LanguageModelChatProvider` API, but bundled Copilot Chat keeps part of its
native model UI behind an internal endpoint wrapper. This project integrates
with that wrapper in two ways:

1. the extension uses supported response metadata for native context usage;
2. an optional guarded patch exposes controls that the public provider API
   cannot currently describe.

The context counter does not require the Copilot patch. Thinking Effort and the
provider-specific output limit do.

## Native Context Usage

Every streamed request sends:

```json
{
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

Both llama.cpp's OpenAI-compatible server and DeepSeek return a final SSE chunk
with an empty `choices` array and a `usage` object. The extension validates and
forwards it as a `LanguageModelDataPart` with MIME type `usage`:

```json
{
  "prompt_tokens": 120,
  "completion_tokens": 30,
  "total_tokens": 150,
  "prompt_tokens_details": {
    "cached_tokens": 80
  }
}
```

Copilot Chat uses this data for the native Session Info panel. If an otherwise
compatible server does not return usage, the provider sends a conservative
character-based estimate so the panel does not stay at `0 / N tokens`.

The context-window denominator comes from the model metadata advertised by the
provider. For local models this is resolved from runtime server metadata when
available; the configured fallback is used otherwise.

## Optional Bundle Patch

`scripts/patch-copilot-chat.mjs` modifies only Copilot Chat's wrapper for the
`llamacpp` vendor. Patch v2 makes three changes:

- `maxOutputTokens` uses the limit advertised by the selected model instead of
  the wrapper's fixed 8192-token value;
- `supportsReasoningEffort` exposes native session choices;
- the selected effort is forwarded as `modelOptions.reasoningEffort` to this
  extension.

The extension maps native values to its request modes:

| Native value | Extension mode |
| --- | --- |
| `none` | `off` |
| `low` | `light` |
| `medium` | `balanced` |
| `high`, `max` | `deep` |

Local models expose `None`, `Low`, `Medium`, and `High`. DeepSeek exposes
`High` and `Max`. The session value overrides `llamacpp.thinkingMode` only for
that chat request.

## Apply And Restore

Run from the repository with the Node environment used to build the extension:

```sh
npm run patch:copilot:status
npm run patch:copilot
npm run patch:copilot:restore
```

The patcher locates the active Windows VS Code installation through `code.cmd`.
For a portable or test build, pass the application root explicitly:

```sh
npm run patch:copilot:status -- --root <path>
npm run patch:copilot -- --root <path>
```

Run `Developer: Reload Window` in every open VS Code window after applying or
restoring the patch.

## Safeguards

Before writing, the patcher:

1. checks the Copilot manifest and expected wrapper structure;
2. requires every minified-code anchor to be unique;
3. changes only the identified extension-endpoint class;
4. validates the resulting JavaScript with `node --check`;
5. creates `extension.js.llama-vscode-chat.backup` beside the bundle;
6. records Copilot version and original/patched SHA-256 hashes in a JSON file.

The patch is deliberately fail-closed. If a Copilot update changes the bundle
shape, the script stops instead of applying a broad replacement. VS Code
updates normally install a new application directory, so run `status` and
reapply after each update.

The implementation has been exercised against the local VS Code 1.127 / bundled
Copilot Chat 0.55 installation and the repository's VS Code 1.129 test host with
Copilot Chat 0.57. These are verification snapshots, not a promise that future
minified bundles retain the same structure.

## Troubleshooting

### Session Info Shows `0 / N tokens`

1. Install the newest VSIX and reload the window.
2. Send a new chat turn; old responses cannot be retroactively annotated.
3. Open the latest extension log and find `chat.response.usage`.
4. `source: "server"` means exact upstream counters were used.
5. `source: "estimate"` means the server omitted its final usage chunk.

The denominator can be correct while usage stays zero: model limits and response
usage travel through separate metadata paths.

### Context Window Is Wrong

Check the selected model tooltip and Quick Access context breakdown. For a local
llama.cpp server, verify `/v1/models` and `/slots` expose the active runtime
context. Set `llamacpp.localContextLength` only as a fallback or explicit local
override.

### Thinking Effort Is Missing

Run `npm run patch:copilot:status`. If the patch is applied, reload all VS Code
windows and start a new chat session with a model from this provider.

### VS Code Was Updated

The new installation has a new Copilot bundle. Re-run `status`, then `apply`.
Do not copy a patched bundle from an older VS Code build.

## Ownership Boundary

The VSIX owns model discovery, routing, prompts, tools, memory, streaming,
context usage, and diagnostics. The external patch owns only the missing native
Copilot controls. Keeping this boundary narrow makes the extension usable
without modifying VS Code and makes restoration deterministic.
