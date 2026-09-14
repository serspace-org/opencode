import { Autocomplete } from "@opencode-ai/schema/autocomplete"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

const SearchQuery = Schema.Struct({
  ...LocationQuery.fields,
  provider: Schema.String,
  trigger: Schema.String,
  query: Schema.String,
  sessionID: Schema.optional(Schema.String),
})

export const AutocompleteGroup = HttpApiGroup.make("server.autocomplete")
  .add(
    HttpApiEndpoint.get("autocomplete.providers", "/api/autocomplete/providers", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Autocomplete.ProviderInfo)),
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.get("autocomplete.search", "/api/autocomplete/search", {
      query: SearchQuery,
      success: Location.response(Autocomplete.SearchResult),
    }).annotateMerge(locationQueryOpenApi),
  )
  .annotateMerge(OpenApi.annotations({ title: "autocomplete", description: "Plugin-provided prompt autocomplete." }))
