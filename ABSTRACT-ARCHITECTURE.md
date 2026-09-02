# OpenCode — Abstract Architecture

A language-agnostic architectural specification distilled from the opencode
codebase. It describes *what* the system is made of and *why* — the essential
modules, data flows, state machines, and invariants — stripped of
implementation-specific detail (no TypeScript, Bun, Effect, SolidJS, or SQLite
assumptions). It is intended as the blueprint for a from-scratch implementation
in another language.

Where opencode today carries transitional machinery (a legacy session runtime,
a legacy file-based store, a legacy hand-tooled SDK), this document describes
the single ideal form and notes the legacy artifact only as a migration
requirement.

---

## 1. What the system is

OpenCode is an **AI coding agent**: a long-running agent runtime that conducts
multi-turn conversations with large language models, executes tools (shell,
file editing, search, web access, …) against a user's project, and presents the
interaction through interchangeable user interfaces — terminal, web, desktop,
and chat-bot embedders.

The defining architectural decision:

> **One server, many thin clients.** All state, all model interaction, all tool
> execution, and all persistence live in one server. Every UI is a client that
> talks to the server over HTTP, receives realtime updates over a server-pushed
> event stream (SSE), and uses a WebSocket only for interactive terminal (pty)
> sessions. Clients never touch the model, the tools, or the database directly.

---

## 2. Guiding principles

1. **The server is the single source of truth.** Clients mirror server state;
   they do not own it.
2. **Contract-first API.** One declarative API definition is the source for
   both the server implementation *and* all generated clients. Clients are
   never hand-written against ad-hoc endpoints.
3. **Strict layered dependencies.** Modules form a directed acyclic graph
   (§4). Lower layers never know about higher ones.
4. **Durability before execution.** User input is persisted *before* any model
   work is scheduled. The session transcript is an **append-only event log**
   folded into read-model projections — not rows mutated in place.
5. **Admission is separate from execution.** Accepting a prompt (durable write)
   is a different operation from running the model loop (an advisory wake-up).
   This makes prompts crash-safe and retry-safe.
6. **One model stream per provider turn.** Each turn performs exactly one
   streaming model request. History is reloaded from the durable projection
   before every continuation; nothing depends on in-memory transcript state.
7. **Explicit delivery semantics.** Mid-run user input is either a *steer*
   (promoted at the next safe turn boundary) or *queued* (promoted only when
   the session would otherwise go idle). Never implicit.
8. **Everything is validated at the boundary.** All wire data and all stored
   data is described by declarative schemas with branded identifiers; parsing
   is validation.
9. **Structured concurrency.** Work runs as scoped, interruptible lightweight
   tasks. Interrupting an idle or absent session is a well-defined no-op, never
   an error.
10. **Placement-aware services.** Runtime services are either *global*
    (one per process) or *location-scoped* (one per project/workspace).
    Session execution is looked up by session identity, not held by callers.

---

## 3. System overview

```
                          ┌──────────────────────────────────────┐
                          │              CLIENTS                  │
                          │  TUI   Web app   Desktop   Bots/ACP   │
                          └───────┬───────────────┬───────────────┘
                     HTTP + SSE   │               │  HTTP + SSE + WS (pty)
                          ┌───────▼───────────────▼───────────────┐
                          │              SERVER                    │
                          │  API handlers · auth · multi-instance  │
                          │  OpenAPI exposure · SSE fan-out        │
                          └───────┬───────────────────────────────┘
                          ┌───────▼───────────────────────────────┐
                          │               CORE                     │
                          │  Session engine (event-sourced)        │
                          │  Tool registry & execution boundary    │
                          │  Agents · Permissions · Questions      │
                          │  Config · Plugins · MCP host · LSP     │
                          │  System context · Compaction · Revert  │
                          │  Event log & projections · Persistence │
                          └──┬────────────────┬───────────────────┘
                   ┌─────────▼───────┐   ┌────▼────────────────────┐
                   │   LLM LAYER      │   │      STORAGE            │
                   │ canonical model  │   │ embedded SQL database   │
                   │ protocol × auth  │   │ event log · projections │
                   │ × framing ×      │   │ VCS-worktree snapshots  │
                   │ transport routes │   │ credential store        │
                   └──────────────────┘   └─────────────────────────┘
```

---

## 4. Module layers and dependency rules

Modules form a DAG. A module may only depend on modules below it in this
table. These rules are enforced by build/boundary checks, not convention.

