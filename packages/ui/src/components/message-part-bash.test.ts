import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("message part bash renderer", () => {
  test("shows the shell description while pending", () => {
    const source = readFileSync(new URL("./message-part.tsx", import.meta.url), "utf8")

    expect(source).toContain('<Show when={props.input.description}>')
    expect(source).not.toContain('<Show when={!pending() && props.input.description}>')
  })
})
