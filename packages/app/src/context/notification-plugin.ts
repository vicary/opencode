import type { EventSessionError } from "@opencode-ai/sdk/v2"

export function message(err: EventSessionError["properties"]["error"]) {
  if (!err) return
  if (err.name !== "UnknownError") return
  return err.data.message
}

export function isPlugin(msg: string) {
  if (msg.startsWith("Failed to install plugin ")) return true
  if (msg.startsWith("Failed to load plugin ")) return true
  return msg.startsWith("Plugin ") && msg.includes(" skipped: ")
}
