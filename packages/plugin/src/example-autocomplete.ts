import type { Plugin } from "./index.js"

const records = [
  { id: "person_ada", type: "person", name: "Ada Lovelace" },
  { id: "project_engine", type: "project", name: "Analytical Engine" },
  { id: "task_notes", type: "task", name: "Write algorithm notes" },
]

/** Contrived local provider. Add this file to `plugin` in opencode.json, then type `#` in the prompt. */
export const ExampleAutocompletePlugin: Plugin = async () => ({
  autocomplete: {
    register(registry) {
      registry.add({
        info: {
          id: "example.records",
          trigger: { value: "#", kind: "character", description: "Example records" },
          title: "Example records",
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
                  content: `#${record.name}`,
                  display: record.name,
                  source: {
                    providerID: "example.records",
                    entityType: record.type,
                    entityID: record.id,
                    metadata: { example: "true" },
                  },
                },
              })),
          }
        },
      })
    },
  },
})
