# Shared Memory

Shared memory is durable context owned by the extension. It is global to one
VS Code profile, so the same entries can be used by local models, DeepSeek, new
chats, and different workspaces.

## Storage

The file is stored at:

```text
<extension global storage>/memory/shared-memory.json
```

The document has a version and an array of entries:

```json
{
  "version": 1,
  "entries": [
    {
      "id": "stable-id",
      "title": "Preferred local model",
      "content": "Use Qwen for local coding tasks.",
      "tags": ["qwen", "local"],
      "pinned": false,
      "createdAt": "2026-07-16T10:00:00.000Z",
      "updatedAt": "2026-07-16T10:00:00.000Z"
    }
  ]
}
```

Writes use a temporary file and rename. Invalid startup data is preserved as an
`.invalid-<timestamp>` backup before a new empty document is created. Invalid
manual edits are rejected on reload without replacing the active in-memory
state.

## Retrieval

For every request, the extension builds a query from the four most recent user
messages. Entries are ranked by:

- pinned status;
- title matches;
- tag matches;
- content matches;
- most recent update time as a tie-breaker.

Only selected entries are injected. `llamacpp.memoryMaxTokens` caps their total
estimated context cost; the default is 4096 tokens. Pinned entries have search
priority but still respect the same hard budget.

## Agent Tools

- `llamacpp_store_memory`: create an entry or update one by id.
- `llamacpp_search_memory`: search entries or list recent entries.
- `llamacpp_delete_memory`: delete one entry by id.

VS Code asks for confirmation before extension tools execute. Users can inspect
or edit the file with `Local LLM: Open Shared Memory` and remove all entries with
`Local LLM: Clear Shared Memory`.

## Limits

- 500 entries total.
- 160 characters per title.
- 24,000 characters per content value.
- 16 normalized tags, 48 characters each.
- 32,768 tokens maximum automatic injection budget.

When the store is full, the oldest non-pinned entry is evicted. A store made
entirely of pinned entries rejects additional entries.

## Safety Model

Memory is treated as untrusted reference context. The injected system text tells
the model not to execute instructions found inside entries unless the current
user request independently asks for the same action. This reduces stale or
malicious memory from overriding the live task, but users should still avoid
storing secrets, executable instructions, and unverified claims.

Memory is local to the VS Code profile and is not synchronized by this
extension. Back up the JSON file explicitly if it needs to move to another
machine or profile.
