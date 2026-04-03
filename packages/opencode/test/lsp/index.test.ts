import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test"
import path from "path"
import { Deferred, Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { LSPClient } from "@/lsp/client"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LSP.defaultLayer, CrossSpawnSpawner.defaultLayer))
const experimentalTyIt = testEffect(
  Layer.mergeAll(
    LSP.layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(RuntimeFlags.layer({ experimentalLspTy: true }))),
    CrossSpawnSpawner.defaultLayer,
  ),
)
const disabledDownloadIt = testEffect(
  Layer.mergeAll(
    LSP.layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(RuntimeFlags.layer({ disableLspDownload: true }))),
    CrossSpawnSpawner.defaultLayer,
  ),
)
const idleLayer = Layer.mergeAll(LSP.defaultLayer, CrossSpawnSpawner.defaultLayer)
const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
const IDLE_MS = 300_000
const SWEEP_MS = 30_000

let fake = false

afterEach(async () => {
  await disposeAllInstances()
  if (!fake) return
  jest.clearAllTimers()
  jest.useRealTimers()
  fake = false
})

function clock() {
  jest.useFakeTimers()
  fake = true
}

async function tick(ms: number) {
  jest.advanceTimersByTime(ms)
  for (let i = 0; i < 5; i += 1) await new Promise<void>((done) => queueMicrotask(done))
}

function proc() {
  return {
    pid: 1,
    stdin: {} as any,
    stdout: {} as any,
    stderr: {} as any,
    kill: mock(() => true),
    on: mock(() => undefined),
    once: mock(() => undefined),
    removeListener: mock(() => undefined),
    removeAllListeners: mock(() => undefined),
  } as any
}

function client(root: string, stop: Array<string>) {
  return {
    root,
    serverID: "typescript",
    connection: {
      sendRequest: mock(async () => []),
    } as unknown as LSPClient.Info["connection"],
    notify: {
      open: mock(async () => undefined),
    },
    diagnostics: new Map(),
    waitForDiagnostics: mock(async () => undefined),
    shutdown: mock(async () => {
      stop.push(root)
    }),
  } as unknown as LSPClient.Info
}