| Layer | Name | Responsibility | May depend on | Must never depend on |
|---|---|---|---|---|
| 0 | **Contracts (Schema)** | Declarative schemas for every wire and storage shape: entities, events, errors, branded IDs. Pure data descriptions; no behavior, no I/O, browser-safe. | nothing | everything |
| 1a | **Protocol** | The declarative HTTP API definition: endpoint groups per domain, request/response schemas, tagged errors with HTTP statuses, the event-stream endpoint, middleware *slots* (implementations injected by the server). | Contracts | Core, Server |
| 1b | **LLM** | Provider-native model access (§8). Canonical request/response/event model; composable request "routes". Deliberately free of session concepts. | Contracts | Core, Server |
| 2 | **Core** | The domain engine (§6–§16): session orchestration, tools, agents, permissions, config, plugins, MCP, events, persistence. Exposed as injectable services with explicit global/location placement. | Contracts, LLM, Plugin-API | Protocol, Server |
| 3 | **Server** | Implements every Protocol endpoint group as handlers backed by Core services; assembles the service graph; provides concrete middleware (auth, errors); serves HTTP/SSE/WS; emits the machine-readable API description (OpenAPI). | Core, Protocol | Client |
| 4 | **Client** | *Generated* isomorphic SDK produced by reflecting over the Protocol definition. Two flavors: (a) dependency-free async/promise client with structural types; (b) an effect/functional client for embedding in the runtime. | Contracts, Protocol (runtime); Core, Server (build-time only, for codegen) | Core, Server at runtime |
| 5 | **Embedded SDK** | Composes Client + Core + Server: mounts the real server routes as an in-process request handler and points the generated client at it — a fully typed API with zero network. Also re-exports the tool-authoring API. | Client, Core, Server | — |
| 6 | **Applications** | CLI, TUI, web app, desktop app, bots, ACP adapter. | Client / Embedded SDK | Core internals |

Additional edges (all acyclic): Core → Plugin-API (host consumes plugin
definitions); Plugin-API → Contracts.

**Code generation rule.** The API contract is the single source of truth.
Changing the contract requires regenerating the client; generated files are
committed, never hand-edited, and freshness is verified by CI.

---

## 5. Domain model

All entities are records with **branded identifiers** (typed, prefixed,
non-interchangeable IDs) and are validated by Contracts schemas. Optional
fields are explicit; timestamps are UTC; money-free; paths are branded
absolute/relative.

### 5.1 Core entities

| Entity | Identity | Key fields | Notes |
|---|---|---|---|
| **Project** | ProjectID | root directory, VCS info | The unit of "where the agent works". |
| **Workspace** | WorkspaceID | identity, metadata | Reserved for future remote placement; omission means implicit-local. |
| **Location** | LocationID | workspace ref | Placement identity for location-scoped services. |
| **Session** | SessionID | project ref, title, parent session ref (subagents), timestamps, revert state, compaction state | A conversation/agent-run context. |
| **SessionInput** | (SessionID, admitted seq) | prompt content, delivery mode (`steer` \| `queue`), promoted seq (nullable), client-supplied prompt ID | The **durable inbox**. |
| **SessionMessage** | (SessionID, seq) | role, parts | The **projected transcript**; derived from events. |
| **Event** | (aggregate ID, seq) | type tag, payload, timestamps | Append-only durable log entry (§7). |
| **ContextEpoch** | (SessionID, epoch seq) | baseline snapshot of system-context producers | Pins what the system prompt was for a run of turns. |
| **Agent** | name | system prompt, model ref, permission ruleset, step allowance, tool filter | A persona/mode the session runs as (§10). |
| **Provider** | ProviderID | auth ref, endpoint config, catalog source | A model vendor/account. |
| **Model** | (ProviderID, ModelID) | capabilities, limits, cost metadata | Resolved from catalog + config. |
| **Credential** | CredentialID | secret material (stored in a credential store, not the DB) | Provider/MCP auth. |
| **Command** | name | prompt template, argument spec | Slash commands expanding into prompts. |
| **Skill** | SkillID | instructions + resources | Loadable expertise packages the agent can invoke. |
| **Permission** | rule ID | effect (`allow`/`ask`/`deny`), pattern, scope | Ordered rules (§11). |
| **Question** | QuestionID | prompt, options, session ref | Agent→user structured questions (§11). |
| **Pty** | PtyID | shell, cwd, size, session/workspace ref | Managed terminal processes. |
| **Integration / Connection** | IDs | external-system bindings | Extensibility surface for hosted products. |

### 5.2 Message parts

