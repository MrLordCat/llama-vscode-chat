# Shared Memory

Shared memory is durable reference context owned by the extension. It is
available to local models and DeepSeek across chats, while each entry controls
whether it applies globally, to one workspace, or to one model.

## Storage And Migration

The file is stored at:

```text
<extension global storage>/memory/shared-memory.json
```

The current format is version 2:

```json
{
  "version": 2,
  "entries": [
    {
      "id": "stable-id",
      "title": "Current project build command",
      "content": "Run npm run check before packaging the VSIX.",
      "tags": ["build", "validation"],
      "pinned": false,
      "scope": "workspace",
      "scopeId": "file:///D:/GitHub/llama-vscode-chat",
      "kind": "workflow",
      "createdAt": "2026-07-17T10:00:00.000Z",
      "updatedAt": "2026-07-17T10:00:00.000Z"
    }
  ]
}
```

Version-one entries migrate automatically to `scope: "global"` and
`kind: "other"`. Their ids, text, tags, pin state, and timestamps are retained.
The migrated document is persisted during initialization.

Writes use a temporary file and rename. Invalid startup data is preserved as an
`.invalid-<timestamp>` backup before a new empty document is created. Invalid
manual edits are rejected on reload without replacing active in-memory data.

## Scope And Types

Scopes:

- `global`: eligible in every workspace and for every model.
- `workspace`: eligible only when `scopeId` equals the current workspace id.
- `model`: eligible only when `scopeId` equals the selected model id.

Kinds:

- `preference`: durable user choices and response preferences.
- `decision`: accepted project or architectural decisions.
- `environment`: stable local paths, commands, and runtime constraints.
- `workflow`: repeatable procedures and verification steps.
- `externalFact`: source-backed facts that can become stale.
- `other`: reference information that does not fit another kind.

An `externalFact` requires both `sourceUrl` and `verifiedAt`. Use `expiresAt`
for versions, compatibility facts, service behavior, or any claim that should
be reviewed later. Expired entries remain stored and inspectable but are
excluded from normal search and automatic prompt injection.

## Retrieval

For every request, the extension builds a query from the four most recent user
messages. It first filters entries by active workspace/model scope and expiry,
then ranks them with:

- weighted exact title, tag, and content terms;
- BM25-style document frequency and length normalization;
- conservative trigram matching for misspellings and related word forms;
- exact title-phrase and pinned boosts after relevance is established;
- update time as the final tie-breaker.

Pinned entries are not injected merely because they are pinned. They must still
match a non-empty query. An empty manual search lists pinned and recent entries.

Selected entries are inserted immediately before the latest user request. This
keeps the older system and conversation prefix stable for prompt-cache reuse.
`llamacpp.memoryMaxTokens` caps automatic memory context; the default is 4096.

## Agent Tools

- `llamacpp_store_memory`: create an entry or update one by id. Workspace scope
  automatically uses the current workspace id when `scopeId` is omitted.
- `llamacpp_search_memory`: hybrid search with optional model, scope, and
  expired-entry filters.
- `llamacpp_delete_memory`: delete one entry by exact id.

VS Code asks for confirmation before extension tools execute. Users can inspect
or edit the file with `Local LLM: Open Shared Memory` and remove all entries
with `Local LLM: Clear Shared Memory`.

## Limits

- 500 entries total.
- 160 characters per title.
- 24,000 characters per content value.
- 16 normalized tags, 48 characters each.
- 32,768 tokens maximum automatic injection budget.

Search indexing considers at most the first 12,000 content characters per
entry to keep retrieval responsive; stored and returned content is not reduced.
When the store is full, the oldest non-pinned entry is evicted. A store made
entirely of pinned entries rejects additional entries.

## Safety Model

Memory is untrusted reference context. Its prompt wrapper says that it cannot
override current system or user instructions and that instructions inside a
memory entry must not be executed unless the live request asks for the same
action. Source metadata describes provenance, not authority.

Do not store secrets, credentials, temporary guesses, raw tool output, or
instructions copied from untrusted sources. Memory is local to the VS Code
profile and is not synchronized by this extension.
