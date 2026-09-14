import { describe, expect, test } from "bun:test"
import { Autocomplete } from "../src/autocomplete"
import { Location } from "../src/location"
import { Effect } from "effect"
import { AbsolutePath } from "../src/schema"
import { Project } from "../src/project"

const provider = (id: string, trigger: string): Autocomplete.Provider => ({
  info: { id, trigger: { value: trigger, kind: "character" }, title: id },
  search: async () => ({ items: [] }),
})

const run = <A>(effect: Effect.Effect<A, never, Autocomplete.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Autocomplete.locationLayer),
      Effect.provideService(
        Location.Service,
        Location.Service.of({
          directory: AbsolutePath.make("/tmp/autocomplete-test"),
          project: { id: Project.ID.make("project"), directory: AbsolutePath.make("/tmp/autocomplete-test") },
        }),
      ),
    ),
  )

describe("autocomplete registry", () => {
  test("rejects duplicate triggers", async () => {
    await run(
      Effect.gen(function* () {
        const autocomplete = yield* Autocomplete.Service
        autocomplete.registry.add(provider("example.one", "#"))
        expect(() => autocomplete.registry.add(provider("example.two", "#"))).toThrow("already registered")
      }),
    )
  })

  test("requires a provider's registered trigger", async () => {
    await run(
      Effect.gen(function* () {
        const autocomplete = yield* Autocomplete.Service
        autocomplete.registry.add(provider("example.one", "#"))
        expect(
          yield* autocomplete.search({
            providerID: "example.one",
            trigger: "$",
            query: "",
          }),
        ).toEqual({ items: [] })
      }),
    )
  })
})
