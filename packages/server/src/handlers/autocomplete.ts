import { Autocomplete } from "@opencode-ai/core/autocomplete"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { Location } from "@opencode-ai/core/location"

export const AutocompleteHandler = HttpApiBuilder.group(Api, "server.autocomplete", (handlers) =>
  handlers
    .handle("autocomplete.providers", () =>
      response(
        Effect.gen(function* () {
          const autocomplete = yield* Autocomplete.Service
          const location = yield* Location.Service
          return yield* autocomplete.providers(location.directory)
        }),
      ),
    )
    .handle("autocomplete.search", ({ query }) =>
      response(
        Effect.gen(function* () {
          const autocomplete = yield* Autocomplete.Service
          const location = yield* Location.Service
          return yield* autocomplete.search({
            directory: location.directory,
            workspaceID: location.workspaceID,
            providerID: query.provider,
            trigger: query.trigger,
            query: query.query,
            sessionID: query.sessionID,
          })
        }),
      ),
    ),
)
