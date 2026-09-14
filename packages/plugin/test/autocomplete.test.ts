import { expect, test } from "bun:test"
import type { AutocompleteProvider } from "../src/index"
import { ExampleAutocompletePlugin } from "../examples/autocomplete"

test("example registers dedicated and shared searches with attributable selections", async () => {
  const providers: AutocompleteProvider[] = []
  const plugin = await ExampleAutocompletePlugin()
  plugin.autocomplete.register({
    add(provider) {
      providers.push(provider)
      return () => {}
    },
  })
  expect(providers.map((provider) => provider.info.trigger.value)).toEqual(["#", "@"])
  expect(new Set(providers.map((provider) => provider.info.id)).size).toBe(2)
  for (const provider of providers) {
    const result = await provider.search({
      providerID: provider.info.id,
      trigger: provider.info.trigger.value,
      query: "ada",
      directory: "/example",
      signal: new AbortController().signal,
    })
    expect(provider.info.title).toBe("Example records")
    expect(provider.info.priority).toBe(100)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.selection).toMatchObject({
      type: "context",
      content: `${provider.info.trigger.value}Ada Lovelace`,
      source: { providerID: provider.info.id, entityType: "person", entityID: "person_ada" },
    })
  }
})
