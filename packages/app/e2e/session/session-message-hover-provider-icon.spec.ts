import { test, expect } from "../fixtures"
import { withSession } from "../actions"

type Sdk = Parameters<typeof withSession>[0]

async function seedUserMessage(sdk: Sdk, sessionID: string) {
  await sdk.session.promptAsync({
    sessionID,
    noReply: true,
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    parts: [{ type: "text", text: "e2e provider icon test" }],
  })

  await expect
    .poll(
      async () => {
        const msgs = await sdk.session.messages({ sessionID, limit: 5 }).then((r) => r.data ?? [])
        return msgs.some((m) => m.info.role === "user")
      },
      { timeout: 30_000 },
    )
    .toBe(true)
}

test("user message hover shows provider icon to the left of model name", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e provider icon ${Date.now()}`, async (session) => {
    await seedUserMessage(sdk, session.id)
    await gotoSession(session.id)

    const msg = page.locator('[data-component="user-message"]').first()
    await expect(msg).toBeVisible()

    await msg.hover()

    const wrap = msg.locator('[data-slot="user-message-meta-wrap"]').first()
    await expect(wrap).toBeVisible({ timeout: 10_000 })

    const icon = wrap.locator('[data-component="provider-icon"]').first()
    await expect(icon).toBeVisible({ timeout: 5_000 })
  })
})

test("user message hover meta shows no provider icon when provider id is unknown", async ({
  page,
  sdk,
  gotoSession,
}) => {
  await withSession(sdk, `e2e no-provider icon ${Date.now()}`, async (session) => {
    await sdk.session.promptAsync({
      sessionID: session.id,
      noReply: true,
      model: { providerID: "unknown-provider-xyz", modelID: "some-model" },
      parts: [{ type: "text", text: "e2e missing provider icon test" }],
    })

    await expect
      .poll(
        async () => {
          const msgs = await sdk.session.messages({ sessionID: session.id, limit: 5 }).then((r) => r.data ?? [])
          return msgs.some((m) => m.info.role === "user")
        },
        { timeout: 30_000 },
      )
      .toBe(true)

    await gotoSession(session.id)

    const msg = page.locator('[data-component="user-message"]').first()
    await expect(msg).toBeVisible()
    await msg.hover()

    const wrap = msg.locator('[data-slot="user-message-meta-wrap"]').first()
    await expect(wrap).toBeVisible({ timeout: 10_000 })

    const icon = wrap.locator('[data-component="provider-icon"]').first()
    await expect(icon).toHaveCount(0)
  })
})