A message is an ordered list of typed parts (a tagged union):

- `text` — Markdown text (streamed as deltas).
- `reasoning` — model reasoning/thinking blocks (streamed, optionally signed/redacted).
- `tool_call` — tool name, streamed input arguments, call ID, state.
- `tool_result` — call ID, output or error, attachments, truncation metadata.
- `file` / `image` — binary or referenced attachments.
- `patch` — applied edit descriptions.
- `subtask` — reference to a child session (subagent runs).

### 5.3 Value objects

- **GenerationOptions** — temperature, max output tokens, top-p, cache policy, provider-specific extensions.
- **ModelRef** — (ProviderID, ModelID) pair used wherever a model is selected.
- **ToolDefinition** — name, description, input schema, output schema (§9).
- **Usage** — input/output/cached token counts, cost if known.

---

## 6. The session engine (the heart)

The session engine is **event-sourced**: every state change is a durable event;
the visible transcript is a projection. It has four cooperating components.

### 6.1 Components

| Component | Placement | Responsibility |
|---|---|---|
| **Session facade** | global | CRUD, `prompt()`, `resume`, `interrupt`, `revert`, `compact`, `wait`, listing, history reads. The public surface. |
| **Input store (inbox)** | global | Durable admission of user input; promotion bookkeeping. |
| **Execution router** | process-global | Maps SessionID → where the session runs. Discovers placement lazily (store lookup + location map) only when a drain starts. Callers never hold executors. |
| **Run coordinator** | process-global | Per-key serializer: at most one active *drain* per session; coalesces wake-ups; joins explicit concurrent resumes; interrupts the owning task. Different sessions run fully concurrently. |
| **Runner** | location-scoped | The drain loop itself: turns, tools, compaction, limits, snapshots. |
| **Projector** | global | Folds the event log into read-model tables (transcript, inbox state). |

### 6.2 Admission (no model work yet)

```
prompt(session, input, clientPromptID, delivery, resume):
  if reusing sessionID: adopt the existing session
  if reusing clientPromptID:
      require exact equivalence (session, content, delivery)
      else fail with PromptConflict            # idempotent retry
  row := durable insert into inbox (session, input, delivery,
                                   monotonically increasing admitted_seq)
  publish event PromptAdmitted
  if resume != false: ExecutionRouter.wake(sessionID)   # advisory
```

### 6.3 The drain loop

A drain is a process-local, interruptible task with **no durable identity**.
It runs until the session settles:

```
drain(session):
  fail any tool calls left open by a previous interruption
  loop:
    # 1. Admission boundary
    promote all pending STEER inputs           # at safe turn boundary
    if no other work and queue non-empty:
        promote exactly ONE queued input       # then re-evaluate
    if nothing to do: settle and exit

    # promoting new user input resets the agent's provider-turn allowance
    # (a batch of steers resets it once)

    # 2. Turn preparation
    agent  := resolve current agent
    model  := resolve model (session override → agent → config default)
    epoch  := current context epoch (system-context baseline, §15)
    history := projected transcript since epoch baseline
    request := build model request (system prompt, history, tools)
    tools  := registry.materialize(agent.permissions)   # §9

    # 3. The one stream
    events := llm.stream(request)              # exactly one call per turn
    for each event:
        persist as durable session event        # text/reasoning/tool deltas…
        if tool-call input complete:
            record ToolCalled
            start eager tool execution on a task set  # §9.4

    # 4. Tool settlement
    await tool tasks; results become durable ToolSuccess/ToolFailed events
    snapshot VCS worktree around the turn       # for revert (§16.3)

    # 5. Continuation
    if tools ran or new steers arrived: continue loop
    if step allowance exceeded: fail step, settle
    if context overflow: compact (§6.6) then continue
    else: settle and exit
```

### 6.4 Delivery modes

| Mode | Promotion rule | Use |
|---|---|---|
| `steer` | All pending steers promote at the next safe provider-turn boundary while the drain continues. | Default interactive input; "also do X" mid-run. |
| `queue` | One queued input promotes only when the session would otherwise become idle; continuation is re-evaluated before promoting another. | Fire-and-forget follow-ups. |

### 6.5 Interruption

`interrupt(session)` targets the active process-local ownership chain for that
session: the owning drain task is interrupted, in-flight tool tasks are
cancelled, and open tool calls are durably failed. If the session is idle or
unknown, interruption is a **no-op**.

### 6.6 Compaction

