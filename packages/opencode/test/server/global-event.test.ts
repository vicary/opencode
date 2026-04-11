import { afterEach, describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util"

Log.init({ print: false })

afterEach(() => {
  GlobalBus.removeAllListeners("event")
})

describe("global event endpoint", () => {
  test("removes GlobalBus listener when client disconnects", async () => {
    const base = GlobalBus.listenerCount("event")
    const srv = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    const ctrl = new AbortController()

    try {
      const res = await fetch(new URL("/global/event", srv.url), {
        signal: ctrl.signal,
      })

      expect(res.status).toBe(200)

      const reader = res.body?.getReader()
      expect(reader).toBeTruthy()
      await reader!.read()

      expect(GlobalBus.listenerCount("event")).toBe(base + 1)

      ctrl.abort()

      for (let i = 0; i < 50; i++) {
        if (GlobalBus.listenerCount("event") === base) break
        await new Promise((r) => setTimeout(r, 10))
      }

      expect(GlobalBus.listenerCount("event")).toBe(base)
    } finally {
      ctrl.abort()
      await srv.stop(true)
      GlobalBus.removeAllListeners("event")
    }
  }, 5000)
})
