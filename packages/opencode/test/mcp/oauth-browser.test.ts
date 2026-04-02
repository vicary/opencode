import { test, expect, mock, beforeEach, afterEach } from "bun:test"
import { EventEmitter } from "events"
import { Deferred, Effect, Layer, Option } from "effect"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import type { MCP as MCPNS } from "../../src/mcp/index"
import type { InstanceContext } from "../../src/project/instance-context"

// Track open() calls and control failure behavior
let openShouldFail = false
let openCalledWith: string | undefined
let openDeferred: Deferred.Deferred<string> | undefined
const streamables: Array<{ closed: number }> = []

void mock.module("open", () => ({
  default: async (url: string) => {
    openCalledWith = url
    if (openDeferred) Effect.runSync(Deferred.succeed(openDeferred, url).pipe(Effect.ignore))

    // Return a mock subprocess that emits an error if openShouldFail is true
    const subprocess = new EventEmitter()
    if (openShouldFail) {
      // Emit error asynchronously like a real subprocess would
      setTimeout(() => {
        subprocess.emit("error", new Error("spawn xdg-open ENOENT"))
      }, 10)
    }
    return subprocess
  },
}))

// Mock UnauthorizedError
class MockUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized")
    this.name = "UnauthorizedError"
  }
}

// Track what options were passed to each transport constructor
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown }
}> = []

// Mock the transport constructors
void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    url: string
    closed = 0
    authProvider: { redirectToAuthorization?: (url: URL) => Promise<void> } | undefined
    constructor(url: URL, options?: { authProvider?: { redirectToAuthorization?: (url: URL) => Promise<void> } }) {
      this.url = url.toString()
      this.authProvider = options?.authProvider
      streamables.push(this)
      transportCalls.push({
        type: "streamable",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      // Simulate OAuth redirect by calling the authProvider's redirectToAuthorization
      if (this.authProvider?.redirectToAuthorization) {
        await this.authProvider.redirectToAuthorization(new URL("https://auth.example.com/authorize?client_id=test"))
      }
      throw new MockUnauthorizedError()
    }
    async finishAuth(_code: string) {
      // Mock successful auth completion
    }
    async close() {
      this.closed += 1
    }
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL) {
      transportCalls.push({
        type: "sse",
        url: url.toString(),
        options: {},
      })
    }
    async start() {
      throw new Error("Mock SSE transport cannot connect")
    }
  },
}))

// Mock the MCP SDK Client to trigger OAuth flow
void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(transport: { start: () => Promise<void> }) {
      await transport.start()
    }
  },
}))

// Mock UnauthorizedError in the auth module
void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: MockUnauthorizedError,
}))

beforeEach(() => {
  openShouldFail = false
  openCalledWith = undefined
  openDeferred = undefined
  transportCalls.length = 0
  streamables.length = 0
})

// Import modules after mocking
const { MCP } = await import("../../src/mcp/index")
const { AppRuntime } = await import("../../src/effect/app-runtime")
const { Bus } = await import("../../src/bus")
const { Config } = await import("../../src/config/config")
const { InstanceRef } = await import("../../src/effect/instance-ref")
const { McpAuth } = await import("../../src/mcp/auth")
const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")
const { InstanceRuntime } = await import("../../src/project/instance-runtime")
const { AppFileSystem } = await import("@opencode-ai/core/filesystem")
const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")
const { disposeAllInstances, provideTestInstance, tmpdir, withTestInstance } = await import("../fixture/fixture")
const mcpTest = testEffect(
  MCP.layer.pipe(
    Layer.provide(McpAuth.defaultLayer),
    Layer.provideMerge(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
  ),
)
const service = MCP.Service as unknown as Effect.Effect<MCPNS.Interface, never, never>
const runInInstance = <A, E, R>(ctx: InstanceContext, effect: Effect.Effect<A, E, R>) =>
  AppRuntime.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))
const authenticate = (ctx: InstanceContext, name: string) => runInInstance(ctx, Effect.gen(function* () {
  const mcp = yield* service
  return yield* mcp.authenticate(name)
}))
const removeAuth = (ctx: InstanceContext, name: string) => runInInstance(ctx, Effect.gen(function* () {
  const mcp = yield* service
  return yield* mcp.removeAuth(name)
}))

afterEach(async () => {
  await McpOAuthCallback.stop().catch(() => undefined)
  await disposeAllInstances()
})

const config = (name: string) => ({
  mcp: {
    [name]: {
      type: "remote" as const,
      url: "https://example.com/mcp",
    },
  },
})

const withCallbackStop = Effect.addFinalizer(() => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore))

const trackBrowserOpen = Effect.gen(function* () {
  const opened = yield* Deferred.make<string>()
  openDeferred = opened
  yield* Effect.addFinalizer(() => Effect.sync(() => (openDeferred = undefined)))
  return opened
})

const trackBrowserOpenFailed = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const event = yield* Deferred.make<{ mcpName: string; url: string }>()
  const unsubscribe = yield* bus.subscribeCallback(MCP.BrowserOpenFailed, (evt) => {
    Effect.runSync(Deferred.succeed(event, evt.properties).pipe(Effect.ignore))
  })
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
  return event
})

