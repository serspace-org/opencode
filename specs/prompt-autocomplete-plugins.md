# Plugin-Provided Prompt Autocomplete

Design proposal for allowing OpenCode plugins to contribute asynchronous
typeahead providers to the primary prompt input.

The motivating use case is a Serspace provider: typing `#` (or another
configured trigger) searches people, projects, tasks, and goals, then inserts
the selected entity as structured prompt context. The design is intentionally
generic so the same mechanism can support issue trackers, documentation
systems, databases, and other project-specific reference sources.

## Status

Proposed. This document describes an upstream-capable extension; it is not an
implementation plan approved by OpenCode maintainers.

## Goals

- Let server plugins register one or more prompt autocomplete providers.
- Support a distinct trigger such as `#` without changing the existing `@`
  file, agent, reference, and MCP-resource behavior.
- Support provider-owned asynchronous search, including remote APIs and
  authenticated databases.
- Use one protocol contract for the web composer and TUI.
- Preserve structured identity and metadata when a user selects a result.
- Keep provider credentials and database access on the server side.
- Make provider failures non-fatal to prompt editing and submission.
- Allow providers to return ordinary text selections as well as structured
  context selections.

## Non-goals

- Replacing the existing `@` file search implementation.
- Making plugins execute arbitrary browser JavaScript.
- Sending an entire external database into the model prompt.
- Making every autocomplete result an LLM tool call.
- Defining a Serspace-specific protocol in the OpenCode core.

## Ecosystem Review

### Upstream requests

