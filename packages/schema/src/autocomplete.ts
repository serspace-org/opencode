export * as Autocomplete from "./autocomplete"

import { Schema } from "effect"
import { optional } from "./schema"

export const Trigger = Schema.Struct({
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  kind: Schema.Literals(["character", "prefix"]),
  description: Schema.String.check(Schema.isMaxLength(200)).pipe(optional),
}).annotate({ identifier: "Autocomplete.Trigger" })
export interface Trigger extends Schema.Schema.Type<typeof Trigger> {}

export const ProviderInfo = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  trigger: Trigger,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  description: Schema.String.check(Schema.isMaxLength(200)).pipe(optional),
  priority: Schema.Int.pipe(optional),
  maxResults: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(optional),
  cacheTTL: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(optional),
}).annotate({ identifier: "Autocomplete.ProviderInfo" })
export interface ProviderInfo extends Schema.Schema.Type<typeof ProviderInfo> {}

export const TextSelection = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String.check(Schema.isMaxLength(4_000)),
}).annotate({ identifier: "Autocomplete.TextSelection" })

export const ContextSelection = Schema.Struct({
  type: Schema.Literal("context"),
  content: Schema.String.check(Schema.isMaxLength(4_000)),
  display: Schema.String.check(Schema.isMaxLength(200)),
  source: Schema.Struct({
    providerID: Schema.String.check(Schema.isMaxLength(100)),
    entityType: Schema.String.check(Schema.isMaxLength(100)),
    entityID: Schema.String.check(Schema.isMaxLength(200)),
    metadata: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(1_000))).pipe(optional),
  }),
}).annotate({ identifier: "Autocomplete.ContextSelection" })

export const Selection = Schema.Union([TextSelection, ContextSelection]).annotate({
  identifier: "Autocomplete.Selection",
})
export type Selection = Schema.Schema.Type<typeof Selection>

export const Item = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  label: Schema.String.check(Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMaxLength(500)).pipe(optional),
  group: Schema.String.check(Schema.isMaxLength(100)).pipe(optional),
  icon: Schema.String.check(Schema.isMaxLength(100)).pipe(optional),
  detail: Schema.String.check(Schema.isMaxLength(1_000)).pipe(optional),
  selection: Selection,
}).annotate({ identifier: "Autocomplete.Item" })
export interface Item extends Schema.Schema.Type<typeof Item> {}

export const SearchResult = Schema.Struct({
  items: Schema.Array(Item),
  stale: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Autocomplete.SearchResult" })
export interface SearchResult extends Schema.Schema.Type<typeof SearchResult> {}
