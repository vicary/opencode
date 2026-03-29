import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { shouldUseV2NewSessionPage } from "./new-session-layout"

const dir = dirname(fileURLToPath(import.meta.url))

describe("shouldUseV2NewSessionPage", () => {
  test("keeps prod session pages on the legacy layout", () => {
    expect(shouldUseV2NewSessionPage({ channel: "prod", sessionID: "ses_123" })).toBe(false)
    expect(shouldUseV2NewSessionPage({ channel: "prod" })).toBe(false)
  })

  test("uses the v2 layout only for non-prod new-session pages", () => {
    expect(shouldUseV2NewSessionPage({ channel: "dev" })).toBe(true)
    expect(shouldUseV2NewSessionPage({ channel: "dev", sessionID: "ses_123" })).toBe(false)
  })

  test("session page renders the dock composer only once", async () => {
    const src = await Bun.file(join(dir, "../session.tsx")).text()
    const matches = src.match(/<Show when=\{params\.id \|\| !USE_NEW_SESSION_DESIGN\}>\{composerRegion\("dock"\)\}<\/Show>/g)
    expect(matches?.length ?? 0).toBe(1)
  })
})
