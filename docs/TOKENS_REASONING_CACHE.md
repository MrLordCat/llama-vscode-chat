# Tokens, Reasoning, And Prompt Cache

## Three Independent Limits

The extension does not use one number for every purpose:

| Setting | Purpose | Recommended default |
| --- | --- | --- |
| `reasoningBudget` | Maximum hidden reasoning tokens for compatible local llama.cpp servers | 16384 |
| `localDefaultMaxOutputTokens` | Normal local `max_tokens` when the session supplies no explicit value | 32768 |
| `deepSeekDefaultMaxOutputTokens` | Normal DeepSeek `max_tokens` | 65536 |
| `maxOutputTokensCap` | Absolute ceiling applied after session, model, and source limits | 131072 local / 393216 DeepSeek maximum |

`max_tokens` covers the complete generated sequence. For a reasoning model that
means hidden reasoning plus the visible answer. A local request with a 16384
reasoning cap and `max_tokens=32768` can split the available generation space
evenly between hidden reasoning and the visible answer.

The provider reserves the resolved `max_tokens` while calculating available
input context. A large hard ceiling no longer becomes the default reservation.

## Thinking Mode Mapping

| Mode | Local llama.cpp | DeepSeek |
| --- | --- | --- |
| Off | thinking disabled, budget 0 | thinking disabled |
| Light | up to 512 hidden tokens | High effort |
| Balanced | up to 2048 hidden tokens | High effort |
| Deep | up to `reasoningBudget` | Max effort |
| Auto | up to `reasoningBudget` | High effort |

For local requests the extension sends:

```json
{
  "chat_template_kwargs": {
    "enable_thinking": true,
    "preserve_thinking": true
  },
  "thinking_budget_tokens": 16384
}
```

The maintained llama.cpp server translates `thinking_budget_tokens` into its
reasoning-budget sampler when the active template exposes thinking start/end
tags. Models or servers without that support may ignore the numeric cap. The
server-wide `--reasoning-budget` option remains the ultimate fallback.

`preserve_thinking` is enabled only for detected Qwen 3.6 models and can be
disabled with `llamacpp.preserveThinking`. Reasoning chunks are internally
tagged before being forwarded to VS Code, so diagnostics count them correctly
even when a host build uses a private or renamed ThinkingPart constructor.

DeepSeek receives `thinking.type` and `reasoning_effort`; it does not receive
llama.cpp's `cache_prompt` or numeric local reasoning budget.

## Exact Local Prompt Counts

With `llamacpp.accurateTokenCounting=true`, each distinct local prompt is sent
through llama.cpp `/apply-template` with its actual messages, tools, and Qwen
template kwargs, then through `/tokenize`. The short-lived result cache avoids
repeating this work during retries. These calls perform no inference.

When either endpoint is unavailable or exceeds `tokenizerTimeoutMs`, budgeting
falls back to the character estimate. `chat.tokens.count` and the Context Usage
tooltip report whether a turn used `server` or `heuristic` counting. DeepSeek
continues to use the fallback before generation and returns authoritative usage
after the response.

## Prompt Cache Behavior

llama.cpp reuses only the identical prefix of a prompt. The extension preserves
that prefix in several ways:

- `cache_prompt=true` is sent only to local sources.
- Tool definitions are priority-sorted, compacted, count-limited, and bounded
  by `apiDirectToolTokenBudget` so the catalog remains stable and affordable.
- Retrieved shared memory is inserted immediately before the latest user turn,
  rather than rewriting the first system message.
- Raw tool results are sanitized and capped before budgeting.
- Compaction copies messages and runs only near the configured soft target.

Compaction necessarily changes the prefix once because old turns are replaced
by a summary. Later turns can reuse that new compacted prefix. Switching models,
changing system instructions, changing tool catalogs, or alternating multiple
independent chats on a single llama.cpp slot can also lower cache reuse.

## Measuring Cache Reuse

The Diagnostics group shows the last server-reported Prompt Cache value. Logs
record the same data under `chat.response.usage.promptCache`:

```json
{
  "promptTokens": 12000,
  "cachedTokens": 10800,
  "uncachedTokens": 1200,
  "hitPercent": 90
}
```

llama.cpp reports standard `prompt_tokens_details.cached_tokens`. DeepSeek's
`prompt_cache_hit_tokens` is normalized to the same shape. `n/a` means the
server omitted cache counters, not necessarily that no cache was used.

## Recommended Profiles

Quality-oriented local coding:

```json
{
  "llamacpp.thinkingMode": "deep",
  "llamacpp.reasoningBudget": 16384,
  "llamacpp.preserveThinking": true,
  "llamacpp.localDefaultMaxOutputTokens": 32768,
  "llamacpp.accurateTokenCounting": true,
  "llamacpp.cachePrompt": true,
  "llamacpp.toolCallingMode": "apiDirect",
  "llamacpp.apiDirectMaxTools": 48,
  "llamacpp.apiDirectToolTokenBudget": 12000,
  "llamacpp.apiDirectIncludeAllTools": false
}
```

Faster local turns can use Balanced without changing the cap. DeepSeek quality
uses Deep, a 65536 normal output default, and retains 393216 only as the hard
ceiling for explicitly large requests.
