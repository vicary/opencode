import { describe, expect, test } from "bun:test"
import { isPlugin, message } from "./notification-plugin"

describe("notification plugin helpers", () => {
  test("reads plugin message from UnknownError payload", () => {
    expect(message({ name: "UnknownError", data: { message: "Failed to install plugin demo@9.9.9: boom" } })).toBe(
      "Failed to install plugin demo@9.9.9: boom",
    )
  })

  test("returns undefined for non-unknown errors", () => {
    expect(
      message({
        name: "ProviderAuthError",
        data: { providerID: "demo", message: "auth required" },
      } as never),
    ).toBeUndefined()
  })

  test("matches install, load, and skipped plugin errors only", () => {
    expect(isPlugin("Failed to install plugin demo@9.9.9: boom")).toBe(true)
    expect(isPlugin("Failed to load plugin demo: explode")).toBe(true)
    expect(isPlugin("Plugin demo skipped: incompatible")).toBe(true)
    expect(isPlugin("Failed to parse command foo")).toBe(false)
  })
})
