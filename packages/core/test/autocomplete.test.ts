import { describe, expect, test } from "bun:test"
import { Autocomplete } from "../src/autocomplete"
import { Effect } from "effect"

const provider = (id: string, trigger: string): Autocomplete.Provider => ({
  info: { id, trigger: { value: trigger, kind: "character" }, title: id },
  search: async () => ({ items: [] }),
})

const run = <A>(effect: Effect.Effect<A, never, Autocomplete.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Autocomplete.globalLayer)))

describe("autocomplete registry", () => {
  test("rejects duplicate triggers", async () => {
    await run(
      Effect.gen(function* () {
        const autocomplete = yield* Autocomplete.Service
        autocomplete.registry("/tmp/one").add(provider("example.one", "#"))
        expect(() => autocomplete.registry("/tmp/one").add(provider("example.two", "#"))).toThrow(
          "already registered",
        )
      }),
    )
  })

  test("requires a provider's registered trigger", async () => {
    await run(
      Effect.gen(function* () {
        const autocomplete = yield* Autocomplete.Service
        autocomplete.registry("/tmp/one").add(provider("example.one", "#"))
        expect(
          yield* autocomplete.search({
            directory: "/tmp/one",
            providerID: "example.one",
            trigger: "$",
            query: "",
          }),
        ).toEqual({ items: [] })
      }),
    )
  })
})
