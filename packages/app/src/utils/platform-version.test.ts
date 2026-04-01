import { describe, expect, test } from "bun:test"
import { resolvePlatformVersion } from "./platform-version"

describe("resolvePlatformVersion", () => {
  test("prefers the injected build version", () => {
    expect(resolvePlatformVersion("1.3.7", "1.3.8-preview.202604011002")).toBe("1.3.8-preview.202604011002")
  })

  test("falls back to package version when no injected version exists", () => {
    expect(resolvePlatformVersion("1.3.7", undefined)).toBe("1.3.7")
  })
})