When the transcript approaches the model's context limit (or on explicit
request), the engine runs a **compaction turn**: a summarization model request
whose output replaces the pre-baseline history, recorded as `Compaction.*`
events and a new context epoch. It is automatic on overflow and manual via the
API.

### 6.7 Revert

The engine captures VCS-worktree snapshots around turns and records checkpoint
markers on the session. Revert is three explicit operations — `stage` (compute
the target state), `clear` (unstage), `commit` (restore the workspace and roll
the transcript back, recorded as `Revert.*` events).

### 6.8 Subagents

A tool (`task`) can spawn a **child session** (linked by parent-session ID)
with its own agent, permissions, and step allowance. The child runs through the
same engine; its final message becomes the tool result. Subagent output is
bounded like any tool output.

### 6.9 Legacy requirement

The reference implementation still ships a previous-generation in-memory agent
loop for compatibility. An ideal implementation ships **only** the durable
engine above; the legacy obligation reduces to **data migration** (importing
old transcripts/files into the event-sourced tables) and an
export/interchange format for sessions.

---

## 7. Event architecture

Two buses, strictly separated:

| Bus | Durability | Purpose |
|---|---|---|
| **Durable event log** | persisted, per-aggregate monotonic sequence | Source of truth for session history; replayable; drives projections. |
| **Ephemeral bus** | in-process pub/sub | High-frequency deltas (text streaming, compaction progress), UI hints, lifecycle notices. Loss-tolerant. |

Rules:

- Every durable event carries (aggregate ID, sequence, type tag, payload).
- **Replay/ownership claims are separate from execution ownership** — replaying
  history never implies the right to run the session.
- The server exposes one **event-stream endpoint** (SSE) carrying the union of
  all client-relevant events: session updates, message/part updates, permission
  requests, questions, pty output, service statuses, heartbeat.
- Clients subscribe once and **fold events into a local state mirror**;
  high-frequency deltas are coalesced (≈ one animation frame) before rendering.
- Event contracts are versioned; transitional event types are marked and
  retired deliberately.

### Session event catalog (canonical)

`PromptAdmitted`, `Prompted`, `AgentSwitched`, `ModelSwitched`,
`Step.Started / Ended / Failed`,
`Text.Started / Delta* / Ended`, `Reasoning.*`,
`Tool.InputStarted / InputDelta / InputReady / Called / Progress / Success / Failed`,
`Shell.*`, `Retried`,
`Compaction.Started / Delta* / Finished`,
`Revert.*` — (* ephemeral).

---

## 8. LLM provider abstraction

A provider-agnostic layer that owns *only* model access — no session concepts.

### 8.1 Canonical model

- **Request** = system prompt + canonical messages (§5.2 parts) + tool
  definitions + generation options + cache policy.
- **Event stream** = typed deltas: text, reasoning, tool-input start/delta/end,
  finish (with stop reason), usage, error.
- **Errors** are a tagged taxonomy: auth, rate-limit, overloaded, invalid
  request, context overflow, tool failure, transport — each carrying
  retryability.

### 8.2 Route composition

A callable provider **route** is the composition of five orthogonal axes:

| Axis | Responsibility | Examples |
|---|---|---|
| **Wire protocol** | Request body construction + streaming response state machine (including incremental tool-call assembly) | chat-completions style; responses style; messages style; gemini style; converse style |
| **Endpoint** | URL construction | vendor base URLs, regional endpoints |
| **Auth** | Per-request signing | bearer token, static header, request signing (e.g. SigV4) |
| **Framing** | Byte-stream → event decoding | SSE, binary event-stream, WebSocket frames |
| **Transport** | Connection | HTTP/1.1 or HTTP/2 streaming; WebSocket |

A vendor = a small facade choosing the five axes + credential wiring. Vendors
sharing a wire protocol reuse it entirely (the "openAI-compatible" family).
New vendors are added by configuration, not code, whenever an existing wire
protocol fits.

### 8.3 Tool calls at this layer

- Tool definitions are translated per wire protocol.
- **Provider-executed (hosted) tools** pass through untouched — the layer
  distinguishes local vs. hosted calls.
- A typed **dispatcher** executes exactly one local tool call against a host
  function, mapping failures to structured tool errors.
- A **tool-input stream assembler** repairs/interleaves partial JSON argument
  deltas into complete calls.

---

## 9. Tool system

### 9.1 Tool definition

A tool is an opaque, self-contained capability:

```
Tool = {
  description : text (model-facing contract)
  input       : schema
  output      : schema
  execute     : (parsed input, execution context) → output | ToolFailure
  toModelOutput : output → model-facing rendering (text/parts)
}
```