const authenticateScoped = (name: string) =>
  Effect.gen(function* () {
    const mcp = yield* service
    yield* mcp.authenticate(name).pipe(
      Effect.ignore,
      Effect.catchCause(() => Effect.void),
      Effect.forkScoped,
    )
  })

mcpTest.instance(
  "BrowserOpenFailed event is published when open() throws",
  () =>
    Effect.gen(function* () {
      yield* withCallbackStop
      openShouldFail = true

      const event = yield* trackBrowserOpenFailed
      yield* authenticateScoped("test-oauth-server")

      const failure = yield* awaitWithTimeout(
        Deferred.await(event),
        "Timed out waiting for BrowserOpenFailed event",
        "5 seconds",
      )

      expect(failure.mcpName).toBe("test-oauth-server")
      expect(failure.url).toContain("https://")
    }),
  { config: config("test-oauth-server") },
)

mcpTest.instance(
  "BrowserOpenFailed event is NOT published when open() succeeds",
  () =>
    Effect.gen(function* () {
      yield* withCallbackStop
      openShouldFail = false

      const opened = yield* trackBrowserOpen
      const event = yield* trackBrowserOpenFailed
      yield* authenticateScoped("test-oauth-server-2")

      yield* awaitWithTimeout(Deferred.await(opened), "Timed out waiting for open()", "5 seconds")
      const failure = yield* Deferred.await(event).pipe(Effect.timeoutOption("700 millis"))

      expect(failure).toEqual(Option.none())
      expect(openCalledWith).toBeDefined()
    }),
  { config: config("test-oauth-server-2") },
)

mcpTest.instance(
  "open() is called with the authorization URL",
  () =>
    Effect.gen(function* () {
      yield* withCallbackStop
      openShouldFail = false
      openCalledWith = undefined

      const opened = yield* trackBrowserOpen
      const event = yield* trackBrowserOpenFailed
      yield* authenticateScoped("test-oauth-server-3")

      const url = yield* awaitWithTimeout(Deferred.await(opened), "Timed out waiting for open()", "5 seconds")
      const failure = yield* Deferred.await(event).pipe(Effect.timeoutOption("700 millis"))

      expect(failure).toEqual(Option.none())
      expect(typeof url).toBe("string")
      expect(url).toContain("https://")
    }),
  { config: config("test-oauth-server-3") },
)

test("pending OAuth transport replacement closes old transport", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            replace: {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await provideTestInstance({
    directory: tmp.path,
    fn: async (ctx) => {
      const a = authenticate(ctx, "replace").catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      expect(streamables).toHaveLength(2)

      const first = streamables.at(-1)!
      const b = authenticate(ctx, "replace").catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      expect(streamables).toHaveLength(3)
      expect(first.closed).toBe(1)
      expect(streamables.at(-1)?.closed).toBe(0)

      await removeAuth(ctx, "replace")
      expect(streamables.at(-1)?.closed).toBe(1)
      await McpOAuthCallback.stop()
      await Promise.all([a, b])
    },
  })
})

test("removeAuth closes pending OAuth transport before deleting it", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            remove: {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await provideTestInstance({
    directory: tmp.path,
    fn: async (ctx) => {
      const auth = authenticate(ctx, "remove").catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      expect(streamables).toHaveLength(2)
      expect(streamables.at(-1)?.closed).toBe(0)

      await removeAuth(ctx, "remove")
      expect(streamables.at(-1)?.closed).toBe(1)

      await McpOAuthCallback.stop()
      await auth
    },
  })
})

test("instance cleanup closes pending OAuth transports", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            finalizer: {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await withTestInstance({
    directory: tmp.path,
    fn: async (ctx) => {
      const auth = authenticate(ctx, "finalizer").catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      expect(streamables).toHaveLength(2)
      expect(streamables.at(-1)?.closed).toBe(0)

      await McpOAuthCallback.stop()
      await auth
      await InstanceRuntime.disposeInstance(ctx)
      expect(streamables.at(-1)?.closed).toBe(1)
    },
  })
})

test("instance cleanup does not clear another instance pending transport", async () => {
  await using a = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            keep: {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await using b = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            drop: {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  let keep: { closed: number } | undefined
  let drop: { closed: number } | undefined
  let keepCtx: InstanceContext | undefined

  await withTestInstance({
    directory: a.path,
    fn: async (ctx) => {
      keepCtx = ctx
      const auth = authenticate(ctx, "keep").catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      keep = streamables.at(-1)
      await McpOAuthCallback.stop()
      await auth
    },
  })

  await withTestInstance({
    directory: b.path,
    fn: async (ctx) => {
      const auth = authenticate(ctx, "drop").catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      drop = streamables.at(-1)
      expect(keep?.closed).toBe(0)
      expect(drop?.closed).toBe(0)
      await McpOAuthCallback.stop()
      await auth
      await InstanceRuntime.disposeInstance(ctx)
      expect(drop?.closed).toBe(1)
      expect(keep?.closed).toBe(0)
    },
  })

  expect(keepCtx).toBeDefined()
  expect(keep?.closed).toBe(0)
  await removeAuth(keepCtx!, "keep")
  expect(keep?.closed).toBe(1)
  await InstanceRuntime.disposeInstance(keepCtx!)
})
