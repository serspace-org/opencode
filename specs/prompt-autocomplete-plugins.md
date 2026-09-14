# Plugin prompt autocomplete

Fork prototype for design review; upstream approval has not been obtained.

## Contract

- Server plugins register providers through `Hooks.autocomplete.register`.
  Each provider owns an ID, a token-boundary trigger, and asynchronous search.
  `@` providers extend built-in suggestions and may share that trigger; `/`
  and `!` remain reserved. Other triggers and provider IDs must be unique.
  Providers register separate IDs for each binding, so a plugin can offer both
  a dedicated `#` search and additive `@` results without a new wire contract.
  Provider titles label the source in both composers; selected metadata retains
  the registered provider ID and stable entity identity. Duplicate registrations fail;
  a failed plugin registration is logged without stopping other plugin hooks.
- Discovery and search use `/api/autocomplete`. TUI uses the generated client.
  The app retains its existing request adapter because its other APIs use a
  vendored pre-migration client; migrating that transport is follow-up work.
  TUI and web pass the selected directory explicitly.
- Search receives a cancellation signal, a query capped at 500 characters,
  and a five-second timeout. Results are schema-validated before access and
  capped at the provider limit (default 20). Provider errors yield no results;
  diagnostics omit plugin exception payloads, which may contain query data.
- Context selections submit their content as synthetic text with stable
  `metadata.autocomplete` identity. Content is also visible in the editable
  prompt. Metadata is provenance, not a server-resolved external record or an
  authorization grant. Plugins must provide the bounded content they want
  submitted; lazy entity resolution is a separate design decision.

## Runtime ownership

`Autocomplete.node` owns a process-local registry keyed by directory. The
OpenCode host installs a scoped initializer that calls `Plugin.init()` in the
requested instance. `InstanceState` uses `ScopedCache` to initialize each
directory once and dispose its registrations on instance teardown. Repeating
discovery/search does not rerun plugin registration.

The standalone Server package provides the same Core node but does not load
legacy OpenCode plugins: its registry is empty unless its host registers
providers. Server must not import OpenCode to add legacy plugin loading.
Layer memoization, rather than the spelling of `globalLayer` versus `node`,
determines service sharing within a runtime.

Directory selection follows the existing authenticated local-server API
model. A directory query is not a tenant authorization boundary. Workspace
isolation and third-party authorization remain host/provider responsibilities.

## Review and verification

The local example lives in `packages/plugin/examples/autocomplete.ts`; it is
not a public package export. Add its file path to the plugin configuration and
type `#` to exercise discovery before creating a session. Type `@ada` to see
the same records alongside built-in matches, labeled `Example records · person`.
The example sets `info.priority: 100` so its records appear above built-in
suggestions once available. Built-ins and providers without an explicit priority
use zero; equal-priority results retain their existing order.

Regression coverage includes registration validation, disposal/re-registration,
directory isolation, malformed results, provider exceptions, token replacement
at the cursor, serialization, and nonempty submitted selection content.

Before upstream submission: obtain a design review, record web/TUI behavior,
verify cancellation and history/undo through the complete interactive flows,
and settle plain-text versus structured selection presentation. Keep the fork
PR draft until those checks and the package-wide checks are complete. Squash
the prototype history when preparing the eventual upstream contribution.