The execution context carries: session identity, working directory, abort
signal, permission context, and a metadata channel for progress events.

### 9.2 Registry

The registry is the **layered** union of, in increasing precedence:

1. **Built-ins** (§9.5)
2. **Application tools** — registered by the embedding application/process
3. **Plugin tools** — contributed by plugins (§13)
4. **MCP tools** — discovered from connected MCP servers (§14)

Later registrations shadow earlier ones by name. The registry filters out any
definition wholly denied by the active permission ruleset *before* exposing
tools to the model.

### 9.3 Materialization

Before a turn, definitions are *materialized* for the specific agent and
model: filtered by permissions, renamed/deduplicated, translated into the
model's tool format. Materialization captures each tool's execute function so
the model loop never touches the registry mid-turn.

### 9.4 Execution boundary

All local tool execution crosses one boundary ("settle"):

- Invokes the captured execute function under the abort signal.
- Maps `ToolFailure` to an error result (never an exception escaping the loop).
- **Bounds output**: oversized results are spilled to an output store and
  replaced with a truncated view + reference.
- Emits `Tool.Progress` during execution and `Tool.Success/Failed` at the end.
- Runs plugin hooks `tool.execute.before/after` (§13).
- Asks permission first when the ruleset says `ask` (§11).

### 9.5 Built-in tool catalog

| Tool | Function |
|---|---|
| `bash` / shell | Run shell commands in the project environment (managed pty where interactive). |
| `read` / `write` / `edit` / `apply_patch` | File reading and precise file mutation (exact-match edits or patch format). |
| `glob` / `grep` | Filesystem pattern search and content search. |
| `webfetch` / `websearch` | Retrieve a URL as text; search the web. |
| `todowrite` | Maintain the agent's structured task list (visible to the user). |
| `task` | Spawn a subagent session (§6.8). |
| `question` | Ask the user a structured question (§11). |
| `skill` | Load a skill package into context. |
| `plan` | Enter/record plan state for plan-style agents. |
| `lsp` | Query language-server diagnostics/symbols. |
| `invalid` | Sink for model calls to nonexistent tools (returns a corrective error). |
| `codemode` | Run a confined model-written program that may only call host-supplied tools — no ambient fs/network/process. |

---

## 10. Agent system

An **agent** is a named bundle: system prompt, default model, permission
ruleset, step allowance, and tool filter. Sessions run *as* an agent and can
switch mid-session (`AgentSwitched`).

Built-ins:

- **build** — full-access default.
- **plan** — read-only analysis: edits denied, shell commands require approval.
- **general** — subagent persona for complex multistep tasks.

Agents are user-extensible via config (§12): custom prompts, per-agent
permissions, model pinning. Promoting new user input resets the selected
agent's provider-turn allowance (once per input batch).