Upstream issue [#5558](https://github.com/anomalyco/opencode/issues/5558)
proposed a `"autocomplete.provide"` plugin hook with custom triggers,
provider-owned filtering, and completion items containing display text, an
inserted value, and a description. The issue was automatically closed after 90
days of inactivity. It was not closed because the feature shipped, and it has
no implementation pull request.

The proposal here follows that direction but changes two important details:

1. Providers are queried through the OpenCode server rather than exposing the
   plugin runtime directly to the browser.
2. A result has an explicit selection payload, allowing structured context to
   be preserved instead of flattening every entity to text.

Upstream `$skill` work demonstrates that adding another built-in trigger is
possible, but it is a host-owned feature rather than a plugin extension point:

- [Issue #20982](https://github.com/anomalyco/opencode/issues/20982)
- [PR #29217](https://github.com/anomalyco/opencode/pull/29217)

### Current plugin system

The legacy server plugin API in `packages/plugin/src/index.ts` supports tools,
commands, events, provider extensions, and message/model hooks. It does not
support autocomplete providers. `tool` is the closest existing primitive, but
tools are selected by the model after submission and cannot participate in
interactive prompt editing.

The V2 plugin API has a command transformation boundary in
`packages/plugin/src/v2/effect/command.ts`, but commands are not a general
suggestion registry. Commands are appropriate for `/name` templates, not
low-latency query-backed entity lookup.

TUI plugins can register slots, routes, dialogs, and keybindings through
`packages/plugin/src/tui.ts`. They can replace or surround prompt UI, but
there is no provider API for the built-in prompt and no equivalent web-app
plugin runtime.

### Current web prompt

The web prompt has two implementations during the current migration:

- The legacy composer in `packages/app/src/components/prompt-input.tsx` owns
  `AtOption`, the `@` provider list, slash-command list, filtering, and
  selection behavior.
- The V2 composer delegates interaction to
  `packages/session-ui/src/v2/components/prompt-input/interaction.ts`.
  It already accepts `PromptInputV2Suggestion[]`, async file search, and an
  `onSuggestionSelect` callback.

The V2 seam is the preferred foundation. However,
`PromptInputV2Suggestion.kind` is currently a closed union of `agent`,
`command`, `file`, `reference`, and `resource`, and mention insertion only
accepts file and agent parts. A plugin result cannot currently be represented
without changing those shared contracts.

The current app adapter in
`packages/app/src/components/prompt-input-v2.tsx` constructs all context
suggestions locally. It has no call to a provider registry or autocomplete
endpoint.

### Current protocol and client

The command API in `packages/protocol/src/groups/command.ts` demonstrates the
normal current architecture: define a schema, add an HTTP endpoint, implement
the handler, regenerate the client, and consume the generated client from the
host UI. Custom autocomplete should follow this path rather than introduce a
web-only fetch convention.

## Proposed Architecture

```text
prompt editor
    |
    | trigger + query + location
    v
autocomplete client API
    |
    | server-side provider dispatch
    v
plugin autocomplete providers
    |
    v
Serspace API / database / issue tracker / other service
```

The editor owns trigger detection, cancellation, keyboard navigation, and
rendering. The server owns provider discovery, plugin execution, credentials,
timeouts, and result normalization. The selected result is returned to the
editor as a typed selection that can become a prompt part.

## Core Contracts

The following are conceptual TypeScript contracts. The wire versions should be
Effect schemas in `packages/schema`, not handwritten client-only interfaces.

### Provider identity and registration

```ts
export type AutocompleteTrigger = {
  value: string
  description?: string
  // A single character such as "#" is the initial supported form.
  // Prefix triggers can be added later without changing result semantics.
  kind: "character" | "prefix"
}

export type AutocompleteProviderInfo = {
  id: string
  trigger: AutocompleteTrigger
  title: string
  description?: string
  priority?: number
  maxResults?: number
  cacheTTL?: number
}

export type AutocompleteProvider = {
  info: AutocompleteProviderInfo
  search(input: AutocompleteSearchInput): Promise<AutocompleteSearchResult>
}
```

Provider IDs must be stable and namespaced by plugin identity, for example
`serspace.entities`. Trigger collisions must be rejected during registration;
silently choosing the first plugin makes configuration order observable and is
hard to debug.

### Search request and result

```ts
export type AutocompleteSearchInput = {
  providerID: string
  trigger: string
  query: string
  directory: string
  workspaceID?: string
  sessionID?: string
  signal: AbortSignal
}

export type AutocompleteSearchResult = {
  items: AutocompleteItem[]
  stale?: boolean
}

export type AutocompleteItem = {
  id: string
  label: string
  description?: string
  group?: string
  icon?: string
  detail?: string
  selection: AutocompleteSelection
}

export type AutocompleteSelection =
  | {
      type: "text"
      text: string
    }
  | {
      type: "context"
      content: string
      display: string
      source: {
        providerID: string
        entityType: string
        entityID: string
        metadata?: Record<string, string>
      }
    }
```

`id` is a provider-local stable key for rendering and selection reconciliation;
it must not be treated as globally unique. `selection.source` is the durable
identity needed to resolve or audit the selected entity later.

The initial implementation should not allow arbitrary plugin-defined prompt
parts on the wire. The `context` selection should be represented by a generic
external-reference part with a bounded JSON metadata payload. This avoids
making the core schema depend on Serspace or any one external system.

### Plugin hook

The legacy server plugin shape could add the following hook:

```ts
export type AutocompleteHook = {
  register?: (register: AutocompleteRegistry) => void
}

export type AutocompleteRegistry = {
  add(provider: AutocompleteProvider): () => void
}

export interface Hooks {
  autocomplete?: AutocompleteHook
}
```

A simpler public shape is also possible:

```ts
export interface Hooks {
  "autocomplete.provide"?: (
    input: AutocompleteSearchInput,
  ) => Promise<AutocompleteSearchResult>
}
```

The registry form is preferable because it makes provider metadata explicit,
supports multiple triggers/providers per plugin, and permits the host to
validate collisions before handling requests. It also gives the host a clear
disposal boundary.

### Protocol endpoint

The protocol should expose provider discovery and query separately:

```ts
GET /api/autocomplete/providers
  -> Array<AutocompleteProviderInfo>

GET /api/autocomplete/search
  ?provider=<providerID>
  &trigger=<trigger>
  &query=<query>
  &location=<location>
  &sessionID=<sessionID>
  -> AutocompleteSearchResult
```

The query endpoint must enforce the following server-side:

- The provider exists and is enabled for the location.
- The requested trigger matches the registered provider.
- The provider cannot access a different project or workspace by changing
  query parameters.
- The request has a timeout and is cancellable.
- Results are schema-validated and size-limited.
- Errors are returned as an empty provider result with diagnostic logging, not
  as a prompt failure.

The endpoint should use the current Protocol/Server HttpApi generation flow.
After changing the public API, run `bun run generate` from `packages/client`;
generated files must not be edited directly.

### Client suggestion model

The existing V2 suggestion model should be generalized rather than duplicated:

```ts
export type PromptInputV2SuggestionKind =
  | "agent"
  | "command"
  | "file"
  | "reference"
  | "resource"
  | "plugin"

export type PromptInputV2PluginSuggestion = {
  type: "plugin"
  providerID: string
  entityType: string
  entityID: string
  content: string
  display: string
  metadata?: Record<string, string>
}

export type PromptInputV2Suggestion = {
  id: string
  kind: PromptInputV2SuggestionKind
  label: string
  title?: string
  trigger?: string
  description?: string
  group?: string
  path?: string
  keybind?: string[]
  recent?: boolean
  mention?: PromptInputV2FilePart | PromptInputV2AgentPart | PromptInputV2PluginSuggestion
}
```

The `mention` name is retained for compatibility with existing editor code,
but the implementation should treat it as a generic structured insertion.
`addMention` should be generalized to replace the active trigger token, not
hard-code `lastIndexOf("@")` as it currently does in
`packages/session-ui/src/v2/components/prompt-input/store.ts`.

### Provider adapter in the app

The app-specific controller should receive providers and query them through
the generated client:

```ts
export type PromptInputV2Autocomplete = {
  providers: Accessor<AutocompleteProviderInfo[]>
  search: (
    providerID: string,
    trigger: string,
    query: string,
  ) => Promise<PromptInputV2Suggestion[]>
}
```

`createPromptInputV2Controller` should accept an optional autocomplete adapter.
When the current token begins with a registered trigger, it should:

1. Identify the provider by trigger.
2. Abort the previous request.
3. Query with the current token text.
4. Ignore responses for obsolete query generations.
5. Present the normalized results through the existing suggestion popover.

The legacy composer should use the same adapter or be retired once the V2
composer is complete. Implementing the feature in only one composer would
create inconsistent behavior between the web UI variants.

## Serspace Provider Example

The Serspace provider should use `#` and query a server-side Serspace search
API. It should return a compact label and preserve identity in the selection:

```ts
const provider: AutocompleteProvider = {
  info: {
    id: "serspace.entities",
    trigger: { value: "#", kind: "character", description: "Serspace" },
    title: "Serspace",
    maxResults: 10,
  },
  async search(input) {
    const entities = await searchEntities({
      query: input.query,
      workspaceID: input.workspaceID,
      signal: input.signal,
    })

    return {
      items: entities.map((entity) => ({
        id: entity.entity_id,
        label: entity.name,
        description: entity.type,
        group: entity.type,
        selection: {
          type: "context",
          content: `#${entity.name}`,
          display: entity.name,
          source: {
            providerID: "serspace.entities",
            entityType: entity.type,
            entityID: entity.entity_id,
          },
        },
      })),
    }
  },
}
```

The selected reference should remain visible as `#name` in the editable prompt,
while the submitted prompt carries the structured reference. The server can
resolve the reference to a bounded context representation at submission time.
This is preferable to inserting the entire Serspace record into the browser
prompt or trusting a user-editable entity name as identity.

