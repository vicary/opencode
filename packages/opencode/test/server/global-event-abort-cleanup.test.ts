import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { GlobalBus } from "@/bus/global"
import { Server } from "@/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

function app() {
  return Server.Default().app
}

function abortStream() {
  return Effect.gen(function* () {
    const baseline = GlobalBus.listenerCount("event")
    const controller = new AbortController()
    const response = yield* Effect.promise(() =>
      Promise.resolve(
        app().request("/global/event", {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        }),
      ),
    )
    const reader = response.body?.getReader()

    expect(response.status).toBe(200)

    if (reader) {
      yield* Effect.promise(() => reader.read()).pipe(Effect.asVoid)
    }

    expect(GlobalBus.listenerCount("event")).toBe(baseline + 1)

    controller.abort()
    yield* Effect.promise(() => reader?.cancel().catch(() => {}) ?? Promise.resolve())

    yield* Effect.sleep("50 millis")
    expect(GlobalBus.listenerCount("event")).toBe(baseline)
  })
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  GlobalBus.removeAllListeners("event")
})

describe("global event abort cleanup", () => {
  it.live("removes the global bus listener when the client aborts /global/event", () =>
    Effect.gen(function* () {
      yield* abortStream()
      yield* abortStream()
    }),
  )
})
