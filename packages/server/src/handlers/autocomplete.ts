import { Autocomplete } from "@opencode-ai/core/autocomplete"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const AutocompleteHandler = HttpApiBuilder.group(Api, "server.autocomplete", (handlers) =>
  handlers
    .handle("autocomplete.providers", () => response(Autocomplete.Service.use((autocomplete) => autocomplete.providers())))
    .handle("autocomplete.search", ({ query }) =>
      response(
        Effect.gen(function* () {
          const autocomplete = yield* Autocomplete.Service
          return yield* autocomplete.search({
            providerID: query.provider,
            trigger: query.trigger,
            query: query.query,
            sessionID: query.sessionID,
          })
        }),
      ),
    ),
)
