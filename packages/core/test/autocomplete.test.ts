import { describe, expect, test } from "bun:test"
import { Autocomplete } from "../src/autocomplete"
import { Effect, Fiber } from "effect"

const provider = (id: string, trigger: string): Autocomplete.Provider => ({
  info: { id, trigger: { value: trigger, kind: "character" }, title: id },
  search: async () => ({ items: [] }),
})

const run = <A>(effect: Effect.Effect<A, never, Autocomplete.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Autocomplete.globalLayer)))

describe("autocomplete registry", () => {
  test("multiple @ providers coexist and dispose independently", async () => {
    await run(
      Effect.gen(function* () {
        const autocomplete = yield* Autocomplete.Service
        const registry = autocomplete.registry("/tmp/one")
        const dispose = registry.add(provider("one", "@"))
        registry.add(provider("two", "@"))
        registry.add(provider("dedicated", "#"))
        expect((yield* autocomplete.providers("/tmp/one")).map((item) => item.id)).toEqual(["dedicated", "one", "two"])
        dispose()
        expect((yield* autocomplete.providers("/tmp/one")).map((item) => item.id)).toEqual(["dedicated", "two"])
        expect(() => registry.add(provider("two", "@"))).toThrow("Duplicate")
      }),
    )
  })

  test("interrupting search aborts the provider signal", async () => {
    await run(
      Effect.gen(function* () {
        const autocomplete = yield* Autocomplete.Service
        const started = Promise.withResolvers<AbortSignal>()
        autocomplete.registry("/tmp/one").add({
          ...provider("one", "#"),
          search: (input) =>
            new Promise((resolve) => {
              started.resolve(input.signal)
              input.signal.addEventListener("abort", () => resolve({ items: [] }), { once: true })
            }),
        })
        const fiber = yield* autocomplete
          .search({ directory: "/tmp/one", providerID: "one", trigger: "#", query: "" })
          .pipe(Effect.forkChild)
        const signal = yield* Effect.promise(() => started.promise)
        yield* Fiber.interrupt(fiber)
        expect(signal.aborted).toBe(true)
      }),
    )
  })

  test("isolates directories and supports re-registration after disposal", async () => {
    await run(
      Effect.gen(function* () {
        const autocomplete = yield* Autocomplete.Service
        const registry = autocomplete.registry("/tmp/one")
        const dispose = registry.add(provider("one", "#"))
        expect(yield* autocomplete.providers("/tmp/two")).toEqual([])
        dispose()
        registry.add(provider("two", "#"))
        dispose()
        expect((yield* autocomplete.providers("/tmp/one")).map((item) => item.id)).toEqual(["two"])
      }),
    )
  })

  test("provider exceptions and malformed results return empty results", async () => {
    await run(
      Effect.gen(function* () {
        const autocomplete = yield* Autocomplete.Service
        const registry = autocomplete.registry("/tmp/one")
        const dispose = registry.add({
          ...provider("one", "#"),
          search: async () => {
            throw new Error("private query")
          },
        })
        const input = { directory: "/tmp/one", providerID: "one", trigger: "#", query: "" }
        expect(yield* autocomplete.search(input)).toEqual({ items: [] })
        dispose()
        // Exercise a JavaScript plugin boundary without asserting a false TypeScript type.
        registry.add({ ...provider("one", "#"), search: async () => JSON.parse('{"items":null}') })
        expect(yield* autocomplete.search(input)).toEqual({ items: [] })
      }),
    )
  })

  test("validates registration before mutating the registry", async () => {
    await run(
      Effect.gen(function* () {
        const autocomplete = yield* Autocomplete.Service
        const registry = autocomplete.registry("/tmp/one")
        expect(() => registry.add(provider("builtin", "/"))).toThrow("Reserved")
        expect(() =>
          registry.add({ ...provider("invalid", "#"), info: { ...provider("invalid", "#").info, maxResults: -1 } }),
        ).toThrow()
        registry.add(provider("valid", "#"))
        expect((yield* autocomplete.providers("/tmp/one")).map((item) => item.id)).toEqual(["valid"])
      }),
    )
  })

  test("rejects duplicate triggers", async () => {
    await run(
      Effect.gen(function* () {
        const autocomplete = yield* Autocomplete.Service
        autocomplete.registry("/tmp/one").add(provider("example.one", "#"))
        expect(() => autocomplete.registry("/tmp/one").add(provider("example.two", "#"))).toThrow("already registered")
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

  test("initializes providers for the requested directory", async () => {
    await run(
      Effect.gen(function* () {
        const autocomplete = yield* Autocomplete.Service
        autocomplete.initialize((directory) =>
          Effect.sync(() => {
            autocomplete.registry(directory).add(provider("example.one", "#"))
          }),
        )
        expect(yield* autocomplete.providers("/tmp/one")).toEqual([provider("example.one", "#").info])
      }),
    )
  })
})
