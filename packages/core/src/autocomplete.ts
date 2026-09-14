export * as Autocomplete from "./autocomplete"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Autocomplete } from "@opencode-ai/schema/autocomplete"
import { Location } from "./location"

export type SearchInput = {
  providerID: string
  trigger: string
  query: string
  directory: string
  workspaceID?: string
  sessionID?: string
  signal: AbortSignal
}

export type Provider = {
  info: Autocomplete.ProviderInfo
  search(input: SearchInput): Promise<Autocomplete.SearchResult>
}

export type Registry = {
  add(provider: Provider): () => void
}

export interface Interface {
  readonly registry: Registry
  readonly providers: () => Effect.Effect<Autocomplete.ProviderInfo[]>
  readonly search: (input: {
    providerID: string
    trigger: string
    query: string
    sessionID?: string
  }) => Effect.Effect<Autocomplete.SearchResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Autocomplete") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const providers = new Map<string, Provider>()
    const triggers = new Map<string, string>()
    const registry: Registry = {
      add(provider) {
        if (providers.has(provider.info.id)) throw new Error(`Duplicate autocomplete provider: ${provider.info.id}`)
        const owner = triggers.get(provider.info.trigger.value)
        if (owner) throw new Error(`Autocomplete trigger ${provider.info.trigger.value} is already registered by ${owner}`)
        providers.set(provider.info.id, provider)
        triggers.set(provider.info.trigger.value, provider.info.id)
        return () => {
          if (providers.get(provider.info.id) !== provider) return
          providers.delete(provider.info.id)
          triggers.delete(provider.info.trigger.value)
        }
      },
    }

    return Service.of({
      registry,
      providers: Effect.fn("Autocomplete.providers")(function* () {
        return Array.from(providers.values())
          .map((provider) => provider.info)
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
      }),
      search: Effect.fn("Autocomplete.search")(function* (input) {
        const provider = providers.get(input.providerID)
        if (!provider || provider.info.trigger.value !== input.trigger) return { items: [] }
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            provider.search({
              ...input,
              signal,
              query: input.query.slice(0, 500),
              directory: location.directory,
              workspaceID: location.workspaceID,
            }),
          catch: (error) => error,
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.tapError((error) => Effect.logWarning("autocomplete provider failed", { providerID: input.providerID, error })),
          Effect.catch(() => Effect.succeed({ items: [] })),
        )
        return yield* Schema.decodeUnknownEffect(Autocomplete.SearchResult)({
          ...result,
          items: result.items.slice(0, provider.info.maxResults ?? 20),
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("autocomplete provider returned invalid results", { providerID: input.providerID, error }),
          ),
          Effect.catch(() => Effect.succeed({ items: [] })),
        )
      }),
    })
  }),
)

export const locationLayer = layer
export const node = makeLocationNode({ service: Service, layer, deps: [Location.node] })