## Critical Design Decisions

### Server plugin versus TUI plugin

Autocomplete providers must be **server plugins**. A TUI-only provider cannot
serve the web app, cannot safely hold server credentials, and would diverge
from the HTTP/API architecture. A TUI plugin may still provide presentation
customization later, but it should consume the same provider data contract.

### `@` extension versus a new trigger

The first provider should use `#` rather than overload `@`:

- `@` already has file, agent, reference, and MCP-resource semantics.
- External entities need a different resolution path than files.
- A separate trigger makes provider ownership and failure behavior clear.
- Existing prompts remain backward compatible.

The registry can technically permit `@` in the future, but conflict policy,
precedence, and coexistence with built-ins must be explicitly defined first.

### Plain text versus structured context

Plain text is easy to implement but loses entity identity and forces the model
to infer which record the user selected. Structured context is the correct
default for Serspace and other external databases. The protocol should still
support `type: "text"` for providers that only need insertion.

### Query ownership and filtering

The provider should own remote query semantics and authorization. OpenCode may
apply a small final result limit and stable ordering, but should not assume
that fuzzy filtering over `label` is correct for every provider. A provider
may return already-filtered results and indicate whether host filtering is
safe.

### Caching

The server may cache provider results briefly, keyed by provider, location,
workspace, and normalized query. It must not cache across users or workspaces
unless the provider explicitly declares the data public. Initial support can
omit caching and rely on provider-side caching.

