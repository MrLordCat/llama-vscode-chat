# Llama.cpp Provider for GitHub Copilot Chat

This extension connects OpenAI-compatible Llama.cpp endpoints to VS Code Chat.

## Features

- Streaming chat responses.
- Tool calling with compatibility fallback for strict chat templates.
- Context-aware compaction and overflow retry.
- Thinking controls for compatible models (for example Qwen):
  - `thinkingMode`
  - `reasoningBudget`
- Quick Actions view in the Activity Bar.

## Requirements

- VS Code 1.104.0 or newer.
- Running Llama.cpp server with OpenAI-compatible API:
  - `GET /v1/models`
  - `POST /v1/chat/completions`

## Quick Start

1. Open command palette and run `Llama.cpp: Open Sidebar`.
2. Run `Manage Llama.cpp Provider` and set server URL.
3. Select a Llama.cpp model in chat model picker.
4. Start chatting.

## Configuration

Main settings are under `llamacpp.*` in VS Code Settings.

- Context management:
  - `autoCompact`
  - `retryOnContextOverflow`
  - `contextUtilization`
  - `hardContextUtilization`
  - `compactKeepLastTurns`
  - `hardCompactKeepLastTurns`
  - `maxOutputTokensCap`
  - `minReplyReserveTokens`
  - `maxToolsPerRequest`
  - `requestTimeoutMs`
- Reasoning:
  - `thinkingMode`: `auto | off | light | balanced | deep`
  - `reasoningBudget`: `0..65536`
- Tool-result transport mode:
  - `toolResultMode`: `auto | tool | user`
  - `auto` starts with `role=tool` and falls back to `role=user` when backend chat template rejects tool-role messages.

## Recommended Profile For Large Context Agent Work

If you use this model as a daily coding agent with long sessions:

- Keep `autoCompact = true`.
- Keep `retryOnContextOverflow = true`.
- Start with:
  - `contextUtilization = 0.85`
  - `hardContextUtilization = 0.72`
  - `compactKeepLastTurns = 12`
  - `hardCompactKeepLastTurns = 6`
- Use `toolResultMode = auto` unless your model already reliably supports `role=tool`.
- Use `thinkingMode = balanced` (or `auto`) for better latency/quality balance.

## Known Limitation: Context Usage In VS Code Chat

You may see current context usage shown as `0` in VS Code Chat for third-party providers, while GitHub Copilot models display usage.

- This extension still performs internal token estimation and context budgeting before each request.
- The built-in usage indicator behavior for custom providers is currently limited and may not reflect real usage even when requests are processed correctly.

## Development

1. Clone the repository.

```sh
git clone https://github.com/mbeps/llama-vscode-chat.git
cd llama-vscode-chat
```

1. Install dependencies.

```sh
npm install
```

1. Compile.

```sh
npm run compile
```

1. Run tests.

```sh
npm run test
```

1. Package local VSIX.

```sh
npx @vscode/vsce package -o llama-vscode-chat-local.vsix
```

## References

- [Llama.cpp](https://github.com/ggerganov/llama.cpp)
- [VS Code Extension API](https://code.visualstudio.com/api)
