import type { AutocompleteRegistry, Plugin } from "../src/index.js"

const records = [
  { id: "person_ada", type: "person", name: "Ada Lovelace" },
  { id: "project_engine", type: "project", name: "Analytical Engine" },
  { id: "task_notes", type: "task", name: "Write algorithm notes" },
]

/** Local demo: # searches these records; @ includes them alongside built-in suggestions. */
export const ExampleAutocompletePlugin = (async () => ({
  autocomplete: {
    register(registry: AutocompleteRegistry) {
      for (const trigger of ["#", "@"]) {
        const providerID = trigger === "#" ? "example.records" : "example.records.mentions"
        registry.add({
          info: {
            id: providerID,
            trigger: { value: trigger, kind: "character", description: "Example records" },
            title: "Example records",
            priority: 100,
            maxResults: 10,
          },
          async search(input) {
            await new Promise((resolve) => setTimeout(resolve, 75))
            if (input.signal.aborted) return { items: [] }
            const query = input.query.toLowerCase()
            return {
              items: records
                .filter((record) => record.name.toLowerCase().includes(query))
                .map((record) => ({
                  id: record.id,
                  label: record.name,
                  description: record.type,
                  group: record.type,
                  selection: {
                    type: "context" as const,
                    content: `${input.trigger}${record.name}`,
                    display: record.name,
                    source: {
                      providerID,
                      entityType: record.type,
                      entityID: record.id,
                      metadata: { example: "true" },
                    },
                  },
                })),
            }
          },
        })
      }
    },
  },
})) satisfies Plugin
