/**
 * Regression test: global SSE endpoint must remove its GlobalBus listener when
 * the client disconnects mid-stream.
 *
 * Bug: Stream.callback in eventResponse() registers GlobalBus.on("event", …)
 * via an acquireRelease inside the stream's scope. When a TCP client aborts the
 * connection (reader.cancel() on a real fetch), the Effect stream finalizer
 * (and therefore GlobalBus.off) must run. If it does not, a dangling listener
 * accumulates for every abandoned connection.
 *
 * This test uses a real Server.listen so that the TCP abort path is exercised,
 * not the in-process handler (which delivers the abort differently).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { GlobalBus } from "../../src/bus/global"
import { Server } from "../../src/server/server"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { withTimeout } from "../../src/util/timeout"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

void Log.init({ print: false })

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const originalPassword = Flag.OPENCODE_SERVER_PASSWORD
const originalUsername = Flag.OPENCODE_SERVER_USERNAME

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = originalPassword
  Flag.OPENCODE_SERVER_USERNAME = originalUsername
  if (originalPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = originalPassword
  await disposeAllInstances()
  await resetDatabase()
})

async function startListener() {
  Flag.OPENCODE_SERVER_PASSWORD = undefined
  delete process.env.OPENCODE_SERVER_PASSWORD
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

describe("global SSE abort cleanup", () => {
  test("removes GlobalBus listener when TCP client cancels the SSE stream", async () => {
    const listener = await startListener()
    try {
      const listenersBefore = GlobalBus.listenerCount("event")

      // Open the global event SSE stream over a real TCP connection.
      const controller = new AbortController()
      const response = await withTimeout(
        fetch(new URL(GlobalPaths.event, listener.url), { signal: controller.signal }),
        5_000,
        "timed out opening global event stream",
      )

      expect(response.status).toBe(200)
      expect(response.body).not.toBeNull()

      const reader = response.body!.getReader()

      // Read the initial server.connected event to confirm the SSE is live and
      // the GlobalBus.on acquire side has run.
      const first = await withTimeout(reader.read(), 5_000, "timed out reading first SSE event")
      expect(first.done).toBe(false)

      // Allow a microtask turn for the Effect fiber to settle the acquire.
      await settle(50)

      // Sanity: at least one listener should be registered while connected.
      const listenersWhileConnected = GlobalBus.listenerCount("event")
      expect(listenersWhileConnected).toBeGreaterThan(listenersBefore)

      // Abort the connection, simulating client disconnect.
      controller.abort()
      await reader.cancel().catch(() => undefined)

      // Give the runtime time to propagate the cancellation through the Effect
      // stream and run the acquireRelease finalizer (GlobalBus.off).
      await settle(200)

      // The GlobalBus listener registered by eventResponse() must be gone.
      // Failure here means there is a listener leak per disconnected SSE client.
      const listenersAfter = GlobalBus.listenerCount("event")
      expect(listenersAfter).toBe(listenersBefore)
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping listener").catch(() => undefined)
    }
  })
})
