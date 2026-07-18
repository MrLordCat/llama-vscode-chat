# Codex Subscription Provider

The extension can expose models from an existing ChatGPT/Codex subscription in
the VS Code and Copilot Chat model picker. This is a separate provider from the
local OpenAI-compatible and DeepSeek transports.

## What Subscription Access Means

ChatGPT subscription access is not an OpenAI API key. The extension launches
the official `codex app-server --stdio` process and uses its JSON-RPC surface.
Codex owns browser login, refresh tokens, model discovery, rate limits, and the
inner agent loop. Native command, search, file, web, and memory tools remain
owned by the outer Copilot session when delegation is enabled.

The extension never reads, copies, logs, or stores the contents of
`~/.codex/auth.json`. It validates `account/read` and requires
`account.type == "chatgpt"`, then keeps that validated state for at most five
minutes and invalidates it on logout or app-server restart. API-key and Bedrock
sessions are deliberately rejected by this provider so they cannot cause
unexpected metered API usage.

Official references:

- [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

## Runtime Architecture

```text
Copilot Chat UI
  -> llamacpp composite LanguageModelChatProvider
     -> codex:: model routing
     -> local codex app-server over JSONL/stdin
        -> ChatGPT-managed Codex service
        -> Codex shell, file edits, web, MCP, skills, and sandbox
```

Copilot Chat owns the visible and durable chat history. The first provider
request creates an ephemeral Codex thread and supplies the current VS Code
conversation as serialized data. Native tool-result rounds reuse that in-memory
thread and send only the matching result tail. A normal follow-up user turn also
reuses the thread when the prior history and answer are unchanged. Switching
among local, DeepSeek, and Codex models remains predictable without repeatedly
uploading the full chat during an agent run.

Codex owns the inner agent loop. Through the app-server experimental
`dynamicTools` protocol, it selects directly from the tools advertised by the
outer Copilot request. The provider emits the selection as a
`LanguageModelToolCallPart` and suspends the current provider response while the
app-server turn stays alive. Copilot then renders and executes the tool through
its standard agent loop. The following provider round contains the native
result and resolves the still-pending app-server dynamic tool request. Parallel
requests are emitted together and resume only after every matching result is
available. The original Codex turn continues directly: there is no interrupt,
second `turn/start`, serialized continuation prompt, or full-history prefill.
Continuations are matched by unique native tool call ids, time out after 30
minutes if abandoned, and are never persisted as chat history.

Copilot can advertise a very large catalog (95 tools in the measured baseline).
By default, the provider marks uncommon schemas with app-server
`deferLoading` inside the `vscode_deferred` namespace, while keeping workspace
reads, searches, terminal commands, edits, web verification, user input, and
planning immediately visible. Codex's built-in tool search loads a deferred
schema only when it is needed. Disable
`llamacpp.codexDeferNonCoreTools` if an older custom CLI does not support this
experimental app-server field.

Completed conversation threads stay available in memory for up to four hours
(maximum 16). Reuse requires matching SHA-256 history and answer digests, model,
workspace, sandbox, approval policy, dynamic tool catalog, and app-server
process generation. Editing or regenerating an earlier turn, changing runtime
configuration, restarting Codex, or missing the cache starts a fresh thread with
the bounded full Copilot history. Quick Access reports both the in-process
thread-reuse ratio and the last prompt-cache percentage returned by Codex.

This design also supports private caller tools that are not present in
`vscode.lm.tools`, including Copilot's terminal implementation. Native calls use
the session's own permission level, terminal auto-approval rules, and `Bypass
Approvals`. While delegation is active, internal Codex command and file approval
requests are declined without an extra modal prompt so Codex can select the
matching outer tool instead.

Agent commentary and reasoning summaries are emitted through the native VS Code
thinking stream when that API is available. Final answer text and server token
usage are emitted through the normal language-model response stream.

## Setup

The provider resolves the executable in this order:

1. `llamacpp.codexCliPath`
2. Codex bundled with the official `openai.chatgpt` VS Code extension
3. `codex` on `PATH`

Use `Local LLM: Sign In to Codex Subscription` for a managed browser OAuth
flow. An existing ChatGPT session created with `codex login` is shared
automatically. Signing out from the extension also signs out that shared local
Codex CLI session.

Use `Local LLM: Show Codex Subscription Status` to verify the ChatGPT plan and
current Codex rate-limit window. OAuth tokens and the account email are not
shown or written to extension logs.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `llamacpp.enableCodexSubscription` | `true` | Advertise subscription-backed Codex models. |
| `llamacpp.codexCliPath` | empty | Optional explicit Codex executable. |
| `llamacpp.codexReasoningEffort` | `auto` | Use model default or a supported effort. |
| `llamacpp.codexReasoningSummary` | `auto` | Thinking summary detail. |
| `llamacpp.codexSandboxMode` | `workspace-write` | Runtime filesystem sandbox. |
| `llamacpp.codexApprovalPolicy` | `on-request` | Runtime approval behavior. |
| `llamacpp.codexFastServiceTier` | `false` | Request priority service when offered; uses quota faster. |
| `llamacpp.codexEphemeralThreads` | `true` | Avoid duplicating Copilot-owned histories. |
| `llamacpp.codexContextLength` | `258400` | Context advertised to VS Code. |
| `llamacpp.codexMaxInputChars` | `600000` | Serialized conversation limit below the app-server hard request limit. |
| `llamacpp.codexMaxToolResultChars` | `12000` | Per-result history cap that preserves more conversational turns. |
| `llamacpp.codexUseVsCodeTools` | `true` | Delegate Codex-selected tools to Copilot's native tool loop and approvals. |
| `llamacpp.codexDeferNonCoreTools` | `true` | Keep core coding tools eager and load uncommon schemas through Codex tool search. |
| `llamacpp.codexMaxOutputTokens` | `32768` | Reply reserve advertised to VS Code. |

The model catalog supplies the supported Thinking Effort values dynamically.
The native per-chat selector takes precedence over the global default. If an
effort is unavailable for a selected model, the provider falls back to that
model's catalog default.

`danger-full-access` and `never` approvals are available for advanced local
workflows but are not recommended defaults. `workspace-write` with `on-request`
keeps normal project edits ergonomic while requiring approval for escalation.

## Troubleshooting

### No Codex models in the picker

Run `Local LLM: Show Codex Subscription Status`. A valid state is
`Connected (<plan>)`. Then run `Local LLM: Refresh Models`.

If the status says `API auth blocked`, run `codex logout`, then sign in with a
ChatGPT account through `codex login` or the extension command. This provider
does not use `OPENAI_API_KEY`.

### Codex CLI cannot be started

Install the official OpenAI extension, install `@openai/codex`, or set an
absolute `llamacpp.codexCliPath`. After changing the path, reload VS Code and
refresh models.

### Commands or searches remain inside the thinking block

Confirm that `llamacpp.codexUseVsCodeTools` is enabled. A command routed through
the native bridge produces `codex.chat.tool_delegated` and a normal Copilot tool
card. Copilot then executes it using the current session approval mode. An
`codex.internal_tool.declined` event means Codex first selected an internal tool;
the provider rejected it so the model can retry with the matching outer tool.

### Context display differs from the runtime

The current runtime reports a 258400-token window. The advertised value is
configurable because future models or Codex versions may differ. Actual usage
from `thread/tokenUsage/updated` is returned after every completed turn.

### Input exceeds 1048576 characters

Copilot may pass a long chat containing large tool results as more than one
million serialized characters even when its token indicator is still below the
model context window. The provider keeps the first and newest messages, omits
older middle history, and truncates the newest message only as a last resort.
Before dropping messages it bounds individual historical tool results, which
usually keeps all user and assistant turns available.
`llamacpp.codexMaxInputChars` defaults to `600000`, leaving room for app-server
protocol overhead. The `codex.chat.start` log event records original and final
character counts plus omitted and truncated message and image counts. Images
belonging to omitted history messages are not resent.