### Submission and history

Selections must survive prompt history, undo, retries, and serialization. The
structured selection should therefore be part of the prompt input schema, not
only an editor decoration. A manually typed `#id` may remain plain text unless
the provider can resolve it during submission; autocomplete selection should
always preserve its structured source.

## Security and Reliability

- Never send plugin credentials or raw database connections to the browser.
- Treat provider labels and descriptions as untrusted text; escape them in
  both web and TUI renderers.
- Bound query length, result count, label length, metadata size, and request
  duration.
- Propagate `AbortSignal` so fast typing does not accumulate requests.
- Ignore late responses from older query generations.
- Do not let a provider exception disable prompt submission.
- Scope provider execution to the current location and workspace.
- Avoid logging query contents when they may contain personal or confidential
  entity data.
- Require explicit plugin enablement for providers that access external data.

## Implementation Sequence

1. Add schema contracts for provider info, search requests/results, items, and
   structured selections.
2. Add the server registry and plugin hook, including trigger collision checks.
3. Add provider discovery and search HttpApi endpoints.
4. Regenerate `packages/client` from the protocol.
5. Generalize the V2 prompt suggestion and prompt-part unions.
6. Add trigger-aware provider querying to `session-ui`.
7. Wire the web app adapter to the generated client.
8. Wire the TUI adapter to the same API and preserve existing `@` behavior.
9. Add a Serspace provider outside OpenCode core.
10. Retire or delegate the legacy composer implementation after V2 adoption.

## Testing Requirements

- Provider registration rejects duplicate triggers deterministically.
- Provider discovery is location-scoped.
- Search cancellation prevents stale results from replacing newer results.
- Provider failures render an empty result state and do not block submission.
- Selection replaces the complete active trigger token at the cursor.
- Selection works in the middle of a prompt, not only at the end.
- Structured selections survive prompt history and undo.
- Provider metadata cannot inject HTML or terminal control sequences.
- Web and TUI render the same provider result contract.
- Existing `@` file, agent, reference, and resource behavior remains unchanged.
- Serspace results preserve entity type and stable entity ID through submission.

## Open Questions

- Should provider discovery be static at startup or support runtime reload?
- Should a provider be allowed to register multiple triggers?
- Should trigger matching require a token boundary to avoid matching shell
  syntax, email addresses, or currency values?
- Should structured external references be resolved eagerly at selection time
  or lazily during prompt submission?
- Should selected external references be visible as pills in the composer and
  message timeline?
- What is the compatibility policy for plugins built against the proposed
  interface while the V2 prompt schema is still changing?

## Recommendation

Implement a generic server-side `autocomplete` provider registry with `#` as
the first supported custom trigger. Reuse the existing V2 suggestion and
popover pipeline, but introduce a generic structured external-reference part
instead of adding Serspace-specific fields to file or agent parts.

This provides the requested Serspace experience without making OpenCode aware
of Serspace, preserves the existing prompt semantics, and creates a credible
upstream contribution rather than a narrowly scoped fork.