describe("lsp.spawn", () => {
  it.live("does not spawn builtin LSP for files outside instance", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.touchFile(path.join(dir, "..", "outside.ts"))
              yield* lsp.hover({
                file: path.join(dir, "..", "hover.ts"),
                line: 0,
                character: 0,
              })
              expect(spy).toHaveBeenCalledTimes(0)
            } finally {
              spy.mockRestore()
            }
          }),
        ),
      { config: { lsp: true } },
    ),
  )

  it.live("does not spawn builtin LSP for files inside instance when LSP is unset", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.ts"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(0)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    ),
  )

  it.live("would spawn builtin LSP for files inside instance when lsp is true", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.ts"),
                line: 0,
                character: 0,
              })
              expect(spy).toHaveBeenCalledTimes(1)
            } finally {
              spy.mockRestore()
            }
          }),
        ),
      { config: { lsp: true } },
    ),
  )

  it.live("publishes lsp.updated after custom LSP initialization", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const updated = yield* Deferred.make<void>()
          const unsubscribe = Bus.subscribe(LSP.Event.Updated, () =>
            Effect.runSync(Deferred.succeed(updated, undefined)),
          )
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

          const file = path.join(dir, "sample.repro")
          yield* Effect.promise(() => Bun.write(file, "sample\n"))
          yield* lsp.touchFile(file)
          yield* awaitWithTimeout(Deferred.await(updated), "lsp.updated event was not published")
        }),
      {
        config: {
          lsp: {
            fake: {
              command: [process.execPath, fakeServerPath],
              extensions: [".repro"],
            },
          },
        },
      },
    ),
  )

  it.live("would spawn builtin LSP for files inside instance when config object is provided", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.ts"),
                line: 0,
                character: 0,
              })
              expect(spy).toHaveBeenCalledTimes(1)
            } finally {
              spy.mockRestore()
            }
          }),
        ),
      {
        config: {
          lsp: {
            eslint: { disabled: true },
          },
        },
      },
    ),
  )

  it.live("uses pyright instead of ty by default", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const ty = spyOn(LSPServer.Ty, "spawn").mockResolvedValue(undefined)
            const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.py"),
                line: 0,
                character: 0,
              })
              expect(ty).toHaveBeenCalledTimes(0)
              expect(pyright).toHaveBeenCalledTimes(1)
            } finally {
              ty.mockRestore()
              pyright.mockRestore()
            }
          }),
        ),
      { config: { lsp: true } },
    ),
  )

  experimentalTyIt.live("uses ty instead of pyright when experimentalLspTy is enabled", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const ty = spyOn(LSPServer.Ty, "spawn").mockResolvedValue(undefined)
            const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.py"),
                line: 0,
                character: 0,
              })
              expect(ty).toHaveBeenCalledTimes(1)
              expect(pyright).toHaveBeenCalledTimes(0)
            } finally {
              ty.mockRestore()
              pyright.mockRestore()
            }
          }),
        ),
      { config: { lsp: true } },
    ),
  )

  disabledDownloadIt.live("passes disableLspDownload to builtin LSP spawn", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.py"),
                line: 0,
                character: 0,
              })
              expect(pyright).toHaveBeenCalledTimes(1)
              expect(pyright.mock.calls[0]?.[2]).toMatchObject({ disableLspDownload: true })
            } finally {
              pyright.mockRestore()
            }
          }),
        ),
      { config: { lsp: true } },
    ),
  )

  test("idle lsp client is evicted without disposing the instance", async () => {
    clock()
    const stop: Array<string> = []
    const spawn = spyOn(LSPServer.Typescript, "spawn").mockImplementation(async () => ({ process: proc() }))
    const create = spyOn(LSPClient, "create").mockImplementation(async (input) => client(input.root, stop))

    try {
      await Effect.runPromise(
        provideTmpdirInstance(
          (root) =>
            LSP.Service.use((lsp) =>
              Effect.gen(function* () {
                const file = path.join(root, "src", "inside.ts")
                yield* lsp.hover({ file, line: 0, character: 0 })
                yield* Effect.promise(() => tick(IDLE_MS + SWEEP_MS + 1))
                expect(stop).toEqual([root])
                yield* lsp.hover({ file, line: 0, character: 0 })
              }),
            ),
          { config: { lsp: true } },
        ).pipe(Effect.scoped, Effect.provide(idleLayer)),
      )

      expect(spawn).toHaveBeenCalledTimes(2)
      expect(create).toHaveBeenCalledTimes(2)
    } finally {
      spawn.mockRestore()
      create.mockRestore()
    }
  })

  test("active lsp use refreshes idle lifetime", async () => {
    clock()
    const stop: Array<string> = []
    const spawn = spyOn(LSPServer.Typescript, "spawn").mockImplementation(async () => ({ process: proc() }))
    const create = spyOn(LSPClient, "create").mockImplementation(async (input) => client(input.root, stop))

    try {
      await Effect.runPromise(
        provideTmpdirInstance(
          (root) =>
            LSP.Service.use((lsp) =>
              Effect.gen(function* () {
                const file = path.join(root, "src", "inside.ts")
                yield* lsp.hover({ file, line: 0, character: 0 })
                yield* Effect.promise(() => tick(IDLE_MS - 1))
                yield* lsp.hover({ file, line: 0, character: 0 })
                yield* Effect.promise(() => tick(SWEEP_MS + 1))
                expect(stop).toEqual([])
                yield* lsp.hover({ file, line: 0, character: 0 })
                expect(spawn).toHaveBeenCalledTimes(1)
                yield* Effect.promise(() => tick(IDLE_MS + SWEEP_MS + 1))
                expect(stop).toEqual([root])
              }),
            ),
          { config: { lsp: true } },
        ).pipe(Effect.scoped, Effect.provide(idleLayer)),
      )
    } finally {
      spawn.mockRestore()
      create.mockRestore()
    }
  })

  test("one stale root is evicted while another active root remains", async () => {
    clock()
    const stop: Array<string> = []
    const root = spyOn(LSPServer.Typescript, "root")
    const spawn = spyOn(LSPServer.Typescript, "spawn").mockImplementation(async () => ({ process: proc() }))
    const create = spyOn(LSPClient, "create").mockImplementation(async (input) => client(input.root, stop))

    try {
      await Effect.runPromise(
        provideTmpdirInstance(
          (dir) =>
            LSP.Service.use((lsp) =>
              Effect.gen(function* () {
                const a = path.join(dir, "a")
                const b = path.join(dir, "b")
                root.mockImplementation(async (file) => (file.includes(`${path.sep}b${path.sep}`) ? b : a))
                yield* lsp.hover({ file: path.join(a, "one.ts"), line: 0, character: 0 })
                yield* lsp.hover({ file: path.join(b, "two.ts"), line: 0, character: 0 })
                yield* Effect.promise(() => tick(IDLE_MS - 1))
                yield* lsp.hover({ file: path.join(b, "two.ts"), line: 0, character: 0 })
                yield* Effect.promise(() => tick(SWEEP_MS + 1))
                expect(stop).toEqual([a])
                yield* lsp.hover({ file: path.join(b, "two.ts"), line: 0, character: 0 })
                expect(spawn).toHaveBeenCalledTimes(2)
                yield* Effect.promise(() => tick(IDLE_MS + SWEEP_MS + 1))
                expect(stop).toEqual([a, b])
              }),
            ),
          { config: { lsp: true } },
        ).pipe(Effect.scoped, Effect.provide(idleLayer)),
      )
    } finally {
      root.mockRestore()
      spawn.mockRestore()
      create.mockRestore()
    }
  })
})