Auxiliary agent-facing machinery: **slash commands** (prompt templates with
arguments), **skills** (loadable instruction/resource packages), **todos**
(the agent's visible task list), **reminders**.

---

## 11. Permissions and questions

### 11.1 Permission engine

- Ordered rules: `(pattern, effect)` with effect ∈ `allow | ask | deny`;
  first match wins; rulesets compose (agent → project config → global config).
- Patterns target tool names and argument shapes (e.g. "all edits", "shell
  commands matching …").
- `deny` removes the tool from materialization or blocks the call outright.
- `ask` suspends execution and emits a **permission request event**; the
  client's reply (allow once / always / deny) resumes or fails the call.
  Replies may be remembered for the session.

### 11.2 Questions

A structured channel for agent→user clarification: the model calls the
`question` tool; the server emits a question event; the client renders a
picker/form; the answer unblocks the tool call. Questions, like permissions,
are part of the event stream so any client can render them.

---

## 12. Configuration system

- **Layered resolution**: built-in defaults ← global user config ← project
  config ← environment/CLI overrides. Later layers deep-merge over earlier
  ones.
- **Format**: JSON/JSONC documents validated against a schema; environment
  variable interpolation in strings; `{file:…}` includes for prompts.
- **Discovery**: project config found by walking up from the working
  directory; global config in the platform config home.
- **Contents**: providers & model defaults, agents, permissions, MCP servers,
  plugins, commands, keybinds, theme/UI preferences, formatters, watchers,
  experimental flags.
- Config changes that affect the model request (agent, provider) are picked up
  at turn preparation; some subsystems support live reload via plugins.

---

## 13. Plugin system

Plugins extend the host without forking it.

- **Unit**: a plugin is a function receiving a host context (typed client to
  the running server, project info, shell handle) and returning **hooks** and
  optionally **tool definitions**.
- **Loading**: from package names or local files declared in config;
  built-in plugins ship with the binary (mostly provider *auth* plugins).
  A pure mode disables external plugins.
- **Hook points** (each is "call every plugin in order, threading the value"):

  | Hook | Effect |
  |---|---|
  | `config` | transform loaded configuration |
  | `event` | observe domain events |
  | `chat.message` / `chat.params` / `chat.headers` | transform the outbound model request |
  | `permission.ask` | programmatic permission decisions |
  | `tool.execute.before/after` | wrap tool calls |
  | `command.execute.before` | intercept slash commands |
  | `shell.env` | amend the shell environment |
  | `auth` / `provider` | supply credentials and provider definitions |
  | UI hooks | contribute terminal-UI components/slots |

- **Scoped registrations** (ideal form): plugins register per-domain
  transforms (agents, catalog, commands, integrations, references, skills,
  filesystem, paths, events) owned by a scope, so unloading/reloading a plugin
  revokes exactly its contributions.
- Plugins may themselves add tools to the registry (§9.2).

---

## 14. External tool & editor integration

### 14.1 MCP (Model Context Protocol) client host

- **Transports**: child-process stdio, HTTP/SSE, streamable HTTP.
- **Lifecycle states**: `disabled | connecting | connected | failed |
  needs_auth | needs_client_registration`, all reported on the event stream.
- **Auth**: full OAuth flow with a local loopback callback and credential
  storage in the credential store.
- **Surfacing**: connected servers' tools merge into the tool registry;
  resources can be attached to prompts (size-bounded); `tools changed`
  notifications propagate to clients.
- Managed via CLI (add/remove/list/debug) and config.

### 14.2 LSP

Per-project language-server clients provide diagnostics and symbol
information to tools and the UI; servers are spawned lazily per language and
shut down with the project instance.

---

## 15. System context

System prompts are assembled from a **registry of context producers** — each
producer observes a domain (environment, project metadata, VCS state, rules
files, etc.) and yields a context fragment.

- Producers live with their observed domains; the registry aggregates them.
- A **context epoch** snapshots the combined baseline per session; turn
  preparation pins the epoch so history and system context stay consistent.
- Session history selection and epoch persistence are session-owned.

---

## 16. Persistence

### 16.1 Primary store

- One **embedded SQL database** per user data directory (write-ahead logging,
  single-writer), driven by a migration chain. Path overridable by env var.
- Core tables: `project`, `session`, `message`, `part`, `todo`,
  `session_message` (projected transcript with per-session sequence),
  `session_input` (durable inbox), `session_context_epoch`,
  `event` + `event_sequence` (durable log).
- Read models are **rebuildable** from the event log.
- Column names use snake_case matching field names — no per-column renames.

### 16.2 Other stores

- **Credential store** — provider/MCP secrets, kept out of the database.
- **KV/preferences** — client-side or small server-side key-value state.
- **Legacy import** — earlier file-based (JSON) storage is migrated on first
  run; sessions can be exported/imported as a portable interchange document.

### 16.3 Snapshots

Turn checkpoints use **VCS worktree snapshots** (copy-on-write clones of the
working tree), enabling precise revert (§6.7) without touching the user's
repository state.

---

## 17. Server layer

- **Composition**: builds the service graph (global + location-scoped nodes),
  mounts every Protocol endpoint group with concrete handlers, installs
  concrete middleware (auth, schema-error mapping, session-location routing).
- **Transport**: HTTP/1.1 keep-alive; SSE for the event stream; WebSocket for
  pty attach. Serves a machine-readable API description (OpenAPI) used by SDK
  generation.
- **Listener policy**: default port with graceful fallback to any free port;
  optional LAN discovery advertisement; optional CORS allowlist.
- **Auth**: optional shared-password HTTP Basic auth; per-request middleware.
- **Multi-instance**: one listener can serve many project instances — the
  target project is selected per request (directory header), and each project
  gets a lazily-created, cached instance state (its own services, LSP clients,
  MCP connections). Idle instances are evictable.
- **Lifecycle**: graceful shutdown drains sessions (interrupt), closes
  instances, flushes the event log.

---

## 18. Clients and SDK generation

- **Generated clients** are produced by reflecting over the Protocol
  definition — not by hand, not from a separately maintained spec:
  1. **Zero-dependency async client** — structural types, function-per-
     endpoint, SSE endpoints as async iterables. Browser-safe.
  2. **Functional/effect client** — for embedding in the host runtime, with
     tagged error mapping.
- **Boundary guarantees** (checked by tests): the client bundle contains no
  server/core code; the generated tree is never edited by hand; regeneration
  is idempotent and CI-verified.
- **Embedded SDK**: composes the real server routes as an in-process request
  handler behind the generated client — consumers get the full typed API with
  no socket. Used by bots, tests, and headless embeddings.
- A **legacy hand-tooled SDK** exists for the previous API generation; the
  ideal architecture keeps exactly one generated client line.

---

## 19. Process and deployment topologies

The same server runs in five shapes; clients cannot tell the difference.

| Topology | How it works | Used by |
|---|---|---|
| **In-process worker** | CLI spawns a worker thread hosting the full server; the UI talks to it through an in-process request bridge (no socket); events pushed over the same bridge. | Default terminal experience |
| **TCP server** | `serve` listens on a port (default 4096 with fallback), optional auth + discovery. | Headless/remote use, web app |
| **Daemon** | A detached long-lived server registers itself (registry file with URL, PID, version) protected by a shared password file; CLIs discover, health-check, and version-match it. | Persistent local installs |
| **Desktop sidecar** | The desktop shell spawns the server as a child/utility process on loopback with a generated password. | Desktop app |
| **Embedded** | Server routes run inside the host process behind the generated client. | Bots, tests, embeddings |

Attach/detach is first-class: any UI can attach to any reachable server given
URL + credentials; a session keeps running while no UI is attached.

---

## 20. CLI surface

The entry binary is a command dispatcher. Canonical commands:

| Command | Purpose |
|---|---|
| *(default)* | Start the interactive terminal UI against an in-process or daemon server. |
| `run` | Headless single prompt (or minimal interactive mode); flags for session continue/fork, output format (text/JSON), attach. |
| `serve` | Run the headless HTTP server. |
| `web` | Serve and open the web UI. |
| `attach <url>` | Connect the terminal UI to a running server. |
| `acp` | Speak the Agent-Client-Protocol over stdio (editor integration), backed by an internal server + client. |
| `mcp` | Manage/debug MCP servers. |
| `agent`, `session` | Inspect/manage agents and sessions. |
| `models`, `providers` | List catalog models / manage provider auth. |
| `db`, `export`, `import` | Database maintenance; portable session interchange. |
| `service {start,stop,status,restart,password}` | Manage the daemon topology. |
| `migrate` | Run data migrations (legacy stores → current). |
| `upgrade`, `uninstall` | Self-maintenance. |
| `debug`, `stats` | Diagnostics, usage statistics. |

Cross-cutting flags: log level / log printing, pure mode (no external
plugins), working directory.

---

## 21. Client applications

All clients implement the same **client-side architecture**:

1. **Connect** with (base URL, optional credentials).
2. **Fetch initial state** (sessions, config, providers).
3. **Subscribe to the event stream** with automatic reconnect + backoff; fold
   events into a local state mirror; coalesce high-frequency deltas before
   render; apply optimistic updates where latency matters (prompt echo).
4. **Render** entirely from the mirror; all mutations go back through the API.

### 21.1 Terminal UI (TUI)

- Immediate-mode terminal rendering with a component tree; keyboard-first
  interaction with a configurable keymap layer; dialogs, command palette,
  fuzzy search.
- Context-provider composition (connection, sync state, theme, permissions,
  plugin runtime); plugins may contribute UI slots.
- Distributed as a library so the CLI (which owns the server lifecycle) embeds
  it.

### 21.2 Web app

- Router-based GUI: session list, chat timeline, file tree, diff views,
  embedded terminal (WebSocket), model/agent pickers, review flows.
- Multi-server: manages several named connections (local, remote, other
  machines/containers) and scopes state per connection.
- Heavy local sync: query cache + event reducers; streaming markdown rendering
  off the main thread for smoothness.

### 21.3 Desktop app

- Native shell (windows, menus, updater, deep links, notifications, file
  pickers) wrapping the **same web app** as its renderer.
- Spawns the server as a sidecar (§19); renderer receives URL + credentials at
  startup and thereafter behaves exactly like the web app.
- A narrow **platform bridge** (preload IPC) injects native capabilities
  behind an interface — storage, notifications, pickers, updater, shell-env —
  so the shared UI code stays platform-agnostic. Multi-window with per-window
  state.

### 21.4 Bots and adapters

- Chat bots (e.g. Slack) and the ACP adapter embed the server via the
  **embedded SDK**, mapping external threads ↔ sessions and streaming tool
  activity back to the host platform.

### 21.5 Shared UI libraries

- A **design-system library** (components, themes, icons, i18n) and a
  **session-UI library** (message parts, tool-call renderers, diffs, prompt
  input) are shared across GUI clients; the theme system is shared with the
  TUI. All user-visible copy goes through i18n keys.

---

## 22. Cross-cutting concerns

| Concern | Approach |
|---|---|
| **Errors** | Tagged error taxonomy at every layer; API errors carry stable codes + HTTP statuses; client errors mirror them. |
| **Logging/telemetry** | Structured logs with levels; optional tracing around turns and tool calls; crash-safe flush. |
| **Structured concurrency** | All background work in scoped tasks; scope close cancels children; no orphaned work after shutdown/interrupt. |
| **Time/IDs** | UTC timestamps; sortable unique IDs for entities; branded ID constructors. |
| **Internationalization** | All UI copy via i18n keys; server messages are codes, not prose. |
| **Theming** | Named theme documents shared by TUI and GUI. |
| **Installation/upgrade** | Single-binary distribution per platform; self-upgrade and uninstall commands; channel-aware data paths. |
| **Session sharing** | Optional export/publish of a session transcript for read-only viewing (hosted service). |
| **Security** | Credentials in a dedicated store; password auth for remote servers; sandboxed codemode execution; permission gating on every tool call. |

---

## 23. Hosted companion services (peripheral)

The reference repo also contains the vendor's hosted products; an ideal
re-implementation may omit them, but for completeness:

- **Account/billing console** — dashboard + billing backend for a managed
  cloud tier (separate web stack, payment processor, identity provider).
- **Session sync service** — realtime sync of session state to the cloud
  (durable-object-style coordination + object storage) behind the `sync`
  endpoint group.
- **Enterprise/teams product** — shared-session rendering and org management,
  reusing the session-UI libraries.
- **Marketing/docs site** — static site with documentation.

These consume the same contracts and SDK; they never reach into core
internals.

---

## 24. Invariants (must hold in any implementation)

1. A prompt is **durable before it is executable**; admission never runs model
   code, and `resume:false` admits without scheduling.
2. Session ID reuse adopts the existing session; prompt-ID reuse reconciles an
   **exact retry** (session, content, delivery must match) else conflicts.
3. At most **one active drain per session**; wakes coalesce; explicit resumes
   join the active drain; different sessions are concurrent.
4. Exactly **one model stream per provider turn**; history is reloaded from
   the projection before every continuation.
5. Session execution is **process-global and keyed by session ID**; placement
   is discovered, never captured by callers.
6. Steers promote at safe turn boundaries; queued inputs promote one-at-a-time
   at idle boundaries; each promotion batch resets the turn allowance once.
7. All durable state changes are **events**; read models are projections;
   replay ownership ≠ execution ownership.
8. Interrupting an idle/missing session is a **no-op**; interrupting an active
   one cancels the whole ownership chain and durably fails open tool calls.
9. Every tool call crosses the single **execution boundary**: permissions →
   plugin hooks → execute → output bounding → durable result event.
10. The **API contract** is the only source for server routes and client
    SDKs; generated code is never hand-edited.
11. Layer dependencies are a **DAG**: Contracts → Protocol/LLM → Core →
    Server → Client → Apps; client runtime code never includes Core/Server.
12. Omitted workspace identity means **implicit-local placement**; explicit
    workspace identity is reserved for future distribution.

---

## 25. Glossary

| Term | Meaning |
|---|---|
| **Drain** | One process-local run of the session loop for a session; no durable identity. |
| **Admission** | Durable recording of user input into the session inbox. |
| **Promotion** | Turning an admitted inbox row into a visible user message at a safe boundary. |
| **Steer / queue** | The two delivery modes for mid-run input (§6.4). |
| **Provider turn** | One model request/response cycle within a drain. |
| **Context epoch** | A pinned snapshot of the system-context baseline for a session. |
| **Projection** | A read model folded from the durable event log. |
| **Materialization** | Preparing the permission-filtered tool set for one turn. |
| **Location** | Placement scope (project/workspace) for services. |
| **Instance** | A per-project runtime scope within a multi-project server. |
| **Sidecar** | A server process spawned and owned by a desktop shell. |
| **Daemon** | A detached, discoverable long-lived server with shared-password auth. |
