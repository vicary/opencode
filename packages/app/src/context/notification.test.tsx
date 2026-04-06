import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

const calls = {
  notify: [] as Array<{ title: string; description?: string; href?: string }>,
  sound: [] as string[],
  dialog: [] as Array<() => unknown>,
}

const listeners: Array<(input: { name: string; details: { type: string; properties: Record<string, unknown> } }) => void> = []

const globalSync = {
  child: () => [
    {
      session: [],
    },
  ],
}

const store = new Map<symbol, unknown>()
let persistedState: { list: Array<{ directory?: string; type: string; viewed: boolean }> } | undefined

mock.module("@solidjs/router", () => ({
  useParams: () => ({}),
}))

mock.module("@/utils/persist", () => ({
  Persist: {
    global: (key: string) => ({ key }),
  },
  persisted: (_target: unknown, value: ReturnType<typeof createStore<{ list: Array<{ directory?: string; type: string; viewed: boolean }> }>>) => {
    persistedState = value[0]
    return [...value, undefined, () => true]
  },
}))

mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: (input: { name?: string; init: (props: { children?: unknown }) => unknown }) => {
    const key = Symbol(input.name)
    return {
      provider: (props: { children?: unknown }) => {
        const value = input.init(props)
        store.set(key, value)
        const ready = (value as { ready?: Accessor<boolean> | boolean }).ready
        if (ready === undefined || (typeof ready === "function" ? ready() : ready)) return props.children
        return undefined
      },
      use: () => store.get(key),
    }
  },
}))

mock.module("./global-sdk", () => ({
  useGlobalSDK: () => ({
    event: {
      listen(fn: (input: { name: string; details: { type: string; properties: Record<string, unknown> } }) => void) {
        listeners.push(fn)
        return () => {
          const idx = listeners.indexOf(fn)
          if (idx >= 0) listeners.splice(idx, 1)
        }
      },
    },
    client: {
      session: {
        get: () => Promise.resolve({ data: undefined }),
      },
    },
  }),
}))

mock.module("./global-sync", () => ({
  useGlobalSync: () => globalSync,
}))

mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    platform: "web",
    notify: async (title: string, description?: string, href?: string) => {
      calls.notify.push({ title, description, href })
    },
  }),
}))

mock.module("@/context/settings", () => ({
  useSettings: () => ({
    notifications: {
      agent: () => false,
      permissions: () => false,
      errors: () => false,
    },
    sounds: {
      agentEnabled: () => false,
      agent: () => "agent",
      permissionsEnabled: () => false,
      permissions: () => "permissions",
      errorsEnabled: () => false,
      errors: () => "errors",
    },
  }),
}))

mock.module("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

mock.module("@/utils/sound", () => ({
  playSoundById: async (id: string) => {
    calls.sound.push(id)
  },
}))

mock.module("@opencode-ai/ui/context/dialog", () => ({
  DialogProvider: (props: { children?: unknown }) => props.children,
  useDialog: () => ({
    active: undefined,
    show: (node: () => unknown) => {
      calls.dialog.push(node)
    },
    close: () => {},
  }),
}))

mock.module("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { children?: unknown }) => props.children,
}))

const tick = () => Promise.resolve().then(() => Promise.resolve())

describe("notification plugin modal", () => {
  beforeEach(() => {
    calls.notify.length = 0
    calls.sound.length = 0
    calls.dialog.length = 0
    listeners.length = 0
    store.clear()
    persistedState = undefined
    localStorage.clear()
  })

  test("plugin session.error opens a dialog without a selected session", async () => {
    const mod = (await import(`./notification?test=${Date.now()}` as string)) as typeof import("./notification")
    const NotificationProvider = mod.NotificationProvider

    let dispose!: () => void
    createRoot((d) => {
      dispose = d
      NotificationProvider({ get children() { return undefined } })
    })

    expect(listeners.length).toBe(1)

    listeners[0]?.({
      name: "/tmp/persist",
      details: {
        type: "session.error",
        properties: {
          error: {
            name: "UnknownError",
            data: { message: "Failed to install plugin demo@9.9.9: boom" },
          },
        },
      },
    })

    await tick()

    expect(calls.dialog).toHaveLength(1)

    dispose()
  })

  test("plugin session.error is still appended to notifications", async () => {
    const mod = (await import(`./notification?test=${Date.now()}` as string)) as typeof import("./notification")
    const NotificationProvider = mod.NotificationProvider

    let dispose!: () => void

    createRoot((d) => {
      dispose = d
      NotificationProvider({ get children() { return undefined } })
    })

    listeners[0]?.({
      name: "/tmp/persist",
      details: {
        type: "session.error",
        properties: {
          error: {
            name: "UnknownError",
            data: { message: "Failed to load plugin demo: explode" },
          },
        },
      },
    })

    await tick()

    expect(calls.dialog).toHaveLength(1)
    expect(persistedState?.list).toBeArray()
    expect(persistedState?.list.length).toBe(1)
    expect(persistedState?.list[0]?.type).toBe("error")
    expect(persistedState?.list[0]?.directory).toBe("/tmp/persist")
    expect(persistedState?.list[0]?.viewed).toBe(false)

    dispose()
  })

  test("non-plugin session.error does not open a dialog", async () => {
    const mod = (await import(`./notification?test=${Date.now()}` as string)) as typeof import("./notification")
    const NotificationProvider = mod.NotificationProvider

    let dispose!: () => void
    createRoot((d) => {
      dispose = d
      NotificationProvider({ get children() { return undefined } })
    })

    listeners[0]?.({
      name: "/tmp/non-plugin",
      details: {
        type: "session.error",
        properties: {
          error: {
            name: "UnknownError",
            data: { message: "Failed to parse command foo" },
          },
        },
      },
    })

    await tick()

    expect(calls.dialog).toHaveLength(0)

    dispose()
  })

  test("repeated identical plugin errors do not stack dialogs within the dedup window", async () => {
    const mod = (await import(`./notification?test=${Date.now()}` as string)) as typeof import("./notification")
    const NotificationProvider = mod.NotificationProvider

    let now = 1000
    const realNow = Date.now
    Date.now = () => now

    let dispose!: () => void
    createRoot((d) => {
      dispose = d
      NotificationProvider({ get children() { return undefined } })
    })

    const event = {
      name: "/tmp/dedup",
      details: {
        type: "session.error",
        properties: {
          error: {
            name: "UnknownError",
            data: { message: "Failed to install plugin demo@9.9.9: boom" },
          },
        },
      },
    } as const

    listeners[0]?.(event)
    await tick()
    now += 1000
    listeners[0]?.(event)
    await tick()

    expect(calls.dialog).toHaveLength(1)

    Date.now = realNow
    dispose()
  })

  test("repeated identical plugin errors open again after the dedup window", async () => {
    const mod = (await import(`./notification?test=${Date.now()}` as string)) as typeof import("./notification")
    const NotificationProvider = mod.NotificationProvider

    let now = 1000
    const realNow = Date.now
    Date.now = () => now

    let dispose!: () => void
    createRoot((d) => {
      dispose = d
      NotificationProvider({ get children() { return undefined } })
    })

    const event = {
      name: "/tmp/after-window",
      details: {
        type: "session.error",
        properties: {
          error: {
            name: "UnknownError",
            data: { message: "Failed to install plugin demo@9.9.9: boom" },
          },
        },
      },
    } as const

    listeners[0]?.(event)
    await tick()
    now += 5000
    listeners[0]?.(event)
    await tick()

    expect(calls.dialog).toHaveLength(2)

    Date.now = realNow
    dispose()
  })
})
