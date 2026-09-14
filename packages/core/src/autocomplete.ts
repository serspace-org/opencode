export * as Autocomplete from "./autocomplete"

import { makeGlobalNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Autocomplete } from "@opencode-ai/schema/autocomplete"

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
  readonly initialize: (load: (directory: string) => Effect.Effect<void>) => () => void
  readonly registry: (directory: string) => Registry
  readonly providers: (directory: string) => Effect.Effect<Autocomplete.ProviderInfo[]>
  readonly search: (input: {
    directory: string
    workspaceID?: string
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
    const locations = new Map<string, { providers: Map<string, Provider>; triggers: Map<string, string> }>()
    const initializers = new Set<(directory: string) => Effect.Effect<void>>()

    return Service.of({
      initialize(load) {
        initializers.add(load)
        return () => initializers.delete(load)
      },
      registry(directory) {
        const state = locations.get(directory) ?? { providers: new Map(), triggers: new Map() }
        locations.set(directory, state)
        return {
          add(provider) {
            if (state.providers.has(provider.info.id)) {
              throw new Error(`Duplicate autocomplete provider: ${provider.info.id}`)
            }
            const owner = state.triggers.get(provider.info.trigger.value)
            if (owner) {
              throw new Error(`Autocomplete trigger ${provider.info.trigger.value} is already registered by ${owner}`)
            }
            state.providers.set(provider.info.id, provider)
            state.triggers.set(provider.info.trigger.value, provider.info.id)
            return () => {
              if (state.providers.get(provider.info.id) !== provider) return
              state.providers.delete(provider.info.id)
              state.triggers.delete(provider.info.trigger.value)
              if (state.providers.size === 0) locations.delete(directory)
            }
          },
        }
      },
      providers: Effect.fn("Autocomplete.providers")(function* (directory) {
        yield* Effect.all(Array.from(initializers, (initialize) => initialize(directory)), { discard: true })
        return Array.from(locations.get(directory)?.providers.values() ?? [])
          .map((provider) => provider.info)
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
      }),
      search: Effect.fn("Autocomplete.search")(function* (input) {
        yield* Effect.all(Array.from(initializers, (initialize) => initialize(input.directory)), { discard: true })
        const provider = locations.get(input.directory)?.providers.get(input.providerID)
        if (!provider || provider.info.trigger.value !== input.trigger) return { items: [] }
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            provider.search({
              ...input,
              signal,
              query: input.query.slice(0, 500),
              directory: input.directory,
              workspaceID: input.workspaceID,
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

export const globalLayer = layer
export const node = makeGlobalNode({ service: Service, layer, deps: [] })
