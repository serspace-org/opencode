/** @jsxImportSource @opentui/solid */
import { RGBA, TextAttributes } from "@opentui/core"
import type { TuiPlugin, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui"

const ink = (theme: Record<string, unknown>, name: string, fallback: string) => {
  const value = theme[name]
  if (typeof value === "string") return value
  if (value instanceof RGBA) return value
  return fallback
}

const defaultArt = [
  "   _____ __________  _____ ____  ___   ____________   __    ___    ____ _____",
  "  / ___// ____/ __ \\/ ___// __ \\/   | / ____/ ____/  / /   /   |  / __ ) ___/",
  "  \\__ \\/ __/ / /_/ /\\__ \\/ /_/ / /| |/ /   / __/    / /   / /| | / __  \\__ \\ ",
  " ___/ / /___/ _, _/___/ / ____/ ___ / /___/ /___   / /___/ ___ |/ /_/ /__/ / ",
  "/____/_____/_/ |_|/____/_/   /_/  |_\\____/_____/  /_____/_/  |_/_____/____/  ",
]

function Logo(ctx: TuiSlotContext, art: string[]) {
  const theme = ctx.theme.current as Record<string, unknown>
  const fill = [
    ink(theme, "primary", "#5f87ff"),
    ink(theme, "primary", "#5f87ff"),
    ink(theme, "text", "#d7d7d7"),
    ink(theme, "textMuted", "#a5a5a5"),
    ink(theme, "textMuted", "#a5a5a5"),
  ]
  return (
    <box flexDirection="column">
      {art.map((line, index) => (
        <text
          selectable={false}
          fg={fill[index] ?? ink(theme, "textMuted", "#a5a5a5")}
          attributes={TextAttributes.BOLD}
        >
          {line}
        </text>
      ))}
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const art = typeof options?.art === "string" && options.art.trim() ? options.art.split("\n") : defaultArt

  api.slots.register({
    slots: {
      home_logo: (ctx) => Logo(ctx, art),
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "serspace-logo",
  tui,
}

export default plugin
