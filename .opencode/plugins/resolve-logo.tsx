/** @jsxImportSource @opentui/solid */
import { RGBA, TextAttributes } from "@opentui/core"
import type { TuiPlugin, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui"

const ink = (theme: Record<string, unknown>, name: string, fallback: string) => {
  const value = theme[name]
  if (typeof value === "string") return value
  if (value instanceof RGBA) return value
  return fallback
}

function Logo(ctx: TuiSlotContext) {
  const theme = ctx.theme.current as Record<string, unknown>
  return (
    <text selectable={false}>
      <span style={{ fg: ink(theme, "textMuted", "#a5a5a5") }}>Re</span>
      <span style={{ fg: ink(theme, "primary", "#5f87ff"), attributes: TextAttributes.BOLD }}>solve</span>
    </text>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    slots: {
      home_logo: (ctx) => Logo(ctx),
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "resolve-logo",
  tui,
}

export default plugin
